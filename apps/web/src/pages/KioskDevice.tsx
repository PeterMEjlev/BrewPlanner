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
  stateTick,
} from './Dashboard';

/** Touch-first sensor view for the Pi screen: big number, big controls, big chart. */
export function KioskDevicePage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  // A `?metric=` query pins the page to one metric and hides the selector (the
  // fermenter's gravity link uses this so the Tilt's beer temp never shows here).
  const lockedMetric = params.get('metric') ?? undefined;
  const deviceId = Number(id);
  const { device, metric, setMetric, rangeMs, setRangeMs, chartData, latest, longRange, refresh } =
    useDeviceData(deviceId, lockedMetric);
  // The metric buttons only show with several metrics and no locked metric; when
  // they do, the active button already names the metric, so the label beside the
  // big value would just repeat it.
  const hasMetricSelector = !lockedMetric && !!device && device.latest.length > 1;
  // All-time consumption for energy/water meters (shown alongside the live value).
  const totalMetric = cumulativeMetricOf(device);
  const total = useDeviceTotal(deviceId, totalMetric);
  // Brew controllers expose a target temperature the operator can change here.
  const setpointReading = device?.latest.find((r) => r.metric === 'setpoint_c');

  return (
    <div className="touch-none-select flex h-full flex-col bg-zinc-900 text-white">
      <header className="flex items-center gap-4 border-b border-zinc-700 px-5 py-3 sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <Link
            to="/kiosk"
            className="shrink-0 rounded-xl bg-zinc-700 px-5 py-3 text-2xl font-semibold active:bg-zinc-600"
            aria-label="Back to home"
          >
            ←
          </Link>
          <h1 className="min-w-0 truncate text-3xl font-bold tracking-tight sm:text-4xl">
            {device?.name ?? 'Sensor'}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {setpointReading && (
            <SetpointControl
              deviceId={deviceId}
              setpointC={setpointReading.value}
              pendingC={device?.pendingSetpointC ?? null}
              onApplied={refresh}
              variant="header"
            />
          )}
          {device && (
            <span
              className={`inline-flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-lg font-semibold ${
                device.online ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-700 text-zinc-400'
              }`}
            >
              <span
                className={`h-3 w-3 rounded-full ${
                  device.online
                    ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]'
                    : 'bg-zinc-500'
                }`}
                aria-hidden
              />
              {device.online ? 'Online' : 'Offline'}
            </span>
          )}
        </div>
      </header>

      <main className="flex flex-1 flex-col gap-4 overflow-hidden p-5 sm:p-6">
        {/* Current value */}
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          {latest ? (
            isStateMetric(latest.metric) ? (
              <StateBadge value={latest.value} size="lg" />
            ) : (
              <>
                <span className="text-6xl font-bold tabular-nums sm:text-7xl">
                  {formatValue(latest)}
                </span>
                {!hasMetricSelector && (
                  <span className="text-2xl text-zinc-400">{metricLabel(latest.metric)}</span>
                )}
              </>
            )
          ) : (
            <span className="text-3xl text-zinc-400">No readings yet</span>
          )}
        </div>

        {/* All-time consumption (energy / water meters) */}
        {totalMetric && total != null && (
          <div className="text-xl text-zinc-400">
            All-time{' '}
            <span className="font-semibold tabular-nums text-zinc-200">
              {formatValue({ metric: totalMetric, value: total, recordedAt: '' })}
            </span>
          </div>
        )}

        {/* Metric (if several) + range selectors */}
        <div className="flex flex-wrap items-center gap-3">
          {!lockedMetric && device && device.latest.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {device.latest.map((r) => (
                <button
                  key={r.metric}
                  type="button"
                  onClick={() => setMetric(r.metric)}
                  className={`rounded-xl px-5 py-3 text-xl font-semibold active:scale-[0.98] ${
                    r.metric === metric ? 'bg-blue-600' : 'bg-zinc-700 active:bg-zinc-600'
                  }`}
                >
                  {metricLabel(r.metric)}
                </button>
              ))}
            </div>
          )}
          <div className="ml-auto flex gap-2">
            {RANGES.map((r) => (
              <button
                key={r.label}
                type="button"
                onClick={() => setRangeMs(r.ms)}
                className={`rounded-xl px-5 py-3 text-xl font-semibold active:scale-[0.98] ${
                  r.ms === rangeMs ? 'bg-blue-600' : 'bg-zinc-700 active:bg-zinc-600'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* Chart fills the rest of the screen */}
        <div className="min-h-0 flex-1 rounded-2xl border-2 border-zinc-700 bg-zinc-800 p-3">
          {chartData.length === 0 ? (
            <div className="flex h-full items-center justify-center text-2xl text-zinc-400">
              No readings in this range.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  scale="time"
                  tickFormatter={(t) => formatTick(t, longRange)}
                  tick={{ fontSize: 14, fill: '#cbd5e1' }}
                  stroke="#475569"
                  minTickGap={48}
                />
                <YAxis
                  width={52}
                  tick={{ fontSize: 14, fill: '#cbd5e1' }}
                  stroke="#475569"
                  domain={metric && isStateMetric(metric) ? [-1.1, 1.1] : ['auto', 'auto']}
                  ticks={metric && isStateMetric(metric) ? [-1, 0, 1] : undefined}
                  tickFormatter={
                    metric && isStateMetric(metric) ? (v) => stateTick(v) : undefined
                  }
                />
                <Tooltip
                  contentStyle={{
                    background: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: 10,
                    color: '#e2e8f0',
                    fontSize: 16,
                  }}
                  labelStyle={{ color: '#94a3b8' }}
                  itemStyle={{ color: '#e2e8f0' }}
                  cursor={{ stroke: '#475569' }}
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
                  strokeWidth={3}
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
