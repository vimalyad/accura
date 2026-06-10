import { BrowserError } from '@accura/shared';
import type { Page } from 'playwright';
import type { ScreenshotResult } from './types.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Reads actual pixel dimensions from a PNG buffer (IHDR chunk).
 *
 * Vision models must be told dimensions that exactly match the bytes sent —
 * a mismatch produces systematic coordinate offsets in click grounding. We
 * therefore parse the real encoded size instead of trusting viewport config
 * (deviceScaleFactor can silently change it).
 */
export function pngDimensions(data: Buffer): { width: number; height: number } {
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new BrowserError('Buffer is not a PNG image', {
      context: { length: data.length },
    });
  }
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

export async function takeScreenshot(page: Page): Promise<ScreenshotResult> {
  const data = await page.screenshot({ type: 'png' });
  const { width, height } = pngDimensions(data);
  return { data, width, height };
}
