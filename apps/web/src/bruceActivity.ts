import { useEffect, useState } from 'react';
import type { BrucePhase } from '@checklist/shared';

/**
 * Whether Bruce is working on a question right now, shared with the nav.
 *
 * The Bruce page and the sidebar are on opposite sides of the router — and the
 * shell remounts on every navigation — so this lives at module scope rather
 * than in React state. That also gives the behaviour you want: ask Bruce
 * something, wander off to check the fermenter, and the Bruce tab keeps its
 * indicator until the answer lands. The answer is stored server-side, so it is
 * waiting on the page when you come back.
 *
 * The phase travels with it so the nav can say *what* he is doing, not just
 * that he is busy — the same distinction the chat's own progress line draws
 * between reading the library and being out on the web.
 */

let current: BrucePhase | null = null;
const listeners = new Set<(phase: BrucePhase | null) => void>();

/** Set the phase, or null when the answer has landed (or failed). */
export function setBrucePhase(phase: BrucePhase | null): void {
  current = phase;
  for (const listener of listeners) listener(current);
}

/** The phase Bruce is in, or null when he is idle. Re-renders on change. */
export function useBrucePhase(): BrucePhase | null {
  const [phase, setPhase] = useState<BrucePhase | null>(current);
  useEffect(() => {
    // Sync on mount: the shell remounts mid-question on every navigation, and
    // would otherwise start from whatever the phase was when it last rendered.
    setPhase(current);
    listeners.add(setPhase);
    return () => {
      listeners.delete(setPhase);
    };
  }, []);
  return phase;
}
