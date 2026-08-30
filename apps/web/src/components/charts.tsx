/**
 * Hand-rolled SVG visualizations for the desktop Overview, plus the value-axis
 * maths the recharts charts share with them. Kept dependency-free (no recharts)
 * so the Overview bundle stays small — recharts is loaded only on the
 * detail/chart pages. Each component is pure and presentational, driven by plain
 * numbers, so it renders the same against mock and live telemetry.
 */

import { useState } from 'react';
import type { Span } from './chartZoom';
import { cardShift, markerFraction } from './eventMarkers';

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

/** A thin line sparkline that stretches to fill its box (width comes from CSS). */
export function Sparkline({
  data,
  stroke = '#38bdf8',
  fill,
  height = 44,
  grow = false,
  minSpan,
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
  className?: string;
}): JSX.Element {
  const w = 100;
  const renderedHeight = grow ? '100%' : height;
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

  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      className={className}
      style={{ height: renderedHeight, width: '100%', display: 'block' }}
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
  className?: string;
}): JSX.Element {
  const w = 100;
  const mid = w / 2;
  const renderedHeight = grow ? '100%' : height;
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

  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      className={className}
      style={{ height: renderedHeight, width: '100%', display: 'block' }}
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
  );
}

/** A mini bar chart that stretches to fill its box — used for power draw. */
export function BarSpark({
  data,
  fill = '#84cc16',
  height = 44,
  className,
}: {
  data: number[];
  fill?: string;
  height?: number;
  className?: string;
}): JSX.Element {
  if (data.length === 0) {
    return <div className={className} style={{ height }} aria-hidden />;
  }
  const max = Math.max(...data, 1);
  const n = data.length;
  return (
    <svg
      viewBox={`0 0 ${n} ${height}`}
      preserveAspectRatio="none"
      className={className}
      style={{ height, width: '100%', display: 'block' }}
      aria-hidden
    >
      {data.map((v, i) => {
        const bh = Math.max((v / max) * height, 0.5);
        return (
          <rect key={i} x={i + 0.12} y={height - bh} width={0.76} height={bh} fill={fill} rx={0.15} />
        );
      })}
    </svg>
  );
}

export interface SparkSeries {
  data: number[];
  stroke: string;
  /** Render as a dashed line (e.g. the fridge against the solid beer line). */
  dashed?: boolean;
}

/**
 * A moment worth marking with a vertical line across a mini chart — today, the
 * brewer changing a fermenter's target temperature.
 */
export interface SparkMarker {
  /** Epoch milliseconds. */
  t: number;
  /** Headline on hover, e.g. "18.0 -> 20.0". */
  label: string;
  /** Second, quieter line on hover — normally when it happened. */
  detail?: string;
}

/**
 * A mini multi-series line chart sharing one Y-scale, plus an optional dotted
 * horizontal reference line (e.g. the setpoint) and optional vertical event
 * markers (e.g. where that setpoint was changed). Like {@link Sparkline} but for
 * comparing a couple of series at a glance; no area fill.
 *
 * Markers need `timeWindow` to place them, and hovering one shows a small card
 * naming the event. That card is HTML rather than SVG because the plot is drawn
 * with `preserveAspectRatio="none"` — text inside it would be stretched by
 * whatever aspect the parent happens to give the chart.
 */
export function MultiLineSparkline({
  series,
  refLine,
  markers,
  markerStroke = '#f59e0b',
  timeWindow,
  height = 44,
  grow = false,
  minSpan,
  className,
}: {
  series: SparkSeries[];
  /** A constant horizontal line, e.g. the target temperature. */
  refLine?: { value: number; stroke: string };
  /** Vertical event lines; ignored without a `timeWindow` to place them in. */
  markers?: SparkMarker[];
  markerStroke?: string;
  /** The time span the plot covers, needed to position {@link markers}. */
  timeWindow?: { start: number; end: number };
  height?: number;
  grow?: boolean;
  /** Floor on the Y-span (see {@link withMinSpan}) so a tiny swing stays small. */
  minSpan?: number;
  className?: string;
}): JSX.Element {
  // Keyed by the marker's timestamp rather than its index: a poll that adds an
  // older change would shift every index under a pointer that hasn't moved.
  const [hovered, setHovered] = useState<number | null>(null);
  const w = 100;
  const renderedHeight = grow ? '100%' : height;
  const allValues = series.flatMap((s) => s.data);
  if (refLine) allValues.push(refLine.value);
  const drawable = series.filter((s) => s.data.length >= 2);
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

  const placed = timeWindow
    ? (markers ?? []).flatMap((m) => {
        const frac = markerFraction(m.t, timeWindow);
        return frac == null ? [] : [{ marker: m, frac }];
      })
    : [];
  const open = placed.find((p) => p.marker.t === hovered);

  return (
    <div className={className} style={{ height: renderedHeight, position: 'relative' }}>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        preserveAspectRatio="none"
        style={{ height: '100%', width: '100%', display: 'block' }}
        aria-hidden
      >
        {refLine && (
          <line
            x1={0}
            x2={w}
            y1={toY(refLine.value)}
            y2={toY(refLine.value)}
            stroke={refLine.stroke}
            strokeWidth={1.2}
            strokeDasharray="1 2.5"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {drawable.map((s, i) => (
          <path
            key={i}
            d={pathFor(s.data)}
            fill="none"
            stroke={s.stroke}
            strokeWidth={1.5}
            strokeDasharray={s.dashed ? '4 3' : undefined}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {/* Over the traces, so a marker stays visible where a line crosses it
            and wins the pointer at that crossing. */}
        {placed.map(({ marker, frac }) => (
          <g key={marker.t}>
            <line
              x1={frac * w}
              x2={frac * w}
              y1={0}
              y2={height}
              stroke={markerStroke}
              strokeWidth={hovered === marker.t ? 2 : 1.2}
              strokeOpacity={hovered === marker.t ? 1 : 0.75}
              strokeDasharray="2 2"
              vectorEffect="non-scaling-stroke"
            />
            {/* Hit area: the line itself is a hair wide, and on a phone this is
                the whole target. */}
            <rect
              x={frac * w - 2}
              y={0}
              width={4}
              height={height}
              fill="transparent"
              pointerEvents="all"
              onPointerEnter={() => setHovered(marker.t)}
              onPointerLeave={() => setHovered((cur) => (cur === marker.t ? null : cur))}
            />
          </g>
        ))}
      </svg>
      {open && (
        <div
          className="pointer-events-none absolute z-10 whitespace-nowrap rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] leading-tight shadow-lg shadow-black/40"
          style={{ left: `${open.frac * 100}%`, top: 2, transform: cardShift(open.frac) }}
        >
          <span className="font-semibold" style={{ color: markerStroke }}>
            {open.marker.label}
          </span>
          {open.marker.detail && <span className="block text-zinc-400">{open.marker.detail}</span>}
        </div>
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

/**
 * A single-value progress ring (online / total). Like {@link Donut} but with one
 * rounded arc over a full track. Centre label is overlaid by the caller.
 */
export function RingGauge({
  value,
  max,
  size = 128,
  thickness = 11,
  color = '#22c55e',
  trackColor = '#27272a',
}: {
  value: number;
  max: number;
  size?: number;
  thickness?: number;
  color?: string;
  trackColor?: string;
}): JSX.Element {
  const r = (size - thickness) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  const frac = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const len = frac * circ;

  return (
    <svg viewBox={`0 0 ${size} ${size}`} style={{ width: size, height: size }} aria-hidden>
      <circle cx={c} cy={c} r={r} fill="none" stroke={trackColor} strokeWidth={thickness} />
      {frac > 0 && (
        <circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={`${len} ${circ - len}`}
          strokeDashoffset={0}
          transform={`rotate(-90 ${c} ${c})`}
        />
      )}
    </svg>
  );
}
