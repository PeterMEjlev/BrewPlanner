import { Link } from 'react-router-dom';

/**
 * Kiosk settings screen, reached from the gear button on the home hub. Minimal
 * for now — a home button and a heading — so the gear has a real destination to
 * grow kiosk configuration into.
 */
export function SettingsPage(): JSX.Element {
  return (
    <div className="touch-none-select flex h-full flex-col bg-black text-white">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-6 py-4">
        <Link
          to="/kiosk"
          className="shrink-0 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-2xl leading-none transition active:bg-zinc-800"
          aria-label="Home"
        >
          ⌂
        </Link>
        <h1 className="py-1 text-3xl font-bold leading-normal tracking-tight">Settings</h1>
      </header>

      <main className="flex flex-1 items-center justify-center p-6 text-center">
        <p className="text-xl text-zinc-400">No settings yet.</p>
      </main>
    </div>
  );
}
