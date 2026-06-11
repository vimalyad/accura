import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BrowserConfigSchema, createLogger } from '@accura/shared';
import { BrowserSession } from '@accura/browser';
import { Observer } from '@accura/perception';
import { buildCoreRegistry, type ActionContext } from '@accura/actions';
import { SkillReplayer, renderSkills } from '../src/replay.js';
import type { Skill } from '../src/types.js';

const config = BrowserConfigSchema.parse({ headless: true });

function dataUrl(html: string): string {
  return `data:text/html,${encodeURIComponent(html)}`;
}

const FORM_PAGE = dataUrl(`
<html><head><title>Signup</title></head><body>
  <form id="f">
    <input id="name" type="text" placeholder="Full name">
    <input id="email" type="email" placeholder="Email address">
    <button type="submit">Submit form</button>
  </form>
  <script>
    document.getElementById('f').addEventListener('submit', (e) => {
      e.preventDefault();
      const msg = document.createElement('div');
      msg.id = 'msg';
      msg.textContent = 'Thanks ' + document.getElementById('name').value;
      document.body.appendChild(msg);
    });
  </script>
</body></html>`);

function skill(steps: Skill['steps']): Skill {
  return {
    id: 'sk-1',
    domain: 'fixture',
    title: 'Sign up',
    urlPattern: 'data:text/html',
    preconditions: [],
    steps,
    score: 1,
    uses: 1,
    createdAt: new Date().toISOString(),
    retired: false,
  };
}

describe('SkillReplayer (integration)', () => {
  let session: BrowserSession;
  let observer: Observer;
  let ctx: ActionContext;
  const registry = buildCoreRegistry();

  beforeAll(async () => {
    session = await BrowserSession.launch(config);
    observer = new Observer(session);
    ctx = { session, observer, scratchpad: new Map(), log: createLogger('test') };
  });

  beforeEach(async () => {
    await session.navigate(FORM_PAGE);
    await session.waitForStable({ timeoutMs: 5000 });
  });

  afterAll(async () => {
    await session.close();
  });

  it('replays a full recipe by re-grounding each step on the live page', async () => {
    const replayer = new SkillReplayer(registry, ctx, observer);
    const result = await replayer.replay(
      skill([
        { action: 'input', targetText: 'Full name', params: { text: 'Ada' } },
        { action: 'input', targetText: 'Email address', params: { text: 'a@b.c' } },
        { action: 'click', targetText: 'Submit form', params: {} },
      ]),
    );

    expect(result.complete).toBe(true);
    expect(result.succeededSteps).toBe(3);
    expect(await session.page.textContent('#msg')).toBe('Thanks Ada');
  });

  it('stops at the first ungroundable step and hands control back', async () => {
    const replayer = new SkillReplayer(registry, ctx, observer);
    const result = await replayer.replay(
      skill([
        { action: 'input', targetText: 'Full name', params: { text: 'Ada' } },
        { action: 'click', targetText: 'Button That Does Not Exist', params: {} },
        { action: 'click', targetText: 'Submit form', params: {} },
      ]),
    );

    expect(result.complete).toBe(false);
    expect(result.succeededSteps).toBe(1);
    expect(result.failedAtStep).toBe(2);
    expect(result.summary).toContain('falling back to the live executor');
    // first step's effect persists - the live executor continues from here
    const value = await session.page.inputValue('#name');
    expect(value).toBe('Ada');
  });
});

describe('renderSkills', () => {
  it('renders compact one-liners for the prompt', () => {
    const text = renderSkills([
      skill([
        { action: 'input', targetText: 'Search', params: { text: '{query}' } },
        { action: 'sendKeys', params: { keys: 'Enter' } },
      ]),
    ]);
    expect(text).toBe('- Sign up (score 1): input "Search" -> sendKeys');
  });
});
