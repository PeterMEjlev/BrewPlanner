import { DEFAULT_RECIPE_DEFAULTS, type RecipeDefaults } from '@checklist/shared';
import { api } from './api';
import { createServerStore } from './serverStore';

/**
 * The figures a blank brew sheet opens on, held once for the whole app and
 * fetched the first time something asks. Server-shared (unlike the display
 * preferences in settings.ts): they describe the brewhouse, so the kiosk, a
 * laptop and the phone all start a new recipe on the same numbers.
 *
 * Falls back to the brewery's own defaults whenever the server can't be
 * reached — a new recipe still opens on real numbers rather than on blanks.
 */

const store = createServerStore({
  initial: DEFAULT_RECIPE_DEFAULTS,
  load: api.getRecipeDefaults,
  persist: api.updateRecipeDefaults,
});

export function getRecipeDefaults(): RecipeDefaults {
  return store.getSnapshot();
}

export function useRecipeDefaults(): RecipeDefaults {
  return store.useValue();
}

export async function saveRecipeDefaults(next: RecipeDefaults): Promise<void> {
  await store.save(next);
}

export async function resetRecipeDefaults(): Promise<RecipeDefaults> {
  return store.reset();
}
