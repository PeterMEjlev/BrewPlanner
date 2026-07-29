import { describe, expect, it } from 'vitest';
import { tickStep, timeAxis } from './timeAxis';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A window of `span` ms ending at a deliberately un-round local time. */
function windowOf(span: number, end = new Date(2026, 6, 29, 9, 33, 18, 412).getTime()) {
  return { min: end - span, max: end };
}

/** Milliseconds since the local midnight `t` falls in. */
function sinceMidnight(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return t - d.getTime();
}

describe('tickStep', () => {
  it('picks a spacing that divides the day', () => {
    expect(tickStep(HOUR, 8)).toBe(10 * MINUTE);
    expect(tickStep(6 * HOUR, 8)).toBe(HOUR);
    expect(tickStep(24 * HOUR, 8)).toBe(3 * HOUR);
    expect(tickStep(7 * DAY, 8)).toBe(DAY);
  });
});

describe('timeAxis', () => {
  it('puts every tick on a round time from local midnight', () => {
    for (const span of [5 * MINUTE, HOUR, 6 * HOUR, DAY, 3 * DAY]) {
      const { ticks } = timeAxis(windowOf(span));
      expect(ticks?.length).toBeGreaterThan(1);
      const step = tickStep(span, 8);
      for (const t of ticks!) {
        expect(sinceMidnight(t) % Math.min(step, DAY)).toBe(0);
      }
    }
  });

  it('keeps the ticks inside the window and in order', () => {
    const view = windowOf(6 * HOUR);
    const { ticks } = timeAxis(view);
    expect(ticks![0]).toBeGreaterThanOrEqual(view.min);
    expect(ticks![ticks!.length - 1]).toBeLessThanOrEqual(view.max);
    for (let i = 1; i < ticks!.length; i++) expect(ticks![i]!).toBeGreaterThan(ticks![i - 1]!);
  });

  it('labels with a 24-hour clock', () => {
    const { format } = timeAxis(windowOf(6 * HOUR));
    expect(format(new Date(2026, 6, 29, 8, 0).getTime())).toBe('08:00');
    expect(format(new Date(2026, 6, 29, 20, 20).getTime())).toBe('20:20');
  });

  it('adds seconds only once zoomed in past a minute per tick', () => {
    const zoomed = timeAxis(windowOf(2 * MINUTE));
    expect(zoomed.format(new Date(2026, 6, 29, 8, 0, 30).getTime())).toBe('08:00:30');
    const wide = timeAxis(windowOf(6 * HOUR));
    expect(wide.format(new Date(2026, 6, 29, 8, 0, 30).getTime())).toBe('08:00');
  });

  it('marks midnight with the date so a window over midnight stays readable', () => {
    const { ticks, format } = timeAxis(windowOf(DAY));
    const midnight = ticks!.find((t) => sinceMidnight(t) === 0);
    expect(midnight).toBeDefined();
    expect(format(midnight!)).not.toMatch(/^\d\d:/);
  });

  it("leaves the ticks to recharts when there is no window", () => {
    expect(timeAxis(null).ticks).toBeUndefined();
    expect(timeAxis({ min: 5, max: 5 }).ticks).toBeUndefined();
  });
});
