import { z } from 'zod';
import { createLogger } from '@accura/shared';
import type { BrowserSession } from '@accura/browser';
import { describeObservation, Observer } from '@accura/perception';
import {
  executeBatch,
  summarizeOutcome,
  type ActionContext,
  type ActionRegistry,
} from '@accura/actions';
import { generateStructured, type ChatModel, type ContentPart } from '@accura/llm';
import { buildSystemPrompt, renderHistory, type StepRecord } from './prompts.js';

const log = createLogger('agent:loop');

export interface AgentOptions {
  session: BrowserSession;
  registry: ActionRegistry;
  executorModel: ChatModel;
  extractorModel?: ChatModel;
  maxSteps?: number;
  maxActionsPerStep?: number;
  /** Attach screenshots to observations (requires a vision-capable executor). */
  useVision?: boolean;
  startUrl?: string;
}

export interface AgentResult {
  success: boolean;
  result: string;
  stepsTaken: number;
  history: StepRecord[];
}

export class Agent {
  private readonly observer: Observer;
  private readonly ctx: ActionContext;
  private readonly stepSchema: z.ZodType<{
    evaluationPreviousGoal: 'success' | 'failure' | 'uncertain' | 'first-step';
    memory: string;
    nextGoal: string;
    actions: Array<{ name: string; params: Record<string, unknown> }>;
  }>;

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
    }) as never;
  }

  async run(task: string): Promise<AgentResult> {
    const maxSteps = this.options.maxSteps ?? 40;
    const history: StepRecord[] = [];
    const systemPrompt = buildSystemPrompt(this.options.registry.describeCatalog());

    if (this.options.startUrl) {
      await this.options.session.navigate(this.options.startUrl);
    }

    for (let step = 1; step <= maxSteps; step += 1) {
      await this.options.session.waitForStable({ timeoutMs: 8000 });
      const observation = await this.observer.observe();

      const budgetNote =
        step >= Math.floor(maxSteps * 0.75)
          ? `\nNOTE: step ${step} of ${maxSteps}. Budget is running out - prioritize completing the highest-value remaining work, then call done.`
          : '';

      const userText = [
        `# Task\n${task}`,
        `# History\n${renderHistory(history)}`,
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

      const stepOutput = await generateStructured(
        this.options.executorModel,
        { system: systemPrompt, messages: [{ role: 'user', content }] },
        this.stepSchema,
        { toolName: 'agent_step', toolDescription: 'Submit your evaluation, memory, goal and next actions.' },
      );

      log.info(
        { step, goal: stepOutput.nextGoal, actions: stepOutput.actions.map((a) => a.name) },
        'executing step',
      );

      const outcome = await executeBatch(stepOutput.actions, this.options.registry, this.ctx, {
        maxActions: this.options.maxActionsPerStep ?? 3,
      });

      history.push({
        step,
        goal: stepOutput.nextGoal,
        actionsSummary: summarizeOutcome(outcome),
        evaluation: stepOutput.evaluationPreviousGoal,
        memory: stepOutput.memory,
      });

      if (outcome.done) {
        return {
          success: outcome.done.success,
          result: outcome.done.result,
          stepsTaken: step,
          history,
        };
      }
    }

    return {
      success: false,
      result: `Step budget (${maxSteps}) exhausted before the task completed.`,
      stepsTaken: maxSteps,
      history,
    };
  }
}
