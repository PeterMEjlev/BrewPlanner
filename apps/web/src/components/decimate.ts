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
 * The series to hand a chart: clipped to the visible window (pass null when the
 * axis shows everything) and thinned to at most `maxPoints`. Step series are
 * collapsed to their transitions instead, which is exact.
 */
export function thinForPlot(
  data: TimePoint[],
  window: Span | null,
  maxPoints: number,
  step: boolean,
): TimePoint[] {
  const slice = window ? sliceWindow(data, window) : data;
  if (step) return dedupeSteps(slice);
  return lttb(slice, maxPoints);
}
