/**
 * Round clock times for a chart's time axis.
 *
 * Left to itself, recharts spaces the time axis evenly from whatever the first
 * reading happened to be, so a chart labels itself 06:43 / 08:03 / 09:23 — three
 * numbers nobody can read a time off. This picks the tick positions instead: a
 * spacing that divides a day evenly, counted from local midnight, so the labels
 * land on 08:00 / 08:20 / 08:40 and stay round at every zoom level.
 */

import type { Span } from './chartZoom';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Tick spacings to choose from. Every one either divides a day evenly or is a
 * whole number of days — that's what keeps the labels on round clock times as
 * the window narrows, and it's why the list isn't just powers of ten.
 */
const STEPS = [
  SECOND,
  2 * SECOND,
  5 * SECOND,
  10 * SECOND,
  15 * SECOND,
  30 * SECOND,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  4 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
  28 * DAY,
] as const;

/** Guard against a pathological window filling the axis with thousands of ticks. */
const MAX_TICKS = 64;

/**
 * Ticks to aim for. Deliberately a little more than a chart wants to show: the
 * axis' `minTickGap` thins them to fit the width it actually has, and since
 * every candidate spacing is round, the survivors read cleanly. Aiming low
 * instead would jump a 7-day chart from one label a day to one every two.
 */
const DEFAULT_TARGET = 8;

/** The smallest listed spacing that keeps the window down to ~`target` ticks. */
export function tickStep(span: number, target: number): number {
  const rough = span / Math.max(1, target);
  return STEPS.find((s) => s >= rough) ?? Math.ceil(rough / (28 * DAY)) * 28 * DAY;
}

function startOfDay(t: number): Date {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * First boundary at or after `t` for a sub-day step, counted from local
 * midnight. Counting from the epoch instead would put the boundaries on UTC
 * time — round only for a brewer in Greenwich — and would drift off the clock
 * again after a daylight-saving change. A step that doesn't fit a whole number
 * of times into a (possibly 23- or 25-hour) day just gets a short last slot:
 * the next midnight caps it, since midnight is round by definition.
 */
function ceilWithinDay(t: number, step: number): number {
  const day = startOfDay(t).getTime();
  const nextDay = new Date(day);
  nextDay.setDate(nextDay.getDate() + 1);
  return Math.min(day + Math.ceil((t - day) / step) * step, nextDay.getTime());
}

/** Zero-padded 24-hour clock, e.g. `08:20` — no AM/PM, no locale surprises. */
function clock(d: Date, withSeconds: boolean): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (!withSeconds) return `${hh}:${mm}`;
  return `${hh}:${mm}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function dateLabel(d: Date): string {
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export interface TimeAxis {
  /** Tick positions in epoch ms, or undefined to leave recharts to its own. */
  ticks: number[] | undefined;
  format: (t: number) => string;
}

/**
 * Ticks and labels for the time axis of a chart showing `view` — pass the zoomed
 * window when there is one, so the axis follows the zoom rather than the loaded
 * range. `target` is how many ticks to aim for; the axis' own `minTickGap` drops
 * any that would collide on a narrow screen, and since every candidate is round,
 * what's left still reads cleanly.
 *
 * A midnight tick carries its date rather than `00:00`, which is what tells a
 * window running over midnight which day the times after it belong to.
 */
export function timeAxis(view: Span | null, target = DEFAULT_TARGET): TimeAxis {
  const span = view ? view.max - view.min : 0;
  if (!view || !(span > 0)) {
    return { ticks: undefined, format: (t) => clock(new Date(t), false) };
  }

  const step = tickStep(span, target);
  const ticks: number[] = [];
  if (step >= DAY) {
    const days = Math.round(step / DAY);
    const d = startOfDay(view.min);
    if (d.getTime() < view.min) d.setDate(d.getDate() + 1);
    while (d.getTime() <= view.max && ticks.length < MAX_TICKS) {
      ticks.push(d.getTime());
      d.setDate(d.getDate() + days);
    }
  } else {
    let t = ceilWithinDay(view.min, step);
    while (t <= view.max && ticks.length < MAX_TICKS) {
      ticks.push(t);
      // Re-derived from the day rather than `t + step` so a daylight-saving
      // change can't carry an off-the-clock offset through the rest of the axis.
      t = ceilWithinDay(t + 1, step);
    }
  }

  const format = (t: number): string => {
    const d = new Date(t);
    if (step >= DAY) return dateLabel(d);
    const midnight = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
    if (midnight && step >= MINUTE) return dateLabel(d);
    return clock(d, step < MINUTE);
  };

  return { ticks: ticks.length ? ticks : undefined, format };
}
