import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentResult } from '@accura/agent';
import { RunManager, type RunWiring } from '../src/runManager.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scriptedWiring(stepDelayMs = 10): RunWiring {
  return async (request, onEvent): Promise<AgentResult> => {
    onEvent({ type: 'start', task: request.task, maxSteps: 3 });
    for (let step = 1; step <= 2; step += 1) {
      await delay(stepDelayMs);
      onEvent({
        type: 'step',
        step,
        maxSteps: 3,
        url: 'https://x.test/',
        goal: `goal ${step}`,
        evaluation: 'success',
        memory: '',
        actionsSummary: 'OK wait',
        verifierNotes: [],
        screenshotBase64: `shot-${step}`,
      });
    }
    onEvent({ type: 'result', success: true, result: 'done!', stepsTaken: 2 });
    return {
      success: true,
      result: 'done!',
      stepsTaken: 2,
      history: [],
      doneRejections: 0,
      planRevisions: 0,
    };
  };
}

async function waitForStatus(
  manager: RunManager,
  id: string,
  statuses: string[],
  timeoutMs = 5000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (statuses.includes(manager.get(id)!.status)) return;
    await delay(10);
  }
  throw new Error(`run ${id} never reached ${statuses.join('/')}`);
}

describe('RunManager', () => {
  it('runs a request to completion and records the outcome', async () => {
    const manager = new RunManager(scriptedWiring());
    const run = manager.create({ task: 'demo' });
    expect(run.status).toBe('queued');

    await waitForStatus(manager, run.id, ['succeeded']);
    const final = manager.get(run.id)!;
    expect(final.stepsTaken).toBe(2);
    expect(final.result).toBe('done!');
    expect(final.finishedAt).toBeDefined();
  });

  it('caps concurrency and queues the overflow', async () => {
    const manager = new RunManager(scriptedWiring(150), 1);
    const first = manager.create({ task: 'one' });
    const second = manager.create({ task: 'two' });

    await waitForStatus(manager, first.id, ['running']);
    expect(manager.get(second.id)!.status).toBe('queued');

    await waitForStatus(manager, second.id, ['succeeded']);
    expect(manager.get(first.id)!.status).toBe('succeeded');
  });

  it('replays buffered events to late subscribers and prunes old screenshots', async () => {
    const manager = new RunManager(scriptedWiring());
    const run = manager.create({ task: 'demo' });
    await waitForStatus(manager, run.id, ['succeeded']);

    const replayed: AgentEvent[] = [];
    manager.subscribe(run.id, (event) => replayed.push(event));

    expect(replayed.map((e) => e.type)).toEqual(['start', 'step', 'step', 'result']);
    const steps = replayed.filter((e) => e.type === 'step');
    expect(steps[0]).not.toHaveProperty('screenshotBase64');
    expect(steps[1]).toMatchObject({ screenshotBase64: 'shot-2' });
  });

  it('marks crashed wiring as error and emits a terminal result event', async () => {
    const manager = new RunManager(async () => {
      throw new Error('browser exploded');
    });
    const run = manager.create({ task: 'boom' });
    await waitForStatus(manager, run.id, ['error']);

    const events: AgentEvent[] = [];
    manager.subscribe(run.id, (event) => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: 'result', success: false });
    expect(manager.get(run.id)!.error).toContain('browser exploded');
  });

  it('returns undefined for unknown runs', () => {
    const manager = new RunManager(scriptedWiring());
    expect(manager.get('nope')).toBeUndefined();
    expect(manager.subscribe('nope', () => undefined)).toBeUndefined();
  });
});
