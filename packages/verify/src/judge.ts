import { z } from 'zod';
import { generateStructured, type ChatModel, type ContentPart } from '@accura/llm';

export interface JudgeVerdict {
  verdict: boolean;
  reasoning: string;
  failureReason?: string;
  missingKeyPoints?: string[];
}

export interface TrajectoryEvidence {
  task: string;
  keyPoints: string[];
  /** Per-step summaries: goal, actions, results, state diffs. */
  stepSummaries: string[];
  finalResult: string;
  claimedSuccess: boolean;
  /** Key observation excerpts (first page, pages after URL changes, final page). */
  observationExcerpts: string[];
  /** Final screenshot, when a vision judge is available. */
  finalScreenshot?: { dataBase64: string };
}

const KeyPointsSchema = z.object({
  keyPoints: z
    .array(z.string())
    .min(1)
    .max(8)
    .describe('Independently checkable completion criteria derived from the task'),
});

const VerdictSchema = z.object({
  reasoning: z.string().describe('Walk through each key point against the evidence'),
  verdict: z.boolean().describe('true ONLY if every key point is demonstrably satisfied'),
  failureReason: z
    .string()
    .optional()
    .describe('Required when verdict=false: the single most important unmet requirement'),
  missingKeyPoints: z.array(z.string()).optional(),
});

/**
 * WebJudge-style trajectory judge that gates `done`:
 *  - key points are derived from the task UP FRONT (not post-hoc),
 *  - evidence spans the whole trajectory, not just the final state,
 *  - the prompt is skeptical with hard auto-fail conditions; agents
 *    overclaim success far more often than they under-claim.
 */
export class TrajectoryJudge {
  constructor(private readonly model: ChatModel) {}

  async deriveKeyPoints(task: string): Promise<string[]> {
    const output = await generateStructured(
      this.model,
      {
        system:
          'Derive the completion criteria for a web automation task. Each key point must be ' +
          'independently checkable from page evidence ("a confirmation message is visible", ' +
          '"the result contains the product price"). Cover every constraint the task states ' +
          '(counts, filters, formats). Do not invent requirements the task does not state.',
        messages: [{ role: 'user', content: `Task: ${task}` }],
      },
      KeyPointsSchema,
      { toolName: 'submit_key_points' },
    );
    return output.keyPoints;
  }

  async judge(evidence: TrajectoryEvidence): Promise<JudgeVerdict> {
    const text = [
      `# Task\n${evidence.task}`,
      `# Key points (ALL must be demonstrably satisfied)\n${evidence.keyPoints
        .map((point, index) => `${index + 1}. ${point}`)
        .join('\n')}`,
      `# Agent's claim\nsuccess=${evidence.claimedSuccess}\nresult: ${evidence.finalResult}`,
      `# Trajectory\n${evidence.stepSummaries.join('\n')}`,
      `# Observation evidence\n${evidence.observationExcerpts.join('\n---\n')}`,
    ].join('\n\n');

    const content: ContentPart[] = [{ type: 'text', text }];
    if (evidence.finalScreenshot && this.model.caps.vision) {
      content.push({
        type: 'image',
        mediaType: 'image/png',
        dataBase64: evidence.finalScreenshot.dataBase64,
      });
    }

    return generateStructured(
      this.model,
      {
        system:
          'You are a skeptical judge of web automation runs. Be initially doubtful of the ' +
          "agent's self-reported success - agents overclaim far more often than they " +
          'under-claim. Judge ONLY from the evidence provided.\n\n' +
          'Automatic verdict=false conditions:\n' +
          '- any value in the result (URL, price, name, count) does not appear in the evidence\n' +
          '- the agent declared done before completing every key point\n' +
          '- a captcha or bot-wall blocked the run\n' +
          '- the result format does not match what the task asked for\n' +
          '- the trajectory shows the final action failed but was reported as success\n\n' +
          'verdict=true requires positive evidence for EVERY key point. Absence of evidence ' +
          'is failure, not success.',
        messages: [{ role: 'user', content }],
      },
      VerdictSchema,
      { toolName: 'submit_verdict' },
    );
  }
}
