export type ErrorContext = Record<string, unknown>;

export interface AccuraErrorOptions {
  cause?: unknown;
  context?: ErrorContext;
}

/**
 * Base error for the project. `code` is a stable machine-readable category;
 * `context` carries structured details safe to log and to surface to a model
 * as a tool error (models recover better from informative errors).
 */
export class AccuraError extends Error {
  readonly code: string;
  readonly context: ErrorContext;

  constructor(code: string, message: string, options?: AccuraErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.context = options?.context ?? {};
  }
}

export class ConfigError extends AccuraError {
  constructor(message: string, options?: AccuraErrorOptions) {
    super('CONFIG', message, options);
  }
}

export class LlmError extends AccuraError {
  constructor(message: string, options?: AccuraErrorOptions) {
    super('LLM', message, options);
  }
}

export class BrowserError extends AccuraError {
  constructor(message: string, options?: AccuraErrorOptions) {
    super('BROWSER', message, options);
  }
}

export class PerceptionError extends AccuraError {
  constructor(message: string, options?: AccuraErrorOptions) {
    super('PERCEPTION', message, options);
  }
}

export class ActionError extends AccuraError {
  constructor(message: string, options?: AccuraErrorOptions) {
    super('ACTION', message, options);
  }
}

export class VerifyError extends AccuraError {
  constructor(message: string, options?: AccuraErrorOptions) {
    super('VERIFY', message, options);
  }
}

/** Normalizes unknown thrown values (strings, objects) into Error instances. */
export function ensureError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : JSON.stringify(value));
}
