import type { BrewTemperatureRow } from '@checklist/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../../api';
import { clockTime } from '../../util';
import { timeAxis } from '../timeAxis';
import { useBrewSystemLive } from './useBrewSystemLive';
import { VESSELS, type Vessel, formatTemp, formatTimerSeconds } from './vessels';

/**
 * The Overview brew-system card, enlarged: the same readings at a size you can
 * take in from across the brewery, plus the temperature history the card has no
 * room for — the rig's own Temperature Chart page, in this dashboard's shape.
 *
 * Read-only throughout, deliberately. Everything here mirrors the rig; the
 * controls that change it live on the Brew System page (linked in the header),
 * so nothing on the Overview can start a heater or a pump by mis-tap.
 *
 * Pulls in recharts, so it's only ever loaded behind a lazy boundary.
 */

/** Windows offered over the session log, mirroring the rig's window slider. */
const RANGES = [
  { label: '15 min', ms: 15 * 60_000 },
  { label: '1 hour', ms: 60 * 60_000 },
  { label: 'Session', ms: null },
] as const;

/** How often to ask the rig for rows logged since the ones we hold. */
const HISTORY_POLL_MS = 10_000;

/**
 * Cap on plotted rows. The rig logs every 10s and keeps 24h, so a full session
 * can reach ~8,600 rows — far more than the plot has pixels. Thinning by stride
 * (rather than averaging) keeps every plotted point a real reading, and all
 * three traces on one shared time axis; at this cap a full session still keeps
 * a point every ~100s, which no temperature move worth seeing hides inside.
 */
const MAX_PLOT_ROWS = 900;

function thinRows(rows: BrewTemperatureRow[], maxPoints: number): BrewTemperatureRow[] {
  if (rows.length <= maxPoints) return rows;
  const stride = Math.ceil(rows.length / maxPoints);
  const out: BrewTemperatureRow[] = [];
  for (let i = 0; i < rows.length; i += stride) out.push(rows[i]!);
  // Always end on the newest reading, whatever the stride landed on.
  const last = rows[rows.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * The rig's session temperature log, topped up incrementally.
 *
 * The first fetch pulls the whole session; later ones ask only for rows newer
 * than the last we hold (`?since=`), which is what keeps a 10s refresh down to a
 * few hundred bytes over the tunnel. The rig wipes the log when a new brew
 * starts — we'd keep showing the finished one until this view is reopened, which
 * is the trade for not re-pulling the session on every tick (the rig's own chart
 * learns about it over a socket this server doesn't proxy).
 */
function useTemperatureHistory(): { rows: BrewTemperatureRow[]; loading: boolean } {
  const [rows, setRows] = useState<BrewTemperatureRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Read inside the interval without making it a dependency, so the poll isn't
  // torn down and rebuilt on every appended row.
  const lastTsRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const load = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const since = lastTsRef.current;
        const result = await api.getBrewTemperatureHistory(since ?? undefined);
        if (cancelled) return;
        const fresh = (result.rows ?? []).filter((r) => since == null || r.ts > since);
        if (fresh.length > 0) {
          lastTsRef.current = fresh[fresh.length - 1]!.ts;
          setRows((prev) => [...prev, ...fresh]);
        }
      } catch {
        // Keep what's plotted: a blip mid-brew shouldn't blank the chart.
      } finally {
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const timer = setInterval(() => void load(), HISTORY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return { rows, loading };
}

export default function BrewSystemModal({ onClose }: { onClose: () => void }): JSX.Element {
  // The same shared poll the rail card behind this overlay is on — opening the
  // enlarged view joins that request rather than starting a second one.
  const { status, state } = useBrewSystemLive();
  const { rows, loading } = useTemperatureHistory();
  const [rangeMs, setRangeMs] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Partial<Record<Vessel, boolean>>>({});

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // The window is measured back from the newest reading, not from now: a rig
  // that stopped logging an hour ago should still show its last 15 minutes
  // rather than an empty chart.
  const plotted = useMemo(() => {
    if (rows.length === 0) return [];
    const newest = rows[rows.length - 1]!.ts;
    const windowed = rangeMs == null ? rows : rows.filter((r) => r.ts >= newest - rangeMs);
    return thinRows(windowed, MAX_PLOT_ROWS);
  }, [rows, rangeMs]);

  const axis = useMemo(
    () =>
      timeAxis(
        plotted.length > 1
          ? { min: plotted[0]!.ts, max: plotted[plotted.length - 1]!.ts }
          : null,
        6,
      ),
    [plotted],
  );

  const pumps = state?.controlState.pumps;
  const timer = state?.timer;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Brew system"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm"
      />

      <div className="relative z-10 max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/50">
        <div className="sticky top-0 flex items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/95 px-5 py-3.5 backdrop-blur">
          <h2 className="truncate text-base font-semibold tracking-tight text-zinc-50">
            Brew System
          </h2>
          <div className="flex items-center gap-1">
            <Link
              to="/brew-system"
              className="rounded-lg px-2.5 py-1.5 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
            >
              Controls ↗
            </Link>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close brew system"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-lg text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="space-y-5 p-5">
          {status != null && !status.online && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
              {state
                ? "The rig isn't answering — these are the last readings it sent."
                : 'The rig is offline. It reconnects automatically when powered on.'}
            </p>
          )}

          <div className="grid grid-cols-3 gap-3">
            {VESSELS.map((vessel) => {
              const pot = vessel.pot ? state?.controlState.pots[vessel.pot] : undefined;
              return (
                <div
                  key={vessel.key}
                  className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-center"
                >
                  <div
                    className="text-[11px] font-semibold uppercase tracking-wider"
                    style={{ color: vessel.color }}
                  >
                    {vessel.name}
                  </div>
                  <div className="mt-1 text-3xl font-semibold tabular-nums text-zinc-50">
                    {formatTemp(state?.temperatures[vessel.key])}
                    <span className="text-lg text-zinc-500">°</span>
                  </div>
                  {pot ? (
                    <div className="mt-1.5 space-y-0.5 text-xs">
                      <div
                        className={pot.heaterOn ? 'font-semibold text-amber-400' : 'text-zinc-500'}
                      >
                        {pot.heaterOn ? `Heating · ${Math.round(pot.efficiency)}%` : 'Element off'}
                      </div>
                      <div className="text-zinc-500">
                        {pot.regulationEnabled
                          ? `Holding ${formatTemp(pot.sv)}°`
                          : 'Manual'}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-1.5 text-xs text-zinc-600">Sensor only</div>
                  )}
                </div>
              );
            })}
          </div>

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-1">
                {RANGES.map((range) => (
                  <button
                    key={range.label}
                    type="button"
                    onClick={() => setRangeMs(range.ms)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                      rangeMs === range.ms
                        ? 'bg-zinc-800 text-zinc-100'
                        : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'
                    }`}
                  >
                    {range.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-1">
                {VESSELS.map((vessel) => {
                  const on = !hidden[vessel.key];
                  return (
                    <button
                      key={vessel.key}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setHidden((prev) => ({ ...prev, [vessel.key]: !prev[vessel.key] }))
                      }
                      className="rounded-lg border px-2.5 py-1 text-xs font-semibold transition"
                      style={
                        on
                          ? { borderColor: vessel.color, color: vessel.color }
                          : { borderColor: '#3f3f46', color: '#71717a' }
                      }
                    >
                      {vessel.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="h-64 w-full">
              {plotted.length > 1 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={plotted} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                    <CartesianGrid stroke="#334155" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="ts"
                      type="number"
                      scale="time"
                      domain={['dataMin', 'dataMax']}
                      ticks={axis.ticks}
                      tickFormatter={axis.format}
                      minTickGap={40}
                      stroke="#334155"
                      tick={{ fontSize: 12, fill: '#94a3b8' }}
                    />
                    <YAxis
                      width={48}
                      unit="°"
                      stroke="#334155"
                      tick={{ fontSize: 12, fill: '#94a3b8' }}
                      domain={['auto', 'auto']}
                    />
                    <Tooltip
                      contentStyle={{
                        background: '#0f172a',
                        border: '1px solid #334155',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      labelFormatter={(t) => clockTime(Number(t), true)}
                      formatter={(value, name) => [`${formatTemp(Number(value))} °C`, name]}
                    />
                    {VESSELS.filter((v) => !hidden[v.key]).map((vessel) => (
                      <Line
                        key={vessel.key}
                        type="monotone"
                        dataKey={vessel.key}
                        name={vessel.label}
                        stroke={vessel.color}
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                        connectNulls
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-zinc-800 text-sm text-zinc-600">
                  {loading
                    ? 'Loading temperature log…'
                    : 'No temperature log yet — the rig logs one while a brew runs.'}
                </div>
              )}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <PumpRow name="Pump 1" on={pumps?.P1.on ?? false} speed={pumps?.P1.speed ?? 0} />
            <PumpRow name="Pump 2" on={pumps?.P2.on ?? false} speed={pumps?.P2.speed ?? 0} />
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                Timer
              </div>
              <div className="mt-0.5 flex items-baseline gap-2">
                <span className="text-lg font-semibold tabular-nums text-zinc-100">
                  {formatTimerSeconds(timer?.seconds ?? 0)}
                </span>
                <span className="text-xs text-zinc-500">
                  {timer?.running ? 'running' : 'stopped'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One pump's state: a lit dot when it's running, and its duty cycle. */
function PumpRow({ name, on, speed }: { name: string; on: boolean; speed: number }): JSX.Element {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{name}</div>
      <div className="mt-0.5 flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full ${on ? 'bg-sky-400' : 'bg-zinc-700'}`}
          aria-hidden
        />
        <span className="text-lg font-semibold tabular-nums text-zinc-100">
          {on ? `${Math.round(speed)}%` : 'Off'}
        </span>
      </div>
    </div>
  );
}
