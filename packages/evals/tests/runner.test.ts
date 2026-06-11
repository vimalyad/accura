import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserConfigSchema, ModelSpecSchema } from '@accura/shared';
import type { ChatModel, ChatRequest, ChatResponse } from '@accura/llm';
import { startFixtureServer, type FixtureServer } from '../src/fixtures.js';
import { runSuite } from '../src/runner.js';
import { EvalSuiteSchema } from '../src/types.js';
import suiteJson from '../suites/fixtures.json' with { type: 'json' };

const browserConfig = BrowserConfigSchema.parse({ headless: true });
const spec = ModelSpecSchema.parse({ provider: 'openai-compatible', model: 'oracle' });

function toolResponse(args: unknown): ChatResponse {
  return {
    text: '',
    toolCalls: [{ id: 'c', name: 'agent_step', arguments: args }],
    stopReason: 'tool_use',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
  };
}

function lastText(request: ChatRequest): string {
  const content = request.messages.at(-1)?.content;
  return typeof content === 'string'
    ? content
    : (content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

/** Oracle for the price-lookup task: reads the price from the observation. */
const priceOracle: ChatModel = {
  id: 'price-oracle',
  spec,
  caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
  async generate(request) {
    const text = lastText(request);
    const match = text.match(/Super Widget — (\$[\d.]+)/);
    return toolResponse({
      evaluationPreviousGoal: 'first-step',
      memory: '',
      nextGoal: 'report price',
      actions: [
        {
          name: 'done',
          params: match
            ? { success: true, result: `Super Widget costs ${match[1]}` }
            : { success: false, result: 'price not found' },
        },
      ],
    });
  },
};

/** Oracle that confidently reports a wrong price — ground truth must catch it. */
const wrongOracle: ChatModel = {
  ...priceOracle,
  id: 'wrong-oracle',
  async generate(request) {
    // $99.00 exists on the page (Mega Widget) so grounding passes,
    // but it is the wrong answer — only ground truth catches this.
    void lastText(request);
    return toolResponse({
      evaluationPreviousGoal: 'first-step',
      memory: '',
      nextGoal: 'report price',
      actions: [{ name: 'done', params: { success: true, result: 'It costs $99.00' } }],
    });
  },
};

describe('runSuite (integration)', () => {
  let fixtures: FixtureServer;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
  });

  afterAll(async () => {
    await fixtures.close();
  });

  it('runs tasks against the fixture server and applies ground truth', async () => {
    const suite = EvalSuiteSchema.parse({
      name: 'mini',
      tasks: suiteJson.tasks.filter((t) => t.id === 'price-lookup'),
    });

    const report = await runSuite({
      suite,
      modelsFor: () => ({ executor: priceOracle }),
      browserConfig,
      fixtureServer: fixtures,
    });

    expect(report.totalRuns).toBe(1);
    expect(report.successRate).toBe(1);
    expect(report.records[0]).toMatchObject({
      taskId: 'price-lookup',
      agentSuccess: true,
      groundTruthPass: true,
      finalScore: true,
    });
  });

  it('ground truth overrides a confident wrong answer', async () => {
    const suite = EvalSuiteSchema.parse({
      name: 'mini',
      tasks: suiteJson.tasks.filter((t) => t.id === 'price-lookup'),
    });

    const report = await runSuite({
      suite,
      modelsFor: () => ({ executor: wrongOracle }),
      browserConfig,
      fixtureServer: fixtures,
    });

    expect(report.records[0]).toMatchObject({
      agentSuccess: true,
      groundTruthPass: false,
      finalScore: false,
    });
    expect(report.successRate).toBe(0);
  });

  it('filters by tags and survives task crashes', async () => {
    const suite = EvalSuiteSchema.parse({
      name: 'tagged',
      tasks: [
        {
          id: 'live-task',
          instruction: 'never runs',
          tags: ['live'],
        },
        {
          id: 'broken-url',
          instruction: 'crash on navigation',
          startUrl: 'fixture:/does-not-need-server',
          tags: ['smoke'],
        },
      ],
    });

    const report = await runSuite({
      suite,
      modelsFor: () => ({ executor: priceOracle }),
      browserConfig,
      excludeTags: ['live'],
      // no fixtureServer passed: fixture: URL must produce a recorded error
    });

    expect(report.totalRuns).toBe(1);
    expect(report.records[0]?.taskId).toBe('broken-url');
    expect(report.records[0]?.finalScore).toBe(false);
    expect(report.records[0]?.error).toContain('no fixture server');
  });
});
