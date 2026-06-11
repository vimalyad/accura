import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TraceWriter } from '../src/trace.js';

describe('TraceWriter', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'accura-trace-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes meta, steps, result and screenshots as a replayable trace', async () => {
    const trace = await TraceWriter.create(dir, 'test-run');
    await trace.meta({ task: 'demo task' });
    await trace.step({ step: 1, goal: 'first' });
    await trace.step({ step: 2, goal: 'second' });
    await trace.result({ success: true, result: 'ok' });
    await trace.screenshot(1, Buffer.from('fakepng').toString('base64'));

    const raw = await readFile(join(trace.dir, 'trace.jsonl'), 'utf8');
    const lines = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines.map((l) => l.type)).toEqual(['meta', 'step', 'step', 'result']);
    expect(lines[0]).toMatchObject({ task: 'demo task' });
    expect(lines[3]).toMatchObject({ success: true });
    expect(lines.every((l) => typeof l.at === 'number')).toBe(true);

    const png = await readFile(join(trace.dir, 'screenshots', 'step-1.png'));
    expect(png.toString()).toBe('fakepng');
  });
});
