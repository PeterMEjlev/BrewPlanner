import type {
  ActiveState,
  DeviceStatus,
  DeviceType,
  LatestReading,
  Reading,
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
  other: 'bg-zinc-600/30 text-zinc-300',
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

/** Placeholder until the recipe (and its style) comes from Brewer's Friend — see TODO.md. */
const BEER_STYLE = '<Beer Style>';

// --- Fermentation status (derived from gravity history) ---------------------

/**
 * Fermentation is "complete" once gravity has held essentially flat for a good
 * while: classic homebrew practice is a stable reading across ~2–3 days. We
 * pull the recent gravity history and call it done when the spread over the
 * trailing window is within a small threshold — but only if the readings
 * actually span most of that window, so a freshly-booted Tilt doesn't read as
 * finished off a few minutes of flat data.
 */
const FERMENT_STABLE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // gravity flat this long ⇒ done
const FERMENT_STABLE_THRESHOLD_SG = 0.002; // max SG spread that still counts as "flat"
const FERMENT_LOOKBACK_MS = FERMENT_STABLE_WINDOW_MS + 12 * 60 * 60 * 1000; // history to fetch
const FERMENT_POLL_MS = 60_000; // gravity moves slowly — re-evaluate once a minute

function fermentationDone(history: Reading[]): boolean {
  const windowStart = Date.now() - FERMENT_STABLE_WINDOW_MS;
  const recent = history.filter((r) => Date.parse(r.recordedAt) >= windowStart);
  if (recent.length < 2) return false;
  const times = recent.map((r) => Date.parse(r.recordedAt));
  // Need readings covering most of the window before trusting a "flat" verdict.
  if (Math.max(...times) - Math.min(...times) < FERMENT_STABLE_WINDOW_MS * 0.8) return false;
  const values = recent.map((r) => r.value);
  return Math.max(...values) - Math.min(...values) <= FERMENT_STABLE_THRESHOLD_SG;
}

interface FermentStatus {
  label: string;
  dotClass: string;
  textClass: string;
}

/**
 * Watch the group's gravity history and report Fermenting / Complete. Falls
 * back to an online/offline indicator when no device reports gravity. Gravity
 * is polled on its own slow cadence (independent of the 5 s tile refresh).
 */
function useFermentStatus(devices: DeviceStatus[]): FermentStatus {
  const gravityDeviceId = devices.find((d) => d.latest.some((r) => r.metric === 'gravity_sg'))?.id;
  const anyOnline = devices.some((d) => d.online);
  const [done, setDone] = useState<boolean | null>(null);

  useEffect(() => {
    if (gravityDeviceId == null) {
      setDone(null);
      return;
    }
    let cancelled = false;
    const check = async () => {
      try {
        const since = new Date(Date.now() - FERMENT_LOOKBACK_MS).toISOString();
        const history = await api.getDeviceHistory(gravityDeviceId, {
          metric: 'gravity_sg',
          since,
          limit: 2000,
        });
        if (!cancelled) setDone(fermentationDone(history));
      } catch {
        // Keep the last known verdict on a transient fetch error.
      }
    };
    void check();
    const id = setInterval(() => void check(), FERMENT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [gravityDeviceId]);

  if (!anyOnline) {
    return { label: 'Offline', dotClass: 'bg-zinc-600', textClass: 'text-zinc-400' };
  }
  if (gravityDeviceId == null) {
    return { label: 'Online', dotClass: 'bg-emerald-400', textClass: 'text-emerald-300' };
  }
  if (done) {
    return { label: 'Complete', dotClass: 'bg-emerald-400', textClass: 'text-emerald-300' };
  }
  return { label: 'Fermenting', dotClass: 'bg-amber-400', textClass: 'text-amber-300' };
}

// --- Reading lookups + display formatting for the fermenter card ------------

interface Source {
  reading: LatestReading;
  deviceId: number;
}

/** First reading matching `metric` (optionally from a given device type). */
function findReading(
  devices: DeviceStatus[],
  metric: string,
  type?: DeviceType,
): Source | undefined {
  for (const d of devices) {
    if (type && d.type !== type) continue;
    const reading = d.latest.find((r) => r.metric === metric);
    if (reading) return { reading, deviceId: d.id };
  }
  return undefined;
}

/** Cooling / idle / heating look for the controller's hvac_state value. */
function hvacLook(value: number): { label: string; icon: string; cls: string } {
  if (value < 0) return { label: 'Cooling', icon: '❄', cls: 'text-sky-400' };
  if (value > 0) return { label: 'Heating', icon: '🔥', cls: 'text-orange-400' };
  return { label: 'Idle', icon: '○', cls: 'text-zinc-400' };
}

/** Line-art conical fermenter, tinted via currentColor. */
function FermenterIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-9 w-9"
      aria-hidden
    >
      {/* top port */}
      <path d="M29 6h6M32 6v5" />
      {/* domed lid + cylindrical body */}
      <path d="M17 18c0-4 6.7-7 15-7s15 3 15 7" />
      <path d="M17 18v18" />
      <path d="M47 18v18" />
      {/* conical bottom */}
      <path d="M17 36l15 19 15-19" />
      {/* butterfly valve */}
      <circle cx="32" cy="45" r="3" />
      {/* legs */}
      <path d="M23 50l-3 8" />
      <path d="M41 50l3 8" />
    </svg>
  );
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
    <div className="touch-none-select flex h-full flex-col gap-2 overflow-hidden bg-zinc-900 p-2 text-white">
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
              <span className="min-w-0 flex-1 truncate text-base font-medium text-zinc-200">
                {active.checklist.name}
              </span>
              <span
                className={`shrink-0 rounded-md px-2 py-0.5 text-lg font-bold tabular-nums ${
                  checklistDone ? 'bg-green-600' : 'bg-zinc-700'
                }`}
              >
                {active.progress.completed}/{active.progress.total}
              </span>
            </>
          ) : (
            <span className="text-sm text-zinc-400">No active checklist</span>
          )}
        </ActionButton>

        <ActionButton to="/kiosk/todos" icon="🍺" label="Brewery To-Do">
          {openTodos > 0 ? (
            <span className="ml-auto shrink-0 rounded-md bg-amber-600 px-2 py-0.5 text-lg font-bold tabular-nums">
              {openTodos}
              <span className="ml-1 text-sm font-normal text-amber-100/80">open</span>
            </span>
          ) : (
            <span className="ml-auto text-sm text-zinc-400">All clear</span>
          )}
        </ActionButton>
      </div>

      {/* Hero equipment — fill the bulk of the screen. A station (the fermenter
          merges several devices) is the most important, so it claims twice the
          width of a single-sensor card. */}
      <main className="flex min-h-0 flex-1 gap-2">
        {primaryGroups.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-zinc-700 text-zinc-500">
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
      className="flex h-14 touch-manipulation items-center gap-2 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-800 px-3 transition active:scale-[0.98] active:bg-zinc-700"
    >
      <span className="shrink-0 text-xl" aria-hidden>
        {icon}
      </span>
      <span className="shrink-0 text-base font-semibold text-zinc-300">{label}</span>
      {children}
    </Link>
  );
}

/**
 * The fermenter hero card. Merges the same-named pressure sensor, fridge
 * controller (Inkbird) and floating hydrometer (Tilt) into four columns —
 * Pressure | Fridge Temp | Beer Temp | Gravity — with a live fermentation
 * status derived from gravity. Each column links to its source device's chart.
 */
function StationTile({ name, devices }: { name: string; devices: DeviceStatus[] }): JSX.Element {
  const status = useFermentStatus(devices);

  const pressure = findReading(devices, 'pressure_bar');
  const beer = findReading(devices, 'temp_c', 'hydrometer');
  const fridge = findReading(devices, 'temp_c', 'brew_controller');
  const setpoint = findReading(devices, 'setpoint_c', 'brew_controller');
  const state = findReading(devices, 'hvac_state', 'brew_controller');
  const gravity = findReading(devices, 'gravity_sg');

  const hvac = state ? hvacLook(state.reading.value) : null;

  // Track which column is visually first so only that one omits its left border.
  let firstCol = true;
  const col = () => { const f = firstCol; firstCol = false; return f; };

  return (
    <div className="flex h-full w-full min-h-0 flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-800 px-4 py-3">
      {/* Header: tank icon, name + style, fermentation status. */}
      <div className="flex shrink-0 items-center gap-3">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900/40 text-zinc-200">
          <FermenterIcon />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-3xl font-bold leading-tight">{name}</div>
          <div className="truncate text-base text-zinc-400">{BEER_STYLE}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${status.dotClass}`} aria-hidden />
          <span className={`text-sm font-semibold uppercase tracking-wide ${status.textClass}`}>
            {status.label}
          </span>
        </div>
      </div>

      <hr className="my-3 shrink-0 border-zinc-700/70" />

      {/* Pressure | Temperature | Gravity — labels pinned to top row. The
          temperature column stacks Beer over Fridge (with setpoint + hvac
          state) so both readings sit together, mirroring the fermenter card. */}
      <div className="flex min-h-0 flex-1">
        {pressure && (
          <MetricColumn deviceId={pressure.deviceId} label="Pressure" first={col()}>
            <BigValue value={String(Math.round(pressure.reading.value * 14.5038))} unit="PSI" />
          </MetricColumn>
        )}

        {(beer || fridge) && (
          <MetricColumn label="Temperature" first={col()}>
            <div className="flex w-full flex-col items-center gap-1.5">
              {beer && (
                <TempRow deviceId={beer.deviceId} label="Beer" value={beer.reading.value.toFixed(1)} />
              )}
              {beer && fridge && <hr className="w-3/4 border-zinc-700/70" />}
              {fridge && (
                <TempRow
                  deviceId={fridge.deviceId}
                  label="Fridge"
                  value={fridge.reading.value.toFixed(1)}
                  valueClass={hvac?.cls}
                />
              )}
              {setpoint && (
                <span className="text-sm text-zinc-400">
                  Set: {setpoint.reading.value.toFixed(1)}°C
                </span>
              )}
              {hvac && (
                <span className={`flex items-center gap-1 text-sm font-semibold ${hvac.cls}`}>
                  <span aria-hidden>{hvac.icon}</span>
                  <span className="uppercase tracking-wide">{hvac.label}</span>
                </span>
              )}
            </div>
          </MetricColumn>
        )}

        {gravity && (
          <MetricColumn deviceId={gravity.deviceId} label="Gravity" first={col()}>
            <BigValue value={gravity.reading.value.toFixed(3)} unit="SG" />
          </MetricColumn>
        )}
      </div>
    </div>
  );
}

/**
 * One column of the fermenter card. The label is pinned to the top of the
 * column so all four labels sit on the same horizontal line regardless of how
 * tall the value content below each one is. The value area fills the remaining
 * height and vertically centers its content.
 */
function MetricColumn({
  deviceId,
  label,
  first,
  children,
}: {
  deviceId?: number | undefined;
  label: string;
  first?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  const className = `flex min-w-0 flex-1 touch-manipulation flex-col items-center px-2 text-center ${
    first ? '' : 'border-l border-zinc-700/70'
  }`;
  const body = (
    <>
      <span className="shrink-0 text-xs font-medium uppercase tracking-wider text-zinc-400">
        {label}
      </span>
      <div className="flex flex-1 items-center justify-center">{children}</div>
    </>
  );
  return deviceId == null ? (
    <div className={className}>{body}</div>
  ) : (
    <Link to={`/kiosk/devices/${deviceId}`} className={`${className} rounded-xl active:bg-zinc-700/40`}>
      {body}
    </Link>
  );
}

/**
 * One temperature reading inside the combined Temperature column: a label
 * (Beer / Fridge) to the left of the value. Links to its own source device's
 * chart since beer (Tilt) and fridge (Inkbird) come from different sensors.
 */
function TempRow({
  deviceId,
  label,
  value,
  valueClass,
}: {
  deviceId: number | undefined;
  label: string;
  value: string;
  valueClass?: string;
}): JSX.Element {
  const content = (
    <>
      <span className="w-14 shrink-0 text-right text-base text-zinc-400">{label}</span>
      <span className={`text-3xl font-bold tabular-nums ${valueClass ?? ''}`}>
        {value}
        <span className="ml-0.5 text-base font-medium text-zinc-400">°C</span>
      </span>
    </>
  );
  const className = 'flex items-baseline justify-center gap-2.5';
  return deviceId == null ? (
    <div className={className}>{content}</div>
  ) : (
    <Link
      to={`/kiosk/devices/${deviceId}`}
      className={`${className} touch-manipulation rounded-lg px-2 py-0.5 active:bg-zinc-700/40`}
    >
      {content}
    </Link>
  );
}

/** Big number with a unit underneath (pressure, gravity). */
function BigValue({ value, unit }: { value: string; unit: string }): JSX.Element {
  return (
    <>
      <span className="text-5xl font-bold leading-none tabular-nums">{value}</span>
      <span className="mt-1.5 text-base text-zinc-400">{unit}</span>
    </>
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
      className="flex h-full w-full min-h-0 touch-manipulation flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-800 p-3 transition active:scale-[0.98] active:bg-zinc-700"
    >
      <div className="flex items-start gap-2">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-lg ${TYPE_ACCENT[device.type]}`}
          aria-hidden
        >
          {TYPE_ICON[device.type]}
        </span>
        <span className="min-w-0 flex-1 text-base font-semibold leading-tight text-zinc-200 [overflow-wrap:anywhere] line-clamp-2">
          {device.name}
        </span>
        <StatusDot online={device.online} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col justify-center">
        {headline ? (
          <div className="leading-none">
            <span className="text-4xl font-bold tabular-nums">{formatValue(headline)}</span>
            <span className="ml-2 text-sm font-medium text-zinc-400">
              {metricLabel(headline.metric)}
            </span>
          </div>
        ) : (
          <span className="text-base text-zinc-500">No readings</span>
        )}

        {extras.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {extras.map((m) => (
              <span
                key={m.metric}
                className="rounded-md bg-zinc-700/60 px-2 py-0.5 text-xs text-zinc-300"
              >
                <span className="text-zinc-400">{metricLabel(m.metric)} </span>
                <span className="font-semibold tabular-nums">{formatValue(m)}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      <span className="shrink-0 text-xs text-zinc-500">
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
      className="flex h-16 touch-manipulation items-center gap-2.5 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-800 px-3 transition active:scale-[0.98] active:bg-zinc-700"
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xl ${TYPE_ACCENT[device.type]}`}
        aria-hidden
      >
        {TYPE_ICON[device.type]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-zinc-400">{device.name}</div>
        <div className="text-xl font-bold leading-tight tabular-nums">
          {headline ? formatValue(headline) : <span className="text-zinc-500">—</span>}
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
        online ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]' : 'bg-zinc-600'
      }`}
      aria-label={online ? 'Online' : 'Offline'}
    />
  );
}
