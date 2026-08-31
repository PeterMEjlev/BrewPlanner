import { DEFAULT_KEG_CONTENT_COLORS, type KegContentColors } from '@checklist/shared';
import { api } from './api';
import { createServerStore } from './serverStore';

const store = createServerStore({
  initial: DEFAULT_KEG_CONTENT_COLORS,
  load: api.getKegContentColors,
  persist: api.updateKegContentColors,
});

export function getKegContentColors(): KegContentColors {
  return store.getSnapshot();
}

export function useKegContentColors(): KegContentColors {
  return store.useValue();
}

export async function saveKegContentColors(next: KegContentColors): Promise<void> {
  await store.save(next);
}

export async function resetKegContentColors(): Promise<KegContentColors> {
  return store.reset();
}
