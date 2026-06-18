import type { DeviceStatus, DeviceType, LatestReading, Reading, Recipe } from '@checklist/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import {
  BarSpark,
  Donut,
  type DonutSegment,
  ForecastSparkline,
  MultiLineSparkline,
  RingGauge,
  Sparkline,
} from '../components/charts';
import { DashboardShell } from '../components/DashboardShell';
import { FitScale } from '../components/FitScale';
import { useGraphColors, withAlpha } from '../graphColors';
import {
  BellIcon,
  BoltIcon,
  ChecklistIcon,
  DropletIcon,
  FermenterIcon,
  FlaskIcon,
  GaugeIcon,
  HutIcon,
  KegIcon,
  MonitorIcon,
  ThermometerIcon,
  TodoIcon,
  WrenchIcon,
} from '../components/icons';
import { MetricModal } from '../components/MetricModal';
import {
  type Keg,
  SHEETS_VIEW_URL,
  getContentColor,
  isUnknownContents,
  useKegs,
} from '../kegs';
import {
  type GravityPoint,
  estimateDoneTime,
  fitGravityDecay,
  forecastSeries,
} from '../gravityForecast';
import { SetpointControl } from '../SetpointControl';
import { formatPressure, useSettings } from '../settings';
import { ChartRangeProvider, useChartRange } from '../chartRange';
import { RANGES, useDeviceTotal, useMetricSeries, useMetricSeriesT } from '../useDeviceData';
import { relativeTime } from '../util';

const KEG_POLL_MS = 60_000;
const FERMENT_POLL_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How much gravity history feeds the forecast fit (compressed into the left half). */
const GRAVITY_HISTORY_MS = 14 * DAY_MS;
/** How far the dashed forecast tail extends past "now". */
const GRAVITY_FORECAST_MS = 2 * DAY_MS;
/** Spacing of sampled points along the forecast curve. */
const GRAVITY_FORECAST_STEP_MS = 2 * 60 * 60 * 1000;

type IconComponent = (props: { className?: string }) => JSX.Element;

/** Device-type → the dashboard's monochrome line icon, for the fleet list. */
const TYPE_ICON: Record<DeviceType, IconComponent> = {
  pressure_sensor: GaugeIcon,
  brew_controller: ThermometerIcon,
  power_meter: BoltIcon,
  water_meter: DropletIcon,
  hydrometer: FlaskIcon,
  other: MonitorIcon,
};

const TYPE_LABEL: Record<DeviceType, string> = {
  pressure_sensor: 'Pressure',
  // The brew controller is an Inkbird and the hydrometer is a Tilt — label them
  // by the device brand the brewer recognises.
  brew_controller: 'Inkbird',
  power_meter: 'Power',
  water_meter: 'Water',
  hydrometer: 'Tilt',
  other: 'Sensor',
};

function isBreweryTempDevice(device: DeviceStatus): boolean {
  return device.type === 'brew_controller' && /brewery|ambient/i.test(device.name);
}

function isFermenterDevice(device: DeviceStatus): boolean {
  return (
    device.type === 'pressure_sensor' ||
    device.type === 'hydrometer' ||
    (device.type === 'brew_controller' && !isBreweryTempDevice(device))
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

function fermentationDone(history: Reading[], windowMs: number, thresholdSg: number): boolean {
  const windowStart = Date.now() - windowMs;
  const recent = history.filter((r) => Date.parse(r.recordedAt) >= windowStart);
  if (recent.length < 2) return false;
  const times = recent.map((r) => Date.parse(r.recordedAt));
  if (Math.max(...times) - Math.min(...times) < windowMs * 0.8) return false;
  const values = recent.map((r) => r.value);
  return Math.max(...values) - Math.min(...values) <= thresholdSg;
}

interface FermentStatus {
  label: string;
  dotClass: string;
  textClass: string;
  shellClass: string;
}

function useFermentStatus(devices: DeviceStatus[]): FermentStatus {
  const { fermentStableDays, fermentThresholdSg } = useSettings();
  const windowMs = fermentStableDays * 24 * 60 * 60 * 1000;
  const lookbackMs = windowMs + 12 * 60 * 60 * 1000;
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
        const since = new Date(Date.now() - lookbackMs).toISOString();
        const history = await api.getDeviceHistory(gravityDeviceId, {
          metric: 'gravity_sg',
          since,
          limit: 2000,
        });
        if (!cancelled) setDone(fermentationDone(history, windowMs, fermentThresholdSg));
      } catch {
        // Keep the last known verdict through transient history failures.
      }
    };
    void check();
    const id = setInterval(() => void check(), FERMENT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [gravityDeviceId, windowMs, lookbackMs, fermentThresholdSg]);

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
  if (value < 0) return 'text-sky-300';
  if (value > 0) return 'text-amber-300';
  return 'text-zinc-300';
}

// --- Derived alerts ---------------------------------------------------------

interface Alert {
  id: string;
  severity: 'critical' | 'warning';
  title: string;
  detail: string;
}

/**
 * There is no alerts backend yet, so the Alerts feed is derived live from
 * device state: any offline sensor is a critical alert. The count drives the
 * sidebar badge.
 */
function deriveAlerts(devices: DeviceStatus[]): Alert[] {
  const alerts: Alert[] = [];
  for (const d of devices) {
    if (!d.online) {
      alerts.push({
        id: `offline-${d.id}`,
        severity: 'critical',
        title: `${d.name} offline`,
        detail: `${TYPE_LABEL[d.type]} sensor hasn't reported recently.`,
      });
    }
  }
  return alerts;
}

/** A metric the user clicked to enlarge in the chart overlay. */
interface ChartTarget {
  deviceId: number;
  metric?: string;
  title: string;
}

/** Opens the enlarge-on-click chart overlay for a metric. */
type OpenChart = (target: ChartTarget) => void;

/**
 * The hub landing page at `/`. A desktop "command centre": the fermenter and
 * utilities live in the main column, with keg inventory, operations, the device
 * fleet and a derived alerts feed in the right rail. A persistent sidebar
 * ([DashboardShell]) wraps it.
 */
export function DashboardPage(): JSX.Element {
  const [devices, setDevices] = useState<DeviceStatus[] | null>(null);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chart, setChart] = useState<ChartTarget | null>(null);
  const { dashboardRefreshSec } = useSettings();
  const { kegs, loading: kegsLoading, error: kegsError } = useKegs(KEG_POLL_MS);
  const openChart = useCallback((target: ChartTarget) => setChart(target), []);

  const load = useCallback(async () => {
    try {
      const [d, r] = await Promise.all([
        api.listDevices(),
        api.getActiveRecipe().catch(() => null),
      ]);
      setDevices(d);
      setRecipe(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load devices');
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), dashboardRefreshSec * 1000);
    return () => clearInterval(id);
  }, [load, dashboardRefreshSec]);

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

  const alerts = deriveAlerts(deviceList);
  const lastUpdate = latestDeviceTimestamp(deviceList);

  const brewery = deviceList.find(isBreweryTempDevice) ?? null;
  const power = deviceList.find((d) => d.type === 'power_meter') ?? null;
  const water = deviceList.find((d) => d.type === 'water_meter') ?? null;
  const utilityOnline = [brewery, power, water].filter((d) => d?.online).length;
  const utilityTotal = [brewery, power, water].filter(Boolean).length;

  return (
    <ChartRangeProvider>
    <DashboardShell active="overview" alertCount={alerts.length} lastUpdate={lastUpdate} fit>
      <FitScale className="w-full max-w-[1580px]">
      <main className="w-full px-5 py-5 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
        {error && (
          <div className="mb-5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="grid gap-5 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_23rem] xl:grid-rows-[minmax(0,1fr)]">
          <div className="min-w-0 space-y-5 xl:flex xl:min-h-0 xl:flex-col">
            <section id="fermenter" className="scroll-mt-5 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
              {devices === null ? (
                <LoadingPanel label="Loading fermenter…" />
              ) : stationGroups.length === 0 ? (
                <EmptyPanel
                  title="No fermenter station yet"
                  body="Register pressure, controller, or hydrometer devices with the same fermenter name and they will group here."
                />
              ) : (
                <div className="space-y-5 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
                  {stationGroups.map((group) => (
                    <FermenterCommandCenter
                      key={group[0]!.name}
                      name={group[0]!.name}
                      devices={group}
                      recipe={recipe}
                      onRefresh={load}
                      onOpen={openChart}
                    />
                  ))}
                </div>
              )}
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

          <aside className="space-y-5 xl:flex xl:min-h-0 xl:flex-col">
            <KegInventoryPanel kegs={kegs} loading={kegsLoading} error={kegsError} />
            <OperationsPanel />
            <DeviceFleetPanel devices={deviceList} loading={devices === null} />
            <AlertsPanel alerts={alerts} loading={devices === null} />
          </aside>
        </div>
      </main>
      </FitScale>

      {chart && (
        <MetricModal
          deviceId={chart.deviceId}
          metric={chart.metric}
          title={chart.title}
          onClose={() => setChart(null)}
        />
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

function FermenterCommandCenter({
  name,
  devices,
  recipe,
  onRefresh,
  onOpen,
}: {
  name: string;
  devices: DeviceStatus[];
  recipe: Recipe | null;
  onRefresh: () => void;
  onOpen: OpenChart;
}): JSX.Element {
  const { pressureUnit, fermentStableDays, fermentThresholdSg } = useSettings();
  const colors = useGraphColors();
  const status = useFermentStatus(devices);
  const pressure = findReading(devices, 'pressure_bar');
  const beer = findReading(devices, 'temp_c', 'hydrometer');
  const fridge = findReading(devices, 'temp_c', 'brew_controller');
  const setpoint = findReading(devices, 'setpoint_c', 'brew_controller');
  const state = findReading(devices, 'hvac_state', 'brew_controller');
  const gravity = findReading(devices, 'gravity_sg');
  const controller = devices.find((d) => d.type === 'brew_controller' && !isBreweryTempDevice(d));
  const online = devices.filter((d) => d.online).length;
  const gravityHistory = useMetricSeriesT(gravity?.deviceId ?? null, 'gravity_sg', GRAVITY_HISTORY_MS);
  // Each preview tracks the window picked in its own enlarged chart. The temp
  // card shows beer + fridge together, so both share the window of the chart its
  // combined view opens (the fridge device, or the beer device when no fridge).
  const pressureRangeMs = useChartRange(pressure?.deviceId ?? null, 'pressure_bar');
  const tempRangeMs = useChartRange((fridge ?? beer)?.deviceId ?? null, 'temp_c');
  const pressureSeries = useMetricSeries(pressure?.deviceId ?? null, 'pressure_bar', pressureRangeMs);
  const tempSeries = useMetricSeries(beer?.deviceId ?? null, 'temp_c', tempRangeMs);
  const fridgeSeries = useMetricSeries(fridge?.deviceId ?? null, 'temp_c', tempRangeMs);

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
      ? { min: Math.min(...tempValues), max: Math.max(...tempValues) }
      : null;

  return (
    <article className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-5 py-4 xl:shrink-0">
        <div className="flex min-w-0 shrink-0 items-center gap-3">
          <FermenterIcon className="h-11 w-11 shrink-0 text-white" strokeWidth={2.6} />
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold uppercase tracking-wide text-white">
              {name}
            </h2>
            {recipe ? (
              <Link
                to="/kiosk/recipes"
                className="block truncate text-sm text-zinc-500 transition hover:text-white"
                title="Change recipe"
              >
                {recipe.name}
                {recipe.style ? ` (${recipe.style})` : ''}
              </Link>
            ) : (
              <Link
                to="/kiosk/recipes"
                className="mt-1 inline-flex items-center gap-1 rounded-lg border border-white/30 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-white/20"
              >
                <span className="text-sm leading-none" aria-hidden>
                  +
                </span>
                Link Recipe
              </Link>
            )}
          </div>
        </div>
        {controller && (
          <div className="min-w-0 flex-1">
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

      <div className="grid gap-4 p-5 md:grid-cols-3 xl:min-h-0 xl:flex-1 xl:grid-rows-[minmax(0,1fr)]">
        <FermenterSubCard
          icon={<GaugeIcon className="h-6 w-6" />}
          title="Pressure"
          onClick={
            pressure
              ? () => onOpen({ deviceId: pressure.deviceId, metric: 'pressure_bar', title: `${name} · Pressure` })
              : undefined
          }
        >
          {pressure ? (
            <>
              <div className="mt-3">
                <BigValue {...formatPressure(pressure.reading.value, pressureUnit)} />
              </div>
              <div className="mt-3 flex-1 min-h-[12rem] xl:min-h-0">
                <MiniChartFrame
                  max={pressureRange ? formatPressure(pressureRange.max, pressureUnit).value : undefined}
                  min={pressureRange ? formatPressure(pressureRange.min, pressureUnit).value : undefined}
                  caption={pressureRange ? rangeCaption(pressureRangeMs) : undefined}
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
              {beer ? (
                <MetricButton
                  onClick={() => onOpen({ deviceId: beer.deviceId, metric: 'temp_c', title: `${name} · Beer temperature` })}
                >
                  <TemperatureValue reading={beer.reading} />
                </MetricButton>
              ) : (
                <MissingMetric label="No beer temp" compact />
              )}
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Fridge</p>
              {fridge ? (
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
              <div className="mt-2 flex-1 min-h-[12rem] xl:min-h-0">
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
                    caption={tempRange ? rangeCaption(tempRangeMs) : undefined}
                  >
                    <MultiLineSparkline
                      series={[
                        ...(beer ? [{ data: tempSeries, stroke: colors.beerTemp }] : []),
                        ...(fridge ? [{ data: fridgeSeries, stroke: colors.fridgeTemp, dashed: true }] : []),
                      ]}
                      refLine={setpoint ? { value: setpoint.reading.value, stroke: colors.setpoint } : undefined}
                      grow
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
          onClick={
            gravity
              ? () => onOpen({ deviceId: gravity.deviceId, metric: 'gravity_sg', title: `${name} · Gravity` })
              : undefined
          }
        >
          {gravity ? (
            <>
              <div className="mt-3">
                <BigValue value={gravity.reading.value.toFixed(3)} unit="SG" />
              </div>
              <div className="mt-3 flex-1 min-h-[12rem] xl:min-h-0">
                {gravityValues.length > 1 ? (
                  <MiniChartFrame
                    max={gravityRange ? gravityRange.max.toFixed(3) : undefined}
                    min={gravityRange ? gravityRange.min.toFixed(3) : undefined}
                    caption={gravityForecast != null ? 'Last 48h' : 'Recent trend'}
                    captionRight={gravityForecast != null ? '2-day forecast' : undefined}
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
  children,
}: {
  icon: React.ReactNode;
  title: string;
  onClick?: () => void;
  /** Optional element pinned to the top-right of the card head (e.g. a status pill). */
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  const base = 'flex flex-col rounded-xl border border-zinc-800 bg-zinc-950/40 p-4 text-left';
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

/** Min/max of a series, or null when there aren't enough points to draw a line. */
function minMax(data: number[]): { min: number; max: number } | null {
  if (data.length < 2) return null;
  return { min: Math.min(...data), max: Math.max(...data) };
}

/** Caption for a windowed preview, e.g. "Last 24h" — tracks the chosen range. */
function rangeCaption(rangeMs: number): string {
  return `Last ${RANGES.find((r) => r.ms === rangeMs)?.label ?? '24h'}`;
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
  caption?: string;
  /** Optional second caption pinned to the right — e.g. a forecast-tail label. */
  captionRight?: string;
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
        <div className="mt-1 flex items-baseline justify-between gap-2 text-xs font-medium leading-none text-white">
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
}: {
  brewery: DeviceStatus | null;
  power: DeviceStatus | null;
  water: DeviceStatus | null;
  online: number;
  total: number;
  loading: boolean;
  onOpen: OpenChart;
}): JSX.Element {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <PanelHeading
        title="Brewery & Utilities"
        icon={<HutIcon className="h-7 w-7" />}
        right={total > 0 ? <SensorsOnlinePill online={online} total={total} /> : undefined}
        large
      />
      {loading ? (
        <p className="mt-4 text-sm text-zinc-400">Loading utilities…</p>
      ) : (
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <BreweryTempCard device={brewery} onOpen={onOpen} />
          <PowerCard device={power} onOpen={onOpen} />
          <WaterCard device={water} onOpen={onOpen} />
        </div>
      )}
    </section>
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
}: {
  icon: React.ReactNode;
  title: string;
}): JSX.Element {
  return (
    <div className="flex h-full flex-col rounded-xl border border-dashed border-zinc-800 bg-zinc-950/30 p-4">
      <div className="flex items-center gap-2 text-zinc-300 opacity-70">
        {icon}
        <h3 className="font-semibold text-zinc-300">{title}</h3>
      </div>
      <p className="mt-6 text-sm text-zinc-600">Not connected yet</p>
    </div>
  );
}

function BreweryTempCard({
  device,
  onOpen,
}: {
  device: DeviceStatus | null;
  onOpen: OpenChart;
}): JSX.Element {
  const series = useMetricSeries(device?.id ?? null, 'temp_c', useChartRange(device?.id ?? null, 'temp_c'));
  const colors = useGraphColors();
  if (!device) {
    return <UtilityPlaceholder icon={<ThermometerIcon className="h-5 w-5" />} title="Temperature" />;
  }
  const temp = device.latest.find((r) => r.metric === 'temp_c');
  const range = minMax(series);
  return (
    <UtilityCardButton
      onClick={() => onOpen({ deviceId: device.id, metric: 'temp_c', title: 'Brewery ambient temperature' })}
    >
      <UtilityShell icon={<ThermometerIcon className="h-5 w-5" />} title="Temperature">
        <p className="mt-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
          Ambient Temp
        </p>
        <div className="mt-1 flex items-baseline gap-1.5">
          <span className="text-2xl font-semibold tabular-nums text-zinc-50">
            {temp ? temp.value.toFixed(1) : '—'}
          </span>
          <span className="text-sm font-medium text-zinc-500">°C</span>
        </div>
        <div className="mt-3">
          <Sparkline data={series} stroke={colors.fridgeTemp} fill={withAlpha(colors.fridgeTemp, 0.1)} height={40} />
        </div>
        {range && (
          <p className="mt-3 text-xs text-zinc-500">
            Min{' '}
            <span className="font-semibold tabular-nums text-zinc-300">{range.min.toFixed(1)} °C</span>
            {'  ·  Max '}
            <span className="font-semibold tabular-nums text-zinc-300">{range.max.toFixed(1)} °C</span>
          </p>
        )}
      </UtilityShell>
    </UtilityCardButton>
  );
}

function PowerCard({
  device,
  onOpen,
}: {
  device: DeviceStatus | null;
  onOpen: OpenChart;
}): JSX.Element {
  const series = useMetricSeries(device?.id ?? null, 'power_w', useChartRange(device?.id ?? null, 'power_w'));
  const total = useDeviceTotal(device?.id ?? -1, device ? 'energy_kwh' : undefined);
  const colors = useGraphColors();
  if (!device) return <UtilityPlaceholder icon={<BoltIcon className="h-5 w-5" />} title="Power" />;
  const current = device.latest.find((r) => r.metric === 'power_w');
  const today = device.latest.find((r) => r.metric === 'energy_kwh');
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
}: {
  device: DeviceStatus | null;
  onOpen: OpenChart;
}): JSX.Element {
  const series = useMetricSeries(device?.id ?? null, 'flow_lpm', useChartRange(device?.id ?? null, 'flow_lpm'));
  const total = useDeviceTotal(device?.id ?? -1, device ? 'water_l' : undefined);
  const colors = useGraphColors();
  if (!device) return <UtilityPlaceholder icon={<DropletIcon className="h-5 w-5" />} title="Water" />;
  const current = device.latest.find((r) => r.metric === 'flow_lpm');
  const today = device.latest.find((r) => r.metric === 'water_l');
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

function KegInventoryPanel({
  kegs,
  loading,
  error,
}: {
  kegs: Keg[];
  loading: boolean;
  error: string | null;
}): JSX.Element {
  const filled = kegs.filter((k) => !isUnknownContents(k.contents)).length;
  const total = kegs.length;
  const empty = total - filled;
  const contents = contentCounts(kegs);

  // Pop the filled (beer) slices outward so the stocked inventory stands out,
  // leaving the empty slice flush. A small gap still separates every slice.
  const segments: DonutSegment[] = contents.map((c, i) => ({
    value: c.count,
    color:
      c.color ??
      getContentColor(c.contents) ??
      KEG_FALLBACK_COLORS[i % KEG_FALLBACK_COLORS.length]!,
    explode: 7,
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

// --- Operations -------------------------------------------------------------

function OperationsPanel(): JSX.Element {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <PanelHeading title="Operations" icon={<WrenchIcon className="h-5 w-5" />} />
      <div className="mt-3 grid gap-2">
        <AppLink to="/admin" icon={<ChecklistIcon className="h-5 w-5" />} title="Brew Checklist" />
        <AppLink to="/todos" icon={<TodoIcon className="h-5 w-5" />} title="Brewery To-Do" />
      </div>
    </section>
  );
}

function AppLink({
  to,
  icon,
  title,
  subtitle,
}: {
  to: string;
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
}): JSX.Element {
  return (
    <Link
      to={to}
      className="flex items-center gap-3 rounded-lg border border-zinc-800 px-3 py-2 transition hover:border-zinc-700 hover:bg-zinc-800/60"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-white">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-zinc-100">{title}</span>
        {subtitle && <span className="block truncate text-sm text-zinc-500">{subtitle}</span>}
      </span>
      <span className="text-zinc-600" aria-hidden>
        ›
      </span>
    </Link>
  );
}

// --- Device fleet -----------------------------------------------------------

interface FleetGroup {
  key: string;
  type: DeviceType;
  name: string;
  count: number;
  online: number;
}

/**
 * Top-down order of the Device Fleet list: pressure, fermenter temperature,
 * gravity, brewery temperature, power, water. The two Inkbirds share the
 * `brew_controller` type, so they're split by name (brewery/ambient sorts after
 * the fermenter controller and after gravity).
 */
function fleetRank(group: FleetGroup): number {
  switch (group.type) {
    case 'pressure_sensor':
      return 0;
    case 'brew_controller':
      return /brewery|ambient/i.test(group.name) ? 3 : 1;
    case 'hydrometer':
      return 2;
    case 'power_meter':
      return 4;
    case 'water_meter':
      return 5;
    default:
      return 6;
  }
}

function fleetGroups(devices: DeviceStatus[]): FleetGroup[] {
  const map = new Map<string, FleetGroup>();
  for (const d of devices) {
    const key = `${d.type}|${d.name}`;
    const g = map.get(key);
    if (g) {
      g.count += 1;
      if (d.online) g.online += 1;
    } else {
      map.set(key, { key, type: d.type, name: d.name, count: 1, online: d.online ? 1 : 0 });
    }
  }
  return [...map.values()].sort(
    (a, b) => fleetRank(a) - fleetRank(b) || a.name.localeCompare(b.name),
  );
}

function DeviceFleetPanel({
  devices,
  loading,
}: {
  devices: DeviceStatus[];
  loading: boolean;
}): JSX.Element {
  const online = devices.filter((d) => d.online).length;
  const total = devices.length;
  const allUp = total > 0 && online === total;
  const groups = fleetGroups(devices);

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <PanelHeading
        title="Device Fleet"
        icon={<MonitorIcon className="h-5 w-5" />}
        right={
          <Link to="/devices" className="text-xs text-zinc-500 transition hover:text-white">
            All devices ↗
          </Link>
        }
      />
      <div className="mt-4 flex items-center gap-5">
        <div className="relative shrink-0">
          <RingGauge
            value={online}
            max={total}
            size={120}
            color={allUp ? '#22c55e' : '#f59e0b'}
          />
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="text-2xl font-semibold tabular-nums text-zinc-50">
              {loading ? '—' : online}
            </span>
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
              of {loading ? '—' : total} online
            </span>
          </div>
        </div>
        <ul className="min-w-0 flex-1 space-y-1.5">
          {groups.length === 0 && (
            <li className="text-sm text-zinc-600">{loading ? 'Loading fleet…' : 'No devices'}</li>
          )}
          {groups.map((g) => {
            const Icon = TYPE_ICON[g.type];
            return (
              <li key={g.key} className="flex items-center gap-2.5 text-sm">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-zinc-300">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1 truncate text-zinc-300">
                  {TYPE_LABEL[g.type]} <span className="text-zinc-500">({g.name})</span>
                </span>
                {g.count > 1 && <span className="tabular-nums text-zinc-500">{g.count}</span>}
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    g.online === g.count ? 'bg-emerald-400' : g.online === 0 ? 'bg-zinc-600' : 'bg-amber-400'
                  }`}
                  aria-hidden
                />
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

// --- Alerts -----------------------------------------------------------------

function AlertsPanel({ alerts, loading }: { alerts: Alert[]; loading: boolean }): JSX.Element {
  return (
    <section
      id="alerts"
      // Floor (instead of min-h-0) so the panel can't silently collapse to
      // nothing on short screens: it keeps a real height, which lets the column
      // genuinely overflow and the dashboard's fit-scaler shrink everything to
      // fit. On roomy screens flex-1 still grows it to fill the slack.
      className="scroll-mt-5 rounded-xl border border-zinc-800 bg-zinc-900 p-5 xl:flex xl:min-h-[7rem] xl:flex-1 xl:flex-col"
    >
      <PanelHeading
        title="Alerts"
        icon={<BellIcon className="h-5 w-5" />}
        right={
          alerts.length > 0 ? (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-zinc-950">
              {alerts.length}
            </span>
          ) : undefined
        }
      />
      {loading ? (
        <p className="mt-3 text-sm text-zinc-500">Loading…</p>
      ) : alerts.length === 0 ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-zinc-500">
          <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden />
          No active alerts
        </p>
      ) : (
        <ul className="mt-3 space-y-2 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1">
          {alerts.map((a) => (
            <li
              key={a.id}
              className={`rounded-lg border px-3 py-2 text-sm ${
                a.severity === 'critical'
                  ? 'border-red-500/30 bg-red-500/10'
                  : 'border-amber-500/30 bg-amber-500/10'
              }`}
            >
              <p
                className={`font-semibold ${
                  a.severity === 'critical' ? 'text-red-300' : 'text-amber-200'
                }`}
              >
                {a.title}
              </p>
              <p className="mt-0.5 text-zinc-400">{a.detail}</p>
            </li>
          ))}
        </ul>
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
  icon: string;
  cls: string;
}

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

// relativeTime now lives in ../util; re-exported here so the device pages that
// import it from this module keep working.
export { relativeTime };
