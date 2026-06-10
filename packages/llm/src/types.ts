import type { ModelSpec } from '@accura/shared';

export interface ChatCapabilities {
  vision: boolean;
  toolUse: boolean;
  structured: boolean;
  coordinateGrounded: boolean;
}

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  dataBase64: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ChatMessage {
  role: 'user' | 'assistant';
  /**
   * When mixing text and images, place instruction text BEFORE images —
   * this measurably improves grounding accuracy on Anthropic models.
   * Providers preserve the given order.
   */
  content: string | ContentPart[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema object for the tool's parameters. */
  inputSchema: Record<string, unknown>;
  /** Request strict schema enforcement where the provider supports it. */
  strict?: boolean;
}

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface ChatRequest {
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  maxTokens?: number;
  temperature?: number;
  /** Cache the system prompt where supported (Anthropic cache_control). Default true. */
  cacheSystemPrompt?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments object; falls back to the raw string if unparseable. */
  arguments: unknown;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: ChatUsage;
}

export interface ChatModel {
  readonly id: string;
  readonly spec: ModelSpec;
  readonly caps: ChatCapabilities;
  generate(request: ChatRequest): Promise<ChatResponse>;
}
