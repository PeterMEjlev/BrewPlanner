import type { RecipeImportResult } from '@checklist/shared';
import * as bf from './brewersfriend.js';
import { importBrewersFriendRecipe } from './recipeRepo.js';
import { getSetting, setSetting } from './repo.js';

const IMPORT_COMPLETE_KEY = 'brewers_friend_recipe_import_v1';
let inFlight: Promise<RecipeImportResult> | null = null;

/**
 * One-way import. Existing recipe ids are never overwritten, so a retry can add
 * newly discovered legacy recipes without undoing anything edited in the app.
 */
export async function importFromBrewersFriend(): Promise<RecipeImportResult> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const upstream = await bf.readRecipesForImport();
    let imported = 0;
    let skipped = 0;
    for (const recipe of upstream) {
      if (importBrewersFriendRecipe(recipe)) imported += 1;
      else skipped += 1;
    }
    setSetting(IMPORT_COMPLETE_KEY, new Date().toISOString());
    return { imported, skipped };
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Run the legacy import once, when an API key is available. */
export async function ensureInitialRecipeImport(): Promise<RecipeImportResult | null> {
  if (getSetting(IMPORT_COMPLETE_KEY) || !bf.isConfigured()) return null;
  return importFromBrewersFriend();
}
