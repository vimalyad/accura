import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createLogger } from '@accura/shared';
import type { AgentEvent } from '@accura/agent';
import type { AgentMemory, RunRecord, Skill, SkillDraft } from '@accura/memory';
import { SCHEMA_SQL } from './schema.js';

const log = createLogger('store:pg');

/** Skills whose score drops below this are retired (mirrors the file store). */
const RETIRE_THRESHOLD = -3;

export interface StoredRunSummary {
  id: string;
  task: string;
  profile: string;
  status: string;
  createdAt: string;
  finishedAt?: string;
  stepsTaken?: number;
  result?: string;
  error?: string;
  userId?: string;
}

export interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
}

/**
 * Postgres-backed store: run history + event log for the API server, and
 * the AgentMemory backend (skills, run records) for multi-user deployments.
 *
 * Concurrency notes:
 *  - skill scoring is a single UPDATE (no read-modify-write race);
 *  - event appends are keyed (run_id, seq) so duplicate writes fail loudly;
 *  - screenshots are stripped before persistence — bulk stays on disk.
 */
export class PgStore implements AgentMemory {
  private constructor(private readonly pool: pg.Pool) {}

  static async connect(databaseUrl: string): Promise<PgStore> {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
    await pool.query(SCHEMA_SQL);
    log.info('postgres store ready');
    return new PgStore(pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ── server run history ───────────────────────────────────────────

  async insertRun(summary: StoredRunSummary): Promise<void> {
    await this.pool.query(
      `INSERT INTO runs (id, task, profile, status, created_at, user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        summary.id,
        summary.task,
        summary.profile,
        summary.status,
        summary.createdAt,
        summary.userId ?? null,
      ],
    );
  }

  async updateRun(summary: StoredRunSummary): Promise<void> {
    await this.pool.query(
      `UPDATE runs SET status = $2, finished_at = $3, steps_taken = $4, result = $5, error = $6
       WHERE id = $1`,
      [
        summary.id,
        summary.status,
        summary.finishedAt ?? null,
        summary.stepsTaken ?? null,
        summary.result ?? null,
        summary.error ?? null,
      ],
    );
  }

  async listRuns(limit = 200): Promise<StoredRunSummary[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM runs ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(mapRunRow);
  }

  async getRun(id: string): Promise<StoredRunSummary | undefined> {
    const { rows } = await this.pool.query(`SELECT * FROM runs WHERE id = $1`, [id]);
    return rows[0] ? mapRunRow(rows[0]) : undefined;
  }

  async appendEvent(runId: string, seq: number, event: AgentEvent): Promise<void> {
    const payload: Record<string, unknown> = { ...event };
    // The database indexes the trajectory; PNG bulk lives in trace dirs.
    delete payload.screenshotBase64;
    await this.pool.query(
      `INSERT INTO run_events (run_id, seq, type, payload) VALUES ($1, $2, $3, $4)`,
      [runId, seq, event.type, JSON.stringify(payload)],
    );
  }

  async listEvents(runId: string): Promise<AgentEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT payload FROM run_events WHERE run_id = $1 ORDER BY seq ASC`,
      [runId],
    );
    return rows.map((row: { payload: AgentEvent }) => row.payload);
  }

  // ── users & sessions (email+password auth) ───────────────────────

  /** Throws 'email already registered' on duplicates. */
  async createUser(email: string, passwordHash: string): Promise<StoredUser> {
    const user: StoredUser = { id: randomUUID(), email: email.toLowerCase(), passwordHash };
    try {
      await this.pool.query(
        `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
        [user.id, user.email, user.passwordHash],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new Error('email already registered', { cause: error });
      }
      throw error;
    }
    return user;
  }

  async getUserByEmail(email: string): Promise<StoredUser | undefined> {
    const { rows } = await this.pool.query(
      `SELECT id, email, password_hash FROM users WHERE email = $1`,
      [email.toLowerCase()],
    );
    const row = rows[0] as { id: string; email: string; password_hash: string } | undefined;
    return row ? { id: row.id, email: row.email, passwordHash: row.password_hash } : undefined;
  }

  async createSession(userId: string, ttlDays = 30): Promise<string> {
    const token = randomUUID();
    await this.pool.query(
      `INSERT INTO sessions (token, user_id, expires_at)
       VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
      [token, userId, String(ttlDays)],
    );
    return token;
  }

  async getSessionUser(token: string): Promise<{ id: string; email: string } | undefined> {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.email FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.expires_at > now()`,
      [token],
    );
    return rows[0] as { id: string; email: string } | undefined;
  }

  async deleteSession(token: string): Promise<void> {
    await this.pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
  }

  // ── AgentMemory (skills + memory runs) ───────────────────────────

  async addSkill(domain: string, draft: SkillDraft): Promise<Skill> {
    const skill: Skill = {
      ...draft,
      id: randomUUID(),
      domain,
      score: 0,
      uses: 0,
      createdAt: new Date().toISOString(),
      retired: false,
    };
    await this.pool.query(
      `INSERT INTO skills (id, domain, title, url_pattern, preconditions, steps, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        skill.id,
        skill.domain,
        skill.title,
        skill.urlPattern,
        JSON.stringify(skill.preconditions),
        JSON.stringify(skill.steps),
        skill.createdAt,
      ],
    );
    return skill;
  }

  async querySkills(url: string): Promise<Skill[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM skills
       WHERE NOT retired AND $1 LIKE '%' || url_pattern || '%'
       ORDER BY score DESC`,
      [url],
    );
    return rows.map(mapSkillRow);
  }

  /** Single-statement update: safe under concurrent writers by construction. */
  async recordSkillOutcome(id: string, ok: boolean): Promise<void> {
    const delta = ok ? 1 : -1;
    await this.pool.query(
      `UPDATE skills
       SET uses = uses + 1,
           score = score + $2,
           retired = retired OR (score + $2 < $3)
       WHERE id = $1`,
      [id, delta, RETIRE_THRESHOLD],
    );
  }

  async getSkill(id: string): Promise<Skill | undefined> {
    const { rows } = await this.pool.query(`SELECT * FROM skills WHERE id = $1`, [id]);
    return rows[0] ? mapSkillRow(rows[0]) : undefined;
  }

  async recordRun(record: RunRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO memory_runs (task, domain, success, steps, result, at, trace_dir)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        record.task,
        record.domain,
        record.success,
        record.steps,
        record.result,
        record.at,
        record.traceDir ?? null,
      ],
    );
  }

  async listMemoryRuns(domain?: string): Promise<RunRecord[]> {
    const { rows } = domain
      ? await this.pool.query(`SELECT * FROM memory_runs WHERE domain = $1 ORDER BY id`, [domain])
      : await this.pool.query(`SELECT * FROM memory_runs ORDER BY id`);
    return rows.map(
      (row: {
        task: string;
        domain: string;
        success: boolean;
        steps: number;
        result: string;
        at: Date;
        trace_dir: string | null;
      }) => ({
        task: row.task,
        domain: row.domain,
        success: row.success,
        steps: row.steps,
        result: row.result,
        at: row.at.toISOString(),
        ...(row.trace_dir ? { traceDir: row.trace_dir } : {}),
      }),
    );
  }
}

interface RunRow {
  id: string;
  task: string;
  profile: string;
  status: string;
  created_at: Date;
  finished_at: Date | null;
  steps_taken: number | null;
  result: string | null;
  error: string | null;
  user_id: string | null;
}

function mapRunRow(row: RunRow): StoredRunSummary {
  return {
    id: row.id,
    task: row.task,
    profile: row.profile,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    ...(row.finished_at ? { finishedAt: row.finished_at.toISOString() } : {}),
    ...(row.steps_taken !== null ? { stepsTaken: row.steps_taken } : {}),
    ...(row.result !== null ? { result: row.result } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.user_id !== null ? { userId: row.user_id } : {}),
  };
}

interface SkillRow {
  id: string;
  domain: string;
  title: string;
  url_pattern: string;
  preconditions: string[];
  steps: Skill['steps'];
  score: number;
  uses: number;
  retired: boolean;
  created_at: Date;
}

function mapSkillRow(row: SkillRow): Skill {
  return {
    id: row.id,
    domain: row.domain,
    title: row.title,
    urlPattern: row.url_pattern,
    preconditions: row.preconditions,
    steps: row.steps,
    score: row.score,
    uses: row.uses,
    retired: row.retired,
    createdAt: row.created_at.toISOString(),
  };
}
