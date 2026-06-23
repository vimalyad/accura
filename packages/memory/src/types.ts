import { z } from 'zod';

export const SkillStepSchema = z.object({
  action: z.string().describe('Action name from the agent action set'),
  /**
   * Visible text / placeholder / aria-label identifying the target element.
   * Replay re-grounds against the LIVE page by this text — never by stale
   * element ids, which do not survive across sessions.
   */
  targetText: z.string().optional(),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type SkillStep = z.infer<typeof SkillStepSchema>;

export const SkillDraftSchema = z.object({
  title: z.string().describe('Short imperative title, e.g. "Search flights on example.com"'),
  /** Substring of URLs where this skill applies. */
  urlPattern: z.string(),
  preconditions: z.array(z.string()).default([]),
  steps: z.array(SkillStepSchema).min(1).max(15),
});
export type SkillDraft = z.infer<typeof SkillDraftSchema>;

export interface Skill extends SkillDraft {
  id: string;
  domain: string;
  /** successes - failures; retired when it drops below the threshold. */
  score: number;
  uses: number;
  createdAt: string;
  retired: boolean;
}

export interface RunRecord {
  task: string;
  domain: string;
  success: boolean;
  steps: number;
  result: string;
  at: string;
  traceDir?: string;
}

/**
 * What the Agent needs from a memory backend. Implemented by the file-based
 * MemoryStore (single-user, local).
 */
export interface AgentMemory {
  querySkills(url: string): Promise<Skill[]>;
  addSkill(domain: string, draft: SkillDraft): Promise<Skill>;
  recordSkillOutcome(id: string, ok: boolean): Promise<void>;
  recordRun(record: RunRecord): Promise<void>;
}
