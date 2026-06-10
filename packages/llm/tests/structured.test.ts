import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { LlmError, ModelSpecSchema } from '@accura/shared';
import { extractJson, generateStructured } from '../src/structured.js';
import type { ChatModel, ChatResponse } from '../src/types.js';

const schema = z.object({ name: z.string(), count: z.number() });

const spec = ModelSpecSchema.parse({ provider: 'openai-compatible', model: 'fake' });

function fakeModel(responses: Array<Partial<ChatResponse>>, toolUse = true): ChatModel {
  const generate = vi.fn();
  for (const r of responses) {
    generate.mockResolvedValueOnce({
      text: '',
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
      ...r,
    });
  }
  return {
    id: 'fake',
    spec,
    caps: { vision: false, toolUse, structured: true, coordinateGrounded: false },
    generate,
  };
}

describe('generateStructured via forced tool', () => {
  it('returns validated data from a tool call', async () => {
    const model = fakeModel([
      {
        toolCalls: [{ id: '1', name: 'submit_result', arguments: { name: 'a', count: 2 } }],
        stopReason: 'tool_use',
      },
    ]);
    const result = await generateStructured(
      model,
      { messages: [{ role: 'user', content: 'go' }] },
      schema,
    );
    expect(result).toEqual({ name: 'a', count: 2 });
  });

  it('repairs after an invalid tool call', async () => {
    const model = fakeModel([
      {
        toolCalls: [{ id: '1', name: 'submit_result', arguments: { name: 'a', count: 'two' } }],
        stopReason: 'tool_use',
      },
      {
        toolCalls: [{ id: '2', name: 'submit_result', arguments: { name: 'a', count: 2 } }],
        stopReason: 'tool_use',
      },
    ]);
    const result = await generateStructured(
      model,
      { messages: [{ role: 'user', content: 'go' }] },
      schema,
    );
    expect(result).toEqual({ name: 'a', count: 2 });
    expect(model.generate).toHaveBeenCalledTimes(2);
    // The repair turn must carry the validation failure back to the model.
    const repairCall = (model.generate as ReturnType<typeof vi.fn>).mock.calls[1]![0];
    const lastMessage = repairCall.messages.at(-1);
    expect(lastMessage.role).toBe('user');
    expect(lastMessage.content).toContain('failed validation');
  });

  it('throws LlmError after exhausting repairs', async () => {
    const bad = {
      toolCalls: [{ id: '1', name: 'submit_result', arguments: { wrong: true } }],
      stopReason: 'tool_use' as const,
    };
    const model = fakeModel([bad, bad, bad]);
    await expect(
      generateStructured(model, { messages: [{ role: 'user', content: 'go' }] }, schema),
    ).rejects.toBeInstanceOf(LlmError);
  });
});

describe('generateStructured via JSON text (no tool support)', () => {
  it('parses fenced JSON from text output', async () => {
    const model = fakeModel(
      [{ text: 'Sure!\n```json\n{"name":"b","count":7}\n```' }],
      false,
    );
    const result = await generateStructured(
      model,
      { messages: [{ role: 'user', content: 'go' }] },
      schema,
    );
    expect(result).toEqual({ name: 'b', count: 7 });
  });
});

describe('extractJson', () => {
  it('finds JSON inside prose and fences', () => {
    expect(extractJson('prefix {"a":1} suffix').value).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```').value).toEqual({ a: 1 });
  });

  it('reports missing or broken JSON', () => {
    expect(extractJson('no json here').parseError).toContain('No JSON object');
    expect(extractJson('{"broken": ').parseError).toContain('No JSON object');
    expect(extractJson('{"broken": }').parseError).toContain('JSON parse error');
  });
});

