import { z } from 'zod';
import { createLogger } from '@accura/shared';
import type { BrowserSession } from '@accura/browser';
import { describeObservation, Observer, type AgentObservation } from '@accura/perception';
import {
  executeBatch,
  summarizeOutcome,
  type ActionContext,
  type ActionInvocation,
  type ActionRegistry,
  type BatchOutcome,
} from '@accura/actions';
import { generateStructured, type ChatModel, type ContentPart } from '@accura/llm';
import {
  checkDataGrounding,
  detectContradiction,
  diffObservations,
  TrajectoryJudge,
} from '@accura/verify';
import { buildSystemPrompt, renderHistory, type StepRecord } from './prompts.js';
import { RecoveryPolicy } from './recovery.js';
import { TraceWriter } from './trace.js';
import { applyCompletions, Planner, renderPlan, type Plan } from './planner.js';
import { StepArbiter } from './arbiter.js';
import { OutcomeSimulator } from './simulation.js';

const log = createLogger('agent:loop');

export interface AgentOptions {
  session: BrowserSession;
  registry: ActionRegistry;
  executorModel: ChatModel;
  extractorModel?: ChatModel;
  /** Gates done(success=true). Strongly recommended; omit only in tests. */
  judgeModel?: ChatModel;
  /** Enables Plan-and-Act: initial checklist + trigger-driven replanning. */
  plannerModel?: ChatModel;
  /** Arbiter for best-of-N at flagged decisions. Defaults to judgeModel. */
  arbiterModel?: ChatModel;
  /** Candidates sampled at flagged decision points. */
  arbiterN?: number;
  /** Pre-flight outcome simulation for irreversible actions. Defaults to plannerModel ?? judgeModel. */
  simulatorModel?: ChatModel;
  maxSteps?: number;
  maxActionsPerStep?: number;
  /** done(success=true) rejections tolerated before returning honest failure. */
  maxDoneRejections?: number;
  /** Steps between scheduled replans (triggers can replan sooner). */
  replanEveryNSteps?: number;
  useVision?: boolean;
  startUrl?: string;
  /** Directory for JSONL trajectory traces; omit to disable tracing. */
  traceDir?: string;
}

export interface AgentResult {
  success: boolean;
  result: string;
  stepsTaken: number;
  history: StepRecord[];
  doneRejections: number;
  planRevisions: number;
  traceDir?: string;
}

interface StepPlanOutput {
  evaluationPreviousGoal: 'success' | 'failure' | 'uncertain' | 'first-step';
  memory: string;
  nextGoal: string;
  actions: ActionInvocation[];
  completedPlanItems?: number[];
}

export class Agent {
  private readonly observer: Observer;
  private readonly ctx: ActionContext;
  private readonly recovery = new RecoveryPolicy();
  private readonly stepSchema: z.ZodType<StepPlanOutput>;

  constructor(private readonly options: AgentOptions) {
    const useVision = options.useVision ?? options.executorModel.caps.vision;
    this.observer = new Observer(options.session, { includeScreenshot: useVision });
    this.ctx = {
      session: options.session,
      observer: this.observer,
      scratchpad: new Map(),
      log: createLogger('agent:actions'),
    };
    if (options.extractorModel) {
      this.ctx.extractor = options.extractorModel;
    }
    this.stepSchema = z.object({
      evaluationPreviousGoal: z
        .enum(['success', 'failure', 'uncertain', 'first-step'])
        .describe('Did the PREVIOUS step achieve its goal, judged from the current observation?'),
      memory: z
        .string()
        .describe('Facts gathered so far and approaches already tried. Carried across steps.'),
      nextGoal: z.string().describe('What the next action batch should achieve'),
      actions: z
        .array(options.registry.invocationSchema())
        .min(1)
        .max(options.maxActionsPerStep ?? 3),
      completedPlanItems: z
        .array(z.number().int().min(0))
        .optional()
        .describe('Indices (0-based) of plan items now demonstrably complete'),
    }) as never;
  }

  async run(task: string): Promise<AgentResult> {
    const maxSteps = this.options.maxSteps ?? 40;
    const maxDoneRejections = this.options.maxDoneRejections ?? 2;
    const replanEvery = this.options.replanEveryNSteps ?? 10;
    const history: StepRecord[] = [];
    const systemPrompt = buildSystemPrompt(this.options.registry.describeCatalog());

    const judge = this.options.judgeModel
      ? new TrajectoryJudge(this.options.judgeModel)
      : undefined;
    const planner = this.options.plannerModel
      ? new Planner(this.options.plannerModel)
      : undefined;
    const arbiterModel = this.options.arbiterModel ?? this.options.judgeModel;
    const arbiter = arbiterModel
      ? new StepArbiter(arbiterModel, this.options.arbiterN ?? 3)
      : undefined;
    const simulatorModel = this.options.simulatorModel ?? this.options.plannerModel ?? this.options.judgeModel;
    const simulator = simulatorModel ? new OutcomeSimulator(simulatorModel) : undefined;

    const trace = this.options.traceDir
      ? await TraceWriter.create(this.options.traceDir)
      : undefined;
    await trace?.meta({ task, maxSteps, executor: this.options.executorModel.id });

    let keyPoints: string[] = [task];
    if (judge) {
      try {
        keyPoints = await judge.deriveKeyPoints(task);
      } catch (error) {
        log.warn({ error }, 'key point derivation failed; falling back to raw task');
      }
    }

    if (this.options.startUrl) {
      await this.options.session.navigate(this.options.startUrl);
    }

    const observedEvidence: string[] = [];
    const observationExcerpts: string[] = [];
    let previousObservation: AgentObservation | undefined;
    let previousBatchAllOk = false;
    let pendingRejection: string | undefined;
    let pendingReplanReason: string | undefined;
    let doneRejections = 0;
    let lastScreenshot: { dataBase64: string } | undefined;
    let plan: Plan | undefined;
    let lastPlanStep = 0;
    let budgetReplanDone = false;

    for (let step = 1; step <= maxSteps; step += 1) {
      if (this.options.session.events.hasCrash()) {
        log.warn('crash detected; restoring session');
        await this.options.session.restore();
      }
      await this.options.session.waitForStable({ timeoutMs: 8000 });
      const observation = await this.observer.observe();
      if (observation.screenshot) {
        lastScreenshot = { dataBase64: observation.screenshot.dataBase64 };
        await trace?.screenshot(step, observation.screenshot.dataBase64);
      }

      observedEvidence.push(observation.pageText.slice(0, 8000), observation.elementsText);
      if (observedEvidence.length > 60) observedEvidence.splice(0, observedEvidence.length - 60);
      if (observationExcerpts.length === 0 || observation.url !== previousObservation?.url) {
        observationExcerpts.push(`URL ${observation.url}\n${observation.pageText.slice(0, 1500)}`);
        if (observationExcerpts.length > 8) observationExcerpts.shift();
      }

      // ---- planning ----
      if (planner && !plan) {
        try {
          plan = await planner.createPlan(task, describeObservation(observation));
          lastPlanStep = step;
          await trace?.step({ step, plan: renderPlan(plan), revision: plan.revision });
        } catch (error) {
          log.warn({ error }, 'initial planning failed; continuing without a plan');
        }
      } else if (planner && plan) {
        const reasons: string[] = [];
        if (pendingReplanReason) reasons.push(pendingReplanReason);
        if (this.recovery.isStuck()) reasons.push('agent is stuck on the same URL with no progress');
        if (step - lastPlanStep >= replanEvery) reasons.push(`scheduled replan after ${replanEvery} steps`);
        if (!budgetReplanDone && step >= Math.floor(maxSteps * 0.75)) {
          reasons.push('75% of the step budget is spent - prioritize the highest-value remaining items');
          budgetReplanDone = true;
        }
        if (reasons.length > 0) {
          try {
            plan = await planner.replan(task, plan, renderHistory(history), reasons.join('; '));
            lastPlanStep = step;
            pendingReplanReason = undefined;
            await trace?.step({ step, plan: renderPlan(plan), revision: plan.revision });
          } catch (error) {
            log.warn({ error }, 'replan failed; keeping current plan');
          }
        }
      }

      // ---- verifier notes ----
      const verifierNotes: string[] = [];
      let contradictionFlag = false;
      if (previousObservation) {
        const diff = diffObservations(previousObservation, observation);
        verifierNotes.push(`What changed after your last actions: ${diff.summary}`);
        const contradiction = detectContradiction(previousBatchAllOk, diff);
        if (contradiction) {
          verifierNotes.push(contradiction);
          contradictionFlag = true;
        }
      }
      verifierNotes.push(...this.recovery.advice());
      if (pendingRejection) {
        verifierNotes.push(pendingRejection);
        pendingRejection = undefined;
      }

      const budgetNote =
        step >= Math.floor(maxSteps * 0.75)
          ? `\nNOTE: step ${step} of ${maxSteps}. Budget is running out - prioritize completing the highest-value remaining work, then call done.`
          : '';

      const userText = [
        `# Task\n${task}`,
        ...(plan
          ? [
              `# Plan (revision ${plan.revision})\n${renderPlan(plan)}\nReport newly completed item indices in completedPlanItems.`,
            ]
          : []),
        `# History\n${renderHistory(history)}`,
        ...(verifierNotes.length > 0 ? [`# Verifier notes\n${verifierNotes.join('\n')}`] : []),
        `# Current page (step ${step}/${maxSteps})${budgetNote}\n${describeObservation(observation)}`,
      ].join('\n\n');

      const content: ContentPart[] = [{ type: 'text', text: userText }];
      if (observation.screenshot) {
        content.push({
          type: 'image',
          mediaType: 'image/png',
          dataBase64: observation.screenshot.dataBase64,
        });
      }

      // ---- step generation, best-of-N at flagged decision points ----
      const lastEvaluation = history.at(-1)?.evaluation;
      const flagged =
        contradictionFlag ||
        verifierNotes.some((note) => note.startsWith('FORBIDDEN') || note.startsWith('STUCK')) ||
        lastEvaluation === 'failure' ||
        lastEvaluation === 'uncertain';

      const generateCandidate = () =>
        generateStructured(
          this.options.executorModel,
          { system: systemPrompt, messages: [{ role: 'user', content }] },
          this.stepSchema,
          {
            toolName: 'agent_step',
            toolDescription: 'Submit your evaluation, memory, goal and next actions.',
          },
        );

      let stepOutput: StepPlanOutput;
      if (flagged && arbiter) {
        const candidates: StepPlanOutput[] = [];
        for (let i = 0; i < arbiter.n; i += 1) {
          try {
            candidates.push(await generateCandidate());
          } catch (error) {
            log.warn({ error }, 'candidate generation failed');
          }
        }
        if (candidates.length === 0) {
          stepOutput = await generateCandidate();
        } else {
          stepOutput = await arbiter.chooseBest(
            candidates,
            `Task: ${task}\nRecent history:\n${renderHistory(history, 5)}\nVerifier notes:\n${verifierNotes.join('\n')}`,
          );
        }
        await trace?.step({ step, bestOfN: candidates.length });
      } else {
        stepOutput = await generateCandidate();
      }

      log.info(
        { step, goal: stepOutput.nextGoal, actions: stepOutput.actions.map((a) => a.name) },
        'executing step',
      );

      // ---- simulation gate for irreversible actions ----
      let batch = stepOutput.actions;
      let simulationBlock: { invocation: ActionInvocation; concern: string } | undefined;
      if (simulator) {
        const irreversibleIndex = batch.findIndex(
          (invocation) => this.options.registry.get(invocation.name)?.irreversible === true,
        );
        if (irreversibleIndex !== -1) {
          const invocation = batch[irreversibleIndex]!;
          const assessment = await simulator.assess(
            invocation,
            stepOutput.nextGoal,
            describeObservation(observation),
          );
          await trace?.step({ step, simulation: { action: invocation.name, ...assessment } });
          if (!assessment.proceed) {
            simulationBlock = {
              invocation,
              concern: assessment.concern ?? assessment.predictedOutcome,
            };
            batch = batch.slice(0, irreversibleIndex);
          }
        }
      }

      const outcome =
        batch.length > 0
          ? await this.executeWithPolicy(batch)
          : ({ executed: [], skipped: [] } as BatchOutcome);
      if (simulationBlock) {
        outcome.executed.push({
          name: simulationBlock.invocation.name,
          params: simulationBlock.invocation.params,
          result: {
            ok: false,
            message:
              `BLOCKED by outcome simulation: ${simulationBlock.concern}. ` +
              'This action is irreversible - re-check the page state and the plan before retrying.',
          },
        });
        pendingReplanReason = `simulation blocked irreversible action ${simulationBlock.invocation.name}: ${simulationBlock.concern}`;
      }

      for (const executed of outcome.executed) {
        this.recovery.noteResult(executed.name, executed.params, executed.result.ok);
      }
      previousBatchAllOk =
        outcome.executed.length > 0 && outcome.executed.every((a) => a.result.ok);
      this.recovery.noteStep(this.options.session.currentUrl(), previousBatchAllOk);
      previousObservation = observation;

      if (plan && stepOutput.completedPlanItems?.length) {
        plan = applyCompletions(plan, stepOutput.completedPlanItems);
      }

      const record: StepRecord = {
        step,
        goal: stepOutput.nextGoal,
        actionsSummary: summarizeOutcome(outcome),
        evaluation: stepOutput.evaluationPreviousGoal,
        memory: stepOutput.memory,
      };
      history.push(record);
      await trace?.step({
        step,
        url: observation.url,
        goal: stepOutput.nextGoal,
        evaluation: stepOutput.evaluationPreviousGoal,
        memory: stepOutput.memory,
        actions: stepOutput.actions,
        outcome: record.actionsSummary,
        verifierNotes,
      });

      if (!outcome.done) continue;

      // ---- done gate: grounding (deterministic) then judge (model) ----
      if (!outcome.done.success) {
        return this.finish(
          { success: false, result: outcome.done.result, stepsTaken: step },
          history,
          doneRejections,
          plan,
          trace,
        );
      }

      const grounding = checkDataGrounding(outcome.done.result, observedEvidence);
      if (!grounding.ok) {
        doneRejections += 1;
        const reason =
          `DONE REJECTED (${doneRejections}/${maxDoneRejections}): these values in your result ` +
          `never appeared in any observation: ${grounding.ungrounded.join(', ')}. ` +
          'Locate the real values on the page or report honestly that you could not.';
        log.warn({ ungrounded: grounding.ungrounded }, 'done rejected by grounding check');
        if (doneRejections >= maxDoneRejections) {
          return this.finish(
            {
              success: false,
              result: `Task could not be verified as complete. ${reason}`,
              stepsTaken: step,
            },
            history,
            doneRejections,
            plan,
            trace,
          );
        }
        pendingRejection = reason;
        pendingReplanReason = 'final answer was rejected: ungrounded values';
        continue;
      }

      if (judge) {
        const verdict = await judge.judge({
          task,
          keyPoints,
          stepSummaries: history.map(
            (entry) =>
              `Step ${entry.step} [${entry.evaluation}] ${entry.goal}\n${entry.actionsSummary}`,
          ),
          finalResult: outcome.done.result,
          claimedSuccess: true,
          observationExcerpts,
          ...(lastScreenshot ? { finalScreenshot: lastScreenshot } : {}),
        });
        await trace?.step({ step, judge: verdict });
        if (!verdict.verdict) {
          doneRejections += 1;
          const reason =
            `DONE REJECTED by judge (${doneRejections}/${maxDoneRejections}): ` +
            `${verdict.failureReason ?? 'key points not demonstrably satisfied'}` +
            (verdict.missingKeyPoints?.length
              ? ` Missing: ${verdict.missingKeyPoints.join('; ')}`
              : '');
          log.warn({ verdict }, 'done rejected by judge');
          if (doneRejections >= maxDoneRejections) {
            return this.finish(
              {
                success: false,
                result: `Task could not be verified as complete. ${reason}`,
                stepsTaken: step,
              },
              history,
              doneRejections,
              plan,
              trace,
            );
          }
          pendingRejection = reason;
          pendingReplanReason = `judge rejected the result: ${verdict.failureReason ?? 'unverified'}`;
          continue;
        }
      }

      return this.finish(
        { success: true, result: outcome.done.result, stepsTaken: step },
        history,
        doneRejections,
        plan,
        trace,
      );
    }

    return this.finish(
      {
        success: false,
        result: `Step budget (${maxSteps}) exhausted before the task completed.`,
        stepsTaken: maxSteps,
      },
      history,
      doneRejections,
      plan,
      trace,
    );
  }

  /** Hard-blocks invocations the recovery policy has forbidden. */
  private async executeWithPolicy(invocations: ActionInvocation[]): Promise<BatchOutcome> {
    const allowed: ActionInvocation[] = [];
    let blocked: ActionInvocation | undefined;
    for (const invocation of invocations) {
      if (this.recovery.isForbidden(invocation.name, invocation.params)) {
        blocked = invocation;
        break;
      }
      allowed.push(invocation);
    }

    const outcome =
      allowed.length > 0
        ? await executeBatch(allowed, this.options.registry, this.ctx, {
            maxActions: this.options.maxActionsPerStep ?? 3,
          })
        : ({ executed: [], skipped: [] } as BatchOutcome);

    if (blocked) {
      outcome.executed.push({
        name: blocked.name,
        params: blocked.params,
        result: {
          ok: false,
          message: `BLOCKED: ${blocked.name} with these exact parameters failed twice already. Choose a different element or approach.`,
        },
      });
    }
    return outcome;
  }

  private async finish(
    core: { success: boolean; result: string; stepsTaken: number },
    history: StepRecord[],
    doneRejections: number,
    plan: Plan | undefined,
    trace: TraceWriter | undefined,
  ): Promise<AgentResult> {
    const result: AgentResult = {
      ...core,
      history,
      doneRejections,
      planRevisions: plan?.revision ?? 0,
      ...(trace ? { traceDir: trace.dir } : {}),
    };
    await trace?.result({ ...result, history: undefined });
    return result;
  }
}
