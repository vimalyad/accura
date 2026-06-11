/**
 * Auth e2e against the DOCKERIZED stack (run `docker compose up -d` first):
 * auth gate renders → signup via UI → console appears with account chip →
 * API-level scoping spot-check with a second user.
 */
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.ACCURA_URL ?? 'http://localhost:7700';
const stamp = Date.now();
const alice = { email: `alice-${stamp}@example.com`, password: 'alice-password-1' };
const bob = { email: `bob-${stamp}@example.com`, password: 'bob-password-12' };

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// 1. anonymous visit → auth gate
await page.goto(BASE);
await page.waitForSelector('.auth-card', { timeout: 15000 });
await page.screenshot({ path: resolve('..', '..', 'reference', 'shots', '06-auth-gate.png') });
console.log('auth gate rendered');

// 2. signup through the UI
await page.click('.auth-tabs button:nth-child(2)');
await page.fill('input[name=email]', alice.email);
await page.fill('input[name=password]', alice.password);
await page.click('.auth-submit');
await page.waitForSelector('.header .account-email', { timeout: 15000 });
const chip = await page.textContent('.header .account-email');
console.log(`signed up and entered console as: ${chip}`);
await page.screenshot({ path: resolve('..', '..', 'reference', 'shots', '07-authed-console.png') });

// 3. API scoping: alice creates a run; bob must not see it
const aliceRun = await page.evaluate(async () => {
  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'alice secret task', maxSteps: 1 }),
  });
  return res.json();
});
console.log(`alice created run ${aliceRun.id}`);

const bobContext = await browser.newContext();
const bobPage = await bobContext.newPage();
const bobSignup = await bobPage.request.post(`${BASE}/api/auth/signup`, { data: bob });
if (bobSignup.status() !== 201) throw new Error(`bob signup failed: ${bobSignup.status()}`);
const bobRuns = await (await bobPage.request.get(`${BASE}/api/runs`)).json();
const bobSeesAlice = bobRuns.some((r) => r.id === aliceRun.id);
const bobDirect = await bobPage.request.get(`${BASE}/api/runs/${aliceRun.id}`);
console.log(`bob sees alice's run in list: ${bobSeesAlice}; direct fetch: ${bobDirect.status()}`);

const anonymous = await browser.newContext();
const anonStatus = (await (await anonymous.newPage()).request.get(`${BASE}/api/runs`)).status();
console.log(`anonymous /api/runs: ${anonStatus}`);

await browser.close();

if (bobSeesAlice || bobDirect.status() !== 404 || anonStatus !== 401) {
  console.error('AUTH CHECK FAILED');
  process.exit(1);
}
console.log('AUTH CHECK PASSED: gate, signup, scoping and guard all verified');
