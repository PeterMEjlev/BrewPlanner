import type { ActiveState, DeviceStatus, DeviceType, Todo } from '@checklist/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { formatValue, metricLabel, relativeTime } from './Dashboard';

/** Refresh cadence for the wall display — frequent enough to feel live. */
const POLL_MS = 5000;

const TYPE_ICON: Record<DeviceType, string> = {
  pressure_sensor: '📈',
  brew_controller: '🎛️',
  power_meter: '⚡',
  water_meter: '🚰',
  hydrometer: '🍷',
  other: '📡',
};

/**
 * Touch-first hub home for the Pi's 10" screen. Big tap targets, no hover
 * states, a fluid tile grid that reflows for landscape or portrait. Tiles link
 * out to the existing touch checklist/to-do (/display) and the touch sensor
 * view (/kiosk/devices/:id).
 */
export function KioskHomePage(): JSX.Element {
  const [active, setActive] = useState<ActiveState | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [devices, setDevices] = useState<DeviceStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    try {
      const [a, t, d] = await Promise.all([
        api.getActive(),
        api.listTodos(),
        api.listDevices(),
      ]);
      setActive(a);
      setTodos(t);
      setDevices(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Wall-clock, updated every second.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const openTodos = todos.filter((t) => !t.done).length;

  return (
    <div className="touch-none-select flex h-full flex-col bg-slate-900 text-white">
      <header className="flex items-center justify-between gap-4 border-b border-slate-700 px-6 py-4">
        <div className="flex items-center gap-3">
          <span className="text-3xl" aria-hidden>
            🍺
          </span>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Konfus Brewing</h1>
        </div>
        <div className="text-right leading-tight">
          <div className="text-3xl font-semibold tabular-nums sm:text-4xl">
            {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
          <div className="text-sm text-slate-400">
            {now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
          </div>
        </div>
      </header>

      {error && (
        <div className="bg-red-900/40 px-6 py-2 text-center text-lg text-red-300">{error}</div>
      )}

      <main className="flex-1 overflow-y-auto p-5 sm:p-6">
        <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(15rem,1fr))]">
          {/* Checklist */}
          <Tile to="/display" icon="✅" label="Checklist">
            {active?.checklist ? (
              <div className="flex items-end justify-between gap-3">
                <span className="min-w-0 truncate text-2xl font-medium text-slate-200">
                  {active.checklist.name}
                </span>
                <span
                  className={`shrink-0 rounded-xl px-4 py-1 text-3xl font-bold tabular-nums ${
                    active.progress.total > 0 &&
                    active.progress.completed === active.progress.total
                      ? 'bg-green-600'
                      : 'bg-slate-700'
                  }`}
                >
                  {active.progress.completed}/{active.progress.total}
                </span>
              </div>
            ) : (
              <span className="text-2xl text-slate-400">No active checklist</span>
            )}
          </Tile>

          {/* Brewery To-Do */}
          <Tile to="/kiosk/todos" icon="🍺" label="Brewery To-Do">
            {openTodos > 0 ? (
              <span className="text-3xl font-bold">
                {openTodos} <span className="text-2xl font-normal text-slate-400">open</span>
              </span>
            ) : (
              <span className="text-2xl text-slate-400">All clear</span>
            )}
          </Tile>

          {/* Sensors */}
          {devices.map((d) => {
            const latest = d.latest[0];
            return (
              <Tile key={d.id} to={`/kiosk/devices/${d.id}`} icon={TYPE_ICON[d.type]} label={d.name}>
                <div className="flex items-end justify-between gap-3">
                  {latest ? (
                    <span className="text-4xl font-bold tabular-nums sm:text-5xl">
                      {formatValue(latest)}
                      <span className="ml-1 align-baseline text-xl font-normal text-slate-400">
                        {metricLabel(latest.metric)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-2xl text-slate-400">No readings</span>
                  )}
                  <OnlineDot online={d.online} />
                </div>
                <span className="mt-1 block text-sm text-slate-500">
                  {d.lastSeenAt ? `Updated ${relativeTime(d.lastSeenAt)}` : 'Never reported'}
                </span>
              </Tile>
            );
          })}
        </div>
      </main>
    </div>
  );
}

function Tile({
  to,
  icon,
  label,
  children,
}: {
  to: string;
  icon: string;
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Link
      to={to}
      className="flex min-h-[9rem] touch-manipulation flex-col justify-between rounded-2xl border-2 border-slate-700 bg-slate-800 p-5 transition active:scale-[0.98] active:bg-slate-700 sm:p-6"
    >
      <div className="flex items-center gap-3">
        <span className="text-3xl" aria-hidden>
          {icon}
        </span>
        <span className="text-xl font-semibold text-slate-200 sm:text-2xl">{label}</span>
      </div>
      <div className="mt-3">{children}</div>
    </Link>
  );
}

function OnlineDot({ online }: { online: boolean }): JSX.Element {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-2 rounded-full px-3 py-1 text-base font-semibold ${
        online ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-700 text-slate-400'
      }`}
    >
      <span
        className={`h-2.5 w-2.5 rounded-full ${
          online ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]' : 'bg-slate-500'
        }`}
        aria-hidden
      />
      {online ? 'Online' : 'Offline'}
    </span>
  );
}
