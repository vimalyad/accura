import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentResult } from '@accura/agent';
import { RunManager, type RunWiring } from '../src/runManager.js';
import { buildServer } from '../src/server.js';

const wiring: RunWiring = async (request, onEvent): Promise<AgentResult> => {
  onEvent({ type: 'start', task: request.task, maxSteps: 2 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  onEvent({
    type: 'step',
    step: 1,
    maxSteps: 2,
    url: request.startUrl ?? 'https://x.test/',
    goal: 'do the thing',
    evaluation: 'first-step',
    memory: '',
    actionsSummary: 'OK done',
    verifierNotes: [],
  });
  onEvent({ type: 'result', success: true, result: 'finished', stepsTaken: 1 });
  return {
    success: true,
    result: 'finished',
    stepsTaken: 1,
    history: [],
    doneRejections: 0,
    planRevisions: 0,
  };
};

describe('API server', () => {
  const manager = new RunManager(wiring);
  const app = buildServer(manager);
  let baseUrl: string;

  beforeAll(async () => {
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('validates run creation', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/runs', payload: {} });
    expect(bad.statusCode).toBe(400);

    const good = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { task: 'find the price', startUrl: 'https://x.test/' },
    });
    expect(good.statusCode).toBe(201);
    const body = good.json() as { id: string; status: string };
    expect(body.id).toBeTruthy();
    expect(body.status).toBe('queued');
  });

  it('lists and fetches runs, 404s unknown ids', async () => {
    const created = (
      await app.inject({ method: 'POST', url: '/api/runs', payload: { task: 't2' } })
    ).json() as { id: string };

    const list = (await app.inject({ method: 'GET', url: '/api/runs' })).json() as Array<{
      id: string;
    }>;
    expect(list.some((r) => r.id === created.id)).toBe(true);

    const one = await app.inject({ method: 'GET', url: `/api/runs/${created.id}` });
    expect(one.statusCode).toBe(200);

    const missing = await app.inject({ method: 'GET', url: '/api/runs/does-not-exist' });
    expect(missing.statusCode).toBe(404);
  });

  it('streams a full run over SSE and closes after the result', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: { task: 'streamed task' },
      })
    ).json() as { id: string };

    const response = await fetch(`${baseUrl}/api/runs/${created.id}/stream`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events: AgentEvent[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = chunk
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('');
        if (data) events.push(JSON.parse(data) as AgentEvent);
      }
    }

    expect(events.map((e) => e.type)).toEqual(['start', 'step', 'result']);
    expect(events.at(-1)).toMatchObject({ success: true, result: 'finished' });
  });

  it('404s the stream for unknown runs', async () => {
    const response = await fetch(`${baseUrl}/api/runs/unknown/stream`);
    expect(response.status).toBe(404);
  });
});
