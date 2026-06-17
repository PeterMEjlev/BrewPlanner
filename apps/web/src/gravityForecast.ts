/**
 * Client-side gravity fermentation forecast. Fits the classic "approach to
 * terminal gravity" decay model to a Tilt's specific-gravity history and
 * extrapolates it forward, so the Overview's gravity sparkline can draw a short
 * prediction and estimate when fermentation will finish.
 *
 * Model:  SG(t) = FG + A·e^(−k·τ),   τ = days since the first sample
 *   FG = terminal (final) gravity the beer settles toward
 *   A  = remaining drop at τ=0 (≈ OG − FG); always ≥ 0 for a fermentation
 *   k  = attenuation rate per day; larger = faster
 *
 * Fitting is dependency-free: for any candidate `k` the model is *linear* in
 * {FG, A}, so we solve those by closed-form least squares and search `k` in 1-D
 * for the lowest error. This is stable on noisy Tilt data and — unlike a raw
 * polynomial — can't produce a runaway forecast, since it's bounded by FG.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GravityPoint {
  /** Epoch milliseconds. */
  t: number;
  /** Specific gravity. */
  value: number;
}

export interface GravityFit {
  /** Terminal gravity the curve approaches. */
  fg: number;
  /** Remaining drop at t0 (≈ OG − FG). */
  a: number;
  /** Attenuation rate, per day. */
  k: number;
  /** Epoch ms of the first sample — the model's τ=0. */
  t0: number;
  /** Root-mean-square residual, in gravity points — a fit-quality gauge. */
  rms: number;
}

// Gating: don't pretend to forecast from too little, too-flat, or too-noisy data.
const MIN_POINTS = 8;
const MIN_SPAN_MS = 12 * 60 * 60 * 1000; // need at least 12h of history
const MIN_DROP = 0.003; // and a genuine downward trend to fit a decay
const MAX_RMS = 0.004; // reject fits worse than typical Tilt noise
const MAX_DONE_DAYS = 60; // beyond this, the finish is "uncertain" → null

/** Predicted gravity at time `t` for a fit. */
export function predictGravity(fit: GravityFit, t: number): number {
  return fit.fg + fit.a * Math.exp(-fit.k * ((t - fit.t0) / DAY_MS));
}

/**
 * Fit the decay model to a gravity history (oldest→newest). Returns null when
 * the data is too sparse, too flat, or fits too poorly to forecast honestly.
 */
export function fitGravityDecay(points: GravityPoint[]): GravityFit | null {
  const n = points.length;
  if (n < MIN_POINTS) return null;
  const t0 = points[0]!.t;
  const span = points[n - 1]!.t - t0;
  if (span < MIN_SPAN_MS) return null;

  // Need a real downward trend; otherwise this is lag phase or flat noise.
  if (points[0]!.value - points[n - 1]!.value < MIN_DROP) return null;

  const tau = points.map((p) => (p.t - t0) / DAY_MS);
  const v = points.map((p) => p.value);

  // Linear least squares for {FG, A} at a fixed k, returning the fit + its SSE.
  const evalK = (k: number): { fg: number; a: number; sse: number } | null => {
    let s1 = 0; // Σ e^{-kτ}
    let s2 = 0; // Σ e^{-2kτ}
    let sv = 0; // Σ v
    let sf = 0; // Σ v·e^{-kτ}
    const e = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const ei = Math.exp(-k * tau[i]!);
      e[i] = ei;
      s1 += ei;
      s2 += ei * ei;
      sv += v[i]!;
      sf += v[i]! * ei;
    }
    const det = n * s2 - s1 * s1;
    if (Math.abs(det) < 1e-12) return null;
    const fg = (sv * s2 - s1 * sf) / det;
    const a = (n * sf - s1 * sv) / det;
    if (a <= 0) return null; // not a decay toward a lower asymptote
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const r = v[i]! - (fg + a * e[i]!);
      sse += r * r;
    }
    return { fg, a, sse };
  };

  let bestSse = Infinity;
  let bestK = 0;
  let bestFg = 0;
  let bestA = 0;
  const consider = (k: number): void => {
    const r = evalK(k);
    if (r && r.sse < bestSse) {
      bestSse = r.sse;
      bestK = k;
      bestFg = r.fg;
      bestA = r.a;
    }
  };

  // Coarse log-spaced sweep of k (per day), then a ternary-search refine.
  const kMin = 0.02;
  const kMax = 30;
  const steps = 60;
  for (let i = 0; i <= steps; i++) consider(kMin * Math.pow(kMax / kMin, i / steps));
  if (bestSse === Infinity) return null;

  let lo = bestK / 1.5;
  let hi = bestK * 1.5;
  for (let iter = 0; iter < 24; iter++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const r1 = evalK(m1);
    const r2 = evalK(m2);
    if ((r1 ? r1.sse : Infinity) < (r2 ? r2.sse : Infinity)) hi = m2;
    else lo = m1;
    consider(m1);
    consider(m2);
  }

  const rms = Math.sqrt(bestSse / n);
  if (rms > MAX_RMS) return null;
  // Reject an implausible asymptote (above the latest reading, or sub-water).
  if (bestFg < 0.98 || bestFg > points[n - 1]!.value + 1e-6) return null;

  return { fg: bestFg, a: bestA, k: bestK, t0, rms };
}

/**
 * Estimate when fermentation will be "complete" under the same rule the live
 * status uses: the gravity's spread over a trailing `stableDays` window falls
 * within `thresholdSg`. For the model, that spread at time τ is
 * `A·e^(−kτ)·(e^{kW} − 1)`, which we invert for the first τ that clears the
 * threshold. Returns the epoch-ms estimate (with `alreadyDone` when that's
 * already true), or null when it's further out than {@link MAX_DONE_DAYS}.
 */
export function estimateDoneTime(
  fit: GravityFit,
  stableDays: number,
  thresholdSg: number,
  now: number,
): { t: number; alreadyDone: boolean } | null {
  // A·(e^{kW} − 1): the spread coefficient. expm1 keeps precision for small kW.
  const factor = fit.a * Math.expm1(fit.k * stableDays);
  if (factor <= 0 || thresholdSg <= 0) return null;
  const tauDone = Math.log(factor / thresholdSg) / fit.k;
  const tDone = fit.t0 + tauDone * DAY_MS;
  if (tDone <= now) return { t: now, alreadyDone: true };
  if ((tDone - now) / DAY_MS > MAX_DONE_DAYS) return null;
  return { t: tDone, alreadyDone: false };
}

/** Sample the predicted curve from `from`→`to` (epoch ms) at `stepMs` spacing. */
export function forecastSeries(
  fit: GravityFit,
  from: number,
  to: number,
  stepMs: number,
): GravityPoint[] {
  const pts: GravityPoint[] = [];
  for (let t = from; t < to; t += stepMs) pts.push({ t, value: predictGravity(fit, t) });
  pts.push({ t: to, value: predictGravity(fit, to) });
  return pts;
}
