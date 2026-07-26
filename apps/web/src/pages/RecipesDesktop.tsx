import type { KegContentColors, Recipe } from '@checklist/shared';
import { getRecipeColor, matchContentOption } from '@checklist/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { canControl, useAuth } from '../auth';
import { ebcColor } from '../beerColor';
import { DashboardShell } from '../components/DashboardShell';
import { FermenterIcon } from '../components/icons';
import { useKegContentColors } from '../kegContentColors';
import { asCleanMessage } from '../util';

/** "West Coast IPA · 6.2%" — whichever of the two the recipe actually has. */
function describeRecipe(recipe: Recipe): string {
  const abv = recipe.abv ? `${recipe.abv}%` : '';
  return [recipe.style, abv].filter(Boolean).join(' · ') || 'No style set';
}

/**
 * The beer's colour swatch, from the shared keg palette (so an IPA looks the
 * same here as on its keg). Hollow when the style doesn't map to a known type.
 */
function StyleDot({
  color,
  label,
  className = 'h-2.5 w-2.5',
}: {
  color: string | null;
  /** The matched content type, for the tooltip. */
  label: string | null;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={`${className} shrink-0 rounded-full ${color ? '' : 'border border-zinc-600'}`}
      style={color ? { backgroundColor: color } : undefined}
      title={label ?? 'Unrecognised style'}
      aria-hidden
    />
  );
}

/**
 * Desktop Recipes — the brewery's Brewer's Friend account, browsable from the
 * sidebar. The list comes from the server (the API key stays server-side); each
 * card opens that recipe's full brew sheet at /recipes/:id, where the grain bill,
 * hop schedule, mash steps and water targets live, and where a recipe can be put
 * in the fermenter.
 *
 * Two colour systems meet on this page, deliberately: dots come from the
 * brewery's own style palette (the colour that style wears on the kegs and the
 * Overview), on the "In the fermenter" block and on every card alike, while a
 * card's left edge is the beer's physical colour computed from its EBC — which
 * is what a brewer reading a recipe expects to see, and what the detail page shows.
 */
export function RecipesDesktopPage(): JSX.Element {
  const { auth } = useAuth();
  // Clearing the fermenter's recipe is admin-only server-side (DELETE
  // /api/recipe), so a read-only guest gets the same list without the control.
  const controllable = canControl(auth);
  const colors = useKegContentColors();

  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [active, setActive] = useState<Recipe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [clearing, setClearing] = useState(false);

  /** Load (or reload) the list plus the current fermenter selection. */
  async function load(refresh = false): Promise<void> {
    if (refresh) setRefreshing(true);
    try {
      const [list, current] = await Promise.all([
        api.listRecipes(refresh),
        api.getActiveRecipe(),
      ]);
      setRecipes(list);
      setActive(current);
      setError(null);
    } catch (e) {
      // The list is the page — a failure here (no API key, upstream down)
      // leaves the empty state with the reason on it.
      setRecipes((prev) => prev ?? []);
      setError(asCleanMessage(e));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  /** Take the current beer out of the fermenter. */
  async function clearActive(): Promise<void> {
    if (clearing) return;
    setClearing(true);
    try {
      await api.clearActiveRecipe();
      setActive(null);
      setError(null);
    } catch (e) {
      setError(asCleanMessage(e));
    } finally {
      setClearing(false);
    }
  }

  // The active beer's palette colour + matched type, for the header dot/icon.
  const activeColor = active ? getRecipeColor(active, colors) : null;
  const activeMatch = active ? matchContentOption(active.name, active.style) : null;

  const filtered = useMemo(() => {
    if (!recipes) return [];
    const q = search.trim().toLowerCase();
    if (!q) return recipes;
    return recipes.filter(
      (r) => r.name.toLowerCase().includes(q) || r.style.toLowerCase().includes(q),
    );
  }, [recipes, search]);

  return (
    <DashboardShell active="recipes">
      <main className="w-full max-w-[1100px] px-5 py-5">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-zinc-50">Recipes</h1>
            <p className="mt-0.5 text-sm text-zinc-500">
              Your Brewer&rsquo;s Friend recipes. Open one for the full brew sheet, or set what
              is in the fermenter — that&rsquo;s the beer shown on the Overview and the kiosk.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {recipes != null && recipes.length > 0 && (
              <>
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search recipes…"
                  aria-label="Search recipes"
                  className="w-56 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-[#f87a68]"
                />
                <span className="hidden rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-400 sm:inline">
                  <span className="font-semibold text-zinc-100">{filtered.length}</span> recipe
                  {filtered.length === 1 ? '' : 's'}
                </span>
              </>
            )}
            {/* The server caches the list for a few minutes; this forces a
                re-read after editing a recipe on Brewer's Friend. */}
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={refreshing}
              title="Refresh from Brewer's Friend"
              aria-label="Refresh from Brewer's Friend"
              className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
            >
              {refreshing ? '…' : '↻'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* What's fermenting right now — set from a recipe's own page, shown here
            so the page answers "what's in the tank?" without a detour. */}
        <section className="mb-5 flex flex-wrap items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900 px-5 py-4">
          <FermenterIcon
            className="h-10 w-10 shrink-0 text-white"
            strokeWidth={2.6}
            style={activeColor ? { color: activeColor } : undefined}
          />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              In the fermenter
            </div>
            {active ? (
              <>
                <div className="flex items-center gap-2">
                  <StyleDot color={activeColor} label={activeMatch} />
                  <Link
                    to={`/recipes/${encodeURIComponent(active.id)}`}
                    className="truncate text-base font-semibold text-zinc-50 transition hover:text-[#f87a68]"
                  >
                    {active.name}
                  </Link>
                </div>
                <div className="truncate text-sm text-zinc-400">{describeRecipe(active)}</div>
              </>
            ) : (
              <div className="mt-0.5 text-sm text-zinc-500">
                {controllable
                  ? 'Nothing linked yet — open a recipe below and set it in the fermenter.'
                  : 'No recipe linked.'}
              </div>
            )}
          </div>
          {active?.url && (
            <a
              href={active.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100"
            >
              Open on Brewer&rsquo;s Friend ↗
            </a>
          )}
          {active && controllable && (
            <button
              type="button"
              onClick={() => void clearActive()}
              disabled={clearing}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
            >
              {clearing ? 'Clearing…' : 'Clear'}
            </button>
          )}
        </section>

        {recipes === null ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-400">
            Loading recipes…
          </div>
        ) : recipes.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-400">
            No recipes found in your Brewer&rsquo;s Friend account.
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-400">
            No recipes match “{search.trim()}”.
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((r) => (
              <li key={r.id}>
                <RecipeCard recipe={r} inFermenter={r.id === active?.id} colors={colors} />
              </li>
            ))}
          </ul>
        )}
      </main>
    </DashboardShell>
  );
}

/**
 * One recipe in the grid — a link to its brew sheet. The colour bar down the left
 * is the beer's own colour from its EBC, so the grid reads as a row of beers, while
 * the dot by the name is the style's colour from the keg palette, matching how that
 * beer looks on the keg boards. The one in the fermenter keeps the coral highlight.
 */
function RecipeCard({
  recipe,
  inFermenter,
  colors,
}: {
  recipe: Recipe;
  inFermenter: boolean;
  colors: KegContentColors;
}): JSX.Element {
  const color = ebcColor(recipe.ebc);
  const styleMatch = matchContentOption(recipe.name, recipe.style);
  return (
    <Link
      to={`/recipes/${encodeURIComponent(recipe.id)}`}
      style={color ? { borderLeftColor: color, borderLeftWidth: 3 } : undefined}
      className={`flex h-full flex-col gap-1 rounded-xl border px-4 py-3.5 transition ${
        inFermenter
          ? 'border-[#f87a68] bg-gradient-to-br from-[#f87a68]/25 to-[#e0463f]/25'
          : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700 hover:bg-zinc-800/60'
      }`}
    >
      <span className="flex w-full items-center gap-2">
        <StyleDot color={getRecipeColor(recipe, colors)} label={styleMatch} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">
          {recipe.name}
        </span>
      </span>
      <span className="w-full truncate pl-[18px] text-xs text-zinc-500">
        {describeRecipe(recipe)}
        {recipe.ibu && ` · ${recipe.ibu} IBU`}
      </span>
      <span className="mt-auto pl-[18px] pt-2 text-xs font-semibold text-[#f87a68]">
        {inFermenter ? '✓ In the fermenter' : ' '}
      </span>
    </Link>
  );
}
