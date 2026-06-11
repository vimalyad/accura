import { z } from 'zod';
import { ActionError } from '@accura/shared';
import type { ActionContext } from './context.js';

export interface ActionResult {
  ok: boolean;
  /** Surfaced verbatim to the model in the next step's history. */
  message: string;
  data?: unknown;
  isDone?: boolean;
  doneSuccess?: boolean;
}

export interface ActionDefinition<P extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  params: P;
  /**
   * Actions that change page context (navigate, goBack, switchTab) abort
   * the rest of a multi-action batch — later actions were planned against
   * a DOM that no longer exists.
   */
  terminatesSequence?: boolean;
  /** Gated behind outcome simulation in later phases (submit/purchase/delete). */
  irreversible?: boolean;
  run(ctx: ActionContext, params: z.infer<P>): Promise<ActionResult>;
}

export interface ActionInvocation {
  name: string;
  params: Record<string, unknown>;
}

export function defineAction<P extends z.ZodObject>(
  definition: ActionDefinition<P>,
): ActionDefinition<P> {
  return definition;
}

export class ActionRegistry {
  private readonly actions = new Map<string, ActionDefinition>();

  register(definition: ActionDefinition): this {
    if (this.actions.has(definition.name)) {
      throw new ActionError(`Action "${definition.name}" is already registered`);
    }
    this.actions.set(definition.name, definition);
    return this;
  }

  get(name: string): ActionDefinition | undefined {
    return this.actions.get(name);
  }

  list(): ActionDefinition[] {
    return [...this.actions.values()];
  }

  /**
   * Discriminated union over `{ name, params }` — embedded in the executor's
   * structured-output schema so every emitted action is validated against
   * its exact parameter schema before anything touches the browser.
   */
  invocationSchema(): z.ZodType<ActionInvocation> {
    const definitions = this.list();
    if (definitions.length === 0) {
      throw new ActionError('Cannot build invocation schema from an empty registry');
    }
    const variants = definitions.map((definition) =>
      z
        .object({
          name: z.literal(definition.name),
          params: definition.params,
        })
        .describe(definition.description),
    );
    return z.discriminatedUnion('name', variants as never) as unknown as z.ZodType<ActionInvocation>;
  }

  /** Compact catalog for the system prompt. */
  describeCatalog(): string {
    return this.list()
      .map((definition) => {
        const shape = definition.params.shape;
        const params = Object.entries(shape)
          .map(([key, schema]) => {
            const optional = schema instanceof z.ZodOptional || schema instanceof z.ZodDefault;
            return optional ? `${key}?` : key;
          })
          .join(', ');
        return `- ${definition.name}(${params}): ${definition.description}`;
      })
      .join('\n');
  }
}
