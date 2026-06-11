import { resolve } from 'node:path';
import { createLogger } from '@accura/shared';
import { RunManager } from './runManager.js';
import { buildServer } from './server.js';
import { defaultWiring } from './wiring.js';

const log = createLogger('server:main');

const port = Number(process.env.PORT ?? 7700);
const host = process.env.HOST ?? '127.0.0.1';
const concurrency = Number(process.env.ACCURA_CONCURRENCY ?? 2);

const manager = new RunManager(
  defaultWiring({
    configsDir: resolve('configs'),
    dataDir: resolve('.accura'),
  }),
  concurrency,
);

const app = buildServer(manager);

app
  .listen({ port, host })
  .then((address) => log.info({ address }, 'accura server listening'))
  .catch((error: unknown) => {
    log.error({ error }, 'failed to start server');
    process.exit(1);
  });
