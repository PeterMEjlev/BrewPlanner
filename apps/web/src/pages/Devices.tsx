import type { DeviceStatus, DeviceType, LatestReading } from '@checklist/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { DashboardShell } from '../components/DashboardShell';
import { cumulativeMetricOf, useDeviceTotal } from '../useDeviceData';
import {
  StateBadge,
  formatValue,
  formatValueParts,
  isStateMetric,
  metricLabel,
  relativeTime,
} from './Dashboard';

const POLL_MS = 10000;

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
  brew_controller: 'Inkbird',
  power_meter: 'Power',
  water_meter: 'Water',
  hydrometer: 'Tilt',
  other: 'Sensor',
};

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
  const totalMetric = cumulativeMetricOf(device);
  const total = useDeviceTotal(device.id, totalMetric);

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
            <h3 className="truncate font-semibold text-zinc-100">{device.name}</h3>
            <p className="text-xs uppercase tracking-wider text-zinc-500">{TYPE_LABEL[device.type]}</p>
          </div>
        </div>
        <StatusBadge online={device.online} />
      </div>

      {device.latest.length > 0 ? (
        <div className="mt-4 grid flex-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          {device.latest.map((r) => (
            <MetricReading key={r.metric} reading={r} />
          ))}
        </div>
      ) : (
        <p className="mt-4 flex-1 text-sm text-zinc-500">
          {device.online ? 'No readings yet.' : 'No device connected.'}
        </p>
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
          {metricLabel(reading.metric)}
        </p>
        <StateBadge value={reading.value} />
      </div>
    );
  }
  const { value, unit } = formatValueParts(reading);
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
        {metricLabel(reading.metric)}
      </p>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tracking-tight tabular-nums text-zinc-50">{value}</span>
        {unit && <span className="text-sm font-medium text-zinc-500">{unit}</span>}
      </div>
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
