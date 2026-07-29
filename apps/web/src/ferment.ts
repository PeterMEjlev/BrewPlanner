import type { Reading } from '@checklist/shared';

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
