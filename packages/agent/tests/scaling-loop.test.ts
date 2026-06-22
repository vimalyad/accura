import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BrowserConfigSchema, ModelSpecSchema } from '@accura/shared';
import { BrowserSession } from '@accura/browser';
import { buildCoreRegistry, defineAction } from '@accura/actions';
import type { ChatModel, ChatRequest, ChatResponse } from '@accura/llm';
import { Agent } from '../src/loop.js';

const config = BrowserConfigSchema.parse({ headless: true });
const spec = ModelSpecSchema.parse({ provider: 'openai-compatible', model: 'scripted' });

function dataUrl(html: string): string {
  return `data:text/html,${encodeURIComponent(html)}`;
}

const PAGE = dataUrl('<html><body><h1>Checkout</h1><p>Total: $20.00</p></body></html>');

function toolResponse(name: string, args: unknown): ChatResponse {
  return {
    text: '',
    toolCalls: [{ id: 'c', name, arguments: args }],
    stopReason: 'tool_use',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
  };
}

function toolNameOf(request: ChatRequest): string {
  return typeof request.toolChoice === 'object' ? request.toolChoice.name : '';
}

function lastText(request: ChatRequest): string {
  const content = request.messages.at(-1)?.content;
  return typeof content === 'string'
    ? content
    : (content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

describe('planner + simulation in the loop (integration)', () => {
  let session: BrowserSession;

  beforeAll(async () => {
    session = await BrowserSession.launch(config);
  });

  afterAll(async () => {
    await session.close();
  });

  it('threads the plan through prompts and applies completions', async () => {
    const prompts: string[] = [];
    let step = 0;
    const executor: ChatModel = {
      id: 'exec',
      spec,
      caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
      async generate(request) {
        prompts.push(lastText(request));
        step += 1;
        if (step === 1) {
          return toolResponse('agent_step', {
            evaluationPreviousGoal: 'first-step',
            memory: '',
            nextGoal: 'read the total',
            actions: [{ name: 'wait', params: { seconds: 0.5 } }],
            completedPlanItems: [0],
          });
        }
        return toolResponse('agent_step', {
          evaluationPreviousGoal: 'success',
          memory: 'total seen',
          nextGoal: 'finish',
          actions: [{ name: 'done', params: { success: true, result: 'Total: $20.00' } }],
          completedPlanItems: [1],
        });
      },
    };

    const plannerModel: ChatModel = {
      id: 'planner',
      spec,
      caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
      async generate(request) {
        return toolResponse(toolNameOf(request), {
          items: ['open the checkout page', 'report the total'],
        });
      },
    };

    const agent = new Agent({
      session,
      registry: buildCoreRegistry(),
      executorModel: executor,
      plannerModel,
      maxSteps: 5,
      startUrl: PAGE,
    });
    const result = await agent.run('Report the checkout total');

    expect(result.success).toBe(true);
    expect(result.planRevisions).toBe(1);
    // step 1 prompt: fresh plan, first item active
    expect(prompts[0]).toContain('# Plan (revision 1)');
    expect(prompts[0]).toContain('[>] 1. open the checkout page');
    // step 2 prompt: completion applied, second item now active
    expect(prompts[1]).toContain('[x] 1. open the checkout page');
    expect(prompts[1]).toContain('[>] 2. report the total');
  });

  it('samples best-of-N at flagged decisions and lets the arbiter choose', async () => {
    let executorCalls = 0;
    const executor: ChatModel = {
      id: 'exec',
      spec,
      caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
      async generate() {
        executorCalls += 1;
        if (executorCalls === 1) {
          // step 1: uncertain evaluation flags the NEXT step for best-of-N
          return toolResponse('agent_step', {
            evaluationPreviousGoal: 'uncertain',
            memory: '',
            nextGoal: 'poke around',
            actions: [{ name: 'wait', params: { seconds: 0.5 } }],
          });
        }
        // candidates for step 2: distinct per call so dedup keeps them all
        return toolResponse('agent_step', {
          evaluationPreviousGoal: 'uncertain',
          memory: '',
          nextGoal: `candidate-${executorCalls}`,
          actions:
            executorCalls % 2 === 0
              ? [{ name: 'done', params: { success: true, result: 'Total: $20.00' } }]
              : [{ name: 'scroll', params: { direction: 'down', pages: 1 } }],
        });
      },
    };

    let arbiterCalls = 0;
    const arbiterModel: ChatModel = {
      id: 'arbiter',
      spec,
      caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
      async generate(request) {
        arbiterCalls += 1;
        const text = JSON.stringify(request.messages);
        // pick the done candidate
        const match = text.match(/Candidate (\d+):\\n {2}goal: candidate-\d+\\n {2}actions: done/);
        const index = match ? Number(match[1]) : 0;
        return toolResponse(toolNameOf(request), { rationale: 'finish now', chosenIndex: index });
      },
    };

    const agent = new Agent({
      session,
      registry: buildCoreRegistry(),
      executorModel: executor,
      arbiterModel,
      arbiterN: 3,
      maxSteps: 4,
      startUrl: PAGE,
    });
    const result = await agent.run('Report the checkout total');

    expect(result.success).toBe(true);
    // 1 (step1) + 3 (candidates for flagged step 2) = 4
    expect(executorCalls).toBe(4);
    expect(arbiterCalls).toBe(1);
  });

  it('blocks irreversible actions when the simulation says no', async () => {
    const registry = buildCoreRegistry();
    let purchases = 0;
    registry.register(
      defineAction({
        name: 'purchase',
        description: 'Place the order (irreversible)',
        params: z.object({}),
        irreversible: true,
        async run() {
          purchases += 1;
          return { ok: true, message: 'order placed' };
        },
      }),
    );

    let executorCalls = 0;
    const executor: ChatModel = {
      id: 'exec',
      spec,
      caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
      async generate(request) {
        executorCalls += 1;
        const text = lastText(request);
        if (executorCalls === 1) {
          return toolResponse('agent_step', {
            evaluationPreviousGoal: 'first-step',
            memory: '',
            nextGoal: 'buy the wrong thing',
            actions: [{ name: 'purchase', params: {} }],
          });
        }
        // After the block, report honestly referencing the blocker.
        expect(text).toContain('BLOCKED by outcome simulation');
        return toolResponse('agent_step', {
          evaluationPreviousGoal: 'failure',
          memory: 'purchase was blocked',
          nextGoal: 'stop',
          actions: [
            { name: 'done', params: { success: false, result: 'purchase blocked by simulation' } },
          ],
        });
      },
    };

    const simulatorModel: ChatModel = {
      id: 'sim',
      spec,
      caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
      async generate(request) {
        return toolResponse(toolNameOf(request), {
          predictedOutcome: 'an order for the wrong item would be placed',
          proceed: false,
          concern: 'cart contents do not match the task',
        });
      },
    };

    const agent = new Agent({
      session,
      registry,
      executorModel: executor,
      simulatorModel,
      maxSteps: 4,
      startUrl: PAGE,
    });
    const result = await agent.run('Buy the correct widget');

    expect(purchases).toBe(0);
    expect(result.success).toBe(false);
    expect(result.result).toContain('blocked');
  });

  it('breaks a successful-but-inert action loop (no-progress repeats are forbidden)', async () => {
    const registry = buildCoreRegistry();
    registry.register(
      defineAction({
        name: 'peek',
        description: 'Read-only probe that reports success but never changes the page',
        params: z.object({ q: z.string() }),
        async run() {
          return { ok: true, message: 'nothing found' };
        },
      }),
    );

    let sawBreaker = false;
    let peekCount = 0;
    const executor: ChatModel = {
      id: 'exec',
      spec,
      caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
      async generate(request) {
        const text = lastText(request);
        // The fix: a repeated action that always reports ok but leaves the page
        // inert must still surface FORBIDDEN/STUCK. Before the fix it never did,
        // and this loop ran to the step budget.
        if (text.includes('FORBIDDEN') || text.includes('STUCK')) {
          sawBreaker = true;
          return toolResponse('agent_step', {
            evaluationPreviousGoal: 'failure',
            memory: 'the probe never changes anything',
            nextGoal: 'abandon the loop',
            actions: [
              { name: 'done', params: { success: false, result: 'changed strategy after no-progress loop' } },
            ],
          });
        }
        peekCount += 1;
        return toolResponse('agent_step', {
          evaluationPreviousGoal: 'success',
          memory: '',
          nextGoal: 'probe again',
          actions: [{ name: 'peek', params: { q: 'main_heading' } }],
        });
      },
    };

    const agent = new Agent({
      session,
      registry,
      executorModel: executor,
      maxSteps: 10,
      startUrl: PAGE,
    });
    const result = await agent.run('Find something via the probe');

    expect(sawBreaker).toBe(true); // loop-breaker fired despite every action reporting ok
    expect(peekCount).toBeLessThan(10); // did not silently exhaust the step budget
    expect(result.success).toBe(false);
  });
});
