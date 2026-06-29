import { useState } from 'react';
import { getServerUrl, setServerUrl } from '../native';

/**
 * First-run screen for the native app: ask which Konfus server to talk to (the
 * public Cloudflare-tunnel URL). The browser app never sees this — it's served
 * by the server and talks to it same-origin. The chosen URL is verified by
 * pinging the unauthenticated /api/auth/me endpoint, then persisted; afterwards
 * the normal login flow takes over. Reachable again later via the "Connect to a
 * different server" links (see setupContext).
 */
export function ServerSetup({ onConnected }: { onConnected: () => void }): JSX.Element {
  const [url, setUrl] = useState(getServerUrl());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // Tolerate a bare host (no scheme) by defaulting to https — the tunnel is
    // always https — and drop any trailing slash so we don't build `//api`.
    let normalized = url.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;
    try {
      // /api/auth/me is unauthenticated and always returns JSON, so a clean 200
      // confirms we're really pointing at a Konfus server.
      let res: Response;
      try {
        res = await fetch(`${normalized}/api/auth/me`, { headers: { Accept: 'application/json' } });
      } catch (err) {
        // A *thrown* fetch is a transport-level failure — DNS, offline, TLS, or
        // the server not sending CORS headers for this origin — never an HTTP
        // status. Distinguish it so "wrong address" and "can't reach" don't look
        // the same. Logged so it's visible over `adb logcat` when debugging.
        console.error('[ServerSetup] connect failed:', err);
        throw new Error(`Couldn’t reach ${normalized}. Check the address and that you’re online.`);
      }
      if (!res.ok) {
        throw new Error(`That server responded with ${res.status}. Double-check the address.`);
      }
      const body = (await res.json().catch(() => null)) as { isLocal?: unknown } | null;
      if (typeof body?.isLocal !== 'boolean') {
        throw new Error("That address responded, but it doesn’t look like a Konfus server.");
      }
      await setServerUrl(normalized);
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-zinc-950 p-6">
      <form
        onSubmit={connect}
        className="w-full max-w-sm space-y-5 rounded-2xl border border-zinc-800 bg-zinc-900 p-8 shadow-xl shadow-black/30"
      >
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">KONFUS</h1>
          <p className="text-sm text-zinc-400">
            Enter the address of your Konfus server to connect.
          </p>
        </div>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-zinc-300">Server address</span>
          <input
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            autoFocus
            placeholder="https://brew.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-base text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-blue-500"
          />
        </label>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={busy || !url.trim()}
          className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-base font-medium text-white transition hover:bg-blue-500 disabled:opacity-40"
        >
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    </div>
  );
}
