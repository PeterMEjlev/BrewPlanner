import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';

/**
 * Login screen shown to remote visitors. Local kiosk requests are trusted and
 * never reach this page (see RequireAuth). On success we go to wherever the
 * visitor was headed, defaulting to the admin view.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(username, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error && err.message.startsWith('401')
        ? 'Invalid username or password.'
        : 'Could not sign in. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-950 p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-5 rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-xl shadow-black/30"
      >
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-slate-100">
            <span aria-hidden>🍺</span> Konfus Brewing
          </h1>
          <p className="text-sm text-slate-400">Sign in to continue.</p>
        </div>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-slate-300">Username</span>
          <input
            type="text"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-base text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-blue-500"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-slate-300">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-base text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-blue-500"
          />
        </label>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={busy || !username || !password}
          className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-base font-medium text-white transition hover:bg-blue-500 disabled:opacity-40"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
