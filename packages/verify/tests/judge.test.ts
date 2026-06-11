import { describe, expect, it, vi } from 'vitest';
import { ModelSpecSchema } from '@accura/shared';
import type { ChatModel, ChatRequest, ChatResponse } from '@accura/llm';
import { TrajectoryJudge, type TrajectoryEvidence } from '../src/judge.js';

const spec = ModelSpecSchema.parse({ provider: 'openai-compatible', model: 'fake-judge' });

function fakeJudgeModel(argumentsByCall: unknown[]): { model: ChatModel; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let call = 0;
  const model: ChatModel = {
    id: 'fake-judge',
    spec,
    caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
    generate: vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
      requests.push(request);
      const args = argumentsByCall[Math.min(call, argumentsByCall.length - 1)];
      call += 1;
      return {
        text: '',
        toolCalls: [{ id: `c${call}`, name: request.toolChoice && typeof request.toolChoice === 'object' ? request.toolChoice.name : 'tool', arguments: args }],
        stopReason: 'tool_use',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
      };
    }),
  };
  return { model, requests };
}

const evidence: TrajectoryEvidence = {
  task: 'Buy the cheapest red shoe',
  keyPoints: ['A red shoe is in the cart', 'It is the cheapest red shoe listed'],
  stepSummaries: ['Step 1 [success] goal: open shop\nOK navigate: Navigated'],
  finalResult: 'Added Red Runner $20 to cart',
  claimedSuccess: true,
  observationExcerpts: ['Red Runner $20 — Added to cart'],
};

describe('TrajectoryJudge', () => {
  it('derives key points via structured output', async () => {
    const { model } = fakeJudgeModel([{ keyPoints: ['point a', 'point b'] }]);
    const judge = new TrajectoryJudge(model);
    expect(await judge.deriveKeyPoints('some task')).toEqual(['point a', 'point b']);
  });

  it('passes full evidence to the model and parses the verdict', async () => {
    const { model, requests } = fakeJudgeModel([
      { reasoning: 'all points satisfied', verdict: true },
    ]);
    const judge = new TrajectoryJudge(model);
    const verdict = await judge.judge(evidence);

    expect(verdict.verdict).toBe(true);
    const request = requests[0]!;
    expect(request.system).toContain('skeptical');
    expect(request.system).toContain('Automatic verdict=false');
    const text = JSON.stringify(request.messages);
    expect(text).toContain('Buy the cheapest red shoe');
    expect(text).toContain('A red shoe is in the cart');
    expect(text).toContain('Red Runner $20');
  });

  it('carries failure reasons back on rejection', async () => {
    const { model } = fakeJudgeModel([
      {
        reasoning: 'price not verified',
        verdict: false,
        failureReason: 'cheapest constraint not demonstrated',
        missingKeyPoints: ['It is the cheapest red shoe listed'],
      },
    ]);
    const judge = new TrajectoryJudge(model);
    const verdict = await judge.judge(evidence);
    expect(verdict.verdict).toBe(false);
    expect(verdict.failureReason).toContain('cheapest');
    expect(verdict.missingKeyPoints).toHaveLength(1);
  });
});
