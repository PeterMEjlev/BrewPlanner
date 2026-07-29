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
import { metricColor, useGraphColors } from '../graphColors';
import { timeAxis } from '../components/timeAxis';
import { RANGES, cumulativeMetricOf, useDeviceData, useDeviceTotal } from '../useDeviceData';
import {
  StateBadge,
  formatValue,
  isStateMetric,
  metricLabel,
  stateTick,
} from './Dashboard';

function isBreweryTempDevice(device: { name: string; type: string }): boolean {
  return device.type === 'brew_controller' && /brewery|ambient/i.test(device.name);
}

/** Touch-first sensor view for the Pi screen: big number, big controls, big chart. */
export function KioskDevicePage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  // A `?metric=` query pins the page to one metric and hides the selector (the
  // fermenter's gravity link uses this so the Tilt's beer temp never shows here).
  const lockedMetric = params.get('metric') ?? undefined;
  const deviceId = Number(id);
  const { device, metric, setMetric, rangeMs, setRangeMs, chartData, latest, refresh } =
    useDeviceData(deviceId, lockedMetric);
  const colors = useGraphColors();
  // Round clock times across the loaded window rather than wherever the readings
  // happen to fall (see timeAxis.ts).
  const xAxis = timeAxis(
    chartData.length > 1
      ? { min: chartData[0]!.t, max: chartData[chartData.length - 1]!.t }
      : null,
  );

  // All-time consumption for energy/water meters (shown alongside the live value).
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
  // Brewery ambient is a plain temperature page; hide controller internals from
  // the graph picker while keeping the setpoint config available in the header.
  const hasMetricSelector = !lockedMetric && !breweryTempOnly && metricOptions.length > 1;
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
          {supportsSetpoint && (
            <SetpointControl
              deviceId={deviceId}
              setpointC={setpointReading?.value ?? null}
              pendingC={device?.pendingSetpointC ?? null}
              onApplied={refresh}
              variant="header"
            />
          )}
        </div>
      </header>

      <main className="flex flex-1 flex-col gap-4 overflow-hidden p-5 sm:p-6">
        {/* Current value */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {latestForDisplay ? (
            isStateMetric(latestForDisplay.metric) ? (
              <StateBadge value={latestForDisplay.value} size="lg" />
            ) : (
              <>
                <span className="text-6xl font-bold tabular-nums sm:text-7xl">
                  {formatValue(latestForDisplay)}
                </span>
                {!hasMetricSelector && (
                  <span className="text-2xl text-zinc-400">
                    {metricLabel(latestForDisplay.metric)}
                  </span>
                )}
              </>
            )
          ) : (
            <span className="text-3xl text-zinc-400">No readings yet</span>
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
          {hasMetricSelector && (
            <div className="flex flex-wrap gap-2">
              {metricOptions.map((r) => (
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
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  scale="time"
                  ticks={xAxis.ticks}
                  tickFormatter={xAxis.format}
                  tick={{ fontSize: 14, fill: '#94a3b8' }}
                  stroke="#334155"
                  minTickGap={48}
                />
                <YAxis
                  width={52}
                  tick={{ fontSize: 14, fill: '#94a3b8' }}
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
                    borderRadius: 10,
                    color: '#e2e8f0',
                    fontSize: 16,
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
                  stroke={chartMetric ? metricColor(chartMetric, colors) : '#3b82f6'}
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
