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
  const from = (location.state as { from?: string } | null)?.from ?? '/admin';

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
    <div className="flex min-h-full items-center justify-center bg-gray-100 p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-5 rounded-2xl bg-white p-8 shadow-sm"
      >
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-gray-900">BrewPlanner</h1>
          <p className="text-sm text-gray-500">Sign in to continue.</p>
        </div>

        <label className="block space-y-1">
          <span className="text-sm font-medium text-gray-700">Username</span>
          <input
            type="text"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base outline-none focus:border-gray-900"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium text-gray-700">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base outline-none focus:border-gray-900"
          />
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={busy || !username || !password}
          className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-base font-medium text-white transition hover:bg-gray-700 disabled:opacity-40"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
