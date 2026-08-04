import { abvFromGravities, type Reading } from '@checklist/shared';

/**
 * Has fermentation finished? True when the gravity readings inside the trailing
 * `windowMs` have held within `thresholdSg` of each other — the "stable for
 * three days" rule of thumb, read off the Tilt instead of a hydrometer sample.
 *
 * Two guards keep it from calling it early, which matters because this is the
 * kind of check that misfires silently rather than crashing:
 *
 * - fewer than two readings in the window says nothing about stability;
 * - the readings must actually *span* the window (80% of it, allowing for a
 *   sensor that drops the odd sample). Without that, a Tilt switched on an hour
 *   ago would look perfectly stable and report a finished ferment.
 *
 * Lives here rather than in a page because the Overview and the kiosk home both
 * show this status and used to carry their own copy of the rule.
 */
export function fermentationDone(
  history: Reading[],
  windowMs: number,
  thresholdSg: number,
): boolean {
  const windowStart = Date.now() - windowMs;
  const recent = history.filter((r) => Date.parse(r.recordedAt) >= windowStart);
  if (recent.length < 2) return false;
  const times = recent.map((r) => Date.parse(r.recordedAt));
  if (Math.max(...times) - Math.min(...times) < windowMs * 0.8) return false;
  const values = recent.map((r) => r.value);
  return Math.max(...values) - Math.min(...values) <= thresholdSg;
}

/**
 * How much alcohol the beer in the tank has made so far, %: the batch's OG
 * against the Tilt's current reading.
 *
 * Floored at zero. A Tilt sits a point or two off a hydrometer, so a batch that
 * has barely started can read *above* its OG, and "−0.2 % ABV" reads as a broken
 * card rather than as calibration drift. Null when the OG isn't a gravity the
 * arithmetic can use — the caller's fallbacks for a missing OG end in a target
 * typed by hand, so this can't assume it got a real one.
 */
export function fermentAbv(og: number, currentSg: number): number | null {
  if (!Number.isFinite(og) || og <= 1) return null;
  const abv = abvFromGravities(og, currentSg);
  return abv == null ? null : Math.max(0, abv);
}
