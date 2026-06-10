import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ConfigError } from './errors.js';
import { err, ok, type Result } from './result.js';

export const MODEL_ROLES = ['planner', 'executor', 'judge', 'extractor', 'skill-inductor'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export const ModelSpecSchema = z.object({
  provider: z.enum(['anthropic', 'openai-compatible']),
  model: z.string().min(1),
  /** Required for openai-compatible providers (Ollama, Groq, OpenRouter, ...). */
  baseUrl: z.url().optional(),
  /** Name of the environment variable holding the API key. Never the key itself. */
  apiKeyEnv: z.string().min(1).optional(),
  maxTokens: z.number().int().positive().default(4096),
  /**
   * Omit for models that reject sampling params (Anthropic Opus 4.7+,
   * or any Anthropic model running with adaptive thinking).
   */
  temperature: z.number().min(0).max(2).optional(),
  /** Anthropic adaptive thinking. Ignored by openai-compatible providers. */
  thinking: z.enum(['adaptive']).optional(),
  /** Anthropic effort level. Ignored by openai-compatible providers. */
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  vision: z.boolean().default(false),
  coordinateGrounded: z.boolean().default(false),
});
export type ModelSpec = z.infer<typeof ModelSpecSchema>;

export const BrowserConfigSchema = z.object({
  headless: z.boolean().default(true),
  viewportWidth: z.number().int().positive().default(1280),
  viewportHeight: z.number().int().positive().default(800),
  navigationTimeoutMs: z.number().int().positive().default(30_000),
});
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  headless: true,
  viewportWidth: 1280,
  viewportHeight: 800,
  navigationTimeoutMs: 30_000,
};

export const ProfileSchema = z.object({
  name: z.string().min(1),
  /** Executor is mandatory; other roles fall back to the executor model. */
  roles: z.object({
    executor: ModelSpecSchema,
    planner: ModelSpecSchema.optional(),
    judge: ModelSpecSchema.optional(),
    extractor: ModelSpecSchema.optional(),
    'skill-inductor': ModelSpecSchema.optional(),
  }),
  browser: BrowserConfigSchema.default(DEFAULT_BROWSER_CONFIG),
  maxSteps: z.number().int().positive().default(40),
});
export type Profile = z.infer<typeof ProfileSchema>;

export function parseProfile(data: unknown): Result<Profile, ConfigError> {
  const parsed = ProfileSchema.safeParse(data);
  if (!parsed.success) {
    return err(
      new ConfigError(`Invalid profile: ${z.prettifyError(parsed.error)}`, {
        context: { issues: parsed.error.issues },
      }),
    );
  }
  return ok(parsed.data);
}

export async function loadProfile(filePath: string): Promise<Result<Profile, ConfigError>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (cause) {
    return err(new ConfigError(`Cannot read profile file: ${filePath}`, { cause }));
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (cause) {
    return err(new ConfigError(`Profile file is not valid JSON: ${filePath}`, { cause }));
  }
  return parseProfile(data);
}

/** Resolves the model for a role, falling back to the executor model. */
export function resolveModelSpec(profile: Profile, role: ModelRole): ModelSpec {
  return profile.roles[role] ?? profile.roles.executor;
}
