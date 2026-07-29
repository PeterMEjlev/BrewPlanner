/** Normalize a thrown value into a user-facing message. */
export function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}

/**
 * As {@link asMessage}, minus the leading "<status>: " that the api client
 * prefixes onto failures — for places that show the server's own message to the
 * user, where a bare HTTP code adds nothing they can act on.
 */
export function asCleanMessage(e: unknown): string {
  return asMessage(e).replace(/^\d{3}:\s*/, '');
}

/**
 * Where an in-app "Home" button should land. Some `/kiosk/*` pages are reachable
 * from the desktop UI too (or by direct URL), so a hardcoded `/kiosk` home link
 * would strand a desktop visitor on the touch hub. The physical Pi kiosk tags
 * `<html class="kiosk">` (see
 * main.tsx) — the codebase's dependable "this is the kiosk" signal — so route
 * Home to the kiosk hub there and to the desktop Overview everywhere else.
 */
export function homePath(): string {
  return document.documentElement.classList.contains('kiosk') ? '/kiosk' : '/';
}

/**
 * The app shows times on a 24-hour clock everywhere — the brewery's own
 * convention, and unambiguous in a way "3:50 PM" isn't on a log line or a chart
 * tooltip. Left to the browser, the same page reads 15:50 on the Pi kiosk and
 * 3:50 PM on a phone set to US English, so the clock part is built by hand
 * rather than delegated to `toLocaleTimeString`. Only the *time* is pinned:
 * dates still follow the viewer's locale, so day/month order stays familiar.
 */
type Timestamp = string | number | Date;

function toDate(t: Timestamp): Date {
  return t instanceof Date ? t : new Date(t);
}

/** Zero-padded 24-hour clock: `08:20`, or `08:20:15` with seconds. */
export function clockTime(t: Timestamp, withSeconds = false): string {
  const d = toDate(t);
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (!withSeconds) return `${hh}:${mm}`;
  return `${hh}:${mm}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/** Date then 24-hour time, e.g. `29 Jul 2026, 15:50` — tooltips and titles. */
export function dateTime(t: Timestamp, withSeconds = false): string {
  const d = toDate(t);
  if (Number.isNaN(d.getTime())) return '—';
  const date = d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  return `${date}, ${clockTime(d, withSeconds)}`;
}

/** Compact "x ago" string for a recent ISO timestamp. */
export function relativeTime(iso: string): string {
  const diffMs = Date.now() - Date.parse(iso);
  const sec = Math.max(0, Math.round(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}
