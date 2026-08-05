import {
  REPORTING_INTERVAL_OPTIONS,
  type DeviceStatus,
  type DeviceType,
  type HostStatus,
} from '@checklist/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import arduinoIcon from '../assets/arduino.png';
import inkbirdIcon from '../assets/inkbird.png';
import pressureSensorIcon from '../assets/pressure-sensor.png';
import rpiIcon from '../assets/rpi.png';
import tiltIcon from '../assets/tilt.png';
import { canControl, useAuth } from '../auth';
import { DashboardShell } from '../components/DashboardShell';
import { Select } from '../components/Select';
import { useFleet, useHosts } from '../useDeviceData';
import { dateTime } from '../util';
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
  pressure_sensor: pressureSensorIcon,
};

/**
 * The board that fronts a device which can't reach the hub by itself.
 *
 * The fermentation pressure transducer is an analog part: it answers with a
 * voltage and speaks no protocol, so an Arduino Uno R3 digitises it and streams
 * the value over USB to the Pi running this server, where the pressure agent
 * pushes it on. That board is as load-bearing as the Pis on the Systems row —
 * a dead Arduino is a silent sensor — so a device fronted by one shows the
 * board's specs on its card, and its photo beside the sensor's.
 *
 * The fields here are fixed hardware facts rather than telemetry: an Uno has no
 * OS to report an uptime, a load average or a service from, so unlike
 * {@link HostCard} there is nothing to poll. Whether the board is actually
 * feeding the hub is the one live thing about it, and the card reads that off
 * the device's own online state — a quiet sensor and a dead Arduino look the
 * same from here, which is exactly why the two share one status.
 */
interface BridgeBoard {
  /** Board name, shown as the block's heading. */
  name: string;
  image: string;
  mcu: string;
  /**
   * What the sensor plugs into, and at what resolution — the reason the board is
   * in the chain at all, and the ceiling on how finely the sensor can be read.
   */
  inputs: string;
  /** How the board reaches the hub, ending at the host that reads it. */
  link: string;
}

const TYPE_BRIDGE: Partial<Record<DeviceType, BridgeBoard>> = {
  pressure_sensor: {
    name: 'Arduino Uno R3',
    image: arduinoIcon,
    mcu: 'ATmega328P · 16 MHz',
    inputs: '6 analog · 10-bit ADC',
    // The hub's own name, as readLocalHost() reports it (apps/server/src/system/hosts.ts).
    link: 'USB serial → BrewPlanner Pi',
  },
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
  // Analog in, so it reaches the hub via the Arduino in TYPE_BRIDGE, not by itself.
  pressure_sensor: {
    brand: null,
    model: 'Fermentation pressure sensor',
    connectivity: 'Analog → USB serial',
  },
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
  return dateTime(iso);
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

// --- Host formatting --------------------------------------------------------

/** Bytes as GB/MB with one decimal — SD cards and Pi RAM never need more. */
function formatBytes(bytes: number | null): string {
  if (bytes == null) return '—';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** An uptime as "6d 4h" / "4h 12m" / "12m" — two units is as precise as anyone reads. */
function formatUptime(seconds: number | null): string {
  if (seconds == null) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** A Pi throttles at 80 °C and starts capping the clock a little before that. */
function tempTone(celsius: number): string {
  if (celsius >= 75) return 'text-red-400';
  if (celsius >= 65) return 'text-amber-400';
  return 'text-zinc-200';
}

/** Load past one job per core means something is queueing behind the CPU. */
function loadTone(load: number, cores: number | null): string {
  const perCore = load / (cores && cores > 0 ? cores : 1);
  if (perCore >= 1) return 'text-red-400';
  if (perCore >= 0.7) return 'text-amber-400';
  return 'text-zinc-200';
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

  // The fleet comes off the shared channel, so this page and the sidebar's
  // Devices badge are one request rather than two. It's mirrored into local
  // state because an interval edit is applied optimistically on top of it,
  // until the next poll confirms it.
  const fleet = useFleet();
  // The two Pis underneath the fleet — the hub serving this page and the brewing
  // rig. Their own channel: they're read a different way (locally and over SSH,
  // not from the readings table) and change far more slowly than a sensor does.
  const hosts = useHosts();
  useEffect(() => {
    if (fleet.data) setDevices(fleet.data);
    setError(fleet.error);
  }, [fleet.data, fleet.error]);

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
        void fleet.refresh();
      }
    },
    [fleet.refresh],
  );

  const list = devices ?? [];
  const lastUpdate = latestDeviceTimestamp(list);
  const rows = fleetRows(list);

  return (
    <DashboardShell active="devices" lastUpdate={lastUpdate}>
      <main className="w-full max-w-[1580px] px-5 py-5">
        {error && (
          <div className="mb-5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* The machines first, then what's plugged into them: the Pis are what
            everything below depends on, so a red one explains a quiet fleet. */}
        {hosts.data && hosts.data.length > 0 && (
          <section className="mb-6">
            <SectionLabel>Systems</SectionLabel>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {hosts.data.map((host) => (
                <HostCard key={host.id} host={host} />
              ))}
            </div>
          </section>
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
            {hosts.data && hosts.data.length > 0 && <SectionLabel>Sensors</SectionLabel>}
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

/** A quiet heading over a band of cards ("Systems", "Sensors"). */
function SectionLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">{children}</h2>
  );
}

/**
 * One Raspberry Pi. Deliberately not a link like {@link DeviceCard}: a host has
 * no reading history to chart, so everything worth knowing about it is here.
 *
 * An unreachable host still gets a card — an empty slot where the rig should be
 * is exactly the ambiguity ("is it off, or did I break something?") this page is
 * meant to settle.
 */
function HostCard({ host }: { host: HostStatus }): JSX.Element {
  return (
    <div
      className={`flex min-h-[10.5rem] flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-4 ${
        host.online ? '' : 'opacity-60'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {/* Same height as the boards on the sensor cards below (see
              {@link DeviceGlyph}), width following the photo's own aspect — every
              hardware photo is cropped to its subject, so one height class puts
              them all at one visual size. */}
          <img src={rpiIcon} alt="" aria-hidden className="h-9 w-auto shrink-0 object-contain" />
          <div className="min-w-0">
            <h3 className="truncate font-semibold text-zinc-100" title={host.name}>
              {host.name}
            </h3>
            <p className="mt-0.5 truncate text-xs text-zinc-500" title={host.role}>
              {host.role}
            </p>
          </div>
        </div>
        <StatusBadge online={host.online} />
      </div>

      {!host.online ? (
        <p className="mt-4 flex-1 text-sm text-zinc-500">
          {host.error ?? 'Powered off or off the network — nothing to report.'}
        </p>
      ) : (
        <>
          <dl className="mt-4 grid flex-1 grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
            {host.model && <InfoRow label="Board" value={host.model} wide />}
            {host.os && <InfoRow label="OS" value={host.os} wide />}
            <InfoRow label="Hostname" value={host.hostname ?? '—'} />
            <InfoRow label="IP address" value={host.ip ?? '—'} mono />
            <InfoRow label="Uptime" value={formatUptime(host.uptimeSec)} />
            <InfoRow
              label="CPU temp"
              value={host.cpuTempC != null ? `${host.cpuTempC.toFixed(1)} °C` : '—'}
              tone={host.cpuTempC != null ? tempTone(host.cpuTempC) : undefined}
            />
            <InfoRow
              label="Load"
              value={
                host.loadAvg1 != null
                  ? `${host.loadAvg1.toFixed(2)}${host.cpuCount ? ` / ${host.cpuCount} cores` : ''}`
                  : '—'
              }
              tone={host.loadAvg1 != null ? loadTone(host.loadAvg1, host.cpuCount) : undefined}
            />
            <InfoRow
              label="Service"
              value={
                host.serviceActive == null ? '—' : host.serviceActive ? 'Running' : 'Stopped'
              }
              title={host.serviceName ?? undefined}
              tone={host.serviceActive === false ? 'text-red-400' : undefined}
            />
          </dl>

          <div className="mt-3 space-y-2">
            <Meter label="Memory" used={host.memUsedBytes} total={host.memTotalBytes} />
            <Meter label="Disk" used={host.diskUsedBytes} total={host.diskTotalBytes} />
          </div>

          {host.error && <p className="mt-3 text-xs text-amber-400">{host.error}</p>}
        </>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-800 pt-2.5 text-xs text-zinc-500">
        {host.commit ? (
          <>
            <span className="font-mono text-zinc-400">{host.commit}</span>
            {host.commitSubject && (
              <span className="min-w-0 truncate" title={host.commitSubject}>
                {host.commitSubject}
              </span>
            )}
          </>
        ) : (
          <span>Version unknown</span>
        )}
      </div>
    </div>
  );
}

/** A used/total bar — the fastest read on whether a Pi is running out of something. */
function Meter({
  label,
  used,
  total,
}: {
  label: string;
  used: number | null;
  total: number | null;
}): JSX.Element | null {
  if (used == null || total == null || total <= 0) return null;
  const pct = Math.min(100, Math.max(0, (used / total) * 100));
  const fill = pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium uppercase tracking-wider text-zinc-500">{label}</span>
        <span className="tabular-nums text-zinc-400">
          {formatBytes(used)} / {formatBytes(total)}
          <span className="ml-1.5 text-zinc-600">{Math.round(pct)}%</span>
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
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
  const bridge = TYPE_BRIDGE[device.type];
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
          <DeviceGlyph type={device.type} bridge={bridge} />
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
        {/* What the box calls itself in its own manufacturer app (e.g. an
            Inkbird's name in the Inkbird app) — the label on the physical unit,
            where the title above is the name it's registered under here. Only
            shown when an agent reports one. */}
        {device.vendorName && <InfoRow label="App name" value={device.vendorName} wide />}
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
        {/* The board that fronts this device, in the same grid as the device's
            own rows: sensor and board are one unit here — you can't have one
            without the other — so they read as one spec list, not two. Four
            half-width rows keep the two-column rhythm unbroken; only the link,
            which names both ends of the chain, needs the full width. */}
        {bridge && (
          <>
            <InfoRow label="Board" value={bridge.name} />
            <InfoRow label="MCU" value={bridge.mcu} />
            <InfoRow label="Sensor in" value={bridge.inputs} />
            {/* The one live fact about the board: an Uno reports no vitals of its
                own, but readings arriving at all means it is powered, running its
                sketch and holding the serial line. */}
            <InfoRow
              label="Serial feed"
              value={device.online ? 'Streaming' : 'Silent'}
              tone={device.online ? undefined : 'text-amber-400'}
            />
            <InfoRow label="Link" value={bridge.link} wide />
          </>
        )}
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

/**
 * A card's artwork: the device's own photo, with the board that fronts it beside
 * it in signal order (the sensor first, then what reads it). Types we have no
 * photo for keep the generic {@link TYPE_ICON} emoji.
 *
 * Each image gets its own box rather than one shared square, because the two are
 * different shapes — a stubby upright transducer next to a board seen flat — and
 * sizing both to the same square would shrink the board to a smudge.
 */
function DeviceGlyph({
  type,
  bridge,
}: {
  type: DeviceType;
  bridge: BridgeBoard | undefined;
}): JSX.Element {
  const image = TYPE_IMAGE[type];
  if (!image) {
    return (
      <span className="text-2xl" aria-hidden>
        {TYPE_ICON[type]}
      </span>
    );
  }
  if (!bridge) {
    return <img src={image} alt="" aria-hidden className="h-11 w-11 shrink-0 object-contain" />;
  }
  // Both at one height, widths left to follow each photo's own aspect — a board
  // seen flat is far wider than an upright transducer, and matching their heights
  // is what makes the pair read as one unit rather than two pasted-together cutouts.
  return (
    <span className="flex shrink-0 items-center gap-1.5" aria-hidden>
      <img src={image} alt="" className="h-9 w-auto object-contain" />
      <img src={bridge.image} alt="" className="h-9 w-auto object-contain" />
    </span>
  );
}

/** One label/value pair in a device card's info grid. */
function InfoRow({
  label,
  value,
  mono = false,
  wide = false,
  title,
  tone,
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
  /** Text colour for a value worth noticing (a hot CPU, a stopped service). */
  tone?: string;
}): JSX.Element {
  return (
    <div
      className={`flex items-baseline justify-between gap-2 border-b border-zinc-800/60 py-0.5 ${
        wide ? 'sm:col-span-2' : ''
      }`}
    >
      <dt className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</dt>
      <dd
        className={`text-right text-sm ${tone ?? 'text-zinc-200'} ${wide ? '' : 'truncate'} ${
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
        {/* Keep clicks off the card's link: stop bubbling (so React Router's
            handler never runs) and cancel the anchor's default navigation. The
            menu is portalled out of the anchor, but a click in it still travels
            up the React tree, so the guard belongs on the wrapper. */}
        <span
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
        >
          <Select
            value={seconds}
            aria-label="Logging interval"
            onChange={onChange}
            align="right"
            className="rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-sm text-zinc-200 transition hover:border-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
            options={options.map((s) => ({ value: s, label: formatInterval(s) }))}
          />
        </span>
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
