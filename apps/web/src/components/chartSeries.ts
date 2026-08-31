import { isStateMetric, metricUnit } from '../pages/Dashboard';
import type { TimePoint } from '../useDeviceData';
import type { Span } from './chartZoom';

/**
 * Putting several of a device's metrics on one chart: which axis each belongs
 * to, which column it is drawn from, and how the separately-thinned series are
 * interleaved into the single row array recharts draws.
 *
 * Split out of MetricChart so the arithmetic can be tested without mounting a
 * chart — the same bargain as decimate.ts and timeAxis.ts.
 */

/**
 * Which value axis a metric belongs on. Metrics measured in the same unit share
 * one — a fridge temperature and the setpoint it is held to are both °C and are
 * only comparable drawn against the same scale. Anything else needs its own:
 * overlay the HVAC mode (-1/0/+1) on a °C axis and it flattens into a line along
 * the bottom, which is the whole reason the second axis exists.
 *
 * A metric with no unit at all (gravity, the state) keys on its own name rather
 * than on a shared `null`, so two unrelated unitless metrics don't collide.
 */
export function axisOf(metric: string): string {
  if (isStateMetric(metric)) return 'state';
  return metricUnit(metric) ?? metric;
}

/** The chart column a metric's readings are plotted from. */
export function valueKey(metric: string): string {
  return `v_${metric}`;
}

/** A merged chart row: `t` plus one column per series with a point at it. */
export type SeriesRow = Record<string, number>;

/**
 * Interleave several thinned series into the single row array recharts draws
 * from, keyed by {@link valueKey}.
 *
 * Each series is thinned by whatever rule suits it (see `thinForPlot`), so their
 * points no longer land on shared timestamps even though the agent logged them
 * together. Every row therefore carries only the columns that have a reading at
 * that moment, and the lines are drawn with `connectNulls` so each still runs
 * unbroken through the gaps the others left.
 *
 * The single-series case — every chart until one is overlaid — is kept off the
 * map entirely: it is the same rows either way, and it is the one drawn most.
 */
export function mergeSeries(parts: { key: string; points: TimePoint[] }[]): SeriesRow[] {
  if (parts.length === 0) return [];
  if (parts.length === 1) {
    const { key, points } = parts[0]!;
    return points.map((p) => ({ t: p.t, [key]: p.value }));
  }
  const rows = new Map<number, SeriesRow>();
  for (const { key, points } of parts) {
    for (const p of points) {
      const row = rows.get(p.t);
      if (row) row[key] = p.value;
      else rows.set(p.t, { t: p.t, [key]: p.value });
    }
  }
  return [...rows.values()].sort((a, b) => a.t! - b.t!);
}

/** Min and max across every series handed in, or null when they're all empty. */
export function extentOf(all: TimePoint[][]): Span | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const points of all) {
    for (const p of points) {
      if (p.value < min) min = p.value;
      if (p.value > max) max = p.value;
    }
  }
  return min <= max ? { min, max } : null;
}
