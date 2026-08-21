import type { BrewSession, BrewSessionStatus } from '@checklist/shared';

/**
 * Shared formatting for the brew-session log — used by both the list and the detail
 * page, so a batch reads the same in either place.
 */

/** A muted accent per stage, matching how the rest of the app chips state. */
export const STATUS_CHIP: Record<BrewSessionStatus, string> = {
  brewing: 'bg-[#f87a68]/20 text-[#f9a094]',
  fermenting: 'bg-amber-500/15 text-amber-300',
  conditioning: 'bg-sky-500/15 text-sky-300',
  packaged: 'bg-emerald-500/15 text-emerald-300',
};

/** A batch still on its way to the keg — pinned to the top of the log. */
export function isInProgress(brewSession: BrewSession): boolean {
  return brewSession.status !== 'packaged';
}

/** "5h 40m", "45m", or "—" when the brewer hasn't said how long it took. */
export function formatDuration(minutes: number | null): string {
  if (minutes == null || !Number.isFinite(minutes)) return '—';
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

/** The calendar day a brew happened, in the viewer's locale: "14 Jul 2026". */
export function brewDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The year a brew session falls in, for the log's separators. */
export function brewYear(iso: string): number | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.getFullYear();
}

/**
 * An ISO instant as the `yyyy-mm-dd` a date input wants, in *local* time.
 * `toISOString().slice(0, 10)` is the UTC day, which in Denmark is yesterday's
 * date for anything brewed after 01:00 in summer.
 */
export function dateInputValue(iso: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A `yyyy-mm-dd` from a date input back to an ISO instant, keeping the clock
 * time the entry already had. Editing "which day was this?" shouldn't silently
 * move a brew that started at 09:00 to midnight — and for a brew session being
 * back-dated from scratch, midday is a better guess than either midnight.
 */
export function dateInputToIso(value: string, keepTimeFrom: string | null): string | null {
  const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10));
  if (!year || !month || !day) return null;
  const previous = keepTimeFrom ? new Date(keepTimeFrom) : null;
  const valid = previous && !Number.isNaN(previous.getTime());
  const d = new Date(
    year,
    month - 1,
    day,
    valid ? previous.getHours() : 12,
    valid ? previous.getMinutes() : 0,
    0,
    0,
  );
  return d.toISOString();
}

/** A measured figure with its unit, or "—" when it was never measured. */
export function measured(value: number | null, unit: string, decimals = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(decimals).replace(/\.0$/, '')} ${unit}`;
}

/**
 * The leading number in a figure the sheet holds as text — "1.048", "28 L",
 * "67°C" all read. Null for anything that doesn't start with one, so a target
 * the recipe never stated simply has no comparison rather than a wrong one.
 */
function leadingNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number.parseFloat(value.trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * How far a measurement landed from what the recipe asked for, as the phrase
 * that goes under the field: "+4 pts", "−1.5 L", "+2 min".
 *
 * Gravities are compared in points, because that is the unit brewers actually
 * discuss a miss in — "four points short", never "0.004 short".
 *
 * Null when either side is missing, and null when they agree: a field with no
 * delta under it already says the day hit the number, and "±0" only adds ink.
 */
export function targetDelta(
  actual: string | number | null,
  target: string | number | null,
  /** The unit to say the difference in; 'gravity' switches to points. */
  unit: string,
): string | null {
  const a = leadingNumber(actual);
  const t = leadingNumber(target);
  if (a == null || t == null) return null;
  const gravity = unit === 'gravity';
  const difference = gravity ? (a - t) * 1000 : a - t;
  // Below a tenth of a point (or a tenth of a litre, degree, minute) the two
  // figures are the same reading twice, and rounding would print a signed zero.
  if (Math.abs(difference) < 0.05) return null;
  const rounded = gravity ? Math.round(difference) : Math.round(difference * 10) / 10;
  if (rounded === 0) return null;
  const sign = rounded > 0 ? '+' : '−';
  const size = Math.abs(rounded);
  if (gravity) return `${sign}${size} ${size === 1 ? 'pt' : 'pts'}`;
  return `${sign}${size} ${unit}`;
}
