import { z } from 'zod';
import { generateStructured, type ChatModel } from '@accura/llm';
import type { ActionInvocation } from '@accura/actions';

const AssessmentSchema = z.object({
  predictedOutcome: z.string().describe('What will most likely happen if this action runs'),
  proceed: z
    .boolean()
    .describe('false if the predicted outcome conflicts with the stated goal or is unsafe'),
  concern: z.string().optional().describe('Required when proceed=false'),
});

export interface SimulationAssessment {
  predictedOutcome: string;
  proceed: boolean;
  concern?: string;
}

/**
 * WebDreamer-style pre-flight gate for irreversible actions (submit, purchase,
 * delete, send). Live sites cannot be rewound, so we spend one model call
 * predicting the outcome BEFORE acting; a predicted mismatch blocks the
 * action and sends the agent back to planning.
 */
export class OutcomeSimulator {
  constructor(private readonly model: ChatModel) {}

  async assess(
    invocation: ActionInvocation,
    goal: string,
    observationContext: string,
  ): Promise<SimulationAssessment> {
    return generateStructured(
      this.model,
      {
        system:
          'You simulate the outcome of an IRREVERSIBLE browser action before it runs. ' +
          'Predict what happens, then decide: proceed only if the predicted outcome ' +
          'clearly serves the stated goal. When in doubt, do not proceed - a blocked ' +
          'action costs one step; a wrong purchase or deletion cannot be undone.',
        messages: [
          {
            role: 'user',
            content: [
              `Stated goal: ${goal}`,
              `Action about to run: ${invocation.name}(${JSON.stringify(invocation.params)})`,
              `Current page context:\n${observationContext.slice(0, 4000)}`,
            ].join('\n\n'),
          },
        ],
      },
      AssessmentSchema,
      { toolName: 'submit_assessment' },
    );
  }
}
