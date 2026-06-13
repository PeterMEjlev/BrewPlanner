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
 * Touch-first hub home for the Pi's 7" screen. Everything has to be visible at
 * a glance with no scrolling, so there is no header chrome: the tile grid fills
 * the whole viewport and its rows divide the available height evenly
 * (auto-rows-fr) however many sensors are present. Tiles link out to the touch
 * checklist/to-do (/display) and the touch sensor view (/kiosk/devices/:id).
 */
export function KioskHomePage(): JSX.Element {
  const [active, setActive] = useState<ActiveState | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [devices, setDevices] = useState<DeviceStatus[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  const openTodos = todos.filter((t) => !t.done).length;

  return (
    <div className="touch-none-select flex h-full flex-col overflow-hidden bg-slate-900 text-white">
      {error && (
        <div className="shrink-0 bg-red-900/40 px-4 py-1 text-center text-sm text-red-300">
          {error}
        </div>
      )}

      <main className="min-h-0 flex-1 p-2">
        <div className="grid h-full auto-rows-fr gap-2 [grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))]">
          {/* Checklist */}
          <Tile to="/display" icon="✅" label="Checklist">
            {active?.checklist ? (
              <div className="flex items-end justify-between gap-2">
                <span className="min-w-0 truncate text-base font-medium text-slate-200">
                  {active.checklist.name}
                </span>
                <span
                  className={`shrink-0 rounded-lg px-2.5 py-0.5 text-xl font-bold tabular-nums ${
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
              <span className="text-base text-slate-400">No active checklist</span>
            )}
          </Tile>

          {/* Brewery To-Do */}
          <Tile to="/kiosk/todos" icon="🍺" label="Brewery To-Do">
            {openTodos > 0 ? (
              <span className="text-2xl font-bold">
                {openTodos} <span className="text-base font-normal text-slate-400">open</span>
              </span>
            ) : (
              <span className="text-base text-slate-400">All clear</span>
            )}
          </Tile>

          {/* Sensors */}
          {devices.map((d) => {
            const latest = d.latest[0];
            return (
              <Tile key={d.id} to={`/kiosk/devices/${d.id}`} icon={TYPE_ICON[d.type]} label={d.name}>
                <div className="flex items-end justify-between gap-2">
                  {latest ? (
                    <span className="text-3xl font-bold tabular-nums">
                      {formatValue(latest)}
                      <span className="ml-1 align-baseline text-sm font-normal text-slate-400">
                        {metricLabel(latest.metric)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-base text-slate-400">No readings</span>
                  )}
                  <OnlineDot online={d.online} />
                </div>
                <span className="mt-0.5 block text-xs text-slate-500">
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
      className="flex min-h-0 touch-manipulation flex-col justify-between overflow-hidden rounded-xl border border-slate-700 bg-slate-800 p-3 transition active:scale-[0.98] active:bg-slate-700"
    >
      <div className="flex items-center gap-2">
        <span className="text-xl" aria-hidden>
          {icon}
        </span>
        <span className="min-w-0 truncate text-base font-semibold text-slate-200">{label}</span>
      </div>
      <div className="mt-1">{children}</div>
    </Link>
  );
}

function OnlineDot({ online }: { online: boolean }): JSX.Element {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${
        online ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-700 text-slate-400'
      }`}
    >
      <span
        className={`h-2 w-2 rounded-full ${
          online ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]' : 'bg-slate-500'
        }`}
        aria-hidden
      />
      {online ? 'Online' : 'Offline'}
    </span>
  );
}
