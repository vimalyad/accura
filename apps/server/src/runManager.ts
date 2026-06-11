import { randomUUID } from 'node:crypto';
import { createLogger } from '@accura/shared';
import type { AgentEvent, AgentResult } from '@accura/agent';

const log = createLogger('server:runs');

export interface RunRequest {
  task: string;
  startUrl?: string;
  profile?: string;
  maxSteps?: number;
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'error';

export interface RunSummary {
  id: string;
  task: string;
  profile: string;
  status: RunStatus;
  createdAt: string;
  finishedAt?: string;
  stepsTaken?: number;
  result?: string;
  error?: string;
}

/**
 * Executes one run and reports lifecycle events. Injectable so tests use
 * scripted models while production wires profiles + a real browser.
 */
export type RunWiring = (
  request: RunRequest,
  onEvent: (event: AgentEvent) => void,
) => Promise<AgentResult>;

interface RunState {
  summary: RunSummary;
  request: RunRequest;
  events: AgentEvent[];
  listeners: Set<(event: AgentEvent) => void>;
}

const MAX_BUFFERED_EVENTS = 1000;

/**
 * In-memory run registry with a concurrency-capped queue. Events are
 * buffered per run so an SSE client that connects mid-run (or after the
 * run finished) replays the full history before going live. To bound
 * memory, only the LATEST step event keeps its screenshot in the buffer —
 * live listeners always receive full events.
 */
export class RunManager {
  private readonly runs = new Map<string, RunState>();
  private readonly queue: string[] = [];
  private active = 0;

  constructor(
    private readonly wiring: RunWiring,
    private readonly concurrency = 2,
  ) {}

  create(request: RunRequest): RunSummary {
    const summary: RunSummary = {
      id: randomUUID(),
      task: request.task,
      profile: request.profile ?? 'dev',
      status: 'queued',
      createdAt: new Date().toISOString(),
    };
    this.runs.set(summary.id, { summary, request, events: [], listeners: new Set() });
    this.queue.push(summary.id);
    // Snapshot before scheduling: execution may flip the status to 'running'
    // synchronously, but the caller should see what they created.
    const snapshot = { ...summary };
    this.schedule();
    return snapshot;
  }

  get(id: string): RunSummary | undefined {
    const state = this.runs.get(id);
    return state ? { ...state.summary } : undefined;
  }

  list(): RunSummary[] {
    return [...this.runs.values()]
      .map((state) => ({ ...state.summary }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Replays the buffered event history, then attaches for live events.
   * Returns an unsubscribe function. Callers should close on 'result'.
   */
  subscribe(id: string, listener: (event: AgentEvent) => void): (() => void) | undefined {
    const state = this.runs.get(id);
    if (!state) return undefined;
    for (const event of state.events) listener(event);
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }

  private schedule(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.active += 1;
      void this.execute(id).finally(() => {
        this.active -= 1;
        this.schedule();
      });
    }
  }

  private async execute(id: string): Promise<void> {
    const state = this.runs.get(id);
    if (!state) return;
    state.summary.status = 'running';
    log.info({ id, task: state.request.task }, 'run started');
    try {
      const result = await this.wiring(state.request, (event) => this.push(state, event));
      state.summary.status = result.success ? 'succeeded' : 'failed';
      state.summary.stepsTaken = result.stepsTaken;
      state.summary.result = result.result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.summary.status = 'error';
      state.summary.error = message;
      // Synthesize a terminal event so stream consumers always see closure.
      this.push(state, { type: 'result', success: false, result: `Run crashed: ${message}`, stepsTaken: 0 });
      log.error({ id, error }, 'run crashed');
    } finally {
      state.summary.finishedAt = new Date().toISOString();
    }
  }

  private push(state: RunState, event: AgentEvent): void {
    if (event.type === 'step' && event.screenshotBase64) {
      // Drop screenshots from older buffered steps; keep only the newest.
      for (const buffered of state.events) {
        if (buffered.type === 'step') delete buffered.screenshotBase64;
      }
    }
    state.events.push(event);
    if (state.events.length > MAX_BUFFERED_EVENTS) state.events.shift();
    for (const listener of state.listeners) {
      try {
        listener(event);
      } catch {
        // a broken consumer must never break the run
      }
    }
  }
}
