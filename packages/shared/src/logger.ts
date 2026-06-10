import { pino, type Logger } from 'pino';

export type { Logger };

let rootLogger: Logger | undefined;

function getRootLogger(): Logger {
  if (!rootLogger) {
    rootLogger = pino({
      level: process.env.LOG_LEVEL ?? 'info',
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }
  return rootLogger;
}

/** Returns a child logger tagged with a scope (package or component name). */
export function createLogger(scope: string): Logger {
  return getRootLogger().child({ scope });
}

/** Test seam: replace the root logger (e.g. with a silent or capturing instance). */
export function setRootLogger(logger: Logger | undefined): void {
  rootLogger = logger;
}
