/**
 * Lifecycle events emitted by the Agent for live observers (the API server
 * streams these over SSE). Mirrors what the trace writer persists — the
 * trace is the durable record, events are the live feed.
 */
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

export type AgentEventListener = (event: AgentEvent) => void;
