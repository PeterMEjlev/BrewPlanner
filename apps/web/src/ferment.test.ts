import type { Reading } from '@checklist/shared';
import { describe, expect, it } from 'vitest';
import { fermentationDone } from './ferment';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WINDOW = 3 * DAY;
const THRESHOLD = 0.002;

/** Readings every `stepMs` going back `spanMs` from now, newest last. */
function series(spanMs: number, stepMs: number, value: (i: number) => number): Reading[] {
  const now = Date.now();
  const count = Math.floor(spanMs / stepMs) + 1;
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    deviceId: 1,
    metric: 'gravity_sg',
    value: value(i),
    recordedAt: new Date(now - spanMs + i * stepMs).toISOString(),
  }));
}

describe('fermentationDone', () => {
  it('reports done when gravity holds flat across the window', () => {
    expect(fermentationDone(series(WINDOW, HOUR, () => 1.012), WINDOW, THRESHOLD)).toBe(true);
  });

  it('tolerates drift within the threshold', () => {
    const drift = series(WINDOW, HOUR, (i) => 1.012 + (i % 2 ? 0.0005 : 0));
    expect(fermentationDone(drift, WINDOW, THRESHOLD)).toBe(true);
  });

  it('is not done while gravity is still falling', () => {
    const falling = series(WINDOW, HOUR, (i) => 1.05 - i * 0.0005);
    expect(fermentationDone(falling, WINDOW, THRESHOLD)).toBe(false);
  });

  it('is not done on a spread just over the threshold', () => {
    const now = Date.now();
    const edge: Reading[] = [
      { id: 1, deviceId: 1, metric: 'gravity_sg', value: 1.012, recordedAt: new Date(now - WINDOW).toISOString() },
      { id: 2, deviceId: 1, metric: 'gravity_sg', value: 1.0141, recordedAt: new Date(now).toISOString() },
    ];
    expect(fermentationDone(edge, WINDOW, THRESHOLD)).toBe(false);
  });

  it('refuses to call it off a freshly-booted sensor', () => {
    // The failure this guard exists for: an hour of perfectly flat readings from
    // a Tilt switched on this morning is not three stable days.
    const fresh = series(HOUR, 5 * 60_000, () => 1.012);
    expect(fermentationDone(fresh, WINDOW, THRESHOLD)).toBe(false);
  });

  it('accepts a window with gaps, as long as it is mostly covered', () => {
    // A sensor that drops samples shouldn't reset the verdict — 90% coverage.
    const sparse = series(WINDOW * 0.9, 6 * HOUR, () => 1.012);
    expect(fermentationDone(sparse, WINDOW, THRESHOLD)).toBe(true);
  });

  it('ignores readings older than the window', () => {
    const now = Date.now();
    const old: Reading[] = [
      // Wildly different, but outside the window — must not widen the spread.
      { id: 1, deviceId: 1, metric: 'gravity_sg', value: 1.06, recordedAt: new Date(now - 10 * DAY).toISOString() },
      ...series(WINDOW, HOUR, () => 1.012),
    ];
    expect(fermentationDone(old, WINDOW, THRESHOLD)).toBe(true);
  });

  it('says no with too little data', () => {
    expect(fermentationDone([], WINDOW, THRESHOLD)).toBe(false);
    expect(fermentationDone(series(0, HOUR, () => 1.012), WINDOW, THRESHOLD)).toBe(false);
  });
});
