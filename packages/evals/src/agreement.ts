import type { TaskRunRecord } from './types.js';

export interface HumanLabel {
  taskId: string;
  seed: number;
  humanSuccess: boolean;
}

export interface AgreementReport {
  compared: number;
  agreements: number;
  agreementRate: number;
  /** Judge said success, human said failure — the dangerous direction. */
  falsePositives: number;
  /** Judge said failure, human said success. */
  falseNegatives: number;
}

/**
 * Judge-agreement harness: periodically hand-label a sample of runs and
 * compare against the automated verdicts. The production reference point is
 * ~87% agreement; below that, judge prompts need work before its verdicts
 * can gate anything.
 */
export function computeAgreement(records: TaskRunRecord[], labels: HumanLabel[]): AgreementReport {
  const byKey = new Map(records.map((r) => [`${r.taskId}:${r.seed}`, r]));
  let compared = 0;
  let agreements = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  for (const label of labels) {
    const record = byKey.get(`${label.taskId}:${label.seed}`);
    if (!record) continue;
    compared += 1;
    if (record.finalScore === label.humanSuccess) {
      agreements += 1;
    } else if (record.finalScore && !label.humanSuccess) {
      falsePositives += 1;
    } else {
      falseNegatives += 1;
    }
  }

  return {
    compared,
    agreements,
    agreementRate: compared === 0 ? 0 : agreements / compared,
    falsePositives,
    falseNegatives,
  };
}
