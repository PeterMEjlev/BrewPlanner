import type { Alert, AlertSeverity, AlertSource } from '@checklist/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { DashboardShell } from '../components/DashboardShell';
import { BellIcon } from '../components/icons';
import { relativeTime } from './Dashboard';

const POLL_MS = 15000;

/** Per-severity row styling and accent. */
const SEVERITY: Record<AlertSeverity, { row: string; title: string; dot: string; label: string }> = {
  critical: {
    row: 'border-red-500/30 bg-red-500/10',
    title: 'text-red-300',
    dot: 'bg-red-400',
    label: 'Critical',
  },
  warning: {
    row: 'border-amber-500/30 bg-amber-500/10',
    title: 'text-amber-200',
    dot: 'bg-amber-400',
    label: 'Warning',
  },
  info: {
    row: 'border-sky-500/30 bg-sky-500/10',
    title: 'text-sky-200',
    dot: 'bg-sky-400',
    label: 'Info',
  },
};

const SOURCE_LABEL: Record<AlertSource, string> = {
  device_offline: 'Device offline',
  keg_age: 'Keg age',
  ferment_done: 'Fermentation',
};

/**
 * An alert is active until its condition clears: an offline alert until the
 * device reports again, and one-shot events (keg age, fermentation done) until
 * dismissed. Mirrors the dashboard so both badges agree on the count.
 */
function isActive(a: Alert): boolean {
  return a.resolvedAt == null;
}

/**
 * The alert history page: a server-backed timeline of past alerts (device
 * offline episodes, keg-age and fermentation-complete events), newest first.
 * Unlike the Overview's live "active alerts" widget, this persists across
 * restarts and shows resolved alerts too.
 */
export function AlertsPage(): JSX.Element {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAlerts(await api.listAlerts());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load alerts');
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const list = alerts ?? [];
  const activeCount = list.filter(isActive).length;

  return (
    <DashboardShell active="alerts" alertCount={activeCount}>
      <main className="w-full max-w-[1100px] px-5 py-5">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <BellIcon className="h-7 w-7 text-white" />
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-zinc-50">Alerts</h1>
              <p className="mt-0.5 text-sm text-zinc-500">
                A history of every alert the hub has recorded.
              </p>
            </div>
          </div>
          {list.length > 0 && (
            <span className="rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-400">
              <span className="font-semibold text-zinc-100">{activeCount}</span> active ·{' '}
              {list.length} total
            </span>
          )}
        </div>

        {error && (
          <div className="mb-5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {alerts === null ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-400">
            Loading alerts…
          </div>
        ) : list.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-900/40 p-8 text-center">
            <p className="flex items-center justify-center gap-2 font-semibold text-zinc-200">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" aria-hidden />
              No alerts recorded
            </p>
            <p className="mt-2 text-sm text-zinc-500">
              Device outages, ageing kegs and finished fermentations will appear here.
            </p>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {list.map((a) => (
              <AlertRow key={a.id} alert={a} />
            ))}
          </ul>
        )}
      </main>
    </DashboardShell>
  );
}

function AlertRow({ alert }: { alert: Alert }): JSX.Element {
  const look = SEVERITY[alert.severity];
  const active = isActive(alert);
  return (
    <li className={`rounded-xl border px-4 py-3 ${look.row}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className={`flex items-center gap-2 font-semibold ${look.title}`}>
            <span className={`h-2 w-2 shrink-0 rounded-full ${look.dot}`} aria-hidden />
            <span className="truncate">{alert.title}</span>
          </p>
          <p className="mt-1 text-sm text-zinc-400">{alert.detail}</p>
        </div>
        <StatusPill active={active} resolved={alert.source === 'device_offline' && !active} />
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
        <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 font-medium text-zinc-400">
          {SOURCE_LABEL[alert.source]}
        </span>
        <span title={new Date(alert.createdAt).toLocaleString()}>
          {relativeTime(alert.createdAt)}
        </span>
        {alert.resolvedAt && (
          <span className="text-zinc-600" title={new Date(alert.resolvedAt).toLocaleString()}>
            · resolved {relativeTime(alert.resolvedAt)}
          </span>
        )}
      </div>
    </li>
  );
}

/** Right-aligned state chip: ongoing outages get "Active", cleared ones "Resolved". */
function StatusPill({ active, resolved }: { active: boolean; resolved: boolean }): JSX.Element | null {
  if (active) {
    return (
      <span className="shrink-0 rounded-lg bg-red-500/20 px-2 py-0.5 text-xs font-semibold text-red-300">
        Active
      </span>
    );
  }
  if (resolved) {
    return (
      <span className="shrink-0 rounded-lg bg-zinc-800 px-2 py-0.5 text-xs font-semibold text-zinc-400">
        Resolved
      </span>
    );
  }
  return null;
}
