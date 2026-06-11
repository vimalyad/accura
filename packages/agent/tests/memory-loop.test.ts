import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserConfigSchema, ModelSpecSchema } from '@accura/shared';
import { BrowserSession } from '@accura/browser';
import { buildCoreRegistry } from '@accura/actions';
import type { ChatModel, ChatRequest, ChatResponse } from '@accura/llm';
import { MemoryStore } from '@accura/memory';
import { Agent } from '../src/loop.js';

const config = BrowserConfigSchema.parse({ headless: true });
const spec = ModelSpecSchema.parse({ provider: 'openai-compatible', model: 'scripted' });

function dataUrl(html: string): string {
  return `data:text/html,${encodeURIComponent(html)}`;
}

const PAGE = dataUrl(`
<html><body>
  <input id="q" placeholder="Search box">
  <button onclick="document.body.insertAdjacentHTML('beforeend','<div id=r>Found it</div>')">Go search</button>
</body></html>`);

function toolResponse(name: string, args: unknown): ChatResponse {
  return {
    text: '',
    toolCalls: [{ id: 'c', name, arguments: args }],
    stopReason: 'tool_use',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
  };
}

function lastText(request: ChatRequest): string {
  const content = request.messages.at(-1)?.content;
  return typeof content === 'string'
    ? content
    : (content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

describe('skill memory in the loop (integration)', () => {
  let session: BrowserSession;
  let dir: string;

  beforeAll(async () => {
    session = await BrowserSession.launch(config);
    dir = await mkdtemp(join(tmpdir(), 'accura-memloop-'));
  });

  afterAll(async () => {
    await session.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('replays a stored skill, surfaces it in prompts, and records the run + new skill', async () => {
    const store = new MemoryStore(join(dir, 'm1'));
    const stored = await store.addSkill('datapage', {
      title: 'Run the search',
      urlPattern: 'data:text/html',
      preconditions: [],
      steps: [
        { action: 'input', targetText: 'Search box', params: { text: 'widgets' } },
        { action: 'click', targetText: 'Go search', params: {} },
      ],
    });

    const prompts: string[] = [];
    const executor: ChatModel = {
      id: 'exec',
      spec,
      caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
      async generate(request) {
        prompts.push(lastText(request));
        return toolResponse('agent_step', {
          evaluationPreviousGoal: 'success',
          memory: 'replay did the work',
          nextGoal: 'finish',
          actions: [{ name: 'done', params: { success: true, result: 'Found it' } }],
        });
      },
    };

    const inductor: ChatModel = {
      id: 'inductor',
      spec,
      caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
      async generate(request) {
        const tool = typeof request.toolChoice === 'object' ? request.toolChoice.name : '';
        return toolResponse(tool, {
          title: 'Search and confirm',
          urlPattern: 'data:text/html',
          preconditions: [],
          steps: [{ action: 'click', targetText: 'Go search', params: {} }],
        });
      },
    };

    const agent = new Agent({
      session,
      registry: buildCoreRegistry(),
      executorModel: executor,
      memoryStore: store,
      skillInductorModel: inductor,
      maxSteps: 4,
      startUrl: PAGE,
    });
    const result = await agent.run('Search for widgets and report the result');

    expect(result.success).toBe(true);
    // replay happened before the first live step and is in the history
    expect(result.history[0]?.goal).toContain('Replay known workflow');
    expect(result.history[0]?.evaluation).toBe('success');
    // the replayed actions really ran in the browser
    expect(await session.page.textContent('#r')).toBe('Found it');
    // prompts carried the known-workflows section
    expect(prompts[0]).toContain('# Known workflows for this site');
    expect(prompts[0]).toContain('Run the search');
    // replay outcome scored the stored skill
    const updated = await store.getSkill(stored.id);
    expect(updated?.score).toBe(1);
    expect(updated?.uses).toBe(1);
    // run recorded
    const runs = await store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.success).toBe(true);
  });

  it('a broken skill falls back to the live executor and is scored down', async () => {
    const store = new MemoryStore(join(dir, 'm2'));
    const broken = await store.addSkill('datapage', {
      title: 'Broken workflow',
      urlPattern: 'data:text/html',
      preconditions: [],
      steps: [{ action: 'click', targetText: 'No Such Button', params: {} }],
    });

    const executor: ChatModel = {
      id: 'exec',
      spec,
      caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
      async generate(request) {
        const text = lastText(request);
        // the failed replay is visible to the live executor
        expect(text).toContain('stopped at step 1');
        return toolResponse('agent_step', {
          evaluationPreviousGoal: 'uncertain',
          memory: 'replay failed, working live',
          nextGoal: 'finish',
          actions: [{ name: 'done', params: { success: false, result: 'could not search' } }],
        });
      },
    };

    const agent = new Agent({
      session,
      registry: buildCoreRegistry(),
      executorModel: executor,
      memoryStore: store,
      maxSteps: 3,
      startUrl: PAGE,
    });
    const result = await agent.run('Search for widgets');

    expect(result.success).toBe(false);
    const updated = await store.getSkill(broken.id);
    expect(updated?.score).toBe(-1);
  });
});
