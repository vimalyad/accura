import { resolveModelSpec, type ModelRole, type ModelSpec, type Profile } from '@accura/shared';
import { createChatModel } from './factory.js';
import type { ChatModel } from './types.js';

/**
 * Resolves agent roles (planner, executor, judge, ...) to ChatModel
 * instances based on the active profile. Roles without an explicit spec
 * fall back to the executor model. Instances are cached per unique spec
 * so two roles sharing a model share a client.
 */
export class ModelRouter {
  private readonly cache = new Map<string, ChatModel>();

  constructor(
    private readonly profile: Profile,
    private readonly factory: (spec: ModelSpec) => ChatModel = createChatModel,
  ) {}

  modelFor(role: ModelRole): ChatModel {
    const spec = resolveModelSpec(this.profile, role);
    const key = JSON.stringify(spec);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const model = this.factory(spec);
    this.cache.set(key, model);
    return model;
  }
}
