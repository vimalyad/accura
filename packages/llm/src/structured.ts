import { z } from 'zod';
import { LlmError } from '@accura/shared';
import type { ChatMessage, ChatModel, ChatRequest } from './types.js';

export interface StructuredOptions {
  /** Repair reprompts after the first failed attempt. Default 2. */
  maxRepairAttempts?: number;
  toolName?: string;
  toolDescription?: string;
}

const DEFAULT_TOOL_NAME = 'submit_result';

/**
 * Forces a model to produce output matching a Zod schema.
 *
 * Tool-capable models are forced to call a synthetic tool whose parameters
 * are the schema; others get a JSON-only instruction. Validation failures
 * trigger a repair reprompt carrying the validation errors. The agent never
 * consumes unvalidated model output — this is the only path to typed data.
 */
export async function generateStructured<T>(
  model: ChatModel,
  request: ChatRequest,
  schema: z.ZodType<T>,
  options?: StructuredOptions,
): Promise<T> {
  const maxRepairAttempts = options?.maxRepairAttempts ?? 2;
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;

  const messages: ChatMessage[] = [...request.messages];
  let lastError = '';

  for (let attempt = 0; attempt <= maxRepairAttempts; attempt += 1) {
    const candidate = model.caps.toolUse
      ? await viaForcedTool(model, request, messages, jsonSchema, options)
      : await viaJsonText(model, request, messages, jsonSchema);

    const parsed = schema.safeParse(candidate.value);
    if (parsed.success) return parsed.data;

    lastError = candidate.parseError ?? z.prettifyError(parsed.error);
    messages.push({
      role: 'user',
      content:
        `Your previous output failed validation:\n${lastError}\n` +
        `Previous output was: ${truncate(JSON.stringify(candidate.value) ?? '(no output)', 2000)}\n` +
        `Respond again with corrected output that satisfies the schema exactly.`,
    });
  }

  throw new LlmError(`Structured output failed validation after ${maxRepairAttempts} repairs`, {
    context: { model: model.id, lastError },
  });
}

interface Candidate {
  value: unknown;
  parseError?: string;
}

async function viaForcedTool(
  model: ChatModel,
  request: ChatRequest,
  messages: ChatMessage[],
  jsonSchema: Record<string, unknown>,
  options?: StructuredOptions,
): Promise<Candidate> {
  const toolName = options?.toolName ?? DEFAULT_TOOL_NAME;
  const response = await model.generate({
    ...request,
    messages,
    tools: [
      {
        name: toolName,
        description:
          options?.toolDescription ?? 'Submit the final result in the required structure.',
        inputSchema: jsonSchema,
        // No strict: true. Anthropic strict mode requires additionalProperties:false
        // on every object and forbids optional fields — neither of which Zod v4's
        // z.toJSONSchema emits, and the agent's schemas rely on optional fields.
        // Correctness is enforced by Zod validation + the repair reprompt above.
      },
    ],
    toolChoice: { name: toolName },
  });
  const call = response.toolCalls.find((c) => c.name === toolName) ?? response.toolCalls[0];
  if (!call) {
    return { value: undefined, parseError: 'No tool call was produced.' };
  }
  if (typeof call.arguments === 'string') {
    return extractJson(call.arguments);
  }
  return { value: call.arguments };
}

async function viaJsonText(
  model: ChatModel,
  request: ChatRequest,
  messages: ChatMessage[],
  jsonSchema: Record<string, unknown>,
): Promise<Candidate> {
  const instruction =
    `Respond ONLY with a single JSON object matching this JSON Schema — ` +
    `no prose, no markdown fences:\n${JSON.stringify(jsonSchema)}`;
  const response = await model.generate({
    ...request,
    system: request.system ? `${request.system}\n\n${instruction}` : instruction,
    messages,
  });
  return extractJson(response.text);
}

/** Pulls the first JSON object out of model text, tolerating code fences and prose. */
export function extractJson(text: string): Candidate {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return { value: undefined, parseError: 'No JSON object found in output.' };
  }
  const slice = cleaned.slice(start, end + 1);
  try {
    return { value: JSON.parse(slice) };
  } catch (error) {
    return {
      value: slice,
      parseError: `JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
