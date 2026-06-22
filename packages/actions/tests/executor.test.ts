import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BrowserConfigSchema, createLogger } from '@accura/shared';
import { BrowserSession } from '@accura/browser';
import { Observer } from '@accura/perception';
import { buildCoreRegistry } from '../src/core.js';
import { executeBatch, summarizeOutcome } from '../src/executor.js';
import type { ActionContext } from '../src/context.js';

const config = BrowserConfigSchema.parse({ headless: true });

function dataUrl(html: string): string {
  return `data:text/html,${encodeURIComponent(html)}`;
}

const FORM_PAGE = `
<html><head><title>Form</title></head><body>
  <input id="name" type="text" placeholder="Name">
  <select id="plan"><option value="f">Free</option><option value="p">Pro</option></select>
  <button id="go" onclick="document.getElementById('out').textContent='clicked:'+document.getElementById('name').value">Go</button>
  <button id="dbl" ondblclick="document.getElementById('out').textContent='double'">Double</button>
  <a id="away" href="about:blank">Leave</a>
  <div id="out"></div>
</body></html>`;

describe('executeBatch (integration)', () => {
  let session: BrowserSession;
  let observer: Observer;
  let ctx: ActionContext;
  const registry = buildCoreRegistry();

  beforeAll(async () => {
    session = await BrowserSession.launch(config);
    observer = new Observer(session);
    ctx = {
      session,
      observer,
      scratchpad: new Map(),
      log: createLogger('test'),
    };
  });

  beforeEach(async () => {
    await session.navigate(dataUrl(FORM_PAGE));
    await session.waitForStable({ timeoutMs: 5000 });
  });

  afterAll(async () => {
    await session.close();
  });

  async function idOf(predicate: (text: string) => boolean): Promise<number> {
    const observation = await observer.observe();
    const element = observation.elements.find(
      (e) =>
        predicate(e.text ?? '') ||
        predicate(e.attributes.placeholder ?? '') ||
        predicate(e.attributes.name ?? ''),
    );
    if (!element) throw new Error('fixture element not found');
    return element.id;
  }

  it('runs input + click in one batch and stops cleanly', async () => {
    const nameId = await idOf((t) => t === 'Name');
    const goId = await idOf((t) => t === 'Go');

    const outcome = await executeBatch(
      [
        { name: 'input', params: { id: nameId, text: 'Ada' } },
        { name: 'click', params: { id: goId } },
      ],
      registry,
      ctx,
    );

    expect(outcome.executed).toHaveLength(2);
    expect(outcome.executed.every((a) => a.result.ok)).toBe(true);
    expect(outcome.skipped).toHaveLength(0);
    const out = await session.page.textContent('#out');
    expect(out).toBe('clicked:Ada');
  });

  it('doubleClick fires a dblclick on the target element', async () => {
    const dblId = await idOf((t) => t === 'Double');
    const outcome = await executeBatch(
      [{ name: 'doubleClick', params: { id: dblId } }],
      registry,
      ctx,
    );
    expect(outcome.executed[0]?.result.ok).toBe(true);
    expect(await session.page.textContent('#out')).toBe('double');
  });

  it('skips the tail after a page-changing action and reports it', async () => {
    const linkId = await idOf((t) => t === 'Leave');
    const outcome = await executeBatch(
      [
        { name: 'click', params: { id: linkId } },
        { name: 'sendKeys', params: { keys: 'Enter' } },
      ],
      registry,
      ctx,
    );

    // allow navigation to settle before asserting
    await session.waitForStable({ timeoutMs: 5000 });
    expect(outcome.executed).toHaveLength(1);
    expect(outcome.skipped).toHaveLength(1);
    expect(outcome.skippedReason).toContain('page changed');
    expect(summarizeOutcome(outcome)).toContain('SKIPPED sendKeys');
  });

  it('stops the batch on action failure with an informative message', async () => {
    const outcome = await executeBatch(
      [
        { name: 'click', params: { id: 987_654 } },
        { name: 'wait', params: { seconds: 1 } },
      ],
      registry,
      ctx,
    );
    expect(outcome.executed[0]?.result.ok).toBe(false);
    expect(outcome.executed[0]?.result.message).toContain('not found');
    expect(outcome.skipped).toHaveLength(1);
  });

  it('rejects invalid params without touching the browser', async () => {
    const outcome = await executeBatch(
      [{ name: 'scroll', params: { direction: 'sideways' } }],
      registry,
      ctx,
    );
    expect(outcome.executed[0]?.result.ok).toBe(false);
    expect(outcome.executed[0]?.result.message).toContain('Invalid parameters');
  });

  it('selectOption works by label and by value', async () => {
    const selectId = await idOf(() => false).catch(async () => {
      const observation = await observer.observe();
      return observation.elements.find((e) => e.tag === 'select')!.id;
    });
    const outcome = await executeBatch(
      [{ name: 'selectOption', params: { id: selectId, option: 'Pro' } }],
      registry,
      ctx,
    );
    expect(outcome.executed[0]?.result.ok).toBe(true);
    const value = await session.page.inputValue('#plan');
    expect(value).toBe('p');
  });

  it('done stops everything and carries the result payload', async () => {
    const outcome = await executeBatch(
      [
        { name: 'done', params: { success: true, result: 'all good' } },
        { name: 'wait', params: { seconds: 1 } },
      ],
      registry,
      ctx,
    );
    expect(outcome.done).toEqual({ success: true, result: 'all good' });
    expect(outcome.skipped).toHaveLength(1);
  });

  it('scratchpad write/read roundtrip', async () => {
    const outcome = await executeBatch(
      [
        { name: 'writeFile', params: { name: 'todo.md', content: '- [ ] step 1' } },
        { name: 'readFile', params: { name: 'todo.md' } },
      ],
      registry,
      ctx,
    );
    expect(outcome.executed[1]?.result.message).toContain('- [ ] step 1');
  });
});
