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
 *
 * The cache is stale-while-revalidate: {@link revalidateRecipes} re-reads
 * upstream in the background and reports back only what actually changed, so a
 * recipe edited on Brewer's Friend shows up without the brewer having to think
 * about refreshing, and without a page that already has the answer waiting.
 */

let recipesPromise: Promise<Recipe[]> | null = null;
let statsPromise: Promise<RecipeStatsResponse> | null = null;
const detailPromises = new Map<string, Promise<RecipeDetail>>();

/** When each was last read from upstream, for the revalidation throttle. */
let recipesCheckedAt = 0;
let statsCheckedAt = 0;

/**
 * How long a background check waits before it's worth making again. Brewer's
 * Friend rate-limits an account that walks its pages too often, and a brewer
 * bouncing between the grid and a brew sheet would otherwise re-read the whole
 * account on every trip. The refresh button ignores this — an explicit ask is
 * always honoured immediately.
 */
const REVALIDATE_AFTER_MS = 60_000;

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
 * Re-read the account in the background and report only what changed.
 *
 * Both reads are forced past the *server's* cache, which is the point: an
 * unforced read would be answered from the server's own copy and could never
 * notice a recipe edited upstream. Failures are swallowed — a background check
 * that can't reach Brewer's Friend leaves the cached data on screen rather than
 * replacing a working page with an error.
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
 * Drop everything, so the next read goes upstream. Used by the refresh button:
 * a brewer who has just edited a recipe on Brewer's Friend means the whole set,
 * brew sheets included, not only the list.
 */
export function invalidateRecipes(): void {
  recipesPromise = null;
  statsPromise = null;
  recipesCheckedAt = 0;
  statsCheckedAt = 0;
  detailPromises.clear();
}
