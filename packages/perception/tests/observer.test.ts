import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserConfigSchema } from '@accura/shared';
import { BrowserSession } from '@accura/browser';
import { Observer } from '../src/observer.js';
import { resolveElement } from '../src/resolve.js';

const config = BrowserConfigSchema.parse({ headless: true });

function dataUrl(html: string): string {
  return `data:text/html,${encodeURIComponent(html)}`;
}

const FORM_PAGE = `
<html><head><title>Fixture</title></head><body>
  <h1>Sign up</h1>
  <form>
    <label for="email">Email</label>
    <input id="email" type="email" placeholder="you@example.com">
    <input id="pw" type="password" value="supersecret">
    <select id="plan"><option>Free</option><option selected>Pro</option></select>
    <input id="agree" type="checkbox">
    <button type="submit">Create account</button>
    <a href="/terms">Terms</a>
  </form>
  <div id="host"></div>
  <div id="deco" style="cursor:pointer"><span>styled clickable</span></div>
  <script>
    const shadow = document.getElementById('host').attachShadow({mode:'open'});
    shadow.innerHTML = '<button id="shadow-btn">Shadow Button</button>';
  </script>
</body></html>`;

describe('Observer (integration)', () => {
  let session: BrowserSession;
  let observer: Observer;

  beforeAll(async () => {
    session = await BrowserSession.launch(config);
    observer = new Observer(session);
    await session.navigate(dataUrl(FORM_PAGE));
    await session.waitForStable({ timeoutMs: 5000 });
  });

  afterAll(async () => {
    await session.close();
  });

  it('enumerates interactive elements including shadow DOM', async () => {
    const observation = await observer.observe();
    const tags = observation.elements.map((e) => e.tag);
    expect(tags).toContain('input');
    expect(tags).toContain('select');
    expect(tags).toContain('button');
    expect(tags).toContain('a');
    expect(observation.elementsText).toContain('Shadow Button');
    expect(observation.title).toBe('Fixture');
  });

  it('excludes label[for] but reads live form values from properties', async () => {
    await session.page.fill('#email', 'a@b.c');
    const observation = await observer.observe();
    expect(observation.elementsText).not.toMatch(/<label/);
    const email = observation.elements.find((e) => e.attributes.type === 'email');
    expect(email?.attributes.value).toBe('a@b.c');
    const select = observation.elements.find((e) => e.tag === 'select');
    expect(select?.attributes.selected).toBe('Pro');
    expect(select?.attributes.options).toContain('Free|Pro');
  });

  it('never serializes password values', async () => {
    const observation = await observer.observe();
    expect(observation.elementsText).not.toContain('supersecret');
    expect(observation.elementsText).toContain('<redacted>');
  });

  it('detects cursor:pointer elements only at the outermost level', async () => {
    const observation = await observer.observe();
    const pointerElements = observation.elements.filter(
      (e) => e.text?.includes('styled clickable'),
    );
    expect(pointerElements).toHaveLength(1);
    expect(pointerElements[0]?.tag).toBe('div');
  });

  it('keeps ids stable across observations and marks new elements', async () => {
    const first = await observer.observe();
    const buttonBefore = first.elements.find((e) => e.text === 'Create account');

    await session.page.evaluate(() => {
      const extra = document.createElement('button');
      extra.textContent = 'Suggestion';
      document.body.appendChild(extra);
    });

    const second = await observer.observe();
    const buttonAfter = second.elements.find((e) => e.text === 'Create account');
    expect(buttonAfter?.id).toBe(buttonBefore?.id);

    const suggestion = second.elements.find((e) => e.text === 'Suggestion');
    expect(suggestion).toBeDefined();
    expect(second.newElementIds).toContain(suggestion!.id);
    expect(second.elementsText).toContain(`*[${suggestion!.id}]`);
  });

  it('resolves ids back to live elements', async () => {
    const observation = await observer.observe();
    const button = observation.elements.find((e) => e.text === 'Create account');
    const handle = await resolveElement(session, button!.id);
    const text = await handle.evaluate((el) => el.textContent);
    expect(text).toBe('Create account');
    await handle.dispose();
  });

  it('reports an informative error for stale ids', async () => {
    await expect(resolveElement(session, 999_999)).rejects.toThrow(/not found/);
  });

  it('produces empty-page warnings', async () => {
    const blankSession = await BrowserSession.launch(config);
    try {
      await blankSession.navigate(dataUrl('<html><body></body></html>'));
      const blankObserver = new Observer(blankSession);
      const observation = await blankObserver.observe();
      expect(observation.pageStats.warnings.join(' ')).toContain('empty');
    } finally {
      await blankSession.close();
    }
  });
});
