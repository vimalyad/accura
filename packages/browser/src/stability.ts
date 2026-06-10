import type { Page } from 'playwright';
import type { StabilityOptions, StabilityReport } from './types.js';

/**
 * Gate that runs before every observation. A stale observation (DOM still
 * mutating, requests in flight) is one of the top silent accuracy killers:
 * the model acts on elements that are about to move or disappear.
 *
 * Three layers, each individually capped and non-fatal:
 *  1. domcontentloaded
 *  2. network quiet (Playwright networkidle: 500ms with no requests)
 *  3. DOM mutation quiescence: two consecutive windows with zero mutations
 */
export async function waitForStablePage(
  page: Page,
  options?: StabilityOptions,
): Promise<StabilityReport> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const mutationWindowMs = options?.mutationWindowMs ?? 250;
  const networkQuietTimeoutMs = options?.networkQuietTimeoutMs ?? 5_000;
  const start = Date.now();
  const remaining = () => Math.max(0, timeoutMs - (Date.now() - start));

  let domContentLoaded = true;
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: remaining() });
  } catch {
    domContentLoaded = false;
  }

  let networkQuiet = true;
  try {
    await page.waitForLoadState('networkidle', {
      timeout: Math.min(remaining(), networkQuietTimeoutMs),
    });
  } catch {
    networkQuiet = false;
  }

  const domStable = await waitForDomQuiescence(page, mutationWindowMs, remaining());

  return { domContentLoaded, networkQuiet, domStable, elapsedMs: Date.now() - start };
}

async function waitForDomQuiescence(
  page: Page,
  windowMs: number,
  budgetMs: number,
): Promise<boolean> {
  if (budgetMs <= 0) return false;
  try {
    return await page.evaluate(
      ({ windowMs, budgetMs }) =>
        new Promise<boolean>((resolve) => {
          let mutations = 0;
          const observer = new MutationObserver((records) => {
            mutations += records.length;
          });
          observer.observe(document.documentElement ?? document, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
          let quietWindows = 0;
          const started = Date.now();
          const tick = () => {
            quietWindows = mutations === 0 ? quietWindows + 1 : 0;
            mutations = 0;
            if (quietWindows >= 2) {
              observer.disconnect();
              resolve(true);
              return;
            }
            if (Date.now() - started >= budgetMs) {
              observer.disconnect();
              resolve(false);
              return;
            }
            setTimeout(tick, windowMs);
          };
          setTimeout(tick, windowMs);
        }),
      { windowMs, budgetMs },
    );
  } catch {
    // Navigation destroyed the execution context mid-wait — page is
    // definitionally not stable yet; the caller may re-gate.
    return false;
  }
}
