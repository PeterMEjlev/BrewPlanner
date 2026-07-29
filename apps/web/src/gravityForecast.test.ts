import { describe, expect, it } from 'vitest';
import {
  type GravityPoint,
  estimateDoneTime,
  fitGravityDecay,
  forecastSeries,
  predictGravity,
} from './gravityForecast';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 6, 1);

/** Samples of the true model SG(τ) = fg + a·e^(−kτ), every `stepH` hours. */
function decay(
  { fg, a, k }: { fg: number; a: number; k: number },
  days: number,
  stepH = 2,
  noise: (i: number) => number = () => 0,
): GravityPoint[] {
  const count = Math.floor((days * 24) / stepH) + 1;
  return Array.from({ length: count }, (_, i) => {
    const t = T0 + i * stepH * 60 * 60 * 1000;
    const tau = (t - T0) / DAY;
    return { t, value: fg + a * Math.exp(-k * tau) + noise(i) };
  });
}

describe('fitGravityDecay', () => {
  it('recovers the parameters of a clean decay', () => {
    const truth = { fg: 1.01, a: 0.05, k: 0.6 };
    const fit = fitGravityDecay(decay(truth, 7));
    expect(fit).not.toBeNull();
    expect(fit!.fg).toBeCloseTo(truth.fg, 3);
    expect(fit!.a).toBeCloseTo(truth.a, 3);
    expect(fit!.k).toBeCloseTo(truth.k, 1);
    expect(fit!.rms).toBeLessThan(1e-4);
  });

  it('still fits through Tilt-sized noise', () => {
    const truth = { fg: 1.012, a: 0.048, k: 0.5 };
    // Deterministic ±0.0005 jitter — about what a Tilt actually wobbles by.
    const fit = fitGravityDecay(decay(truth, 7, 2, (i) => (i % 3 - 1) * 0.0005));
    expect(fit).not.toBeNull();
    expect(fit!.fg).toBeCloseTo(truth.fg, 2);
  });

  it('declines to fit too few points', () => {
    expect(fitGravityDecay(decay({ fg: 1.01, a: 0.05, k: 0.6 }, 7).slice(0, 5))).toBeNull();
  });

  it('declines to fit too short a span', () => {
    // Plenty of points, but only 6 hours of them — not enough to extrapolate.
    expect(fitGravityDecay(decay({ fg: 1.01, a: 0.05, k: 0.6 }, 0.25, 0.5))).toBeNull();
  });

  it('declines to fit a flat series', () => {
    const flat = decay({ fg: 1.01, a: 0, k: 0.6 }, 7);
    expect(fitGravityDecay(flat)).toBeNull();
  });

  it('declines to fit a rising series', () => {
    const rising = decay({ fg: 1.01, a: 0.05, k: 0.6 }, 7).reverse().map((p, i) => ({
      t: T0 + i * 2 * 60 * 60 * 1000,
      value: p.value,
    }));
    expect(fitGravityDecay(rising)).toBeNull();
  });

  it('declines when the data is too noisy to trust', () => {
    const junk = decay({ fg: 1.01, a: 0.05, k: 0.6 }, 7, 2, (i) => (i % 2 ? 0.02 : -0.02));
    expect(fitGravityDecay(junk)).toBeNull();
  });
});

describe('predictGravity', () => {
  it('returns the starting gravity at t0 and approaches fg later', () => {
    const fit = { fg: 1.01, a: 0.05, k: 0.6, t0: T0, rms: 0 };
    expect(predictGravity(fit, T0)).toBeCloseTo(1.06, 6);
    expect(predictGravity(fit, T0 + 100 * DAY)).toBeCloseTo(1.01, 6);
  });
});

describe('estimateDoneTime', () => {
  const fit = { fg: 1.01, a: 0.05, k: 0.6, t0: T0, rms: 0 };

  it('lands where the modelled spread first clears the threshold', () => {
    const done = estimateDoneTime(fit, 3, 0.002, T0);
    expect(done).not.toBeNull();
    expect(done!.alreadyDone).toBe(false);
    // The window is the *trailing* one, matching the live fermentationDone rule:
    // at the estimate, the preceding `stableDays` of decay span the threshold.
    const spread = predictGravity(fit, done!.t - 3 * DAY) - predictGravity(fit, done!.t);
    expect(spread).toBeCloseTo(0.002, 5);
  });

  it('finishes later when the beer must hold stable for longer', () => {
    const short = estimateDoneTime(fit, 1, 0.002, T0);
    const long = estimateDoneTime(fit, 3, 0.002, T0);
    expect(long!.t).toBeGreaterThan(short!.t);
  });

  it('reports alreadyDone when the moment has passed', () => {
    const now = T0 + 30 * DAY;
    const done = estimateDoneTime(fit, 3, 0.002, now);
    expect(done).toEqual({ t: now, alreadyDone: true });
  });

  it('returns null when the finish is further out than the horizon', () => {
    // A crawling ferment: 60+ days before the spread narrows that far.
    const slow = { fg: 1.01, a: 0.05, k: 0.02, t0: T0, rms: 0 };
    expect(estimateDoneTime(slow, 3, 0.0001, T0)).toBeNull();
  });

  it('returns null for a non-positive threshold', () => {
    expect(estimateDoneTime(fit, 3, 0, T0)).toBeNull();
  });
});

describe('forecastSeries', () => {
  it('samples the curve inclusively at both ends', () => {
    const fit = { fg: 1.01, a: 0.05, k: 0.6, t0: T0, rms: 0 };
    const pts = forecastSeries(fit, T0, T0 + 2 * DAY, DAY / 2);
    expect(pts[0]!.t).toBe(T0);
    expect(pts[pts.length - 1]!.t).toBe(T0 + 2 * DAY);
    // Monotonically decreasing, and never below the asymptote.
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.value).toBeLessThan(pts[i - 1]!.value);
    expect(pts[pts.length - 1]!.value).toBeGreaterThan(fit.fg);
  });
});
