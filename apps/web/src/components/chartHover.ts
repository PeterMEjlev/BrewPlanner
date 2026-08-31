/**
 * Reading a value off a mini chart.
 *
 * The Overview's charts are a few hundred pixels of trend with no axis to
 * measure against, which is fine for "is it going up" and useless for "what was
 * it at four this morning". Enlarging one to answer that is a lot of ceremony
 * for a number, so every chart that plots real samples can be pointed at
 * instead: a crosshair snaps to the nearest sample and a card names it.
 *
 * The maths lives here rather than beside the components (charts.tsx) because
 * it is the part that can be quietly wrong — a crosshair one sample off still
 * looks right and quotes the wrong number — and because the components it
 * serves disagree about what a sample is: a line's points sit *on* the grid
 * while a bar spans a slice of it.
 */

/** The window a chart's samples are spread across, for dating a hovered one. */
export interface TimeWindow {
  start: number;
  end: number;
}

/**
 * The sample of a line chart under a pointer at `frac` (0 to 1 across the plot),
 * and where that sample sits, so the crosshair lands on the point whose value
 * the card is quoting rather than between two of them.
 *
 * Line charts space `points` samples end to end — the first at 0, the last at 1
 * — so the gap between them is one `points - 1`th of the width.
 */
export function snapToSample(frac: number, points: number): { index: number; frac: number } {
  if (points < 2) return { index: 0, frac: 0 };
  const clamped = Math.min(1, Math.max(0, frac));
  const index = Math.round(clamped * (points - 1));
  return { index, frac: index / (points - 1) };
}

/**
 * The same for a bar chart, where the pointer falls *inside* a bar rather than
 * near a point: bar `i` of `n` owns the width from `i / n` to `(i + 1) / n`, and
 * the card is anchored over its centre.
 */
export function snapToBar(frac: number, bars: number): { index: number; frac: number } {
  if (bars < 1) return { index: 0, frac: 0 };
  const clamped = Math.min(1, Math.max(0, frac));
  const index = Math.min(bars - 1, Math.floor(clamped * bars));
  return { index, frac: (index + 0.5) / bars };
}

/**
 * When sample `index` of `points` was recorded, given the window they cover.
 *
 * An interpolation, not a record: these charts plot by index rather than on a
 * time axis, so a gap in the readings shifts every sample after it. That is the
 * same approximation the lines themselves are drawn with, and at preview
 * resolution it is smaller than the bucket each point already averages over.
 * Null when there is no window to place them in.
 */
export function sampleTimeAt(
  index: number,
  points: number,
  window: TimeWindow | undefined,
): number | null {
  if (!window || points < 2) return null;
  return window.start + (index / (points - 1)) * (window.end - window.start);
}

/**
 * Whether a moment falls in the sample at `frac` — within half a sample either
 * side, so every moment in the window belongs to exactly one of them.
 *
 * This is what decides when a hover card mentions a target change: it belongs
 * to the one sample whose crosshair covers the moment it happened.
 */
export function coversSample(markerFrac: number, hoverFrac: number, points: number): boolean {
  const reach = points > 1 ? 0.5 / (points - 1) : 0;
  return Math.abs(markerFrac - hoverFrac) <= reach;
}
