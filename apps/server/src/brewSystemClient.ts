import type { BrewSystemState } from '@checklist/shared';

/**
 * Talking to the brewing rig (the separate Raspberry Pi running brew-system-v3).
 *
 * Split out of routes/brewSystem.ts because two callers need it now: the proxy
 * routes the dashboard drives, and the brew-session sampler that logs pot
 * temperatures in the background. The routes own the *policy* (which endpoints
 * are forwarded, who may call them); this module only knows how to reach the rig.
 *
 * The rig is normally powered off between brew sessions, so "unreachable" is an
 * expected state rather than an error — every read here answers null instead of
 * throwing at the caller.
 */

/** Where the rig lives on the LAN, e.g. `http://192.168.1.60:8000` (no trailing slash). */
export function rigBase(): string | null {
  const url = process.env.BREW_SYSTEM_URL?.trim().replace(/\/+$/, '');
  return url ? url : null;
}

/**
 * Short timeout: the rig answers state reads from an in-memory cache in
 * milliseconds, so anything slower means it's off or the LAN is broken.
 */
export const RIG_TIMEOUT_MS = 2500;

export async function rigGet<T>(base: string, path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(RIG_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Rig answered ${res.status} for ${path}`);
  return (await res.json()) as T;
}

/**
 * The rig's live hardware state, or null when it isn't configured or didn't
 * answer. The one read the sampler needs, so it doesn't have to know the rig's
 * URL scheme or repeat the "off is normal" handling.
 */
export async function readBrewSystemState(): Promise<BrewSystemState | null> {
  const base = rigBase();
  if (!base) return null;
  try {
    return await rigGet<BrewSystemState>(base, '/api/hardware/state');
  } catch {
    return null;
  }
}
