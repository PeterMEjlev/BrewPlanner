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
import {
  BoltIcon,
  ChecklistIcon,
  DropletIcon,
  FermenterIcon,
  FlaskIcon,
  GaugeIcon,
  KegIcon,
  MonitorIcon,
  MusicIcon,
  ThermometerIcon,
  TodoIcon,
} from '../components/icons';
import { isUnknownContents, useKegs } from '../kegs';
import { formatPressure, useSettings } from '../settings';
import { listPollMs } from '../useDeviceData';
import { usePoll } from '../usePoll';
import { formatValueParts, metricLabel } from './Dashboard';

/** Keg counts move slowly — re-pull the sheet once a minute for the home tile. */
const KEG_POLL_MS = 60_000;

type IconComponent = (props: { className?: string }) => JSX.Element;

/**
 * Device-type → the dashboard's monochrome line icon. The same shared glyphs the
 * desktop Overview uses for its fleet list, so the kiosk rail cards read with the
 * identical icon set and weight.
 */
const TYPE_ICON: Record<DeviceType, IconComponent> = {
  pressure_sensor: GaugeIcon,
  brew_controller: ThermometerIcon,
  power_meter: BoltIcon,
  water_meter: DropletIcon,
  hydrometer: FlaskIcon,
  other: MonitorIcon,
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
 * finished off a few minutes of flat data. The window (days) and threshold (SG)
 * are tunable from the Settings screen; see [settings.ts].
 */
const FERMENT_POLL_MS = 60_000; // gravity moves slowly — re-evaluate once a minute

function fermentationDone(history: Reading[], windowMs: number, thresholdSg: number): boolean {
  const windowStart = Date.now() - windowMs;
  const recent = history.filter((r) => Date.parse(r.recordedAt) >= windowStart);
  if (recent.length < 2) return false;
  const times = recent.map((r) => Date.parse(r.recordedAt));
  // Need readings covering most of the window before trusting a "flat" verdict.
  if (Math.max(...times) - Math.min(...times) < windowMs * 0.8) return false;
  const values = recent.map((r) => r.value);
  return Math.max(...values) - Math.min(...values) <= thresholdSg;
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
  const { fermentStableDays, fermentThresholdSg } = useSettings();
  const windowMs = fermentStableDays * 24 * 60 * 60 * 1000;
  const lookbackMs = windowMs + 12 * 60 * 60 * 1000; // a little extra history to fetch
  const gravityDeviceId = devices.find((d) => d.latest.some((r) => r.metric === 'gravity_sg'))?.id;
  const anyOnline = devices.some((d) => d.online);
  const [done, setDone] = useState<boolean | null>(null);

  useEffect(() => {
    if (gravityDeviceId == null) setDone(null);
  }, [gravityDeviceId]);

  usePoll(
    async (isStale) => {
      if (gravityDeviceId == null) return;
      try {
        const since = new Date(Date.now() - lookbackMs).toISOString();
        const history = await api.getDeviceHistory(gravityDeviceId, {
          metric: 'gravity_sg',
          since,
          limit: 2000,
        });
        if (!isStale()) setDone(fermentationDone(history, windowMs, fermentThresholdSg));
      } catch {
        // Keep the last known verdict on a transient fetch error.
      }
    },
    FERMENT_POLL_MS,
    [gravityDeviceId, windowMs, lookbackMs, fermentThresholdSg],
  );

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

function isBreweryTempDevice(device: DeviceStatus): boolean {
  return device.type === 'brew_controller' && /brewery|ambient/i.test(device.name);
}

/** The filled-keg fridge Inkbird — gets its own compact temp card in the rail. */
function isKegsTempDevice(device: DeviceStatus): boolean {
  return device.type === 'brew_controller' && /keg/i.test(device.name);
}

/**
 * Tint for the fridge temperature from the controller's hvac_state: blue while
 * cooling, orange while heating, and plain white when idle — the colour is the
 * only cue (no separate status line).
 */
function hvacColor(value: number): string {
  if (value < 0) return 'text-sky-300';
  if (value > 0) return 'text-orange-400';
  return '';
}

/**
 * Touch-first hub home for the Pi's 7" screen. Everything is visible at a glance
 * with no scrolling: the fermenter the brewer watches fills the left as a large
 * hero card (merging its pressure / fridge / beer / gravity sensors) with the
 * Checklists and To-Do shortcuts beneath it, while a right-hand rail carries the
 * remaining sensor + utility cards (brewery temp, keg fridge, power, water).
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

  // Poll at the fleet's fastest per-device logging cadence (each device's own
  // interval) rather than one fixed rate.
  const pollMs = listPollMs(devices);
  usePoll(load, pollMs, [load]);

  // The fermenter (a multi-device "station") is the hero on the left; every
  // other sensor — lone watched sensors (brewery + keg-fridge temps) and the
  // utility meters — lines up in the right rail, ordered most-watched first.
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
            {/* Left column: a brewery-speaker button pinned to the far edge, then
                the combined checklist | to-do card (which gives up the width). */}
            <div className="flex gap-3">
              <Link
                to="/kiosk/music"
                aria-label="Brewery speaker"
                className="flex h-[4.5rem] w-[4.5rem] shrink-0 touch-manipulation items-center justify-center rounded-3xl border border-zinc-800 bg-zinc-950 text-zinc-300 transition active:scale-[0.98] active:bg-zinc-800"
              >
                <MusicIcon className="h-8 w-8" />
              </Link>

              {/* Checklist + To-Do share one card: the left half opens the
                  checklist display, the right half the to-do list. Icons only. */}
              <div className="flex h-[4.5rem] flex-1 overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950">
                <Link
                  to="/display"
                  aria-label="Checklists"
                  className="flex flex-1 touch-manipulation items-center justify-center text-zinc-300 transition active:bg-zinc-800"
                >
                  <ChecklistIcon className="h-8 w-8" />
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
            </div>

            {/* Right column → a shortcut into the keg inventory view. */}
            <ActionButton
              to="/kiosk/kegs"
              title="Kegs"
              subtitle={kegInfo}
              icon={<KegIcon className="h-[1.56rem] w-[1.56rem]" />}
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
}: {
  to: string;
  title: string;
  subtitle: string;
  icon: JSX.Element;
}): JSX.Element {
  return (
    <Link
      to={to}
      className="flex h-[4.5rem] touch-manipulation items-center gap-3 overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 px-5 text-white transition active:scale-[0.98] active:bg-zinc-800"
    >
      <span className="shrink-0 text-white" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xl font-bold leading-tight text-white">{title}</div>
        <div className="truncate text-sm text-white">{subtitle}</div>
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
  const { pressureUnit } = useSettings();

  const pressure = findReading(devices, 'pressure_bar');
  const beer = findReading(devices, 'temp_c', 'hydrometer');
  const fridge = findReading(devices, 'temp_c', 'brew_controller');
  const setpoint = findReading(devices, 'setpoint_c', 'brew_controller');
  const state = findReading(devices, 'hvac_state', 'brew_controller');
  const gravity = findReading(devices, 'gravity_sg');

  const fridgeColor = state ? hvacColor(state.reading.value) : '';

  // Mock sensors always read "online", so an offline backing device means that
  // sensor is pinned to live ("Actual") data but isn't connected — show a greyed
  // "Not connected" column instead of silently dropping it. Beer temp + gravity
  // share the Tilt; fridge temp + setpoint share the Inkbird controller.
  const pressureDevice = devices.find((d) => d.type === 'pressure_sensor');
  const hydrometerDevice = devices.find((d) => d.type === 'hydrometer');
  const controllerDevice = devices.find(
    (d) => d.type === 'brew_controller' && !isBreweryTempDevice(d),
  );
  const pressureOffline = !!pressureDevice && !pressureDevice.online;
  const hydrometerOffline = !!hydrometerDevice && !hydrometerDevice.online;
  const controllerOffline = !!controllerDevice && !controllerDevice.online;

  // Collect the present columns, then interleave straight divider lines between
  // them in the render. Drawing each divider as its own element — rather than a
  // left border on the column — keeps it perfectly straight even though the
  // linked columns have rounded corners for their tap highlight.
  const columns: JSX.Element[] = [];
  if (pressureOffline) {
    columns.push(<NotConnectedColumn key="pressure" label="Pressure" />);
  } else if (pressure) {
    const p = formatPressure(pressure.reading.value, pressureUnit);
    columns.push(
      <MetricColumn key="pressure" deviceId={pressure.deviceId} label="Pressure">
        <BigValue value={p.value} unit={p.unit} />
      </MetricColumn>,
    );
  }
  if (beer || fridge || hydrometerOffline || controllerOffline) {
    // The whole Temperature column opens the combined chart (beer + fridge on
    // one graph), so the inner rows are plain readings, not their own links. An
    // offline backing sensor shows "Not connected" in place of its row.
    const tempParams = new URLSearchParams();
    if (beer) tempParams.set('beer', String(beer.deviceId));
    if (fridge) tempParams.set('fridge', String(fridge.deviceId));
    const beerCell = hydrometerOffline ? (
      <TempNotConnected label="Beer" />
    ) : beer ? (
      <TempRow label="Beer" value={beer.reading.value.toFixed(1)} />
    ) : null;
    const fridgeCell = controllerOffline ? (
      <TempNotConnected label="Fridge" />
    ) : fridge ? (
      <TempRow label="Fridge" value={fridge.reading.value.toFixed(1)} valueClass={fridgeColor} />
    ) : null;
    columns.push(
      <MetricColumn
        key="temp"
        label="Temperature"
        wide
        to={beer || fridge ? `/kiosk/temperature?${tempParams}` : undefined}
      >
        <div className="flex w-full flex-col items-center gap-3 py-1">
          {beerCell}
          {beerCell && fridgeCell && <hr className="w-3/4 border-zinc-800" />}
          {fridgeCell}
          {setpoint && !controllerOffline && (
            <span className="mt-1 text-sm text-zinc-500">
              Set: {setpoint.reading.value.toFixed(1)}°C
            </span>
          )}
        </div>
      </MetricColumn>,
    );
  }
  if (hydrometerOffline) {
    columns.push(<NotConnectedColumn key="gravity" label="Gravity" />);
  } else if (gravity) {
    // Lock the device page to gravity — the Tilt also reports beer temp, but that
    // now lives on the combined Temperature chart, so this view is gravity-only.
    columns.push(
      <MetricColumn
        key="gravity"
        to={`/kiosk/devices/${gravity.deviceId}?metric=gravity_sg`}
        label="Gravity"
      >
        <BigValue value={gravity.reading.value.toFixed(3)} unit="SG" />
      </MetricColumn>,
    );
  }

  return (
    <div className="flex h-full w-full min-h-0 flex-col overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 px-6 py-5">
      {/* Header: tank icon, name + recipe style, fermentation status. Read-only —
          the recipe library lives on the desktop/phone dashboard (sidebar →
          Recipes), which is also where the fermenter's beer gets set; the kiosk
          just displays whatever is in the tank. */}
      <div className="flex shrink-0 items-center gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-4 py-1">
          <FermenterIcon strokeWidth={2.6} className="h-12 w-12 shrink-0 text-white" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-3xl font-bold leading-tight tracking-tight">{name}</div>
            <div className="truncate text-base text-white">
              {recipeStyle || 'No recipe linked'}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${status.dotClass}`} aria-hidden />
          <span className={`text-sm font-semibold uppercase tracking-wide ${status.textClass}`}>
            {status.label}
          </span>
        </div>
      </div>

      <hr className="my-5 shrink-0 border-zinc-800" />

      {/* Pressure | Temperature | Gravity — labels pinned to the top row, with a
          straight divider line between each present column. */}
      <div className="flex min-h-0 flex-1">
        {columns.flatMap((c, i) =>
          i === 0
            ? [c]
            : [
                <span
                  key={`divider-${i}`}
                  className="w-px shrink-0 self-stretch bg-zinc-800"
                  aria-hidden
                />,
                c,
              ],
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
 * column extra width so its stacked readings have room to breathe. Pass `to` for
 * a custom destination (the Temperature column opens the combined chart); else
 * `deviceId` links to that device's own chart.
 */
function MetricColumn({
  to,
  deviceId,
  label,
  wide,
  children,
}: {
  to?: string;
  deviceId?: number | undefined;
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  const href = to ?? (deviceId != null ? `/kiosk/devices/${deviceId}` : null);
  const className = `flex min-w-0 ${
    wide ? 'flex-[1.5]' : 'flex-1'
  } touch-manipulation flex-col items-center px-3 text-center`;
  const body = (
    <>
      <span className="shrink-0 text-xs font-medium uppercase tracking-wider text-zinc-400">
        {label}
      </span>
      <div className="flex flex-1 items-center justify-center">{children}</div>
    </>
  );
  return href == null ? (
    <div className={className}>{body}</div>
  ) : (
    <Link to={href} className={`${className} rounded-xl active:bg-zinc-800/60`}>
      {body}
    </Link>
  );
}

/**
 * One temperature reading inside the combined Temperature column: a label
 * (Beer / Fridge) to the left of the value. Purely display — the whole column is
 * the tap target now, opening the combined beer + fridge chart.
 */
function TempRow({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-center gap-2.5">
      <span className="w-14 shrink-0 text-right text-base text-zinc-500">{label}</span>
      <span className={`text-3xl font-semibold tracking-tight tabular-nums ${valueClass ?? ''}`}>
        {value}
        <span className="ml-0.5 text-base font-medium text-zinc-500">°C</span>
      </span>
    </div>
  );
}

/**
 * A fermenter column whose sensor is set to live data but isn't connected — the
 * label with a greyed "Not connected" pill, so the brewer sees why it's blank
 * (no device) rather than a missing reading. Not a link (nothing to chart yet).
 */
function NotConnectedColumn({ label }: { label: string }): JSX.Element {
  return (
    <MetricColumn label={label}>
      <span className="inline-flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-base font-medium text-zinc-400">
        <span className="h-2.5 w-2.5 rounded-full bg-zinc-600" aria-hidden />
        Not connected
      </span>
    </MetricColumn>
  );
}

/** A not-connected stand-in for one temperature row (Beer / Fridge). */
function TempNotConnected({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex items-baseline justify-center gap-2.5">
      <span className="w-14 shrink-0 text-right text-base text-zinc-500">{label}</span>
      <span className="text-lg font-medium text-zinc-500">Not connected</span>
    </div>
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
  // Brewery ambient + the keg fridge are both single-temperature controllers, so
  // render them as the same compact temp tile — one big temperature tinted by the
  // cooling/heating state, with the target beneath — keeping matching cards alike.
  if (isKegsTempDevice(device)) return <TempControllerCard device={device} title="Keg Fridge" />;
  if (isBreweryTempDevice(device))
    return <TempControllerCard device={device} title={device.name} heatOnly />;

  const metrics = orderedMetrics(device.latest);
  const multi = metrics.length > 1;

  return (
    <Link
      to={`/kiosk/devices/${device.id}`}
      className={`flex min-h-0 flex-1 touch-manipulation flex-col overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 px-4 py-4 transition active:scale-[0.98] active:bg-zinc-800 ${
        device.online ? '' : 'opacity-50'
      }`}
    >
      {/* Header: a small line glyph beside the device name — the desktop
          dashboard's icon style (no circle, icon next to white text). */}
      <div className="flex shrink-0 items-center gap-2 text-white">
        <DeviceGlyph type={device.type} />
        <span className="min-w-0 flex-1 text-sm font-semibold leading-tight text-white line-clamp-2">
          {device.name}
        </span>
      </div>

      {/* Readings — multi-metric cards split into captioned columns (e.g. power's
          Current + Today); a single-reading card drops the caption, since the
          device name above already says what the value is. */}
      <div className="flex min-h-0 flex-1 items-center">
        {metrics.length === 0 ? (
          <span className="text-base text-zinc-500">{device.online ? 'No readings' : 'Not connected'}</span>
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
                <span className="mt-1.5 max-w-full truncate text-xs text-white">
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
 * Compact rail tile for a single-temperature controller (brewery ambient / keg
 * fridge): one big temperature tinted by the cooling/heating relay state
 * (blue/orange, plain when idle) with the target temperature beside it. `title`
 * names the card (e.g. "Keg Fridge"); `heatOnly` controllers never show the
 * cooling tint (their cooling relay is unused). Links to the controller's chart.
 */
function TempControllerCard({
  device,
  title,
  heatOnly = false,
}: {
  device: DeviceStatus;
  title: string;
  heatOnly?: boolean;
}): JSX.Element {
  const temp = device.latest.find((r) => r.metric === 'temp_c');
  const setpoint = device.latest.find((r) => r.metric === 'setpoint_c');
  const state = device.latest.find((r) => r.metric === 'hvac_state');
  // A heat-only controller's cooling relay isn't wired to anything, so a stray
  // "cooling" reading shows as idle (plain) rather than the blue cooling tint.
  const stateValue = state ? (heatOnly && state.value < 0 ? 0 : state.value) : null;
  const tempColor = stateValue != null ? hvacColor(stateValue) : '';

  return (
    <Link
      to={`/kiosk/devices/${device.id}?metric=temp_c`}
      className={`flex min-h-0 flex-1 touch-manipulation flex-col overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 px-4 py-4 transition active:scale-[0.98] active:bg-zinc-800 ${
        device.online ? '' : 'opacity-50'
      }`}
    >
      <div className="flex shrink-0 items-center gap-2 text-white">
        <DeviceGlyph type={device.type} />
        <span className="min-w-0 flex-1 text-sm font-semibold leading-tight text-white line-clamp-2">
          {title}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1">
          {temp ? (
            <span className={`text-4xl font-semibold leading-none tracking-tight tabular-nums ${tempColor}`}>
              {temp.value.toFixed(1)}
              <span className="ml-0.5 text-base font-medium text-zinc-500">°C</span>
            </span>
          ) : (
            <span className="text-base text-zinc-500">{device.online ? 'No readings' : 'Not connected'}</span>
          )}
          {setpoint && device.online && (
            <span className="text-sm text-zinc-500">Set: {setpoint.value.toFixed(1)}°C</span>
          )}
        </div>
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

/** Line-art glyph for a rail card, picked by device type (shared icon set). */
function DeviceGlyph({ type }: { type: DeviceType }): JSX.Element {
  const Icon = TYPE_ICON[type];
  return <Icon className="h-5 w-5 shrink-0" />;
}
