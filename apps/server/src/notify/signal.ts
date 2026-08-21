import type { AlertSeverity, DeviceStatus, Reading } from '@checklist/shared';
import { getHistory } from '../devices/repo.js';

/**
 * The vocabulary the telemetry checks are written in — shared by the built-in
 * critical checks (critical.ts) and the brewer's own rules (custom.ts) so both
 * decide "has this been true long enough to mean something?" the same way.
 *
 * Two ideas do all the work here.
 *
 * **Three-state verdicts.** A check answers `firing`, `clear`, or `unknown`,
 * never a boolean. `unknown` is the honest answer when a sensor is silent, when
 * there isn't enough history to judge, or when a reading is sitting on the
 * threshold — and it deliberately does nothing, leaving an open alert open
 * rather than flapping it shut on no evidence.
 *
 * **Windows, not samples.** A single reading is a glitch; a reading that has
 * held for minutes is a condition. Every judgement here is made over a span of
 * time that the readings must actually cover — {@link spans} is what stops a
 * sensor that has been offline for an hour and just came back from reading as
 * "it's been fine for an hour".
 */

export const MIN = 60_000;
export const HOUR = 3_600_000;

/**
 * What one check concluded this tick. See the module note: `unknown` covers a
 * silent sensor, a history too short to judge, and the band around a threshold,
 * and must never close an alert that is still open.
 */
export type Verdict =
  | { state: 'firing'; severity: AlertSeverity; title: string; detail: string }
  | { state: 'clear' }
  | { state: 'unknown' };

export const CLEAR: Verdict = { state: 'clear' };
export const UNKNOWN: Verdict = { state: 'unknown' };

// --- Reading helpers --------------------------------------------------------

/** The device's most recent value for a metric, or null if it has none. */
export function latest(device: DeviceStatus, metric: string): number | null {
  const reading = device.latest.find((r) => r.metric === metric);
  return reading ? reading.value : null;
}

/** Raw readings for a metric over the last `windowMs`, oldest first. */
export function history(deviceId: number, metric: string, windowMs: number): Reading[] {
  const rows = getHistory(deviceId, {
    metric,
    since: new Date(Date.now() - windowMs).toISOString(),
    // Newest-first with a cap would silently drop the *oldest* rows — exactly the
    // ones the span checks below depend on. Agents push at most every 30s, so
    // this covers a long window with room to spare.
    limit: 5000,
  });
  return rows.slice().reverse();
}

/** Whether the readings actually cover `windowMs` rather than a recent sliver. */
export function spans(readings: { recordedAt: string }[], windowMs: number): boolean {
  if (readings.length < 2) return false;
  const oldest = Date.parse(readings[0]!.recordedAt);
  const newest = Date.parse(readings[readings.length - 1]!.recordedAt);
  if (!Number.isFinite(oldest) || !Number.isFinite(newest)) return false;
  // Allow a little slack: a 5-minute window sampled every 30s starts ~4m30s back.
  return newest - oldest >= windowMs * 0.8;
}

/** Whether every reading in a full window satisfies the predicate. */
export function sustained<T extends { recordedAt: string }>(
  readings: T[],
  predicate: (r: T) => boolean,
  windowMs: number,
): boolean {
  return spans(readings, windowMs) && readings.every(predicate);
}

// --- Formatting -------------------------------------------------------------

/**
 * Pressure in both units. The hub stores bar and the phone shows whichever the
 * browser is set to, but a notification is plain text with no settings behind
 * it — so it carries both rather than guessing which one the reader thinks in.
 */
export function pressure(bar: number): string {
  return `${bar.toFixed(2)} bar (${Math.round(bar * 14.5038)} psi)`;
}

export function degrees(c: number): string {
  return `${c.toFixed(1)} °C`;
}

export function minutes(ms: number): string {
  const m = Math.round(ms / MIN);
  return m >= 60 ? hours(ms) : `${m} min`;
}

export function hours(ms: number): string {
  const h = ms / HOUR;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}
