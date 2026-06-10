import { describe, expect, it } from 'vitest';
import { andThen, err, isErr, isOk, map, mapErr, ok, unwrap, unwrapOr } from '../src/result.js';

describe('Result', () => {
  it('ok wraps a value', () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    expect(r.value).toBe(42);
  });

  it('err wraps an error', () => {
    const r = err(new Error('boom'));
    expect(r.ok).toBe(false);
    expect(isErr(r)).toBe(true);
    expect(r.error.message).toBe('boom');
  });

  it('map transforms only success values', () => {
    expect(map(ok(2), (n) => n * 2)).toEqual(ok(4));
    const failure = err('nope');
    expect(map(failure, (n: number) => n * 2)).toBe(failure);
  });

  it('andThen chains results and short-circuits on failure', () => {
    const half = (n: number) => (n % 2 === 0 ? ok(n / 2) : err('odd'));
    expect(andThen(ok(4), half)).toEqual(ok(2));
    expect(andThen(ok(3), half)).toEqual(err('odd'));
    expect(andThen(err('early'), half)).toEqual(err('early'));
  });

  it('mapErr transforms only errors', () => {
    expect(mapErr(err('e'), (e) => `wrapped:${e}`)).toEqual(err('wrapped:e'));
    expect(mapErr(ok(1), () => 'unused')).toEqual(ok(1));
  });

  it('unwrapOr returns fallback on failure', () => {
    expect(unwrapOr(ok(1), 9)).toBe(1);
    expect(unwrapOr(err('x'), 9)).toBe(9);
  });

  it('unwrap throws the contained error', () => {
    expect(unwrap(ok('fine'))).toBe('fine');
    expect(() => unwrap(err(new Error('boom')))).toThrow('boom');
    expect(() => unwrap(err('plain string'))).toThrow('plain string');
  });
});
