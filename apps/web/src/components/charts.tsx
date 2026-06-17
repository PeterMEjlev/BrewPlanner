/**
 * Hand-rolled SVG visualizations for the desktop Overview. Kept dependency-free
 * (no recharts) so the Overview bundle stays small — recharts is loaded only on
 * the detail/chart pages. Each is a pure, presentational component driven by
 * plain numbers, so it renders the same against mock and live telemetry.
 */

/** A thin line sparkline that stretches to fill its box (width comes from CSS). */
export function Sparkline({
  data,
  stroke = '#38bdf8',
  fill,
  height = 44,
  grow = false,
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
  className?: string;
}): JSX.Element {
  const w = 100;
  const renderedHeight = grow ? '100%' : height;
  if (data.length < 2) {
    return <div className={className} style={{ height: renderedHeight }} aria-hidden />;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
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
 * A mini multi-series line chart sharing one Y-scale, plus an optional dotted
 * horizontal reference line (e.g. the setpoint). Like {@link Sparkline} but for
 * comparing a couple of series at a glance; no area fill.
 */
export function MultiLineSparkline({
  series,
  refLine,
  height = 44,
  grow = false,
  className,
}: {
  series: SparkSeries[];
  /** A constant horizontal line, e.g. the target temperature. */
  refLine?: { value: number; stroke: string };
  height?: number;
  grow?: boolean;
  className?: string;
}): JSX.Element {
  const w = 100;
  const renderedHeight = grow ? '100%' : height;
  const allValues = series.flatMap((s) => s.data);
  if (refLine) allValues.push(refLine.value);
  const drawable = series.filter((s) => s.data.length >= 2);
  if (allValues.length === 0 || drawable.length === 0) {
    return <div className={className} style={{ height: renderedHeight }} aria-hidden />;
  }
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
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

  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      className={className}
      style={{ height: renderedHeight, width: '100%', display: 'block' }}
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
    </svg>
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
