/** Wire types mirroring the server (kept local so the bundle stays lean). */

export interface RunSummary {
  id: string;
  task: string;
  profile: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'error';
  createdAt: string;
  finishedAt?: string;
  stepsTaken?: number;
  result?: string;
  error?: string;
}

export type AgentEvent =
  | { type: 'start'; task: string; maxSteps: number }
  | { type: 'plan'; step: number; plan: string; revision: number }
  | { type: 'replay'; summary: string; complete: boolean }
  | {
      type: 'step';
      step: number;
      maxSteps: number;
      url: string;
      goal: string;
      evaluation: string;
      memory: string;
      actionsSummary: string;
      verifierNotes: string[];
      screenshotBase64?: string;
    }
  | { type: 'judge'; step: number; verdict: boolean; reason?: string }
  | { type: 'rejection'; step: number; reason: string }
  | { type: 'result'; success: boolean; result: string; stepsTaken: number };

export interface CreateRunInput {
  task: string;
  startUrl?: string;
  profile?: string;
  maxSteps?: number;
}

export interface MeResponse {
  authEnabled: boolean;
  user: { email: string } | null;
}

export async function getMe(): Promise<MeResponse> {
  const response = await fetch('/api/auth/me');
  if (!response.ok) throw new Error(`me failed (${response.status})`);
  return (await response.json()) as MeResponse;
}

async function authPost(path: string, body?: unknown): Promise<{ email: string }> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
    user?: { email: string };
  };
  if (!response.ok) throw new Error(data.error ?? `request failed (${response.status})`);
  return data.user ?? { email: '' };
}

export function signup(email: string, password: string): Promise<{ email: string }> {
  return authPost('/api/auth/signup', { email, password });
}

export function login(email: string, password: string): Promise<{ email: string }> {
  return authPost('/api/auth/login', { email, password });
}

export async function logout(): Promise<void> {
  await authPost('/api/auth/logout');
}

export async function createRun(input: CreateRunInput): Promise<RunSummary> {
  const response = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `create failed (${response.status})`);
  }
  return (await response.json()) as RunSummary;
}

export async function listRuns(): Promise<RunSummary[]> {
  const response = await fetch('/api/runs');
  if (!response.ok) throw new Error(`list failed (${response.status})`);
  return (await response.json()) as RunSummary[];
}

/** Subscribes to a run's SSE stream. Returns a cleanup function. */
export function streamRun(id: string, onEvent: (event: AgentEvent) => void): () => void {
  const source = new EventSource(`/api/runs/${id}/stream`);
  source.onmessage = (message) => {
    const event = JSON.parse(message.data) as AgentEvent;
    onEvent(event);
    if (event.type === 'result') source.close();
  };
  source.onerror = () => {
    // server closes the stream after the result; treat further errors as final
    source.close();
  };
  return () => source.close();
}
