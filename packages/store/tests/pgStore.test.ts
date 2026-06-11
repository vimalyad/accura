import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/pgStore.js';

/**
 * Integration tests against a real Postgres (dockerized locally, service
 * container in CI). Skipped when DATABASE_URL is not set so the suite
 * stays green on machines without docker.
 */
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('PgStore (postgres integration)', () => {
  let store: PgStore;

  beforeAll(async () => {
    store = await PgStore.connect(databaseUrl!);
  });

  afterAll(async () => {
    await store.close();
  });

  it('migrates idempotently', async () => {
    // connecting twice applies the schema twice without error
    const again = await PgStore.connect(databaseUrl!);
    await again.close();
  });

  it('round-trips run summaries', async () => {
    const id = randomUUID();
    await store.insertRun({
      id,
      task: 'find the price',
      profile: 'dev',
      status: 'queued',
      createdAt: new Date().toISOString(),
    });
    await store.updateRun({
      id,
      task: 'find the price',
      profile: 'dev',
      status: 'succeeded',
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      stepsTaken: 4,
      result: '$20.00',
    });

    const fetched = await store.getRun(id);
    expect(fetched).toMatchObject({ id, status: 'succeeded', stepsTaken: 4, result: '$20.00' });
    const listed = await store.listRuns(10);
    expect(listed.some((run) => run.id === id)).toBe(true);
  });

  it('appends events in order and strips screenshots', async () => {
    const id = randomUUID();
    await store.insertRun({
      id,
      task: 't',
      profile: 'dev',
      status: 'running',
      createdAt: new Date().toISOString(),
    });
    await store.appendEvent(id, 0, { type: 'start', task: 't', maxSteps: 5 });
    await store.appendEvent(id, 1, {
      type: 'step',
      step: 1,
      maxSteps: 5,
      url: 'https://x.test/',
      goal: 'g',
      evaluation: 'success',
      memory: '',
      actionsSummary: 'OK',
      verifierNotes: [],
      screenshotBase64: 'HUGE_PNG_DATA',
    });

    const events = await store.listEvents(id);
    expect(events.map((e) => e.type)).toEqual(['start', 'step']);
    expect(events[1]).not.toHaveProperty('screenshotBase64');
    expect(events[1]).toMatchObject({ goal: 'g' });

    // duplicate seq must fail loudly, not overwrite history
    await expect(
      store.appendEvent(id, 1, { type: 'start', task: 'dup', maxSteps: 1 }),
    ).rejects.toThrow();
  });

  it('cascades event deletion with the run', async () => {
    const id = randomUUID();
    await store.insertRun({
      id,
      task: 't',
      profile: 'dev',
      status: 'running',
      createdAt: new Date().toISOString(),
    });
    await store.appendEvent(id, 0, { type: 'start', task: 't', maxSteps: 1 });
    // direct SQL delete to validate the FK cascade
    await (store as unknown as { pool: { query(q: string, p: unknown[]): Promise<unknown> } }).pool
      .query('DELETE FROM runs WHERE id = $1', [id]);
    expect(await store.listEvents(id)).toEqual([]);
  });

  it('implements AgentMemory: skills with scoring and retirement', async () => {
    const marker = randomUUID().slice(0, 8);
    const skill = await store.addSkill('shop.example', {
      title: `Search ${marker}`,
      urlPattern: `shop-${marker}.example`,
      preconditions: ['page open'],
      steps: [{ action: 'input', targetText: 'Search', params: { text: '{q}' } }],
    });

    const matches = await store.querySkills(`https://shop-${marker}.example/home`);
    expect(matches.map((s) => s.id)).toContain(skill.id);
    expect(await store.querySkills('https://unrelated.example/')).not.toContainEqual(
      expect.objectContaining({ id: skill.id }),
    );

    await store.recordSkillOutcome(skill.id, true);
    expect((await store.getSkill(skill.id))?.score).toBe(1);

    for (let i = 0; i < 5; i += 1) await store.recordSkillOutcome(skill.id, false);
    const retired = await store.getSkill(skill.id);
    expect(retired?.score).toBe(-4);
    expect(retired?.retired).toBe(true);
    expect(await store.querySkills(`https://shop-${marker}.example/home`)).toEqual([]);
  });

  it('survives concurrent skill scoring without losing updates', async () => {
    const marker = randomUUID().slice(0, 8);
    const skill = await store.addSkill('busy.example', {
      title: `Busy ${marker}`,
      urlPattern: `busy-${marker}.example`,
      preconditions: [],
      steps: [{ action: 'wait', params: { seconds: 1 } }],
    });

    // 30 concurrent writers; single-statement updates must not lose any.
    await Promise.all(
      Array.from({ length: 30 }, () => store.recordSkillOutcome(skill.id, true)),
    );
    const after = await store.getSkill(skill.id);
    expect(after?.score).toBe(30);
    expect(after?.uses).toBe(30);
  });

  it('orders matching skills by score', async () => {
    const marker = randomUUID().slice(0, 8);
    const weak = await store.addSkill('rank.example', {
      title: 'weak',
      urlPattern: `rank-${marker}.example`,
      preconditions: [],
      steps: [{ action: 'wait', params: {} }],
    });
    const strong = await store.addSkill('rank.example', {
      title: 'strong',
      urlPattern: `rank-${marker}.example`,
      preconditions: [],
      steps: [{ action: 'wait', params: {} }],
    });
    await store.recordSkillOutcome(strong.id, true);
    await store.recordSkillOutcome(weak.id, false);

    const ranked = await store.querySkills(`https://rank-${marker}.example/`);
    expect(ranked.map((s) => s.title)).toEqual(['strong', 'weak']);
  });

  it('records and lists memory runs', async () => {
    const domain = `dom-${randomUUID().slice(0, 8)}.example`;
    await store.recordRun({
      task: 'remember me',
      domain,
      success: true,
      steps: 3,
      result: 'ok',
      at: new Date().toISOString(),
      traceDir: '/tmp/trace-1',
    });
    const runs = await store.listMemoryRuns(domain);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ task: 'remember me', success: true, traceDir: '/tmp/trace-1' });
  });
});

describe.skipIf(Boolean(databaseUrl))('PgStore (no database available)', () => {
  it('is skipped because DATABASE_URL is not set', () => {
    expect(databaseUrl).toBeUndefined();
  });
});
