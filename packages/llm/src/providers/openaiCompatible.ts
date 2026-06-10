import { LlmError, type ModelSpec } from '@accura/shared';
import { withRetry, type RetryOptions } from '../retry.js';
import type {
  ChatCapabilities,
  ChatMessage,
  ChatModel,
  ChatRequest,
  ChatResponse,
  StopReason,
  ToolCall,
} from '../types.js';

interface OpenAiToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export interface OpenAiCompatibleOptions {
  fetchImpl?: typeof fetch;
  retry?: RetryOptions;
}

/**
 * Provider for any OpenAI-compatible chat-completions endpoint:
 * Ollama, Groq, OpenRouter, Gemini's OpenAI endpoint, vLLM, etc.
 */
export class OpenAiCompatibleModel implements ChatModel {
  readonly id: string;
  readonly caps: ChatCapabilities;
  private readonly fetchImpl: typeof fetch;
  private readonly retry: RetryOptions | undefined;

  constructor(
    readonly spec: ModelSpec,
    options?: OpenAiCompatibleOptions,
  ) {
    this.id = spec.model;
    this.caps = {
      vision: spec.vision,
      toolUse: true,
      structured: true,
      coordinateGrounded: spec.coordinateGrounded,
    };
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.retry = options?.retry;
  }

  async generate(request: ChatRequest): Promise<ChatResponse> {
    const baseUrl = (this.spec.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const url = `${baseUrl}/chat/completions`;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.spec.apiKeyEnv) {
      const key = process.env[this.spec.apiKeyEnv];
      if (!key) {
        throw new LlmError(`Environment variable ${this.spec.apiKeyEnv} is not set`, {
          context: { model: this.id },
        });
      }
      headers.authorization = `Bearer ${key}`;
    }

    const body = this.buildBody(request);

    const data = await withRetry(async () => {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new LlmError(`Chat completion failed with status ${response.status}`, {
          context: { status: response.status, model: this.id, body: text.slice(0, 2000) },
        });
      }
      return (await response.json()) as OpenAiResponse;
    }, this.retry);

    return this.parseResponse(data);
  }

  private buildBody(request: ChatRequest): Record<string, unknown> {
    const messages: Array<Record<string, unknown>> = [];
    if (request.system) {
      messages.push({ role: 'system', content: request.system });
    }
    for (const message of request.messages) {
      messages.push({ role: message.role, content: mapContent(message) });
    }

    const body: Record<string, unknown> = {
      model: this.spec.model,
      messages,
      max_tokens: request.maxTokens ?? this.spec.maxTokens,
    };
    const temperature = request.temperature ?? this.spec.temperature;
    if (temperature !== undefined) body.temperature = temperature;

    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          ...(tool.strict ? { strict: true } : {}),
        },
      }));
      if (request.toolChoice !== undefined) {
        body.tool_choice =
          typeof request.toolChoice === 'object'
            ? { type: 'function', function: { name: request.toolChoice.name } }
            : request.toolChoice;
      }
    }
    return body;
  }

  private parseResponse(data: OpenAiResponse): ChatResponse {
    const choice = data.choices?.[0];
    if (!choice?.message) {
      throw new LlmError('Chat completion response has no choices', {
        context: { model: this.id, retryable: true },
      });
    }

    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((call, index) => {
      const rawArguments = call.function?.arguments ?? '';
      let parsed: unknown = rawArguments;
      try {
        parsed = JSON.parse(rawArguments);
      } catch {
        // leave as raw string; the structured-output layer will repair-reprompt
      }
      return {
        id: call.id ?? `call_${index}`,
        name: call.function?.name ?? '',
        arguments: parsed,
      };
    });

    return {
      text: choice.message.content ?? '',
      toolCalls,
      stopReason: mapFinishReason(choice.finish_reason, toolCalls.length > 0),
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        cacheReadInputTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
    };
  }
}

function mapContent(message: ChatMessage): string | Array<Record<string, unknown>> {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : {
          type: 'image_url',
          image_url: { url: `data:${part.mediaType};base64,${part.dataBase64}` },
        },
  );
}

function mapFinishReason(reason: string | undefined, hasToolCalls: boolean): StopReason {
  if (reason === 'tool_calls' || hasToolCalls) return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'stop') return 'end';
  if (reason === 'content_filter') return 'refusal';
  return 'other';
}
