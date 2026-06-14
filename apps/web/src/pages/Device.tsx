import { Link, useParams } from 'react-router-dom';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { SetpointControl } from '../SetpointControl';
import {
  RANGES,
  cumulativeMetricOf,
  formatTick,
  useDeviceData,
  useDeviceTotal,
} from '../useDeviceData';
import {
  StateBadge,
  formatValue,
  isStateMetric,
  metricColor,
  metricLabel,
  relativeTime,
  stateTick,
} from './Dashboard';

/** Detail view for one device: live status plus a history chart per metric. */
export function DevicePage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const deviceId = Number(id);
  const {
    device,
    metric,
    setMetric,
    rangeMs,
    setRangeMs,
    chartData,
    latest,
    longRange,
    refresh,
    error,
  } = useDeviceData(deviceId);
  // With several metrics the selector buttons name the active one, so the label
  // beside the big value is redundant; keep it only for single-metric devices.
  const hasMetricSelector = !!device && device.latest.length > 1;
  // All-time consumption for energy/water meters.
  const totalMetric = cumulativeMetricOf(device);
  const total = useDeviceTotal(deviceId, totalMetric);
  // Brew controllers expose a target temperature the operator can change here.
  const setpointReading = device?.latest.find((r) => r.metric === 'setpoint_c');

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
        {error && (
          <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {latest && (
          <div className="mb-6">
            {isStateMetric(latest.metric) ? (
              <StateBadge value={latest.value} size="lg" />
            ) : (
              <>
                <span className="text-5xl font-bold tabular-nums text-zinc-50">
                  {formatValue(latest)}
                </span>
                {!hasMetricSelector && (
                  <span className="ml-2 text-lg text-zinc-400">{metricLabel(latest.metric)}</span>
                )}
              </>
            )}
            {totalMetric && total != null && (
              <p className="mt-2 text-sm text-zinc-400">
                All-time{' '}
                <span className="font-semibold tabular-nums text-zinc-200">
                  {formatValue({ metric: totalMetric, value: total, recordedAt: '' })}
                </span>
              </p>
            )}
          </div>
        )}

        {/* Change the controller's target temperature (brew controllers only). */}
        {setpointReading && (
          <div className="mb-6 max-w-md">
            <SetpointControl
              deviceId={deviceId}
              setpointC={setpointReading.value}
              pendingC={device?.pendingSetpointC ?? null}
              onApplied={refresh}
              variant="compact"
            />
          </div>
        )}

        {/* Metric + range selectors */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {device && device.latest.length > 1 && (
            <div className="flex gap-2">
              {device.latest.map((r) => (
                <button
                  key={r.metric}
                  type="button"
                  onClick={() => setMetric(r.metric)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    r.metric === metric
                      ? 'bg-blue-600 text-white'
                      : 'border border-zinc-700 text-zinc-300 hover:bg-zinc-800'
                  }`}
                >
                  {metricLabel(r.metric)}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            {RANGES.map((r) => (
              <button
                key={r.label}
                type="button"
                onClick={() => setRangeMs(r.ms)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                  r.ms === rangeMs
                    ? 'bg-zinc-100 text-zinc-900'
                    : 'border border-zinc-700 text-zinc-300 hover:bg-zinc-800'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* Chart */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          {chartData.length === 0 ? (
            <p className="py-20 text-center text-sm text-zinc-500">
              No readings in this range.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  scale="time"
                  tickFormatter={(t) => formatTick(t, longRange)}
                  tick={{ fontSize: 12, fill: '#94a3b8' }}
                  stroke="#334155"
                  minTickGap={40}
                />
                <YAxis
                  width={48}
                  tick={{ fontSize: 12, fill: '#94a3b8' }}
                  stroke="#334155"
                  domain={metric && isStateMetric(metric) ? [-1.1, 1.1] : ['auto', 'auto']}
                  ticks={metric && isStateMetric(metric) ? [-1, 0, 1] : undefined}
                  tickFormatter={
                    metric && isStateMetric(metric) ? (v) => stateTick(v) : undefined
                  }
                />
                <Tooltip
                  contentStyle={{
                    background: '#0f172a',
                    border: '1px solid #1e293b',
                    borderRadius: 8,
                    color: '#e2e8f0',
                  }}
                  labelStyle={{ color: '#94a3b8' }}
                  itemStyle={{ color: '#e2e8f0' }}
                  cursor={{ stroke: '#334155' }}
                  labelFormatter={(t) => new Date(t as number).toLocaleString()}
                  formatter={(value) => {
                    const num = typeof value === 'number' ? value : Number(value);
                    return [
                      metric ? formatValue({ metric, value: num, recordedAt: '' }) : num,
                      metric ? metricLabel(metric) : 'value',
                    ];
                  }}
                />
                <Line
                  type={metric && isStateMetric(metric) ? 'stepAfter' : 'monotone'}
                  dataKey="value"
                  stroke={metric ? metricColor(metric) : '#3b82f6'}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </main>
    </div>
  );
}
