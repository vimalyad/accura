import { createLogger, type BrowserConfig } from '@accura/shared';
import { BrowserSession } from '@accura/browser';
import { buildCoreRegistry } from '@accura/actions';
import { Agent } from '@accura/agent';
import type { ChatModel } from '@accura/llm';
import { resolveStartUrl, type FixtureServer } from './fixtures.js';
import { buildReport } from './scoring.js';
import type { EvalReport, EvalSuite, EvalTask, TaskRunRecord } from './types.js';

const log = createLogger('evals:runner');

export interface RunnerModels {
  executor: ChatModel;
  judge?: ChatModel;
  extractor?: ChatModel;
}

export interface RunnerOptions {
  suite: EvalSuite;
  /** Per-task model wiring; a factory so scripted oracles can be injected in tests. */
  modelsFor: (task: EvalTask) => RunnerModels;
  browserConfig: BrowserConfig;
  seeds?: number;
  /** Only run tasks carrying at least one of these tags (empty = all). */
  includeTags?: string[];
  /** Skip tasks carrying any of these tags (e.g. ["live"] on CI). */
  excludeTags?: string[];
  fixtureServer?: FixtureServer;
  traceDir?: string;
}

export async function runSuite(options: RunnerOptions): Promise<EvalReport> {
  const seeds = options.seeds ?? 1;
  const records: TaskRunRecord[] = [];

  const tasks = options.suite.tasks.filter((task) => {
    if (options.includeTags?.length && !task.tags.some((t) => options.includeTags!.includes(t))) {
      return false;
    }
    if (options.excludeTags?.length && task.tags.some((t) => options.excludeTags!.includes(t))) {
      return false;
    }
    return true;
  });

  for (const task of tasks) {
    for (let seed = 0; seed < seeds; seed += 1) {
      records.push(await runTask(task, seed, options));
    }
  }
  return buildReport(options.suite.name, records);
}

async function runTask(task: EvalTask, seed: number, options: RunnerOptions): Promise<TaskRunRecord> {
  const started = Date.now();
  const models = options.modelsFor(task);
  let session: BrowserSession | undefined;
  try {
    session = await BrowserSession.launch(options.browserConfig);
    const startUrl = resolveStartUrl(task.startUrl, options.fixtureServer?.baseUrl);
    const agent = new Agent({
      session,
      registry: buildCoreRegistry(),
      executorModel: models.executor,
      ...(models.judge ? { judgeModel: models.judge } : {}),
      ...(models.extractor ? { extractorModel: models.extractor } : {}),
      maxSteps: task.maxSteps,
      ...(startUrl ? { startUrl } : {}),
      ...(options.traceDir ? { traceDir: options.traceDir } : {}),
    });

    const outcome = await agent.run(task.instruction);
    const groundTruthPass = task.groundTruth
      ? evaluateGroundTruth(task, outcome.success, outcome.result)
      : undefined;

    const record: TaskRunRecord = {
      taskId: task.id,
      seed,
      agentSuccess: outcome.success,
      finalScore: groundTruthPass ?? outcome.success,
      steps: outcome.stepsTaken,
      result: outcome.result,
      durationMs: Date.now() - started,
      ...(groundTruthPass !== undefined ? { groundTruthPass } : {}),
      ...(outcome.traceDir ? { traceDir: outcome.traceDir } : {}),
    };
    log.info({ task: task.id, seed, score: record.finalScore, steps: record.steps }, 'task done');
    return record;
  } catch (error) {
    log.error({ task: task.id, seed, error }, 'task crashed');
    return {
      taskId: task.id,
      seed,
      agentSuccess: false,
      finalScore: false,
      steps: 0,
      result: '',
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await session?.close();
  }
}

function evaluateGroundTruth(task: EvalTask, agentSuccess: boolean, result: string): boolean {
  const truth = task.groundTruth!;
  if (agentSuccess !== truth.successExpected) return false;
  const haystack = result.toLowerCase();
  return truth.mustContain.every((needle) => haystack.includes(needle.toLowerCase()));
}
