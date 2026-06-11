import { z } from 'zod';
import { generateStructured, type ChatModel } from '@accura/llm';
import type { ActionInvocation } from '@accura/actions';

export interface StepCandidate {
  evaluationPreviousGoal: string;
  memory: string;
  nextGoal: string;
  actions: ActionInvocation[];
}

const ChoiceSchema = z.object({
  rationale: z.string(),
  chosenIndex: z.number().int().min(0).describe('Index of the best candidate'),
});

/** Semantic dedup: candidates proposing identical action sequences are one. */
export function dedupCandidates<T extends StepCandidate>(candidates: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const candidate of candidates) {
    const key = JSON.stringify(candidate.actions.map((a) => ({ n: a.name, p: a.params })));
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(candidate);
    }
  }
  return unique;
}

/**
 * Best-of-N with a judge arbiter, applied ONLY at flagged decision points
 * (executor uncertain, verifier contradiction). The literature is clear:
 * modest N with an arbiter helps; naive large-N hurts.
 */
export class StepArbiter {
  constructor(
    private readonly model: ChatModel,
    readonly n = 3,
  ) {}

  async chooseBest<T extends StepCandidate>(candidates: T[], contextSummary: string): Promise<T> {
    const unique = dedupCandidates(candidates);
    if (unique.length === 0) {
      throw new Error('No candidates to arbitrate');
    }
    if (unique.length === 1) return unique[0]!;

    const listing = unique
      .map(
        (candidate, index) =>
          `Candidate ${index}:\n  goal: ${candidate.nextGoal}\n  actions: ${candidate.actions
            .map((a) => `${a.name}(${JSON.stringify(a.params)})`)
            .join(', ')}`,
      )
      .join('\n');

    const choice = await generateStructured(
      this.model,
      {
        system:
          'Pick the single best next step for a web agent at an uncertain decision point. ' +
          'Prefer: actions that verify state over actions that assume it; recovery over ' +
          'repetition of something that already failed; progress on the stated goal over ' +
          'exploration. Penalize candidates that repeat previously failed actions.',
        messages: [
          {
            role: 'user',
            content: `Context:\n${contextSummary.slice(0, 4000)}\n\nCandidates:\n${listing}`,
          },
        ],
      },
      ChoiceSchema,
      { toolName: 'submit_choice' },
    );

    return unique[Math.min(choice.chosenIndex, unique.length - 1)]!;
  }
}
