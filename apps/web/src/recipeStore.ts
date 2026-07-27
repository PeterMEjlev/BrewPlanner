import type { Recipe, RecipeDetail, RecipeStatsResponse } from '@checklist/shared';
import { api } from './api';

/**
 * Session-lived cache for BrewPlanner's database-backed recipe library.
 *
 * Each fetch is kept for as long as the tab lives, so returning from a brew
 * sheet does not redraw and reprice the same data. The Recipes page's reload
 * button clears it.
 *
 * Promises are cached rather than values, so two components asking at once share
 * one request. A rejected promise is dropped from the cache, so a failure is
 * retried on the next ask instead of being remembered as "no recipes".
 *
 * The cache is stale-while-revalidate: {@link revalidateRecipes} re-reads the
 * shared server library in the background and reports only what changed, so an
 * edit from another client appears without delaying the cached first paint.
 */

let recipesPromise: Promise<Recipe[]> | null = null;
let statsPromise: Promise<RecipeStatsResponse> | null = null;
const detailPromises = new Map<string, Promise<RecipeDetail>>();

/** When each was last read from the server, for the revalidation throttle. */
let recipesCheckedAt = 0;
let statsCheckedAt = 0;

/**
 * How long a background check waits before it is worth making again. A brewer
 * bouncing between the grid and a brew sheet should not re-read the whole
 * library on every trip. The reload button ignores this throttle.
 */
const REVALIDATE_AFTER_MS = 60_000;

/** Cache a promise, forgetting it again if it rejects. */
function keep<T>(promise: Promise<T>, forget: () => void): Promise<T> {
  return promise.catch((err) => {
    forget();
    throw err;
  });
}

/** The app's recipe list. `force` re-reads it (and drops the cached copy). */
export function loadRecipes(force = false): Promise<Recipe[]> {
  if (force || !recipesPromise) {
    recipesCheckedAt = Date.now();
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
    statsCheckedAt = Date.now();
    statsPromise = keep(api.listRecipeStats(force), () => {
      statsPromise = null;
    });
  }
  return statsPromise;
}

/** What a background check found. A null field means "no change" — don't redraw. */
export interface RecipeRevalidation {
  recipes: Recipe[] | null;
  stats: RecipeStatsResponse | null;
}

/**
 * Re-read the library in the background and report only what changed. Failures
 * are swallowed so a transient server error leaves the cached data on screen.
 *
 * Does nothing until there's something cached to compare against; the first
 * visit is already reading fresh data through {@link loadRecipes}.
 */
export async function revalidateRecipes(): Promise<RecipeRevalidation> {
  const [recipes, stats] = await Promise.all([revalidateList(), revalidateStats()]);
  return { recipes, stats };
}

async function revalidateList(): Promise<Recipe[] | null> {
  const cached = recipesPromise;
  if (!cached || Date.now() - recipesCheckedAt < REVALIDATE_AFTER_MS) return null;
  recipesCheckedAt = Date.now();
  try {
    const [previous, fresh] = [await cached, await api.listRecipes(true)];
    recipesPromise = Promise.resolve(fresh);
    if (sameJson(previous, fresh)) return null;
    // A recipe whose list entry moved has a stale brew sheet cached too.
    dropChangedDetails(previous, fresh);
    return fresh;
  } catch {
    return null;
  }
}

async function revalidateStats(): Promise<RecipeStatsResponse | null> {
  const cached = statsPromise;
  if (!cached || Date.now() - statsCheckedAt < REVALIDATE_AFTER_MS) return null;
  statsCheckedAt = Date.now();
  try {
    const [previous, fresh] = [await cached, await api.listRecipeStats(true)];
    statsPromise = Promise.resolve(fresh);
    return sameJson(previous.stats, fresh.stats) ? null : fresh;
  } catch {
    return null;
  }
}

/**
 * Forget the cached brew sheet of every recipe whose list entry changed, so
 * opening it reads the edit rather than what it looked like an hour ago.
 */
function dropChangedDetails(previous: Recipe[], fresh: Recipe[]): void {
  const before = new Map(previous.map((r) => [r.id, JSON.stringify(r)]));
  for (const recipe of fresh) {
    if (before.get(recipe.id) !== JSON.stringify(recipe)) detailPromises.delete(recipe.id);
  }
}

/**
 * Field-for-field equality. The server builds these objects the same way every
 * time, so key order is stable and serialising is a fair comparison.
 */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Drop everything, so the next read comes from the server. This includes cached
 * brew sheets as well as the list and derived stats.
 */
export function invalidateRecipes(): void {
  recipesPromise = null;
  statsPromise = null;
  recipesCheckedAt = 0;
  statsCheckedAt = 0;
  detailPromises.clear();
}
