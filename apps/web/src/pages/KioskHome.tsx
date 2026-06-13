import type {
  DeviceStatus,
  DeviceType,
  LatestReading,
  Reading,
  Recipe,
} from '@checklist/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { isUnknownContents, useKegs } from '../kegs';
import { formatValueParts, metricLabel } from './Dashboard';

/** Refresh cadence for the wall display — frequent enough to feel live. */
const POLL_MS = 5000;

/** Keg counts move slowly — re-pull the sheet once a minute for the home tile. */
const KEG_POLL_MS = 60_000;

const TYPE_ICON: Record<DeviceType, string> = {
  pressure_sensor: '📈',
  brew_controller: '🌡️',
  power_meter: '⚡',
  water_meter: '🚰',
  hydrometer: '🍷',
  other: '📡',
};

/**
 * Per-type icon tint for the sidebar cards. The glyph sits in a plain circle
 * (like the fermenter's), tinted to give each sensor a distinct colour at a
 * glance while the reading itself stays white for max legibility.
 */
const SIDEBAR_TINT: Record<DeviceType, string> = {
  pressure_sensor: 'text-indigo-300',
  brew_controller: 'text-zinc-200',
  power_meter: 'text-yellow-400',
  water_meter: 'text-sky-400',
  hydrometer: 'text-fuchsia-300',
  other: 'text-zinc-300',
};

/**
 * Friendlier captions for the utility cards: the instantaneous reading (power,
 * flow) reads as "Current", the running daily total (energy, water) as "Today".
 * Anything else falls back to its metric label.
 */
const METRIC_CAPTION: Record<string, string> = {
  power_w: 'Current',
  energy_kwh: 'Today',
  flow_lpm: 'Current',
  water_l: 'Today',
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

/**
 * Tint for the fridge temperature from the controller's hvac_state: blue while
 * cooling, orange while heating, and plain white when idle — the colour is the
 * only cue (no separate status line).
 */
function hvacColor(value: number): string {
  if (value < 0) return 'text-sky-400';
  if (value > 0) return 'text-orange-400';
  return '';
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
 * Touch-first hub home for the Pi's 7" screen. Everything is visible at a glance
 * with no scrolling: the fermenter the brewer watches fills the left as a large
 * hero card (merging its pressure / fridge / beer / gravity sensors) with the
 * Checklists and To-Do shortcuts beneath it, while a right-hand rail carries a
 * live clock and the remaining sensor + utility cards (brewery temp, power,
 * water).
 */
export function KioskHomePage(): JSX.Element {
  const [devices, setDevices] = useState<DeviceStatus[]>([]);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Keg inventory comes from the shared Google Sheet (read-only here), polled
  // independently so a sheet hiccup never blanks the rest of the dashboard.
  const { kegs } = useKegs(KEG_POLL_MS);

  const load = useCallback(async () => {
    try {
      const [d, r] = await Promise.all([api.listDevices(), api.getActiveRecipe()]);
      setDevices(d);
      setRecipe(r);
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

  // The fermenter (a multi-device "station") is the hero on the left; every
  // other sensor — lone watched sensors and the utility meters — lines up in
  // the right rail, ordered most-watched first.
  const primary = devices.filter((d) => !SECONDARY_TYPES.has(d.type));
  const secondary = devices
    .filter((d) => SECONDARY_TYPES.has(d.type))
    .sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type] || a.name.localeCompare(b.name));
  const primaryGroups = groupByName(primary).sort(
    (a, b) => groupRank(a) - groupRank(b) || a[0]!.name.localeCompare(b[0]!.name),
  );
  const stations = primaryGroups.filter((g) => g.length > 1);
  const loneSensors = primaryGroups.filter((g) => g.length === 1).map((g) => g[0]!);
  const railDevices = [...loneSensors, ...secondary];

  const filledKegs = kegs.filter((k) => !isUnknownContents(k.contents)).length;
  const kegInfo =
    kegs.length > 0 ? `${filledKegs} of ${kegs.length} filled` : 'View keg inventory';

  return (
    <div className="touch-none-select flex h-full flex-col gap-3 overflow-hidden bg-black p-3 text-white">
      {error && (
        <div className="shrink-0 rounded-lg bg-red-900/40 px-4 py-1 text-center text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        {/* Left: the fermenter hero card with the Checklist / To-Do shortcuts beneath. */}
        <div className="flex min-w-0 flex-[7] flex-col gap-3">
          <main className="flex min-h-0 flex-1 flex-col gap-3">
            {stations.length === 0 ? (
              <div className="flex flex-1 items-center justify-center rounded-3xl border border-dashed border-zinc-800 text-zinc-500">
                No fermenter connected yet
              </div>
            ) : (
              stations.map((group) => (
                <div key={group[0]!.name} className="min-h-0 flex-1">
                  <StationTile
                    name={group[0]!.name}
                    devices={group}
                    recipeStyle={recipe?.style ?? null}
                  />
                </div>
              ))
            )}
          </main>

          <div className="grid shrink-0 grid-cols-2 gap-3">
            {/* Checklist + To-Do share one card: the left half opens the checklist
                display, the right half the to-do list. Icons only, no labels. */}
            <div className="flex h-[4.5rem] overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950">
              <Link
                to="/display"
                aria-label="Checklists"
                className="flex flex-1 touch-manipulation items-center justify-center text-zinc-300 transition active:bg-zinc-800"
              >
                <ClipboardIcon className="h-8 w-8" />
              </Link>
              <span className="w-px shrink-0 self-stretch bg-zinc-800" aria-hidden />
              <Link
                to="/kiosk/todos"
                aria-label="To-Do list"
                className="flex flex-1 touch-manipulation items-center justify-center text-zinc-300 transition active:bg-zinc-800"
              >
                <TodoIcon className="h-8 w-8" />
              </Link>
            </div>

            {/* Reclaimed space → a shortcut into the keg inventory view. */}
            <ActionButton
              to="/kiosk/kegs"
              title="Kegs"
              subtitle={kegInfo}
              icon={<KegIcon />}
              accent="border-zinc-700 text-zinc-300"
            />
          </div>
        </div>

        {/* Right rail: the remaining sensor + utility cards, filling the height. */}
        <div className="flex w-[30%] min-w-0 shrink-0 flex-col gap-3">
          {railDevices.length === 0 ? (
            <div className="flex flex-1 items-center justify-center rounded-3xl border border-dashed border-zinc-800 text-center text-sm text-zinc-500">
              No other sensors
            </div>
          ) : (
            railDevices.map((d) => <SidebarCard key={d.id} device={d} />)
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A wide shortcut card beneath the fermenter (the Kegs inventory link): an
 * outlined glyph, a title, and a live-status subtitle (the filled-keg count),
 * with a trailing chevron.
 */
function ActionButton({
  to,
  title,
  subtitle,
  icon,
  accent,
}: {
  to: string;
  title: string;
  subtitle: string;
  icon: JSX.Element;
  accent: string;
}): JSX.Element {
  return (
    <Link
      to={to}
      className="flex h-[4.5rem] touch-manipulation items-center gap-3.5 overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 px-5 transition active:scale-[0.98] active:bg-zinc-800"
    >
      <span
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border ${accent}`}
        aria-hidden
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xl font-bold leading-tight">{title}</div>
        <div className="truncate text-sm text-zinc-400">{subtitle}</div>
      </div>
      <span className="shrink-0 text-2xl text-zinc-500" aria-hidden>
        ›
      </span>
    </Link>
  );
}

/**
 * The fermenter hero card. Merges the same-named pressure sensor, fridge
 * controller (Inkbird) and floating hydrometer (Tilt) into three columns —
 * Pressure | Temperature | Gravity — with a live fermentation status derived
 * from gravity. Each column links to its source device's chart. Tapping the
 * header opens the recipe picker; `recipeStyle` is the chosen recipe's beer
 * style (null when none has been selected yet).
 */
function StationTile({
  name,
  devices,
  recipeStyle,
}: {
  name: string;
  devices: DeviceStatus[];
  recipeStyle: string | null;
}): JSX.Element {
  const status = useFermentStatus(devices);

  const pressure = findReading(devices, 'pressure_bar');
  const beer = findReading(devices, 'temp_c', 'hydrometer');
  const fridge = findReading(devices, 'temp_c', 'brew_controller');
  const setpoint = findReading(devices, 'setpoint_c', 'brew_controller');
  const state = findReading(devices, 'hvac_state', 'brew_controller');
  const gravity = findReading(devices, 'gravity_sg');

  const fridgeColor = state ? hvacColor(state.reading.value) : '';

  // Track which column is visually first so only that one omits its left border.
  let firstCol = true;
  const col = () => { const f = firstCol; firstCol = false; return f; };

  return (
    <div className="flex h-full w-full min-h-0 flex-col overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 px-6 py-5">
      {/* Header: tank icon, name + recipe style, fermentation status. Tapping the
          icon/name opens the recipe picker (the style comes from the choice). */}
      <div className="flex shrink-0 items-center gap-4">
        <Link
          to="/kiosk/recipes"
          className="flex min-w-0 flex-1 touch-manipulation items-center gap-4 rounded-2xl py-1 transition active:bg-zinc-800/60"
        >
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-zinc-800 bg-black text-zinc-200">
            <FermenterIcon />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-3xl font-bold leading-tight tracking-tight">{name}</div>
            <div className="truncate text-base text-zinc-500">
              {recipeStyle || 'Tap to select recipe'}
            </div>
          </div>
        </Link>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${status.dotClass}`} aria-hidden />
          <span className={`text-sm font-semibold uppercase tracking-wide ${status.textClass}`}>
            {status.label}
          </span>
        </div>
      </div>

      <hr className="my-5 shrink-0 border-zinc-800" />

      {/* Pressure | Temperature | Gravity — labels pinned to top row. The
          temperature column stacks Beer over Fridge (plus the setpoint); the
          fridge value is tinted blue/orange by the cooling/heating state. */}
      <div className="flex min-h-0 flex-1">
        {pressure && (
          <MetricColumn deviceId={pressure.deviceId} label="Pressure" first={col()}>
            <BigValue value={String(Math.round(pressure.reading.value * 14.5038))} unit="PSI" />
          </MetricColumn>
        )}

        {(beer || fridge) && (
          <MetricColumn label="Temperature" first={col()} wide>
            <div className="flex w-full flex-col items-center gap-3 py-1">
              {beer && (
                <TempRow deviceId={beer.deviceId} label="Beer" value={beer.reading.value.toFixed(1)} />
              )}
              {beer && fridge && <hr className="w-3/4 border-zinc-800" />}
              {fridge && (
                <TempRow
                  deviceId={fridge.deviceId}
                  label="Fridge"
                  value={fridge.reading.value.toFixed(1)}
                  valueClass={fridgeColor}
                />
              )}
              {setpoint && (
                <span className="mt-1 text-sm text-zinc-500">
                  Set: {setpoint.reading.value.toFixed(1)}°C
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
 * column so all labels sit on the same horizontal line regardless of how tall
 * the value content below each one is. The value area fills the remaining height
 * and vertically centers its content. `wide` gives the multi-row Temperature
 * column extra width so its stacked readings have room to breathe.
 */
function MetricColumn({
  deviceId,
  label,
  first,
  wide,
  children,
}: {
  deviceId?: number | undefined;
  label: string;
  first?: boolean;
  wide?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  const className = `flex min-w-0 ${
    wide ? 'flex-[1.5]' : 'flex-1'
  } touch-manipulation flex-col items-center px-3 text-center ${
    first ? '' : 'border-l border-zinc-800'
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
    <Link to={`/kiosk/devices/${deviceId}`} className={`${className} rounded-xl active:bg-zinc-800/60`}>
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
      <span className="w-14 shrink-0 text-right text-base text-zinc-500">{label}</span>
      <span className={`text-3xl font-semibold tracking-tight tabular-nums ${valueClass ?? ''}`}>
        {value}
        <span className="ml-0.5 text-base font-medium text-zinc-500">°C</span>
      </span>
    </>
  );
  const className = 'flex items-baseline justify-center gap-2.5';
  return deviceId == null ? (
    <div className={className}>{content}</div>
  ) : (
    <Link
      to={`/kiosk/devices/${deviceId}`}
      className={`${className} touch-manipulation rounded-lg px-2 py-0.5 active:bg-zinc-800/60`}
    >
      {content}
    </Link>
  );
}

/** Big number with a unit underneath (pressure, gravity). */
function BigValue({ value, unit }: { value: string; unit: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center">
      <span className="text-4xl font-semibold leading-none tracking-tight tabular-nums">{value}</span>
      <span className="mt-2 text-base text-zinc-500">{unit}</span>
    </div>
  );
}


/**
 * One card in the right rail: a watched sensor (brewery temp) or a utility meter
 * (power / water). A tinted line-glyph in a circle and the device name head the
 * card; below, each reading shows as a big value with a small unit and a metric
 * caption — several metrics (e.g. power's current + total) split into columns.
 * Offline devices dim. The card links to the device's chart.
 */
function SidebarCard({ device }: { device: DeviceStatus }): JSX.Element {
  const metrics = orderedMetrics(device.latest);

  const multi = metrics.length > 1;

  return (
    <Link
      to={`/kiosk/devices/${device.id}`}
      className={`flex min-h-0 touch-manipulation flex-col overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 px-4 py-4 transition active:scale-[0.98] active:bg-zinc-800 ${
        // Multi-metric cards (power/water) carry more, so they take a larger share
        // of the rail height; a single-reading card (brewery temp) stays compact.
        multi ? 'flex-[1.6]' : 'flex-1'
      } ${device.online ? '' : 'opacity-50'}`}
    >
      {/* Header: glyph circle + name (wraps to a second line when long). */}
      <div className="flex shrink-0 items-center gap-2.5">
        <span
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-zinc-800 bg-black ${SIDEBAR_TINT[device.type]}`}
          aria-hidden
        >
          <DeviceGlyph type={device.type} />
        </span>
        <span className="min-w-0 flex-1 text-sm font-medium uppercase leading-tight tracking-wider text-zinc-400 line-clamp-2">
          {device.name}
        </span>
      </div>

      {/* Readings — multi-metric cards split into captioned columns (e.g. power's
          Current + Today); a single-reading card drops the caption, since the
          device name above already says what the value is. */}
      <div className="flex min-h-0 flex-1 items-center">
        {metrics.length === 0 ? (
          <span className="text-base text-zinc-500">No readings</span>
        ) : (
          metrics.map((m, i) => (
            <div
              key={m.metric}
              className={`flex min-w-0 flex-1 flex-col items-center px-1 text-center ${
                i > 0 ? 'border-l border-zinc-800' : ''
              }`}
            >
              <MetricValue reading={m} compact={multi} />
              {multi && (
                <span className="mt-1.5 max-w-full truncate text-xs text-zinc-500">
                  {METRIC_CAPTION[m.metric] ?? metricLabel(m.metric)}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </Link>
  );
}

/**
 * A single reading as a big number with its unit beside it. `compact` shrinks it
 * for cards that pack several metrics side by side (power, water) so they don't
 * overflow their narrow columns.
 */
function MetricValue({ reading, compact }: { reading: LatestReading; compact?: boolean }): JSX.Element {
  const { value, unit } = formatValueParts(reading);
  return (
    <span className="whitespace-nowrap leading-none">
      <span className={`font-semibold tracking-tight tabular-nums ${compact ? 'text-2xl' : 'text-4xl'}`}>
        {value}
      </span>
      {unit && (
        <span className={`font-medium text-zinc-500 ${compact ? 'ml-0.5 text-xs' : 'ml-1.5 text-base'}`}>
          {unit}
        </span>
      )}
    </span>
  );
}

/** Line-art glyph for a rail card, picked by device type; tinted via currentColor. */
function DeviceGlyph({ type }: { type: DeviceType }): JSX.Element {
  switch (type) {
    case 'brew_controller':
      // The rail's brew_controller is the brewery's ambient sensor — a hut reads
      // as "the building" better than a thermometer here.
      return <HutIcon />;
    case 'power_meter':
      return <BoltIcon />;
    case 'water_meter':
      return <DropletIcon />;
    default:
      // Rare types (e.g. a lone "other" sensor) keep the emoji badge.
      return <span className="text-2xl">{TYPE_ICON[type]}</span>;
  }
}

/** Shared stroke styling for the inline line-art glyphs. */
const GLYPH_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  className: 'h-6 w-6',
  'aria-hidden': true,
} as const;

function HutIcon(): JSX.Element {
  return (
    <svg {...GLYPH_PROPS}>
      {/* pitched roof, walls, and a doorway */}
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5.5 10v9.5h13V10" />
      <path d="M10 19.5V14h4v5.5" />
    </svg>
  );
}

function BoltIcon(): JSX.Element {
  return (
    <svg {...GLYPH_PROPS}>
      <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
    </svg>
  );
}

function DropletIcon(): JSX.Element {
  return (
    <svg {...GLYPH_PROPS}>
      <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" />
    </svg>
  );
}

function ClipboardIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg {...GLYPH_PROPS} className={className ?? GLYPH_PROPS.className}>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" />
      <path d="m8.5 11 1.5 1.5 3-3" />
      <path d="M8.5 16.5h7" />
    </svg>
  );
}

/** A ticked task list — distinguishes the to-do half from the checklist half. */
function TodoIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg {...GLYPH_PROPS} className={className ?? GLYPH_PROPS.className}>
      <path d="M9 5h11" />
      <path d="M9 12h11" />
      <path d="M9 19h11" />
      <path d="m3.5 5 1.1 1.1L7 3.6" />
      <path d="m3.5 12 1.1 1.1L7 10.6" />
      <path d="m3.5 19 1.1 1.1L7 17.6" />
    </svg>
  );
}

/** Line-art beer keg/barrel for the inventory shortcut. */
function KegIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg {...GLYPH_PROPS} className={className ?? GLYPH_PROPS.className}>
      <path d="M9 3h6" />
      <path d="M8 3c-1.3 1.6-2 4.6-2 9s.7 7.4 2 9h8c1.3-1.6 2-4.6 2-9s-.7-7.4-2-9" />
      <path d="M5.7 8.5h12.6" />
      <path d="M5.7 15.5h12.6" />
    </svg>
  );
}
