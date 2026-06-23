import { describe, expect, it, vi } from 'vitest';
import { LlmError, ModelSpecSchema } from '@accura/shared';
import { OpenAiCompatibleModel } from '../src/providers/openaiCompatible.js';

const spec = ModelSpecSchema.parse({
  provider: 'openai-compatible',
  model: 'test-model',
  baseUrl: 'https://api.example.test/v1',
  temperature: 0,
  vision: true,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const okBody = {
  choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

describe('OpenAiCompatibleModel', () => {
  it('maps system, messages and sampling params into the request body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(okBody));
    const model = new OpenAiCompatibleModel(spec, { fetchImpl });

    await model.generate({
      system: 'be helpful',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 123,
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.test/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('test-model');
    expect(body.max_tokens).toBe(123);
    expect(body.temperature).toBe(0);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be helpful' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('maps image parts to data-url image_url blocks', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(okBody));
    const model = new OpenAiCompatibleModel(spec, { fetchImpl });

    await model.generate({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', mediaType: 'image/png', dataBase64: 'QUJD' },
          ],
        },
      ],
    });

    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ]);
  });

  it('maps tools, forced tool choice and parses tool call arguments', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 'c1', function: { name: 'click', arguments: '{"index":5}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    );
    const model = new OpenAiCompatibleModel(spec, { fetchImpl });

    const response = await model.generate({
      messages: [{ role: 'user', content: 'click it' }],
      tools: [{ name: 'click', description: 'click an element', inputSchema: { type: 'object' } }],
      toolChoice: { name: 'click' },
    });

    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.tools[0].function.name).toBe('click');
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'click' } });
    expect(response.stopReason).toBe('tool_use');
    expect(response.toolCalls).toEqual([{ id: 'c1', name: 'click', arguments: { index: 5 } }]);
  });

  it('retries retryable statuses and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'rate limited' }, 429))
      .mockResolvedValueOnce(jsonResponse(okBody));
    const model = new OpenAiCompatibleModel(spec, {
      fetchImpl,
      retry: { retries: 2, baseDelayMs: 1 },
    });

    const response = await model.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.text).toBe('hello');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable statuses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'bad' }, 400));
    const model = new OpenAiCompatibleModel(spec, {
      fetchImpl,
      retry: { retries: 3, baseDelayMs: 1 },
    });

    await expect(
      model.generate({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toBeInstanceOf(LlmError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('omits temperature when not configured', async () => {
    const noTempSpec = ModelSpecSchema.parse({
      provider: 'openai-compatible',
      model: 'test-model',
      baseUrl: 'https://api.example.test/v1',
    });
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(okBody));
    const model = new OpenAiCompatibleModel(noTempSpec, { fetchImpl });
    await model.generate({ messages: [{ role: 'user', content: 'hi' }] });
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect('temperature' in body).toBe(false);
  });
});
