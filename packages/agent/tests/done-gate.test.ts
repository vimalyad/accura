import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserConfigSchema, ModelSpecSchema } from '@accura/shared';
import { BrowserSession } from '@accura/browser';
import { buildCoreRegistry } from '@accura/actions';
import type { ChatModel, ChatRequest, ChatResponse } from '@accura/llm';
import { Agent } from '../src/loop.js';

const config = BrowserConfigSchema.parse({ headless: true });
const spec = ModelSpecSchema.parse({ provider: 'openai-compatible', model: 'scripted' });

function dataUrl(html: string): string {
  return `data:text/html,${encodeURIComponent(html)}`;
}

const PAGE = dataUrl('<html><body><h1>Product page</h1><p>Price today: $20.00</p></body></html>');

function toolResponse(name: string, args: unknown): ChatResponse {
  return {
    text: '',
    toolCalls: [{ id: 'c', name, arguments: args }],
    stopReason: 'tool_use',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
  };
}

/** Executor that always declares done(success=true) with a given result. */
function doneExecutor(result: string): ChatModel {
  return {
    id: 'done-executor',
    spec,
    caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
    async generate(): Promise<ChatResponse> {
      return toolResponse('agent_step', {
        evaluationPreviousGoal: 'success',
        memory: 'm',
        nextGoal: 'finish',
        actions: [{ name: 'done', params: { success: true, result } }],
      });
    },
  };
}

/** Judge whose verdicts are scripted; also serves key-point derivation. */
function scriptedJudge(verdicts: boolean[]): ChatModel & { judgeCalls: number } {
  let judgeCalls = 0;
  const model = {
    id: 'scripted-judge',
    spec,
    caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
    judgeCalls: 0,
    async generate(request: ChatRequest): Promise<ChatResponse> {
      const tool = typeof request.toolChoice === 'object' ? request.toolChoice.name : '';
      if (tool === 'submit_key_points') {
        return toolResponse(tool, { keyPoints: ['the price is reported'] });
      }
      const verdict = verdicts[Math.min(judgeCalls, verdicts.length - 1)]!;
      judgeCalls += 1;
      model.judgeCalls = judgeCalls;
      return toolResponse(tool, {
        reasoning: 'scripted',
        verdict,
        ...(verdict ? {} : { failureReason: 'not convinced yet' }),
      });
    },
  };
  return model;
}

describe('done gate (integration)', () => {
  let session: BrowserSession;

  beforeAll(async () => {
    session = await BrowserSession.launch(config);
  });

  afterAll(async () => {
    await session.close();
  });

  it('rejects fabricated values via grounding and returns an honest failure', async () => {
    const agent = new Agent({
      session,
      registry: buildCoreRegistry(),
      executorModel: doneExecutor('The price is $99.99'),
      maxSteps: 5,
      maxDoneRejections: 2,
      startUrl: PAGE,
    });
    const result = await agent.run('Find the price');

    expect(result.success).toBe(false);
    expect(result.doneRejections).toBe(2);
    expect(result.result).toContain('$99.99');
    expect(result.result).toContain('could not be verified');
  });

  it('accepts grounded values that pass the grounding check', async () => {
    const agent = new Agent({
      session,
      registry: buildCoreRegistry(),
      executorModel: doneExecutor('The price is $20.00'),
      maxSteps: 5,
      startUrl: PAGE,
    });
    const result = await agent.run('Find the price');
    expect(result.success).toBe(true);
    expect(result.doneRejections).toBe(0);
  });

  it('judge rejection sends the agent back; acceptance finishes the run', async () => {
    const judge = scriptedJudge([false, true]);
    const agent = new Agent({
      session,
      registry: buildCoreRegistry(),
      executorModel: doneExecutor('The price is $20.00'),
      judgeModel: judge,
      maxSteps: 6,
      maxDoneRejections: 3,
      startUrl: PAGE,
    });
    const result = await agent.run('Find the price');

    expect(result.success).toBe(true);
    expect(result.doneRejections).toBe(1);
    expect(judge.judgeCalls).toBe(2);
    expect(result.stepsTaken).toBe(2);
  });

  it('persistent judge rejection ends in an honest failure', async () => {
    const judge = scriptedJudge([false]);
    const agent = new Agent({
      session,
      registry: buildCoreRegistry(),
      executorModel: doneExecutor('The price is $20.00'),
      judgeModel: judge,
      maxSteps: 6,
      maxDoneRejections: 2,
      startUrl: PAGE,
    });
    const result = await agent.run('Find the price');

    expect(result.success).toBe(false);
    expect(result.result).toContain('not convinced yet');
    expect(result.doneRejections).toBe(2);
  });
});
