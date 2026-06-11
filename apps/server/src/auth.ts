import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'accura_session';

/**
 * What auth needs from the store (PgStore implements this structurally).
 * Email+password with NO verification — by explicit product decision;
 * the email is an identifier, not a verified contact.
 */
export interface AuthStore {
  createUser(email: string, passwordHash: string): Promise<{ id: string; email: string }>;
  getUserByEmail(
    email: string,
  ): Promise<{ id: string; email: string; passwordHash: string } | undefined>;
  createSession(userId: string, ttlDays?: number): Promise<string>;
  getSessionUser(token: string): Promise<{ id: string; email: string } | undefined>;
  deleteSession(token: string): Promise<void>;
}

// ── password hashing: scrypt (built-in, no native deps) ────────────

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// ── fastify integration ────────────────────────────────────────────

const CredentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(8, 'password must be at least 8 characters'),
});

function readSessionToken(request: FastifyRequest): string | undefined {
  const cookie = request.headers.cookie;
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === SESSION_COOKIE && value) return decodeURIComponent(value);
  }
  return undefined;
}

function setSessionCookie(reply: FastifyReply, token: string, maxAgeSeconds: number): void {
  reply.header(
    'set-cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`,
  );
}

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    userEmail?: string;
  }
}

/**
 * Registers /api/auth/* and guards /api/runs* behind a session.
 * Sessions live in the database, so any server instance can validate them.
 */
export function registerAuth(app: FastifyInstance, store: AuthStore): void {
  app.post('/api/auth/signup', async (request, reply) => {
    const parsed = CredentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    }
    let user: { id: string; email: string };
    try {
      user = await store.createUser(parsed.data.email, hashPassword(parsed.data.password));
    } catch (error) {
      if (error instanceof Error && error.message === 'email already registered') {
        return reply.code(409).send({ error: 'email already registered' });
      }
      throw error;
    }
    const token = await store.createSession(user.id);
    setSessionCookie(reply, token, 30 * 24 * 3600);
    return reply.code(201).send({ user: { email: user.email } });
  });

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = CredentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    }
    const user = await store.getUserByEmail(parsed.data.email);
    // Same response for unknown email and wrong password: no account probing.
    if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
      return reply.code(401).send({ error: 'invalid email or password' });
    }
    const token = await store.createSession(user.id);
    setSessionCookie(reply, token, 30 * 24 * 3600);
    return reply.send({ user: { email: user.email } });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = readSessionToken(request);
    if (token) await store.deleteSession(token);
    setSessionCookie(reply, '', 0);
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', async (request) => {
    const token = readSessionToken(request);
    const user = token ? await store.getSessionUser(token) : undefined;
    return { authEnabled: true, user: user ? { email: user.email } : null };
  });

  // Guard: everything under /api/runs requires a valid session.
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/runs')) return;
    const token = readSessionToken(request);
    const user = token ? await store.getSessionUser(token) : undefined;
    if (!user) {
      return reply.code(401).send({ error: 'authentication required' });
    }
    request.userId = user.id;
    request.userEmail = user.email;
  });
}
