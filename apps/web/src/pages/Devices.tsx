import { REPORTING_INTERVAL_OPTIONS, type DeviceStatus, type DeviceType } from '@checklist/shared';
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import inkbirdIcon from '../assets/inkbird.png';
import tiltIcon from '../assets/tilt.png';
import { canControl, useAuth } from '../auth';
import { DashboardShell } from '../components/DashboardShell';
import { listPollMs } from '../useDeviceData';
import { usePoll } from '../usePoll';
import { metricLabel, relativeTime } from './Dashboard';

/**
 * Synthesized mock/placeholder devices use ids at/above this base (see the
 * server's MOCK_ID_BASE). They have no real agent behind them, so their logging
 * interval can't be changed — the editor falls back to a static value for them.
 */
const MOCK_ID_BASE = 900_000;

/**
 * Cumulative meter metrics hidden from the Devices page. A water/power meter
 * reports one live quantity (flow / power); its running total (`water_l` /
 * `energy_kwh`) is a derived counter, not a separate "data type", so it's left
 * off the per-device metric chips and count here.
 */
const HIDDEN_METRICS = new Set(['water_l', 'energy_kwh']);

const TYPE_ICON: Record<DeviceType, string> = {
  pressure_sensor: '📈',
  brew_controller: '🎛️',
  power_meter: '⚡',
  water_meter: '💧',
  hydrometer: '🍷',
  other: '📡',
};

/**
 * Product photos for the device types we have real hardware artwork for
 * (see the repo `Icons/` folder). When a type is listed here the card shows the
 * photo instead of the generic {@link TYPE_ICON} emoji. The Inkbird image covers
 * every brew_controller (fermenter, kegs fridge, and brewery ambient are all the
 * same ITC-308-WIFI); the Tilt image covers the hydrometer.
 */
const TYPE_IMAGE: Partial<Record<DeviceType, string>> = {
  brew_controller: inkbirdIcon,
  hydrometer: tiltIcon,
};

/** Generic kind shown as a secondary subtitle next to the location name. */
const TYPE_LABEL: Record<DeviceType, string> = {
  pressure_sensor: 'Pressure',
  brew_controller: 'Controller',
  power_meter: 'Power meter',
  water_meter: 'Water meter',
  hydrometer: 'Hydrometer',
  other: 'Sensor',
};

/**
 * Hardware make/model per device type. The hub doesn't store per-device brand
 * info, so this mirrors the actual kit documented in SENSORS.md / the agent
 * READMEs. Brand is null for the generic wired sensors, where the model name
 * alone is the most useful label.
 */
interface DeviceModel {
  brand: string | null;
  model: string;
  /** How the device reaches the hub/satellite. */
  connectivity: string;
}

const DEVICE_MODEL: Record<DeviceType, DeviceModel> = {
  brew_controller: { brand: 'Inkbird', model: 'ITC-308-WIFI', connectivity: 'Wi-Fi · Tuya' },
  hydrometer: { brand: 'Tilt', model: 'Hydrometer', connectivity: 'Bluetooth LE' },
  pressure_sensor: { brand: null, model: 'Fermentation pressure sensor', connectivity: 'Wired' },
  power_meter: { brand: null, model: 'Mains energy meter', connectivity: 'Wired' },
  water_meter: { brand: null, model: 'Water flow meter', connectivity: 'Wired' },
  other: { brand: null, model: 'Generic sensor', connectivity: '—' },
};

/** "Brand Model" when a brand is known, else just the model name. */
function deviceTitle(type: DeviceType): string {
  const m = DEVICE_MODEL[type];
  return m.brand ? `${m.brand} ${m.model}` : m.model;
}

/** Short absolute date a device was first registered, e.g. "2 Jun 2026". */
function formatRegistered(createdAt: string): string {
  return new Date(createdAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Full local timestamp for the `title` tooltip on a relative time, e.g. last fetch. */
function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** A push cadence as "every 30s" / "every 5m" / "every 2h", or "—" when unknown. */
function formatInterval(sec: number | null | undefined): string {
  if (sec == null) return '—';
  if (sec < 90) return `every ${sec}s`;
  if (sec < 3600) return `every ${Math.round(sec / 60)}m`;
  return `every ${Math.round(sec / 3600)}h`;
}

/** A reading count with thousands separators, or "—" when not reported. */
function formatCount(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString();
}

// --- Fleet grouping ---------------------------------------------------------
// The grid is laid out as labelled rows rather than one alphabetical run: the
// fermenter station (pressure, controller, Tilt) on top, then the brewery &
// kegs controllers, then the water & power meters. These mirror the Overview's
// own device grouping (see Dashboard.tsx).

/** The brewery ambient thermometer — a brew_controller named brewery/ambient. */
function isBreweryTempDevice(d: DeviceStatus): boolean {
  return d.type === 'brew_controller' && /brewery|ambient/i.test(d.name);
}

/** The filled-keg fridge controller — a brew_controller named for kegs. */
function isKegsTempDevice(d: DeviceStatus): boolean {
  return d.type === 'brew_controller' && /keg/i.test(d.name);
}

/** A fermenter-station device: pressure/gravity sensor, or the ferment controller. */
function isFermenterDevice(d: DeviceStatus): boolean {
  return (
    d.type === 'pressure_sensor' ||
    d.type === 'hydrometer' ||
    (d.type === 'brew_controller' && !isBreweryTempDevice(d) && !isKegsTempDevice(d))
  );
}

/** Order inside the fermenter row: pressure, then controller, then Tilt. */
const FERMENTER_TYPE_RANK: Partial<Record<DeviceType, number>> = {
  pressure_sensor: 0,
  brew_controller: 1,
  hydrometer: 2,
};

function byNameId(a: DeviceStatus, b: DeviceStatus): number {
  return a.name.localeCompare(b.name) || a.id - b.id;
}

/**
 * Split the fleet into the rows the grid renders top-to-bottom. Each returned
 * group is drawn as its own responsive grid, so a group always begins on a new
 * row (a two-card row leaves its trailing cell empty rather than pulling the
 * next group's first card up). Empty groups are dropped; anything that fits none
 * of the named rows falls into a trailing catch-all so no device is hidden.
 */
function fleetRows(devices: DeviceStatus[]): DeviceStatus[][] {
  const fermenter = devices
    .filter(isFermenterDevice)
    .sort(
      (a, b) =>
        (FERMENTER_TYPE_RANK[a.type] ?? 9) - (FERMENTER_TYPE_RANK[b.type] ?? 9) || byNameId(a, b),
    );
  // Brewery ambient before the kegs fridge.
  const breweryKegs = devices
    .filter((d) => isBreweryTempDevice(d) || isKegsTempDevice(d))
    .sort((a, b) => Number(isKegsTempDevice(a)) - Number(isKegsTempDevice(b)) || byNameId(a, b));
  // Water before power.
  const waterPower = devices
    .filter((d) => d.type === 'water_meter' || d.type === 'power_meter')
    .sort((a, b) => (a.type === 'water_meter' ? 0 : 1) - (b.type === 'water_meter' ? 0 : 1) || byNameId(a, b));
  const claimed = new Set([...fermenter, ...breweryKegs, ...waterPower]);
  const rest = devices.filter((d) => !claimed.has(d)).sort(byNameId);
  return [fermenter, breweryKegs, waterPower, rest].filter((g) => g.length > 0);
}

/** A flat list of every registered device, linking to each detail/chart page. */
export function DevicesPage(): JSX.Element {
  const [devices, setDevices] = useState<DeviceStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { auth } = useAuth();
  const editable = canControl(auth);

  const load = useCallback(async () => {
    try {
      setDevices(await api.listDevices());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load devices');
    }
  }, []);

  // Save a device's new logging interval, updating the card immediately and
  // reloading on failure so a rejected change doesn't stick visually.
  const saveInterval = useCallback(
    async (id: number, seconds: number) => {
      setDevices(
        (cur) => cur?.map((d) => (d.id === id ? { ...d, reportingIntervalSec: seconds } : d)) ?? cur,
      );
      try {
        await api.setDeviceInterval(id, seconds);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to update interval');
        void load();
      }
    },
    [load],
  );

  const pollMs = listPollMs(devices);
  usePoll(load, pollMs, [load]);

  const list = devices ?? [];
  const online = list.filter((d) => d.online).length;
  const lastUpdate = latestDeviceTimestamp(list);
  const rows = fleetRows(list);

  return (
    <DashboardShell active="devices" lastUpdate={lastUpdate}>
      <main className="w-full max-w-[1580px] px-5 py-5">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-zinc-50">Devices</h1>
            <p className="mt-0.5 text-sm text-zinc-500">Every sensor and controller registered on the hub.</p>
          </div>
          {list.length > 0 && (
            <span className="rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-400">
              <span className="font-semibold text-zinc-100">{online}</span> / {list.length} online
            </span>
          )}
        </div>

        {error && (
          <div className="mb-5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {devices === null ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-400">
            Loading devices…
          </div>
        ) : list.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-900/40 p-6">
            <p className="font-semibold text-zinc-200">No devices registered yet</p>
            <p className="mt-2 text-sm text-zinc-500">
              Register one on the Pi with{' '}
              <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
                npm run device -- add "Fermenter" pressure_sensor
              </code>{' '}
              and point its agent at this server.
            </p>
          </div>
        ) : (
          // One responsive grid per row-group (fermenter, brewery & kegs, water
          // & power) so each group starts on its own row. The row gap between
          // groups matches the card gap within a group, so it reads as one grid.
          <div className="space-y-4">
            {rows.map((group) => (
              <div
                key={group[0]!.id}
                className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
              >
                {group.map((d) => (
                  <DeviceCard
                    key={d.id}
                    device={d}
                    editable={editable && d.id < MOCK_ID_BASE}
                    onSetInterval={saveInterval}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </main>
    </DashboardShell>
  );
}

function DeviceCard({
  device,
  editable,
  onSetInterval,
}: {
  device: DeviceStatus;
  editable: boolean;
  onSetInterval: (id: number, seconds: number) => void;
}): JSX.Element {
  const model = DEVICE_MODEL[device.type];
  // A meter's running-total counter isn't a separate data type — hide it here.
  const metrics = device.latest.filter((r) => !HIDDEN_METRICS.has(r.metric));

  return (
    <Link
      to={`/devices/${device.id}`}
      className={`flex min-h-[10.5rem] flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-4 transition hover:border-zinc-700 hover:bg-zinc-800/60 ${
        device.online ? '' : 'opacity-60'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {TYPE_IMAGE[device.type] ? (
            <img
              src={TYPE_IMAGE[device.type]}
              alt=""
              aria-hidden
              className="h-11 w-11 shrink-0 object-contain"
            />
          ) : (
            <span className="text-2xl" aria-hidden>
              {TYPE_ICON[device.type]}
            </span>
          )}
          <div className="min-w-0">
            {/* Lead with the human-friendly name the device was registered under
                (e.g. "Brewery Ambient") so the several Inkbird controllers, which
                share one make/model, are told apart at a glance. Make/model moves
                to the subtitle alongside the generic kind. */}
            <h3 className="truncate font-semibold text-zinc-100" title={device.name}>
              {device.name}
            </h3>
            <p className="mt-0.5 truncate text-xs text-zinc-500">
              <span className="font-medium text-zinc-400">{deviceTitle(device.type)}</span>
              <span className="text-zinc-600"> · </span>
              {TYPE_LABEL[device.type]}
            </p>
          </div>
        </div>
        <StatusBadge online={device.online} />
      </div>

      <dl className="mt-4 grid flex-1 grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {/* Full-width and first so the whole 17-char MAC fits without clipping;
            only shown when reported (mock/older agents leave it null). */}
        {device.mac && <InfoRow label="MAC address" value={device.mac} mono wide />}
        <InfoRow label="IP address" value={device.lastIp ?? '—'} mono />
        <InfoRow label="Protocol" value={model.connectivity} />
        <InfoRow
          label="Last fetch"
          value={device.lastSeenAt ? relativeTime(device.lastSeenAt) : 'Never'}
          title={device.lastSeenAt ? formatAbsolute(device.lastSeenAt) : undefined}
        />
        <IntervalRow
          seconds={device.reportingIntervalSec}
          editable={editable}
          onChange={(s) => onSetInterval(device.id, s)}
        />
        <InfoRow label="Data points" value={formatCount(device.readingCount)} />
        <InfoRow
          label="Reporting"
          value={metrics.length > 0 ? `${metrics.length} metric${metrics.length === 1 ? '' : 's'}` : 'None'}
        />
      </dl>

      {metrics.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {metrics.map((r) => (
            <Chip key={r.metric} label={metricLabel(r.metric)} />
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-800 pt-2.5 text-xs text-zinc-500">
        <span className="text-zinc-600">ID {device.id}</span>
        <span>Registered {formatRegistered(device.createdAt)}</span>
      </div>
    </Link>
  );
}

/** One label/value pair in a device card's info grid. */
function InfoRow({
  label,
  value,
  mono = false,
  wide = false,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  /**
   * Span both grid columns and never truncate the value — for long values like
   * a MAC address that don't fit a half-width cell (they'd otherwise clip).
   */
  wide?: boolean;
  title?: string;
}): JSX.Element {
  return (
    <div
      className={`flex items-baseline justify-between gap-2 border-b border-zinc-800/60 py-0.5 ${
        wide ? 'sm:col-span-2' : ''
      }`}
    >
      <dt className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</dt>
      <dd
        className={`text-right text-sm text-zinc-200 ${wide ? '' : 'truncate'} ${
          mono ? 'font-mono tabular-nums' : ''
        }`}
        title={title ?? value}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * The "Interval" grid row. Read-only it mirrors {@link InfoRow}; for an admin on
 * a real device it's an inline picker for that device's logging cadence. Pointer
 * and change events are stopped so using the picker doesn't follow the card's
 * link.
 */
function IntervalRow({
  seconds,
  editable,
  onChange,
}: {
  seconds: number;
  editable: boolean;
  onChange: (seconds: number) => void;
}): JSX.Element {
  if (!editable) return <InfoRow label="Interval" value={formatInterval(seconds)} />;
  // Always include the current value so a custom/legacy cadence still shows.
  const options = Array.from(new Set<number>([...REPORTING_INTERVAL_OPTIONS, seconds])).sort(
    (a, b) => a - b,
  );
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-zinc-800/60 py-0.5">
      <dt className="text-xs font-medium uppercase tracking-wider text-zinc-500">Interval</dt>
      <dd className="text-right">
        <select
          value={seconds}
          aria-label="Logging interval"
          // Keep clicks off the card's link: stop bubbling (so React Router's
          // handler never runs) and cancel the anchor's default navigation. The
          // dropdown opens on mousedown, so preventing the click default is safe.
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
          onChange={(e) => {
            e.stopPropagation();
            onChange(Number(e.target.value));
          }}
          className="cursor-pointer rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-sm text-zinc-200 transition hover:border-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          {options.map((s) => (
            <option key={s} value={s}>
              {formatInterval(s)}
            </option>
          ))}
        </select>
      </dd>
    </div>
  );
}

/** A small pill for a device spec — accent for connectivity, muted for metrics. */
function Chip({ label, accent = false }: { label: string; accent?: boolean }): JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
        accent
          ? 'bg-sky-500/10 text-sky-300 ring-sky-500/20'
          : 'bg-zinc-800/70 text-zinc-400 ring-zinc-700/50'
      }`}
    >
      {label}
    </span>
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
