import type { DeviceStatus, DeviceType, LatestReading } from '@checklist/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';

/** Refresh device status often enough to feel live without hammering the Pi. */
const POLL_MS = 10000;

const TYPE_ICON: Record<DeviceType, string> = {
  pressure_sensor: '📈',
  brew_controller: '🎛️',
  power_meter: '⚡',
  water_meter: '🚰',
  hydrometer: '🍷',
  other: '📡',
};

/**
 * Sensors on the roadmap but not yet wired to hardware. Each renders a dimmed
 * "Planned" placeholder tile so the dashboard already shows the intended layout.
 * A placeholder disappears automatically once a device that covers it starts
 * reporting (matched by `covered`); the agent scaffolds that will feed them live
 * data are under deploy/agents/.
 */
interface PlannedSensor {
  icon: string;
  title: string;
  subtitle: string;
  /** True once a connected device makes this placeholder redundant. */
  covered: (devices: DeviceStatus[]) => boolean;
}

const hasType = (devices: DeviceStatus[], type: DeviceType): boolean =>
  devices.some((d) => d.type === type);

const PLANNED_SENSORS: PlannedSensor[] = [
  {
    icon: TYPE_ICON.power_meter,
    title: 'Electricity',
    subtitle: 'Power & energy usage (W · kWh)',
    covered: (d) => hasType(d, 'power_meter'),
  },
  {
    icon: TYPE_ICON.water_meter,
    title: 'Water',
    subtitle: 'Flow & total usage (L/min · L)',
    covered: (d) => hasType(d, 'water_meter'),
  },
  {
    icon: '🌡️',
    title: 'Brewery Temperature',
    subtitle: 'Ambient °C (Inkbird ITC-308)',
    // Reuses the brew_controller type, so match the ambient unit by name —
    // otherwise the fermenter controller would hide this placeholder.
    covered: (d) =>
      d.some((x) => x.type === 'brew_controller' && /brewery|ambient/i.test(x.name)),
  },
  {
    icon: TYPE_ICON.hydrometer,
    title: 'Fermentation Gravity',
    subtitle: 'Specific gravity (Tilt)',
    covered: (d) => hasType(d, 'hydrometer'),
  },
];

/**
 * The hub landing page — the front door at `/`. It links to the BrewPlanner
 * apps (checklist, to-do) and shows a live tile per telemetry device. New
 * devices appear automatically once they start pushing to /api/ingest.
 */
export function DashboardPage(): JSX.Element {
  const { auth, refresh: refreshAuth } = useAuth();
  const [devices, setDevices] = useState<DeviceStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDevices(await api.listDevices());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load devices');
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="min-h-full bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-zinc-800 bg-zinc-950/80 px-6 py-4 backdrop-blur">
        <div className="flex items-center gap-3">
          <span className="text-2xl" aria-hidden>
            🍺
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Konfus Brewing</h1>
            <p className="text-xs text-zinc-400">Brewery dashboard</p>
          </div>
        </div>
        {auth.user && (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-zinc-400">
              <span className="font-medium text-zinc-200">{auth.user.username}</span>
            </span>
            <button
              type="button"
              onClick={async () => {
                await api.logout();
                await refreshAuth();
              }}
              className="rounded-lg px-2.5 py-1 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
            >
              Sign out
            </button>
          </div>
        )}
      </header>

      <main className="mx-auto max-w-5xl p-6">
        {error && (
          <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Apps
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <AppTile to="/admin" icon="✅" title="Brew Checklist" subtitle="Procedures & runs" />
          <AppTile to="/todos" icon="🍺" title="Brewery To-Do" subtitle="Ad-hoc task list" />
        </div>

        <h2 className="mb-3 mt-8 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Sensors & equipment
        </h2>
        {devices === null ? (
          <p className="text-sm text-zinc-400">Loading…</p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {devices.map((d) => (
                <DeviceTile key={d.id} device={d} />
              ))}
              {PLANNED_SENSORS.filter((p) => !p.covered(devices)).map((p) => (
                <PlannedTile key={p.title} sensor={p} />
              ))}
            </div>
            {devices.length === 0 && (
              <p className="mt-3 text-xs text-zinc-500">
                No live devices yet — the tiles above are planned sensors. Register one on the
                Pi with{' '}
                <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
                  npm run device -- add "Fermenter 1" pressure_sensor
                </code>{' '}
                and point its agent at this server.
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function AppTile({
  to,
  icon,
  title,
  subtitle,
}: {
  to: string;
  icon: string;
  title: string;
  subtitle: string;
}): JSX.Element {
  return (
    <Link
      to={to}
      className="group flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-5 transition hover:border-zinc-700 hover:bg-zinc-800/60"
    >
      <span className="text-3xl transition group-hover:scale-105" aria-hidden>
        {icon}
      </span>
      <span>
        <span className="block font-semibold text-zinc-100">{title}</span>
        <span className="block text-sm text-zinc-400">{subtitle}</span>
      </span>
    </Link>
  );
}

function DeviceTile({ device }: { device: DeviceStatus }): JSX.Element {
  return (
    <Link
      to={`/devices/${device.id}`}
      className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-5 transition hover:border-zinc-700 hover:bg-zinc-800/60"
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl" aria-hidden>
            {TYPE_ICON[device.type]}
          </span>
          <span className="font-semibold text-zinc-100">{device.name}</span>
        </div>
        <StatusBadge online={device.online} />
      </div>

      {device.latest.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {device.latest.map((r) =>
            isStateMetric(r.metric) ? (
              <StateBadge key={r.metric} value={r.value} />
            ) : (
              <div key={r.metric}>
                <span className="text-2xl font-semibold tabular-nums text-zinc-50">
                  {formatValue(r)}
                </span>
                <span className="ml-1 text-sm text-zinc-400">{metricLabel(r.metric)}</span>
              </div>
            ),
          )}
        </div>
      ) : (
        <p className="text-sm text-zinc-500">No readings yet.</p>
      )}

      <p className="text-xs text-zinc-500">
        {device.lastSeenAt ? `Updated ${relativeTime(device.lastSeenAt)}` : 'Never reported'}
      </p>
    </Link>
  );
}

/** Dimmed, non-interactive tile for a planned-but-not-yet-connected sensor. */
function PlannedTile({ sensor }: { sensor: PlannedSensor }): JSX.Element {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-dashed border-zinc-700 bg-zinc-900/40 p-5">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl opacity-60" aria-hidden>
            {sensor.icon}
          </span>
          <span className="font-semibold text-zinc-300">{sensor.title}</span>
        </div>
        <span className="inline-flex items-center rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-semibold text-zinc-400">
          Planned
        </span>
      </div>
      <p className="text-sm text-zinc-500">{sensor.subtitle}</p>
      <p className="text-xs text-zinc-600">Not connected yet</p>
    </div>
  );
}

function StatusBadge({ online }: { online: boolean }): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${
        online ? 'bg-emerald-500/15 text-emerald-400' : 'bg-zinc-800 text-zinc-400'
      }`}
    >
      <span
        className={`h-2 w-2 rounded-full ${
          online ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]' : 'bg-zinc-500'
        }`}
        aria-hidden
      />
      {online ? 'Online' : 'Offline'}
    </span>
  );
}

// --- formatting helpers -----------------------------------------------------

/** Known metric-name suffixes → display unit. */
const UNITS: Record<string, string> = {
  bar: 'bar',
  psi: 'psi',
  kpa: 'kPa',
  c: '°C',
  f: '°F',
  pct: '%',
  v: 'V',
  w: 'W',
  kwh: 'kWh',
  lpm: 'L/min',
  l: 'L',
};

/**
 * Specific gravity is dimensionless (e.g. 1.050) and conventionally shown to
 * three decimals with no unit — special-cased rather than driven by the suffix
 * table so it never picks up a stray "sg" unit or the generic 2-decimal format.
 */
function isGravityMetric(metric: string): boolean {
  return metric === 'gravity_sg' || metric.endsWith('_sg');
}

function splitMetric(metric: string): { label: string; unit: string | null } {
  if (isGravityMetric(metric)) return { label: 'Gravity', unit: null };
  const parts = metric.split('_');
  const last = parts[parts.length - 1]?.toLowerCase() ?? '';
  if (parts.length > 1 && UNITS[last]) {
    const label = parts.slice(0, -1).join(' ');
    return { label: capitalize(label), unit: UNITS[last]! };
  }
  return { label: capitalize(metric.replace(/_/g, ' ')), unit: null };
}

export function metricLabel(metric: string): string {
  return splitMetric(metric).label;
}

export function formatValue(r: LatestReading): string {
  if (isStateMetric(r.metric)) return stateLook(r.value).label;
  // Gravity reads like 1.050 — keep three decimals and no unit.
  if (isGravityMetric(r.metric)) return r.value.toFixed(3);
  const { unit } = splitMetric(r.metric);
  const n = Math.abs(r.value) >= 100 ? r.value.toFixed(0) : r.value.toFixed(2);
  return unit ? `${n} ${unit}` : n;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- HVAC state metric (cooling / idle / heating) ---------------------------

/**
 * Tri-state metrics rendered as a single labelled status pill instead of a raw
 * number. Today that's `hvac_state` from the fridge/heater controller, encoded
 * -1 = cooling, 0 = idle, +1 = heating. A dual-stage controller drives only one
 * relay at a time, so it's one indicator — never both at once.
 */
export function isStateMetric(metric: string): boolean {
  return metric === 'hvac_state';
}

interface StateLook {
  label: string;
  icon: string;
  /** Tailwind classes for the pill: background + text + ring. */
  cls: string;
}

/** Display for an hvac_state value: cooling (<0), heating (>0), idle (≈0). */
function stateLook(value: number): StateLook {
  if (value <= -0.5)
    return { label: 'Cooling', icon: '❄️', cls: 'bg-sky-500/15 text-sky-300 ring-sky-500/40' };
  if (value >= 0.5)
    return { label: 'Heating', icon: '🔥', cls: 'bg-amber-500/15 text-amber-400 ring-amber-500/40' };
  return { label: 'Idle', icon: '⏸️', cls: 'bg-zinc-800/60 text-zinc-400 ring-zinc-700/60' };
}

/** Short axis-tick label for an hvac_state value. */
export function stateTick(value: number): string {
  return value <= -0.5 ? 'Cool' : value >= 0.5 ? 'Heat' : 'Idle';
}

/** Chart stroke per metric — violet for the hvac state track, blue otherwise. */
export function metricColor(metric: string): string {
  return metric === 'hvac_state' ? '#a78bfa' : '#3b82f6';
}

/**
 * A single colored status pill for the controller's hvac_state, mirroring the
 * Inkbird app: blue snowflake when cooling, amber flame when heating, dimmed
 * grey when idle. Only the active mode is ever shown.
 */
export function StateBadge({
  value,
  size = 'sm',
}: {
  value: number;
  size?: 'sm' | 'lg';
}): JSX.Element {
  const look = stateLook(value);
  const sizing = size === 'lg' ? 'gap-2 px-4 py-2 text-2xl' : 'gap-1.5 px-2.5 py-1 text-sm';
  return (
    <span
      className={`inline-flex items-center rounded-full font-semibold ring-1 transition ${sizing} ${look.cls}`}
    >
      <span aria-hidden>{look.icon}</span>
      <span>{look.label}</span>
    </span>
  );
}

/** Compact "x ago" string for a recent ISO timestamp. */
export function relativeTime(iso: string): string {
  const diffMs = Date.now() - Date.parse(iso);
  const sec = Math.max(0, Math.round(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}
