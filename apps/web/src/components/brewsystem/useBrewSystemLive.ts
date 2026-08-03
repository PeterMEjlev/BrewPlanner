import type { BrewSystemState, BrewSystemStatus } from '@checklist/shared';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { SHARED, useShared } from '../../sharedPoll';

/**
 * The rig's live state, for the Overview's read-only brew-system views.
 *
 * Everyone here shares one poll of `/api/brew-system/state` — the sidebar's
 * Online/Offline badge, the rail card, and the enlarged view — so opening the
 * card doesn't add a second request to a rig on the end of a tunnel. The
 * channel runs at whichever subscriber asked for the fastest cadence.
 *
 * The Brew System *page* keeps its own faster loop: it sends commands, so it
 * needs to see their effect at a control's latency, not a dashboard's.
 */

/**
 * Cadence while an Overview brew-system view is on screen. Faster than the
 * sidebar badge's 15s — a heater ramp or a pump change is worth seeing promptly
 * on a brew session — but slower than the Brew System page's 2s, since nothing here
 * is a control and these requests usually cross the tunnel.
 */
export const BREW_SYSTEM_POLL_MS = 5_000;

/**
 * Last state the rig sent, held at module scope so a view mounting later (the
 * enlarged one) paints from it immediately instead of showing dashes until the
 * next poll lands.
 */
let lastState: BrewSystemState | null = null;

export interface BrewSystemLive {
  /** The availability envelope; null until the first answer of the session. */
  status: BrewSystemStatus | null;
  /**
   * The rig's readings — the last ones it sent once it goes quiet, so a power
   * cut mid-brew leaves the numbers on screen (greyed) rather than blanking them.
   */
  state: BrewSystemState | null;
}

export function useBrewSystemLive(intervalMs = BREW_SYSTEM_POLL_MS): BrewSystemLive {
  const { data } = useShared(SHARED.brewSystem, api.getBrewSystemState, intervalMs);
  const [held, setHeld] = useState<BrewSystemState | null>(lastState);

  useEffect(() => {
    if (!data?.state) return;
    lastState = data.state;
    setHeld(data.state);
  }, [data]);

  return { status: data, state: data?.state ?? held };
}
