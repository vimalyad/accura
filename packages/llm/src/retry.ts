import { AccuraError } from '@accura/shared';

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, error: unknown) => void;
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

export function isRetryable(error: unknown): boolean {
  if (error instanceof AccuraError) {
    const status = error.context.status;
    if (typeof status === 'number') return RETRYABLE_STATUSES.has(status);
    return error.context.retryable === true;
  }
  // fetch network failures surface as TypeError in Node
  return error instanceof TypeError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries `fn` on retryable errors with exponential backoff and jitter. */
export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const retries = options?.retries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const maxDelayMs = options?.maxDelayMs ?? 30_000;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt > retries || !isRetryable(error)) throw error;
      options?.onRetry?.(attempt, error);
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await delay(backoff * (0.5 + Math.random() * 0.5));
    }
  }
}
