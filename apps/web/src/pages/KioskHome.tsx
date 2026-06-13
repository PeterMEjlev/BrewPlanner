import type {
  ActiveState,
  DeviceStatus,
  DeviceType,
  LatestReading,
  Todo,
} from '@checklist/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { formatValue, metricLabel, relativeTime } from './Dashboard';

/** Refresh cadence for the wall display — frequent enough to feel live. */
const POLL_MS = 5000;

const TYPE_ICON: Record<DeviceType, string> = {
  pressure_sensor: '📈',
  brew_controller: '🌡️',
  power_meter: '⚡',
  water_meter: '🚰',
  hydrometer: '🍷',
  other: '📡',
};

/**
 * Per-type icon tint. Gives each sensor a distinct colour at a glance without
 * colouring the reading itself (numbers stay white for max legibility).
 */
const TYPE_ACCENT: Record<DeviceType, string> = {
  pressure_sensor: 'bg-indigo-500/15 text-indigo-300',
  brew_controller: 'bg-amber-500/15 text-amber-300',
  power_meter: 'bg-yellow-500/15 text-yellow-300',
  water_meter: 'bg-cyan-500/15 text-cyan-300',
  hydrometer: 'bg-fuchsia-500/15 text-fuchsia-300',
  other: 'bg-slate-600/30 text-slate-300',
};

/**
 * Sensors the operator actually watches during a brew (fermentation pressure,
 * fridge/ambient temperature, gravity) get the large hero tiles; the "nice to
 * have" utility meters (power, water) drop to a slim secondary strip. Within a
 * tier, devices (and name-groups) are ordered by this rank so the fermenter
 * sits first.
 */
const TYPE_RANK: Record<DeviceType, number> = {
  pressure_sensor: 0,
  hydrometer: 1,
  brew_controller: 2,
  other: 3,
  power_meter: 4,
  water_meter: 5,
};

const SECONDARY_TYPES = new Set<DeviceType>(['power_meter', 'water_meter']);

/**
 * Which metric headlines a single-device tile when several are reported.
 * Pressure / temp / gravity / flow read as the "main number"; controller extras
 * like setpoint and the cooling/heating state fall to the small chips below.
 */
const HEADLINE_ORDER = [
  'pressure_bar',
  'temp_c',
  'gravity_sg',
  'power_w',
  'flow_lpm',
  'water_l',
  'energy_kwh',
];

function metricRank(metric: string): number {
  const i = HEADLINE_ORDER.indexOf(metric);
  return i === -1 ? HEADLINE_ORDER.length : i;
}

/** Latest readings ordered so the headline metric is first. */
function orderedMetrics(latest: LatestReading[]): LatestReading[] {
  return [...latest].sort((a, b) => metricRank(a.metric) - metricRank(b.metric));
}

/**
 * A "station" is a logical piece of equipment built from several physical
 * devices that share a name — e.g. the fermenter combines its pressure sensor,
 * fridge controller (Inkbird) and floating hydrometer (Tilt) into one card so
 * pressure, both temperatures and gravity sit together. Group devices by name
 * and only the multi-device groups render as a station; a lone device keeps its
 * own single-metric tile.
 */
function groupByName(devices: DeviceStatus[]): DeviceStatus[][] {
  const groups = new Map<string, DeviceStatus[]>();
  for (const d of devices) {
    const g = groups.get(d.name);
    if (g) g.push(d);
    else groups.set(d.name, [d]);
  }
  return [...groups.values()];
}

/** A group sorts by its most important member (fermenter first). */
function groupRank(group: DeviceStatus[]): number {
  return Math.min(...group.map((d) => TYPE_RANK[d.type]));
}

/**
 * One reading on a station card. The label is source-aware so the two `temp_c`
 * readings (fridge from the controller, beer from the Tilt) don't collide.
 */
interface Stat {
  key: string;
  deviceId: number;
  label: string;
  reading: LatestReading;
  /** Extra detail under the value (fridge setpoint + cooling/heating state). */
  sub: JSX.Element | null;
}

/** Fixed left-to-right order for the fermenter's readings. */
const STAT_ORDER = ['Pressure', 'Temp (Fridge)', 'Temp (Beer)', 'Gravity'];

function statOrderRank(label: string): number {
  const i = STAT_ORDER.indexOf(label);
  return i === -1 ? STAT_ORDER.length : i;
}

function statLabel(type: DeviceType, metric: string): string {
  if (metric === 'pressure_bar') return 'Pressure';
  if (metric === 'gravity_sg') return 'Gravity';
  if (metric === 'temp_c') {
    if (type === 'brew_controller') return 'Temp (Fridge)';
    if (type === 'hydrometer') return 'Temp (Beer)';
    return 'Temp';
  }
  return metricLabel(metric);
}

/** Tailwind text colour for the cooling / idle / heating state value. */
function stateClass(value: number): string {
  if (value < 0) return 'font-semibold text-sky-300'; // cooling
  if (value > 0) return 'font-semibold text-orange-300'; // heating
  return 'text-slate-400'; // idle
}

function fridgeSub(setpoint?: LatestReading, state?: LatestReading): JSX.Element | null {
  if (!setpoint && !state) return null;
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs leading-tight">
      {setpoint && <span className="text-slate-400">→ {formatValue(setpoint)}</span>}
      {state && <span className={stateClass(state.value)}>{formatValue(state)}</span>}
    </span>
  );
}

/** Flatten a group's devices into ordered station readings. */
function stationStats(devices: DeviceStatus[]): Stat[] {
  const stats: Stat[] = [];
  for (const d of devices) {
    const byMetric = new Map(d.latest.map((r) => [r.metric, r]));
    for (const r of d.latest) {
      // Setpoint and HVAC state aren't standalone readings — they annotate the
      // fridge temperature instead.
      if (r.metric === 'setpoint_c' || r.metric === 'hvac_state') continue;
      const isFridge = d.type === 'brew_controller' && r.metric === 'temp_c';
      stats.push({
        key: `${d.id}-${r.metric}`,
        deviceId: d.id,
        label: statLabel(d.type, r.metric),
        reading: r,
        sub: isFridge ? fridgeSub(byMetric.get('setpoint_c'), byMetric.get('hvac_state')) : null,
      });
    }
  }
  return stats.sort((a, b) => statOrderRank(a.label) - statOrderRank(b.label));
}

/**
 * Touch-first hub home for the Pi's 7" (800×480) screen. Everything is visible
 * at a glance with no scrolling: a compact action bar (checklist + to-do) sits
 * on top, the equipment the brewer watches fills the middle as large hero tiles
 * (the fermenter merges its pressure / fridge / beer / gravity sensors into one
 * card), and the utility meters tuck into a slim strip at the bottom.
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
  const checklistDone =
    active?.checklist != null &&
    active.progress.total > 0 &&
    active.progress.completed === active.progress.total;

  const primary = devices.filter((d) => !SECONDARY_TYPES.has(d.type));
  const secondary = devices
    .filter((d) => SECONDARY_TYPES.has(d.type))
    .sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type] || a.name.localeCompare(b.name));
  const primaryGroups = groupByName(primary).sort(
    (a, b) => groupRank(a) - groupRank(b) || a[0]!.name.localeCompare(b[0]!.name),
  );

  return (
    <div className="touch-none-select flex h-full flex-col gap-2 overflow-hidden bg-slate-900 p-2 text-white">
      {error && (
        <div className="shrink-0 rounded-lg bg-red-900/40 px-4 py-1 text-center text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Action bar — compact: the screen is for watching sensors, not chrome. */}
      <div className="grid shrink-0 grid-cols-2 gap-2">
        <ActionButton to="/display" icon="✅" label="Checklist">
          {active?.checklist ? (
            <>
              <span className="min-w-0 flex-1 truncate text-base font-medium text-slate-200">
                {active.checklist.name}
              </span>
              <span
                className={`shrink-0 rounded-md px-2 py-0.5 text-lg font-bold tabular-nums ${
                  checklistDone ? 'bg-green-600' : 'bg-slate-700'
                }`}
              >
                {active.progress.completed}/{active.progress.total}
              </span>
            </>
          ) : (
            <span className="text-sm text-slate-400">No active checklist</span>
          )}
        </ActionButton>

        <ActionButton to="/kiosk/todos" icon="🍺" label="Brewery To-Do">
          {openTodos > 0 ? (
            <span className="ml-auto shrink-0 rounded-md bg-amber-600 px-2 py-0.5 text-lg font-bold tabular-nums">
              {openTodos}
              <span className="ml-1 text-sm font-normal text-amber-100/80">open</span>
            </span>
          ) : (
            <span className="ml-auto text-sm text-slate-400">All clear</span>
          )}
        </ActionButton>
      </div>

      {/* Hero equipment — fill the bulk of the screen. A station (the fermenter
          merges several devices) is the most important, so it claims twice the
          width of a single-sensor card. */}
      <main className="flex min-h-0 flex-1 gap-2">
        {primaryGroups.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-slate-700 text-slate-500">
            No sensors connected yet
          </div>
        ) : (
          primaryGroups.map((group) => {
            const isStation = group.length > 1;
            return (
              <div
                key={isStation ? group[0]!.name : group[0]!.id}
                className={`min-w-0 ${isStation ? 'flex-[2]' : 'flex-1'}`}
              >
                {isStation ? (
                  <StationTile name={group[0]!.name} devices={group} />
                ) : (
                  <SensorTile device={group[0]!} />
                )}
              </div>
            );
          })
        )}
      </main>

      {/* Utility meters — "nice to have", so a slim strip along the bottom. */}
      {secondary.length > 0 && (
        <div className="grid shrink-0 auto-cols-fr grid-flow-col gap-2">
          {secondary.map((d) => (
            <UtilityTile key={d.id} device={d} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Compact top-bar link with an inline label and trailing status/badge. */
function ActionButton({
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
      className="flex h-14 touch-manipulation items-center gap-2 overflow-hidden rounded-xl border border-slate-700 bg-slate-800 px-3 transition active:scale-[0.98] active:bg-slate-700"
    >
      <span className="shrink-0 text-xl" aria-hidden>
        {icon}
      </span>
      <span className="shrink-0 text-base font-semibold text-slate-300">{label}</span>
      {children}
    </Link>
  );
}

/** Large hero card aggregating several same-named devices (e.g. the fermenter). */
function StationTile({ name, devices }: { name: string; devices: DeviceStatus[] }): JSX.Element {
  const stats = stationStats(devices);
  const online = devices.some((d) => d.online);
  // Icon/accent follow the most important member (pressure for the fermenter).
  const lead = [...devices].sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type])[0]!;

  return (
    <div className="flex h-full w-full min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-800 p-3">
      <div className="flex items-center gap-2">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-lg ${TYPE_ACCENT[lead.type]}`}
          aria-hidden
        >
          {TYPE_ICON[lead.type]}
        </span>
        <span className="min-w-0 flex-1 truncate text-base font-semibold text-slate-200">
          {name}
        </span>
        <StatusDot online={online} />
      </div>

      <div className="mt-2 grid min-h-0 flex-1 grid-cols-2 gap-2">
        {stats.map((s) => (
          <Link
            key={s.key}
            to={`/kiosk/devices/${s.deviceId}`}
            className="flex min-h-0 touch-manipulation flex-col justify-center overflow-hidden rounded-xl bg-slate-900/50 px-2.5 py-1.5 transition active:bg-slate-700"
          >
            <span className="truncate text-xs font-medium text-slate-400">{s.label}</span>
            <span className="text-2xl font-bold leading-tight tabular-nums">
              {formatValue(s.reading)}
            </span>
            {s.sub}
          </Link>
        ))}
      </div>
    </div>
  );
}

/** Large hero tile for a single watched sensor (e.g. brewery temperature). */
function SensorTile({ device }: { device: DeviceStatus }): JSX.Element {
  const metrics = orderedMetrics(device.latest);
  const headline = metrics[0];
  const extras = metrics.slice(1);

  return (
    <Link
      to={`/kiosk/devices/${device.id}`}
      className="flex h-full w-full min-h-0 touch-manipulation flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-800 p-3 transition active:scale-[0.98] active:bg-slate-700"
    >
      <div className="flex items-start gap-2">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-lg ${TYPE_ACCENT[device.type]}`}
          aria-hidden
        >
          {TYPE_ICON[device.type]}
        </span>
        <span className="min-w-0 flex-1 text-base font-semibold leading-tight text-slate-200 [overflow-wrap:anywhere] line-clamp-2">
          {device.name}
        </span>
        <StatusDot online={device.online} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col justify-center">
        {headline ? (
          <div className="leading-none">
            <span className="text-4xl font-bold tabular-nums">{formatValue(headline)}</span>
            <span className="ml-2 text-sm font-medium text-slate-400">
              {metricLabel(headline.metric)}
            </span>
          </div>
        ) : (
          <span className="text-base text-slate-500">No readings</span>
        )}

        {extras.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {extras.map((m) => (
              <span
                key={m.metric}
                className="rounded-md bg-slate-700/60 px-2 py-0.5 text-xs text-slate-300"
              >
                <span className="text-slate-400">{metricLabel(m.metric)} </span>
                <span className="font-semibold tabular-nums">{formatValue(m)}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      <span className="shrink-0 text-xs text-slate-500">
        {device.lastSeenAt ? `Updated ${relativeTime(device.lastSeenAt)}` : 'Never reported'}
      </span>
    </Link>
  );
}

/** Slim tile for a "nice to have" utility meter (power / water). */
function UtilityTile({ device }: { device: DeviceStatus }): JSX.Element {
  const headline = orderedMetrics(device.latest)[0];

  return (
    <Link
      to={`/kiosk/devices/${device.id}`}
      className="flex h-16 touch-manipulation items-center gap-2.5 overflow-hidden rounded-xl border border-slate-700 bg-slate-800 px-3 transition active:scale-[0.98] active:bg-slate-700"
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xl ${TYPE_ACCENT[device.type]}`}
        aria-hidden
      >
        {TYPE_ICON[device.type]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-slate-400">{device.name}</div>
        <div className="text-xl font-bold leading-tight tabular-nums">
          {headline ? formatValue(headline) : <span className="text-slate-500">—</span>}
        </div>
      </div>
      <StatusDot online={device.online} />
    </Link>
  );
}

/** Minimal online indicator — a glowing dot, no text, to save tile space. */
function StatusDot({ online }: { online: boolean }): JSX.Element {
  return (
    <span
      className={`h-2.5 w-2.5 shrink-0 rounded-full ${
        online ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]' : 'bg-slate-600'
      }`}
      aria-label={online ? 'Online' : 'Offline'}
    />
  );
}
