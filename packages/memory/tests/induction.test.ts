import { describe, expect, it, vi } from 'vitest';
import { ModelSpecSchema } from '@accura/shared';
import type { ChatModel, ChatRequest, ChatResponse } from '@accura/llm';
import { redactDraft, SkillInductor } from '../src/induction.js';
import type { SkillDraft } from '../src/types.js';

const spec = ModelSpecSchema.parse({ provider: 'openai-compatible', model: 'fake' });

describe('SkillInductor', () => {
  it('induces a draft via structured output and applies PII redaction', async () => {
    const generate = vi.fn(async (_request: ChatRequest): Promise<ChatResponse> => ({
      text: '',
      toolCalls: [
        {
          id: 'c',
          name: 'submit_skill',
          arguments: {
            title: 'Sign up on signup.example',
            urlPattern: 'signup.example',
            preconditions: ['signup page is open'],
            steps: [
              // Model leaked an email despite instructions — redaction must catch it.
              { action: 'input', targetText: 'Email address', params: { text: 'ada@example.com' } },
              { action: 'click', targetText: 'Submit form', params: {} },
            ],
          },
        },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
    }));
    const model: ChatModel = {
      id: 'fake',
      spec,
      caps: { vision: false, toolUse: true, structured: true, coordinateGrounded: false },
      generate,
    };

    const inductor = new SkillInductor(model);
    const draft = await inductor.induce('sign up', 'https://signup.example/form', [
      'Step 1: filled the form',
    ]);

    expect(draft.title).toBe('Sign up on signup.example');
    expect(draft.steps[0]?.params.text).toBe('{email}');
    const request = generate.mock.calls[0]![0];
    expect(request.system).toContain('NEVER include personal data');
  });
});

describe('redactDraft', () => {
  it('scrubs emails and long numbers everywhere', () => {
    const draft: SkillDraft = {
      title: 'Contact bob@corp.example',
      urlPattern: 'corp.example',
      preconditions: ['account 12345678901 exists'],
      steps: [{ action: 'input', targetText: 'phone 9998887776655', params: { text: 'x' } }],
    };
    const clean = redactDraft(draft);
    expect(clean.title).toBe('Contact {email}');
    expect(clean.preconditions[0]).toBe('account {number} exists');
    expect(clean.steps[0]?.targetText).toBe('phone {number}');
  });
});
