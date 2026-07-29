import { App as CapacitorApp } from '@capacitor/app';
import { useEffect, useRef } from 'react';
import { isNative } from './native';

/**
 * The one polling loop used app-wide. Every screen refreshes by polling, and
 * before this hook each site ran its own bare `setInterval` — which kept firing
 * with the tab hidden or the Android app backgrounded, hammering the tunnel and
 * draining the phone's battery for data nobody was looking at.
 *
 * `usePoll` centralises the interval boilerplate and adds visibility awareness:
 *
 * - Ticks are skipped while the page is hidden (`document.visibilityState`) or
 *   the native app is backgrounded (Capacitor `appStateChange`).
 * - On return to the foreground, a refresh fires immediately — but only if at
 *   least one interval was actually missed, so flicking between apps doesn't
 *   spam requests.
 * - The Pi kiosk's always-on screen is never hidden, so kiosk pages behave
 *   exactly as before.
 */

// --- Shared foreground/background state --------------------------------------

/** False while the Capacitor app is backgrounded; always true in a browser. */
let nativeActive = true;

/** Callbacks to fire when the app returns to the foreground. */
const resumeListeners = new Set<() => void>();

/** No document under a test runner; there, treat the app as always visible. */
const hasDocument = typeof document !== 'undefined';

/**
 * True while nobody is looking — a hidden tab or a backgrounded native app.
 * Exported so the shared-channel store (sharedPoll.ts) can drive its own timers
 * with exactly the same rule, rather than inventing a second one.
 */
export function pollingPaused(): boolean {
  return !nativeActive || (hasDocument && document.visibilityState === 'hidden');
}

/** Run `fn` when the app returns to the foreground. Returns an unsubscribe. */
export function onResume(fn: () => void): () => void {
  resumeListeners.add(fn);
  return () => resumeListeners.delete(fn);
}

function notifyResume(): void {
  if (pollingPaused()) return;
  for (const listener of [...resumeListeners]) listener();
}

if (hasDocument) document.addEventListener('visibilitychange', notifyResume);

// In the native app the web view can keep running while backgrounded without a
// visibilitychange, so track Capacitor's app state as well.
if (isNative()) {
  void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
    nativeActive = isActive;
    notifyResume();
  });
}

// --- The hook -----------------------------------------------------------------

/**
 * Run `fn` now and then every `intervalMs`, pausing while the app is hidden.
 *
 * `fn` receives an `isStale()` probe: it returns true once this poll instance
 * has been torn down (unmount or a `deps` change), so async work can skip its
 * `setState` when the response lands late — the same job the hand-rolled
 * `cancelled` flags did.
 *
 * `deps` restarts the loop (with an immediate run) when they change — pass what
 * the previous `useEffect` dependency array held, minus the interval, which is
 * tracked automatically. `intervalMs: null` fetches once but never polls.
 */
export function usePoll(
  fn: (isStale: () => boolean) => void | Promise<void>,
  intervalMs: number | null,
  deps: React.DependencyList = [],
): void {
  // Always call the latest render's closure without restarting the interval.
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let disposed = false;
    let lastRun = 0;
    const run = (): void => {
      lastRun = Date.now();
      void fnRef.current(() => disposed);
    };

    // The initial fetch is unconditional (even if mounted hidden) so the screen
    // has data the moment it becomes visible.
    run();
    if (intervalMs == null) return () => {
      disposed = true;
    };

    const timer = setInterval(() => {
      if (!pollingPaused()) run();
    }, intervalMs);
    const onResume = (): void => {
      // Catch up only when a tick was actually missed while hidden.
      if (Date.now() - lastRun >= intervalMs) run();
    };
    resumeListeners.add(onResume);
    return () => {
      disposed = true;
      clearInterval(timer);
      resumeListeners.delete(onResume);
    };
  }, [intervalMs, ...deps]);
}
