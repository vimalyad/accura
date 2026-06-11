import { describe, expect, it } from 'vitest';
import { computeAgreement } from '../src/agreement.js';
import type { TaskRunRecord } from '../src/types.js';

function record(taskId: string, seed: number, finalScore: boolean): TaskRunRecord {
  return { taskId, seed, agentSuccess: finalScore, finalScore, steps: 1, result: '', durationMs: 1 };
}

describe('computeAgreement', () => {
  it('computes agreement and error directions', () => {
    const records = [
      record('a', 0, true),
      record('b', 0, true),
      record('c', 0, false),
      record('d', 0, false),
    ];
    const report = computeAgreement(records, [
      { taskId: 'a', seed: 0, humanSuccess: true }, // agree
      { taskId: 'b', seed: 0, humanSuccess: false }, // judge overclaims -> FP
      { taskId: 'c', seed: 0, humanSuccess: true }, // judge underclaims -> FN
      { taskId: 'd', seed: 0, humanSuccess: false }, // agree
      { taskId: 'missing', seed: 0, humanSuccess: true }, // no record, ignored
    ]);

    expect(report.compared).toBe(4);
    expect(report.agreements).toBe(2);
    expect(report.agreementRate).toBe(0.5);
    expect(report.falsePositives).toBe(1);
    expect(report.falseNegatives).toBe(1);
  });
});
