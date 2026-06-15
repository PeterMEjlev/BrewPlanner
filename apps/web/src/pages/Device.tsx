import { Link, useParams, useSearchParams } from 'react-router-dom';
import MetricChart from '../components/MetricChart';
import { useDeviceData } from '../useDeviceData';
import { relativeTime } from '../util';

/** Detail view for one device: live status plus a history chart per metric. */
export function DevicePage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const deviceId = Number(id);
  const initialMetric = params.get('metric') ?? undefined;
  // The header mirrors the chart's own device fetch; cheap and keeps the header
  // status/name reactive without threading state out of MetricChart.
  const { device } = useDeviceData(deviceId, initialMetric);

  return (
    <div className="min-h-full bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-zinc-800 bg-zinc-950/80 px-6 py-4 backdrop-blur">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="rounded-lg px-2 py-1 text-lg text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="Back to dashboard"
          >
            ←
          </Link>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{device?.name ?? 'Device'}</h1>
            <p className="text-xs text-zinc-400">
              {device?.lastSeenAt
                ? `Last update ${relativeTime(device.lastSeenAt)}`
                : 'Never reported'}
            </p>
          </div>
        </div>
        {device && (
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${
              device.online ? 'bg-emerald-500/15 text-emerald-400' : 'bg-zinc-800 text-zinc-400'
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                device.online
                  ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]'
                  : 'bg-zinc-500'
              }`}
              aria-hidden
            />
            {device.online ? 'Online' : 'Offline'}
          </span>
        )}
      </header>

      <main className="mx-auto max-w-4xl p-6">
        <MetricChart deviceId={deviceId} initialMetric={initialMetric} />
      </main>
    </div>
  );
}
