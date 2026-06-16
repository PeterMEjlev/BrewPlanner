import type { DeviceStatus, Reading } from '@checklist/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api';
import { SetpointControl } from '../SetpointControl';
import { RANGES, formatTick } from '../useDeviceData';

const POLL_MS = 10000;
const DEFAULT_RANGE_MS = RANGES[2].ms; // 24h

type SeriesKey = 'beer' | 'fridge';

/**
 * The two temperature lines this page can plot. Each maps to a query-param
 * carrying its source device id (the kiosk fermenter card passes both); the
 * `temp_c` metric is read from whichever devices are supplied.
 */
const SERIES_DEFS: { key: SeriesKey; label: string; color: string; param: string }[] = [
  { key: 'beer', label: 'Beer', color: '#fb923c', param: 'beer' }, // amber / orange
  { key: 'fridge', label: 'Fridge', color: '#d97706', param: 'fridge' }, // muted amber / orange
];

interface Source {
  key: SeriesKey;
  label: string;
  color: string;
  deviceId: number;
}

interface ChartRow {
  t: number;
  beer?: number;
  fridge?: number;
}

function SensorStatusPill({
  source,
  device,
}: {
  source: Source;
  device: DeviceStatus | undefined;
}): JSX.Element {
  const online = device?.online === true;
  const known = device != null;

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-base font-semibold ${
        !known
          ? 'bg-zinc-800 text-zinc-400'
          : online
            ? 'bg-emerald-500/15 text-emerald-300'
            : 'bg-zinc-700 text-zinc-400'
      }`}
    >
      <span className="flex items-center gap-1.5 text-zinc-400">
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: source.color }}
          aria-hidden
        />
        {source.label}
      </span>
      <span
        className={`h-2.5 w-2.5 rounded-full ${
          !known
            ? 'bg-zinc-500'
            : online
              ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]'
              : 'bg-zinc-500'
        }`}
        aria-hidden
      />
      {known ? (online ? 'Online' : 'Offline') : 'Checking'}
    </span>
  );
}

/**
 * Combined fermenter temperature view for the Pi: the beer (Tilt) and fridge
 * (Inkbird) temperatures overlaid on a single chart instead of two separate
 * device pages. A touch-friendly legend toggles each line in and out. Source
 * device ids arrive as `?beer=<id>&fridge=<id>` from the fermenter card.
 */
export function TemperaturePage(): JSX.Element {
  const [params] = useSearchParams();
  const [rangeMs, setRangeMs] = useState<number>(DEFAULT_RANGE_MS);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [devices, setDevices] = useState<Record<string, DeviceStatus>>({});
  const [histories, setHistories] = useState<Record<string, Reading[]>>({});
  const [error, setError] = useState<string | null>(null);

  // Which lines to plot, derived from the supplied device-id params.
  const sources = useMemo<Source[]>(
    () =>
      SERIES_DEFS.flatMap((s) => {
        const v = params.get(s.param);
        return v ? [{ key: s.key, label: s.label, color: s.color, deviceId: Number(v) }] : [];
      }),
    [params],
  );

  const load = useCallback(async () => {
    if (sources.length === 0) return;
    try {
      const since = new Date(Date.now() - rangeMs).toISOString();
      const results = await Promise.all(
        sources.map(async (s) => ({
          key: s.key,
          device: await api.getDevice(s.deviceId),
          history: await api.getDeviceHistory(s.deviceId, {
            metric: 'temp_c',
            since,
            limit: 5000,
          }),
        })),
      );
      setDevices(Object.fromEntries(results.map((r) => [r.key, r.device])));
      setHistories(Object.fromEntries(results.map((r) => [r.key, r.history])));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load temperatures');
    }
  }, [sources, rangeMs]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Merge the per-device histories onto a shared time axis. The Tilt and Inkbird
  // report on their own schedules, so most rows carry just one value; the lines
  // bridge the gaps with connectNulls.
  const chartData = useMemo<ChartRow[]>(() => {
    const byT = new Map<number, ChartRow>();
    for (const s of sources) {
      for (const r of histories[s.key] ?? []) {
        const t = Date.parse(r.recordedAt);
        const row = byT.get(t) ?? { t };
        row[s.key] = r.value;
        byT.set(t, row);
      }
    }
    return [...byT.values()].sort((a, b) => a.t - b.t);
  }, [sources, histories]);

  const longRange = rangeMs > 24 * 60 * 60 * 1000;

  function toggle(key: SeriesKey): void {
    setHidden((h) => ({ ...h, [key]: !h[key] }));
  }

  function latestValue(key: SeriesKey): number | null {
    const r = devices[key]?.latest.find((x) => x.metric === 'temp_c');
    return r ? r.value : null;
  }

  // The fridge line is the Inkbird controller, so its target temperature can be
  // changed here — the brewer adjusts the fermenter setpoint without leaving the
  // combined chart.
  const fridgeSource = sources.find((s) => s.key === 'fridge');
  const fridgeDevice = devices.fridge;
  const fridgeSetpoint = fridgeDevice?.latest.find((r) => r.metric === 'setpoint_c');
  const fridgeSupportsSetpoint = !!fridgeSource && fridgeDevice?.type === 'brew_controller';

  return (
    <div className="touch-none-select flex h-full flex-col bg-zinc-900 text-white">
      <header className="flex items-center gap-4 border-b border-zinc-700 px-5 py-3 sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <Link
            to="/kiosk"
            className="shrink-0 rounded-xl bg-zinc-700 px-5 py-3 text-2xl font-semibold active:bg-zinc-600"
            aria-label="Back to home"
          >
            ←
          </Link>
          <h1 className="min-w-0 truncate text-3xl font-bold tracking-tight sm:text-4xl">
            Temperature
          </h1>
        </div>
        {fridgeSource && fridgeSupportsSetpoint && (
          <SetpointControl
            deviceId={fridgeSource.deviceId}
            setpointC={fridgeSetpoint?.value ?? null}
            pendingC={fridgeDevice?.pendingSetpointC ?? null}
            onApplied={load}
            variant="header"
          />
        )}
      </header>

      {error && (
        <div className="bg-red-900/40 px-6 py-2 text-center text-lg text-red-300">{error}</div>
      )}

      <main className="flex flex-1 flex-col gap-4 overflow-hidden p-5 sm:p-6">
        {/* Current values, one per source, coloured to match its line. */}
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
          {sources.map((s) => {
            const v = latestValue(s.key);
            return (
              <span key={s.key} className="flex items-baseline gap-2">
                <span className="text-2xl text-zinc-400">{s.label}</span>
                <span
                  className="text-5xl font-bold tabular-nums sm:text-6xl"
                  style={{ color: s.color }}
                >
                  {v == null ? '—' : `${v.toFixed(1)}°`}
                </span>
              </span>
            );
          })}
          {sources.length > 0 && (
            <div className="ml-auto flex shrink-0 flex-col items-end gap-2">
              {sources.map((s) => (
                <SensorStatusPill key={s.key} source={s} device={devices[s.key]} />
              ))}
            </div>
          )}
        </div>

        {/* Legend toggles (left) + range selectors (right). Tapping a legend chip
            shows/hides that line in the chart. */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-2">
            {sources.map((s) => {
              const off = !!hidden[s.key];
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => toggle(s.key)}
                  aria-pressed={!off}
                  className={`flex items-center gap-2.5 rounded-xl px-5 py-3 text-xl font-semibold transition active:scale-[0.98] ${
                    off ? 'bg-zinc-800 text-zinc-500' : 'bg-zinc-700 text-white active:bg-zinc-600'
                  }`}
                >
                  <span
                    className="h-3.5 w-3.5 rounded-full"
                    style={{ backgroundColor: off ? '#52525b' : s.color }}
                    aria-hidden
                  />
                  <span className={off ? 'line-through' : ''}>{s.label}</span>
                </button>
              );
            })}
          </div>
          <div className="ml-auto flex gap-2">
            {RANGES.map((r) => (
              <button
                key={r.label}
                type="button"
                onClick={() => setRangeMs(r.ms)}
                className={`rounded-xl px-5 py-3 text-xl font-semibold active:scale-[0.98] ${
                  r.ms === rangeMs ? 'bg-blue-600' : 'bg-zinc-700 active:bg-zinc-600'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* Chart fills the rest of the screen. */}
        <div className="min-h-0 flex-1 rounded-2xl border-2 border-zinc-700 bg-zinc-800 p-3">
          {sources.length === 0 ? (
            <div className="flex h-full items-center justify-center text-2xl text-zinc-400">
              No temperature sensors.
            </div>
          ) : chartData.length === 0 ? (
            <div className="flex h-full items-center justify-center text-2xl text-zinc-400">
              No readings in this range.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  scale="time"
                  tickFormatter={(t) => formatTick(t, longRange)}
                  tick={{ fontSize: 14, fill: '#94a3b8' }}
                  stroke="#334155"
                  minTickGap={48}
                />
                <YAxis
                  width={52}
                  tick={{ fontSize: 14, fill: '#94a3b8' }}
                  stroke="#334155"
                  domain={['auto', 'auto']}
                  tickFormatter={(v) => `${Math.round(v)}°`}
                />
                <Tooltip
                  contentStyle={{
                    background: '#0f172a',
                    border: '1px solid #1e293b',
                    borderRadius: 10,
                    color: '#e2e8f0',
                    fontSize: 16,
                  }}
                  labelStyle={{ color: '#94a3b8' }}
                  itemStyle={{ color: '#e2e8f0' }}
                  cursor={{ stroke: '#334155' }}
                  labelFormatter={(t) => new Date(t as number).toLocaleString()}
                  formatter={(value, name) => {
                    const num = typeof value === 'number' ? value : Number(value);
                    return [`${num.toFixed(1)} °C`, name];
                  }}
                />
                {sources.map((s) => (
                  <Line
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.label}
                    stroke={s.color}
                    strokeWidth={3}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                    hide={!!hidden[s.key]}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </main>
    </div>
  );
}
