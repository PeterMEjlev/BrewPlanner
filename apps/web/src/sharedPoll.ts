import { useCallback, useEffect, useState } from 'react';
import { onResume, pollingPaused } from './usePoll';

/**
 * One poll loop per resource, shared by everyone who wants it.
 *
 * {@link usePoll} gives each hook instance its own timer, which is right for a
 * resource only one component reads — but several here are read from two places
 * at once. The sidebar polls /api/devices every 15s for its nav badge while the
 * page in front of it polls the same endpoint at the fleet's logging cadence;
 * the Alerts page and the alert badge each fetch the alert list; the keg grid
 * and the keg badge each pull the inventory. The module-level caches those hooks
 * kept meant the *data* was shared, but the requests never were: two timers, two
 * round trips, two copies of the same payload over the tunnel.
 *
 * A channel is that missing piece — one timer and one in-flight request per key,
 * with a set of subscribers fanned out to. It keeps everything usePoll already
 * got right (hidden tabs don't poll, returning to the foreground catches up if a
 * tick was missed) by reusing that module's visibility state instead of tracking
 * its own, and it keeps the last value after the final subscriber leaves, so it
 * subsumes the hand-rolled caches rather than sitting on top of them.
 */

export interface SharedState<T> {
  /** Last value fetched, or null before the first one lands. */
  data: T | null;
  /** Last fetch error. Data is kept, so a blip shows stale numbers, not none. */
  error: string | null;
}

const EMPTY: SharedState<never> = { data: null, error: null };

interface Channel<T> {
  load: () => Promise<T>;
  /** Replaced (never mutated) on publish, so identity doubles as a change flag. */
  state: SharedState<T>;
  subscribers: Map<object, (state: SharedState<T>) => void>;
  /** Cadence each subscriber asked for; the channel runs at the fastest of them. */
  rates: Map<object, number>;
  timer: ReturnType<typeof setInterval> | null;
  intervalMs: number;
  lastRunAt: number;
  /** The current request, so concurrent callers await one round trip. */
  inFlight: Promise<void> | null;
  detachResume: (() => void) | null;
}

// One entry per resource key. Channels outlive their subscribers (see above).
const channels = new Map<string, Channel<unknown>>();

function channelFor<T>(key: string): Channel<T> | undefined {
  return channels.get(key) as Channel<T> | undefined;
}

function publish<T>(channel: Channel<T>, state: SharedState<T>): void {
  channel.state = state;
  for (const notify of [...channel.subscribers.values()]) notify(state);
}

/**
 * Fetch once for everybody. A call that arrives while a request is already out
 * joins it rather than starting a second — which is what stops a page and the
 * sidebar from both hitting the endpoint when their timers happen to line up.
 */
function run<T>(key: string): Promise<void> {
  const channel = channelFor<T>(key);
  if (!channel) return Promise.resolve();
  if (channel.inFlight) return channel.inFlight;
  channel.lastRunAt = Date.now();
  channel.inFlight = channel
    .load()
    .then((data) => publish(channel, { data, error: null }))
    .catch((e) =>
      // Keep the last good value: every call site here would rather show a
      // slightly stale number than blank out on one failed request.
      publish(channel, {
        data: channel.state.data,
        error: e instanceof Error ? e.message : 'Request failed',
      }),
    )
    .finally(() => {
      channel.inFlight = null;
    });
  return channel.inFlight;
}

/** (Re)start the channel timer at the fastest cadence any subscriber asked for. */
function retime<T>(key: string, channel: Channel<T>): void {
  const fastest = Math.min(...channel.rates.values());
  if (channel.timer && channel.intervalMs === fastest) return;
  if (channel.timer) clearInterval(channel.timer);
  channel.intervalMs = fastest;
  channel.timer = setInterval(() => {
    if (!pollingPaused()) void run<T>(key);
  }, fastest);
}

/**
 * Join a channel, creating it if nobody has yet. Returns an unsubscribe.
 *
 * The React-free core of this module, so it can be tested without a DOM:
 * {@link useShared} is a thin binding over it.
 */
export function subscribe<T>(
  key: string,
  load: () => Promise<T>,
  intervalMs: number,
  notify: (state: SharedState<T>) => void,
): () => void {
  let channel = channelFor<T>(key);
  if (!channel) {
    channel = {
      load,
      state: EMPTY as SharedState<T>,
      subscribers: new Map(),
      rates: new Map(),
      timer: null,
      intervalMs,
      lastRunAt: 0,
      inFlight: null,
      detachResume: null,
    };
    channels.set(key, channel as Channel<unknown>);
  }
  const active = channel;
  const token = {};
  // Waking a dormant channel (its last subscriber had left) needs the
  // foreground-resume hook back; a live one already has it.
  if (!active.detachResume) {
    active.detachResume = onResume(() => {
      if (Date.now() - active.lastRunAt >= active.intervalMs) void run<T>(key);
    });
  }
  active.subscribers.set(token, notify);
  active.rates.set(token, intervalMs);
  retime(key, active);
  // Join an interval already in progress silently — the new subscriber gets the
  // value that's already loaded. Only a channel whose data has gone stale (or
  // never loaded) pays for a request here.
  if (!active.inFlight && Date.now() - active.lastRunAt >= intervalMs) void run<T>(key);

  return () => {
    active.subscribers.delete(token);
    active.rates.delete(token);
    if (active.subscribers.size > 0) {
      retime(key, active);
      return;
    }
    // Nobody left: stop polling but keep `state`, which is what lets a page
    // repaint instantly with its last data when you navigate back to it.
    if (active.timer) clearInterval(active.timer);
    active.timer = null;
    active.detachResume?.();
    active.detachResume = null;
  };
}

/**
 * Subscribe to a shared resource, polled at `intervalMs`.
 *
 * `key` identifies the resource and is the whole contract: everyone using a key
 * gets the same data from the same request, and the `load` passed by whoever
 * opens the channel is the one that runs. So `load` must be a stable, free
 * function of nothing — `api.listDevices`, not a closure over component state.
 *
 * `intervalMs` may vary per subscriber (the fleet pages poll at each device's
 * own logging cadence, the nav badge far slower); the channel runs at whatever
 * the most demanding subscriber currently on screen asked for.
 */
export function useShared<T>(
  key: string,
  load: () => Promise<T>,
  intervalMs: number,
): SharedState<T> & { refresh: () => Promise<void> } {
  const [state, setState] = useState<SharedState<T>>(
    () => channelFor<T>(key)?.state ?? (EMPTY as SharedState<T>),
  );

  useEffect(() => {
    const unsubscribe = subscribe<T>(key, load, intervalMs, setState);
    // Anything published between this render and this effect. `state` objects
    // are replaced only on publish, so an unchanged one bails out of rendering.
    setState(channelFor<T>(key)?.state ?? (EMPTY as SharedState<T>));
    return unsubscribe;
    // `load` is deliberately not a dependency: it is required to be stable for
    // the key (see above), and an inline arrow would resubscribe every render.
  }, [key, intervalMs]);

  const refresh = useCallback(() => run<T>(key), [key]);
  return { ...state, refresh };
}

/**
 * Push a value into a channel without fetching, updating every subscriber.
 *
 * For optimistic edits: the keg editor writes to a Google Sheet whose published
 * CSV lags a minute or two behind, so the saved rows are merged in locally
 * instead of refetched. Going through the channel means the sidebar's keg badge
 * sees the edit too, which it never did while the grid kept its own copy.
 */
export function publishShared<T>(key: string, update: (current: T | null) => T | null): void {
  const channel = channelFor<T>(key);
  if (!channel) return;
  publish(channel, { data: update(channel.state.data), error: channel.state.error });
}

/** Forget every channel. Tests only — the app wants these to outlive unmounts. */
export function resetSharedChannels(): void {
  for (const channel of channels.values()) {
    if (channel.timer) clearInterval(channel.timer);
    channel.detachResume?.();
  }
  channels.clear();
}

/** Resource keys. Named here so a typo can't silently open a second channel. */
export const SHARED = {
  devices: 'devices',
  alerts: 'alerts',
  kegs: 'kegs',
  activeRecipe: 'activeRecipe',
  hosts: 'hosts',
} as const;
