import { DEFAULT_KEG_CONTENT_COLORS, type KegContentColors } from '@checklist/shared';
import { useSyncExternalStore } from 'react';
import { api } from './api';

let cache: KegContentColors = DEFAULT_KEG_CONTENT_COLORS;
let hydrated = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  api
    .getKegContentColors()
    .then((colors) => {
      cache = colors;
      emit();
    })
    .catch(() => {
      // No server / not reachable - keep the default palette.
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  hydrate();
  return () => {
    listeners.delete(listener);
  };
}

export function getKegContentColors(): KegContentColors {
  return cache;
}

export function useKegContentColors(): KegContentColors {
  return useSyncExternalStore(subscribe, getKegContentColors, getKegContentColors);
}

export async function saveKegContentColors(next: KegContentColors): Promise<void> {
  cache = next;
  emit();
  await api.updateKegContentColors(next);
}

export async function resetKegContentColors(): Promise<KegContentColors> {
  await saveKegContentColors(DEFAULT_KEG_CONTENT_COLORS);
  return DEFAULT_KEG_CONTENT_COLORS;
}
