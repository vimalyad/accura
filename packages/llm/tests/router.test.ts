import { describe, expect, it, vi } from 'vitest';
import { parseProfile, unwrap, type ModelSpec } from '@accura/shared';
import { ModelRouter } from '../src/router.js';
import type { ChatModel } from '../src/types.js';

const profile = unwrap(
  parseProfile({
    name: 'test',
    roles: {
      executor: { provider: 'openai-compatible', model: 'exec-model' },
      judge: { provider: 'openai-compatible', model: 'judge-model' },
    },
  }),
);

function fakeFactory() {
  return vi.fn(
    (spec: ModelSpec): ChatModel => ({
      id: spec.model,
      spec,
      caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
      generate: vi.fn(),
    }),
  );
}

describe('ModelRouter', () => {
  it('resolves explicit roles to their own model', () => {
    const factory = fakeFactory();
    const router = new ModelRouter(profile, factory);
    expect(router.modelFor('judge').id).toBe('judge-model');
    expect(router.modelFor('executor').id).toBe('exec-model');
  });

  it('falls back to the executor for unset roles and shares the instance', () => {
    const factory = fakeFactory();
    const router = new ModelRouter(profile, factory);
    const planner = router.modelFor('planner');
    const executor = router.modelFor('executor');
    expect(planner).toBe(executor);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('caches instances per spec', () => {
    const factory = fakeFactory();
    const router = new ModelRouter(profile, factory);
    router.modelFor('judge');
    router.modelFor('judge');
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
