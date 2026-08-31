/**
 * Hand-rolled SVG visualizations for the desktop Overview, plus the value-axis
 * maths the recharts charts share with them. Kept dependency-free (no recharts)
 * so the Overview bundle stays small — recharts is loaded only on the
 * detail/chart pages. Each component is pure and presentational, driven by plain
 * numbers, so it renders the same against mock and live telemetry.
 */

import { Fragment, type PointerEvent as ReactPointerEvent, useState } from 'react';
import type { Span } from './chartZoom';
import { cardShift, markerFraction } from './eventMarkers';
import {
  type TimeWindow,
  coversSample,
  sampleTimeAt,
  snapToBar,
  snapToSample,
} from './chartHover';
import { clockTime } from '../util';

// --- Hover -------------------------------------------------------------------

/**
 * Pointing at a mini chart to read a value off it. The geometry — which sample
 * is under the pointer, and when it was recorded — lives in chartHover.ts; what
 * follows is the card and crosshair it draws.
 */

/** One line of a hover card: what it is, what it read, and the line's own mark. */
export interface SparkTooltipRow {
  label: string;
  value: string;
  color?: string;
  dash?: keyof typeof SPARK_DASH;
}

/** How a chart turns a hovered sample into a card. Omit to leave it un-hoverable. */
export interface SparkTooltip {
  /** Formats a plotted value, units and all. */
  format: (value: number) => string;
  /** Names the one series, on the single-series charts. */
  label?: string;
}

export type { TimeWindow };

/**
 * Past this, a bare clock time stops identifying a point: "09:56" on a week of
 * history could be any of seven mornings, so the day goes in front of it.
 */
const HOVER_DATE_SPAN_MS = 36 * 60 * 60 * 1000;

/** How a hovered moment is written, given how much time is on screen around it. */
function hoverTime(t: number, spanMs: number): string {
  if (spanMs <= HOVER_DATE_SPAN_MS) return clockTime(t);
  const day = new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
  return `${day} ${clockTime(t)}`;
}

/** When sample `index` of `points` spread across `window` was recorded. */
function sampleTime(index: number, points: number, window: TimeWindow | undefined): string | undefined {
  const t = sampleTimeAt(index, points, window);
  if (t == null || !window) return undefined;
  return hoverTime(t, window.end - window.start);
}

/**
 * Where the pointer is across a chart, 0 to 1.
 *
 * Left raw rather than snapped here because the charts don't agree on what a
 * sample is (see chartHover.ts): a line's points sit on the grid, a bar spans a
 * slice of it, and a forecast's are unevenly spaced along a real time axis.
 */
function useSparkPointer(enabled: boolean): {
  frac: number | null;
  bind: {
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerLeave: () => void;
  };
} {
  const [frac, setFrac] = useState<number | null>(null);
  return {
    frac: enabled ? frac : null,
    bind: {
      onPointerMove: (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        if (!(rect.width > 0)) return;
        setFrac(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
      },
      onPointerLeave: () => setFrac(null),
    },
  };
}

/** The thin rule under the pointer, marking which sample the card is quoting. */
function SparkCrosshair({ frac }: { frac: number }): JSX.Element {
  return (
    <div
      className="pointer-events-none absolute inset-y-0 w-px bg-zinc-500/70"
      style={{ left: `${frac * 100}%` }}
      aria-hidden
    />
  );
}

/**
 * The card itself: a heading, a row per series, and an optional note under a
 * rule for something that happened at this point rather than something measured
 * there (a target change).
 *
 * HTML rather than SVG because the plots are drawn with
 * `preserveAspectRatio="none"` — text inside one would be stretched by whatever
 * aspect the parent happens to give the chart.
 */
function SparkHoverCard({
  frac,
  heading,
  rows,
  note,
  noteColor,
}: {
  frac: number;
  heading?: string;
  rows: SparkTooltipRow[];
  note?: string;
  noteColor?: string;
}): JSX.Element {
  return (
    <div
      className="pointer-events-none absolute z-10 whitespace-nowrap rounded-lg border border-zinc-800 bg-zinc-950/95 px-2 py-1 text-[11px] leading-tight shadow-lg shadow-black/40"
      style={{ left: `${frac * 100}%`, top: 2, transform: cardShift(frac) }}
    >
      {heading && <div className="mb-1 font-medium text-zinc-400">{heading}</div>}
      <div className="grid grid-cols-[auto_auto] items-center gap-x-3 gap-y-0.5">
        {rows.map((row) => (
          <Fragment key={row.label}>
            <span className="flex items-center gap-1.5 text-zinc-400">
              {row.color && (
                <span
                  className="inline-block w-2.5 border-t-2"
                  style={{
                    borderColor: row.color,
                    borderStyle: row.dash === 'dotted' ? 'dotted' : row.dash === 'dashed' ? 'dashed' : 'solid',
                  }}
                  aria-hidden
                />
              )}
              {row.label}
            </span>
            <span className="justify-self-end font-semibold tabular-nums text-zinc-100">
              {row.value}
            </span>
          </Fragment>
        ))}
      </div>
      {note && (
        <div
          className="mt-1 border-t border-zinc-800 pt-1 font-semibold"
          style={{ color: noteColor }}
        >
          {note}
        </div>
      )}
    </div>
  );
}

/**
 * Widen a value range so it spans at least `minSpan`, keeping the data centred.
 * Charts otherwise auto-fit to the exact min/max, which stretches a tiny wobble
 * (e.g. a 0.3 °C swing) to fill the whole height and read as a big move; a floor
 * on the span keeps small changes looking small. A no-op when `minSpan` is unset
 * or the data already spans at least that much.
 */
export function withMinSpan(min: number, max: number, minSpan?: number): { min: number; max: number } {
  if (minSpan == null || max - min >= minSpan) return { min, max };
  const mid = (min + max) / 2;
  return { min: mid - minSpan / 2, max: mid + minSpan / 2 };
}

/** Round tick steps to look for within each order of magnitude. */
const NICE_STEPS = [1, 2, 2.5, 5, 10];

/**
 * Round a value window outward onto round numbers, aiming for ~5 gridlines.
 * recharts steps its ticks up from whatever domain minimum we hand it, so an
 * exact-fit domain would label the axis 0.348 / 0.848 / …; snapping the ends to a
 * round step keeps the familiar 0 / 0.5 / 1 labels (and leaves a little headroom
 * over the peak).
 */
export function niceRange({ min, max }: Span): Span {
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
export function formatAxisValue(v: number, span: number | null): string {
  if (span == null || !(span > 0)) return String(v);
  if (span >= 20) return v.toFixed(0);
  if (span >= 2) return v.toFixed(1);
  if (span >= 0.2) return v.toFixed(2);
  if (span >= 0.02) return v.toFixed(3);
  return v.toFixed(4);
}

/**
 * A thin line sparkline that stretches to fill its box (width comes from CSS).
 *
 * Pass `tooltip` to make it readable: a crosshair then follows the pointer and a
 * card names the sample under it (see {@link SparkTooltip}).
 */
export function Sparkline({
  data,
  stroke = '#38bdf8',
  fill,
  height = 44,
  grow = false,
  minSpan,
  tooltip,
  timeWindow,
  className,
}: {
  data: number[];
  stroke?: string;
  /** Optional area fill colour below the line (use a translucent rgba). */
  fill?: string;
  /** Coordinate-space height; also the rendered height unless `grow` is set. */
  height?: number;
  /** Fill the parent's height instead of a fixed one (parent must size it). */
  grow?: boolean;
  /** Floor on the Y-span (see {@link withMinSpan}) so a tiny swing stays small. */
  minSpan?: number;
  /** Makes the chart hoverable; omit on one too small to read a card over. */
  tooltip?: SparkTooltip;
  /** The span the samples cover, for dating the hovered one. */
  timeWindow?: TimeWindow;
  className?: string;
}): JSX.Element {
  const w = 100;
  const renderedHeight = grow ? '100%' : height;
  const pointer = useSparkPointer(tooltip != null);
  if (data.length < 2) {
    return <div className={className} style={{ height: renderedHeight }} aria-hidden />;
  }
  const { min, max } = withMinSpan(Math.min(...data), Math.max(...data), minSpan);
  const range = max - min || 1;
  // Leave 8% padding top and bottom so peaks/troughs aren't clipped.
  const pad = height * 0.08;
  const toY = (v: number): number => height - pad - ((v - min) / range) * (height - pad * 2);
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, toY(v)] as const);
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const hover = pointer.frac == null ? null : snapToSample(pointer.frac, data.length);

  return (
    <div
      className={className}
      style={{ height: renderedHeight, position: 'relative' }}
      {...(tooltip ? pointer.bind : {})}
    >
      <svg
        viewBox={`0 0 ${w} ${height}`}
        preserveAspectRatio="none"
        style={{ height: '100%', width: '100%', display: 'block' }}
        aria-hidden
      >
        {fill && <path d={`${line} L${w},${height} L0,${height} Z`} fill={fill} stroke="none" />}
        <path
          d={line}
          fill="none"
          stroke={stroke}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {tooltip && hover && (
        <>
          <SparkCrosshair frac={hover.frac} />
          <SparkHoverCard
            frac={hover.frac}
            heading={sampleTime(hover.index, data.length, timeWindow)}
            rows={[
              {
                label: tooltip.label ?? 'Value',
                value: tooltip.format(data[hover.index]!),
                color: stroke,
              },
            ]}
          />
        </>
      )}
    </div>
  );
}

export interface ForecastPoint {
  /** Epoch milliseconds. */
  t: number;
  value: number;
}

/** Clip history to points at/after `from`, interpolating a clean boundary point. */
function clipFrom(history: ForecastPoint[], from: number): ForecastPoint[] {
  const out: ForecastPoint[] = [];
  for (let i = 0; i < history.length; i++) {
    const p = history[i]!;
    if (p.t < from) continue;
    // Interpolate the exact boundary so the line starts flush at the left edge.
    if (out.length === 0 && i > 0) {
      const prev = history[i - 1]!;
      const f = (from - prev.t) / (p.t - prev.t || 1);
      out.push({ t: from, value: prev.value + (p.value - prev.value) * f });
    }
    out.push(p);
  }
  return out;
}

/**
 * A sparkline with a forecast tail on one continuous time scale, with `now`
 * pinned to the centre: the recent history fills the left half and an
 * equally-long forecast fills the right, so the predicted curve flows straight
 * out of the data with no scale break. History older than that window is clipped
 * (the full series lives in the enlarged chart). Both halves share one Y-scale,
 * and the dashed forecast reuses the solid line's colour.
 */
export function ForecastSparkline({
  history,
  forecast,
  now,
  stroke = '#38bdf8',
  fill,
  height = 44,
  grow = false,
  tooltip,
  className,
}: {
  history: ForecastPoint[];
  forecast: ForecastPoint[];
  /** Timestamp pinned to the horizontal centre (the latest real reading). */
  now: number;
  stroke?: string;
  /** Optional area fill colour below the history line (use a translucent rgba). */
  fill?: string;
  height?: number;
  grow?: boolean;
  /**
   * Makes the chart hoverable. This one plots on a real time axis, so a hovered
   * point is dated exactly rather than read back off a window, and one past the
   * centre is labelled as the prediction it is.
   */
  tooltip?: SparkTooltip;
  className?: string;
}): JSX.Element {
  const w = 100;
  const mid = w / 2;
  const renderedHeight = grow ? '100%' : height;
  const pointer = useSparkPointer(tooltip != null);
  if (history.length < 2 || forecast.length === 0) {
    return <div className={className} style={{ height: renderedHeight }} aria-hidden />;
  }

  // One continuous time axis, symmetric about `now`: the forecast sets the
  // half-window, and we show the same span of history on the left (so `now`
  // lands at the centre and the curve keeps a single, honest time scale).
  const forecastEnd = forecast[forecast.length - 1]!.t;
  const halfSpan = forecastEnd - now || 1;
  const start = now - halfSpan;
  const span = forecastEnd - start; // = 2 · halfSpan
  const x = (t: number): number => ((t - start) / span) * w;

  const visible = clipFrom(history, start);
  if (visible.length === 0) {
    return <div className={className} style={{ height: renderedHeight }} aria-hidden />;
  }

  // Continue the forecast straight from the last real reading: shift it so it
  // starts exactly there. This keeps the dashed tail flush with the solid line
  // (no step at the seam) and, since the fit is monotonic, gravity never ticks
  // back up across the join.
  const last = visible[visible.length - 1]!;
  const offset = last.value - forecast[0]!.value;
  const foreVals = forecast.filter((p) => p.t > now).map((p) => ({ t: p.t, value: p.value + offset }));

  const values = [...visible.map((p) => p.value), ...foreVals.map((p) => p.value)];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = height * 0.08;
  const toY = (v: number): number => height - pad - ((v - min) / range) * (height - pad * 2);

  const toPath = (pts: readonly (readonly [number, number])[]): string =>
    pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(2)},${py.toFixed(2)}`).join(' ');

  const histPts = visible.map((p) => [x(p.t), toY(p.value)] as const);
  const histLine = toPath(histPts);
  // Anchor the dashed tail to the last real point so the two lines meet at centre.
  const forePts = [
    [mid, toY(last.value)] as const,
    ...foreVals.map((p) => [x(p.t), toY(p.value)] as const),
  ];
  const leftEdge = histPts[0]![0];

  // Nearest plotted point to the pointer, measured along the shared time axis —
  // the history and the forecast are unevenly spaced, so there is no grid to
  // round onto as the other charts have.
  const plotted = [
    ...visible.map((point) => ({ ...point, predicted: false })),
    ...foreVals.map((point) => ({ ...point, predicted: true })),
  ];
  const hover =
    pointer.frac == null
      ? null
      : plotted.reduce((best, point) =>
          Math.abs(x(point.t) / w - pointer.frac!) < Math.abs(x(best.t) / w - pointer.frac!)
            ? point
            : best,
        );

  return (
    <div
      className={className}
      style={{ height: renderedHeight, position: 'relative' }}
      {...(tooltip ? pointer.bind : {})}
    >
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      style={{ height: '100%', width: '100%', display: 'block' }}
      aria-hidden
    >
      {fill && (
        <path
          d={`${histLine} L${mid},${height} L${leftEdge.toFixed(2)},${height} Z`}
          fill={fill}
          stroke="none"
        />
      )}
      {/* Faint 'now' divider between history and forecast. */}
      <line
        x1={mid}
        x2={mid}
        y1={0}
        y2={height}
        stroke={stroke}
        strokeWidth={0.6}
        strokeDasharray="1 2"
        opacity={0.35}
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={histLine}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={toPath(forePts)}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeDasharray="4 3"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.9}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
      {tooltip && hover && (
        <>
          <SparkCrosshair frac={x(hover.t) / w} />
          <SparkHoverCard
            frac={x(hover.t) / w}
            heading={
              hover.predicted
                ? `${hoverTime(hover.t, span)} · forecast`
                : hoverTime(hover.t, span)
            }
            rows={[
              {
                label: tooltip.label ?? 'Value',
                value: tooltip.format(hover.value),
                color: stroke,
                dash: hover.predicted ? 'dashed' : undefined,
              },
            ]}
          />
        </>
      )}
    </div>
  );
}

/**
 * A mini bar chart that stretches to fill its box — used for power draw.
 *
 * Pass `tooltip` to make it readable: the bar under the pointer lifts out of the
 * row and a card names it. No crosshair — a bar is already a mark of its own,
 * and a rule down the middle of one only obscures it.
 */
export function BarSpark({
  data,
  fill = '#84cc16',
  height = 44,
  tooltip,
  timeWindow,
  className,
}: {
  data: number[];
  fill?: string;
  height?: number;
  /** Makes the chart hoverable; omit on one too small to read a card over. */
  tooltip?: SparkTooltip;
  /** The span the bars cover, for dating the hovered one. */
  timeWindow?: TimeWindow;
  className?: string;
}): JSX.Element {
  const pointer = useSparkPointer(tooltip != null);
  if (data.length === 0) {
    return <div className={className} style={{ height }} aria-hidden />;
  }
  const max = Math.max(...data, 1);
  const n = data.length;
  const hover = pointer.frac == null ? null : snapToBar(pointer.frac, n);
  const at = hover?.index ?? null;
  return (
    <div className={className} style={{ height, position: 'relative' }} {...(tooltip ? pointer.bind : {})}>
      <svg
        viewBox={`0 0 ${n} ${height}`}
        preserveAspectRatio="none"
        style={{ height: '100%', width: '100%', display: 'block' }}
        aria-hidden
      >
        {data.map((v, i) => {
          const bh = Math.max((v / max) * height, 0.5);
          return (
            <rect
              key={i}
              x={i + 0.12}
              y={height - bh}
              width={0.76}
              height={bh}
              fill={fill}
              opacity={at == null || at === i ? 1 : 0.45}
              rx={0.15}
            />
          );
        })}
      </svg>
      {tooltip && hover && (
        <SparkHoverCard
          frac={hover.frac}
          heading={sampleTime(hover.index, n, timeWindow)}
          rows={[
            { label: tooltip.label ?? 'Value', value: tooltip.format(data[hover.index]!), color: fill },
          ]}
        />
      )}
    </div>
  );
}

/** Stroke patterns a mini chart's lines can be told apart by. */
const SPARK_DASH = { dashed: '4 3', dotted: '1 2.5' } as const;

export interface SparkSeries {
  data: number[];
  stroke: string;
  /**
   * Set a line apart from the solid one — the fridge is `dashed` against the
   * solid beer trace, the target `dotted` against both.
   */
  dash?: keyof typeof SPARK_DASH;
  /** Names this line in the hover card. */
  label?: string;
}

/**
 * A moment on a mini chart worth calling out: today, where the brewer moved a
 * fermenter's target temperature.
 *
 * Nothing is drawn for one. The change is already visible as the step in the
 * target line, and a vertical rule beside that step would only be saying the
 * same thing again; a marker adds a line to the hover card of the sample it
 * falls in, so pointing at the step tells you what it was.
 */
export interface SparkMarker {
  /** Epoch milliseconds. */
  t: number;
  /** The note added to that sample's card, e.g. "Target changed 18.0° → 20.0°". */
  label: string;
}

/**
 * A mini multi-series line chart sharing one Y-scale. Like {@link Sparkline} but
 * for comparing a couple of series at a glance; no area fill.
 *
 * Pass `tooltip` to make it readable: hovering names every line at the sample
 * under the pointer, and adds a note where a {@link SparkMarker} falls in that
 * sample. Markers need `timeWindow` to place them.
 */
export function MultiLineSparkline({
  series,
  markers,
  markerColor = '#f59e0b',
  timeWindow,
  tooltip,
  height = 44,
  grow = false,
  minSpan,
  className,
}: {
  series: SparkSeries[];
  /** Events to note on the card of whichever sample they fall in. */
  markers?: SparkMarker[];
  /** Accent for a marker's note. */
  markerColor?: string;
  /** The time span the plot covers, for dating a hovered sample and its markers. */
  timeWindow?: TimeWindow;
  /** Makes the chart hoverable; omit on one too small to read a card over. */
  tooltip?: SparkTooltip;
  height?: number;
  grow?: boolean;
  /** Floor on the Y-span (see {@link withMinSpan}) so a tiny swing stays small. */
  minSpan?: number;
  className?: string;
}): JSX.Element {
  const w = 100;
  const renderedHeight = grow ? '100%' : height;
  const allValues = series.flatMap((s) => s.data);
  const drawable = series.filter((s) => s.data.length >= 2);
  // Every line is drawn across the same width, so the longest sets the grid a
  // hover snaps to; a shorter one is read at the same fraction along itself.
  const points = Math.max(0, ...drawable.map((sp) => sp.data.length));
  const pointer = useSparkPointer(tooltip != null);
  if (allValues.length === 0 || drawable.length === 0) {
    return <div className={className} style={{ height: renderedHeight }} aria-hidden />;
  }
  const { min, max } = withMinSpan(Math.min(...allValues), Math.max(...allValues), minSpan);
  const range = max - min || 1;
  const pad = height * 0.1;
  const toY = (v: number): number => height - pad - ((v - min) / range) * (height - pad * 2);
  const pathFor = (data: number[]): string =>
    data
      .map(
        (v, i) =>
          `${i === 0 ? 'M' : 'L'}${((i / (data.length - 1)) * w).toFixed(2)},${toY(v).toFixed(2)}`,
      )
      .join(' ');

  const hover = pointer.frac == null ? null : snapToSample(pointer.frac, points);
  const note =
    hover == null || !timeWindow
      ? undefined
      : (markers ?? []).find((m) => {
          const mf = markerFraction(m.t, timeWindow);
          return mf != null && coversSample(mf, hover.frac, points);
        })?.label;

  return (
    <div
      className={className}
      style={{ height: renderedHeight, position: 'relative' }}
      {...(tooltip ? pointer.bind : {})}
    >
      <svg
        viewBox={`0 0 ${w} ${height}`}
        preserveAspectRatio="none"
        style={{ height: '100%', width: '100%', display: 'block' }}
        aria-hidden
      >
        {drawable.map((s, i) => (
          <path
            key={i}
            d={pathFor(s.data)}
            fill="none"
            stroke={s.stroke}
            strokeWidth={1.5}
            strokeDasharray={s.dash ? SPARK_DASH[s.dash] : undefined}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {tooltip && hover && (
        <>
          <SparkCrosshair frac={hover.frac} />
          <SparkHoverCard
            frac={hover.frac}
            heading={sampleTime(hover.index, points, timeWindow)}
            rows={drawable.map((sp, i) => ({
              label: sp.label ?? `Series ${i + 1}`,
              // A shorter series is read at the same fraction along its own
              // points, since it too was stretched across the full width.
              value: tooltip.format(sp.data[snapToSample(hover.frac, sp.data.length).index]!),
              color: sp.stroke,
              dash: sp.dash,
            }))}
            note={note}
            noteColor={markerColor}
          />
        </>
      )}
    </div>
  );
}

export interface DonutSegment {
  value: number;
  color: string;
  /**
   * Pull this slice radially outward by this many px (an "exploded" slice) to
   * set it apart — e.g. the empty-keg slice, so grey reads as "unfilled" rather
   * than as a beer that happens to be grey.
   */
  explode?: number;
}

/** Point on a circle, with 0° at the top and angles increasing clockwise. */
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** Path for one annular sector (a donut slice) between two radii and angles. */
function sectorPath(
  cx: number,
  cy: number,
  rInner: number,
  rOuter: number,
  startDeg: number,
  endDeg: number,
): string {
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  const [x1o, y1o] = polar(cx, cy, rOuter, startDeg);
  const [x2o, y2o] = polar(cx, cy, rOuter, endDeg);
  const [x2i, y2i] = polar(cx, cy, rInner, endDeg);
  const [x1i, y1i] = polar(cx, cy, rInner, startDeg);
  return [
    `M ${x1o} ${y1o}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x2o} ${y2o}`,
    `L ${x2i} ${y2i}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${x1i} ${y1i}`,
    'Z',
  ].join(' ');
}

/**
 * A segmented ring. Renders the ring only; the caller overlays any centre
 * label inside a relatively-positioned wrapper. A small `gap` separates the
 * slices, and a segment's `explode` pulls it outward to call it out.
 */
export function Donut({
  segments,
  size = 140,
  thickness = 20,
  gap = 0,
  trackColor = '#27272a',
}: {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  /** Angular gap between slices, in degrees. */
  gap?: number;
  /** Shown when there are no segments (e.g. nothing loaded yet). */
  trackColor?: string;
}): JSX.Element {
  const c = size / 2;
  const maxExplode = Math.max(0, ...segments.map((s) => s.explode ?? 0));
  // Leave room so an exploded slice still fits inside the viewBox.
  const rOuter = (size - thickness) / 2 + thickness / 2 - maxExplode;
  const rInner = rOuter - thickness;
  const rTrack = (rInner + rOuter) / 2;
  const total = segments.reduce((s, x) => s + x.value, 0);

  let cursor = 0;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} style={{ width: size, height: size }} aria-hidden>
      <circle cx={c} cy={c} r={rTrack} fill="none" stroke={trackColor} strokeWidth={thickness} />
      {total > 0 &&
        segments.map((seg, i) => {
          const start = (cursor / total) * 360;
          cursor += seg.value;
          const end = (cursor / total) * 360;
          // Inset each side by half the gap, but never past a hairline so tiny
          // slices (and a lone full-circle slice) still render.
          const half = Math.min(gap / 2, (end - start) / 2 - 0.001);
          const startDeg = start + half;
          const endDeg = Math.min(end - half, start + 359.999);
          const mid = (start + end) / 2;
          const [ux, uy] = polar(0, 0, 1, mid);
          const off = seg.explode ?? 0;
          return (
            <path
              key={i}
              d={sectorPath(c, c, rInner, rOuter, startDeg, endDeg)}
              fill={seg.color}
              transform={off ? `translate(${ux * off} ${uy * off})` : undefined}
            />
          );
        })}
    </svg>
  );
}
