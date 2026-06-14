import { useEffect } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
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

function isBreweryTempDevice(device: { name: string; type: string }): boolean {
  return device.type === 'brew_controller' && /brewery|ambient/i.test(device.name);
}

/** Detail view for one device: live status plus a history chart per metric. */
export function DevicePage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const deviceId = Number(id);
  const initialMetric = params.get('metric') ?? undefined;
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
  } = useDeviceData(deviceId, initialMetric);

  // All-time consumption for energy/water meters.
  const totalMetric = cumulativeMetricOf(device);
  const total = useDeviceTotal(deviceId, totalMetric);
  // Brew controllers expose a target temperature; show the control even before
  // the controller's first setpoint_c sample arrives.
  const setpointReading = device?.latest.find((r) => r.metric === 'setpoint_c');
  const supportsSetpoint = device?.type === 'brew_controller';

  const breweryTempOnly = !!device && isBreweryTempDevice(device);
  const metricOptions = breweryTempOnly
    ? device.latest.filter((r) => r.metric === 'temp_c')
    : (device?.latest ?? []);
  // With several metrics the selector buttons name the active one, so the label
  // beside the big value is redundant. Brewery ambient stays temperature-only.
  const hasMetricSelector = !breweryTempOnly && metricOptions.length > 1;
  const latestForDisplay = breweryTempOnly
    ? device?.latest.find((r) => r.metric === 'temp_c')
    : latest;
  const chartMetric = breweryTempOnly ? 'temp_c' : metric;

  useEffect(() => {
    if (breweryTempOnly && metric !== 'temp_c') {
      setMetric('temp_c');
    }
  }, [breweryTempOnly, metric, setMetric]);

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

        {latestForDisplay && (
          <div className="mb-6">
            {isStateMetric(latestForDisplay.metric) ? (
              <StateBadge value={latestForDisplay.value} size="lg" />
            ) : (
              <>
                <span className="text-5xl font-bold tabular-nums text-zinc-50">
                  {formatValue(latestForDisplay)}
                </span>
                {!hasMetricSelector && (
                  <span className="ml-2 text-lg text-zinc-400">
                    {metricLabel(latestForDisplay.metric)}
                  </span>
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
        {supportsSetpoint && (
          <div className="mb-6 max-w-md">
            <SetpointControl
              deviceId={deviceId}
              setpointC={setpointReading?.value ?? null}
              pendingC={device?.pendingSetpointC ?? null}
              onApplied={refresh}
              variant="compact"
            />
          </div>
        )}

        {/* Metric + range selectors */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {hasMetricSelector && (
            <div className="flex gap-2">
              {metricOptions.map((r) => (
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
                  domain={chartMetric && isStateMetric(chartMetric) ? [-1.1, 1.1] : ['auto', 'auto']}
                  ticks={chartMetric && isStateMetric(chartMetric) ? [-1, 0, 1] : undefined}
                  tickFormatter={
                    chartMetric && isStateMetric(chartMetric) ? (v) => stateTick(v) : undefined
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
                      chartMetric
                        ? formatValue({ metric: chartMetric, value: num, recordedAt: '' })
                        : num,
                      chartMetric ? metricLabel(chartMetric) : 'value',
                    ];
                  }}
                />
                <Line
                  type={chartMetric && isStateMetric(chartMetric) ? 'stepAfter' : 'monotone'}
                  dataKey="value"
                  stroke={chartMetric ? metricColor(chartMetric) : '#3b82f6'}
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
