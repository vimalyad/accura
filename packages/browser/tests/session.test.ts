import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserConfigSchema } from '@accura/shared';
import { BrowserSession } from '../src/session.js';

const config = BrowserConfigSchema.parse({
  headless: true,
  viewportWidth: 800,
  viewportHeight: 600,
  navigationTimeoutMs: 15_000,
});

function dataUrl(html: string): string {
  return `data:text/html,${encodeURIComponent(html)}`;
}

describe('BrowserSession (integration)', () => {
  let session: BrowserSession;

  beforeAll(async () => {
    session = await BrowserSession.launch(config);
  });

  afterAll(async () => {
    await session.close();
  });

  it('navigates and passes the stability gate', async () => {
    await session.navigate(dataUrl('<h1>hello</h1>'));
    const report = await session.waitForStable({ timeoutMs: 8000 });
    expect(report.domContentLoaded).toBe(true);
    expect(report.domStable).toBe(true);
    expect(session.currentUrl()).toContain('data:text/html');
  });

  it('reports unstable DOM while mutations are continuous', async () => {
    await session.navigate(
      dataUrl(
        `<div id="x"></div><script>setInterval(() => {
          document.getElementById('x').textContent = String(Math.random());
        }, 30)</script>`,
      ),
    );
    const report = await session.waitForStable({ timeoutMs: 1500, mutationWindowMs: 200 });
    expect(report.domStable).toBe(false);
  });

  it('takes screenshots whose parsed dimensions match the bytes', async () => {
    await session.navigate(dataUrl('<body style="background:#fff">x</body>'));
    const shot = await session.screenshot();
    expect(shot.width).toBe(800);
    expect(shot.height).toBe(600);
    expect(shot.data.length).toBeGreaterThan(100);
  });

  it('auto-handles dialogs and records them', async () => {
    await session.navigate(dataUrl('<button onclick="alert(\'boo\')">go</button>'));
    await session.page.click('button');
    const events = session.drainEvents();
    expect(events.dialogs).toHaveLength(1);
    expect(events.dialogs[0]).toMatchObject({ type: 'alert', message: 'boo', handled: 'accept' });
  });

  it('adopts popups as the active tab and switches back', async () => {
    await session.navigate(dataUrl('<a id="p" href="about:blank" target="_blank">pop</a>'));
    await session.page.click('#p');
    // Popup adoption is event-driven; give the context event a beat.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const tabs = session.tabs();
    expect(tabs.length).toBe(2);
    expect(tabs.at(-1)?.active).toBe(true);
    expect(session.drainEvents().popupsAdopted).toBe(1);

    await session.switchTab(0);
    expect(session.tabs()[0]?.active).toBe(true);
    await session.switchTab(1);
    await session.page.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(session.tabs().length).toBe(1);
    await session.switchTab(0);
  });

  it('rejects switching to a tab that does not exist', async () => {
    await expect(session.switchTab(99)).rejects.toThrow('No tab at index 99');
  });

  it('exposes a working CDP session', async () => {
    const cdp = await session.cdpSession();
    const result = (await cdp.send('Runtime.evaluate', {
      expression: '6 * 7',
      returnByValue: true,
    })) as { result: { value: number } };
    expect(result.result.value).toBe(42);
    await cdp.detach();
  });
});
