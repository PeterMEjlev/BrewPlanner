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
