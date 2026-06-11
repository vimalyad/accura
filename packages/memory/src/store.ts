import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@accura/shared';
import type { AgentMemory, RunRecord, Skill, SkillDraft } from './types.js';

const log = createLogger('memory:store');

/** Skills whose score drops below this are retired (browser-use's -3 rule). */
const RETIRE_THRESHOLD = -3;

/**
 * Directory-backed memory: runs.jsonl (trajectory index, feeds evals and
 * induction) and skills.json (per-domain verified workflows). Deliberately
 * plain files — inspectable, diffable, no database to operate.
 */
export class MemoryStore implements AgentMemory {
  private skills: Skill[] = [];
  private loaded = false;

  constructor(private readonly dir: string) {}

  private skillsFile(): string {
    return join(this.dir, 'skills.json');
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = await readFile(this.skillsFile(), 'utf8');
      this.skills = JSON.parse(raw) as Skill[];
    } catch {
      this.skills = [];
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await writeFile(this.skillsFile(), JSON.stringify(this.skills, null, 2), 'utf8');
  }

  async recordRun(record: RunRecord): Promise<void> {
    await this.load();
    await appendFile(join(this.dir, 'runs.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
  }

  async listRuns(domain?: string): Promise<RunRecord[]> {
    await this.load();
    try {
      const raw = await readFile(join(this.dir, 'runs.jsonl'), 'utf8');
      const runs = raw
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RunRecord);
      return domain ? runs.filter((run) => run.domain === domain) : runs;
    } catch {
      return [];
    }
  }

  async addSkill(domain: string, draft: SkillDraft): Promise<Skill> {
    await this.load();
    const skill: Skill = {
      ...draft,
      id: randomUUID(),
      domain,
      score: 0,
      uses: 0,
      createdAt: new Date().toISOString(),
      retired: false,
    };
    this.skills.push(skill);
    await this.persist();
    log.info({ domain, title: skill.title }, 'skill added');
    return skill;
  }

  /** Active skills applicable to a URL, best-scored first. */
  async querySkills(url: string): Promise<Skill[]> {
    await this.load();
    return this.skills
      .filter((skill) => !skill.retired && url.includes(skill.urlPattern))
      .sort((a, b) => b.score - a.score);
  }

  async recordSkillOutcome(id: string, ok: boolean): Promise<void> {
    await this.load();
    const skill = this.skills.find((s) => s.id === id);
    if (!skill) return;
    skill.uses += 1;
    skill.score += ok ? 1 : -1;
    if (skill.score < RETIRE_THRESHOLD) {
      skill.retired = true;
      log.info({ title: skill.title, score: skill.score }, 'skill retired');
    }
    await this.persist();
  }

  async getSkill(id: string): Promise<Skill | undefined> {
    await this.load();
    return this.skills.find((s) => s.id === id);
  }
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}
