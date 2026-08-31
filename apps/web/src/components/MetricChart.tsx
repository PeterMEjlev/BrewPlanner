import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { SetpointControl } from '../SetpointControl';
import { useChartRangeStore } from '../chartRange';
import { isBreweryTempDevice } from '../deviceRoles';
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
  type SetpointMarker,
  cumulativeMetricOf,
  useDeviceData,
  useDeviceTotal,
  useSetpointChanges,
} from '../useDeviceData';
import { dateTime } from '../util';
import { formatAxisValue, niceRange, withMinSpan } from './charts';
import { setpointTargetSeries, setpointTargetSpan } from './eventMarkers';
import {
  SELECTION_AREA,
  SelectionSummary,
  type SelectionSeries,
  selectionStats,
} from './chartSelect';
import { type Span, useChartZoom } from './chartZoom';
import { type ThinMode, thinForPlot } from './decimate';
import { setpointChangeLines } from './setpointMarkers';
import { timeAxis } from './timeAxis';

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
  targetDeviceId,
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
  /**
   * The controller that target belongs to, so the chart can also mark where it
   * was *changed* (see setpointMarkers.tsx). Same story as {@link targetC}: only
   * needed for a chart whose own device has no setpoint.
   */
  targetDeviceId?: number;
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

  // What the controller is holding to *now*. Only the tail of the target line
  // below, and the whole of it when nothing moved across the window. Only on
  // `temp_c`: on the setpoint's own chart the plotted line *is* the target.
  const targetC =
    chartMetric === 'temp_c' ? (setpointReading?.value ?? targetOverride ?? null) : null;

  // Where that target was moved, which is what turns it from a flat reference
  // line into a line through time. Read from the controller — this device when
  // it is one, otherwise the one holding it (a Tilt's beer temp is governed by
  // the Inkbird beside it).
  const setpointDeviceId = supportsSetpoint ? deviceId : (targetDeviceId ?? null);
  const setpointChanges = useSetpointChanges(
    chartMetric === 'temp_c' ? setpointDeviceId : null,
    rangeMs,
  );
  const [hoveredChange, setHoveredChange] = useState<SetpointMarker | null>(null);

  // A marker that slides out of the window (or off a metric switch) is unmounted
  // without ever firing a pointer-leave, and a hover left set would keep the
  // data tooltip suppressed for good. Let go of one that no longer exists.
  useEffect(() => {
    setHoveredChange((cur) =>
      cur && setpointChanges.some((c) => c.t === cur.t) ? cur : null,
    );
  }, [setpointChanges]);

  // Full extent of the loaded window — both the unzoomed view and the floor that
  // zooming out returns to.
  const xExtent = useMemo<Span | null>(() => {
    if (chartData.length < 2) return null;
    return { min: chartData[0]!.t, max: chartData[chartData.length - 1]!.t };
  }, [chartData]);

  // A temperature chart honours the brewer's "Temp chart min span" here too, so
  // an enlarged chart frames a tight-holding fridge just like its Overview
  // sparkline does instead of stretching a fraction of a degree to full height.
  // Everywhere the target line goes, so the axis can hold all of it. Computed
  // from the changes rather than from the drawn series, which is downstream of
  // the zoom this feeds.
  const targetSpan = useMemo(
    () => (chartMetric === 'temp_c' ? setpointTargetSpan(setpointChanges, targetC) : null),
    [chartMetric, setpointChanges, targetC],
  );

  const yExtent = useMemo<Span | null>(() => {
    if (stateMetric || chartData.length === 0) return null;
    const values = chartData.map((d) => d.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (!tempMetric) return { min, max };
    // The target has to be inside the domain or its line falls off the chart —
    // exactly the case where it matters most, a fridge sitting well off setpoint,
    // and now for every level it held rather than only the current one.
    const withTarget =
      targetSpan == null
        ? { min, max }
        : { min: Math.min(min, targetSpan.min), max: Math.max(max, targetSpan.max) };
    return niceRange(withMinSpan(withTarget.min, withTarget.max, tempMinSpanC));
  }, [chartData, stateMetric, tempMetric, tempMinSpanC, targetSpan]);

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
  // The window actually on screen — the zoom when there is one, else the whole
  // loaded range. Handed to the axis as an explicit domain rather than left to
  // dataMin/dataMax, so it stays the loaded window even when bucket-averaging
  // moves the first plotted point (see thinForPlot) — and so every tick below
  // lands inside the plot area.
  const xView = zoom.xDomain ?? xExtent;
  // Ticks on round clock times across that window, so they follow both the
  // range button and any zoom (see timeAxis.ts).
  const xAxis = useMemo(() => timeAxis(xView), [xView]);

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

  // Both lines a shift-dragged period can be asked about: what the sensor read,
  // and what it was being held to. A state metric has no meaningful average, so
  // that one summarises the period alone.
  const selectionSeries = useMemo<SelectionSeries[]>(() => {
    if (stateMetric || !chartMetric) return [];
    const rows: SelectionSeries[] = [
      { key: 'value', label: metricLabel(chartMetric), color: metricColor(chartMetric, colors) },
    ];
    if (targetSpan != null) rows.push({ key: 'target', label: 'Target', color: colors.setpoint });
    return rows;
  }, [stateMetric, chartMetric, colors, targetSpan]);

  // The rows under the band, at full resolution — `plotData` below is
  // bucket-averaged at this zoom, and a summary quoting its peak would
  // under-report the one actually recorded. The target is resolved onto just
  // these rows rather than the whole loaded window, which is what keeps this
  // cheap enough to run on every frame of a paint.
  const selectionRows = useMemo(() => {
    const range = zoom.selection;
    if (range == null) return [];
    const inside: { t: number; value: number; target?: number }[] = chartData.filter(
      (point) => point.t >= range.min && point.t <= range.max,
    );
    if (targetSpan == null || inside.length === 0) return inside;
    const target = setpointTargetSeries(
      setpointChanges,
      inside.map((point) => point.t),
      targetC,
    );
    if (target.length !== inside.length) return inside;
    return inside.map((point, i) => ({ ...point, target: target[i]! }));
  }, [chartData, zoom.selection, targetSpan, setpointChanges, targetC]);

  const selectionStatsRows = useMemo(
    () =>
      zoom.selection == null
        ? []
        : selectionStats(
            selectionRows,
            zoom.selection,
            (point) => point.t,
            selectionSeries,
            (point, key) => (key === 'target' ? point.target : point.value),
          ),
    [selectionRows, zoom.selection, selectionSeries],
  );

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

  // The target at each plotted moment, as a column on the rows themselves —
  // recharts draws a line from a dataKey, and `stepAfter` then holds each level
  // flat until the moment it changed rather than sloping between them.
  const plotRows = useMemo(() => {
    if (targetSpan == null) return plotData;
    const target = setpointTargetSeries(
      setpointChanges,
      plotData.map((p) => p.t),
      targetC,
    );
    if (target.length !== plotData.length) return plotData;
    return plotData.map((point, i) => ({ ...point, target: target[i]! }));
  }, [plotData, setpointChanges, targetC, targetSpan]);

  const hasTarget = plotRows.length > 0 && 'target' in plotRows[0]!;

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
          className={`relative select-none ${
            zoom.selecting ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'
          }`}
        >
          {chartData.length === 0 ? (
            <p className="py-20 text-center text-sm text-zinc-500">No readings in this range.</p>
          ) : (
            <ResponsiveContainer width="100%" height={chartHeight}>
              <LineChart data={plotRows} margin={CHART_MARGIN}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                {/* Before the lines, so the band tints the trace rather than
                    washing it out. */}
                {zoom.selection && (
                  <ReferenceArea
                    x1={zoom.selection.min}
                    x2={zoom.selection.max}
                    {...SELECTION_AREA}
                  />
                )}
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={xView ? [xView.min, xView.max] : ['dataMin', 'dataMax']}
                  allowDataOverflow
                  scale="time"
                  ticks={xAxis.ticks}
                  tickFormatter={xAxis.format}
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
                {/* A tooltip chasing the cursor mid-gesture is noise, and
                    skipping it keeps the drag cheaper. */}
                {!zoom.dragging && !zoom.selecting && (
                  <Tooltip
                    // Two tooltips over one marker is one too many: while a
                    // setpoint marker's badge is up, it *is* the answer to
                    // "what happened here".
                    active={hoveredChange ? false : undefined}
                    contentStyle={{
                      background: '#0f172a',
                      border: '1px solid #1e293b',
                      borderRadius: 8,
                      color: '#e2e8f0',
                    }}
                    labelStyle={{ color: '#94a3b8' }}
                    itemStyle={{ color: '#e2e8f0' }}
                    cursor={{ stroke: '#334155' }}
                    labelFormatter={(t) => dateTime(t as number, true)}
                    // Two lines now, so each is named from its own series
                    // rather than everything being labelled with the metric.
                    formatter={(value, name) => {
                      const num = typeof value === 'number' ? value : Number(value);
                      return [
                        chartMetric
                          ? formatValue({ metric: chartMetric, value: num, recordedAt: '' })
                          : num,
                        name,
                      ];
                    }}
                  />
                )}
                {hasTarget && (
                  <Line
                    // Held flat until the moment it moved: a target does not
                    // drift between two settings, it is one until it is the other.
                    type="stepAfter"
                    dataKey="target"
                    name="Target"
                    stroke={colors.setpoint}
                    strokeDasharray="2 4"
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                  />
                )}
                <Line
                  type={stateMetric ? 'stepAfter' : 'monotone'}
                  dataKey="value"
                  name={chartMetric ? metricLabel(chartMetric) : 'Value'}
                  stroke={chartMetric ? metricColor(chartMetric, colors) : '#3b82f6'}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                {/* After the lines, so a marker's hover region wins the pointer
                    at a crossing. */}
                {setpointChangeLines({
                  changes: setpointChanges,
                  color: colors.setpoint,
                  hovered: hoveredChange,
                  onHover: setHoveredChange,
                })}
              </LineChart>
            </ResponsiveContainer>
          )}
          {zoom.selection && (
            <SelectionSummary
              range={zoom.selection}
              view={xView}
              inset={PLOT_INSET}
              stats={selectionStatsRows}
              formatValue={(v) =>
                chartMetric
                  ? formatValue({ metric: chartMetric, value: v, recordedAt: '' })
                  : String(v)
              }
              formatTime={(t) => dateTime(t, true)}
              onClear={zoom.clearSelection}
            />
          )}
        </div>
        {chartData.length > 0 && (
          <p className="mt-2 text-center text-[11px] text-zinc-600">
            Scroll to zoom, drag to pan · over an axis for that axis only · shift-drag to measure
            a period · double-click to reset
          </p>
        )}
      </div>
    </div>
  );
}
