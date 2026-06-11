import { createLogger } from '@accura/shared';
import type { Observer } from '@accura/perception';
import { executeBatch, type ActionContext, type ActionRegistry } from '@accura/actions';
import type { Skill, SkillStep } from './types.js';

const log = createLogger('memory:replay');

export interface ReplayResult {
  skillId: string;
  attemptedSteps: number;
  succeededSteps: number;
  /** 1-based index of the failing step, when replay stopped early. */
  failedAtStep?: number;
  complete: boolean;
  /** One line per step for the agent's history. */
  summary: string;
}

/**
 * Deterministic skill replay with live fallback (the production accuracy+
 * cost pattern): each cached step RE-GROUNDS against the live page by
 * target text — never by stored element ids. The first step that cannot be
 * grounded or fails stops the replay and hands control back to the live
 * executor, which continues from wherever the page actually is.
 */
export class SkillReplayer {
  constructor(
    private readonly registry: ActionRegistry,
    private readonly ctx: ActionContext,
    private readonly observer: Observer,
  ) {}

  async replay(skill: Skill): Promise<ReplayResult> {
    const lines: string[] = [];
    let succeeded = 0;

    for (let index = 0; index < skill.steps.length; index += 1) {
      const step = skill.steps[index]!;
      const grounded = await this.ground(step);
      if (!grounded.ok) {
        lines.push(`step ${index + 1} (${step.action}): ${grounded.message}`);
        return this.finish(skill, lines, succeeded, index + 1);
      }

      const outcome = await executeBatch([grounded.invocation], this.registry, this.ctx, {
        maxActions: 1,
      });
      const executed = outcome.executed[0];
      const ok = executed?.result.ok ?? false;
      lines.push(
        `step ${index + 1} (${step.action}): ${ok ? 'OK' : 'FAILED'} ${executed?.result.message ?? ''}`,
      );
      if (!ok) {
        return this.finish(skill, lines, succeeded, index + 1);
      }
      succeeded += 1;
      await this.ctx.session.waitForStable({ timeoutMs: 5000 });
    }

    return this.finish(skill, lines, succeeded);
  }

  private async ground(
    step: SkillStep,
  ): Promise<{ ok: true; invocation: { name: string; params: Record<string, unknown> } } | { ok: false; message: string }> {
    if (!step.targetText) {
      return { ok: true, invocation: { name: step.action, params: step.params } };
    }
    const observation = await this.observer.observe();
    const needle = step.targetText.toLowerCase();
    const match = observation.elements.find((element) => {
      const haystacks = [
        element.text,
        element.attributes.placeholder,
        element.attributes['aria-label'],
        element.attributes.name,
        element.attributes.title,
      ];
      return haystacks.some((h) => h?.toLowerCase().includes(needle));
    });
    if (!match) {
      return {
        ok: false,
        message: `no element matching "${step.targetText}" on the live page - falling back to the live executor`,
      };
    }
    return { ok: true, invocation: { name: step.action, params: { ...step.params, id: match.id } } };
  }

  private finish(
    skill: Skill,
    lines: string[],
    succeeded: number,
    failedAtStep?: number,
  ): ReplayResult {
    const complete = succeeded === skill.steps.length;
    const result: ReplayResult = {
      skillId: skill.id,
      attemptedSteps: failedAtStep ?? skill.steps.length,
      succeededSteps: succeeded,
      complete,
      ...(failedAtStep !== undefined ? { failedAtStep } : {}),
      summary:
        `Skill replay "${skill.title}": ${succeeded}/${skill.steps.length} steps ` +
        `${complete ? 'completed' : `(stopped at step ${failedAtStep})`}\n` +
        lines.map((line) => `  ${line}`).join('\n'),
    };
    log.info({ skill: skill.title, succeeded, complete }, 'replay finished');
    return result;
  }
}

/** Renders matching skills for the planner/executor prompt. */
export function renderSkills(skills: Skill[]): string {
  return skills
    .map(
      (skill) =>
        `- ${skill.title} (score ${skill.score}): ${skill.steps
          .map((step) => step.targetText ? `${step.action} "${step.targetText}"` : step.action)
          .join(' -> ')}`,
    )
    .join('\n');
}
