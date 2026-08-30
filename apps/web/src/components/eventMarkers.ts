/**
 * Labelling and geometry for the vertical event markers on the temperature
 * charts — today, the moments the brewer moved a fermenter's target (see
 * `SetpointChange` in @checklist/shared for where the events come from).
 *
 * Two very different charts draw them: the Overview's hand-rolled mini charts
 * (see `markers` on MultiLineSparkline in charts.tsx) and the enlarged recharts
 * one (setpointMarkers.tsx). The maths and the wording live here so the two
 * agree, and so the Overview can label a marker without pulling recharts into
 * its bundle.
 */

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
