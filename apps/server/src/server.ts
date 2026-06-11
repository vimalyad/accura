import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { RunManager } from './runManager.js';

export interface ServerOptions {
  /** Directory with the built web console (apps/web/dist); served at /. */
  staticDir?: string;
}

const CreateRunSchema = z.object({
  task: z.string().min(1),
  startUrl: z.string().optional(),
  profile: z.string().optional(),
  maxSteps: z.number().int().positive().max(100).optional(),
});

export function buildServer(manager: RunManager, options?: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

  if (options?.staticDir) {
    void app.register(fastifyStatic, { root: options.staticDir });
  }

  // Permissive CORS so the vite dev server can talk to us during development.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-headers', 'content-type');
    reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
  });
  app.options('/*', async (_request, reply) => reply.code(204).send());

  app.get('/health', async () => ({ ok: true }));

  app.post('/api/runs', async (request, reply) => {
    const parsed = CreateRunSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    }
    const summary = manager.create(parsed.data);
    return reply.code(201).send(summary);
  });

  app.get('/api/runs', async () => manager.list());

  app.get('/api/runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const summary = manager.get(id);
    if (!summary) return reply.code(404).send({ error: 'run not found' });
    return summary;
  });

  /**
   * SSE stream: replays the run's buffered events, then goes live.
   * Closes after the terminal 'result' event.
   */
  app.get('/api/runs/:id/stream', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!manager.get(id)) {
      return reply.code(404).send({ error: 'run not found' });
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    reply.raw.write(': connected\n\n');

    // self-referential: the listener needs the unsubscribe handle
    const handle: { unsubscribe?: () => void } = {};
    handle.unsubscribe = await manager.subscribe(id, (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'result') {
        handle.unsubscribe?.();
        reply.raw.end();
      }
    });
    const unsubscribe = handle.unsubscribe;

    request.raw.on('close', () => unsubscribe?.());
  });

  return app;
}
