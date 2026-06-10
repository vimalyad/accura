import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/errors.js';
import { loadProfile, parseProfile, resolveModelSpec } from '../src/config.js';

const minimalProfile = {
  name: 'test',
  roles: {
    executor: { provider: 'openai-compatible', model: 'qwen2.5-vl' },
  },
};

describe('parseProfile', () => {
  it('accepts a minimal profile and applies defaults', () => {
    const result = parseProfile(minimalProfile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const profile = result.value;
    expect(profile.roles.executor.maxTokens).toBe(4096);
    expect(profile.roles.executor.temperature).toBeUndefined();
    expect(profile.roles.executor.vision).toBe(false);
    expect(profile.browser.headless).toBe(true);
    expect(profile.browser.viewportWidth).toBe(1280);
    expect(profile.maxSteps).toBe(40);
  });

  it('rejects a profile without an executor role', () => {
    const result = parseProfile({ name: 'broken', roles: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigError);
    expect(result.error.message).toContain('executor');
  });

  it('rejects unknown providers', () => {
    const result = parseProfile({
      name: 'broken',
      roles: { executor: { provider: 'mystery', model: 'x' } },
    });
    expect(result.ok).toBe(false);
  });
});

describe('resolveModelSpec', () => {
  it('falls back to the executor model for unset roles', () => {
    const result = parseProfile({
      ...minimalProfile,
      roles: {
        ...minimalProfile.roles,
        judge: { provider: 'anthropic', model: 'claude-opus-4-8' },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(resolveModelSpec(result.value, 'judge').model).toBe('claude-opus-4-8');
    expect(resolveModelSpec(result.value, 'planner').model).toBe('qwen2.5-vl');
  });
});

describe('loadProfile', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'accura-config-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads a valid profile from disk', async () => {
    const file = join(dir, 'profile.json');
    await writeFile(file, JSON.stringify(minimalProfile), 'utf8');
    const result = await loadProfile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('test');
  });

  it('reports missing files as ConfigError', async () => {
    const result = await loadProfile(join(dir, 'does-not-exist.json'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFIG');
  });

  it('reports invalid JSON as ConfigError', async () => {
    const file = join(dir, 'broken.json');
    await writeFile(file, '{ not json', 'utf8');
    const result = await loadProfile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('not valid JSON');
  });
});
