import { generateStructured, type ChatModel } from '@accura/llm';
import { SkillDraftSchema, type SkillDraft } from './types.js';

/**
 * Distills a judge-approved trajectory into a reusable, parameterized
 * recipe (AWM/SkillWeaver pattern — the compounding accuracy term).
 * Task-specific values are abstracted into placeholders and PII is
 * redacted both by instruction and deterministically afterwards.
 */
export class SkillInductor {
  constructor(private readonly model: ChatModel) {}

  async induce(task: string, url: string, stepSummaries: string[]): Promise<SkillDraft> {
    const draft = await generateStructured(
      this.model,
      {
        system:
          'Distill a SUCCESSFUL web automation trajectory into a reusable recipe for the ' +
          'same site. Rules:\n' +
          '- steps reference targets by VISIBLE TEXT (targetText), never by element id;\n' +
          '- replace task-specific values with placeholders like {name}, {query}, {date};\n' +
          '- NEVER include personal data (emails, names, phone numbers, addresses) verbatim;\n' +
          '- keep only load-bearing steps - drop exploration, scrolling-around and retries;\n' +
          '- urlPattern is the URL substring where the recipe applies (host and path prefix).',
        messages: [
          {
            role: 'user',
            content: [
              `Task that succeeded: ${task}`,
              `Site: ${url}`,
              `Trajectory:\n${stepSummaries.join('\n')}`,
            ].join('\n\n'),
          },
        ],
      },
      SkillDraftSchema,
      { toolName: 'submit_skill' },
    );
    return redactDraft(draft);
  }
}

/** Defense in depth: deterministic PII scrub after the model's own redaction. */
export function redactDraft(draft: SkillDraft): SkillDraft {
  return {
    ...draft,
    title: redact(draft.title),
    preconditions: draft.preconditions.map(redact),
    steps: draft.steps.map((step) => ({
      ...step,
      ...(step.targetText !== undefined ? { targetText: redact(step.targetText) } : {}),
      params: Object.fromEntries(
        Object.entries(step.params).map(([key, value]) => [
          key,
          typeof value === 'string' ? redact(value) : value,
        ]),
      ),
    })),
  };
}

function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '{email}')
    .replace(/\b\d{10,}\b/g, '{number}');
}
