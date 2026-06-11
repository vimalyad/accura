import { describe, expect, it, vi } from 'vitest';
import { ModelSpecSchema } from '@accura/shared';
import type { ChatModel, ChatRequest, ChatResponse } from '@accura/llm';
import { applyCompletions, Planner, renderPlan, type Plan } from '../src/planner.js';

const spec = ModelSpecSchema.parse({ provider: 'openai-compatible', model: 'fake' });

function fakeModel(argsByTool: Record<string, unknown>): ChatModel {
  return {
    id: 'fake',
    spec,
    caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
    generate: vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
      const tool = typeof request.toolChoice === 'object' ? request.toolChoice.name : 'unknown';
      return {
        text: '',
        toolCalls: [{ id: 'c', name: tool, arguments: argsByTool[tool] }],
        stopReason: 'tool_use',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
      };
    }),
  };
}

describe('Planner', () => {
  it('creates a plan with the first item active', async () => {
    const planner = new Planner(
      fakeModel({ submit_plan: { items: ['open the site', 'fill the form', 'verify result'] } }),
    );
    const plan = await planner.createPlan('task', 'page summary');
    expect(plan.revision).toBe(1);
    expect(plan.items.map((i) => i.status)).toEqual(['active', 'pending', 'pending']);
  });

  it('replans with statuses and bumps the revision', async () => {
    const planner = new Planner(
      fakeModel({
        submit_revised_plan: {
          rationale: 'login wall found',
          items: [
            { text: 'open the site', status: 'done' },
            { text: 'dismiss the login wall', status: 'active' },
            { text: 'fill the form', status: 'pending' },
          ],
        },
      }),
    );
    const original: Plan = {
      items: [
        { text: 'open the site', status: 'done' },
        { text: 'fill the form', status: 'active' },
      ],
      revision: 1,
    };
    const revised = await planner.replan('task', original, 'history', 'stuck');
    expect(revised.revision).toBe(2);
    expect(revised.items[1]?.text).toContain('login wall');
  });
});

describe('renderPlan / applyCompletions', () => {
  const plan: Plan = {
    items: [
      { text: 'one', status: 'done' },
      { text: 'two', status: 'active' },
      { text: 'three', status: 'pending' },
      { text: 'four', status: 'skipped' },
    ],
    revision: 3,
  };

  it('renders checklist markers', () => {
    expect(renderPlan(plan)).toBe('[x] 1. one\n[>] 2. two\n[ ] 3. three\n[-] 4. four');
  });

  it('marks completions and advances the active item', () => {
    const updated = applyCompletions(plan, [1]);
    expect(updated.items[1]?.status).toBe('done');
    expect(updated.items[2]?.status).toBe('active');
    // skipped items stay skipped
    const skippedTouch = applyCompletions(plan, [3]);
    expect(skippedTouch.items[3]?.status).toBe('skipped');
  });
});
