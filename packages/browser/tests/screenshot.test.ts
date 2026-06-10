import { describe, expect, it } from 'vitest';
import { BrowserError } from '@accura/shared';
import { pngDimensions } from '../src/screenshot.js';

// Minimal valid 1x1 transparent PNG
const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('pngDimensions', () => {
  it('parses width and height from the IHDR chunk', () => {
    expect(pngDimensions(ONE_BY_ONE_PNG)).toEqual({ width: 1, height: 1 });
  });

  it('rejects non-PNG buffers', () => {
    expect(() => pngDimensions(Buffer.from('not a png at all, definitely'))).toThrow(BrowserError);
    expect(() => pngDimensions(Buffer.alloc(4))).toThrow(BrowserError);
  });
});
