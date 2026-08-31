import { useSyncExternalStore } from 'react';

interface ServerStoreOptions<T> {
  initial: T;
  load: () => Promise<T>;
  persist: (value: T) => Promise<unknown>;
}

/** Lazy, optimistic external store for preferences shared through the server. */
export function createServerStore<T>({ initial, load, persist }: ServerStoreOptions<T>) {
  let cache = initial;
  let hydrated = false;
  const listeners = new Set<() => void>();

  const getSnapshot = (): T => cache;
  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  const hydrate = (): void => {
    if (hydrated) return;
    hydrated = true;
    load()
      .then((value) => {
        cache = value;
        emit();
      })
      .catch(() => {
        // A disconnected client remains usable with its local defaults.
      });
  };
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    hydrate();
    return () => listeners.delete(listener);
  };
  const useValue = (): T => useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const save = async (next: T): Promise<void> => {
    cache = next;
    emit();
    await persist(next);
  };
  const reset = async (): Promise<T> => {
    await save(initial);
    return initial;
  };

  return { getSnapshot, reset, save, subscribe, useValue };
}
