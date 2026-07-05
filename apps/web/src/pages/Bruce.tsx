import { DashboardShell } from '../components/DashboardShell';
import { MicIcon } from '../components/icons';

/**
 * Bruce — the brewery voice assistant (apps/bruce, running as its own service
 * on the Pi). Placeholder for now: the status/conversation view (state
 * indicator, live transcript, speak box) is planned but not built yet.
 */
export function BrucePage(): JSX.Element {
  return (
    <DashboardShell active="bruce">
      <main className="w-full max-w-[1580px] px-5 py-5">
        <div className="mb-5">
          <h1 className="text-xl font-semibold tracking-tight text-zinc-50">Bruce</h1>
          <p className="mt-0.5 text-sm text-zinc-500">
            The brewery voice assistant — status and conversation history.
          </p>
        </div>
        <section className="flex flex-col items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-6 py-16 text-center">
          <MicIcon className="h-10 w-10 text-zinc-600" />
          <h2 className="text-lg font-medium text-zinc-200">Nothing here yet</h2>
          <p className="max-w-md text-sm text-zinc-500">
            Bruce runs as a background service on the Pi (say “Bruce!” near the
            microphone). A live status view — listening state, transcripts, and
            recent conversations — will appear here in a later update.
          </p>
        </section>
      </main>
    </DashboardShell>
  );
}
