import { useSyncExternalStore } from 'react';
import { api } from '../../api';
import { DEFAULT_BREW_THEME, mergeBrewTheme, type BrewTheme } from './theme';

/**
 * The rig's own colours, shared by everything that draws a piece of it.
 *
 * The brewer picks these on the rig's Settings → Theme screen, and the rig
 * serves them from `/api/settings`. Three places here paint with them — the
 * Brew System panel, the Overview's rig card, and the enlarged temperature
 * chart — and only the panel was ever fetching them, so the other two drew BK
 * in whatever red this repo had hardcoded. One module-level copy fixes that
 * without three components each asking the rig the same question.
 *
 * Kept as a store rather than context for the same reason `settings.ts` is one:
 * the Overview card renders far from any provider that would have to wrap it,
 * and a colour is not worth a re-parented tree.
 *
 * Defaults are the rig's own, so a rig that is powered off — its normal state
 * between brew sessions — looks exactly as it did before any of this.
 */

let cache: BrewTheme = DEFAULT_BREW_THEME;
let loaded = false;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/**
 * Adopt a theme already fetched elsewhere. The Brew System panel reads the
 * rig's whole config on arrival for the power limits, so its copy of the theme
 * is free — taking it here saves a second request for the same bytes.
 */
export function primeRigTheme(rigTheme: Record<string, string> | undefined): void {
  cache = mergeBrewTheme(rigTheme);
  loaded = true;
  emit();
}

/** Read the rig's theme once, quietly keeping the defaults if it can't be had. */
function load(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const config = await api.getBrewSystemConfig();
      // Offline is not a failure — it's how the rig sits most of the year.
      if (config.online) primeRigTheme(config.theme);
    } catch {
      /* defaults stand */
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Fetched on first use rather than at import: a browser that never opens a
  // page showing the rig should never ask about it.
  if (!loaded) void load();
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): BrewTheme {
  return cache;
}

/** The rig's theme, re-rendering the caller when it arrives. */
export function useRigTheme(): BrewTheme {
  return useSyncExternalStore(subscribe, snapshot);
}
