import { describe, expect, it } from 'vitest';
import { AccuraError, ConfigError, LlmError, ensureError } from '../src/errors.js';

describe('AccuraError', () => {
  it('carries code, context and cause', () => {
    const cause = new Error('root');
    const e = new AccuraError('TEST', 'message', { cause, context: { a: 1 } });
    expect(e.code).toBe('TEST');
    expect(e.message).toBe('message');
    expect(e.context).toEqual({ a: 1 });
    expect(e.cause).toBe(cause);
    expect(e.name).toBe('AccuraError');
  });

  it('subclasses set their own code and name', () => {
    const config = new ConfigError('bad profile');
    expect(config.code).toBe('CONFIG');
    expect(config.name).toBe('ConfigError');
    expect(config).toBeInstanceOf(AccuraError);

    const llm = new LlmError('model failed');
    expect(llm.code).toBe('LLM');
    expect(llm.name).toBe('LlmError');
  });

  it('defaults context to an empty object', () => {
    expect(new ConfigError('x').context).toEqual({});
  });
});

describe('ensureError', () => {
  it('passes through Error instances', () => {
    const e = new Error('original');
    expect(ensureError(e)).toBe(e);
  });

  it('wraps strings and objects', () => {
    expect(ensureError('boom').message).toBe('boom');
    expect(ensureError({ reason: 'x' }).message).toBe('{"reason":"x"}');
  });
});
