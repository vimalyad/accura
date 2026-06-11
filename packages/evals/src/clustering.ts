import { z } from 'zod';
import { generateStructured, type ChatModel } from '@accura/llm';
import type { TaskRunRecord } from './types.js';

const ClustersSchema = z.object({
  clusters: z
    .array(
      z.object({
        label: z.string().describe('Short actionable failure category'),
        count: z.number().int().min(1),
        exampleTaskIds: z.array(z.string()),
        suggestedFix: z.string().describe('What change to the agent would address this category'),
      }),
    )
    .min(1)
    .max(10),
});
export type FailureClusters = z.infer<typeof ClustersSchema>;

/**
 * Clusters failure reasons into actionable buckets via a model call.
 * The output ranks where accuracy work should go next.
 */
export async function clusterFailures(
  model: ChatModel,
  records: TaskRunRecord[],
): Promise<FailureClusters> {
  const failures = records.filter((r) => !r.finalScore);
  if (failures.length === 0) return { clusters: [] } as unknown as FailureClusters;

  const listing = failures
    .map((r) => `- task=${r.taskId} seed=${r.seed}: ${(r.error ?? r.result).slice(0, 300)}`)
    .join('\n');

  return generateStructured(
    model,
    {
      system:
        'Group web-agent failure reasons into a small set of ACTIONABLE categories ' +
        '(e.g. "element grounding misses after dropdown opens", not "task failed"). ' +
        'Every category must imply a concrete fix.',
      messages: [{ role: 'user', content: `Failures:\n${listing}` }],
    },
    ClustersSchema,
    { toolName: 'submit_clusters' },
  );
}
