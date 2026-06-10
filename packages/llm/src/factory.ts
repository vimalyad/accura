import type { ModelSpec } from '@accura/shared';
import { AnthropicModel } from './providers/anthropic.js';
import { OpenAiCompatibleModel } from './providers/openaiCompatible.js';
import type { ChatModel } from './types.js';

export function createChatModel(spec: ModelSpec): ChatModel {
  switch (spec.provider) {
    case 'anthropic':
      return new AnthropicModel(spec);
    case 'openai-compatible':
      return new OpenAiCompatibleModel(spec);
  }
}
