import { describe, expect, it, vi } from 'vitest';
import { ModelSpecSchema } from '@accura/shared';
import type { ChatModel, ChatRequest, ChatResponse } from '@accura/llm';
import { clusterFailures } from '../src/clustering.js';
import type { TaskRunRecord } from '../src/types.js';

const spec = ModelSpecSchema.parse({ provider: 'openai-compatible', model: 'fake' });

function record(taskId: string, finalScore: boolean, error?: string): TaskRunRecord {
  return {
    taskId,
    seed: 0,
    agentSuccess: finalScore,
    finalScore,
    steps: 1,
    result: 'r',
    durationMs: 1,
    ...(error ? { error } : {}),
  };
}

describe('clusterFailures', () => {
  it('returns empty clusters without calling the model when nothing failed', async () => {
    const generate = vi.fn();
    const model: ChatModel = {
      id: 'fake',
      spec,
      caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
      generate,
    };
    const clusters = await clusterFailures(model, [record('a', true)]);
    expect(clusters.clusters).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });

  it('sends failures to the model and parses clusters', async () => {
    const generate = vi.fn(
      async (_request: ChatRequest): Promise<ChatResponse> => ({
        text: '',
        toolCalls: [
          {
            id: 'c',
            name: 'submit_clusters',
            arguments: {
              clusters: [
                {
                  label: 'element not found after dropdown',
                  count: 2,
                  exampleTaskIds: ['a', 'b'],
                  suggestedFix: 'wait for new elements before clicking',
                },
              ],
            },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
      }),
    );
    const model: ChatModel = {
      id: 'fake',
      spec,
      caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
      generate,
    };

    const clusters = await clusterFailures(model, [
      record('a', false, 'Element 5 not found'),
      record('b', false, 'Element 9 not found'),
    ]);

    expect(clusters.clusters[0]?.label).toContain('dropdown');
    const request = generate.mock.calls[0]![0];
    expect(JSON.stringify(request.messages)).toContain('Element 5 not found');
  });
});
