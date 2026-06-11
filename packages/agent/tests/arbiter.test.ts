import { describe, expect, it, vi } from 'vitest';
import { ModelSpecSchema } from '@accura/shared';
import type { ChatModel, ChatRequest, ChatResponse } from '@accura/llm';
import { dedupCandidates, StepArbiter, type StepCandidate } from '../src/arbiter.js';

const spec = ModelSpecSchema.parse({ provider: 'openai-compatible', model: 'fake' });

function candidate(goal: string, actions: StepCandidate['actions']): StepCandidate {
  return { evaluationPreviousGoal: 'uncertain', memory: '', nextGoal: goal, actions };
}

describe('dedupCandidates', () => {
  it('collapses candidates with identical action sequences', () => {
    const a = candidate('click the button', [{ name: 'click', params: { id: 5 } }]);
    const b = candidate('press the button', [{ name: 'click', params: { id: 5 } }]);
    const c = candidate('scroll instead', [{ name: 'scroll', params: { direction: 'down' } }]);
    expect(dedupCandidates([a, b, c])).toHaveLength(2);
  });
});

describe('StepArbiter', () => {
  function arbiterModel(chosenIndex: number): { model: ChatModel; generate: ReturnType<typeof vi.fn> } {
    const generate = vi.fn(async (_request: ChatRequest): Promise<ChatResponse> => ({
      text: '',
      toolCalls: [
        { id: 'c', name: 'submit_choice', arguments: { rationale: 'r', chosenIndex } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
    }));
    return {
      model: {
        id: 'arbiter',
        spec,
        caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
        generate,
      },
      generate,
    };
  }

  it('returns the single candidate without calling the model', async () => {
    const { model, generate } = arbiterModel(0);
    const arbiter = new StepArbiter(model);
    const only = candidate('a', [{ name: 'wait', params: { seconds: 1 } }]);
    const chosen = await arbiter.chooseBest([only, only], 'context');
    expect(chosen).toBe(only);
    expect(generate).not.toHaveBeenCalled();
  });

  it('asks the model to choose among distinct candidates', async () => {
    const { model, generate } = arbiterModel(1);
    const arbiter = new StepArbiter(model);
    const a = candidate('a', [{ name: 'click', params: { id: 1 } }]);
    const b = candidate('b', [{ name: 'scroll', params: { direction: 'down' } }]);
    const chosen = await arbiter.chooseBest([a, b], 'context');
    expect(chosen).toBe(b);
    const request = generate.mock.calls[0]![0] as ChatRequest;
    expect(JSON.stringify(request.messages)).toContain('Candidate 0');
    expect(JSON.stringify(request.messages)).toContain('Candidate 1');
  });

  it('clamps an out-of-range chosen index', async () => {
    const { model } = arbiterModel(99);
    const arbiter = new StepArbiter(model);
    const a = candidate('a', [{ name: 'click', params: { id: 1 } }]);
    const b = candidate('b', [{ name: 'scroll', params: { direction: 'down' } }]);
    const chosen = await arbiter.chooseBest([a, b], 'context');
    expect(chosen).toBe(b);
  });
});
