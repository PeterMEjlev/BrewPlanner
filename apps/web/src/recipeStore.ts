import type { Recipe, RecipeDetail, RecipeStatsResponse } from '@checklist/shared';
import { api } from './api';

/**
 * Session-lived cache for everything that comes out of Brewer's Friend.
 *
 * The server proxies an upstream that is slow enough to feel — half a second or
 * so — and none of it changes while the dashboard is open, so paying that cost
 * again every time the brewer opens a recipe and comes back is pure waste. Each
 * fetch is kept for as long as the tab lives; the Recipes page's refresh button
 * is what clears it.
 *
 * Promises are cached rather than values, so two components asking at once share
 * one request. A rejected promise is dropped from the cache, so a failure is
 * retried on the next ask instead of being remembered as "no recipes".
 */

let recipesPromise: Promise<Recipe[]> | null = null;
let statsPromise: Promise<RecipeStatsResponse> | null = null;
const detailPromises = new Map<string, Promise<RecipeDetail>>();

/** Cache a promise, forgetting it again if it rejects. */
function keep<T>(promise: Promise<T>, forget: () => void): Promise<T> {
  return promise.catch((err) => {
    forget();
    throw err;
  });
}

/** The account's recipe list. `force` re-reads it (and drops the cached copy). */
export function loadRecipes(force = false): Promise<Recipe[]> {
  if (force || !recipesPromise) {
    recipesPromise = keep(api.listRecipes(force), () => {
      recipesPromise = null;
    });
  }
  return recipesPromise;
}

/**
 * One recipe's full brew sheet. Cached per id, so flipping between recipes is
 * instant after the first visit.
 */
export function loadRecipeDetail(id: string, force = false): Promise<RecipeDetail> {
  const cached = detailPromises.get(id);
  if (!force && cached) return cached;
  const promise = keep(api.getRecipe(id), () => detailPromises.delete(id));
  detailPromises.set(id, promise);
  return promise;
}

/** Per-recipe cost and hop rate, for the grid's price and hops/L sorts. */
export function loadRecipeStats(force = false): Promise<RecipeStatsResponse> {
  if (force || !statsPromise) {
    statsPromise = keep(api.listRecipeStats(force), () => {
      statsPromise = null;
    });
  }
  return statsPromise;
}

/**
 * Drop everything, so the next read goes upstream. Used by the refresh button:
 * a brewer who has just edited a recipe on Brewer's Friend means the whole set,
 * brew sheets included, not only the list.
 */
export function invalidateRecipes(): void {
  recipesPromise = null;
  statsPromise = null;
  detailPromises.clear();
}
