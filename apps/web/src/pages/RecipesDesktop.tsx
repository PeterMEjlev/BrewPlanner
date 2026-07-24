import type { Recipe } from '@checklist/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { canControl, useAuth } from '../auth';
import { DashboardShell } from '../components/DashboardShell';
import { FermenterIcon } from '../components/icons';
import { asMessage } from '../util';

/** Sentinel for the page's `saving` id while the choice is being cleared. */
const CLEARING = '\0clear';

/** Strip the leading "<status>: " our api client prefixes onto error messages. */
function cleanError(err: unknown): string {
  return asMessage(err).replace(/^\d{3}:\s*/, '');
}

/** "West Coast IPA · 6.2%" — whichever of the two the recipe actually has. */
function describeRecipe(recipe: Recipe): string {
  const abv = recipe.abv ? `${recipe.abv}%` : '';
  return [recipe.style, abv].filter(Boolean).join(' · ') || 'No style set';
}

/**
 * Desktop Recipes — the mouse-and-keyboard counterpart to the kiosk's touch
 * recipe picker ([Recipes.tsx]). The Overview's fermenter card links here to set
 * (or change) the beer currently fermenting; the list comes from the user's
 * Brewer's Friend account, proxied by the server so the API key stays
 * server-side.
 *
 * Unlike the kiosk — which picks a recipe and bounces straight back to the home
 * screen, because a touchscreen operator only ever wants the one tap — this page
 * stays put: it's browsable (search, a link out to each recipe's Brewer's Friend
 * page), so the choice lands in place and the user leaves when they're done.
 */
export function RecipesDesktopPage(): JSX.Element {
  const { auth } = useAuth();
  // Setting the fermenter's recipe is admin-only server-side (PUT/DELETE
  // /api/recipe), so a read-only guest gets the same list without the controls.
  const controllable = canControl(auth);

  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [active, setActive] = useState<Recipe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // The recipe id being written (or CLEARING), so only that card goes busy.
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [list, current] = await Promise.all([api.listRecipes(), api.getActiveRecipe()]);
        if (cancelled) return;
        setRecipes(list);
        setActive(current);
        setError(null);
      } catch (e) {
        // The list is the page — a failure here (no API key, upstream down)
        // leaves the empty state with the reason on it.
        if (!cancelled) {
          setRecipes([]);
          setError(cleanError(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Persist the fermenter's recipe (or clear it) and reflect it in place. */
  async function choose(recipe: Recipe | null): Promise<void> {
    if (saving) return;
    setSaving(recipe?.id ?? CLEARING);
    try {
      if (recipe) setActive(await api.setActiveRecipe(recipe));
      else {
        await api.clearActiveRecipe();
        setActive(null);
      }
      setError(null);
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setSaving(null);
    }
  }

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
              Your Brewer&rsquo;s Friend recipes. Pick the one in the fermenter — it sets the
              beer shown on the Overview and the kiosk.
            </p>
          </div>
          {recipes != null && recipes.length > 0 && (
            <div className="flex items-center gap-3">
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
            </div>
          )}
        </div>

        {error && (
          <div className="mb-5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* What's fermenting right now — the reason this page exists, so it sits
            above the list rather than being inferred from a highlighted card. */}
        <section className="mb-5 flex flex-wrap items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900 px-5 py-4">
          <FermenterIcon className="h-10 w-10 shrink-0 text-white" strokeWidth={2.6} />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              In the fermenter
            </div>
            {active ? (
              <>
                <div className="truncate text-base font-semibold text-zinc-50">{active.name}</div>
                <div className="truncate text-sm text-zinc-400">{describeRecipe(active)}</div>
              </>
            ) : (
              <div className="mt-0.5 text-sm text-zinc-500">
                {controllable ? 'Nothing linked yet — pick a recipe below.' : 'No recipe linked.'}
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
              onClick={() => void choose(null)}
              disabled={saving != null}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
            >
              {saving === CLEARING ? 'Clearing…' : 'Clear'}
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
                <RecipeCard
                  recipe={r}
                  selected={r.id === active?.id}
                  selectable={controllable}
                  busy={saving === r.id}
                  disabled={saving != null}
                  onSelect={() => void choose(r)}
                />
              </li>
            ))}
          </ul>
        )}
      </main>
    </DashboardShell>
  );
}

/**
 * One recipe in the grid. The whole card selects it; the Brewer's Friend link is
 * a sibling pinned to the corner rather than a child, since a link nested in a
 * button is invalid markup (and would swallow the click).
 */
function RecipeCard({
  recipe,
  selected,
  selectable,
  busy,
  disabled,
  onSelect,
}: {
  recipe: Recipe;
  selected: boolean;
  /** False for read-only guests: the card renders, but picking is off. */
  selectable: boolean;
  busy: boolean;
  disabled: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <div className="relative h-full">
      <button
        type="button"
        onClick={onSelect}
        disabled={!selectable || disabled}
        aria-pressed={selected}
        className={`flex h-full w-full flex-col items-start gap-1 rounded-xl border px-4 py-3.5 pr-12 text-left transition disabled:cursor-default ${
          selected
            ? 'border-[#f87a68]/60 bg-[#f87a68]/10'
            : 'border-zinc-800 bg-zinc-900 enabled:hover:border-zinc-700 enabled:hover:bg-zinc-800/60'
        } ${disabled && !busy ? 'opacity-60' : ''}`}
      >
        <span className="w-full truncate text-sm font-semibold text-zinc-100">{recipe.name}</span>
        <span className="w-full truncate text-xs text-zinc-500">{describeRecipe(recipe)}</span>
        <span className="mt-auto pt-2 text-xs font-semibold text-[#f87a68]">
          {busy ? 'Saving…' : selected ? '✓ In the fermenter' : ' '}
        </span>
      </button>
      {recipe.url && (
        <a
          href={recipe.url}
          target="_blank"
          rel="noopener noreferrer"
          title="Open on Brewer's Friend"
          aria-label={`Open ${recipe.name} on Brewer's Friend`}
          className="absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100"
        >
          ↗
        </a>
      )}
    </div>
  );
}
