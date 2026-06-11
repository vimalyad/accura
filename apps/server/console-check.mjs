/**
 * Phase 9 exit-criterion check: boots the real server with the built web
 * console and a scripted agent (real browser, scripted executor), then
 * drives the console UI with Playwright like a user would:
 * submit task -> watch live steps + screenshots -> see the verdict.
 */
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { BrowserSession } from '@accura/browser';
import { buildCoreRegistry } from '@accura/actions';
import { Agent } from '@accura/agent';
import { ModelSpecSchema } from '@accura/shared';
import { RunManager } from './dist/runManager.js';
import { buildServer } from './dist/server.js';

const spec = ModelSpecSchema.parse({ provider: 'openai-compatible', model: 'scripted' });

const FIXTURE = `data:text/html,${encodeURIComponent(`
<html><head><title>Signup</title></head><body>
  <h1>Create your account</h1>
  <form id="f">
    <input id="name" type="text" placeholder="Full name">
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
</body></html>`)}`;

function scriptedExecutor() {
  let calls = 0;
  return {
    id: 'scripted',
    spec,
    caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
    async generate(request) {
      calls += 1;
      const last = request.messages.at(-1);
      const text =
        typeof last?.content === 'string'
          ? last.content
          : (last?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');
      await new Promise((r) => setTimeout(r, 400)); // let the UI visibly stream
      let step;
      if (text.includes('Thanks Ada')) {
        step = {
          evaluationPreviousGoal: 'success',
          memory: 'form submitted',
          nextGoal: 'report completion',
          actions: [{ name: 'done', params: { success: true, result: 'Signed up. Confirmation: Thanks Ada' } }],
        };
      } else {
        const name = text.match(/\[(\d+)\]<input[^>]*placeholder="Full name"/);
        const btn = text.match(/\[(\d+)\]<button[^>]*> "Submit form"/);
        step = {
          evaluationPreviousGoal: calls === 1 ? 'first-step' : 'uncertain',
          memory: 'on form',
          nextGoal: 'fill and submit the form',
          actions: [
            { name: 'input', params: { id: Number(name[1]), text: 'Ada' } },
            { name: 'click', params: { id: Number(btn[1]) } },
          ],
        };
      }
      return {
        text: '',
        toolCalls: [{ id: `c${calls}`, name: 'agent_step', arguments: step }],
        stopReason: 'tool_use',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
      };
    },
  };
}

const wiring = async (request, onEvent) => {
  const session = await BrowserSession.launch({
    headless: true,
    viewportWidth: 1024,
    viewportHeight: 700,
    navigationTimeoutMs: 15000,
  });
  try {
    const agent = new Agent({
      session,
      registry: buildCoreRegistry(),
      executorModel: scriptedExecutor(),
      useVision: true, // screenshots stream to the console even with a DOM-only model
      maxSteps: request.maxSteps ?? 5,
      startUrl: FIXTURE,
      onEvent,
    });
    return await agent.run(request.task);
  } finally {
    await session.close();
  }
};

const manager = new RunManager(wiring, 1);
const app = buildServer(manager, { staticDir: resolve('..', 'web', 'dist') });
const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
console.log(`server up at ${baseUrl}`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(baseUrl);
await page.fill('textarea[name=task]', 'Sign up as Ada and report the confirmation message');
await page.click('button[type=submit]');

await page.waitForSelector('.card .goal', { timeout: 20000 });
await page.waitForTimeout(800);
await page.screenshot({ path: resolve('..', '..', 'reference', 'shots', '04-accura-console-live.png') });
console.log('captured live view');

await page.waitForSelector('.result-banner', { timeout: 30000 });
const banner = await page.textContent('.result-banner');
const screenshotVisible = await page.locator('.screenshot-pane img').count();
await page.screenshot({ path: resolve('..', '..', 'reference', 'shots', '05-accura-console-done.png') });
console.log(`result banner: ${banner?.trim()}`);
console.log(`screenshot pane populated: ${screenshotVisible > 0}`);

await browser.close();
await app.close();

if (!banner?.includes('Verified') || screenshotVisible === 0) {
  console.error('EXIT CRITERION FAILED');
  process.exit(1);
}
console.log('EXIT CRITERION PASSED: console drove a run end-to-end');
