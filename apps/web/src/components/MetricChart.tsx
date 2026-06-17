import { useEffect, useMemo } from 'react';
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
import { useChartRangeStore } from '../chartRange';
import { metricColor, useGraphColors } from '../graphColors';
import {
  StateBadge,
  formatValue,
  isStateMetric,
  metricLabel,
  stateTick,
} from '../pages/Dashboard';
import {
  RANGES,
  cumulativeMetricOf,
  formatTick,
  useDeviceData,
  useDeviceTotal,
} from '../useDeviceData';

function isBreweryTempDevice(device: { name: string; type: string }): boolean {
  return device.type === 'brew_controller' && /brewery|ambient/i.test(device.name);
}

/**
 * One device's live value, optional setpoint control, metric/range selectors
 * and a history line chart. Shared by the full device page ([DevicePage]) and
 * the dashboard's enlarge-on-click overlay ([MetricModal]). Pulls in recharts,
 * so it's only ever loaded inside an already-lazy chunk.
 */
export default function MetricChart({
  deviceId,
  initialMetric,
  chartHeight = 320,
}: {
  deviceId: number;
  initialMetric?: string;
  chartHeight?: number;
}): JSX.Element {
  // When rendered inside the dashboard's range provider, the selected window is
  // shared with the matching sparkline preview (keyed by device+metric); on the
  // standalone device page there's no provider, so the chart keeps local state.
  const rangeStore = useChartRangeStore();
  const rangeControl = useMemo(
    () =>
      rangeStore
        ? {
            get: (m: string | null) => rangeStore.getRange(deviceId, m),
            set: (m: string | null, ms: number) => rangeStore.setRange(deviceId, m, ms),
          }
        : undefined,
    [rangeStore, deviceId],
  );

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
  } = useDeviceData(deviceId, initialMetric, rangeControl);

  const colors = useGraphColors();
  const totalMetric = cumulativeMetricOf(device);
  const total = useDeviceTotal(deviceId, totalMetric);
  const setpointReading = device?.latest.find((r) => r.metric === 'setpoint_c');
  const supportsSetpoint = device?.type === 'brew_controller';

  const breweryTempOnly = !!device && isBreweryTempDevice(device);
  // A hydrometer's beer temp duplicates the fermenter's Temp & Control card, so
  // the gravity chart drops the Temp metric and shows gravity alone.
  const gravityOnly = device?.type === 'hydrometer';
  const metricOptions = breweryTempOnly
    ? device.latest.filter((r) => r.metric === 'temp_c')
    : gravityOnly
      ? device!.latest.filter((r) => r.metric !== 'temp_c')
      : (device?.latest ?? []);
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

  // Never leave the gravity chart parked on the (now hidden) Temp metric.
  useEffect(() => {
    if (gravityOnly && metric === 'temp_c') {
      setMetric('gravity_sg');
    }
  }, [gravityOnly, metric, setMetric]);

  return (
    <div>
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

      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        {chartData.length === 0 ? (
          <p className="py-20 text-center text-sm text-zinc-500">No readings in this range.</p>
        ) : (
          <ResponsiveContainer width="100%" height={chartHeight}>
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
                stroke={chartMetric ? metricColor(chartMetric, colors) : '#3b82f6'}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
