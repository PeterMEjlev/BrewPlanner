import { DEFAULT_RECIPE_DEFAULTS, type RecipeDefaults } from '@checklist/shared';
import { useSyncExternalStore } from 'react';
import { api } from './api';

/**
 * The figures a blank brew sheet opens on, held once for the whole app and
 * fetched the first time something asks. Server-shared (unlike the display
 * preferences in settings.ts): they describe the brewhouse, so the kiosk, a
 * laptop and the phone all start a new recipe on the same numbers.
 *
 * Falls back to the brewery's own defaults whenever the server can't be
 * reached — a new recipe still opens on real numbers rather than on blanks.
 */

let cache: RecipeDefaults = DEFAULT_RECIPE_DEFAULTS;
let hydrated = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  api
    .getRecipeDefaults()
    .then((defaults) => {
      cache = defaults;
      emit();
    })
    .catch(() => {
      // No server / not reachable — keep the brewery's own numbers.
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  hydrate();
  return () => {
    listeners.delete(listener);
  };
}

export function getRecipeDefaults(): RecipeDefaults {
  return cache;
}

export function useRecipeDefaults(): RecipeDefaults {
  return useSyncExternalStore(subscribe, getRecipeDefaults, getRecipeDefaults);
}

export async function saveRecipeDefaults(next: RecipeDefaults): Promise<void> {
  cache = next;
  emit();
  await api.updateRecipeDefaults(next);
}

export async function resetRecipeDefaults(): Promise<RecipeDefaults> {
  await saveRecipeDefaults(DEFAULT_RECIPE_DEFAULTS);
  return DEFAULT_RECIPE_DEFAULTS;
}
