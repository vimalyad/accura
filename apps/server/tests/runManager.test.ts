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
    await manager.subscribe(run.id, (event) => replayed.push(event));

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
    await manager.subscribe(run.id, (event) => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: 'result', success: false });
    expect(manager.get(run.id)!.error).toContain('browser exploded');
  });

  it('returns undefined for unknown runs', async () => {
    const manager = new RunManager(scriptedWiring());
    expect(manager.get('nope')).toBeUndefined();
    expect(await manager.subscribe('nope', () => undefined)).toBeUndefined();
  });
});

/** In-memory RunPersistence double — validates the persistence contract. */
function fakePersistence() {
  const runs = new Map<string, Record<string, unknown>>();
  const events = new Map<string, AgentEvent[]>();
  return {
    runs,
    events,
    async insertRun(summary: { id: string }) {
      runs.set(summary.id, { ...summary });
    },
    async updateRun(summary: { id: string }) {
      runs.set(summary.id, { ...runs.get(summary.id), ...summary });
    },
    async appendEvent(runId: string, seq: number, event: AgentEvent) {
      const list = events.get(runId) ?? [];
      list[seq] = event;
      events.set(runId, list);
    },
    async listRuns() {
      return [...runs.values()] as never;
    },
    async listEvents(runId: string) {
      return events.get(runId) ?? [];
    },
  };
}

describe('RunManager persistence', () => {
  it('persists run lifecycle and events', async () => {
    const persistence = fakePersistence();
    const manager = new RunManager(scriptedWiring(), 2, persistence);
    const run = manager.create({ task: 'persist me' });
    await waitForStatus(manager, run.id, ['succeeded']);
    // fire-and-forget writes settle on the microtask queue
    await delay(50);

    expect(persistence.runs.get(run.id)).toMatchObject({
      status: 'succeeded',
      result: 'done!',
      stepsTaken: 2,
    });
    expect(persistence.events.get(run.id)?.map((e) => e.type)).toEqual([
      'start',
      'step',
      'step',
      'result',
    ]);
  });

  it('hydrates history after a restart and replays persisted events', async () => {
    const persistence = fakePersistence();
    const before = new RunManager(scriptedWiring(), 2, persistence);
    const run = before.create({ task: 'survive restarts' });
    await waitForStatus(before, run.id, ['succeeded']);
    await delay(50);

    // "restart": a brand-new manager over the same persistence
    const after = new RunManager(scriptedWiring(), 2, persistence);
    await after.hydrate();

    expect(after.get(run.id)).toMatchObject({ task: 'survive restarts', status: 'succeeded' });

    const replayed: AgentEvent[] = [];
    await after.subscribe(run.id, (event) => replayed.push(event));
    expect(replayed.map((e) => e.type)).toEqual(['start', 'step', 'step', 'result']);
  });

  it('marks interrupted runs as errors on hydration', async () => {
    const persistence = fakePersistence();
    persistence.runs.set('stuck-run', {
      id: 'stuck-run',
      task: 'was mid-flight',
      profile: 'dev',
      status: 'running',
      createdAt: new Date().toISOString(),
    });

    const manager = new RunManager(scriptedWiring(), 2, persistence);
    await manager.hydrate();
    await delay(20);

    expect(manager.get('stuck-run')).toMatchObject({
      status: 'error',
      error: 'interrupted by server restart',
    });
    expect(persistence.runs.get('stuck-run')).toMatchObject({ status: 'error' });
  });
});
