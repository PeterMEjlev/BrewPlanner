import type { AuditEntry, AuditFilters } from '@checklist/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { DashboardShell } from '../components/DashboardShell';
import { Select } from '../components/Select';
import type { SelectOption } from '../components/Select';
import { usePoll } from '../usePoll';
import { dateTime, relativeTime } from '../util';

const POLL_MS = 15000;

const CHIP_NEUTRAL = 'bg-zinc-700/60 text-zinc-300';

/**
 * A muted accent per change category, used for the row's entity chip. Covers
 * every entity the audit rules tag a row with — a category the filter bar can
 * offer but the palette doesn't know would read as "Other" while claiming not
 * to be.
 */
const ENTITY_CHIP: Record<string, string> = {
  Checklist: 'bg-sky-500/15 text-sky-300',
  Step: 'bg-sky-500/15 text-sky-300',
  'To-do': 'bg-emerald-500/15 text-emerald-300',
  Recipe: 'bg-violet-500/15 text-violet-300',
  'Brew session': 'bg-[#f87a68]/20 text-[#f9a094]',
  Keg: 'bg-amber-500/15 text-amber-300',
  Alert: 'bg-red-500/15 text-red-300',
  Settings: CHIP_NEUTRAL,
  Device: 'bg-cyan-500/15 text-cyan-300',
  'Brew system': 'bg-orange-500/15 text-orange-300',
  Bruce: 'bg-fuchsia-500/15 text-fuchsia-300',
  System: 'bg-slate-500/20 text-slate-300',
  Account: 'bg-rose-500/15 text-rose-300',
  Other: CHIP_NEUTRAL,
};

function chipClass(entity: string | null): string {
  return ENTITY_CHIP[entity ?? 'Other'] ?? CHIP_NEUTRAL;
}

/** The windows the log can be narrowed to, as hours back from now. */
const TIME_RANGES = [
  { value: 'all', label: 'All time', hours: null },
  { value: '24h', label: 'Last 24 hours', hours: 24 },
  { value: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { value: '30d', label: 'Last 30 days', hours: 24 * 30 },
  { value: '365d', label: 'Last year', hours: 24 * 365 },
] as const;

type RangeValue = (typeof TIME_RANGES)[number]['value'];

interface Filters {
  range: RangeValue;
  /** Empty string means "anyone" / "any category". */
  username: string;
  entity: string;
}

const NO_FILTERS: Filters = { range: 'all', username: '', entity: '' };

/** The `since` instant a range means, or undefined for "all time". */
function sinceFor(range: RangeValue): string | undefined {
  const hours = TIME_RANGES.find((r) => r.value === range)?.hours;
  if (hours == null) return undefined;
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

const FIELD =
  'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 transition hover:border-zinc-600';

/**
 * The change-history page: a server-backed audit log of every change made on the
 * server, newest first, with the admin who made it. Admin-only (the server guards
 * `/api/history` with requireAdmin and the sidebar hides the tab from guests).
 *
 * The filters go to the server rather than narrowing what's already on screen:
 * the log is read newest-first under a cap, so filtering here would only ever
 * search the most recent page of it (see `auditQuerySchema`).
 */
export function HistoryPage(): JSX.Element {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [options, setOptions] = useState<AuditFilters>({ usernames: [], entities: [] });
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [error, setError] = useState<string | null>(null);

  const { range, username, entity } = filters;

  const load = useCallback(async () => {
    try {
      setEntries(
        await api.listAudit({
          since: sinceFor(range),
          username: username || undefined,
          entity: entity || undefined,
        }),
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load history');
    }
  }, [range, username, entity]);

  usePoll(load, POLL_MS, [load]);

  // The dropdown options come from the whole log, so they're fetched once
  // rather than with every narrowing — and a failure here costs the filters,
  // not the history.
  useEffect(() => {
    void api.listAuditFilters().then(setOptions).catch(() => undefined);
  }, []);

  const list = entries ?? [];
  const activeFilters =
    (range === 'all' ? 0 : 1) + (username ? 1 : 0) + (entity ? 1 : 0);

  const userOptions = useMemo<SelectOption<string>[]>(
    () => [
      { value: '', label: 'Anyone' },
      ...options.usernames.map((name) => ({ value: name, label: name })),
    ],
    [options.usernames],
  );

  const entityOptions = useMemo<SelectOption<string>[]>(
    () => [
      { value: '', label: 'All categories' },
      ...options.entities.map((name) => ({ value: name, label: name })),
    ],
    [options.entities],
  );

  return (
    <DashboardShell active="history">
      <main className="w-full max-w-[1100px] px-5 py-5">
        {/* Time, who, and what — the three questions asked of a change log. */}
        <div className="mb-5 flex flex-wrap items-end gap-3">
          <Field label="When">
            <Select
              value={range}
              options={TIME_RANGES.map((r) => ({ value: r.value, label: r.label }))}
              onChange={(value) => setFilters((f) => ({ ...f, range: value }))}
              className={FIELD}
              aria-label="Filter by time"
            />
          </Field>
          <Field label="Triggered by">
            <Select
              value={username}
              options={userOptions}
              onChange={(value) => setFilters((f) => ({ ...f, username: value }))}
              className={FIELD}
              aria-label="Filter by who made the change"
            />
          </Field>
          <Field label="Category">
            <Select
              value={entity}
              options={entityOptions}
              onChange={(value) => setFilters((f) => ({ ...f, entity: value }))}
              className={FIELD}
              aria-label="Filter by category"
            />
          </Field>
          {activeFilters > 0 && (
            <button
              type="button"
              onClick={() => setFilters(NO_FILTERS)}
              className="rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100"
            >
              Clear filters
            </button>
          )}
          <span className="ml-auto rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-400">
            <span className="font-semibold text-zinc-100">{list.length}</span>
            {activeFilters > 0 ? ' matching' : ' recent'} change{list.length === 1 ? '' : 's'}
          </span>
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
            <p className="font-semibold text-zinc-200">
              {activeFilters > 0 ? 'No changes match these filters' : 'No changes recorded yet'}
            </p>
            <p className="mt-2 text-sm text-zinc-500">
              {activeFilters > 0
                ? 'Try a wider time range, or clear the filters to see everything.'
                : 'Edits to checklists, kegs, settings, accounts and more will appear here, with the admin who made them.'}
            </p>
            {activeFilters > 0 && (
              <button
                type="button"
                onClick={() => setFilters(NO_FILTERS)}
                className="mt-4 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100"
              >
                Clear filters
              </button>
            )}
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

/** A captioned filter control, sized so the three sit as one bar. */
function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="min-w-[150px] flex-1 sm:max-w-[220px]">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      {children}
    </label>
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
            <span title={dateTime(entry.createdAt)}>
              {relativeTime(entry.createdAt)}
            </span>
          </div>
        </div>
      </div>
    </li>
  );
}
