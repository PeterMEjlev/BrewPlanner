import { isMockDeviceId } from '@checklist/shared';
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
import { api } from '../api';
import { canControl, useAuth } from '../auth';
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
  type TimePoint,
  cumulativeMetricOf,
  useDeviceData,
  useDeviceTotal,
  useSetpointChanges,
} from '../useDeviceData';
import { dateTime } from '../util';
import { formatAxisValue, niceRange, withMinSpan } from './charts';
import { axisOf, extentOf, mergeSeries, valueKey } from './chartSeries';
import {
  setpointTargetSeries,
  setpointTargetSpan,
  visibleSetpointChanges,
} from './eventMarkers';
import {
  SELECTION_AREA,
  SelectionSummary,
  type SelectionSeries,
  selectionStats,
} from './chartSelect';
import { MIN_TEMP_ZOOM_SPAN_C, type Span, useChartZoom } from './chartZoom';
import { type ThinMode, thinForPlot } from './decimate';
import { IntervalSelect, intervalLabel } from './intervalPicker';
import { setpointChangeLines } from './setpointMarkers';
import { timeAxis } from './timeAxis';

/** Metrics measured in °C, so the "Temp chart min span" setting applies. */
function isTempMetric(metric: string): boolean {
  return metric === 'temp_c' || metric === 'setpoint_c';
}

/**
 * How far the value axis may be zoomed in, in the metric's own units — a floor
 * of about five of the steps the metric is actually reported in. Any narrower
 * and the zoom is magnifying sensor quantisation rather than the reading: the
 * trace turns into a staircase and the axis labels a tenth of a degree in
 * thousandths. Gravity is the one metric read finer than two decimals, at a
 * point (0.001) a step.
 */
function minYSpanFor(metric: string | null): number {
  if (!metric) return 0;
  if (isTempMetric(metric)) return MIN_TEMP_ZOOM_SPAN_C;
  return metric.endsWith('_sg') ? 0.005 : 0.05;
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
 * Width of a setpoint marker's hit area (see setpointMarkers.tsx), and so the
 * closest two of them can land and still be hoverable separately. Markers nearer
 * than this are thinned away — they were unreachable anyway.
 */
const MARKER_HIT_WIDTH_PX = 18;

/** Stable empty marker list, so a gesture's frames don't each allocate one. */
const NO_MARKERS: SetpointMarker[] = [];

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
    metrics,
    toggleMetric,
    series,
    rangeMs,
    setRangeMs,
    chartData,
    latest,
    refresh,
    error,
  } = useDeviceData(deviceId, initialMetric, rangeControl);

  const colors = useGraphColors();
  const { auth } = useAuth();
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

  // Every metric on the chart, primary first. Memoised through its joined form
  // so it keeps one identity across the device polls underneath it — the plot
  // and axis maths below hang off this.
  const drawnKey = (breweryTempOnly ? ['temp_c'] : metrics).join(',');
  const drawnMetrics = useMemo(() => (drawnKey ? drawnKey.split(',') : []), [drawnKey]);

  // The primary's unit owns the left axis; anything measured differently is
  // drawn against a second axis on the right (see axisOf).
  const leftAxis = chartMetric ? axisOf(chartMetric) : null;
  const { leftMetrics, rightMetrics } = useMemo(
    () => ({
      leftMetrics: drawnMetrics.filter((m) => axisOf(m) === leftAxis),
      rightMetrics: drawnMetrics.filter((m) => axisOf(m) !== leftAxis),
    }),
    [drawnMetrics, leftAxis],
  );
  const hasRightAxis = rightMetrics.length > 0;
  // A right axis carrying only state metrics gets their fixed -1/0/+1 scale
  // rather than a computed one, exactly as the left axis does for a state chart.
  const rightStateAxis = hasRightAxis && rightMetrics.every(isStateMetric);

  // The dashed target line reconstructs the setpoint from the moments it was
  // changed. With the logged `setpoint_c` series overlaid on the chart that is
  // the same line drawn twice, so the reconstruction stands down and lets the
  // readings speak. On the setpoint's own chart the plotted line *is* the target.
  const showTarget = chartMetric === 'temp_c' && !drawnMetrics.includes('setpoint_c');

  // What the controller is holding to *now*. Only the tail of the target line
  // below, and the whole of it when nothing moved across the window.
  const targetC = showTarget ? (setpointReading?.value ?? targetOverride ?? null) : null;

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

  // Full extent of the loaded window — both the unzoomed view and the floor that
  // zooming out returns to. Across every drawn metric, not just the primary: a
  // metric that only started logging partway through the window would otherwise
  // be clipped at the axis.
  const xExtent = useMemo<Span | null>(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let points = 0;
    for (const m of drawnMetrics) {
      const rows = series[m] ?? [];
      points += rows.length;
      if (rows.length === 0) continue;
      min = Math.min(min, rows[0]!.t);
      max = Math.max(max, rows[rows.length - 1]!.t);
    }
    return points < 2 || min >= max ? null : { min, max };
  }, [series, drawnMetrics]);

  // A temperature chart honours the brewer's "Temp chart min span" here too, so
  // an enlarged chart frames a tight-holding fridge just like its Overview
  // sparkline does instead of stretching a fraction of a degree to full height.
  // Everywhere the target line goes, so the axis can hold all of it. Computed
  // from the changes rather than from the drawn series, which is downstream of
  // the zoom this feeds.
  const targetSpan = useMemo(
    () => (showTarget ? setpointTargetSpan(setpointChanges, targetC) : null),
    [showTarget, setpointChanges, targetC],
  );

  // The left axis has to hold every metric sharing the primary's unit, not just
  // the primary itself — a setpoint overlaid on a temperature is off the chart
  // otherwise, which is the case it is most wanted in.
  const yExtent = useMemo<Span | null>(() => {
    if (stateMetric) return null;
    const extent = extentOf(leftMetrics.map((m) => series[m] ?? []));
    if (extent == null) return null;
    if (!tempMetric) return extent;
    // The target has to be inside the domain or its line falls off the chart —
    // exactly the case where it matters most, a fridge sitting well off setpoint,
    // and now for every level it held rather than only the current one.
    const withTarget =
      targetSpan == null
        ? extent
        : { min: Math.min(extent.min, targetSpan.min), max: Math.max(extent.max, targetSpan.max) };
    return niceRange(withMinSpan(withTarget.min, withTarget.max, tempMinSpanC));
  }, [series, leftMetrics, stateMetric, tempMetric, tempMinSpanC, targetSpan]);

  // The right axis is left to its own extent: the zoom gestures drive the
  // primary's axis (that is the reading being examined), and a second scale that
  // moved with it would imply a relationship between the two that isn't there.
  const rightExtent = useMemo<Span | null>(() => {
    if (!hasRightAxis || rightStateAxis) return null;
    const extent = extentOf(rightMetrics.map((m) => series[m] ?? []));
    if (extent == null) return null;
    return niceRange(
      rightMetrics.every(isTempMetric)
        ? withMinSpan(extent.min, extent.max, tempMinSpanC)
        : extent,
    );
  }, [series, rightMetrics, hasRightAxis, rightStateAxis, tempMinSpanC]);

  const zoom = useChartZoom({
    xExtent,
    yExtent,
    plotInset: PLOT_INSET,
    minXSpan: MIN_X_SPAN_MS,
    minYSpan: minYSpanFor(chartMetric),
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
  // One pass, no intermediate arrays: this re-runs on every frame of a pan, and
  // a filter-then-map-then-spread over a day of 30s readings allocates three
  // times per frame to answer two numbers.
  const visibleExtremes = useMemo<Span | null>(() => {
    if (stateMetric) return null;
    const x = zoom.xDomain;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let count = 0;
    for (const point of chartData) {
      if (x && (point.t < x.min || point.t > x.max)) continue;
      if (point.value < min) min = point.value;
      if (point.value > max) max = point.value;
      count += 1;
    }
    return count < 2 ? null : { min, max };
  }, [chartData, stateMetric, zoom.xDomain]);

  // The markers actually worth mounting. Two things bound them: the window on
  // screen, and how close together they can land before one hit area swallows
  // the next (see visibleSetpointChanges).
  //
  // And none at all mid-gesture. They draw nothing of their own — each is an
  // invisible hover region whose only output is a badge while the pointer is
  // inside it — so a pan that drops them looks identical and stops re-rendering
  // up to 200 recharts components per frame. Same bargain as the tooltip below,
  // for the same reason: you cannot hover something you are busy dragging.
  const gesturing = zoom.dragging || zoom.selecting;
  const markerChanges = useMemo(
    () =>
      gesturing
        ? NO_MARKERS
        : visibleSetpointChanges(setpointChanges, xView, zoom.plotWidth, MARKER_HIT_WIDTH_PX),
    [gesturing, setpointChanges, xView, zoom.plotWidth],
  );

  // Built once per change to the set rather than once per frame, so a re-render
  // that only moved the domain hands recharts the very same elements back.
  const markerElements = useMemo(
    () =>
      setpointChangeLines({
        changes: markerChanges,
        color: colors.setpoint,
        hovered: hoveredChange,
        onHover: setHoveredChange,
      }),
    [markerChanges, colors.setpoint, hoveredChange],
  );

  // A marker that slides out of the window (or off a metric switch) is unmounted
  // without ever firing a pointer-leave, and a hover left set would keep the
  // data tooltip suppressed for good. Let go of one that is no longer mounted —
  // which is the culled set, not every change in the range.
  useEffect(() => {
    setHoveredChange((cur) => (cur && markerChanges.some((c) => c.t === cur.t) ? cur : null));
  }, [markerChanges]);

  // Every line a shift-dragged period can be asked about: what each sensor read,
  // and what it was being held to. A state metric has no meaningful min/mean, so
  // it contributes no row — with only that on the chart the card summarises the
  // period alone.
  const selectionSeries = useMemo<SelectionSeries[]>(() => {
    const rows: SelectionSeries[] = drawnMetrics
      .filter((m) => !isStateMetric(m))
      .map((m) => ({
        key: valueKey(m),
        label: metricLabel(m),
        color: metricColor(m, colors),
      }));
    if (targetSpan != null) rows.push({ key: 'target', label: 'Target', color: colors.setpoint });
    return rows;
  }, [drawnMetrics, colors, targetSpan]);

  // Which metric each summarised row is measured in, so the card can put every
  // row in its own unit instead of all of them in the primary's.
  const seriesMetric = useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of drawnMetrics) map[valueKey(m)] = m;
    map.target = 'setpoint_c';
    return map;
  }, [drawnMetrics]);

  // The rows under the band, at full resolution — `plotData` below is
  // bucket-averaged at this zoom, and a summary quoting its peak would
  // under-report the one actually recorded. The target is resolved onto just
  // these rows rather than the whole loaded window, which is what keeps this
  // cheap enough to run on every frame of a paint.
  const selectionRows = useMemo(() => {
    const range = zoom.selection;
    if (range == null) return [];
    const inside = mergeSeries(
      drawnMetrics.map((m) => ({
        key: valueKey(m),
        points: (series[m] ?? []).filter((p) => p.t >= range.min && p.t <= range.max),
      })),
    );
    if (targetSpan == null || inside.length === 0) return inside;
    const target = setpointTargetSeries(
      setpointChanges,
      inside.map((row) => row.t!),
      targetC,
    );
    if (target.length !== inside.length) return inside;
    return inside.map((row, i) => ({ ...row, target: target[i]! }));
  }, [series, drawnMetrics, zoom.selection, targetSpan, setpointChanges, targetC]);

  const selectionStatsRows = useMemo(
    () =>
      zoom.selection == null
        ? []
        : selectionStats(
            selectionRows,
            zoom.selection,
            (row) => row.t!,
            selectionSeries,
            (row, key) => row[key],
          ),
    [selectionRows, zoom.selection, selectionSeries],
  );

  // Draw only what's on screen, thinned to about one point per pixel: a day of
  // 30s readings is ~2,900 points, and redrawing all of them each frame is what
  // makes a drag drag. A temperature trace is averaged into buckets instead of
  // peak-thinned — see `smooth` on ThinMode for why its extremes are the part
  // worth losing. Each overlaid metric is thinned by the rule that suits it, not
  // by the primary's: averaging the HVAC mode would invent half-states.
  const plotData = useMemo(
    () =>
      mergeSeries(
        drawnMetrics.map((m) => {
          const mode: ThinMode = isStateMetric(m) ? 'step' : isTempMetric(m) ? 'smooth' : 'peaks';
          return {
            key: valueKey(m),
            points: thinForPlot(
              series[m] ?? [],
              zoom.xDomain,
              mode === 'smooth' ? SMOOTH_PLOT_POINTS : MAX_PLOT_POINTS,
              mode,
            ),
          };
        }),
      ),
    [series, drawnMetrics, zoom.xDomain],
  );

  // The target at each plotted moment, as a column on the rows themselves —
  // recharts draws a line from a dataKey, and `stepAfter` then holds each level
  // flat until the moment it changed rather than sloping between them.
  const plotRows = useMemo(() => {
    if (targetSpan == null) return plotData;
    const target = setpointTargetSeries(
      setpointChanges,
      plotData.map((row) => row.t!),
      targetC,
    );
    if (target.length !== plotData.length) return plotData;
    return plotData.map((row, i) => ({ ...row, target: target[i]! }));
  }, [plotData, setpointChanges, targetC, targetSpan]);

  const hasTarget = plotRows.length > 0 && 'target' in plotRows[0]!;

  // The logging cadence, offered here as well as on the Devices and Settings
  // pages: a curve that is too coarse to read is exactly when a brewer wants it
  // finer, and having to leave the chart to find the setting is how you forget
  // to put it back. Mock sensors have no agent to honour it, so they don't show
  // it at all; a guest sees the cadence but can't move it.
  const editableInterval = canControl(auth) && !isMockDeviceId(deviceId);
  // Held until the device status catches up, so the picker doesn't snap back to
  // the old cadence for the length of a round trip.
  const [pendingInterval, setPendingInterval] = useState<number | null>(null);
  const shownInterval = pendingInterval ?? device?.reportingIntervalSec ?? null;

  useEffect(() => {
    if (pendingInterval != null && device?.reportingIntervalSec === pendingInterval) {
      setPendingInterval(null);
    }
  }, [device, pendingInterval]);

  const applyInterval = (seconds: number): void => {
    setPendingInterval(seconds);
    api
      .setDeviceInterval(deviceId, seconds)
      .catch(() => setPendingInterval(null))
      .finally(() => refresh());
  };

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
          <div className="flex flex-wrap gap-2">
            {metricOptions.map((r) => {
              const on = drawnMetrics.includes(r.metric);
              // The last one on can't be switched off — a chart has to plot
              // something, and an empty one reads as a broken one.
              const only = on && drawnMetrics.length === 1;
              return (
                <button
                  key={r.metric}
                  type="button"
                  onClick={() => toggleMetric(r.metric)}
                  aria-pressed={on}
                  title={
                    only
                      ? `${metricLabel(r.metric)} — the only metric shown`
                      : on
                        ? `Stop showing ${metricLabel(r.metric)}`
                        : `Also show ${metricLabel(r.metric)} on this chart`
                  }
                  className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    on
                      ? 'bg-blue-600 text-white'
                      : 'border border-zinc-700 text-zinc-300 hover:bg-zinc-800'
                  }`}
                >
                  {/* Doubles as the chart's legend: the dot is the colour this
                      metric is drawn in, so a stack of overlaid lines can be
                      read off the buttons that turned them on. */}
                  <span
                    className={`h-2 w-2 rounded-full transition-opacity ${on ? '' : 'opacity-40'}`}
                    style={{ backgroundColor: metricColor(r.metric, colors) }}
                    aria-hidden
                  />
                  {metricLabel(r.metric)}
                </button>
              );
            })}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
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
          {shownInterval != null && (
            <div
              className="ml-1 flex items-center gap-1.5 border-l border-zinc-800 pl-3"
              title={
                'How often this device logs a reading — the resolution of the curve. ' +
                'Its sensor agent matches its push rate to this, and this chart polls at the same cadence.'
              }
            >
              <span className="text-xs uppercase tracking-wider text-zinc-500">Log</span>
              {editableInterval ? (
                <IntervalSelect
                  seconds={shownInterval}
                  align="right"
                  onChange={applyInterval}
                  className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-sm font-medium tabular-nums text-zinc-300 transition hover:bg-zinc-800"
                />
              ) : (
                <span className="text-sm font-medium tabular-nums text-zinc-300">
                  {intervalLabel(shownInterval)}
                </span>
              )}
            </div>
          )}
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
          {plotData.length === 0 ? (
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
                {/* The scale for anything overlaid that isn't in the primary's
                    unit. Left unnamed above so every existing reference — the
                    selection band, the setpoint markers — keeps binding to the
                    primary axis without being told to. */}
                {hasRightAxis && (
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    width={Y_AXIS_WIDTH}
                    tick={{ fontSize: 12, fill: '#94a3b8' }}
                    stroke="#334155"
                    allowDataOverflow
                    domain={
                      rightStateAxis
                        ? [-1.1, 1.1]
                        : rightExtent
                          ? [rightExtent.min, rightExtent.max]
                          : ['auto', 'auto']
                    }
                    ticks={rightStateAxis ? [-1, 0, 1] : undefined}
                    tickFormatter={
                      rightStateAxis
                        ? (v) => stateTick(v)
                        : (v) =>
                            formatAxisValue(
                              v,
                              rightExtent ? rightExtent.max - rightExtent.min : null,
                            )
                    }
                  />
                )}
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
                    // Several lines now, each named and formatted from its own
                    // series: overlay the HVAC mode on a temperature and the
                    // rows have to read "Heating", not "1.00 °C".
                    formatter={(value, name, item) => {
                      const num = typeof value === 'number' ? value : Number(value);
                      const key = typeof item?.dataKey === 'string' ? item.dataKey : '';
                      const m = seriesMetric[key] ?? chartMetric;
                      return [
                        m ? formatValue({ metric: m, value: num, recordedAt: '' }) : num,
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
                {drawnMetrics.map((m) => (
                  <Line
                    key={m}
                    // Each series is thinned on its own timestamps, so the rows
                    // carry gaps where another series has a point and this one
                    // doesn't — connectNulls draws through them.
                    connectNulls
                    yAxisId={axisOf(m) === leftAxis ? undefined : 'right'}
                    type={isStateMetric(m) ? 'stepAfter' : 'monotone'}
                    dataKey={valueKey(m)}
                    name={metricLabel(m)}
                    stroke={metricColor(m, colors)}
                    // The primary is the reading being examined; anything
                    // overlaid on it is context, and drawn a shade lighter.
                    strokeWidth={m === chartMetric ? 2 : 1.5}
                    dot={false}
                    isAnimationActive={false}
                  />
                ))}
                {/* After the lines, so a marker's hover region wins the pointer
                    at a crossing. */}
                {markerElements}
              </LineChart>
            </ResponsiveContainer>
          )}
          {zoom.selection && (
            <SelectionSummary
              range={zoom.selection}
              view={xView}
              inset={PLOT_INSET}
              stats={selectionStatsRows}
              formatValue={(v, s) => {
                const m = seriesMetric[s.key] ?? chartMetric;
                return m ? formatValue({ metric: m, value: v, recordedAt: '' }) : String(v);
              }}
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
