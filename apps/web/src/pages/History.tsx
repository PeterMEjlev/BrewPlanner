import type { AuditEntry } from '@checklist/shared';
import { useCallback, useState } from 'react';
import { api } from '../api';
import { DashboardShell } from '../components/DashboardShell';
import { HistoryIcon } from '../components/icons';
import { usePoll } from '../usePoll';
import { relativeTime } from '../util';

const POLL_MS = 15000;

const CHIP_NEUTRAL = 'bg-zinc-700/60 text-zinc-300';

/** A muted accent per change category, used for the row's entity chip. */
const ENTITY_CHIP: Record<string, string> = {
  Checklist: 'bg-sky-500/15 text-sky-300',
  Step: 'bg-sky-500/15 text-sky-300',
  'To-do': 'bg-emerald-500/15 text-emerald-300',
  Recipe: 'bg-violet-500/15 text-violet-300',
  Keg: 'bg-amber-500/15 text-amber-300',
  Settings: CHIP_NEUTRAL,
  Device: 'bg-cyan-500/15 text-cyan-300',
  Account: 'bg-rose-500/15 text-rose-300',
  Other: CHIP_NEUTRAL,
};

function chipClass(entity: string | null): string {
  return ENTITY_CHIP[entity ?? 'Other'] ?? CHIP_NEUTRAL;
}

/**
 * The change-history page: a server-backed audit log of every change made on the
 * server, newest first, with the admin who made it. Admin-only (the server guards
 * `/api/history` with requireAdmin and the sidebar hides the tab from guests).
 */
export function HistoryPage(): JSX.Element {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries(await api.listAudit());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load history');
    }
  }, []);

  usePoll(load, POLL_MS, [load]);

  const list = entries ?? [];

  return (
    <DashboardShell active="history">
      <main className="w-full max-w-[1100px] px-5 py-5">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <HistoryIcon className="h-7 w-7 text-white" />
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-zinc-50">History</h1>
              <p className="mt-0.5 text-sm text-zinc-500">
                Every change made on the server, and who made it.
              </p>
            </div>
          </div>
          {list.length > 0 && (
            <span className="rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-400">
              <span className="font-semibold text-zinc-100">{list.length}</span> recent change
              {list.length === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {error && (
          <div className="mb-5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {entries === null ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-400">
            Loading history…
          </div>
        ) : list.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-900/40 p-8 text-center">
            <p className="font-semibold text-zinc-200">No changes recorded yet</p>
            <p className="mt-2 text-sm text-zinc-500">
              Edits to checklists, kegs, settings, accounts and more will appear here, with the
              admin who made them.
            </p>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {list.map((entry) => (
              <HistoryRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </main>
    </DashboardShell>
  );
}

function HistoryRow({ entry }: { entry: AuditEntry }): JSX.Element {
  const initial = entry.username.trim().charAt(0).toUpperCase() || '?';
  return (
    <li className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-medium text-zinc-100">{entry.action}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
            <span
              className={`rounded px-1.5 py-0.5 font-medium ${chipClass(entry.entity)}`}
            >
              {entry.entity ?? 'Other'}
            </span>
            <span className="flex items-center gap-1.5 text-zinc-400">
              <span
                className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-zinc-700 text-[10px] font-semibold text-zinc-200"
                aria-hidden
              >
                {initial}
              </span>
              <span className="font-medium">{entry.username}</span>
            </span>
            <span title={new Date(entry.createdAt).toLocaleString()}>
              {relativeTime(entry.createdAt)}
            </span>
          </div>
        </div>
      </div>
    </li>
  );
}
