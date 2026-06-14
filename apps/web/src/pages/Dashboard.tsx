import type { DeviceStatus, DeviceType, LatestReading, Reading, Recipe } from '@checklist/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import {
  type Keg,
  getContentColor,
  isUnknownContents,
  useKegs,
} from '../kegs';
import { SetpointControl } from '../SetpointControl';
import { formatPressure, useSettings } from '../settings';
import { cumulativeMetricOf, useDeviceTotal } from '../useDeviceData';

/** Refresh device status often enough to feel live without hammering the Pi. */
const POLL_MS = 10000;
const KEG_POLL_MS = 60_000;
const FERMENT_POLL_MS = 60_000;

const TYPE_ICON: Record<DeviceType, string> = {
  pressure_sensor: '📈',
  brew_controller: '🎛️',
  power_meter: '⚡',
  water_meter: '🚰',
  hydrometer: '🍷',
  other: '📡',
};

const TYPE_LABEL: Record<DeviceType, string> = {
  pressure_sensor: 'Pressure',
  brew_controller: 'Controller',
  power_meter: 'Power',
  water_meter: 'Water',
  hydrometer: 'Hydrometer',
  other: 'Sensor',
};

/**
 * Sensors on the roadmap but not yet wired to hardware. A placeholder
 * disappears automatically once a live device that covers it starts reporting.
 */
interface PlannedSensor {
  icon: string;
  title: string;
  subtitle: string;
  covered: (devices: DeviceStatus[]) => boolean;
}

const hasType = (devices: DeviceStatus[], type: DeviceType): boolean =>
  devices.some((d) => d.type === type);

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

const PLANNED_SENSORS: PlannedSensor[] = [
  {
    icon: TYPE_ICON.power_meter,
    title: 'Electricity',
    subtitle: 'Power and energy usage (W, kWh)',
    covered: (d) => hasType(d, 'power_meter'),
  },
  {
    icon: TYPE_ICON.water_meter,
    title: 'Water',
    subtitle: 'Flow and total usage (L/min, L)',
    covered: (d) => hasType(d, 'water_meter'),
  },
  {
    icon: '🌡️',
    title: 'Brewery Temperature',
    subtitle: 'Ambient temperature from the room controller',
    covered: (d) =>
      d.some((x) => x.type === 'brew_controller' && /brewery|ambient/i.test(x.name)),
  },
  {
    icon: TYPE_ICON.hydrometer,
    title: 'Fermentation Gravity',
    subtitle: 'Specific gravity and beer temperature from the Tilt',
    covered: (d) => hasType(d, 'hydrometer'),
  },
];

const TYPE_RANK: Record<DeviceType, number> = {
  pressure_sensor: 0,
  hydrometer: 1,
  brew_controller: 2,
  other: 3,
  power_meter: 4,
  water_meter: 5,
};

const HEADLINE_ORDER = [
  'pressure_bar',
  'temp_c',
  'gravity_sg',
  'power_w',
  'flow_lpm',
  'water_l',
  'energy_kwh',
  'setpoint_c',
  'hvac_state',
];

const METRIC_CAPTION: Record<string, string> = {
  power_w: 'Current',
  energy_kwh: 'Today',
  flow_lpm: 'Current',
  water_l: 'Today',
  setpoint_c: 'Setpoint',
  hvac_state: 'Mode',
};

function metricRank(metric: string): number {
  const i = HEADLINE_ORDER.indexOf(metric);
  return i === -1 ? HEADLINE_ORDER.length : i;
}

function orderedMetrics(latest: LatestReading[]): LatestReading[] {
  return [...latest].sort((a, b) => metricRank(a.metric) - metricRank(b.metric));
}

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
  hint: string;
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
      hint: 'No fermenter devices have checked in recently',
      dotClass: 'bg-zinc-500',
      textClass: 'text-zinc-400',
      shellClass: 'border-zinc-700 bg-zinc-900 text-zinc-300',
    };
  }
  if (gravityDeviceId == null) {
    return {
      label: 'Online',
      hint: 'Gravity is not connected, so completion cannot be inferred',
      dotClass: 'bg-emerald-400',
      textClass: 'text-emerald-300',
      shellClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
    };
  }
  if (done) {
    return {
      label: 'Complete',
      hint: 'Gravity has held steady inside the configured window',
      dotClass: 'bg-emerald-400',
      textClass: 'text-emerald-300',
      shellClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
    };
  }
  return {
    label: 'Fermenting',
    hint: 'Gravity is still moving or the stable window is not complete',
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

/**
 * The hub landing page at `/`. On desktop this is an equipment overview, not a
 * generic card grid: fermenter-related devices are grouped into station cards,
 * while kegs, apps, ambient sensors and utility meters get their own areas.
 */
export function DashboardPage(): JSX.Element {
  const { auth, refresh: refreshAuth } = useAuth();
  const [devices, setDevices] = useState<DeviceStatus[] | null>(null);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { kegs, loading: kegsLoading, error: kegsError } = useKegs(KEG_POLL_MS);

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
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const deviceList = devices ?? [];
  const groups = groupByName(deviceList);
  const stationGroups = groups
    .filter(isStationGroup)
    .sort((a, b) => groupRank(a) - groupRank(b) || a[0]!.name.localeCompare(b[0]!.name));
  const stationIds = new Set(stationGroups.flat().map((d) => d.id));
  const equipmentDevices = deviceList
    .filter((d) => !stationIds.has(d.id))
    .sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type] || a.name.localeCompare(b.name));
  const plannedSensors = devices ? PLANNED_SENSORS.filter((p) => !p.covered(devices)) : [];
  const onlineCount = deviceList.filter((d) => d.online).length;

  return (
    <div className="min-h-full bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1580px] items-center justify-between gap-4 px-5 py-4">
          <div>
            <div className="flex items-center gap-3">
              <span className="text-2xl" aria-hidden>
                🍺
              </span>
              <h1 className="text-xl font-semibold tracking-tight">Konfus Brewing</h1>
            </div>
            <p className="mt-1 text-sm text-zinc-400">
              Desktop brewery overview - fermenter, kegs, utilities and operations
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-400 sm:block">
              <span className="font-semibold text-zinc-100">{onlineCount}</span> /{' '}
              {deviceList.length} devices online
            </div>
            {auth.user && (
              <div className="flex items-center gap-3 text-sm">
                <span className="hidden text-zinc-400 sm:inline">
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
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1580px] px-5 py-5">
        {error && (
          <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-5">
            <section>
              <SectionHeader
                title="Fermentation"
                subtitle="All fermenter readings are grouped by equipment, not by sensor."
              />

              {devices === null ? (
                <LoadingPanel label="Loading fermenters..." />
              ) : stationGroups.length === 0 ? (
                <EmptyPanel
                  title="No fermenter station yet"
                  body="Register pressure, controller, or hydrometer devices with the same fermenter name and they will group here."
                />
              ) : (
                <div className="grid gap-4">
                  {stationGroups.map((group) => (
                    <FermenterStationCard
                      key={group[0]!.name}
                      name={group[0]!.name}
                      devices={group}
                      recipe={recipe}
                      onRefresh={load}
                    />
                  ))}
                </div>
              )}
            </section>

            <section>
              <SectionHeader
                title="Brewery And Utilities"
                subtitle="Ambient temperature, power, water and other non-fermenter sensors."
              />
              {devices === null ? (
                <LoadingPanel label="Loading equipment..." />
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {equipmentDevices.map((d) => (
                      <EquipmentDeviceCard key={d.id} device={d} />
                    ))}
                    {plannedSensors.map((p) => (
                      <PlannedTile key={p.title} sensor={p} />
                    ))}
                  </div>
                  {deviceList.length === 0 && (
                    <p className="mt-3 text-xs text-zinc-500">
                      No live devices yet. Register one on the Pi with{' '}
                      <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
                        npm run device -- add "Fermenter" pressure_sensor
                      </code>{' '}
                      and point its agent at this server.
                    </p>
                  )}
                </>
              )}
            </section>
          </div>

          <aside className="space-y-4">
            <KegStatusPanel kegs={kegs} loading={kegsLoading} error={kegsError} />
            <OperationsPanel />
            <FleetPanel devices={deviceList} loading={devices === null} />
          </aside>
        </div>
      </main>
    </div>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }): JSX.Element {
  return (
    <div className="mb-2">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">{title}</h2>
      <p className="mt-0.5 text-sm text-zinc-500">{subtitle}</p>
    </div>
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

function FermenterStationCard({
  name,
  devices,
  recipe,
  onRefresh,
}: {
  name: string;
  devices: DeviceStatus[];
  recipe: Recipe | null;
  onRefresh: () => void;
}): JSX.Element {
  const { pressureUnit } = useSettings();
  const status = useFermentStatus(devices);
  const pressure = findReading(devices, 'pressure_bar');
  const beer = findReading(devices, 'temp_c', 'hydrometer');
  const fridge = findReading(devices, 'temp_c', 'brew_controller');
  const setpoint = findReading(devices, 'setpoint_c', 'brew_controller');
  const state = findReading(devices, 'hvac_state', 'brew_controller');
  const gravity = findReading(devices, 'gravity_sg');
  const controller = devices.find((d) => d.type === 'brew_controller' && !isBreweryTempDevice(d));
  const online = devices.filter((d) => d.online).length;
  const lastSeen = latestDeviceTimestamp(devices);

  return (
    <article className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 text-lg"
              aria-hidden
            >
              {TYPE_ICON.pressure_sensor}
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-xl font-semibold tracking-tight text-zinc-50">{name}</h3>
              <p className="truncate text-sm text-zinc-500">
                {recipe ? `${recipe.name}${recipe.style ? ` - ${recipe.style}` : ''}` : 'No active recipe selected'}
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-semibold ${status.shellClass}`}
            title={status.hint}
          >
            <span className={`h-2.5 w-2.5 rounded-full ${status.dotClass}`} aria-hidden />
            {status.label}
          </span>
          <span className="rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-400">
            {online} / {devices.length} sensors online
          </span>
        </div>
      </div>

      <div className="grid gap-0 divide-y divide-zinc-800 lg:grid-cols-[1fr_1.7fr_1fr] lg:divide-x lg:divide-y-0">
        <StationMetricBlock title="Pressure">
          {pressure ? (
            <LinkedMetric to={`/devices/${pressure.deviceId}`}>
              <BigValue {...formatPressure(pressure.reading.value, pressureUnit)} />
              <MetricTimestamp iso={pressure.reading.recordedAt} />
            </LinkedMetric>
          ) : (
            <MissingMetric label="No pressure sensor" />
          )}
        </StationMetricBlock>

        <StationMetricBlock title="Temperature And Control">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Beer</p>
              {beer ? (
                <LinkedMetric to={`/devices/${beer.deviceId}`}>
                  <TemperatureValue reading={beer.reading} />
                  <MetricTimestamp iso={beer.reading.recordedAt} />
                </LinkedMetric>
              ) : (
                <MissingMetric label="No beer temperature" compact />
              )}
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Fridge</p>
              {fridge ? (
                <LinkedMetric to={`/devices/${fridge.deviceId}`}>
                  <TemperatureValue
                    reading={fridge.reading}
                    valueClass={state ? hvacColor(state.reading.value) : undefined}
                  />
                  <MetricTimestamp iso={fridge.reading.recordedAt} />
                </LinkedMetric>
              ) : (
                <MissingMetric label="No fridge temperature" compact />
              )}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-zinc-400">
            {state && <StateBadge value={state.reading.value} />}
            {setpoint && (
              <span>
                Target{' '}
                <span className="font-semibold tabular-nums text-zinc-200">
                  {setpoint.reading.value.toFixed(1)} °C
                </span>
              </span>
            )}
          </div>
          {controller && (
            <div className="mt-3">
              <SetpointControl
                deviceId={controller.id}
                setpointC={setpoint?.reading.value ?? null}
                pendingC={controller.pendingSetpointC ?? null}
                onApplied={onRefresh}
                variant="compact"
              />
            </div>
          )}
        </StationMetricBlock>

        <StationMetricBlock title="Gravity">
          {gravity ? (
            <LinkedMetric to={`/devices/${gravity.deviceId}?metric=gravity_sg`}>
              <BigValue value={gravity.reading.value.toFixed(3)} unit="SG" />
              <MetricTimestamp iso={gravity.reading.recordedAt} />
            </LinkedMetric>
          ) : (
            <MissingMetric label="No gravity data" />
          )}
        </StationMetricBlock>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-zinc-800 px-4 py-2.5 text-sm text-zinc-500">
        <span>{lastSeen ? `Updated ${relativeTime(lastSeen)}` : 'Never reported'}</span>
        <span className={`font-semibold ${status.textClass}`}>{status.hint}</span>
        <span className="hidden h-4 w-px bg-zinc-800 sm:block" aria-hidden />
        <div className="flex flex-wrap gap-2">
          {devices
            .slice()
            .sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type])
            .map((d) => (
              <SensorChip key={d.id} device={d} />
            ))}
        </div>
      </div>
    </article>
  );
}

function StationMetricBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="min-w-0 p-4">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">{title}</p>
      {children}
    </div>
  );
}

function LinkedMetric({
  to,
  children,
}: {
  to: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Link
      to={to}
      className="block rounded-lg transition hover:bg-zinc-800/50 focus:outline-none focus:ring-2 focus:ring-blue-500"
    >
      {children}
    </Link>
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

function MetricTimestamp({ iso }: { iso: string }): JSX.Element {
  return <p className="mt-1 text-xs text-zinc-500">{relativeTime(iso)}</p>;
}

function MissingMetric({ label, compact }: { label: string; compact?: boolean }): JSX.Element {
  return (
    <p className={`${compact ? 'mt-2' : 'mt-6'} text-sm text-zinc-600`}>{label}</p>
  );
}

function SensorChip({ device }: { device: DeviceStatus }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 px-2 py-1 text-xs text-zinc-400">
      <span
        className={`h-2 w-2 rounded-full ${
          device.online ? 'bg-emerald-400' : 'bg-zinc-600'
        }`}
        aria-hidden
      />
      {TYPE_LABEL[device.type]}
    </span>
  );
}

function KegStatusPanel({
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
  const percent = total > 0 ? Math.round((filled / total) * 100) : 0;
  const contents = contentCounts(kegs);

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Keg Status
          </h2>
          <p className="mt-0.5 text-sm text-zinc-500">
            {loading ? 'Loading sheet...' : error ? 'Sheet unavailable' : 'Shared inventory sheet'}
          </p>
        </div>
        <span className="text-2xl" aria-hidden>
          🍺
        </span>
      </div>

      {error ? (
        <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      ) : (
        <>
          <div className="mt-4 flex items-end gap-2">
            <span className="text-4xl font-semibold tracking-tight tabular-nums text-zinc-50">
              {loading ? '-' : filled}
            </span>
            <span className="pb-1 text-sm text-zinc-500">
              of {loading ? '-' : total} filled
            </span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-emerald-400"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {contents.length === 0 && (
              <span className="text-sm text-zinc-600">
                {loading ? 'Reading keg list...' : 'No filled kegs'}
              </span>
            )}
            {contents.slice(0, 6).map(({ contents: label, count }) => {
              const color = getContentColor(label);
              return (
                <span
                  key={label}
                  className="rounded-lg border border-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-300"
                  style={color ? { borderColor: color, color } : undefined}
                >
                  {count > 1 ? `${count}x ` : ''}
                  {label}
                </span>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function contentCounts(kegs: Keg[]): { contents: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const keg of kegs) {
    if (isUnknownContents(keg.contents)) continue;
    counts.set(keg.contents, (counts.get(keg.contents) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([contents, count]) => ({ contents, count }))
    .sort((a, b) => b.count - a.count || a.contents.localeCompare(b.contents));
}

function OperationsPanel(): JSX.Element {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
        Operations
      </h2>
      <div className="mt-3 grid gap-2">
        <AppLink to="/admin" icon="✅" title="Brew Checklist" subtitle="Procedures and runs" />
        <AppLink to="/todos" icon="📝" title="Brewery To-Do" subtitle="Ad-hoc task list" />
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
  icon: string;
  title: string;
  subtitle: string;
}): JSX.Element {
  return (
    <Link
      to={to}
      className="flex items-center gap-3 rounded-lg border border-zinc-800 px-3 py-2.5 transition hover:border-zinc-700 hover:bg-zinc-800/60"
    >
      <span className="text-xl" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-semibold text-zinc-100">{title}</span>
        <span className="block truncate text-sm text-zinc-500">{subtitle}</span>
      </span>
    </Link>
  );
}

function FleetPanel({
  devices,
  loading,
}: {
  devices: DeviceStatus[];
  loading: boolean;
}): JSX.Element {
  const online = devices.filter((d) => d.online).length;
  const lastSeen = latestDeviceTimestamp(devices);
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
        Device Fleet
      </h2>
      <div className="mt-3 flex items-end gap-2">
        <span className="text-3xl font-semibold tracking-tight text-zinc-50">
          {loading ? '-' : online}
        </span>
        <span className="pb-1 text-sm text-zinc-500">of {loading ? '-' : devices.length} online</span>
      </div>
      <p className="mt-2 text-sm text-zinc-500">
        {lastSeen ? `Latest update ${relativeTime(lastSeen)}` : 'No device reports yet'}
      </p>
    </section>
  );
}

function EquipmentDeviceCard({ device }: { device: DeviceStatus }): JSX.Element {
  const metrics = isBreweryTempDevice(device)
    ? orderedMetrics(device.latest.filter((r) => r.metric === 'temp_c'))
    : orderedMetrics(device.latest);
  const totalMetric = cumulativeMetricOf(device);
  const total = useDeviceTotal(device.id, totalMetric);

  return (
    <Link
      to={`/devices/${device.id}`}
      className={`flex min-h-[10.5rem] flex-col rounded-lg border border-zinc-800 bg-zinc-900 p-4 transition hover:border-zinc-700 hover:bg-zinc-800/60 ${
        device.online ? '' : 'opacity-60'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-2xl" aria-hidden>
            {TYPE_ICON[device.type]}
          </span>
          <div className="min-w-0">
            <h3 className="truncate font-semibold text-zinc-100">{device.name}</h3>
            <p className="text-xs uppercase tracking-wider text-zinc-500">
              {TYPE_LABEL[device.type]}
            </p>
          </div>
        </div>
        <StatusBadge online={device.online} />
      </div>

      {metrics.length > 0 ? (
        <div className="mt-4 grid flex-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          {metrics.map((r) => (
            <MetricReading key={r.metric} reading={r} />
          ))}
        </div>
      ) : (
        <p className="mt-4 flex-1 text-sm text-zinc-500">No readings yet.</p>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 pt-2.5 text-xs text-zinc-500">
        <span>{device.lastSeenAt ? `Updated ${relativeTime(device.lastSeenAt)}` : 'Never reported'}</span>
        {totalMetric && total != null && (
          <span>
            All-time{' '}
            <span className="font-semibold tabular-nums text-zinc-300">
              {formatValue({ metric: totalMetric, value: total, recordedAt: '' })}
            </span>
          </span>
        )}
      </div>
    </Link>
  );
}

function MetricReading({ reading }: { reading: LatestReading }): JSX.Element {
  if (isStateMetric(reading.metric)) {
    return (
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
          {METRIC_CAPTION[reading.metric] ?? metricLabel(reading.metric)}
        </p>
        <StateBadge value={reading.value} />
      </div>
    );
  }
  const { value, unit } = formatValueParts(reading);
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
        {METRIC_CAPTION[reading.metric] ?? metricLabel(reading.metric)}
      </p>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tracking-tight tabular-nums text-zinc-50">
          {value}
        </span>
        {unit && <span className="text-sm font-medium text-zinc-500">{unit}</span>}
      </div>
    </div>
  );
}

/** Dimmed, non-interactive tile for a planned-but-not-yet-connected sensor. */
function PlannedTile({ sensor }: { sensor: PlannedSensor }): JSX.Element {
  return (
    <div className="flex min-h-[10.5rem] flex-col rounded-lg border border-dashed border-zinc-700 bg-zinc-900/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-2xl opacity-60" aria-hidden>
            {sensor.icon}
          </span>
          <span className="font-semibold text-zinc-300">{sensor.title}</span>
        </div>
        <span className="inline-flex items-center rounded-lg bg-zinc-800 px-2 py-0.5 text-xs font-semibold text-zinc-400">
          Planned
        </span>
      </div>
      <p className="mt-4 text-sm text-zinc-500">{sensor.subtitle}</p>
      <p className="mt-auto pt-4 text-xs text-zinc-600">Not connected yet</p>
    </div>
  );
}

function StatusBadge({ online }: { online: boolean }): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-0.5 text-xs font-semibold ${
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

/** Chart stroke per metric. */
export function metricColor(metric: string): string {
  if (metric === 'hvac_state') return '#a78bfa';
  if (metric === 'power_w' || metric === 'energy_kwh') return '#eab308';
  return '#3b82f6';
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
