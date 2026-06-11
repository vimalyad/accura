import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainOf, MemoryStore } from '../src/store.js';
import type { SkillDraft } from '../src/types.js';

const draft: SkillDraft = {
  title: 'Search the catalog',
  urlPattern: 'shop.example',
  preconditions: [],
  steps: [{ action: 'input', targetText: 'Search', params: { text: '{query}' } }],
};

describe('MemoryStore', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'accura-memory-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('records and lists runs filtered by domain', async () => {
    const store = new MemoryStore(join(dir, 'a'));
    await store.recordRun({
      task: 't1',
      domain: 'shop.example',
      success: true,
      steps: 3,
      result: 'ok',
      at: new Date().toISOString(),
    });
    await store.recordRun({
      task: 't2',
      domain: 'other.example',
      success: false,
      steps: 5,
      result: 'no',
      at: new Date().toISOString(),
    });
    expect(await store.listRuns()).toHaveLength(2);
    expect(await store.listRuns('shop.example')).toHaveLength(1);
  });

  it('persists skills across instances and queries by url substring', async () => {
    const path = join(dir, 'b');
    const store = new MemoryStore(path);
    await store.addSkill('shop.example', draft);

    const reopened = new MemoryStore(path);
    const matches = await reopened.querySkills('https://shop.example/search?q=x');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.title).toBe('Search the catalog');
    expect(await reopened.querySkills('https://unrelated.example/')).toHaveLength(0);
  });

  it('scores outcomes and retires skills below -3', async () => {
    const store = new MemoryStore(join(dir, 'c'));
    const skill = await store.addSkill('shop.example', draft);

    await store.recordSkillOutcome(skill.id, true); // +1
    for (let i = 0; i < 5; i += 1) {
      await store.recordSkillOutcome(skill.id, false); // -1 each -> -4
    }
    const after = await store.getSkill(skill.id);
    expect(after?.score).toBe(-4);
    expect(after?.retired).toBe(true);
    expect(await store.querySkills('https://shop.example/')).toHaveLength(0);
  });

  it('orders matching skills by score', async () => {
    const store = new MemoryStore(join(dir, 'd'));
    const weak = await store.addSkill('shop.example', { ...draft, title: 'weak' });
    const strong = await store.addSkill('shop.example', { ...draft, title: 'strong' });
    await store.recordSkillOutcome(strong.id, true);
    await store.recordSkillOutcome(weak.id, false);

    const matches = await store.querySkills('https://shop.example/');
    expect(matches.map((s) => s.title)).toEqual(['strong', 'weak']);
  });
});

describe('domainOf', () => {
  it('extracts hostnames and tolerates junk', () => {
    expect(domainOf('https://shop.example/x?y=1')).toBe('shop.example');
    expect(domainOf('not a url')).toBe('unknown');
  });
});
