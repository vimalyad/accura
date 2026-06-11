import type { EvalReport, TaskAggregate, TaskRunRecord } from './types.js';

/** Deterministic PRNG so CI bootstrap numbers are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function successRate(records: TaskRunRecord[]): number {
  if (records.length === 0) return 0;
  return records.filter((r) => r.finalScore).length / records.length;
}

/**
 * Percentile-bootstrap confidence interval over run outcomes. Live-site
 * nondeterminism makes single-run deltas noise — error bars are mandatory
 * before claiming any accuracy change.
 */
export function bootstrapCI(
  records: TaskRunRecord[],
  iterations = 2000,
  alpha = 0.05,
  rngSeed = 42,
): { low: number; high: number } {
  if (records.length === 0) return { low: 0, high: 0 };
  const rng = mulberry32(rngSeed);
  const outcomes = records.map((r) => (r.finalScore ? 1 : 0));
  const rates: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let j = 0; j < outcomes.length; j += 1) {
      sum += outcomes[Math.floor(rng() * outcomes.length)]!;
    }
    rates.push(sum / outcomes.length);
  }
  rates.sort((a, b) => a - b);
  const lowIndex = Math.floor((alpha / 2) * iterations);
  const highIndex = Math.min(iterations - 1, Math.ceil((1 - alpha / 2) * iterations));
  return { low: rates[lowIndex]!, high: rates[highIndex]! };
}

export function aggregateByTask(records: TaskRunRecord[]): TaskAggregate[] {
  const byTask = new Map<string, TaskRunRecord[]>();
  for (const record of records) {
    const list = byTask.get(record.taskId) ?? [];
    list.push(record);
    byTask.set(record.taskId, list);
  }
  return [...byTask.entries()].map(([taskId, runs]) => ({
    taskId,
    runs: runs.length,
    successes: runs.filter((r) => r.finalScore).length,
    rate: successRate(runs),
  }));
}

export function buildReport(suiteName: string, records: TaskRunRecord[]): EvalReport {
  return {
    suite: suiteName,
    generatedAt: new Date().toISOString(),
    totalRuns: records.length,
    successes: records.filter((r) => r.finalScore).length,
    successRate: successRate(records),
    ci95: bootstrapCI(records),
    perTask: aggregateByTask(records),
    records,
  };
}

export function renderMarkdown(report: EvalReport): string {
  const lines = [
    `# Eval report: ${report.suite}`,
    '',
    `Generated: ${report.generatedAt}`,
    '',
    `**Success rate: ${(report.successRate * 100).toFixed(1)}%** ` +
      `(${report.successes}/${report.totalRuns}, 95% CI ${(report.ci95.low * 100).toFixed(1)}–${(
        report.ci95.high * 100
      ).toFixed(1)}%)`,
    '',
    '| Task | Runs | Successes | Rate |',
    '|---|---|---|---|',
    ...report.perTask.map(
      (task) => `| ${task.taskId} | ${task.runs} | ${task.successes} | ${(task.rate * 100).toFixed(0)}% |`,
    ),
    '',
    '## Failures',
    ...report.records
      .filter((r) => !r.finalScore)
      .map((r) => `- **${r.taskId}** (seed ${r.seed}): ${r.error ?? r.result}`.slice(0, 300)),
  ];
  return lines.join('\n');
}
