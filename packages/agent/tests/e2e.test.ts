import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserConfigSchema, ModelSpecSchema } from '@accura/shared';
import { BrowserSession } from '@accura/browser';
import { buildCoreRegistry } from '@accura/actions';
import type { ChatModel, ChatRequest, ChatResponse } from '@accura/llm';
import { Agent } from '../src/loop.js';

const config = BrowserConfigSchema.parse({ headless: true });

function dataUrl(html: string): string {
  return `data:text/html,${encodeURIComponent(html)}`;
}

const SIGNUP_PAGE = `
<html><head><title>Signup</title></head><body>
  <h1>Create your account</h1>
  <form id="f">
    <input id="name" type="text" placeholder="Full name">
    <input id="email" type="email" placeholder="Email address">
    <button type="submit">Submit form</button>
  </form>
  <script>
    document.getElementById('f').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = document.getElementById('name').value;
      const email = document.getElementById('email').value;
      const msg = document.createElement('div');
      msg.id = 'msg';
      msg.textContent = 'Thanks ' + name + ' (' + email + ')';
      document.body.appendChild(msg);
    });
  </script>
</body></html>`;

/**
 * Scripted executor: parses the REAL observation text it receives to find
 * element ids, exactly like an LLM would. Exercises the full pipeline —
 * perception → structured output schema → grounding → batching → done —
 * deterministically, with no API key.
 */
class ScriptedModel implements ChatModel {
  readonly id = 'scripted';
  readonly spec = ModelSpecSchema.parse({ provider: 'openai-compatible', model: 'scripted' });
  readonly caps = { vision: false, toolUse: true, structured: true, coordinateGrounded: false };
  calls = 0;

  async generate(request: ChatRequest): Promise<ChatResponse> {
    this.calls += 1;
    const lastMessage = request.messages.at(-1);
    const text =
      typeof lastMessage?.content === 'string'
        ? lastMessage.content
        : (lastMessage?.content ?? [])
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('\n');

    const idFor = (pattern: RegExp): number => {
      const match = text.match(pattern);
      if (!match?.[1]) throw new Error(`ScriptedModel: no element matching ${pattern}`);
      return Number(match[1]);
    };

    let step: Record<string, unknown>;
    if (text.includes('Thanks Ada (ada@example.com)')) {
      step = {
        evaluationPreviousGoal: 'success',
        memory: 'Form submitted, confirmation visible.',
        nextGoal: 'Report completion',
        actions: [
          {
            name: 'done',
            params: { success: true, result: 'Submitted. Confirmation: Thanks Ada (ada@example.com)' },
          },
        ],
      };
    } else if (text.includes('value=ada@example.com') || text.includes('value="ada@example.com"')) {
      step = {
        evaluationPreviousGoal: 'success',
        memory: 'Name and email filled.',
        nextGoal: 'Submit the form',
        actions: [
          { name: 'click', params: { id: idFor(/\[(\d+)\]<button[^>]*> "Submit form"/) } },
        ],
      };
    } else {
      step = {
        evaluationPreviousGoal: 'first-step',
        memory: 'On signup form.',
        nextGoal: 'Fill name and email',
        actions: [
          {
            name: 'input',
            params: { id: idFor(/\[(\d+)\]<input[^>]*placeholder="Full name"/), text: 'Ada' },
          },
          {
            name: 'input',
            params: {
              id: idFor(/\[(\d+)\]<input[^>]*placeholder="Email address"/),
              text: 'ada@example.com',
            },
          },
        ],
      };
    }

    return {
      text: '',
      toolCalls: [{ id: `call_${this.calls}`, name: 'agent_step', arguments: step }],
      stopReason: 'tool_use',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
    };
  }
}

describe('Agent end-to-end (scripted model)', () => {
  let session: BrowserSession;

  beforeAll(async () => {
    session = await BrowserSession.launch(config);
  });

  afterAll(async () => {
    await session.close();
  });

  it('completes a multi-step form task through the full pipeline', async () => {
    const model = new ScriptedModel();
    const agent = new Agent({
      session,
      registry: buildCoreRegistry(),
      executorModel: model,
      maxSteps: 6,
      startUrl: dataUrl(SIGNUP_PAGE),
    });

    const result = await agent.run('Sign up as Ada with email ada@example.com');

    expect(result.success).toBe(true);
    expect(result.result).toContain('Thanks Ada (ada@example.com)');
    expect(result.stepsTaken).toBeLessThanOrEqual(4);
    expect(result.history.length).toBe(result.stepsTaken);
    // The confirmation really exists on the page (no fabrication).
    const msg = await session.page.textContent('#msg');
    expect(msg).toBe('Thanks Ada (ada@example.com)');
  });

  it('returns an honest failure when the step budget runs out', async () => {
    const stuckModel: ChatModel = {
      id: 'stuck',
      spec: ModelSpecSchema.parse({ provider: 'openai-compatible', model: 'stuck' }),
      caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
      async generate(): Promise<ChatResponse> {
        return {
          text: '',
          toolCalls: [
            {
              id: 'c',
              name: 'agent_step',
              arguments: {
                evaluationPreviousGoal: 'uncertain',
                memory: 'looping',
                nextGoal: 'wait around',
                actions: [{ name: 'wait', params: { seconds: 0.5 } }],
              },
            },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
        };
      },
    };

    const agent = new Agent({
      session,
      registry: buildCoreRegistry(),
      executorModel: stuckModel,
      maxSteps: 2,
      startUrl: dataUrl('<h1>nothing here</h1>'),
    });

    const result = await agent.run('Impossible task');
    expect(result.success).toBe(false);
    expect(result.result).toContain('budget');
    expect(result.stepsTaken).toBe(2);
  });
});
