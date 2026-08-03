import type {
  BrewPumpControl,
  DeviceStatus,
  DeviceType,
  LatestReading,
  Reading,
  Recipe,
} from '@checklist/shared';
import { getRecipeColor, matchContentOption } from '@checklist/shared';
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { canControl, useAuth } from '../auth';
import {
  BarSpark,
  Donut,
  type DonutSegment,
  ForecastSparkline,
  MultiLineSparkline,
  Sparkline,
  withMinSpan,
} from '../components/charts';
import { DashboardShell } from '../components/DashboardShell';
import { FitScale } from '../components/FitScale';
import { useGraphColors, withAlpha } from '../graphColors';
import {
  BoltIcon,
  DropletIcon,
  FermenterIcon,
  FlaskIcon,
  GaugeIcon,
  HutIcon,
  KegIcon,
  PauseIcon,
  SlidersIcon,
  ThermometerIcon,
} from '../components/icons';
import { MetricModal } from '../components/MetricModal';
import { useBrewSystemLive } from '../components/brewsystem/useBrewSystemLive';
import { VESSELS, formatTemp } from '../components/brewsystem/vessels';
import {
  type Keg,
  SHEETS_VIEW_URL,
  getContentColor,
  isUnknownContents,
  useKegs,
} from '../kegs';
import { useKegContentColors } from '../kegContentColors';
import {
  type GravityPoint,
  estimateDoneTime,
  fitGravityDecay,
  forecastSeries,
} from '../gravityForecast';
import { SetpointControl } from '../SetpointControl';
import { formatPressure, useSettings } from '../settings';
import { ChartRangeProvider, useChartRange } from '../chartRange';
import { fermentationDone } from '../ferment';
import { SHARED, useShared } from '../sharedPoll';
import {
  RANGES,
  useDeviceTotal,
  useFleet,
  useMetricSeries,
  useMetricSeriesFull,
  useMetricSeriesT,
} from '../useDeviceData';
import { usePoll } from '../usePoll';
import { relativeTime } from '../util';

// recharts lives behind this lazy boundary, so the brew-system chart is only
// pulled in when the card is actually opened.
const BrewSystemModal = lazy(() => import('../components/brewsystem/BrewSystemModal'));

const KEG_POLL_MS = 60_000;
const FERMENT_POLL_MS = 60_000;
/** The recipe in the tank changes once a brew, so it doesn't need the fleet's rate. */
const RECIPE_POLL_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How much gravity history feeds the forecast fit (compressed into the left half). */
const GRAVITY_HISTORY_MS = 14 * DAY_MS;
/** How far the dashed forecast tail extends past "now". */
const GRAVITY_FORECAST_MS = 2 * DAY_MS;
/** Spacing of sampled points along the forecast curve. */
const GRAVITY_FORECAST_STEP_MS = 2 * 60 * 60 * 1000;

function isBreweryTempDevice(device: DeviceStatus): boolean {
  return device.type === 'brew_controller' && /brewery|ambient/i.test(device.name);
}

/**
 * The Inkbird on the filled-keg fridge. It's a brew_controller but not part of a
 * fermenter station — it gets its own home in the dashboard later, so for now we
 * keep it out of the fermenter cards (it still appears in the Devices fleet).
 */
function isKegsTempDevice(device: DeviceStatus): boolean {
  return device.type === 'brew_controller' && /keg/i.test(device.name);
}

function isFermenterDevice(device: DeviceStatus): boolean {
  return (
    device.type === 'pressure_sensor' ||
    device.type === 'hydrometer' ||
    (device.type === 'brew_controller' && !isBreweryTempDevice(device) && !isKegsTempDevice(device))
  );
}

const TYPE_RANK: Record<DeviceType, number> = {
  pressure_sensor: 0,
  hydrometer: 1,
  brew_controller: 2,
  other: 3,
  power_meter: 4,
  water_meter: 5,
};

function groupByName(devices: DeviceStatus[]): DeviceStatus[][] {
  const groups = new Map<string, DeviceStatus[]>();
  for (const d of devices) {
    const group = groups.get(d.name);
    if (group) group.push(d);
    else groups.set(d.name, [d]);
  }
  return [...groups.values()];
}

function groupRank(group: DeviceStatus[]): number {
  return Math.min(...group.map((d) => TYPE_RANK[d.type]));
}

function isStationGroup(group: DeviceStatus[]): boolean {
  return group.some(isFermenterDevice);
}

// --- Fermentation status ----------------------------------------------------

interface FermentStatus {
  label: string;
  dotClass: string;
  textClass: string;
  shellClass: string;
}

/**
 * Last computed "fermentation complete" verdict per gravity device, kept across
 * remounts so the status pill returns to the overview reading the same as it
 * left — no Fermenting→Complete flicker while the background check re-runs.
 */
const fermentDoneCache = new Map<number, boolean>();

function useFermentStatus(devices: DeviceStatus[]): FermentStatus {
  const { fermentStableDays, fermentThresholdSg } = useSettings();
  const windowMs = fermentStableDays * 24 * 60 * 60 * 1000;
  const lookbackMs = windowMs + 12 * 60 * 60 * 1000;
  const gravityDeviceId = devices.find((d) => d.latest.some((r) => r.metric === 'gravity_sg'))?.id;
  const anyOnline = devices.some((d) => d.online);
  const [done, setDone] = useState<boolean | null>(() =>
    gravityDeviceId == null ? null : fermentDoneCache.get(gravityDeviceId) ?? null,
  );

  useEffect(() => {
    if (gravityDeviceId == null) {
      setDone(null);
      return;
    }
    const cached = fermentDoneCache.get(gravityDeviceId);
    if (cached != null) setDone(cached);
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
        if (!isStale()) {
          const verdict = fermentationDone(history, windowMs, fermentThresholdSg);
          fermentDoneCache.set(gravityDeviceId, verdict);
          setDone(verdict);
        }
      } catch {
        // Keep the last known verdict through transient history failures.
      }
    },
    FERMENT_POLL_MS,
    [gravityDeviceId, windowMs, lookbackMs, fermentThresholdSg],
  );

  if (!anyOnline) {
    return {
      label: 'Offline',
      dotClass: 'bg-zinc-500',
      textClass: 'text-zinc-400',
      shellClass: 'border-zinc-700 bg-zinc-900 text-zinc-300',
    };
  }
  if (gravityDeviceId == null) {
    return {
      label: 'Online',
      dotClass: 'bg-emerald-400',
      textClass: 'text-emerald-300',
      shellClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
    };
  }
  if (done) {
    return {
      label: 'Complete',
      dotClass: 'bg-emerald-400',
      textClass: 'text-emerald-300',
      shellClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
    };
  }
  return {
    label: 'Fermenting',
    dotClass: 'bg-amber-400',
    textClass: 'text-amber-300',
    shellClass: 'border-amber-500/30 bg-amber-500/10 text-amber-100',
  };
}

interface Source {
  reading: LatestReading;
  deviceId: number;
}

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

function hvacColor(value: number): string {
  // Heating uses orange (not amber) so the value tint doesn't read as the amber
  // "Fermenting" status; cooling stays blue, idle plain.
  if (value < 0) return 'text-sky-300';
  if (value > 0) return 'text-orange-400';
  return 'text-zinc-300';
}


/** Which metric the phone's fermenter card is expanded to. */
type FermenterTab = 'overview' | 'pressure' | 'temp' | 'gravity';

/**
 * Floor (in rem, per fermenter station) on the height the phone layout hands the
 * fermenter card while it shows the Overview tab. The card is the only flexible
 * row on that screen, so it gets whatever the utilities and keg-fridge cards
 * leave over — without a floor it can be squeezed below its own chrome, and its
 * `overflow-hidden` shell then clips the tab strip and charts. `flex-1` still
 * stretches it past the floor on a screen with room to spare.
 *
 * Sized for the card's fixed rows — header 61px, setpoint 77px, tab strip 50px,
 * body padding 32px — plus the Overview list. The utilities (156px) and
 * keg-fridge (118px) cards below are trimmed to fit alongside it, so a viewport
 * down to ~706px seats all three without scrolling; a phone in the browser (URL
 * bar showing) has ~722px, the Android app ~800px. Below that the floor holds
 * and the page scrolls rather than clipping the card.
 */
const COMPACT_FERMENTER_MIN_REM = 20;

/**
 * The same floor while a chart tab (Pressure / Temp / Gravity) is open. Those
 * tabs stack readings, a state badge and a legend above their chart, which in the
 * Overview's height left the chart a few pixels tall — drawn, but invisible. The
 * card grows to seat the tallest of them (Temp: ~109px of readings above a 112px
 * chart) so the page scrolls rather than the chart hiding inside the card, and
 * all three tabs share one height so switching between them doesn't jump.
 */
const COMPACT_FERMENTER_TAB_MIN_REM = 28;

/**
 * Floor on the plot area inside a phone tab, so a chart is never squeezed to
 * nothing on a short screen — the card is sized to give it more than this.
 */
const COMPACT_TAB_CHART = 'min-h-[7rem]';

/** A metric the user clicked to enlarge in the chart overlay. */
interface ChartTarget {
  deviceId: number;
  metric?: string;
  title: string;
  /**
   * Target temperature to draw across the chart, for the case the chart can't
   * work out for itself: beer temp is the Tilt's reading, but the setpoint it is
   * being held to belongs to the Inkbird next to it. Charts on a device that
   * carries its own setpoint don't need this.
   */
  targetC?: number;
}

/** Opens the enlarge-on-click chart overlay for a metric. */
type OpenChart = (target: ChartTarget) => void;

/**
 * True on phone-sized screens (below Tailwind's `md`, where the shell switches to
 * the bottom-nav layout). Drives the compact dashboard used by the Android app
 * and the website on a phone; desktop keeps the full command-centre layout.
 */
function useIsMobile(): boolean {
  const query = '(max-width: 767px)';
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (): void => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isMobile;
}

/**
 * The hub landing page at `/`. A desktop "command centre": the fermenter and
 * utilities live in the main column, with keg inventory, operations and the
 * device fleet in the right rail. A persistent sidebar ([DashboardShell]) wraps
 * it; the sidebar polls its own alert count for the Alerts badge.
 */
export function DashboardPage(): JSX.Element {
  const [chart, setChart] = useState<ChartTarget | null>(null);
  const [brewSystemOpen, setBrewSystemOpen] = useState(false);
  // Which tab each fermenter card has open, by station name. The page owns this
  // (rather than the card) because the card's height on a phone follows its tab.
  const [fermenterTabs, setFermenterTabs] = useState<Record<string, FermenterTab>>({});
  const { dashboardZoom } = useSettings();
  const { auth } = useAuth();
  const isMobile = useIsMobile();
  const controllable = canControl(auth);
  const { kegs, loading: kegsLoading, error: kegsError } = useKegs(KEG_POLL_MS);
  const openChart = useCallback((target: ChartTarget) => setChart(target), []);

  // Both come off shared channels (sharedPoll.ts), which do the job the page's
  // own module-level snapshot used to: the last values survive navigating away,
  // so coming back renders instantly instead of flashing the skeletons. The
  // difference is that the sidebar's device badge now rides the same request,
  // and the recipe is no longer refetched in lockstep with the fleet — it
  // changes once a brew, not every few seconds.
  const { data: devices, error, refresh: reloadFleet } = useFleet();
  const { data: recipe } = useShared(SHARED.activeRecipe, api.getActiveRecipe, RECIPE_POLL_MS);

  // Scroll to a section when the sidebar links here with a hash from another page.
  useEffect(() => {
    if (devices && window.location.hash) {
      const id = window.location.hash.slice(1);
      requestAnimationFrame(() =>
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      );
    }
  }, [devices]);

  const deviceList = devices ?? [];
  const groups = groupByName(deviceList);
  const stationGroups = groups
    .filter(isStationGroup)
    .sort((a, b) => groupRank(a) - groupRank(b) || a[0]!.name.localeCompare(b[0]!.name));

  const lastUpdate = latestDeviceTimestamp(deviceList);

  const brewery = deviceList.find(isBreweryTempDevice) ?? null;
  const kegFridge = deviceList.find(isKegsTempDevice) ?? null;
  const power = deviceList.find((d) => d.type === 'power_meter') ?? null;
  const water = deviceList.find((d) => d.type === 'water_meter') ?? null;
  const utilityOnline = [brewery, power, water].filter((d) => d?.online).length;
  const utilityTotal = [brewery, power, water].filter(Boolean).length;

  const fermenterTab = (station: string): FermenterTab => fermenterTabs[station] ?? 'overview';

  const renderFermenter = (compact: boolean): JSX.Element =>
    devices === null ? (
      <LoadingPanel label="Loading fermenter…" />
    ) : stationGroups.length === 0 ? (
      <EmptyPanel
        title="No fermenter station yet"
        body="Register pressure, controller, or hydrometer devices with the same fermenter name and they will group here."
      />
    ) : (
      // Compact: a flex column whose cards each fill an equal share of the
      // height, so the (usually single) fermenter card stretches to fill the
      // section the page layout hands it.
      <div className={compact ? 'flex h-full flex-col gap-4' : 'space-y-5'}>
        {stationGroups.map((group) => (
          <div key={group[0]!.name} className={compact ? 'min-h-0 flex-1' : undefined}>
            <FermenterCommandCenter
              name={group[0]!.name}
              devices={group}
              recipe={recipe}
              controllable={controllable}
              onRefresh={reloadFleet}
              onOpen={openChart}
              compact={compact}
              tab={compact ? fermenterTab(group[0]!.name) : undefined}
              onTabChange={
                compact
                  ? (t) => setFermenterTabs((tabs) => ({ ...tabs, [group[0]!.name]: t }))
                  : undefined
              }
            />
          </div>
        ))}
      </div>
    );

  // The phone section's height depends on which tab each card has open, so add up
  // what the open tabs need (plus the gap-4 between stacked cards).
  const compactFermenterMinRem =
    stationGroups.reduce(
      (rem, group) =>
        rem +
        (fermenterTab(group[0]!.name) === 'overview'
          ? COMPACT_FERMENTER_MIN_REM
          : COMPACT_FERMENTER_TAB_MIN_REM),
      0,
    ) +
    stationGroups.length -
    1;

  const overviewBody = (
      <main className={isMobile ? 'flex h-full flex-col gap-3 overflow-y-auto px-3 py-3' : 'w-full px-5 py-5'}>
        {error && (
          <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {isMobile ? (
          // Compact phone layout (Android app + mobile web): a flex column that
          // fills the screen — nothing is scaled, so the full width is used. The
          // fermenter card absorbs the slack, and on the Overview tab all three
          // cards seat inside one screen with no scrolling. Opening a chart tab
          // grows the card past the viewport and `main` scrolls; that's the deal
          // the floors below strike. Keg inventory and operations live in the
          // bottom nav, not here.
          <>
            <section
              id="fermenter"
              className="flex-1"
              style={
                stationGroups.length > 0
                  ? { minHeight: `${compactFermenterMinRem}rem` }
                  : undefined
              }
            >
              {renderFermenter(true)}
            </section>
            <div className="shrink-0">
              <BreweryUtilities
                brewery={brewery}
                power={power}
                water={water}
                online={utilityOnline}
                total={utilityTotal}
                loading={devices === null}
                onOpen={openChart}
                compact
              />
            </div>
            <div className="shrink-0">
              <KegFridgeCard device={kegFridge} loading={devices === null} onOpen={openChart} onRefresh={reloadFleet} compact />
            </div>
          </>
        ) : (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_23rem] xl:items-start">
            <div className="min-w-0 space-y-5">
              <section id="fermenter" className="scroll-mt-5">
                {renderFermenter(false)}
              </section>

              <BreweryUtilities
                brewery={brewery}
                power={power}
                water={water}
                online={utilityOnline}
                total={utilityTotal}
                loading={devices === null}
                onOpen={openChart}
              />
            </div>

            <aside className="space-y-5">
              <KegInventoryPanel
                kegs={kegs}
                loading={kegsLoading}
                error={kegsError}
                controllable={controllable}
              />
              {/* Same rule as the sidebar rail: a read-only guest can't open the
                  Brew System page, so they don't get its readings here either. */}
              {controllable && <BrewSystemCard onOpen={() => setBrewSystemOpen(true)} />}
              <KegFridgeCard device={kegFridge} loading={devices === null} onOpen={openChart} onRefresh={reloadFleet} />
            </aside>
          </div>
        )}
      </main>
  );

  return (
    <ChartRangeProvider>
    <DashboardShell active="overview" lastUpdate={lastUpdate} fit>
      {/* Phone: a height-filling flex layout — no scaling, so the full width is
          used and the size stays constant across the fermenter tabs. Desktop:
          the existing fill-the-monitor scaler. */}
      {isMobile ? overviewBody : <FitScale zoom={dashboardZoom}>{overviewBody}</FitScale>}

      {chart && (
        <MetricModal
          deviceId={chart.deviceId}
          metric={chart.metric}
          title={chart.title}
          targetC={chart.targetC}
          onClose={() => setChart(null)}
        />
      )}

      {brewSystemOpen && (
        // No fallback: the overlay appearing a beat after the click reads better
        // than a placeholder card flashing in front of the dashboard.
        <Suspense fallback={null}>
          <BrewSystemModal onClose={() => setBrewSystemOpen(false)} />
        </Suspense>
      )}
    </DashboardShell>
    </ChartRangeProvider>
  );
}

// --- Shared shells ----------------------------------------------------------

function PanelHeading({
  title,
  icon,
  right,
  large,
}: {
  title: string;
  icon?: React.ReactNode;
  right?: React.ReactNode;
  /** Use the larger fermenter-card heading size (for top-level section cards). */
  large?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2
        className={`flex items-center gap-2 font-semibold uppercase text-white ${
          large ? 'text-base tracking-wide' : 'text-sm tracking-wider'
        }`}
      >
        {icon}
        {title}
      </h2>
      {right}
    </div>
  );
}

function SensorsOnlinePill({ online, total }: { online: number; total: number }): JSX.Element {
  const allUp = total > 0 && online === total;
  return (
    <span className="inline-flex items-center gap-2 rounded-lg border border-zinc-800 px-2.5 py-1 text-xs text-zinc-400">
      <span
        className={`h-2 w-2 rounded-full ${allUp ? 'bg-emerald-400' : 'bg-amber-400'}`}
        aria-hidden
      />
      {online} / {total} sensors online
    </span>
  );
}

function LoadingPanel({ label }: { label: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-400">
      {label}
    </div>
  );
}

function EmptyPanel({ title, body }: { title: string; body: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-900/40 p-6">
      <p className="font-semibold text-zinc-200">{title}</p>
      <p className="mt-2 text-sm text-zinc-500">{body}</p>
    </div>
  );
}

// --- Fermenter command centre -----------------------------------------------

/**
 * A small colour dot beside the FERMENTER title showing the linked recipe's beer
 * style (from the shared keg palette, so a beer wears one colour app-wide). Sized
 * to sit inline with the title; hollow when the style is unrecognised or nothing
 * is linked, so the title never looks broken.
 */
function BeerStyleDot({ color, label }: { color: string | null; label: string | null }): JSX.Element {
  return (
    <span
      className={`h-3 w-3 shrink-0 rounded-full ${color ? '' : 'border border-zinc-600'}`}
      style={color ? { backgroundColor: color } : undefined}
      title={label ? `Fermenting: ${label}` : 'No recipe linked'}
      aria-hidden
    />
  );
}

function FermenterCommandCenter({
  name,
  devices,
  recipe,
  controllable,
  onRefresh,
  onOpen,
  compact = false,
  tab: tabProp,
  onTabChange,
}: {
  name: string;
  devices: DeviceStatus[];
  recipe: Recipe | null;
  /** Admin/local: can change the recipe. Guests see the recipe but can't edit it. */
  controllable: boolean;
  onRefresh: () => void;
  onOpen: OpenChart;
  /** Phone layout: a tabbed, single-chart-at-a-time card instead of the 3-up grid. */
  compact?: boolean;
  /**
   * The open tab, when the page owns it. The phone layout lifts this state up
   * because the card's height follows the tab — a chart needs more room than the
   * Overview list — and only the page's flex row can hand that height out. Left
   * out (desktop), the card just keeps the tab to itself.
   */
  tab?: FermenterTab;
  onTabChange?: (tab: FermenterTab) => void;
}): JSX.Element {
  const { pressureUnit, fermentStableDays, fermentThresholdSg, tempMinSpanC } = useSettings();
  const colors = useGraphColors();
  // The beer-style palette (shared with the kegs), so the title dot matches the
  // linked recipe's colour elsewhere in the app. Hollow when the style is
  // unrecognised or nothing is linked.
  const kegColors = useKegContentColors();
  const recipeColor = recipe ? getRecipeColor(recipe, kegColors) : null;
  const recipeMatch = recipe ? matchContentOption(recipe.name, recipe.style) : null;
  const status = useFermentStatus(devices);
  // Which metric the compact (phone) card is expanded to. Ignored on desktop.
  const [ownTab, setOwnTab] = useState<FermenterTab>('overview');
  const tab = tabProp ?? ownTab;
  const setTab = onTabChange ?? setOwnTab;
  const pressure = findReading(devices, 'pressure_bar');
  const beer = findReading(devices, 'temp_c', 'hydrometer');
  const fridge = findReading(devices, 'temp_c', 'brew_controller');
  const setpoint = findReading(devices, 'setpoint_c', 'brew_controller');
  const state = findReading(devices, 'hvac_state', 'brew_controller');
  const gravity = findReading(devices, 'gravity_sg');
  const controller = devices.find(
    (d) => d.type === 'brew_controller' && !isBreweryTempDevice(d) && !isKegsTempDevice(d),
  );
  const pressureDevice = devices.find((d) => d.type === 'pressure_sensor');
  const hydrometerDevice = devices.find((d) => d.type === 'hydrometer');
  // A sensor pinned to real data that isn't reporting comes back offline (mock
  // sensors always read "online"), so an offline backing device means that metric's
  // panel greys out as "not connected". Beer temp + gravity share the Tilt; fridge
  // temp + setpoint + state share the Inkbird controller.
  const pressureOffline = !!pressureDevice && !pressureDevice.online;
  const hydrometerOffline = !!hydrometerDevice && !hydrometerDevice.online;
  const controllerOffline = !!controller && !controller.online;
  const online = devices.filter((d) => d.online).length;
  const gravityHistory = useMetricSeriesT(gravity?.deviceId ?? null, 'gravity_sg', GRAVITY_HISTORY_MS);
  // Each preview tracks the window picked in its own enlarged chart. The temp
  // card shows beer + fridge together, so both share the window of the chart its
  // combined view opens (the fridge device, or the beer device when no fridge).
  const pressureRangeMs = useChartRange(pressure?.deviceId ?? null, 'pressure_bar');
  const tempRangeMs = useChartRange((fridge ?? beer)?.deviceId ?? null, 'temp_c');
  const pressureSeries = useMetricSeries(pressure?.deviceId ?? null, 'pressure_bar', pressureRangeMs);
  const tempSeries = useMetricSeries(beer?.deviceId ?? null, 'temp_c', tempRangeMs);
  // The fridge line is the one whose extremes get spelled out below, so it takes
  // the full series — the plotted values are bucket averages and understate how
  // far the fridge actually travelled.
  const fridgeFull = useMetricSeriesFull(fridge?.deviceId ?? null, 'temp_c', tempRangeMs);
  const fridgeSeries = fridgeFull.values;

  // Fit a decay curve to the gravity history and project it forward, so the
  // gravity card can show a dashed forecast and an estimated finish (using the
  // same stable-window rule as the live status). Falls back to a plain trend
  // when there isn't enough data to fit confidently.
  const gravityValues = useMemo(() => gravityHistory.map((p) => p.value), [gravityHistory]);
  const gravityNow =
    gravityHistory.length > 0 ? gravityHistory[gravityHistory.length - 1]!.t : Date.now();
  const gravityFit = useMemo(() => fitGravityDecay(gravityHistory), [gravityHistory]);
  const gravityForecast = useMemo<GravityPoint[] | null>(
    () =>
      gravityFit
        ? forecastSeries(
            gravityFit,
            gravityNow,
            gravityNow + GRAVITY_FORECAST_MS,
            GRAVITY_FORECAST_STEP_MS,
          )
        : null,
    [gravityFit, gravityNow],
  );
  const gravityDone = useMemo(
    () =>
      gravityFit ? estimateDoneTime(gravityFit, fermentStableDays, fermentThresholdSg, gravityNow) : null,
    [gravityFit, fermentStableDays, fermentThresholdSg, gravityNow],
  );
  // The forecast chart shows one continuous, now-centred window: the recent
  // history matching the forecast's span. Range labels track that visible
  // window, not the full fetched history behind the fit.
  const gravityVisible = useMemo(
    () => gravityHistory.filter((p) => p.t >= gravityNow - GRAVITY_FORECAST_MS),
    [gravityHistory, gravityNow],
  );

  // Value ranges for the sparkline axis labels. The temperature chart shares one
  // scale across beer, fridge, and the setpoint reference line, so its range
  // spans all three — and only shows once at least one line is drawable.
  const pressureRange = minMax(pressureSeries);
  const gravityRange = minMax(
    gravityForecast
      ? [...gravityVisible.map((p) => p.value), ...gravityForecast.map((p) => p.value)]
      : gravityValues,
  );
  const tempDrawable = tempSeries.length >= 2 || fridgeSeries.length >= 2;
  const tempValues = [
    ...tempSeries,
    ...fridgeSeries,
    ...(setpoint ? [setpoint.reading.value] : []),
  ];
  const tempRange =
    tempDrawable && tempValues.length > 0
      ? withMinSpan(Math.min(...tempValues), Math.max(...tempValues), tempMinSpanC)
      : null;
  // Spelled-out extremes under the temp chart, for the fridge line only: that's
  // the one the Inkbird actually holds, so it's the one worth reading how far it
  // drifted. Unwidened, and taken from the readings behind the line rather than
  // the line itself — the plotted points are bucket averages, so their own
  // min/max would quietly report a tighter hold than the fridge managed.
  const fridgeRange = fridgeFull.extremes;

  // --- Phone layout: a tabbed card so only one chart is tall at a time. --------
  if (compact) {
    const TABS = [
      { key: 'overview', label: 'Overview' },
      { key: 'pressure', label: 'Pressure' },
      { key: 'temp', label: 'Temp' },
      { key: 'gravity', label: 'Gravity' },
    ] as const;
    const pressureFmt = pressure ? formatPressure(pressure.reading.value, pressureUnit) : null;
    return (
      <article className="flex h-full flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
        <div className="flex shrink-0 items-center gap-2.5 border-b border-zinc-800 px-4 py-3">
          <FermenterIcon className="h-8 w-8 shrink-0 text-white" strokeWidth={2.6} />
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-white">
              <span className="truncate">{name}</span>
              <BeerStyleDot color={recipeColor} label={recipeMatch} />
            </h2>
            {recipe ? (
              <Link
                to={`/recipes/${encodeURIComponent(recipe.id)}`}
                className="block truncate text-xs text-zinc-500 transition hover:text-white"
                title="Open this recipe's brew sheet"
              >
                {recipe.name}
                {recipe.style ? ` (${recipe.style})` : ''}
              </Link>
            ) : controllable ? (
              <Link
                to="/recipes"
                className="text-xs font-semibold text-zinc-400 transition hover:text-white"
              >
                + Link recipe
              </Link>
            ) : (
              <span className="block truncate text-xs text-zinc-600">No recipe linked</span>
            )}
          </div>
          <SensorsOnlinePill online={online} total={devices.length} />
        </div>

        {controller && !controllerOffline && (
          <div className="shrink-0 border-b border-zinc-800 px-4 py-3">
            <SetpointControl
              deviceId={controller.id}
              setpointC={setpoint?.reading.value ?? null}
              pendingC={controller.pendingSetpointC ?? null}
              onApplied={onRefresh}
              variant="inline"
            />
          </div>
        )}

        <div className="shrink-0 px-4 pt-3">
          <div className="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-950/40 p-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`flex-1 rounded-md px-2 py-1.5 text-xs font-semibold transition ${
                  tab === t.key ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tab === 'overview' && (
            <div className="flex h-full flex-col divide-y divide-zinc-800">
              <button
                type="button"
                onClick={() => setTab('pressure')}
                className="flex w-full flex-1 items-center gap-3 text-left transition hover:bg-zinc-800/30"
              >
                <GaugeIcon className="h-5 w-5 shrink-0 text-white" />
                <span className="flex-1 truncate text-sm font-medium text-zinc-300">Pressure</span>
                {pressureOffline ? (
                  <span className="text-xs text-zinc-600">Not connected</span>
                ) : pressureFmt ? (
                  <span className="text-lg font-semibold tabular-nums text-zinc-50">
                    {pressureFmt.value}
                    <span className="ml-1 text-xs font-medium text-zinc-500">{pressureFmt.unit}</span>
                  </span>
                ) : (
                  <span className="text-sm text-zinc-600">—</span>
                )}
                <div className="w-16 shrink-0">
                  {!pressureOffline && pressureSeries.length > 1 && (
                    <Sparkline data={pressureSeries} stroke={colors.pressure} fill={withAlpha(colors.pressure, 0.12)} height={28} />
                  )}
                </div>
              </button>

              <button
                type="button"
                onClick={() => setTab('temp')}
                className="flex w-full flex-1 items-center gap-3 text-left transition hover:bg-zinc-800/30"
              >
                <ThermometerIcon className="h-5 w-5 shrink-0 text-white" />
                <span className="flex-1 truncate text-sm font-medium text-zinc-300">Temperature</span>
                <span className="text-base font-semibold tabular-nums text-zinc-50">
                  {beer ? `${beer.reading.value.toFixed(1)}°` : '—'}
                  <span className="px-1 text-zinc-600">/</span>
                  <span className={state ? hvacColor(state.reading.value) : undefined}>
                    {fridge ? `${fridge.reading.value.toFixed(1)}°` : '—'}
                  </span>
                </span>
                <div className="w-16 shrink-0">
                  {(tempSeries.length > 1 || fridgeSeries.length > 1) && (
                    <MultiLineSparkline
                      series={[
                        ...(beer ? [{ data: tempSeries, stroke: colors.beerTemp }] : []),
                        ...(fridge ? [{ data: fridgeSeries, stroke: colors.fridgeTemp, dashed: true }] : []),
                      ]}
                      height={28}
                      minSpan={tempMinSpanC}
                    />
                  )}
                </div>
              </button>

              <button
                type="button"
                onClick={() => setTab('gravity')}
                className="flex w-full flex-1 items-center gap-3 text-left transition hover:bg-zinc-800/30"
              >
                <FlaskIcon className="h-5 w-5 shrink-0 text-white" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-zinc-300">Gravity</div>
                  {gravityForecast && gravityDone && (
                    <div className="truncate text-xs text-zinc-500">{gravityDoneLabel(gravityDone)}</div>
                  )}
                </div>
                {gravity && !hydrometerOffline ? (
                  <span className="text-lg font-semibold tabular-nums text-zinc-50">
                    {gravity.reading.value.toFixed(3)}
                    <span className="ml-1 text-xs font-medium text-zinc-500">SG</span>
                  </span>
                ) : (
                  <span className="text-xs text-zinc-600">{hydrometerOffline ? 'Not connected' : '—'}</span>
                )}
                <span
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-semibold ${status.shellClass}`}
                >
                  <span className={`h-2 w-2 rounded-full ${status.dotClass}`} aria-hidden />
                  {status.label}
                </span>
              </button>
            </div>
          )}

          {tab === 'pressure' && (
            <div className="flex h-full flex-col">
              {pressureOffline ? (
                <NotConnected label="Pressure sensor not connected" />
              ) : pressureFmt ? (
                <>
                  <BigValue value={pressureFmt.value} unit={pressureFmt.unit} />
                  <div className={`mt-3 flex-1 ${COMPACT_TAB_CHART}`}>
                    <MiniChartFrame
                      max={pressureRange ? formatPressure(pressureRange.max, pressureUnit).value : undefined}
                      min={pressureRange ? formatPressure(pressureRange.min, pressureUnit).value : undefined}
                      caption={pressureRange ? <RangeCaption rangeMs={pressureRangeMs} /> : undefined}
                    >
                      <Sparkline data={pressureSeries} stroke={colors.pressure} fill={withAlpha(colors.pressure, 0.1)} grow />
                    </MiniChartFrame>
                  </div>
                </>
              ) : (
                <MissingMetric label="No pressure sensor" />
              )}
            </div>
          )}

          {tab === 'temp' && (
            <div className="flex h-full flex-col">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Beer</p>
                  {hydrometerOffline ? (
                    <NotConnected label="Tilt not connected" compact />
                  ) : beer ? (
                    <TemperatureValue reading={beer.reading} />
                  ) : (
                    <MissingMetric label="No beer temp" compact />
                  )}
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Fridge</p>
                  {controllerOffline ? (
                    <NotConnected label="Controller not connected" compact />
                  ) : fridge ? (
                    <TemperatureValue
                      reading={fridge.reading}
                      valueClass={state ? hvacColor(state.reading.value) : undefined}
                    />
                  ) : (
                    <MissingMetric label="No fridge temp" compact />
                  )}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                {state && <StateBadge value={state.reading.value} />}
                {setpoint && (
                  <span className="text-sm text-zinc-400">
                    Target{' '}
                    <span className="font-semibold tabular-nums text-zinc-200">
                      {setpoint.reading.value.toFixed(1)} °C
                    </span>
                  </span>
                )}
              </div>
              {(beer || fridge) && (
                <>
                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] uppercase tracking-wider text-zinc-500">
                    {beer && <LegendSwatch color={colors.beerTemp} label="Beer" />}
                    {fridge && <LegendSwatch color={colors.fridgeTemp} label="Fridge" dashed />}
                    {setpoint && <LegendSwatch color={colors.setpoint} label="Target" dotted />}
                  </div>
                  <div className={`mt-2 flex-1 ${COMPACT_TAB_CHART}`}>
                    <MiniChartFrame
                      max={tempRange ? `${tempRange.max.toFixed(1)}°` : undefined}
                      min={tempRange ? `${tempRange.min.toFixed(1)}°` : undefined}
                      caption={
                        fridgeRange ? (
                          <TempMinMax range={fridgeRange} label="Fridge" />
                        ) : undefined
                      }
                      captionRight={tempRange ? <RangeCaption rangeMs={tempRangeMs} /> : undefined}
                    >
                      <MultiLineSparkline
                        series={[
                          ...(beer ? [{ data: tempSeries, stroke: colors.beerTemp }] : []),
                          ...(fridge ? [{ data: fridgeSeries, stroke: colors.fridgeTemp, dashed: true }] : []),
                        ]}
                        refLine={setpoint ? { value: setpoint.reading.value, stroke: colors.setpoint } : undefined}
                        grow
                        minSpan={tempMinSpanC}
                      />
                    </MiniChartFrame>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'gravity' && (
            <div className="flex h-full flex-col">
              {hydrometerOffline ? (
                <NotConnected label="Tilt hydrometer not connected" />
              ) : gravity ? (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <BigValue value={gravity.reading.value.toFixed(3)} unit="SG" />
                    <div className="flex flex-col items-end gap-1">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold ${status.shellClass}`}
                      >
                        <span className={`h-2 w-2 rounded-full ${status.dotClass}`} aria-hidden />
                        {status.label}
                      </span>
                      {gravityForecast && gravityDone && (
                        <span className="text-sm font-semibold text-white">{gravityDoneLabel(gravityDone)}</span>
                      )}
                    </div>
                  </div>
                  <div className={`mt-3 flex-1 ${COMPACT_TAB_CHART}`}>
                    {gravityValues.length > 1 ? (
                      <MiniChartFrame
                        max={gravityRange ? gravityRange.max.toFixed(3) : undefined}
                        min={gravityRange ? gravityRange.min.toFixed(3) : undefined}
                        caption={
                          gravityForecast != null ? (
                            <PreviewCaption label="Last" value="48h" />
                          ) : (
                            <PreviewCaption label="Recent trend" />
                          )
                        }
                        captionRight={
                          gravityForecast != null ? (
                            <span>
                              <span className={CAPTION_VALUE}>2-day</span> forecast
                            </span>
                          ) : undefined
                        }
                      >
                        {gravityForecast ? (
                          <ForecastSparkline
                            history={gravityHistory}
                            forecast={gravityForecast}
                            now={gravityNow}
                            stroke={colors.gravity}
                            fill={withAlpha(colors.gravity, 0.12)}
                            grow
                          />
                        ) : (
                          <Sparkline data={gravityValues} stroke={colors.gravity} fill={withAlpha(colors.gravity, 0.12)} grow />
                        )}
                      </MiniChartFrame>
                    ) : (
                      <div className="flex h-full items-center text-xs text-zinc-600">Collecting trend…</div>
                    )}
                  </div>
                </>
              ) : (
                <MissingMetric label="No gravity data" />
              )}
            </div>
          )}
        </div>
      </article>
    );
  }

  return (
    <article className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-5 py-4">
        <div className="flex min-w-0 shrink-0 items-center gap-3">
          <FermenterIcon className="h-11 w-11 shrink-0 text-white" strokeWidth={2.6} />
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-semibold uppercase tracking-wide text-white">
              <span className="truncate">{name}</span>
              <BeerStyleDot color={recipeColor} label={recipeMatch} />
            </h2>
            {/* The beer's name opens its brew sheet — readable by guests too,
                even though only an admin can change what's in the fermenter. */}
            {recipe ? (
              <Link
                to={`/recipes/${encodeURIComponent(recipe.id)}`}
                className="block truncate text-sm text-zinc-500 transition hover:text-white"
                title="Open this recipe's brew sheet"
              >
                {recipe.name}
                {recipe.style ? ` (${recipe.style})` : ''}
              </Link>
            ) : controllable ? (
              <Link
                to="/recipes"
                className="mt-1 inline-flex items-center gap-1 rounded-lg border border-white/30 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-white/20"
              >
                <span className="text-sm leading-none" aria-hidden>
                  +
                </span>
                Link Recipe
              </Link>
            ) : (
              <span className="block truncate text-sm text-zinc-600">No recipe linked</span>
            )}
          </div>
        </div>
        {controller && !controllerOffline && (
          <div className="order-last w-full min-w-0 lg:order-none lg:w-auto lg:flex-1">
            <SetpointControl
              deviceId={controller.id}
              setpointC={setpoint?.reading.value ?? null}
              pendingC={controller.pendingSetpointC ?? null}
              onApplied={onRefresh}
              variant="inline"
            />
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <SensorsOnlinePill online={online} total={devices.length} />
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh fermenter readings"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-800 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
          >
            ↻
          </button>
        </div>
      </div>

      <div className="grid gap-4 p-5 md:grid-cols-3">
        <FermenterSubCard
          icon={<GaugeIcon className="h-6 w-6" />}
          title="Pressure"
          dimmed={pressureOffline}
          onClick={
            pressure && !pressureOffline
              ? () => onOpen({ deviceId: pressure.deviceId, metric: 'pressure_bar', title: `${name} · Pressure` })
              : undefined
          }
        >
          {pressureOffline ? (
            <NotConnected label="Pressure sensor not connected" />
          ) : pressure ? (
            <>
              <div className="mt-3">
                <BigValue {...formatPressure(pressure.reading.value, pressureUnit)} />
              </div>
              <div className="mt-3 flex-1 min-h-[12rem]">
                <MiniChartFrame
                  max={pressureRange ? formatPressure(pressureRange.max, pressureUnit).value : undefined}
                  min={pressureRange ? formatPressure(pressureRange.min, pressureUnit).value : undefined}
                  caption={pressureRange ? <RangeCaption rangeMs={pressureRangeMs} /> : undefined}
                >
                  <Sparkline data={pressureSeries} stroke={colors.pressure} fill={withAlpha(colors.pressure, 0.1)} grow />
                </MiniChartFrame>
              </div>
            </>
          ) : (
            <MissingMetric label="No pressure sensor" />
          )}
        </FermenterSubCard>

        <FermenterSubCard icon={<ThermometerIcon className="h-6 w-6" />} title="Temperature & Control">
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Beer</p>
              {hydrometerOffline ? (
                <NotConnected label="Tilt not connected" compact />
              ) : beer ? (
                <MetricButton
                  onClick={() =>
                    onOpen({
                      deviceId: beer.deviceId,
                      metric: 'temp_c',
                      title: `${name} · Beer temperature`,
                      // The Tilt has no setpoint of its own; hand it the
                      // controller's so the chart can still draw the target.
                      ...(setpoint ? { targetC: setpoint.reading.value } : {}),
                    })
                  }
                >
                  <TemperatureValue reading={beer.reading} />
                </MetricButton>
              ) : (
                <MissingMetric label="No beer temp" compact />
              )}
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Fridge</p>
              {controllerOffline ? (
                <NotConnected label="Controller not connected" compact />
              ) : fridge ? (
                <MetricButton
                  onClick={() => onOpen({ deviceId: fridge.deviceId, metric: 'temp_c', title: `${name} · Fridge temperature` })}
                >
                  <TemperatureValue
                    reading={fridge.reading}
                    valueClass={state ? hvacColor(state.reading.value) : undefined}
                  />
                </MetricButton>
              ) : (
                <MissingMetric label="No fridge temp" compact />
              )}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {state ? (
              <StateBadge value={state.reading.value} />
            ) : controllerOffline ? (
              <span className="text-sm text-zinc-500">Controller not connected</span>
            ) : (
              <span className="text-sm text-zinc-500">No controller state</span>
            )}
            {setpoint && (
              <span className="text-sm text-zinc-400">
                Target{' '}
                <span className="font-semibold tabular-nums text-zinc-200">
                  {setpoint.reading.value.toFixed(1)} °C
                </span>
              </span>
            )}
          </div>
          {(beer || fridge) && (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] uppercase tracking-wider text-zinc-500">
                {beer && <LegendSwatch color={colors.beerTemp} label="Beer" />}
                {fridge && <LegendSwatch color={colors.fridgeTemp} label="Fridge" dashed />}
                {setpoint && <LegendSwatch color={colors.setpoint} label="Target" dotted />}
              </div>
              <div className="mt-2 flex-1 min-h-[12rem]">
                <button
                  type="button"
                  onClick={() =>
                    onOpen({
                      deviceId: (fridge ?? beer)!.deviceId,
                      metric: 'temp_c',
                      title: `${name} · Temperature`,
                    })
                  }
                  className="block h-full w-full rounded-lg text-left transition hover:bg-zinc-800/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                >
                  <MiniChartFrame
                    max={tempRange ? `${tempRange.max.toFixed(1)}°` : undefined}
                    min={tempRange ? `${tempRange.min.toFixed(1)}°` : undefined}
                    caption={
                      fridgeRange ? (
                        <TempMinMax range={fridgeRange} label="Fridge" />
                      ) : undefined
                    }
                    captionRight={tempRange ? <RangeCaption rangeMs={tempRangeMs} /> : undefined}
                  >
                    <MultiLineSparkline
                      series={[
                        ...(beer ? [{ data: tempSeries, stroke: colors.beerTemp }] : []),
                        ...(fridge ? [{ data: fridgeSeries, stroke: colors.fridgeTemp, dashed: true }] : []),
                      ]}
                      refLine={setpoint ? { value: setpoint.reading.value, stroke: colors.setpoint } : undefined}
                      grow
                      minSpan={tempMinSpanC}
                    />
                  </MiniChartFrame>
                </button>
              </div>
            </>
          )}
        </FermenterSubCard>

        <FermenterSubCard
          icon={<FlaskIcon className="h-6 w-6" />}
          title="Gravity"
          headerRight={
            <div className="flex flex-col items-end gap-1.5">
              <span
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold ${status.shellClass}`}
              >
                <span className={`h-2 w-2 rounded-full ${status.dotClass}`} aria-hidden />
                {status.label}
              </span>
              {gravityForecast && gravityDone && (
                <span className="text-sm font-semibold text-white">{gravityDoneLabel(gravityDone)}</span>
              )}
            </div>
          }
          dimmed={hydrometerOffline}
          onClick={
            gravity && !hydrometerOffline
              ? () => onOpen({ deviceId: gravity.deviceId, metric: 'gravity_sg', title: `${name} · Gravity` })
              : undefined
          }
        >
          {hydrometerOffline ? (
            <NotConnected label="Tilt hydrometer not connected" />
          ) : gravity ? (
            <>
              <div className="mt-3">
                <BigValue value={gravity.reading.value.toFixed(3)} unit="SG" />
              </div>
              <div className="mt-3 flex-1 min-h-[12rem]">
                {gravityValues.length > 1 ? (
                  <MiniChartFrame
                    max={gravityRange ? gravityRange.max.toFixed(3) : undefined}
                    min={gravityRange ? gravityRange.min.toFixed(3) : undefined}
                    caption={
                      gravityForecast != null ? (
                        <PreviewCaption label="Last" value="48h" />
                      ) : (
                        <PreviewCaption label="Recent trend" />
                      )
                    }
                    captionRight={
                      gravityForecast != null ? (
                        <span>
                          <span className={CAPTION_VALUE}>2-day</span> forecast
                        </span>
                      ) : undefined
                    }
                  >
                    {gravityForecast ? (
                      <ForecastSparkline
                        history={gravityHistory}
                        forecast={gravityForecast}
                        now={gravityNow}
                        stroke={colors.gravity}
                        fill={withAlpha(colors.gravity, 0.12)}
                        grow
                      />
                    ) : (
                      <Sparkline data={gravityValues} stroke={colors.gravity} fill={withAlpha(colors.gravity, 0.12)} grow />
                    )}
                  </MiniChartFrame>
                ) : (
                  <div className="flex h-full items-center text-xs text-zinc-600">Collecting trend…</div>
                )}
              </div>
            </>
          ) : (
            <MissingMetric label="No gravity data" />
          )}
        </FermenterSubCard>
      </div>
    </article>
  );
}

/**
 * A blacker sub-card for one fermenter metric, mirroring the Brewery & Utilities
 * card style: a large white title + icon, the value(s), and a small trend graph.
 * Becomes a button (whole-card click → chart overlay) when `onClick` is given.
 */
function FermenterSubCard({
  icon,
  title,
  onClick,
  headerRight,
  dimmed,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  onClick?: () => void;
  /** Optional element pinned to the top-right of the card head (e.g. a status pill). */
  headerRight?: React.ReactNode;
  /** Fade the card when its sensor is set to live data but isn't connected. */
  dimmed?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  const base = `flex flex-col rounded-xl border border-zinc-800 bg-zinc-950/40 p-4 text-left${
    dimmed ? ' opacity-60' : ''
  }`;
  const head = (
    <div className="flex items-start gap-2.5 text-white">
      {icon}
      <h3 className="min-w-0 truncate text-base font-semibold tracking-tight text-white">{title}</h3>
      {headerRight && <div className="ml-auto shrink-0">{headerRight}</div>}
    </div>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`${base} w-full transition hover:border-zinc-700 hover:bg-zinc-800/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500`}
      >
        {head}
        {children}
      </button>
    );
  }
  return (
    <div className={base}>
      {head}
      {children}
    </div>
  );
}

function MetricButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full rounded-lg text-left transition hover:bg-zinc-800/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
    >
      {children}
    </button>
  );
}

/** A tiny solid/dashed/dotted line swatch + label for the temperature legend. */
function LegendSwatch({
  color,
  label,
  dashed,
  dotted,
}: {
  color: string;
  label: string;
  dashed?: boolean;
  dotted?: boolean;
}): JSX.Element {
  return (
    <span className="flex items-center gap-1">
      <span
        className={`inline-block w-3.5 border-t-2 ${dashed ? 'border-dashed' : dotted ? 'border-dotted' : ''}`}
        style={{ borderColor: color }}
        aria-hidden
      />
      {label}
    </span>
  );
}

function BigValue({ value, unit }: { value: string; unit: string }): JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-3xl font-semibold tracking-tight tabular-nums text-zinc-50">{value}</span>
      <span className="text-sm font-medium uppercase tracking-wide text-zinc-500">{unit}</span>
    </div>
  );
}

function TemperatureValue({
  reading,
  valueClass,
}: {
  reading: LatestReading;
  valueClass?: string;
}): JSX.Element {
  return (
    <div className="flex items-baseline gap-1.5">
      <span
        className={`text-2xl font-semibold tracking-tight tabular-nums text-zinc-50 ${valueClass ?? ''}`}
      >
        {reading.value.toFixed(1)}
      </span>
      <span className="text-sm font-medium text-zinc-500">°C</span>
    </div>
  );
}

function MissingMetric({ label, compact }: { label: string; compact?: boolean }): JSX.Element {
  return <p className={`${compact ? 'mt-2' : 'mt-4'} text-sm text-zinc-600`}>{label}</p>;
}

/**
 * Shown in place of a reading when its sensor is set to live ("Actual") data but
 * isn't reporting — a greyed "not connected" pill plus an explanation, so the
 * blank tile clearly reads as "no device connected" rather than a glitch.
 */
function NotConnected({ label, compact }: { label?: string; compact?: boolean }): JSX.Element {
  return (
    <div className={`${compact ? 'mt-2' : 'mt-3 flex-1'} flex flex-col items-start gap-1.5`}>
      <span className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800/40 px-2 py-0.5 text-xs font-medium text-zinc-400">
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" aria-hidden />
        Not connected
      </span>
      {label && <span className="text-xs text-zinc-600">{label}</span>}
    </div>
  );
}

/** Min/max of a series, or null when there aren't enough points to draw a line. */
function minMax(data: number[]): { min: number; max: number } | null {
  if (data.length < 2) return null;
  return { min: Math.min(...data), max: Math.max(...data) };
}

/**
 * Like {@link minMax}, but widened to at least `minSpanC` so the axis labels
 * match a temperature sparkline drawn with the same `minSpan` floor. The floor
 * is the user's "Temp chart min span" setting (see {@link useSettings}).
 */
function tempRangeOf(data: number[], minSpanC: number): { min: number; max: number } | null {
  const r = minMax(data);
  return r ? withMinSpan(r.min, r.max, minSpanC) : null;
}

/** The window a preview covers, e.g. "24h" — tracks the chosen range. */
function rangeLabel(rangeMs: number): string {
  return RANGES.find((r) => r.ms === rangeMs)?.label ?? '24h';
}

/** Weight/colour every preview footer picks its values out in. */
const CAPTION_VALUE = 'font-semibold tabular-nums text-zinc-300';

/**
 * A caption under a preview chart — a plain lead-in and, where there is one, the
 * value it introduces picked out: "Last **24h**". Same treatment as the Min/Max
 * labels beside it, so a glance lands on the numbers rather than the words.
 */
function PreviewCaption({ label, value }: { label: string; value?: string }): JSX.Element {
  return (
    <span>
      {value == null ? label : `${label} `}
      {value != null && <span className={CAPTION_VALUE}>{value}</span>}
    </span>
  );
}

/** "Last 24h" for a preview windowed by the shared range picker. */
function RangeCaption({ rangeMs }: { rangeMs: number }): JSX.Element {
  return <PreviewCaption label="Last" value={rangeLabel(rangeMs)} />;
}

/**
 * "Min 17.4 °C · Max 19.2 °C" — the extremes of one temperature series, spelled
 * out under its preview chart. Shared by the three Overview temp charts so they
 * read alike.
 */
function TempMinMax({
  range,
  label,
}: {
  range: { min: number; max: number };
  /** Names the series when the chart draws more than one, e.g. "Fridge". */
  label?: string;
}): JSX.Element {
  return (
    <span>
      {label ? `${label} Min ` : 'Min '}
      <span className={CAPTION_VALUE}>{range.min.toFixed(1)} °C</span>
      {'  ·  Max '}
      <span className={CAPTION_VALUE}>{range.max.toFixed(1)} °C</span>
    </span>
  );
}

/**
 * The full line under a utility temp sparkline: extremes on the left, the window
 * they were measured over on the right. The fermenter card gets the same pair
 * through {@link MiniChartFrame}'s caption row instead, since it already has one.
 */
function TempRangeLine({
  range,
  rangeMs,
}: {
  range: { min: number; max: number };
  rangeMs: number;
}): JSX.Element {
  return (
    <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-xs text-zinc-500">
      <TempMinMax range={range} />
      <RangeCaption rangeMs={rangeMs} />
    </div>
  );
}

/** The predicted-finish line shown under the status pill (white, prominent). */
function gravityDoneLabel(done: { t: number; alreadyDone: boolean }): string {
  return done.alreadyDone
    ? 'Est. complete now'
    : `Est. done · ${new Date(done.t).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

/**
 * Wraps a fermenter sub-card sparkline with light axis context: the value range
 * (max top-right, min bottom-right) and the time window below — enough to read
 * the trend without the heft of a full chart. Pass pre-formatted strings; omit
 * any to hide that label (e.g. before a trend has enough points).
 */
function MiniChartFrame({
  children,
  max,
  min,
  caption,
  captionRight,
}: {
  children: React.ReactNode;
  max?: string;
  min?: string;
  caption?: React.ReactNode;
  /** Optional second caption pinned to the right — e.g. the window it covers. */
  captionRight?: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">{children}</div>
        {max != null && (
          <span className="pointer-events-none absolute right-0 top-0 rounded bg-zinc-950/60 px-1.5 py-0.5 text-sm font-semibold leading-none tabular-nums text-white">
            {max}
          </span>
        )}
        {min != null && (
          <span className="pointer-events-none absolute bottom-0 right-0 rounded bg-zinc-950/60 px-1.5 py-0.5 text-sm font-semibold leading-none tabular-nums text-white">
            {min}
          </span>
        )}
      </div>
      {(caption != null || captionRight != null) && (
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-xs leading-none text-zinc-500">
          <span>{caption}</span>
          {captionRight != null && <span>{captionRight}</span>}
        </div>
      )}
    </div>
  );
}

// --- Brewery & utilities ----------------------------------------------------

function BreweryUtilities({
  brewery,
  power,
  water,
  online,
  total,
  loading,
  onOpen,
  compact = false,
}: {
  brewery: DeviceStatus | null;
  power: DeviceStatus | null;
  water: DeviceStatus | null;
  online: number;
  total: number;
  loading: boolean;
  onOpen: OpenChart;
  /** Phone layout: a tight 3-across row of slim tiles. */
  compact?: boolean;
}): JSX.Element {
  return (
    <section className={`rounded-xl border border-zinc-800 bg-zinc-900 ${compact ? 'p-4' : 'p-5'}`}>
      <PanelHeading
        title="Brewery & Utilities"
        icon={<HutIcon className={compact ? 'h-5 w-5' : 'h-7 w-7'} />}
        right={total > 0 ? <SensorsOnlinePill online={online} total={total} /> : undefined}
        large={!compact}
      />
      {loading ? (
        <p className="mt-4 text-sm text-zinc-400">Loading utilities…</p>
      ) : (
        <div className={compact ? 'mt-3 grid grid-cols-3 gap-2' : 'mt-4 grid gap-4 md:grid-cols-3'}>
          <BreweryTempCard device={brewery} onOpen={onOpen} compact={compact} />
          <PowerCard device={power} onOpen={onOpen} compact={compact} />
          <WaterCard device={water} onOpen={onOpen} compact={compact} />
        </div>
      )}
    </section>
  );
}

/**
 * Slim utility tile for the phone 3-across row: title, current value, and a
 * secondary line. No mini chart — the phone screen has to seat this row, the keg
 * fridge and a full-height fermenter card, and tapping a tile opens its chart.
 */
function CompactUtilityTile({
  icon,
  title,
  value,
  unit,
  sub,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  unit?: string | null;
  /** A small secondary line, e.g. "Today 143 kWh" or "Target 6.0°". */
  sub?: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5 text-left transition hover:border-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
    >
      <div className="flex items-center gap-1.5 text-white">
        {icon}
        <span className="truncate text-[11px] font-semibold uppercase tracking-wide">{title}</span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="text-base font-semibold tabular-nums text-zinc-50">{value}</span>
        {unit && <span className="text-[10px] font-medium text-zinc-500">{unit}</span>}
      </div>
      {sub && <p className="truncate text-[10px] text-zinc-500">{sub}</p>}
    </button>
  );
}

/** Slim "no data yet" tile matching {@link CompactUtilityTile}'s footprint. */
function CompactUtilityPlaceholder({
  icon,
  title,
  note,
}: {
  icon: React.ReactNode;
  title: string;
  note: string;
}): JSX.Element {
  return (
    <div className="flex flex-col rounded-lg border border-dashed border-zinc-800 bg-zinc-950/30 p-2.5">
      <div className="flex items-center gap-1.5 text-zinc-300 opacity-70">
        {icon}
        <span className="truncate text-[11px] font-semibold uppercase tracking-wide">{title}</span>
      </div>
      <p className="mt-2 flex items-center gap-1 text-[10px] text-zinc-600">
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" aria-hidden />
        {note}
      </p>
    </div>
  );
}

/** Card wrapper that opens the chart overlay for its device + metric on click. */
function UtilityCardButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block h-full w-full text-left transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:rounded-xl"
    >
      {children}
    </button>
  );
}

function UtilityShell({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex h-full flex-col rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
      <div className="flex items-center gap-2 text-white">
        {icon}
        <h3 className="font-semibold text-white">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function UtilityPlaceholder({
  icon,
  title,
  note = 'Not connected yet',
}: {
  icon: React.ReactNode;
  title: string;
  /** Why there's no data — "not connected yet" vs. a registered sensor gone offline. */
  note?: string;
}): JSX.Element {
  return (
    <div className="flex h-full flex-col rounded-xl border border-dashed border-zinc-800 bg-zinc-950/30 p-4">
      <div className="flex items-center gap-2 text-zinc-300 opacity-70">
        {icon}
        <h3 className="font-semibold text-zinc-300">{title}</h3>
      </div>
      <div className="mt-6 flex items-center gap-1.5 text-sm text-zinc-600">
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" aria-hidden />
        {note}
      </div>
    </div>
  );
}

/**
 * Wording for a utility tile with no live data: a sensor pinned to real that has
 * never reported reads "not connected yet"; one that reported before but has gone
 * quiet reads "offline".
 */
function notConnectedNote(device: DeviceStatus | null): string {
  return device?.lastSeenAt ? 'Offline — not reporting' : 'Not connected yet';
}

function BreweryTempCard({
  device,
  onOpen,
  compact = false,
}: {
  device: DeviceStatus | null;
  onOpen: OpenChart;
  compact?: boolean;
}): JSX.Element {
  const rangeMs = useChartRange(device?.id ?? null, 'temp_c');
  const series = useMetricSeries(device?.id ?? null, 'temp_c', rangeMs);
  const colors = useGraphColors();
  const { tempMinSpanC } = useSettings();
  if (!device || !device.online) {
    return compact ? (
      <CompactUtilityPlaceholder
        icon={<ThermometerIcon className="h-4 w-4" />}
        title="Temp"
        note={notConnectedNote(device)}
      />
    ) : (
      <UtilityPlaceholder
        icon={<ThermometerIcon className="h-5 w-5" />}
        title="Temperature"
        note={notConnectedNote(device)}
      />
    );
  }
  const temp = device.latest.find((r) => r.metric === 'temp_c');
  const setpoint = device.latest.find((r) => r.metric === 'setpoint_c');
  const range = tempRangeOf(series, tempMinSpanC);
  if (compact) {
    return (
      <CompactUtilityTile
        icon={<ThermometerIcon className="h-4 w-4" />}
        title="Temp"
        value={temp ? temp.value.toFixed(1) : '—'}
        unit="°C"
        sub={setpoint ? `Target ${setpoint.value.toFixed(1)}°` : undefined}
        onClick={() => onOpen({ deviceId: device.id, metric: 'temp_c', title: 'Brewery ambient temperature' })}
      />
    );
  }
  return (
    <UtilityCardButton
      onClick={() => onOpen({ deviceId: device.id, metric: 'temp_c', title: 'Brewery ambient temperature' })}
    >
      <UtilityShell icon={<ThermometerIcon className="h-5 w-5" />} title="Temperature">
        <p className="mt-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
          Ambient Temp
        </p>
        <div className="mt-1 flex items-baseline gap-3">
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-semibold tabular-nums text-zinc-50">
              {temp ? temp.value.toFixed(1) : '—'}
            </span>
            <span className="text-sm font-medium text-zinc-500">°C</span>
          </div>
          {setpoint && (
            <p className="text-sm text-zinc-400">
              Target{' '}
              <span className="font-semibold tabular-nums text-zinc-200">
                {setpoint.value.toFixed(1)} °C
              </span>
            </p>
          )}
        </div>
        <div className="mt-3">
          <Sparkline data={series} stroke={colors.fridgeTemp} fill={withAlpha(colors.fridgeTemp, 0.1)} height={40} minSpan={tempMinSpanC} />
        </div>
        {range && <TempRangeLine range={range} rangeMs={rangeMs} />}
      </UtilityShell>
    </UtilityCardButton>
  );
}

function PowerCard({
  device,
  onOpen,
  compact = false,
}: {
  device: DeviceStatus | null;
  onOpen: OpenChart;
  compact?: boolean;
}): JSX.Element {
  const series = useMetricSeries(device?.id ?? null, 'power_w', useChartRange(device?.id ?? null, 'power_w'));
  const total = useDeviceTotal(device?.id ?? -1, device ? 'energy_kwh' : undefined);
  const colors = useGraphColors();
  if (!device || !device.online)
    return compact ? (
      <CompactUtilityPlaceholder icon={<BoltIcon className="h-4 w-4" />} title="Power" note={notConnectedNote(device)} />
    ) : (
      <UtilityPlaceholder icon={<BoltIcon className="h-5 w-5" />} title="Power" note={notConnectedNote(device)} />
    );
  const current = device.latest.find((r) => r.metric === 'power_w');
  const today = device.latest.find((r) => r.metric === 'energy_kwh');
  if (compact) {
    const cur = current ? formatValueParts(current) : null;
    return (
      <CompactUtilityTile
        icon={<BoltIcon className="h-4 w-4" />}
        title="Power"
        value={cur ? cur.value : '—'}
        unit={cur?.unit}
        sub={today ? `Today ${formatValue(today)}` : undefined}
        onClick={() => onOpen({ deviceId: device.id, metric: 'power_w', title: 'Power draw' })}
      />
    );
  }
  return (
    <UtilityCardButton
      onClick={() => onOpen({ deviceId: device.id, metric: 'power_w', title: 'Power draw' })}
    >
      <UtilityShell icon={<BoltIcon className="h-5 w-5" />} title="Power">
        <div className="mt-3 grid grid-cols-2 gap-2">
          <StatPair label="Current" value={current ? formatValue(current) : '—'} />
          <StatPair label="Today" value={today ? formatValue(today) : '—'} />
        </div>
        <div className="mt-3">
          <BarSpark data={series} fill={colors.power} height={40} />
        </div>
        {total != null && (
          <p className="mt-3 text-xs text-zinc-500">
            All-time{' '}
            <span className="font-semibold tabular-nums text-zinc-300">
              {formatValue({ metric: 'energy_kwh', value: total, recordedAt: '' })}
            </span>
          </p>
        )}
      </UtilityShell>
    </UtilityCardButton>
  );
}

function WaterCard({
  device,
  onOpen,
  compact = false,
}: {
  device: DeviceStatus | null;
  onOpen: OpenChart;
  compact?: boolean;
}): JSX.Element {
  const series = useMetricSeries(device?.id ?? null, 'flow_lpm', useChartRange(device?.id ?? null, 'flow_lpm'));
  const total = useDeviceTotal(device?.id ?? -1, device ? 'water_l' : undefined);
  const colors = useGraphColors();
  if (!device || !device.online)
    return compact ? (
      <CompactUtilityPlaceholder icon={<DropletIcon className="h-4 w-4" />} title="Water" note={notConnectedNote(device)} />
    ) : (
      <UtilityPlaceholder icon={<DropletIcon className="h-5 w-5" />} title="Water" note={notConnectedNote(device)} />
    );
  const current = device.latest.find((r) => r.metric === 'flow_lpm');
  const today = device.latest.find((r) => r.metric === 'water_l');
  if (compact) {
    const cur = current ? formatValueParts(current) : null;
    return (
      <CompactUtilityTile
        icon={<DropletIcon className="h-4 w-4" />}
        title="Water"
        value={cur ? cur.value : '—'}
        unit={cur?.unit}
        sub={today ? `Today ${formatValue(today)}` : undefined}
        onClick={() => onOpen({ deviceId: device.id, metric: 'flow_lpm', title: 'Water flow' })}
      />
    );
  }
  return (
    <UtilityCardButton
      onClick={() => onOpen({ deviceId: device.id, metric: 'flow_lpm', title: 'Water flow' })}
    >
      <UtilityShell icon={<DropletIcon className="h-5 w-5" />} title="Water">
        <div className="mt-3 grid grid-cols-2 gap-2">
          <StatPair label="Current" value={current ? formatValue(current) : '—'} />
          <StatPair label="Today" value={today ? formatValue(today) : '—'} />
        </div>
        <div className="mt-3">
          <Sparkline data={series} stroke={colors.water} fill={withAlpha(colors.water, 0.1)} height={40} />
        </div>
        {total != null && (
          <p className="mt-3 text-xs text-zinc-500">
            All-time{' '}
            <span className="font-semibold tabular-nums text-zinc-300">
              {formatValue({ metric: 'water_l', value: total, recordedAt: '' })}
            </span>
          </p>
        )}
      </UtilityShell>
    </UtilityCardButton>
  );
}

function StatPair({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="mt-0.5 text-xl font-semibold tabular-nums text-zinc-50">{value}</p>
    </div>
  );
}

// --- Keg inventory ----------------------------------------------------------

/** Fallback palette for keg contents that have no defined colour in kegs.ts. */
const KEG_FALLBACK_COLORS = ['#a78bfa', '#f472b6', '#fb923c', '#34d399', '#60a5fa'];
const EMPTY_KEG_COLOR = '#3f3f46';

/**
 * A "Dirty" keg is one waiting for a wash, not a beer on tap. It keeps its
 * warning red in the ring, but sits flush like the empty slice — what the
 * raised slices mean is "stocked".
 */
function isDirtyContents(contents: string): boolean {
  return contents.trim().toLowerCase() === 'dirty';
}

function KegInventoryPanel({
  kegs,
  loading,
  error,
  controllable,
}: {
  kegs: Keg[];
  loading: boolean;
  error: string | null;
  /** Admin/local: may open the source Google Sheet. Hidden for read-only guests. */
  controllable: boolean;
}): JSX.Element {
  // "Filled" is a beer someone can pour, so a dirty keg counts no more than an
  // unknown one does. They aren't the same thing though: only "???" fills the
  // empty slice, leaving dirty kegs their own red one.
  const total = kegs.length;
  const filled = kegs.filter(
    (k) => !isUnknownContents(k.contents) && !isDirtyContents(k.contents),
  ).length;
  const empty = kegs.filter((k) => isUnknownContents(k.contents)).length;
  const contents = contentCounts(kegs);

  // Pop the filled (beer) slices outward so the stocked inventory stands out,
  // leaving the empty and dirty slices flush. A small gap still separates every
  // slice.
  const segments: DonutSegment[] = contents.map((c, i) => ({
    value: c.count,
    color:
      c.color ??
      getContentColor(c.contents) ??
      KEG_FALLBACK_COLORS[i % KEG_FALLBACK_COLORS.length]!,
    explode: isDirtyContents(c.contents) ? 0 : 7,
  }));
  if (empty > 0) segments.push({ value: empty, color: EMPTY_KEG_COLOR });

  return (
    <Link
      to="/kegs"
      className="block rounded-xl border border-zinc-800 bg-zinc-900 p-5 transition hover:border-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
    >
      <PanelHeading
        title="Keg Inventory"
        icon={<KegIcon className="h-5 w-5" />}
        right={
          controllable ? (
            <button
              type="button"
              onClick={(e) => {
                // Don't let the click bubble to the card's link — open the sheet instead.
                e.preventDefault();
                e.stopPropagation();
                window.open(SHEETS_VIEW_URL, '_blank', 'noopener,noreferrer');
              }}
              className="text-xs text-zinc-500 transition hover:text-white"
            >
              Inventory sheet ↗
            </button>
          ) : undefined
        }
      />

      {error ? (
        <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      ) : (
        <div className="mt-4 flex items-center gap-5">
          <div className="relative shrink-0">
            <Donut segments={segments} size={132} thickness={20} gap={2} />
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className="text-2xl font-semibold tabular-nums text-zinc-50">
                {loading ? '—' : filled}
              </span>
              <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                of {loading ? '—' : total} filled
              </span>
            </div>
          </div>
          <ul className="min-w-0 flex-1 space-y-1.5">
            {contents.length === 0 && (
              <li className="text-sm text-zinc-600">
                {loading ? 'Reading keg list…' : 'No filled kegs'}
              </li>
            )}
            {contents.slice(0, 6).map((c, i) => {
              const color =
                c.color ??
                getContentColor(c.contents) ??
                KEG_FALLBACK_COLORS[i % KEG_FALLBACK_COLORS.length]!;
              return (
                <li key={c.contents} className="flex items-center gap-2 text-sm">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-zinc-300">{c.contents}</span>
                  <span className="font-semibold tabular-nums text-zinc-100">{c.count}</span>
                </li>
              );
            })}
            {empty > 0 && (
              <li className="flex items-center gap-2 text-sm">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-inset ring-zinc-500"
                  style={{ backgroundColor: EMPTY_KEG_COLOR }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-zinc-400">Empty</span>
                <span className="font-semibold tabular-nums text-zinc-100">{empty}</span>
              </li>
            )}
          </ul>
        </div>
      )}
    </Link>
  );
}

function contentCounts(kegs: Keg[]): { contents: string; count: number; color: string | null }[] {
  const counts = new Map<string, { count: number; color: string | null }>();
  for (const keg of kegs) {
    if (isUnknownContents(keg.contents)) continue;
    const cur = counts.get(keg.contents);
    counts.set(keg.contents, {
      count: (cur?.count ?? 0) + 1,
      color: cur?.color ?? keg.color,
    });
  }
  return [...counts.entries()]
    .map(([contents, { count, color }]) => ({ contents, count, color }))
    .sort((a, b) => b.count - a.count || a.contents.localeCompare(b.contents));
}

// --- Brewing rig ------------------------------------------------------------

/**
 * The brewing rig at a glance: the three vessel temperatures and both pump
 * states, condensed into a rail card. Read-only — clicking it opens the
 * enlarged view (readings plus the session temperature chart), and the controls
 * that change any of it live on the Brew System page.
 *
 * Rides the shared brew-system channel the sidebar's Online/Offline badge
 * already polls, asking it for a brew-day cadence while the Overview is open.
 * The rig is powered off most of the year, so "offline" is an expected state
 * and shows the last readings greyed out rather than an error.
 */
function BrewSystemCard({ onOpen }: { onOpen: () => void }): JSX.Element | null {
  const { status, state } = useBrewSystemLive();

  // Nothing to say until the first answer, and nothing at all on an install
  // with no rig — same rule the sidebar's badge follows.
  if (status == null || !status.configured) return null;

  const online = status.online;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <PanelHeading
        title="Brew System"
        icon={<SlidersIcon className="h-5 w-5" />}
        right={
          <span
            className={`text-xs font-semibold ${online ? 'text-emerald-400' : 'text-red-400'}`}
          >
            {online ? 'Online' : 'Offline'}
          </span>
        }
      />
      <button
        type="button"
        onClick={onOpen}
        className="mt-3 block w-full rounded-lg text-left transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
      >
        <div className={online ? undefined : 'opacity-50'}>
          <div className="grid grid-cols-3 gap-2">
            {VESSELS.map((vessel) => {
              const pot = vessel.pot ? state?.controlState.pots[vessel.pot] : undefined;
              return (
                <div
                  key={vessel.key}
                  className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2 text-center"
                >
                  <div
                    className="text-[11px] font-semibold uppercase tracking-wide"
                    style={{ color: vessel.color }}
                  >
                    {vessel.label}
                  </div>
                  <div className="mt-0.5 text-lg font-semibold tabular-nums text-zinc-50">
                    {formatTemp(state?.temperatures[vessel.key])}
                    <span className="text-xs text-zinc-500">°</span>
                  </div>
                  <div className="truncate text-[10px] text-zinc-500">
                    {pot ? (pot.heaterOn ? `Heat ${Math.round(pot.efficiency)}%` : 'Off') : '—'}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <PumpPill name="Pump 1" pump={state?.controlState.pumps.P1} />
            <PumpPill name="Pump 2" pump={state?.controlState.pumps.P2} />
          </div>
        </div>
      </button>
    </section>
  );
}

/** One pump on the rail card: a lit dot when running, and its duty cycle. */
function PumpPill({ name, pump }: { name: string; pump?: BrewPumpControl }): JSX.Element {
  const on = pump?.on ?? false;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-2.5 py-1.5">
      <span className={`h-2 w-2 shrink-0 rounded-full ${on ? 'bg-sky-400' : 'bg-zinc-700'}`} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">{name}</span>
      <span className="text-xs font-semibold tabular-nums text-zinc-200">
        {on ? `${Math.round(pump?.speed ?? 0)}%` : 'Off'}
      </span>
    </div>
  );
}

// --- Keg fridge -------------------------------------------------------------

/**
 * Compact rail card for the filled-keg fridge Inkbird: its temperature, the
 * cooling/heating state with the current target, a temp sparkline, and an inline
 * setpoint control. Separate from the fermenter station cards — this fridge holds
 * the finished beer, not an active ferment. Greys out when the controller is offline.
 *
 * On a phone the card is cut back to the reading and its target: the sparkline,
 * the Min/Max line and the setpoint control all cost more height than the screen
 * has to give, and tapping the card opens the chart overlay — which carries the
 * same detail, Min/Max included, plus a setpoint control of its own.
 */
function KegFridgeCard({
  device,
  loading,
  onOpen,
  onRefresh,
  compact = false,
}: {
  device: DeviceStatus | null;
  loading: boolean;
  onOpen: OpenChart;
  onRefresh: () => void;
  /** Phone layout: same readings, but tighter padding/spacing to waste less room. */
  compact?: boolean;
}): JSX.Element {
  const colors = useGraphColors();
  const { tempMinSpanC } = useSettings();
  const rangeMs = useChartRange(device?.id ?? null, 'temp_c');
  // The phone card draws no sparkline, so it doesn't pull the history behind one.
  const series = useMetricSeries(compact ? null : device?.id ?? null, 'temp_c', rangeMs);
  const temp = device?.latest.find((r) => r.metric === 'temp_c');
  const setpoint = device?.latest.find((r) => r.metric === 'setpoint_c');
  const state = device?.latest.find((r) => r.metric === 'hvac_state');
  const offline = !device || !device.online;
  const range = tempRangeOf(series, tempMinSpanC);

  return (
    <section className={`rounded-xl border border-zinc-800 bg-zinc-900 ${compact ? 'p-3' : 'p-5'}`}>
      <PanelHeading
        title="Keg Fridge"
        icon={<ThermometerIcon className="h-5 w-5" />}
        // Compact (phone): pull the cooling/heating state up onto the title row.
        right={compact && state ? <StateBadge value={state.value} /> : undefined}
      />
      {offline ? (
        <p className={`flex items-center gap-1.5 text-sm text-zinc-600 ${compact ? 'mt-2' : 'mt-4'}`}>
          <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" aria-hidden />
          {loading ? 'Loading…' : notConnectedNote(device)}
        </p>
      ) : (
        <>
          <button
            type="button"
            onClick={() => onOpen({ deviceId: device.id, metric: 'temp_c', title: 'Keg fridge temperature' })}
            className={`block w-full text-left transition hover:opacity-90 focus:outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-cyan-500 ${
              compact ? 'mt-2' : 'mt-4'
            }`}
          >
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Fridge</p>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="flex items-baseline gap-1.5">
                <span className="text-3xl font-semibold tabular-nums text-zinc-50">
                  {temp ? temp.value.toFixed(1) : '—'}
                </span>
                <span className="text-sm font-medium text-zinc-500">°C</span>
              </span>
              {/* Compact: target sits next to the live temperature instead of its own row. */}
              {compact && setpoint && (
                <span className="text-sm text-zinc-400">
                  Target{' '}
                  <span className="font-semibold tabular-nums text-zinc-200">
                    {setpoint.value.toFixed(1)} °C
                  </span>
                </span>
              )}
            </div>
          </button>
          {/* Desktop rail only: the state/target row, the sparkline with its
              Min/Max, and the inline setpoint. On a phone these live one tap
              away, in the chart overlay the card above opens. */}
          {!compact && (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                {state && <StateBadge value={state.value} />}
                {setpoint && (
                  <span className="text-sm text-zinc-400">
                    Target{' '}
                    <span className="font-semibold tabular-nums text-zinc-200">
                      {setpoint.value.toFixed(1)} °C
                    </span>
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => onOpen({ deviceId: device.id, metric: 'temp_c', title: 'Keg fridge temperature' })}
                className="mt-3 block w-full text-left transition hover:opacity-90 focus:outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-cyan-500"
              >
                <Sparkline data={series} stroke={colors.fridgeTemp} fill={withAlpha(colors.fridgeTemp, 0.1)} height={40} minSpan={tempMinSpanC} />
                {range && <TempRangeLine range={range} rangeMs={rangeMs} />}
              </button>
              <div className="mt-3">
                <SetpointControl
                  deviceId={device.id}
                  setpointC={setpoint?.value ?? null}
                  pendingC={device.pendingSetpointC ?? null}
                  onApplied={onRefresh}
                  variant="inline"
                />
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function latestDeviceTimestamp(devices: DeviceStatus[]): string | null {
  let latest: string | null = null;
  for (const d of devices) {
    if (!d.lastSeenAt) continue;
    if (!latest || Date.parse(d.lastSeenAt) > Date.parse(latest)) latest = d.lastSeenAt;
  }
  return latest;
}

// --- formatting helpers -----------------------------------------------------

/** Known metric-name suffixes -> display unit. */
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
 * Specific gravity is dimensionless and conventionally shown to three decimals
 * with no unit.
 */
function isGravityMetric(metric: string): boolean {
  return metric === 'gravity_sg' || metric.endsWith('_sg');
}

function splitMetric(metric: string): { label: string; unit: string | null } {
  if (isGravityMetric(metric)) return { label: 'Gravity', unit: null };
  // Cumulative totals read clearer with a "Total" qualifier (e.g. the metric
  // selector buttons next to the instantaneous Flow / Power rates). Units are
  // kept so the "Today" / "All-time" values still format with L / kWh.
  if (metric === 'water_l') return { label: 'Total Water', unit: 'L' };
  if (metric === 'energy_kwh') return { label: 'Total Energy', unit: 'kWh' };
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

/**
 * Split a reading into its display number and unit so callers can lay the two
 * out separately. {@link formatValue} joins them back into one string.
 */
export function formatValueParts(r: LatestReading): { value: string; unit: string | null } {
  if (isStateMetric(r.metric)) return { value: stateLook(r.value).label, unit: null };
  if (isGravityMetric(r.metric)) return { value: r.value.toFixed(3), unit: null };
  const { unit } = splitMetric(r.metric);
  const n = Math.abs(r.value) >= 100 ? r.value.toFixed(0) : r.value.toFixed(2);
  return { value: n, unit };
}

export function formatValue(r: LatestReading): string {
  const { value, unit } = formatValueParts(r);
  return unit ? `${value} ${unit}` : value;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- HVAC state metric (cooling / idle / heating) ---------------------------

/**
 * Tri-state metrics rendered as a labelled status pill instead of a raw number.
 * Today that is `hvac_state`, encoded -1 = cooling, 0 = idle, +1 = heating.
 */
export function isStateMetric(metric: string): boolean {
  return metric === 'hvac_state';
}

interface StateLook {
  label: string;
  icon: React.ReactNode;
  cls: string;
}

function stateLook(value: number, size: 'sm' | 'lg' = 'sm'): StateLook {
  if (value <= -0.5)
    return { label: 'Cooling', icon: '❄️', cls: 'bg-sky-500/15 text-sky-300 ring-sky-500/40' };
  if (value >= 0.5)
    return { label: 'Heating', icon: '🔥', cls: 'bg-amber-500/15 text-amber-400 ring-amber-500/40' };
  const pauseSize = size === 'lg' ? 'h-6 w-6' : 'h-4 w-4';
  return {
    label: 'Idle',
    icon: <PauseIcon className={`${pauseSize} text-zinc-200`} />,
    cls: 'bg-zinc-800/60 text-zinc-400 ring-zinc-700/60',
  };
}

/** Short axis-tick label for an hvac_state value. */
export function stateTick(value: number): string {
  return value <= -0.5 ? 'Cool' : value >= 0.5 ? 'Heat' : 'Idle';
}

/**
 * A single colored status pill for the controller's hvac_state, mirroring the
 * Inkbird app: blue while cooling, amber while heating, grey when idle.
 */
export function StateBadge({
  value,
  size = 'sm',
}: {
  value: number;
  size?: 'sm' | 'lg';
}): JSX.Element {
  const look = stateLook(value, size);
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

// relativeTime now lives in ../util; re-exported here so the device pages that
// import it from this module keep working.
export { relativeTime };
