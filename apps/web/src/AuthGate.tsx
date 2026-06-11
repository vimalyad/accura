import { useState } from 'react';
import { login, signup } from './api';

export function AuthGate({ onAuthed }: { onAuthed: (email: string) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(form: FormData) {
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    if (!email || !password) return;
    setBusy(true);
    setError('');
    try {
      const user = mode === 'login' ? await login(email, password) : await signup(email, password);
      onAuthed(user.email);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-gate">
      <div className="auth-card">
        <div className="auth-logo">
          Accura<span>.</span>
        </div>
        <div className="auth-sub">verified browser automation</div>

        <div className="auth-tabs">
          <button
            type="button"
            className={mode === 'login' ? 'active' : ''}
            onClick={() => setMode('login')}
          >
            Sign in
          </button>
          <button
            type="button"
            className={mode === 'signup' ? 'active' : ''}
            onClick={() => setMode('signup')}
          >
            Create account
          </button>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(new FormData(event.currentTarget));
          }}
        >
          <label>
            <span className="micro">email</span>
            <input name="email" type="email" autoComplete="email" placeholder="you@example.com" />
          </label>
          <label>
            <span className="micro">password{mode === 'signup' ? ' · min 8 chars' : ''}</span>
            <input
              name="password"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              placeholder="••••••••"
            />
          </label>
          {error && <div className="error">{error}</div>}
          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}
