import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentResult } from '@accura/agent';
import { hashPassword, verifyPassword, type AuthStore } from '../src/auth.js';
import { RunManager, type RunWiring } from '../src/runManager.js';
import { buildServer } from '../src/server.js';

describe('password hashing', () => {
  it('verifies correct passwords and rejects wrong ones', () => {
    const stored = hashPassword('hunter2hunter2');
    expect(verifyPassword('hunter2hunter2', stored)).toBe(true);
    expect(verifyPassword('wrong-password', stored)).toBe(false);
  });

  it('salts: same password hashes differently', () => {
    expect(hashPassword('samesame123')).not.toBe(hashPassword('samesame123'));
  });

  it('rejects malformed stored values', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
  });
});

/** In-memory AuthStore double. */
function fakeAuthStore(): AuthStore {
  const users = new Map<string, { id: string; email: string; passwordHash: string }>();
  const sessions = new Map<string, string>(); // token -> userId
  return {
    async createUser(email, passwordHash) {
      if (users.has(email)) throw new Error('email already registered');
      const user = { id: randomUUID(), email, passwordHash };
      users.set(email, user);
      return user;
    },
    async getUserByEmail(email) {
      return users.get(email);
    },
    async createSession(userId) {
      const token = randomUUID();
      sessions.set(token, userId);
      return token;
    },
    async getSessionUser(token) {
      const userId = sessions.get(token);
      if (!userId) return undefined;
      const user = [...users.values()].find((u) => u.id === userId);
      return user ? { id: user.id, email: user.email } : undefined;
    },
    async deleteSession(token) {
      sessions.delete(token);
    },
  };
}

const wiring: RunWiring = async (request, onEvent): Promise<AgentResult> => {
  onEvent({ type: 'start', task: request.task, maxSteps: 1 });
  onEvent({ type: 'result', success: true, result: 'ok', stepsTaken: 1 });
  return {
    success: true,
    result: 'ok',
    stepsTaken: 1,
    history: [],
    doneRejections: 0,
    planRevisions: 0,
  };
};

function cookieOf(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  const raw = Array.isArray(header) ? header[0] : header;
  return String(raw).split(';')[0]!;
}

describe('auth flow and run scoping', () => {
  const manager = new RunManager(wiring);
  const app = buildServer(manager, { authStore: fakeAuthStore() });

  afterAll(async () => {
    await app.close();
  });

  it('signs up, reports identity, logs out and logs back in', async () => {
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: 'ada@example.com', password: 'lovelace-engine' },
    });
    expect(signup.statusCode).toBe(201);
    const cookie = cookieOf(signup);
    expect(cookie).toContain('accura_session=');

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(me.json()).toEqual({ authEnabled: true, user: { email: 'ada@example.com' } });

    const dupe = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: 'ada@example.com', password: 'lovelace-engine' },
    });
    expect(dupe.statusCode).toBe(409);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(200);
    const meAfter = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect((meAfter.json() as { user: unknown }).user).toBeNull();

    const badLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ada@example.com', password: 'wrong-password' },
    });
    expect(badLogin.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ada@example.com', password: 'lovelace-engine' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('rejects weak signups', async () => {
    const short = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: 'b@example.com', password: 'short' },
    });
    expect(short.statusCode).toBe(400);
    const notEmail = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: 'not-an-email', password: 'long-enough-pw' },
    });
    expect(notEmail.statusCode).toBe(400);
  });

  it('guards /api/runs and scopes runs per user', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(anonymous.statusCode).toBe(401);

    const aliceCookie = cookieOf(
      await app.inject({
        method: 'POST',
        url: '/api/auth/signup',
        payload: { email: 'alice@example.com', password: 'alice-password' },
      }),
    );
    const bobCookie = cookieOf(
      await app.inject({
        method: 'POST',
        url: '/api/auth/signup',
        payload: { email: 'bob@example.com', password: 'bob-password-1' },
      }),
    );

    const created = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: { cookie: aliceCookie },
      payload: { task: 'alice private task' },
    });
    expect(created.statusCode).toBe(201);
    const runId = (created.json() as { id: string }).id;

    // alice sees her run; bob does not
    const aliceList = (
      await app.inject({ method: 'GET', url: '/api/runs', headers: { cookie: aliceCookie } })
    ).json() as Array<{ id: string }>;
    expect(aliceList.some((r) => r.id === runId)).toBe(true);

    const bobList = (
      await app.inject({ method: 'GET', url: '/api/runs', headers: { cookie: bobCookie } })
    ).json() as Array<{ id: string }>;
    expect(bobList.some((r) => r.id === runId)).toBe(false);

    const bobGet = await app.inject({
      method: 'GET',
      url: `/api/runs/${runId}`,
      headers: { cookie: bobCookie },
    });
    expect(bobGet.statusCode).toBe(404);
    const bobStream = await app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/stream`,
      headers: { cookie: bobCookie },
    });
    expect(bobStream.statusCode).toBe(404);

    const aliceGet = await app.inject({
      method: 'GET',
      url: `/api/runs/${runId}`,
      headers: { cookie: aliceCookie },
    });
    expect(aliceGet.statusCode).toBe(200);
  });

  it('reports authEnabled=false when no auth store is configured', async () => {
    const openApp = buildServer(new RunManager(wiring));
    const me = await openApp.inject({ method: 'GET', url: '/api/auth/me' });
    expect(me.json()).toEqual({ authEnabled: false, user: null });
    const list = await openApp.inject({ method: 'GET', url: '/api/runs' });
    expect(list.statusCode).toBe(200);
    await openApp.close();
  });
});
