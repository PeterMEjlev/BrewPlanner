/**
 * The target temperature drawn through time, and the labelling for the moments
 * it moved (see `SetpointChange` in @checklist/shared for where those come
 * from).
 *
 * A target used to be one flat reference line at whatever the controller is
 * holding *now*, with a vertical mark at each change beside it. That said the
 * same thing twice and neither half well: the flat line was a lie about every
 * minute before the last change, and the vertical marks were an annotation
 * standing in for the shape the line should have had. A stepped line says both
 * at once — where the target was, and when it moved.
 *
 * Two very different charts draw it: the Overview's hand-rolled mini charts
 * (see `markers` on MultiLineSparkline in charts.tsx) and the enlarged recharts
 * one (setpointMarkers.tsx). The maths and the wording live here so the two
 * agree, and so the Overview can build its line without pulling recharts into
 * its bundle.
 */

/** One step in the target: when it moved, and between which two values. */
export interface SetpointStep {
  /** Epoch milliseconds. */
  t: number;
  from: number;
  to: number;
}

/**
 * The changes worth mounting a hover marker for, given the window on screen and
 * how wide the plot is.
 *
 * A window's worth of changes is bounded by the query (200), not by the width it
 * has to fit into, and a long range reaches that bound easily: a fermentation
 * programme steps its target all the way down, so a 30-day view can carry a
 * marker every few pixels. Two markers closer together than one hit area can't
 * be hovered separately — the front one takes every pointer — so drawing both
 * costs a component and buys nothing. Thinning to one per `minGapPx` therefore
 * loses no marker the brewer could have reached, and bounds the count by the
 * width of the chart instead of by the length of the range.
 *
 * Buckets are counted from the epoch rather than from the window's edge, so
 * which member of a cluster survives doesn't change as the chart is panned —
 * a marker that flickered in and out under the cursor would be worse than one
 * that was never there.
 */
export function visibleSetpointChanges<T extends { t: number }>(
  changes: readonly T[],
  view: { min: number; max: number } | null,
  plotWidth: number | null,
  minGapPx: number,
): T[] {
  const span = view ? view.max - view.min : 0;
  // Unmeasured or degenerate: keep the lot and let the chart clip them.
  const minGap =
    view && span > 0 && plotWidth != null && plotWidth > 0 ? (minGapPx / plotWidth) * span : 0;
  const out: T[] = [];
  let lastBucket: number | null = null;
  for (const change of changes) {
    if (view && (change.t < view.min || change.t > view.max)) continue;
    if (minGap > 0) {
      const bucket = Math.floor(change.t / minGap);
      if (bucket === lastBucket) continue;
      lastBucket = bucket;
    }
    out.push(change);
  }
  return out;
}

/**
 * The target in force at each of `times` — a step function, sampled onto
 * whatever grid the chart plots on. `times` must be ascending.
 *
 * Before the first change the target is that change's `from`: the controller
 * was already holding something when the window opened, and the change itself
 * is what says what. After the last change it stays at its `to` rather than
 * jumping to `current` — a difference between the two means a change too recent
 * to have been logged yet, and inventing a step at an unknown moment would be
 * worse than being a poll behind.
 *
 * `current` is only the answer when there are no changes at all: a target that
 * held steady across the whole window, which is the common case and the one the
 * old flat reference line drew. Returns an empty series when there is no target
 * to draw, so a caller can leave the line out entirely.
 */
export function setpointTargetSeries(
  changes: readonly SetpointStep[],
  times: readonly number[],
  current: number | null,
): number[] {
  if (times.length === 0) return [];
  if (changes.length === 0) return current == null ? [] : times.map(() => current);
  const steps = [...changes].sort((a, b) => a.t - b.t);
  let next = 0;
  let value = steps[0]!.from;
  return times.map((t) => {
    while (next < steps.length && steps[next]!.t <= t) {
      value = steps[next]!.to;
      next += 1;
    }
    return value;
  });
}

/** The values a target line will span, for sizing an axis that has to hold it. */
export function setpointTargetSpan(
  changes: readonly SetpointStep[],
  current: number | null,
): { min: number; max: number } | null {
  const values = changes.flatMap((c) => [c.from, c.to]);
  if (current != null) values.push(current);
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

/** "18.0° → 20.0°" — what a marker stands for, in as few characters as fit. */
export function setpointChangeLabel(change: { from: number; to: number }): string {
  return `${change.from.toFixed(1)}° → ${change.to.toFixed(1)}°`;
}

/**
 * Horizontal placement of a marker across a plot, as a fraction of its width.
 *
 * Markers are positioned by time while a preview's series are drawn by index —
 * the two agree because its points are equal-width buckets across the same
 * window (see SERIES_BUCKETS in useDeviceData), and where a gap in the readings
 * leaves a bucket empty it is the line's own index spacing that is the
 * approximation, not this. Returns null for a marker outside the window.
 */
export function markerFraction(
  t: number,
  window: { start: number; end: number },
): number | null {
  const span = window.end - window.start;
  if (!(span > 0)) return null;
  const frac = (t - window.start) / span;
  return frac < 0 || frac > 1 ? null : frac;
}

/**
 * How a mini chart's hover card sits against its marker: centred out in the
 * middle of the plot, but pinned to one side near an edge so it can't spill out
 * of the card it lives in.
 */
export function cardShift(frac: number): string {
  if (frac < 0.3) return 'translateX(0)';
  if (frac > 0.7) return 'translateX(-100%)';
  return 'translateX(-50%)';
}

/** Font size of the recharts badge's text, and the line spacing that goes with it. */
export const BADGE_FONT = 11;
export const BADGE_LINE = 14;
const BADGE_PAD_X = 7;
const BADGE_PAD_Y = 5;
/** Gap between the marker line and the badge beside it. */
const BADGE_GAP = 6;

/**
 * Rough width of a run of text at {@link BADGE_FONT}. The badge is SVG, so
 * there's no layout pass to measure against and its background rect has to be
 * sized before the text renders; 0.56em per character is a little generous for
 * the digits and arrows these labels are made of, which is the right way to be
 * wrong — a slightly wide badge looks deliberate, a narrow one clips.
 */
function textWidth(s: string): number {
  return s.length * BADGE_FONT * 0.56;
}

/** Where a marker's hover badge and each of its text lines go, in plot pixels. */
export interface BadgeBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Left edge of the text, inside the padding. */
  textX: number;
  /** Baselines, top line first. */
  lineY: number[];
}

/**
 * Lay out the badge for a marker at `markerX`, sized to its longest line.
 *
 * It sits to the right of the line by default and flips to the left when that
 * would push it out of the plot — a badge that silently runs off the edge is
 * exactly the kind of thing that only shows up on the one change that happened
 * late in the window. `plot` may be null before recharts has measured itself,
 * in which case there is nothing to stay inside of yet.
 */
export function badgeBox(
  markerX: number,
  markerY: number,
  lines: string[],
  plot: { x: number; width: number } | null,
): BadgeBox {
  const width = Math.max(...lines.map(textWidth)) + BADGE_PAD_X * 2;
  const height = BADGE_LINE * lines.length + BADGE_PAD_Y * 2;
  const right = markerX + BADGE_GAP;
  const fits = !plot || right + width <= plot.x + plot.width;
  // Flipped — but never past the plot's left edge, for a chart too narrow to
  // seat the badge on either side of a marker near its middle.
  const x = fits ? right : Math.max(plot.x, markerX - BADGE_GAP - width);
  const y = markerY + 2;
  return {
    x,
    y,
    width,
    height,
    textX: x + BADGE_PAD_X,
    lineY: lines.map((_, i) => y + BADGE_PAD_Y + BADGE_FONT + i * BADGE_LINE),
  };
}
