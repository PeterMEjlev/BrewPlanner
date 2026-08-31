import { describe, expect, it, vi } from 'vitest';
import { createServerStore } from './serverStore';

describe('createServerStore', () => {
  it('hydrates once on first subscription and notifies subscribers', async () => {
    const load = vi.fn(async () => ({ value: 2 }));
    const store = createServerStore({
      initial: { value: 1 },
      load,
      persist: vi.fn(async () => undefined),
    });
    const listener = vi.fn();

    const unsubscribe = store.subscribe(listener);
    const unsubscribeSecond = store.subscribe(vi.fn());
    await vi.waitFor(() => expect(store.getSnapshot()).toEqual({ value: 2 }));

    expect(load).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    unsubscribeSecond();
  });

  it('keeps defaults after a failed load and saves optimistically', async () => {
    const persist = vi.fn(async () => undefined);
    const store = createServerStore({
      initial: 'default',
      load: vi.fn(async () => { throw new Error('offline'); }),
      persist,
    });
    const listener = vi.fn();
    store.subscribe(listener);
    await Promise.resolve();

    expect(store.getSnapshot()).toBe('default');
    await store.save('next');
    expect(store.getSnapshot()).toBe('next');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('next');
    await store.reset();
    expect(store.getSnapshot()).toBe('default');
  });
});
