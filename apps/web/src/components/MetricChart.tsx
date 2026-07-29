import { useEffect, useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
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
import { useSettings } from '../settings';
import {
  RANGES,
  cumulativeMetricOf,
  formatTick,
  useDeviceData,
  useDeviceTotal,
} from '../useDeviceData';
import { withMinSpan } from './charts';
import { type Span, useChartZoom } from './chartZoom';
import { type ThinMode, thinForPlot } from './decimate';

function isBreweryTempDevice(device: { name: string; type: string }): boolean {
  return device.type === 'brew_controller' && /brewery|ambient/i.test(device.name);
}

/** Metrics measured in °C, so the "Temp chart min span" setting applies. */
function isTempMetric(metric: string): boolean {
  return metric === 'temp_c' || metric === 'setpoint_c';
}

const CHART_MARGIN = { top: 8, right: 16, bottom: 8, left: 0 } as const;
const Y_AXIS_WIDTH = 48;
const X_AXIS_HEIGHT = 30; // recharts' default XAxis height

/**
 * Where the plot area sits inside the chart wrapper — the axes eat a gutter on
 * the left and bottom. Mirrors the margins and axis sizes below so
 * {@link useChartZoom} can tell "over the plot" from "over an axis".
 */
const PLOT_INSET = {
  left: CHART_MARGIN.left + Y_AXIS_WIDTH,
  right: CHART_MARGIN.right,
  top: CHART_MARGIN.top,
  bottom: CHART_MARGIN.bottom + X_AXIS_HEIGHT,
};

/** Don't let the time axis zoom in past a one-minute window. */
const MIN_X_SPAN_MS = 60_000;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

/** Round tick steps to look for within each order of magnitude. */
const NICE_STEPS = [1, 2, 2.5, 5, 10];

/**
 * Round a value window outward onto round numbers, aiming for ~5 gridlines.
 * recharts steps its ticks up from whatever domain minimum we hand it, so an
 * exact-fit domain would label the axis 0.348 / 0.848 / …; snapping the ends to a
 * round step keeps the familiar 0 / 0.5 / 1 labels (and leaves a little headroom
 * over the peak).
 */
function niceRange({ min, max }: Span): Span {
  const rough = (max - min) / 5;
  if (!(rough > 0)) return { min, max };
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = (NICE_STEPS.find((s) => s >= rough / mag - 1e-9) ?? 10) * mag;
  return { min: Math.floor(min / step) * step, max: Math.ceil(max / step) * step };
}

/**
 * Y tick label at a precision that suits how much of the metric is on screen —
 * whole watts when a chart spans hundreds, three decimals once a zoom is down to
 * a few gravity points. Also hides the float drift that snapping a domain to a
 * round step can leave behind.
 */
function formatAxisValue(v: number, span: number | null): string {
  if (span == null || !(span > 0)) return String(v);
  if (span >= 20) return v.toFixed(0);
  if (span >= 2) return v.toFixed(1);
  if (span >= 0.2) return v.toFixed(2);
  if (span >= 0.02) return v.toFixed(3);
  return v.toFixed(4);
}

/**
 * How the time axis labels itself, chosen from the window actually on screen (so
 * it follows both the range button and any zoom): plain dates once a chart covers
 * several days, a date alongside the clock while it straddles midnight — a bare
 * "08:59 PM" is ambiguous when the same time appears on two days — clock times
 * within a single day, and seconds once zoomed right in.
 */
function timeTickFormat(view: Span | null): (t: number) => string {
  if (!view) return (t) => formatTick(t, false);
  const span = view.max - view.min;
  if (span > 3 * ONE_DAY_MS) return (t) => formatTick(t, true);
  if (new Date(view.min).toDateString() !== new Date(view.max).toDateString()) {
    return (t) =>
      new Date(t).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
  }
  if (span > TEN_MINUTES_MS) return (t) => formatTick(t, false);
  return (t) =>
    new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Cap on plotted points. Roughly one per pixel of a wide chart: enough that the
 * thinned curve is indistinguishable, few enough that a pan re-draws cheaply.
 */
const MAX_PLOT_POINTS = 1200;

/**
 * Cap for a temperature trace, which is averaged into buckets rather than
 * thinned (see {@link thinForPlot}). Far coarser than the point budget above,
 * for the same reason the previews are (see SERIES_BUCKETS in useDeviceData):
 * what settles a cycling fridge is the bucket spanning a couple of its
 * compressor cycles, and at one point per pixel a bucket holds two or three
 * readings and smooths nothing. 120 points is ~12 minutes at the 24h range.
 *
 * Nothing is lost to it: recharts splines the line so it doesn't read as
 * polygonal, no temperature move worth looking at happens in twelve minutes,
 * and the buckets narrow as the chart zooms — pulled in far enough, every raw
 * reading is back.
 */
const SMOOTH_PLOT_POINTS = 120;

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
  targetC: targetOverride,
}: {
  deviceId: number;
  initialMetric?: string;
  chartHeight?: number;
  /**
   * Target temp for a device that has no setpoint of its own — a Tilt's beer
   * temp is held to the Inkbird's setpoint, which this chart can't see. Ignored
   * when the device does carry one.
   */
  targetC?: number;
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
    refresh,
    error,
  } = useDeviceData(deviceId, initialMetric, rangeControl);

  const colors = useGraphColors();
  const { tempMinSpanC } = useSettings();
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

  const stateMetric = !!chartMetric && isStateMetric(chartMetric);
  const tempMetric = !!chartMetric && isTempMetric(chartMetric);

  // The target the controller is holding to, drawn as a dotted line across the
  // temp chart — the Overview sparkline carries it, so an enlarged chart without
  // it lost the one reference that says whether the curve is where it should be.
  // Only on `temp_c`: on the setpoint's own chart the plotted line *is* the target.
  const targetC =
    chartMetric === 'temp_c' ? (setpointReading?.value ?? targetOverride ?? null) : null;

  // Full extent of the loaded window — both the unzoomed view and the floor that
  // zooming out returns to.
  const xExtent = useMemo<Span | null>(() => {
    if (chartData.length < 2) return null;
    return { min: chartData[0]!.t, max: chartData[chartData.length - 1]!.t };
  }, [chartData]);

  // A temperature chart honours the brewer's "Temp chart min span" here too, so
  // an enlarged chart frames a tight-holding fridge just like its Overview
  // sparkline does instead of stretching a fraction of a degree to full height.
  const yExtent = useMemo<Span | null>(() => {
    if (stateMetric || chartData.length === 0) return null;
    const values = chartData.map((d) => d.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (!tempMetric) return { min, max };
    // The target has to be inside the domain or its line falls off the chart —
    // exactly the case where it matters most, a fridge sitting well off setpoint.
    const withTarget =
      targetC == null ? { min, max } : { min: Math.min(min, targetC), max: Math.max(max, targetC) };
    return niceRange(withMinSpan(withTarget.min, withTarget.max, tempMinSpanC));
  }, [chartData, stateMetric, tempMetric, tempMinSpanC, targetC]);

  const zoom = useChartZoom({
    xExtent,
    yExtent,
    plotInset: PLOT_INSET,
    minXSpan: MIN_X_SPAN_MS,
    resetKey: `${chartMetric ?? ''}:${rangeMs}`,
  });

  // Label precision follows whatever slice of the metric is actually on screen.
  const visibleYSpan = zoom.yDomain
    ? zoom.yDomain.max - zoom.yDomain.min
    : yExtent
      ? yExtent.max - yExtent.min
      : null;
  const formatXTick = useMemo(() => timeTickFormat(zoom.xDomain ?? xExtent), [zoom.xDomain, xExtent]);

  // The visible window's extremes, spelled out under the live value. The phone's
  // overview cards are too tight to carry a Min/Max line of their own, so opening
  // the chart is where a brewer reads how far a fridge or fermenter drifted.
  // Follows the zoom, so it always describes the slice actually on screen.
  const visibleExtremes = useMemo<Span | null>(() => {
    if (stateMetric) return null;
    const x = zoom.xDomain;
    const values = chartData
      .filter((d) => !x || (d.t >= x.min && d.t <= x.max))
      .map((d) => d.value);
    if (values.length < 2) return null;
    return { min: Math.min(...values), max: Math.max(...values) };
  }, [chartData, stateMetric, zoom.xDomain]);

  // Draw only what's on screen, thinned to about one point per pixel: a day of
  // 30s readings is ~2,900 points, and redrawing all of them each frame is what
  // makes a drag drag. A temperature trace is averaged into buckets instead of
  // peak-thinned — see `smooth` on ThinMode for why its extremes are the part
  // worth losing.
  const thinMode: ThinMode = stateMetric ? 'step' : tempMetric ? 'smooth' : 'peaks';
  const plotData = useMemo(
    () =>
      thinForPlot(
        chartData,
        zoom.xDomain,
        thinMode === 'smooth' ? SMOOTH_PLOT_POINTS : MAX_PLOT_POINTS,
        thinMode,
      ),
    [chartData, zoom.xDomain, thinMode],
  );

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
          {chartMetric && visibleExtremes && (
            <p className="mt-2 text-sm text-zinc-400">
              Min{' '}
              <span className="font-semibold tabular-nums text-zinc-200">
                {formatValue({ metric: chartMetric, value: visibleExtremes.min, recordedAt: '' })}
              </span>
              {'  ·  Max '}
              <span className="font-semibold tabular-nums text-zinc-200">
                {formatValue({ metric: chartMetric, value: visibleExtremes.max, recordedAt: '' })}
              </span>
            </p>
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
        <div className="flex items-center gap-2">
          {zoom.zoomed && (
            <button
              type="button"
              onClick={zoom.reset}
              className="mr-1 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800"
            >
              Reset zoom
            </button>
          )}
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
        {/* Hugs the chart exactly — the zoom maths measures the cursor against
            this box to tell the plot area from the axis gutters. */}
        <div
          ref={zoom.ref}
          onDoubleClick={zoom.reset}
          className="cursor-grab select-none active:cursor-grabbing"
        >
          {chartData.length === 0 ? (
            <p className="py-20 text-center text-sm text-zinc-500">No readings in this range.</p>
          ) : (
            <ResponsiveContainer width="100%" height={chartHeight}>
              <LineChart data={plotData} margin={CHART_MARGIN}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={
                    zoom.xDomain ? [zoom.xDomain.min, zoom.xDomain.max] : ['dataMin', 'dataMax']
                  }
                  allowDataOverflow
                  scale="time"
                  tickFormatter={formatXTick}
                  tick={{ fontSize: 12, fill: '#94a3b8' }}
                  stroke="#334155"
                  height={X_AXIS_HEIGHT}
                  minTickGap={40}
                />
                <YAxis
                  width={Y_AXIS_WIDTH}
                  tick={{ fontSize: 12, fill: '#94a3b8' }}
                  stroke="#334155"
                  allowDataOverflow
                  domain={
                    stateMetric
                      ? [-1.1, 1.1]
                      : zoom.yDomain
                        ? [zoom.yDomain.min, zoom.yDomain.max]
                        : tempMetric && yExtent
                          ? [yExtent.min, yExtent.max]
                          : ['auto', 'auto']
                  }
                  ticks={stateMetric ? [-1, 0, 1] : undefined}
                  tickFormatter={
                    stateMetric ? (v) => stateTick(v) : (v) => formatAxisValue(v, visibleYSpan)
                  }
                />
                {/* A tooltip chasing the cursor mid-pan is noise, and skipping
                    it keeps the drag cheaper. */}
                {!zoom.dragging && (
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
                )}
                {targetC != null && (
                  <ReferenceLine
                    y={targetC}
                    stroke={colors.setpoint}
                    strokeDasharray="2 4"
                    strokeWidth={1.5}
                    // Clipped rather than domain-extending: a zoom into a slice
                    // that excludes the target must stay where the user put it.
                    ifOverflow="hidden"
                    label={{
                      value: `Target ${targetC.toFixed(1)}°C`,
                      position: 'insideTopRight',
                      fill: colors.setpoint,
                      fontSize: 11,
                    }}
                  />
                )}
                <Line
                  type={stateMetric ? 'stepAfter' : 'monotone'}
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
        {chartData.length > 0 && (
          <p className="mt-2 text-center text-[11px] text-zinc-600">
            Scroll to zoom, drag to pan · over an axis to affect just that axis · double-click to
            reset
          </p>
        )}
      </div>
    </div>
  );
}
