import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishShared, resetSharedChannels, subscribe } from './sharedPoll';

/**
 * The whole point of a channel is that N readers of one resource cost one
 * request on one timer. These tests count the calls, because the failure mode
 * this replaced — two components quietly polling the same endpoint — is
 * invisible from the UI: everything looks right, it just costs twice as much
 * over the tunnel.
 */

/** A loader that counts its calls and resolves on demand. */
function counted<T>(value: T) {
  let calls = 0;
  return {
    load: async () => {
      calls += 1;
      return value;
    },
    get calls() {
      return calls;
    },
  };
}

/** Let queued promise callbacks run (the loaders resolve immediately). */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetSharedChannels();
  vi.useRealTimers();
});

describe('subscribe', () => {
  it('fetches once for the first subscriber and shares the result', async () => {
    const src = counted(['a']);
    const seen: unknown[] = [];
    subscribe('k', src.load, 1000, (s) => seen.push(s.data));
    await settle();

    expect(src.calls).toBe(1);
    expect(seen).toEqual([['a']]);
  });

  it('does not refetch for a second subscriber joining a fresh channel', async () => {
    const src = counted(['a']);
    subscribe('k', src.load, 1000, () => {});
    await settle();
    expect(src.calls).toBe(1);

    // The sidebar mounting on top of a page that already has the data: it reads
    // what's loaded rather than asking for it again.
    subscribe('k', src.load, 1000, () => {});
    await settle();
    expect(src.calls).toBe(1);
  });

  it('runs one timer for two subscribers, not two', async () => {
    const src = counted(['a']);
    subscribe('k', src.load, 1000, () => {});
    subscribe('k', src.load, 1000, () => {});
    await settle();
    expect(src.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(3000);
    // Three ticks, one request each — not six.
    expect(src.calls).toBe(4);
  });

  it('polls at the fastest rate any subscriber asked for', async () => {
    const src = counted(['a']);
    subscribe('k', src.load, 10_000, () => {}); // the slow nav badge
    await settle();
    await vi.advanceTimersByTimeAsync(2500);
    expect(src.calls).toBe(1); // slow rate: nothing yet

    subscribe('k', src.load, 1000, () => {}); // a page wanting it fresh
    await vi.advanceTimersByTimeAsync(3000);
    expect(src.calls).toBeGreaterThanOrEqual(4);
  });

  it('drops back to the slower rate when the demanding subscriber leaves', async () => {
    const src = counted(['a']);
    subscribe('k', src.load, 10_000, () => {});
    const leaveFast = subscribe('k', src.load, 1000, () => {});
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    const whileFast = src.calls;
    expect(whileFast).toBeGreaterThan(1);

    leaveFast();
    await vi.advanceTimersByTimeAsync(3000);
    expect(src.calls).toBe(whileFast); // back to 10s: no tick in 3s
  });

  it('coalesces callers that arrive while a request is in flight', async () => {
    let calls = 0;
    let release: (v: string[]) => void = () => {};
    const load = () => {
      calls += 1;
      return new Promise<string[]>((r) => {
        release = r;
      });
    };
    subscribe('k', load, 1000, () => {});
    expect(calls).toBe(1);

    // Ticks keep firing while the slow request is outstanding; none pile on.
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toBe(1);

    release(['done']);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
  });

  it('stops polling when the last subscriber leaves but keeps the value', async () => {
    const src = counted(['a']);
    const leave = subscribe('k', src.load, 1000, () => {});
    await settle();
    leave();

    await vi.advanceTimersByTimeAsync(5000);
    expect(src.calls).toBe(1); // timer cleared

    // Coming back renders from the retained value; it refetches because the
    // value is now older than the interval, but it is never blank first.
    let first: unknown = null;
    subscribe('k', src.load, 1000, (s) => {
      first ??= s.data;
    });
    expect(src.calls).toBe(2);
  });

  it('keeps the last good data when a fetch fails, and reports the error', async () => {
    let ok = true;
    const load = async () => {
      if (!ok) throw new Error('tunnel down');
      return ['good'];
    };
    const states: { data: string[] | null; error: string | null }[] = [];
    subscribe<string[]>('k', load, 1000, (s) => states.push({ ...s }));
    await settle();
    expect(states.at(-1)).toEqual({ data: ['good'], error: null });

    ok = false;
    await vi.advanceTimersByTimeAsync(1000);
    // Stale numbers with an error beside them, not a blanked panel.
    expect(states.at(-1)).toEqual({ data: ['good'], error: 'tunnel down' });
  });

  it('keeps separate keys separate', async () => {
    const a = counted(['a']);
    const b = counted(['b']);
    subscribe('a', a.load, 1000, () => {});
    subscribe('b', b.load, 1000, () => {});
    await settle();
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
  });
});

describe('publishShared', () => {
  it('pushes an optimistic edit to every subscriber without fetching', async () => {
    const src = counted([{ id: 1, name: 'old' }]);
    const seen: unknown[] = [];
    subscribe('k', src.load, 1000, (s) => seen.push(s.data));
    subscribe('k', src.load, 1000, (s) => seen.push(s.data));
    await settle();
    const afterLoad = seen.length;

    publishShared<{ id: number; name: string }[]>('k', (cur) =>
      (cur ?? []).map((r) => ({ ...r, name: 'edited' })),
    );

    expect(src.calls).toBe(1); // no refetch
    // Both subscribers heard about it — this is what keeps the sidebar badge in
    // step with an edit made on the page.
    expect(seen.length).toBe(afterLoad + 2);
    expect(seen.at(-1)).toEqual([{ id: 1, name: 'edited' }]);
  });

  it('ignores a key nobody has opened', () => {
    expect(() => publishShared('never-opened', () => [])).not.toThrow();
  });
});
