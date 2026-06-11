import { z } from 'zod';
import { ensureError } from '@accura/shared';
import { resolveElement } from '@accura/perception';
import {
  ActionRegistry,
  defineAction,
  type ActionDefinition,
  type ActionResult,
} from './registry.js';

function failure(error: unknown): ActionResult {
  return { ok: false, message: ensureError(error).message };
}

export const navigate = defineAction({
  name: 'navigate',
  description: 'Navigate the active tab to a URL.',
  params: z.object({ url: z.string().describe('Absolute URL including protocol') }),
  terminatesSequence: true,
  async run(ctx, { url }) {
    try {
      await ctx.session.navigate(url);
      return { ok: true, message: `Navigated to ${url}` };
    } catch (error) {
      return failure(error);
    }
  },
});

export const click = defineAction({
  name: 'click',
  description: 'Click an interactive element by its id from the elements list.',
  params: z.object({ id: z.number().int().describe('Element id from the observation') }),
  async run(ctx, { id }) {
    try {
      const handle = await resolveElement(ctx.session, id);
      try {
        await handle.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => undefined);
        await handle.click({ timeout: 5000 });
      } finally {
        await handle.dispose().catch(() => undefined);
      }
      return { ok: true, message: `Clicked element [${id}]` };
    } catch (error) {
      return failure(error);
    }
  },
});

export const input = defineAction({
  name: 'input',
  description:
    'Type text into an input, textarea or contenteditable element. Clears existing content first unless clearFirst is false.',
  params: z.object({
    id: z.number().int().describe('Element id from the observation'),
    text: z.string(),
    clearFirst: z.boolean().default(true),
  }),
  async run(ctx, { id, text, clearFirst }) {
    try {
      const handle = await resolveElement(ctx.session, id);
      try {
        if (clearFirst) {
          await handle.fill(text, { timeout: 5000 });
        } else {
          await handle.click({ timeout: 3000 });
          await ctx.session.page.keyboard.type(text);
        }
      } finally {
        await handle.dispose().catch(() => undefined);
      }
      return { ok: true, message: `Typed "${truncate(text, 60)}" into element [${id}]` };
    } catch (error) {
      return failure(error);
    }
  },
});

export const selectOption = defineAction({
  name: 'selectOption',
  description: 'Select an option in a <select> element by its visible label (or value).',
  params: z.object({
    id: z.number().int().describe('Element id of the <select>'),
    option: z.string().describe('Visible option label, or its value attribute'),
  }),
  async run(ctx, { id, option }) {
    try {
      const handle = await resolveElement(ctx.session, id);
      try {
        try {
          await handle.selectOption({ label: option }, { timeout: 4000 });
        } catch {
          await handle.selectOption({ value: option }, { timeout: 4000 });
        }
      } finally {
        await handle.dispose().catch(() => undefined);
      }
      return { ok: true, message: `Selected "${option}" in element [${id}]` };
    } catch (error) {
      return failure(error);
    }
  },
});

export const scroll = defineAction({
  name: 'scroll',
  description: 'Scroll the page up or down by a number of viewport pages.',
  params: z.object({
    direction: z.enum(['up', 'down']),
    pages: z.number().min(0.2).max(10).default(1),
  }),
  async run(ctx, { direction, pages }) {
    try {
      await ctx.session.page.evaluate(
        ({ direction, pages }) => {
          const delta = window.innerHeight * 0.9 * pages * (direction === 'down' ? 1 : -1);
          window.scrollBy({ top: delta, behavior: 'instant' as ScrollBehavior });
        },
        { direction, pages },
      );
      return { ok: true, message: `Scrolled ${direction} ${pages} page(s)` };
    } catch (error) {
      return failure(error);
    }
  },
});

export const sendKeys = defineAction({
  name: 'sendKeys',
  description:
    'Press keyboard keys or shortcuts on the focused element, e.g. "Enter", "Tab", "Control+a". Separate sequential presses with spaces.',
  params: z.object({ keys: z.string() }),
  async run(ctx, { keys }) {
    try {
      for (const combo of keys.split(' ').filter(Boolean)) {
        await ctx.session.page.keyboard.press(combo);
      }
      return { ok: true, message: `Pressed keys: ${keys}` };
    } catch (error) {
      return failure(error);
    }
  },
});

export const goBack = defineAction({
  name: 'goBack',
  description: 'Go back to the previous page in history.',
  params: z.object({}),
  terminatesSequence: true,
  async run(ctx) {
    try {
      await ctx.session.page.goBack({ timeout: 10_000 });
      return { ok: true, message: 'Went back' };
    } catch (error) {
      return failure(error);
    }
  },
});

export const switchTab = defineAction({
  name: 'switchTab',
  description: 'Switch the active tab by index from the tabs list.',
  params: z.object({ index: z.number().int().min(0) }),
  terminatesSequence: true,
  async run(ctx, { index }) {
    try {
      await ctx.session.switchTab(index);
      return { ok: true, message: `Switched to tab ${index}` };
    } catch (error) {
      return failure(error);
    }
  },
});

export const wait = defineAction({
  name: 'wait',
  description: 'Wait for the page to settle, e.g. after triggering a slow update. Max 10s.',
  params: z.object({ seconds: z.number().min(0.5).max(10).default(2) }),
  async run(_ctx, { seconds }) {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return { ok: true, message: `Waited ${seconds}s` };
  },
});

export const findText = defineAction({
  name: 'findText',
  description: 'Find visible text on the page and scroll it into view.',
  params: z.object({ text: z.string().min(2) }),
  async run(ctx, { text }) {
    try {
      const locator = ctx.session.page.getByText(text).first();
      const count = await ctx.session.page.getByText(text).count();
      if (count === 0) {
        return { ok: false, message: `Text "${truncate(text, 60)}" not found on this page` };
      }
      await locator.scrollIntoViewIfNeeded({ timeout: 4000 });
      return { ok: true, message: `Found "${truncate(text, 60)}" (${count} match(es)), scrolled into view` };
    } catch (error) {
      return failure(error);
    }
  },
});

export const extract = defineAction({
  name: 'extract',
  description:
    'Extract specific information from the full page text using a separate extraction model. Use for long pages where the answer is not in the elements list.',
  params: z.object({ goal: z.string().describe('What to extract, precisely') }),
  async run(ctx, { goal }) {
    if (!ctx.extractor) {
      return { ok: false, message: 'No extraction model configured in this profile' };
    }
    try {
      const pageText: string = await ctx.session.page.evaluate(() =>
        (document.body?.innerText ?? '').slice(0, 30_000),
      );
      const response = await ctx.extractor.generate({
        system:
          'Extract exactly what the goal asks for from the page text. Quote values verbatim. If the information is not present, say NOT_FOUND and what is missing.',
        messages: [{ role: 'user', content: `Goal: ${goal}\n\nPage text:\n${pageText}` }],
      });
      return { ok: true, message: `Extraction result:\n${response.text}`, data: response.text };
    } catch (error) {
      return failure(error);
    }
  },
});

export const writeFile = defineAction({
  name: 'writeFile',
  description: 'Write or overwrite a scratchpad file (e.g. todo.md, results.md).',
  params: z.object({ name: z.string(), content: z.string() }),
  async run(ctx, { name, content }) {
    ctx.scratchpad.set(name, content);
    return { ok: true, message: `Wrote ${content.length} chars to ${name}` };
  },
});

export const readFile = defineAction({
  name: 'readFile',
  description: 'Read a scratchpad file previously written with writeFile.',
  params: z.object({ name: z.string() }),
  async run(ctx, { name }) {
    const content = ctx.scratchpad.get(name);
    if (content === undefined) {
      return { ok: false, message: `No scratchpad file named ${name}` };
    }
    return { ok: true, message: `${name}:\n${content}`, data: content };
  },
});

export const evaluateJs = defineAction({
  name: 'evaluateJs',
  description:
    'Escape hatch: run a JavaScript expression in the page and return its JSON-stringified result. Use only when no other action can do the job.',
  params: z.object({ expression: z.string() }),
  async run(ctx, { expression }) {
    try {
      const value = await ctx.session.page.evaluate((expr) => {
        const result = eval(expr);
        try {
          return JSON.stringify(result)?.slice(0, 2000) ?? 'undefined';
        } catch {
          return String(result).slice(0, 2000);
        }
      }, expression);
      return { ok: true, message: `Result: ${value}`, data: value };
    } catch (error) {
      return failure(error);
    }
  },
});

export const clickAt = defineAction({
  name: 'clickAt',
  description:
    'FALLBACK ONLY: click at viewport pixel coordinates. Use when id-based click failed twice, or the target is a canvas/slider/drag surface with no element id. Coordinates refer to the screenshot you received, whose dimensions are exact.',
  params: z.object({
    x: z.number().min(0).describe('Pixels from the left edge of the viewport'),
    y: z.number().min(0).describe('Pixels from the top edge of the viewport'),
  }),
  async run(ctx, { x, y }) {
    try {
      await ctx.session.page.mouse.click(x, y);
      return { ok: true, message: `Clicked at (${x}, ${y})` };
    } catch (error) {
      return failure(error);
    }
  },
});

export const done = defineAction({
  name: 'done',
  description:
    'Declare the task finished. Set success=false if the task could not be completed, with the reason in result. Every value in result must appear verbatim in your observations.',
  params: z.object({
    success: z.boolean(),
    result: z.string().describe('Final answer or completion summary for the user'),
  }),
  terminatesSequence: true,
  async run(_ctx, { success, result }) {
    return {
      ok: true,
      message: `Done (success=${success})`,
      isDone: true,
      doneSuccess: success,
      data: result,
    };
  },
});

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function coreActions(): ActionDefinition[] {
  return [
    navigate,
    click,
    input,
    selectOption,
    scroll,
    sendKeys,
    goBack,
    switchTab,
    wait,
    findText,
    extract,
    writeFile,
    readFile,
    evaluateJs,
    done,
  ] as unknown as ActionDefinition[];
}

export interface RegistryOptions {
  /**
   * Adds clickAt(x, y). Enable ONLY for coordinate-grounded vision models
   * (Claude); ungrounded models hallucinate coordinates.
   */
  coordinateActions?: boolean;
}

export function buildCoreRegistry(options?: RegistryOptions): ActionRegistry {
  const registry = new ActionRegistry();
  for (const action of coreActions()) registry.register(action);
  if (options?.coordinateActions) {
    registry.register(clickAt as unknown as ActionDefinition);
  }
  return registry;
}
