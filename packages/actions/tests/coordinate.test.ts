import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserConfigSchema, createLogger } from '@accura/shared';
import { BrowserSession } from '@accura/browser';
import { Observer } from '@accura/perception';
import { buildCoreRegistry } from '../src/core.js';
import { executeBatch } from '../src/executor.js';
import type { ActionContext } from '../src/context.js';

const config = BrowserConfigSchema.parse({ headless: true });

const PAGE = `data:text/html,${encodeURIComponent(`
<html><body style="margin:0">
  <button style="position:fixed;left:10px;top:10px;width:120px;height:40px"
    onclick="document.body.insertAdjacentHTML('beforeend','<div id=hit>hit</div>')">Target</button>
</body></html>`)}`;

describe('clickAt coordinate fallback', () => {
  let session: BrowserSession;
  let ctx: ActionContext;

  beforeAll(async () => {
    session = await BrowserSession.launch(config);
    ctx = {
      session,
      observer: new Observer(session),
      scratchpad: new Map(),
      log: createLogger('test'),
    };
    await session.navigate(PAGE);
    await session.waitForStable({ timeoutMs: 5000 });
  });

  afterAll(async () => {
    await session.close();
  });

  it('is only registered when coordinate actions are enabled', () => {
    expect(buildCoreRegistry().get('clickAt')).toBeUndefined();
    expect(buildCoreRegistry({ coordinateActions: true }).get('clickAt')).toBeDefined();
  });

  it('clicks at exact viewport coordinates', async () => {
    const registry = buildCoreRegistry({ coordinateActions: true });
    const outcome = await executeBatch(
      [{ name: 'clickAt', params: { x: 70, y: 30 } }],
      registry,
      ctx,
    );
    expect(outcome.executed[0]?.result.ok).toBe(true);
    expect(await session.page.textContent('#hit')).toBe('hit');
  });
});
