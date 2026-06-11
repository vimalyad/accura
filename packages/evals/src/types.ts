import { z } from 'zod';

export const GroundTruthSchema = z.object({
  /** Strings that must appear (case-insensitive) in the agent's final result. */
  mustContain: z.array(z.string()).default([]),
  /** Whether the task is expected to be completable. */
  successExpected: z.boolean().default(true),
});

export const EvalTaskSchema = z.object({
  id: z.string().min(1),
  instruction: z.string().min(1),
  /**
   * Start URL. `fixture:/path` is resolved against the local fixture server
   * at run time — fixture tasks are CI-safe; live-site tasks use https URLs
   * and carry the "live" tag so the smoke gate can exclude them.
   */
  startUrl: z.string().optional(),
  maxSteps: z.number().int().positive().default(15),
  tags: z.array(z.string()).default([]),
  groundTruth: GroundTruthSchema.optional(),
});
export type EvalTask = z.infer<typeof EvalTaskSchema>;

export const EvalSuiteSchema = z.object({
  name: z.string().min(1),
  tasks: z.array(EvalTaskSchema).min(1),
});
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;

export interface TaskRunRecord {
  taskId: string;
  seed: number;
  /** What the agent claimed. */
  agentSuccess: boolean;
  /** Deterministic ground-truth verdict, when ground truth exists. */
  groundTruthPass?: boolean;
  /** The score that counts: ground truth when available, else agent claim. */
  finalScore: boolean;
  steps: number;
  result: string;
  durationMs: number;
  error?: string;
  traceDir?: string;
}

export interface TaskAggregate {
  taskId: string;
  runs: number;
  successes: number;
  rate: number;
}

export interface EvalReport {
  suite: string;
  generatedAt: string;
  totalRuns: number;
  successes: number;
  successRate: number;
  ci95: { low: number; high: number };
  perTask: TaskAggregate[];
  records: TaskRunRecord[];
}
