import { describe, expect, it } from 'vitest';
import { aggregateByTask, bootstrapCI, buildReport, renderMarkdown, successRate } from '../src/scoring.js';
import type { TaskRunRecord } from '../src/types.js';

function record(taskId: string, finalScore: boolean, seed = 0): TaskRunRecord {
  return {
    taskId,
    seed,
    agentSuccess: finalScore,
    finalScore,
    steps: 3,
    result: finalScore ? 'ok' : 'nope',
    durationMs: 100,
  };
}

describe('scoring', () => {
  it('computes the success rate', () => {
    expect(successRate([])).toBe(0);
    expect(successRate([record('a', true), record('a', false)])).toBe(0.5);
  });

  it('bootstrap CI brackets the point estimate and is deterministic', () => {
    const records = [
      ...Array.from({ length: 7 }, (_, i) => record('a', true, i)),
      ...Array.from({ length: 3 }, (_, i) => record('b', false, i)),
    ];
    const ci1 = bootstrapCI(records);
    const ci2 = bootstrapCI(records);
    expect(ci1).toEqual(ci2);
    expect(ci1.low).toBeLessThanOrEqual(0.7);
    expect(ci1.high).toBeGreaterThanOrEqual(0.7);
    expect(ci1.low).toBeGreaterThanOrEqual(0);
    expect(ci1.high).toBeLessThanOrEqual(1);
  });

  it('aggregates per task', () => {
    const aggregate = aggregateByTask([record('a', true), record('a', false, 1), record('b', true)]);
    expect(aggregate).toEqual([
      { taskId: 'a', runs: 2, successes: 1, rate: 0.5 },
      { taskId: 'b', runs: 1, successes: 1, rate: 1 },
    ]);
  });

  it('renders a markdown report with failures section', () => {
    const report = buildReport('demo', [record('a', true), record('b', false)]);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('# Eval report: demo');
    expect(markdown).toContain('50.0%');
    expect(markdown).toContain('| a | 1 | 1 | 100% |');
    expect(markdown).toContain('**b** (seed 0)');
  });
});
