import type { Recipe } from '@checklist/shared';

/**
 * Brewer's Friend integration. The user's read-only API key is held server-side
 * (the BREWERS_FRIEND_API_KEY env var) and never exposed to the browser — the
 * API also can't be called from the browser directly (CORS), so the dashboard
 * goes through this proxy. See TODO.md "Integrate Brewer's Friend".
 */

const RECIPES_URL = 'https://api.brewersfriend.com/v1/recipes';

/** Thrown when no API key is configured, so the route can answer 503 distinctly. */
export class BrewersFriendNotConfiguredError extends Error {
  constructor() {
    super('Brewer\'s Friend is not configured (set BREWERS_FRIEND_API_KEY).');
    this.name = 'BrewersFriendNotConfiguredError';
  }
}

/** Whether a Brewer's Friend API key is configured. */
export function isConfigured(): boolean {
  return Boolean(process.env.BREWERS_FRIEND_API_KEY);
}

/** One recipe as returned by the Brewer's Friend API (only the fields we read). */
interface BrewersFriendRecipe {
  id: string | number;
  title?: string;
  stylename?: string;
  abv?: string | number;
  url?: string;
}

/**
 * Fetch the account's recipes and normalize them to {@link Recipe}. Throws
 * {@link BrewersFriendNotConfiguredError} when no key is set, or a generic Error
 * when the upstream request fails.
 */
export async function listRecipes(): Promise<Recipe[]> {
  const apiKey = process.env.BREWERS_FRIEND_API_KEY;
  if (!apiKey) throw new BrewersFriendNotConfiguredError();

  const res = await fetch(RECIPES_URL, { headers: { 'X-API-KEY': apiKey } });
  if (!res.ok) {
    throw new Error(`Brewer's Friend API returned ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as { recipes?: BrewersFriendRecipe[] };
  const recipes = Array.isArray(body.recipes) ? body.recipes : [];
  return recipes.map((r) => ({
    id: String(r.id),
    name: (r.title ?? '').trim() || 'Untitled recipe',
    style: (r.stylename ?? '').trim(),
    // Normalize to a bare number string and drop any "%" the API includes.
    abv: String(r.abv ?? '').trim().replace(/%/g, ''),
    // Public recipe page. The API hands back a "web." host that 404s in a
    // browser, so strip it; fall back to the standard view URL built from the id.
    url: ((r.url ?? '').trim() || `https://brewersfriend.com/homebrew/recipe/view/${r.id}`).replace(
      '://web.',
      '://',
    ),
  }));
}
