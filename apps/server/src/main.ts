import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from '@accura/shared';
import { PgStore } from '@accura/store';
import { RunManager } from './runManager.js';
import { buildServer } from './server.js';
import { defaultWiring } from './wiring.js';

const log = createLogger('server:main');

const port = Number(process.env.PORT ?? 7700);
const host = process.env.HOST ?? '127.0.0.1';
const concurrency = Number(process.env.ACCURA_CONCURRENCY ?? 2);
const databaseUrl = process.env.DATABASE_URL;

// Multi-user mode: Postgres persists run history and shares skill memory
// across all server instances. Without DATABASE_URL: file-based, single-user.
const store = databaseUrl ? await PgStore.connect(databaseUrl) : undefined;
if (store) {
  log.info('multi-user mode: postgres persistence active');
} else {
  log.info('single-user mode: file-based persistence (.accura/)');
}

const manager = new RunManager(
  defaultWiring({
    configsDir: resolve('configs'),
    dataDir: resolve('.accura'),
    ...(store ? { memory: store } : {}),
  }),
  concurrency,
  store,
);
await manager.hydrate();

// Auth rides on multi-user mode; ACCURA_AUTH=disabled opts out explicitly.
const authEnabled = Boolean(store) && process.env.ACCURA_AUTH !== 'disabled';
if (store && !authEnabled) log.warn('auth explicitly disabled (ACCURA_AUTH=disabled)');

const webDist = resolve('apps', 'web', 'dist');
const app = buildServer(manager, {
  ...(existsSync(webDist) ? { staticDir: webDist } : {}),
  ...(authEnabled && store ? { authStore: store } : {}),
});

try {
  const address = await app.listen({ port, host });
  log.info({ address }, 'accura server listening');
} catch (error) {
  log.error({ error }, 'failed to start server');
  process.exit(1);
}
