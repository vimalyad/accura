import { z } from 'zod';
import { generateStructured, type ChatModel } from '@accura/llm';

export type PlanItemStatus = 'pending' | 'active' | 'done' | 'skipped';

export interface PlanItem {
  text: string;
  status: PlanItemStatus;
}

export interface Plan {
  items: PlanItem[];
  revision: number;
}

const CreatePlanSchema = z.object({
  items: z
    .array(z.string())
    .min(2)
    .max(10)
    .describe('Ordered checklist of concrete sub-goals; each independently completable'),
});

const ReplanSchema = z.object({
  rationale: z.string().describe('Why the plan changed'),
  items: z
    .array(
      z.object({
        text: z.string(),
        status: z.enum(['pending', 'active', 'done', 'skipped']),
      }),
    )
    .min(1)
    .max(10),
});

/**
 * Plan-and-Act structure: a separate planner produces a checklist the
 * executor works through, and REPLANS on triggers (stuck, rejection, budget)
 * rather than on a fixed schedule — dynamic replanning is where the measured
 * gains come from, not the initial plan.
 */
export class Planner {
  constructor(private readonly model: ChatModel) {}

  async createPlan(task: string, observationSummary: string): Promise<Plan> {
    const output = await generateStructured(
      this.model,
      {
        system:
          'Break a web task into an ordered checklist of 2-10 concrete sub-goals. Each item ' +
          'must be independently completable and verifiable from page state. Cover every ' +
          'explicit constraint (filters, counts, formats). No vague items like "explore".',
        messages: [
          {
            role: 'user',
            content: `Task: ${task}\n\nStarting page:\n${observationSummary.slice(0, 3000)}`,
          },
        ],
      },
      CreatePlanSchema,
      { toolName: 'submit_plan' },
    );
    const items = output.items.map((text, index) => ({
      text,
      status: (index === 0 ? 'active' : 'pending') as PlanItemStatus,
    }));
    return { items, revision: 1 };
  }

  async replan(task: string, plan: Plan, historySummary: string, reason: string): Promise<Plan> {
    const output = await generateStructured(
      this.model,
      {
        system:
          'Revise the plan for a web task in progress. Keep completed items as done. ' +
          'Mark unreachable items skipped. Reorder or add items so the agent can make ' +
          'progress from its CURRENT state. Address the trigger reason directly.',
        messages: [
          {
            role: 'user',
            content: [
              `Task: ${task}`,
              `Current plan:\n${renderPlan(plan)}`,
              `Replan trigger: ${reason}`,
              `Recent history:\n${historySummary.slice(0, 4000)}`,
            ].join('\n\n'),
          },
        ],
      },
      ReplanSchema,
      { toolName: 'submit_revised_plan' },
    );
    return { items: output.items, revision: plan.revision + 1 };
  }
}

const STATUS_MARK: Record<PlanItemStatus, string> = {
  done: '[x]',
  active: '[>]',
  pending: '[ ]',
  skipped: '[-]',
};

export function renderPlan(plan: Plan): string {
  return plan.items
    .map((item, index) => `${STATUS_MARK[item.status]} ${index + 1}. ${item.text}`)
    .join('\n');
}

/** Applies executor-reported completions and advances the active item. */
export function applyCompletions(plan: Plan, completedIndices: number[]): Plan {
  const items = plan.items.map((item) => ({ ...item }));
  for (const index of completedIndices) {
    const item = items[index];
    if (item && item.status !== 'skipped') item.status = 'done';
  }
  if (!items.some((item) => item.status === 'active')) {
    const next = items.find((item) => item.status === 'pending');
    if (next) next.status = 'active';
  }
  return { items, revision: plan.revision };
}
