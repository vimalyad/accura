import Anthropic from '@anthropic-ai/sdk';
import { LlmError, type ModelSpec } from '@accura/shared';
import type {
  ChatCapabilities,
  ChatMessage,
  ChatModel,
  ChatRequest,
  ChatResponse,
  StopReason,
  ToolCall,
} from '../types.js';

export interface AnthropicOptions {
  /** Test seam / shared-client injection. */
  client?: Anthropic;
}

export class AnthropicModel implements ChatModel {
  readonly id: string;
  readonly caps: ChatCapabilities;
  private readonly client: Anthropic;

  constructor(
    readonly spec: ModelSpec,
    options?: AnthropicOptions,
  ) {
    this.id = spec.model;
    this.caps = {
      vision: spec.vision,
      toolUse: true,
      structured: true,
      coordinateGrounded: spec.coordinateGrounded,
    };
    if (options?.client) {
      this.client = options.client;
    } else {
      const keyEnv = spec.apiKeyEnv ?? 'ANTHROPIC_API_KEY';
      const apiKey = process.env[keyEnv];
      if (!apiKey) {
        throw new LlmError(`Environment variable ${keyEnv} is not set`, {
          context: { model: spec.model },
        });
      }
      this.client = new Anthropic({
        apiKey,
        maxRetries: 3,
        ...(spec.baseUrl ? { baseURL: spec.baseUrl } : {}),
      });
    }
  }

  async generate(request: ChatRequest): Promise<ChatResponse> {
    const params = this.buildParams(request);
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(params);
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        throw new LlmError(`Anthropic request failed: ${error.message}`, {
          cause: error,
          context: { status: error.status, model: this.id },
        });
      }
      throw error;
    }
    return mapResponse(response);
  }

  private buildParams(request: ChatRequest): Anthropic.MessageCreateParamsNonStreaming {
    const forcedToolChoice =
      typeof request.toolChoice === 'object' || request.toolChoice === 'required';

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.spec.model,
      max_tokens: request.maxTokens ?? this.spec.maxTokens,
      messages: request.messages.map(mapMessage),
    };

    if (request.system) {
      params.system = [
        {
          type: 'text',
          text: request.system,
          ...(request.cacheSystemPrompt === false
            ? {}
            : { cache_control: { type: 'ephemeral' as const } }),
        },
      ];
    }

    if (request.tools?.length) {
      params.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
        ...(tool.strict ? { strict: true } : {}),
      }));
      if (request.toolChoice !== undefined) {
        params.tool_choice =
          typeof request.toolChoice === 'object'
            ? { type: 'tool', name: request.toolChoice.name }
            : request.toolChoice === 'required'
              ? { type: 'any' }
              : { type: request.toolChoice };
      }
    }

    // Forced tool choice is incompatible with thinking — omit thinking there.
    if (this.spec.thinking === 'adaptive' && !forcedToolChoice) {
      params.thinking = { type: 'adaptive' };
    }
    if (this.spec.effort) {
      params.output_config = { effort: this.spec.effort };
    }
    // Sampling params are rejected on Opus 4.7+ and alongside thinking;
    // only forward an explicitly configured temperature when thinking is off.
    const temperature = request.temperature ?? this.spec.temperature;
    if (temperature !== undefined && this.spec.thinking !== 'adaptive') {
      params.temperature = temperature;
    }
    return params;
  }
}

function mapMessage(message: ChatMessage): Anthropic.MessageParam {
  if (typeof message.content === 'string') {
    return { role: message.role, content: message.content };
  }
  const content: Anthropic.ContentBlockParam[] = message.content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : {
          type: 'image',
          source: { type: 'base64', media_type: part.mediaType, data: part.dataBase64 },
        },
  );
  return { role: message.role, content };
}

function mapResponse(response: Anthropic.Message): ChatResponse {
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const block of response.content) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
    }
  }
  return {
    text,
    toolCalls,
    stopReason: mapStopReason(response.stop_reason),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
    },
  };
}

function mapStopReason(reason: Anthropic.Message['stop_reason']): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}
