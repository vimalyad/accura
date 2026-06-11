import { describe, expect, it } from 'vitest';
import { RecoveryPolicy } from '../src/recovery.js';

describe('RecoveryPolicy', () => {
  it('forbids an identical action after two failures', () => {
    const policy = new RecoveryPolicy();
    policy.noteResult('click', { id: 5 }, false);
    expect(policy.isForbidden('click', { id: 5 })).toBe(false);
    policy.noteResult('click', { id: 5 }, false);
    expect(policy.isForbidden('click', { id: 5 })).toBe(true);
    // different params are unaffected
    expect(policy.isForbidden('click', { id: 6 })).toBe(false);
    expect(policy.advice().join(' ')).toContain('FORBIDDEN');
  });

  it('clears the failure count on success', () => {
    const policy = new RecoveryPolicy();
    policy.noteResult('click', { id: 5 }, false);
    policy.noteResult('click', { id: 5 }, true);
    policy.noteResult('click', { id: 5 }, false);
    expect(policy.isForbidden('click', { id: 5 })).toBe(false);
  });

  it('detects being stuck on a URL with no successful actions', () => {
    const policy = new RecoveryPolicy();
    policy.noteStep('https://a.test/', false);
    policy.noteStep('https://a.test/', false);
    expect(policy.isStuck()).toBe(false);
    policy.noteStep('https://a.test/', false);
    expect(policy.isStuck()).toBe(true);
    expect(policy.advice().join(' ')).toContain('STUCK');
  });

  it('does not flag progress or navigation as stuck', () => {
    const policy = new RecoveryPolicy();
    policy.noteStep('https://a.test/', false);
    policy.noteStep('https://a.test/', true);
    policy.noteStep('https://a.test/', false);
    expect(policy.isStuck()).toBe(false);

    const moving = new RecoveryPolicy();
    moving.noteStep('https://a.test/1', false);
    moving.noteStep('https://a.test/2', false);
    moving.noteStep('https://a.test/3', false);
    expect(moving.isStuck()).toBe(false);
  });
});
