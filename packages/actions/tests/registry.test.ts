import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ActionRegistry, defineAction } from '../src/registry.js';

const noop = defineAction({
  name: 'noop',
  description: 'does nothing',
  params: z.object({ value: z.string() }),
  async run() {
    return { ok: true, message: 'noop' };
  },
});

const other = defineAction({
  name: 'other',
  description: 'something else',
  params: z.object({ count: z.number().int() }),
  async run() {
    return { ok: true, message: 'other' };
  },
});

describe('ActionRegistry', () => {
  it('rejects duplicate registrations', () => {
    const registry = new ActionRegistry().register(noop);
    expect(() => registry.register(noop)).toThrow('already registered');
  });

  it('builds a discriminated union schema that validates per-action params', () => {
    const registry = new ActionRegistry().register(noop).register(other);
    const schema = registry.invocationSchema();

    expect(schema.safeParse({ name: 'noop', params: { value: 'x' } }).success).toBe(true);
    expect(schema.safeParse({ name: 'other', params: { count: 3 } }).success).toBe(true);
    expect(schema.safeParse({ name: 'noop', params: { count: 3 } }).success).toBe(false);
    expect(schema.safeParse({ name: 'unknown', params: {} }).success).toBe(false);
  });

  it('describes the catalog with optionality markers', () => {
    const withOptional = defineAction({
      name: 'opt',
      description: 'has optional param',
      params: z.object({ a: z.string(), b: z.number().default(1) }),
      async run() {
        return { ok: true, message: '' };
      },
    });
    const registry = new ActionRegistry().register(withOptional);
    expect(registry.describeCatalog()).toBe('- opt(a, b?): has optional param');
  });

  it('throws when building a schema from an empty registry', () => {
    expect(() => new ActionRegistry().invocationSchema()).toThrow('empty registry');
  });
});
