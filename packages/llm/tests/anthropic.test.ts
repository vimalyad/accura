import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { ModelSpecSchema } from '@accura/shared';
import { AnthropicModel } from '../src/providers/anthropic.js';

const spec = ModelSpecSchema.parse({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  vision: true,
  thinking: 'adaptive',
  effort: 'high',
});

const okMessage = {
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
};

function fakeClient(result: unknown = okMessage) {
  const create = vi.fn().mockResolvedValue(result);
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

describe('AnthropicModel', () => {
  it('sends cached system prompt, adaptive thinking and effort', async () => {
    const { client, create } = fakeClient();
    const model = new AnthropicModel(spec, { client });

    await model.generate({
      system: 'be careful',
      messages: [{ role: 'user', content: 'hi' }],
    });

    const params = create.mock.calls[0]![0];
    expect(params.model).toBe('claude-sonnet-4-6');
    expect(params.system).toEqual([
      { type: 'text', text: 'be careful', cache_control: { type: 'ephemeral' } },
    ]);
    expect(params.thinking).toEqual({ type: 'adaptive' });
    expect(params.output_config).toEqual({ effort: 'high' });
    expect('temperature' in params).toBe(false);
  });

  it('omits thinking when a tool choice is forced', async () => {
    const { client, create } = fakeClient({
      ...okMessage,
      content: [{ type: 'tool_use', id: 't1', name: 'submit', input: { a: 1 } }],
      stop_reason: 'tool_use',
    });
    const model = new AnthropicModel(spec, { client });

    const response = await model.generate({
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'submit', description: 'submit', inputSchema: { type: 'object' } }],
      toolChoice: { name: 'submit' },
    });

    const params = create.mock.calls[0]![0];
    expect('thinking' in params).toBe(false);
    expect(params.tool_choice).toEqual({ type: 'tool', name: 'submit' });
    expect(params.tools[0].input_schema).toEqual({ type: 'object' });
    expect(response.stopReason).toBe('tool_use');
    expect(response.toolCalls).toEqual([{ id: 't1', name: 'submit', arguments: { a: 1 } }]);
  });

  it('maps image parts to base64 source blocks preserving order', async () => {
    const { client, create } = fakeClient();
    const model = new AnthropicModel(spec, { client });

    await model.generate({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'instruction first' },
            { type: 'image', mediaType: 'image/png', dataBase64: 'QUJD' },
          ],
        },
      ],
    });

    const params = create.mock.calls[0]![0];
    expect(params.messages[0].content).toEqual([
      { type: 'text', text: 'instruction first' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ]);
  });

  it('maps usage including cache reads', async () => {
    const { client } = fakeClient();
    const model = new AnthropicModel(spec, { client });
    const response = await model.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 3,
    });
  });

  it('forwards temperature only when thinking is off', async () => {
    const plainSpec = ModelSpecSchema.parse({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      temperature: 0.5,
    });
    const { client, create } = fakeClient();
    const model = new AnthropicModel(plainSpec, { client });
    await model.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(create.mock.calls[0]![0].temperature).toBe(0.5);
  });
});

