import type { Span } from './chartZoom';

/**
 * Thinning for the history charts. At a 30s logging cadence a day of readings is
 * ~2,900 points and a week hits the 5,000-row fetch cap — far more than the plot
 * has pixels, and re-drawing that many curve segments on every frame is what
 * makes a drag or a zoom feel heavy. Trimming to the visible window and down to
 * roughly one point per pixel keeps the same picture for a fraction of the work.
 */

export interface TimePoint {
  /** Epoch milliseconds. */
  t: number;
  value: number;
}

/** First index whose `t` is >= `t0` (data is sorted oldest→newest). */
function lowerBound(data: TimePoint[], t0: number): number {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (data[mid]!.t < t0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The points inside `window`, plus the neighbour just outside each end so the
 * line still runs to both edges of the plot instead of stopping short.
 */
function sliceWindow(data: TimePoint[], window: Span): TimePoint[] {
  const from = Math.max(0, lowerBound(data, window.min) - 1);
  const to = Math.min(data.length, lowerBound(data, window.max) + 1);
  return from === 0 && to === data.length ? data : data.slice(from, to);
}

/**
 * Drop points that repeat the previous value. Lossless for a `stepAfter` line
 * (the value holds until the next point), and a tri-state series like the HVAC
 * mode collapses to just its transitions.
 */
function dedupeSteps(data: TimePoint[]): TimePoint[] {
  if (data.length < 3) return data;
  const out: TimePoint[] = [data[0]!];
  for (let i = 1; i < data.length - 1; i++) {
    if (data[i]!.value !== out[out.length - 1]!.value) out.push(data[i]!);
  }
  out.push(data[data.length - 1]!);
  return out;
}

/**
 * Largest-Triangle-Three-Buckets: keep `threshold` points, choosing from each
 * bucket the one that forms the largest triangle with its neighbours. Unlike
 * plain every-nth sampling it holds on to peaks and troughs, so a thinned
 * temperature trace still looks like itself. First and last points are kept, so
 * the axis extent is unchanged.
 */
function lttb(data: TimePoint[], threshold: number): TimePoint[] {
  const n = data.length;
  if (threshold >= n || threshold < 3) return data;
  const bucket = (n - 2) / (threshold - 2);
  const out: TimePoint[] = [data[0]!];
  let anchor = 0;

  for (let i = 0; i < threshold - 2; i++) {
    // Average of the *next* bucket — the far corner of the triangle.
    const nextStart = Math.floor((i + 1) * bucket) + 1;
    const nextEnd = Math.min(Math.floor((i + 2) * bucket) + 1, n - 1);
    let avgT = 0;
    let avgV = 0;
    const count = Math.max(nextEnd - nextStart, 1);
    for (let j = nextStart; j < nextEnd; j++) {
      avgT += data[j]!.t;
      avgV += data[j]!.value;
    }
    avgT /= count;
    avgV /= count;

    const start = Math.floor(i * bucket) + 1;
    const end = Math.min(Math.floor((i + 1) * bucket) + 1, n - 1);
    const a = data[anchor]!;
    let best = start;
    let bestArea = -1;
    for (let j = start; j < end; j++) {
      const p = data[j]!;
      const area = Math.abs(
        (a.t - avgT) * (p.value - a.value) - (a.t - p.t) * (avgV - a.value),
      );
      if (area > bestArea) {
        bestArea = area;
        best = j;
      }
    }
    out.push(data[best]!);
    anchor = best;
  }

  out.push(data[n - 1]!);
  return out;
}

/**
 * Average into `buckets` equal-width time buckets, one point per bucket that has
 * readings. The opposite intent to {@link lttb}: where that hunts out the
 * extremes, this averages them away.
 *
 * That's what a cycling metric needs. A fridge held by a hysteresis controller
 * genuinely swings ±0.5 °C as its compressor kicks in and out, so peak-preserving
 * thinning faithfully keeps every one of those cycles — and a few hundred of them
 * across a plot draw a hairy band that reads as a temperature out of control,
 * however small the actual swing. Averaging states the same data as the line the
 * cycles are oscillating about.
 *
 * Buckets span the data handed in, so this narrows as a zoom does: pulled in far
 * enough, each bucket holds a single reading and the raw trace is back.
 */
function meanBuckets(data: TimePoint[], buckets: number): TimePoint[] {
  const n = data.length;
  if (buckets < 1 || n <= buckets) return data;
  const start = data[0]!.t;
  const span = data[n - 1]!.t - start;
  if (!(span > 0)) return data;

  const out: TimePoint[] = [];
  let sumT = 0;
  let sumV = 0;
  let count = 0;
  let current = 0;
  const flush = (): void => {
    if (count > 0) out.push({ t: sumT / count, value: sumV / count });
    sumT = 0;
    sumV = 0;
    count = 0;
  };

  for (const p of data) {
    // The last point lands exactly on the top edge; keep it in the final bucket.
    const index = Math.min(buckets - 1, Math.floor(((p.t - start) / span) * buckets));
    if (index !== current) {
      flush();
      current = index;
    }
    sumT += p.t;
    sumV += p.value;
    count++;
  }
  flush();
  return out;
}

/** How a series should be thinned for the plot — see {@link thinForPlot}. */
export type ThinMode =
  /** Collapse to transitions. Exact for a `stepAfter` line (e.g. HVAC mode). */
  | 'step'
  /** Keep peaks and troughs (LTTB) — for series whose extremes are the story. */
  | 'peaks'
  /** Average within buckets — for a metric that cycles about a useful mean. */
  | 'smooth';

/**
 * The series to hand a chart: clipped to the visible window (pass null when the
 * axis shows everything) and thinned to at most `maxPoints`, by whichever rule
 * suits the metric.
 */
export function thinForPlot(
  data: TimePoint[],
  window: Span | null,
  maxPoints: number,
  mode: ThinMode,
): TimePoint[] {
  const slice = window ? sliceWindow(data, window) : data;
  if (mode === 'step') return dedupeSteps(slice);
  if (mode === 'smooth') return meanBuckets(slice, maxPoints);
  return lttb(slice, maxPoints);
}
