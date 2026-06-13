import type { Recipe } from '@checklist/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';

/**
 * Touch-first recipe picker for the Pi. Reached by tapping the top of the
 * fermenter card. Lists the recipes from the user's Brewer's Friend account
 * (fetched server-side) and lets the operator pick the one currently in the
 * fermenter; the choice sets the beer style shown on the kiosk fermenter card.
 */
export function RecipesPage(): JSX.Element {
  const navigate = useNavigate();
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [list, active] = await Promise.all([api.listRecipes(), api.getActiveRecipe()]);
        if (cancelled) return;
        setRecipes(list);
        setActiveId(active?.id ?? null);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load recipes');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Persist the choice (or clear it) and return to the home screen. */
  async function choose(recipe: Recipe | null): Promise<void> {
    if (saving) return;
    setSaving(true);
    try {
      if (recipe) await api.setActiveRecipe(recipe);
      else await api.clearActiveRecipe();
      navigate('/kiosk');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save selection');
      setSaving(false);
    }
  }

  return (
    <div className="touch-none-select flex h-full flex-col bg-black text-white">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-6 py-4">
        <Link
          to="/kiosk"
          className="shrink-0 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-2xl leading-none transition active:bg-zinc-800"
          aria-label="Home"
        >
          ⌂
        </Link>
        <h1 className="py-1 text-3xl font-bold leading-normal tracking-tight">Select Recipe</h1>
      </header>

      {error && (
        <div className="bg-red-900/40 px-6 py-2 text-center text-lg text-red-300">{error}</div>
      )}

      <main className="flex-1 overflow-y-auto p-4 sm:p-6">
        {recipes === null && !error ? (
          <p className="mt-10 text-center text-2xl text-zinc-400">Loading recipes…</p>
        ) : recipes && recipes.length === 0 ? (
          <p className="mt-10 text-center text-2xl text-zinc-400">
            No recipes found in your Brewer's Friend account.
          </p>
        ) : recipes ? (
          <ul className="flex flex-col gap-3">
            {/* Deselect option, so a finished brew can clear the style. */}
            <li>
              <RecipeRow
                title="None"
                subtitle="Clear the selected recipe"
                selected={activeId === null}
                disabled={saving}
                onSelect={() => void choose(null)}
              />
            </li>
            {recipes.map((r) => (
              <li key={r.id}>
                <RecipeRow
                  title={r.name}
                  subtitle={r.style || 'No style set'}
                  selected={r.id === activeId}
                  disabled={saving}
                  onSelect={() => void choose(r)}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </main>
    </div>
  );
}

/** A single tappable recipe row: name + style, with a check when it's active. */
function RecipeRow({
  title,
  subtitle,
  selected,
  disabled,
  onSelect,
}: {
  title: string;
  subtitle: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={`flex w-full touch-manipulation items-center gap-4 rounded-2xl border px-5 py-5 text-left transition active:scale-[0.99] disabled:opacity-60 ${
        selected
          ? 'border-emerald-500/60 bg-emerald-600/15'
          : 'border-zinc-800 bg-zinc-950 active:bg-zinc-800'
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-2xl font-semibold leading-tight">{title}</span>
        <span className="mt-0.5 block truncate text-base text-zinc-400">{subtitle}</span>
      </span>
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xl ${
          selected ? 'bg-emerald-500 text-white' : 'text-transparent'
        }`}
        aria-hidden
      >
        ✓
      </span>
    </button>
  );
}
