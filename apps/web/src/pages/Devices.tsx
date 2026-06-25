import type { DeviceStatus, DeviceType } from '@checklist/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { DashboardShell } from '../components/DashboardShell';
import { metricLabel, relativeTime } from './Dashboard';

const POLL_MS = 10000;

const TYPE_ICON: Record<DeviceType, string> = {
  pressure_sensor: '📈',
  brew_controller: '🎛️',
  power_meter: '⚡',
  water_meter: '🚰',
  hydrometer: '🍷',
  other: '📡',
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

/** A flat list of every registered device, linking to each detail/chart page. */
export function DevicesPage(): JSX.Element {
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

  const list = devices ?? [];
  const online = list.filter((d) => d.online).length;
  const offline = list.filter((d) => !d.online).length;
  const lastUpdate = latestDeviceTimestamp(list);
  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);

  return (
    <DashboardShell active="devices" alertCount={offline} lastUpdate={lastUpdate}>
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {sorted.map((d) => (
              <DeviceCard key={d.id} device={d} />
            ))}
          </div>
        )}
      </main>
    </DashboardShell>
  );
}

function DeviceCard({ device }: { device: DeviceStatus }): JSX.Element {
  const model = DEVICE_MODEL[device.type];

  return (
    <Link
      to={`/devices/${device.id}`}
      className={`flex min-h-[10.5rem] flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-4 transition hover:border-zinc-700 hover:bg-zinc-800/60 ${
        device.online ? '' : 'opacity-60'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-2xl" aria-hidden>
            {TYPE_ICON[device.type]}
          </span>
          <div className="min-w-0">
            <h3 className="truncate font-semibold text-zinc-100">{deviceTitle(device.type)}</h3>
            <p className="mt-0.5 truncate text-xs text-zinc-500">
              <span className="font-medium text-zinc-400">{device.name}</span>
              <span className="text-zinc-600"> · </span>
              {TYPE_LABEL[device.type]}
            </p>
          </div>
        </div>
        <StatusBadge online={device.online} />
      </div>

      <dl className="mt-4 grid flex-1 grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
        <InfoRow label="IP address" value={device.lastIp ?? '—'} mono />
        <InfoRow label="Protocol" value={model.connectivity} />
        <InfoRow
          label="Last fetch"
          value={device.lastSeenAt ? relativeTime(device.lastSeenAt) : 'Never'}
          title={device.lastSeenAt ? formatAbsolute(device.lastSeenAt) : undefined}
        />
        <InfoRow label="Interval" value={formatInterval(device.reportingIntervalSec)} />
        <InfoRow label="Data points" value={formatCount(device.readingCount)} />
        <InfoRow
          label="Reporting"
          value={device.latest.length > 0 ? `${device.latest.length} metric${device.latest.length === 1 ? '' : 's'}` : 'None'}
        />
      </dl>

      {device.latest.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {device.latest.map((r) => (
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
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-zinc-800/60 py-0.5">
      <dt className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</dt>
      <dd
        className={`truncate text-right text-sm text-zinc-200 ${mono ? 'font-mono tabular-nums' : ''}`}
        title={title ?? value}
      >
        {value}
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
