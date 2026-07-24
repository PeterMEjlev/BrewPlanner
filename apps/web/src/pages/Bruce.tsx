import { useEffect, useRef, useState } from 'react';
import type { BruceServiceStatus, BruceState, BruceTranscriptEntry } from '@checklist/shared';
import { api } from '../api';
import { DashboardShell } from '../components/DashboardShell';
import { MicIcon } from '../components/icons';
import { usePoll } from '../usePoll';
import { relativeTime } from '../util';

/** How often the page refreshes Bruce's state + transcript. */
const POLL_MS = 2000;

/** Look of each assistant state: label, dot colour, and whether it pulses. */
const STATE_LOOK: Record<BruceState, { label: string; dot: string; pulse: boolean }> = {
  idle: { label: 'Idle — waiting for "Bruce!"', dot: 'bg-zinc-500', pulse: false },
  listening: { label: 'Listening…', dot: 'bg-emerald-400', pulse: true },
  thinking: { label: 'Thinking…', dot: 'bg-amber-400', pulse: true },
  speaking: { label: 'Speaking…', dot: 'bg-sky-400', pulse: true },
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** One transcript line. Users and Bruce get speech bubbles; the rest are meta lines. */
function TranscriptLine({ entry }: { entry: BruceTranscriptEntry }): JSX.Element {
  if (entry.type === 'function_call') {
    return (
      <div className="flex items-baseline gap-2 px-1 py-0.5 text-xs text-zinc-500">
        <span className="font-mono">ƒ {entry.content}</span>
        <span className="ml-auto shrink-0 tabular-nums">{formatTime(entry.timestamp)}</span>
      </div>
    );
  }
  if (entry.type === 'system') {
    return (
      <div className="flex items-baseline gap-2 px-1 py-0.5 text-xs italic text-zinc-500">
        <span>{entry.content}</span>
        <span className="ml-auto shrink-0 not-italic tabular-nums">{formatTime(entry.timestamp)}</span>
      </div>
    );
  }
  const isUser = entry.type === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
          isUser ? 'bg-emerald-950/60 text-emerald-100' : 'bg-zinc-800 text-zinc-100'
        }`}
      >
        <div className="mb-0.5 flex items-baseline gap-2 text-xs text-zinc-500">
          <span className="font-semibold">{isUser ? 'You' : 'Bruce'}</span>
          <span className="tabular-nums">{formatTime(entry.timestamp)}</span>
        </div>
        {entry.content}
      </div>
    </div>
  );
}

/** Volume slider that follows the server value except while being dragged. */
function VolumeControl({ serverPercent }: { serverPercent: number }): JSX.Element {
  const [local, setLocal] = useState<number | null>(null);
  const value = local ?? serverPercent;

  const commit = async (): Promise<void> => {
    if (local == null) return;
    try {
      await api.bruceSetVolume(local);
    } catch {
      // The next poll re-syncs the slider to the real value.
    }
    setLocal(null);
  };

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="text-zinc-400">Speech volume</span>
        <span className="tabular-nums text-zinc-200">{value}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={200}
        step={5}
        value={value}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={() => void commit()}
        onKeyUp={() => void commit()}
        className="w-full accent-emerald-400"
        aria-label="Bruce speech volume"
      />
      <div className="mt-0.5 flex justify-between text-[10px] text-zinc-600">
        <span>mute</span>
        <span>100 = normal</span>
        <span>200</span>
      </div>
    </div>
  );
}

/** Text box to make Bruce say something out loud in the brewery. */
function SpeakBox(): JSX.Element {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (): Promise<void> => {
    const text = message.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.bruceSpeak(text);
      setMessage('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div className="flex gap-2">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Make Bruce say something in the brewery…"
          maxLength={500}
          className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || !message.trim()}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition enabled:hover:bg-emerald-500 disabled:opacity-40"
        >
          {busy ? 'Sending…' : 'Say it'}
        </button>
      </div>
      {error && <p className="mt-1.5 text-xs text-red-400">{error}</p>}
    </form>
  );
}

export function BrucePage(): JSX.Element {
  const [status, setStatus] = useState<BruceServiceStatus | null>(null);

  usePoll(async (isStale) => {
    try {
      const next = await api.getBruceStatus();
      if (!isStale()) setStatus(next);
    } catch {
      // Keep the last known status through a transient failure.
    }
  }, POLL_MS);

  // Keep the transcript pinned to the newest entry as it grows.
  const scrollRef = useRef<HTMLDivElement>(null);
  const entryCount = status?.online ? status.transcript.length : 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entryCount]);

  return (
    <DashboardShell active="bruce">
      <main className="w-full max-w-[1100px] px-5 py-5">
        {status == null && <p className="text-sm text-zinc-500">Loading…</p>}

        {status != null && !status.online && (
          <section className="flex flex-col items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-6 py-16 text-center">
            <MicIcon className="h-10 w-10 text-zinc-600" />
            <h2 className="text-lg font-medium text-zinc-200">Bruce isn't running</h2>
            <p className="max-w-md text-sm text-zinc-500">
              The voice-assistant service is not reachable on the Pi. Once the microphone and
              speaker are set up, enable it with <code className="text-zinc-400">sudo systemctl
              enable --now bruce.service</code> — see deploy/README-bruce.md for the full
              walkthrough.
            </p>
          </section>
        )}

        {status != null && status.online && (
          <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
            {/* Status + controls rail */}
            <section className="h-fit space-y-5 rounded-xl border border-zinc-800 bg-zinc-900 p-5">
              <div className="flex items-center gap-3">
                <span className="relative flex h-3 w-3">
                  {STATE_LOOK[status.state].pulse && (
                    <span
                      className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${STATE_LOOK[status.state].dot}`}
                    />
                  )}
                  <span
                    className={`relative inline-flex h-3 w-3 rounded-full ${STATE_LOOK[status.state].dot}`}
                  />
                </span>
                <span className="text-sm font-medium text-zinc-100">
                  {STATE_LOOK[status.state].label}
                </span>
              </div>

              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-zinc-500">OpenAI session</dt>
                  <dd className={status.connected ? 'text-emerald-400' : 'text-zinc-400'}>
                    {/* The session closes between conversations by design. */}
                    {status.connected ? 'Connected' : 'Standby'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-zinc-500">Model</dt>
                  <dd className="truncate text-zinc-200">{status.model}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-zinc-500">Service up since</dt>
                  <dd className="text-zinc-200">{relativeTime(status.startedAt)}</dd>
                </div>
              </dl>

              <VolumeControl serverPercent={status.volumePercent} />
            </section>

            {/* Conversation */}
            <section className="flex min-h-[420px] flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-5">
              <h2 className="mb-3 text-sm font-semibold text-zinc-300">Conversation</h2>
              <div
                ref={scrollRef}
                className="flex-1 space-y-2 overflow-y-auto pr-1"
                style={{ maxHeight: '55vh' }}
              >
                {status.transcript.length === 0 ? (
                  <p className="text-sm text-zinc-600">
                    Nothing yet — say “Bruce!” near the microphone, or send him a line below.
                  </p>
                ) : (
                  status.transcript.map((entry, i) => (
                    <TranscriptLine key={`${entry.timestamp}-${i}`} entry={entry} />
                  ))
                )}
              </div>
              <div className="mt-4 border-t border-zinc-800 pt-4">
                <SpeakBox />
              </div>
            </section>
          </div>
        )}
      </main>
    </DashboardShell>
  );
}
