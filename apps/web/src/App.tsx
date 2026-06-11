import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createRun,
  listRuns,
  streamRun,
  type AgentEvent,
  type RunSummary,
} from './api';

export default function App() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const stopStream = useRef<(() => void) | null>(null);

  const refreshRuns = useCallback(() => {
    listRuns()
      .then(setRuns)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshRuns();
    const timer = setInterval(refreshRuns, 3000);
    return () => clearInterval(timer);
  }, [refreshRuns]);

  const selectRun = useCallback((id: string) => {
    stopStream.current?.();
    setSelectedId(id);
    setEvents([]);
    stopStream.current = streamRun(id, (event) =>
      setEvents((existing) => [...existing, event]),
    );
  }, []);

  useEffect(() => () => stopStream.current?.(), []);

  async function submit(form: FormData) {
    const task = String(form.get('task') ?? '').trim();
    if (!task) return;
    setSubmitting(true);
    setFormError('');
    try {
      const startUrl = String(form.get('startUrl') ?? '').trim();
      const maxSteps = Number(form.get('maxSteps'));
      const run = await createRun({
        task,
        profile: String(form.get('profile') ?? 'dev'),
        ...(startUrl ? { startUrl } : {}),
        ...(Number.isFinite(maxSteps) && maxSteps > 0 ? { maxSteps } : {}),
      });
      refreshRuns();
      selectRun(run.id);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  const selected = runs.find((run) => run.id === selectedId);
  const latestStep = [...events].reverse().find((e) => e.type === 'step');
  const latestShot = [...events]
    .reverse()
    .find((e) => e.type === 'step' && e.screenshotBase64);
  const result = events.find((e) => e.type === 'result');

  return (
    <div className="app">
      <header className="header">
        <div className="logo">
          ACCURA<span>.</span>
        </div>
        <div className="sub">accuracy-first browser agent console</div>
      </header>

      <aside className="sidebar">
        <h2>Runs</h2>
        {runs.length === 0 && <div className="empty">No runs yet</div>}
        {runs.map((run) => (
          <button
            key={run.id}
            className={`run-item ${run.id === selectedId ? 'selected' : ''}`}
            onClick={() => selectRun(run.id)}
          >
            <div className="task">{run.task}</div>
            <div className="meta">
              <span className={`badge ${run.status}`}>{run.status}</span>
              <span>{run.profile}</span>
              {run.stepsTaken !== undefined && <span>{run.stepsTaken} steps</span>}
            </div>
          </button>
        ))}
      </aside>

      <main className="main">
        <form
          className="new-run"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(new FormData(event.currentTarget));
          }}
        >
          <textarea
            name="task"
            placeholder='Describe the task, e.g. "Find the price of the Super Widget and report it"'
          />
          <div className="row">
            <input className="url" name="startUrl" placeholder="Start URL (optional)" />
            <select name="profile" defaultValue="dev">
              <option value="dev">dev (free models)</option>
              <option value="final">final (Claude)</option>
            </select>
            <input name="maxSteps" type="number" min="1" max="100" placeholder="max steps" />
            <button type="submit" disabled={submitting}>
              {submitting ? 'Starting…' : 'Run'}
            </button>
          </div>
          {formError && <div className="error">{formError}</div>}
        </form>

        {!selected && <div className="empty">Submit a task or select a run to watch it live.</div>}

        {selected && (
          <div className="run-view">
            <div className="screenshot-pane">
              {latestShot?.type === 'step' && latestShot.screenshotBase64 ? (
                <img
                  src={`data:image/png;base64,${latestShot.screenshotBase64}`}
                  alt={`step ${latestShot.step}`}
                />
              ) : (
                <div className="placeholder">
                  {selected.status === 'queued' ? 'Queued…' : 'No screenshot yet (DOM-only model)'}
                </div>
              )}
              {latestStep?.type === 'step' && <div className="url mono">{latestStep.url}</div>}
            </div>

            <div className="feed">
              {result && (
                <div className={`result-banner ${result.type === 'result' && result.success ? 'ok' : 'bad'}`}>
                  <strong>{result.type === 'result' && result.success ? 'Success' : 'Failed'}</strong>
                  {result.type === 'result' && (
                    <>
                      {' '}
                      after {result.stepsTaken} steps — {result.result}
                    </>
                  )}
                </div>
              )}
              {[...events].reverse().map((event, index) => (
                <EventCard key={events.length - index} event={event} />
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function EventCard({ event }: { event: AgentEvent }) {
  switch (event.type) {
    case 'start':
      return (
        <div className="card">
          <div className="card-head">
            <span className="badge info">start</span>
            <span className="goal">{event.task}</span>
          </div>
        </div>
      );
    case 'plan':
      return (
        <div className="card">
          <div className="card-head">
            <span className="badge info">plan r{event.revision}</span>
          </div>
          <pre>{event.plan}</pre>
        </div>
      );
    case 'replay':
      return (
        <div className="card">
          <div className="card-head">
            <span className={`badge ${event.complete ? 'success' : 'uncertain'}`}>replay</span>
          </div>
          <pre>{event.summary}</pre>
        </div>
      );
    case 'step':
      return (
        <div className="card">
          <div className="card-head">
            <span className={`badge ${event.evaluation}`}>{event.evaluation}</span>
            <span className="goal">
              {event.step}/{event.maxSteps} · {event.goal}
            </span>
          </div>
          <pre>{event.actionsSummary}</pre>
          {event.verifierNotes.length > 0 && (
            <div className="notes">{event.verifierNotes.join('\n')}</div>
          )}
        </div>
      );
    case 'judge':
      return (
        <div className="card">
          <div className="card-head">
            <span className={`badge ${event.verdict ? 'success' : 'failure'}`}>judge</span>
            <span>{event.verdict ? 'approved' : (event.reason ?? 'rejected')}</span>
          </div>
        </div>
      );
    case 'rejection':
      return (
        <div className="card">
          <div className="card-head">
            <span className="badge failure">rejected</span>
          </div>
          <pre>{event.reason}</pre>
        </div>
      );
    case 'result':
      return null; // rendered as the banner
  }
}
