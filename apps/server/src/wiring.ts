import { resolve } from 'node:path';
import { loadProfile, unwrap } from '@accura/shared';
import { ModelRouter } from '@accura/llm';
import { BrowserSession } from '@accura/browser';
import { buildCoreRegistry } from '@accura/actions';
import { Agent } from '@accura/agent';
import { MemoryStore, type AgentMemory } from '@accura/memory';
import type { RunRequest, RunWiring } from './runManager.js';

export interface WiringOptions {
  configsDir: string;
  dataDir: string;
  /** Shared memory backend (Postgres in multi-user mode); falls back to files. */
  memory?: AgentMemory;
}

/**
 * Production wiring: one fresh browser session per run, full stack
 * (judge, planner, skill memory, traces) resolved from the requested profile.
 */
export function defaultWiring(options: WiringOptions): RunWiring {
  return async (request: RunRequest, onEvent) => {
    const profilePath = resolve(options.configsDir, `${request.profile ?? 'dev'}.json`);
    const profile = unwrap(await loadProfile(profilePath));
    const router = new ModelRouter(profile);
    const executorModel = router.modelFor('executor');

    const session = await BrowserSession.launch(profile.browser);
    try {
      const agent = new Agent({
        session,
        registry: buildCoreRegistry({
          coordinateActions: executorModel.caps.coordinateGrounded,
        }),
        executorModel,
        extractorModel: router.modelFor('extractor'),
        judgeModel: router.modelFor('judge'),
        plannerModel: router.modelFor('planner'),
        skillInductorModel: router.modelFor('skill-inductor'),
        memoryStore: options.memory ?? new MemoryStore(resolve(options.dataDir, 'memory')),
        traceDir: resolve(options.dataDir, 'traces'),
        maxSteps: request.maxSteps ?? profile.maxSteps,
        ...(request.startUrl ? { startUrl: request.startUrl } : {}),
        onEvent,
      });
      return await agent.run(request.task);
    } finally {
      await session.close();
    }
  };
}
