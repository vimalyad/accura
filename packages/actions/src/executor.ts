import { createLogger } from '@accura/shared';
import type { ActionContext } from './context.js';
import type { ActionInvocation, ActionRegistry, ActionResult } from './registry.js';

const log = createLogger('actions:executor');

export interface ExecutedAction {
  name: string;
  params: unknown;
  result: ActionResult;
}

export interface BatchOutcome {
  executed: ExecutedAction[];
  /** Tail of the batch that was not run, so the model can re-issue it. */
  skipped: ActionInvocation[];
  skippedReason?: string;
  done?: { success: boolean; result: string };
}

export interface ExecuteOptions {
  maxActions?: number;
  waitBetweenMs?: number;
}

/**
 * Runs a multi-action batch with two stale-DOM guards:
 *
 *  1. Static: actions flagged `terminatesSequence` end the batch.
 *  2. Runtime: if the URL changed after any action, the rest of the batch
 *     was planned against a DOM that no longer exists — skip it and report
 *     the skipped tail so the model re-issues it against fresh state.
 *
 * A failed action also stops the batch; its error message is surfaced.
 */
export async function executeBatch(
  invocations: ActionInvocation[],
  registry: ActionRegistry,
  ctx: ActionContext,
  options?: ExecuteOptions,
): Promise<BatchOutcome> {
  const maxActions = options?.maxActions ?? 3;
  const waitBetweenMs = options?.waitBetweenMs ?? 200;

  const batch = invocations.slice(0, maxActions);
  const overflow = invocations.slice(maxActions);
  const outcome: BatchOutcome = { executed: [], skipped: [...overflow] };
  if (overflow.length > 0) {
    outcome.skippedReason = `batch limited to ${maxActions} actions`;
  }

  for (let index = 0; index < batch.length; index += 1) {
    const invocation = batch[index]!;
    const definition = registry.get(invocation.name);
    if (!definition) {
      outcome.executed.push({
        name: invocation.name,
        params: invocation.params,
        result: { ok: false, message: `Unknown action "${invocation.name}"` },
      });
      stopWith(outcome, batch, index + 1, 'previous action failed');
      break;
    }

    const parsed = definition.params.safeParse(invocation.params);
    if (!parsed.success) {
      outcome.executed.push({
        name: invocation.name,
        params: invocation.params,
        result: {
          ok: false,
          message: `Invalid parameters for ${invocation.name}: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
        },
      });
      stopWith(outcome, batch, index + 1, 'previous action failed');
      break;
    }

    const urlBefore = ctx.session.currentUrl();
    let result: ActionResult;
    try {
      result = await definition.run(ctx, parsed.data);
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    outcome.executed.push({ name: invocation.name, params: parsed.data, result });
    log.debug({ action: invocation.name, ok: result.ok }, result.message);

    if (result.isDone) {
      outcome.done = {
        success: result.doneSuccess ?? false,
        result: typeof result.data === 'string' ? result.data : '',
      };
      stopWith(outcome, batch, index + 1, 'task declared done');
      break;
    }
    if (!result.ok) {
      stopWith(outcome, batch, index + 1, 'previous action failed');
      break;
    }
    if (definition.terminatesSequence) {
      stopWith(outcome, batch, index + 1, `${invocation.name} changes page context`);
      break;
    }
    if (index < batch.length - 1) {
      // Settle BEFORE the URL guard: a click that triggers navigation
      // returns before the navigation commits, and checking immediately
      // would let the next action run against the dying page.
      if (waitBetweenMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitBetweenMs));
      }
      if (ctx.session.currentUrl() !== urlBefore) {
        stopWith(outcome, batch, index + 1, 'page changed after action');
        break;
      }
    }
  }

  return outcome;
}

function stopWith(
  outcome: BatchOutcome,
  batch: ActionInvocation[],
  fromIndex: number,
  reason: string,
): void {
  const tail = batch.slice(fromIndex);
  if (tail.length > 0) {
    outcome.skipped = [...tail, ...outcome.skipped];
    outcome.skippedReason = reason;
  }
}

/** One-line summary per action for the model's history. */
export function summarizeOutcome(outcome: BatchOutcome): string {
  const lines = outcome.executed.map(
    (action) => `${action.result.ok ? 'OK' : 'FAILED'} ${action.name}: ${action.result.message}`,
  );
  if (outcome.skipped.length > 0) {
    lines.push(
      `SKIPPED ${outcome.skipped.map((s) => s.name).join(', ')} (${outcome.skippedReason}) - re-issue against the new page state if still needed.`,
    );
  }
  return lines.join('\n');
}
