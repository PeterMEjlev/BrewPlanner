import type { KegContentColors, Recipe } from '@checklist/shared';
import {
  RECIPE_STYLE_CATEGORIES,
  ebcColor,
  getRecipeColor,
  matchContentOption,
  styleCategory,
} from '@checklist/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { canControl, useAuth } from '../auth';
import { DashboardShell } from '../components/DashboardShell';
import { FermenterIcon } from '../components/icons';
import { useKegContentColors } from '../kegContentColors';
import { invalidateRecipes, loadRecipeStats, loadRecipes } from '../recipeStore';
import { asCleanMessage } from '../util';

/**
 * A bare number string from the API as a fixed-decimal string, or null when the
 * field is empty or not a number — the API hands back full float precision
 * ("5.64756"), which is noise on a card.
 */
function num(value: string | number | null | undefined, decimals: number): string | null {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n.toFixed(decimals) : null;
}

/** The same value as a number, for sorting; null when the field is empty. */
function numeric(value: string | number | null | undefined): number | null {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : null;
}

/** "West Coast IPA · 6.2%" — whichever of the two the recipe actually has. */
function describeRecipe(recipe: Recipe): string {
  const abv = num(recipe.abv, 1);
  return [recipe.style, abv && `${abv}%`].filter(Boolean).join(' · ') || 'No style set';
}

/** What the grid can be ordered by, in the order the picker lists them. */
type SortKey = 'name' | 'created' | 'type' | 'ebc' | 'ibu' | 'abv' | 'hopsPerL' | 'price';

const SORT_LABELS: Record<SortKey, string> = {
  name: 'Name',
  created: 'Date created',
  type: 'Type',
  ebc: 'Colour (EBC)',
  ibu: 'IBU',
  abv: 'ABV',
  hopsPerL: 'Hops / L',
  price: 'Price',
};

/** Ascending reads differently per key, so each says what its arrow means. */
const SORT_DIRECTION_LABELS: Record<SortKey, { asc: string; desc: string }> = {
  name: { asc: 'A → Z', desc: 'Z → A' },
  created: { asc: 'Oldest first', desc: 'Newest first' },
  type: { asc: 'Pale → dark', desc: 'Dark → pale' },
  ebc: { asc: 'Light → dark', desc: 'Dark → light' },
  ibu: { asc: 'Low → high', desc: 'High → low' },
  abv: { asc: 'Weak → strong', desc: 'Strong → weak' },
  hopsPerL: { asc: 'Low → high', desc: 'High → low' },
  price: { asc: 'Cheap → dear', desc: 'Dear → cheap' },
};

/** The two sorts that need the extra per-recipe fetch to mean anything. */
const STATS_SORTS: SortKey[] = ['price', 'hopsPerL'];

/**
 * Which way round each key is worth reading first. Newest recipes are what a
 * brewer wants to see when sorting by date; everything else reads naturally
 * ascending. Applied on picking a key, and freely flipped afterwards.
 */
const SORT_DEFAULT_DIRECTION: Record<SortKey, 'asc' | 'desc'> = {
  name: 'asc',
  created: 'desc',
  type: 'asc',
  ebc: 'asc',
  ibu: 'asc',
  abv: 'asc',
  hopsPerL: 'asc',
  price: 'asc',
};

interface SortOrder {
  key: SortKey;
  dir: 'asc' | 'desc';
}

/** Newest first — what a brewer wants to see on opening the page. */
const DEFAULT_ORDER: SortOrder = { key: 'created', dir: 'desc' };

const ORDER_KEY = 'brewplanner.recipeSort';

/**
 * The order the grid was last left in. Persisted rather than held in state
 * because opening a recipe unmounts this page — and a preference that survives a
 * reload is no worse for it.
 */
function loadOrder(): SortOrder {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (!raw) return DEFAULT_ORDER;
    const saved = JSON.parse(raw) as Partial<SortOrder>;
    // A key from a build that has since renamed or dropped it falls back rather
    // than leaving the grid with no comparator at all.
    if (!saved.key || !(saved.key in SORT_LABELS)) return DEFAULT_ORDER;
    return { key: saved.key, dir: saved.dir === 'desc' ? 'desc' : 'asc' };
  } catch {
    return DEFAULT_ORDER;
  }
}

function saveOrder(order: SortOrder): SortOrder {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    // Per-browser convenience only.
  }
  return order;
}

/** What a recipe's ingredients say about it, once the stats pass has run. */
interface Stats {
  usedDkk: number | null;
  hopsPerL: number | null;
  /** Predicted pour colour where fruit shifted it; null leaves the malt colour. */
  fruitColor: string | null;
  fruitNote: string | null;
}

/**
 * Creation date as a timestamp. Brewer's Friend writes "2026-03-14 09:12:00",
 * which Safari won't parse as-is, so the space becomes a T before it's read.
 */
function createdTime(recipe: Recipe): number | null {
  const raw = (recipe.createdAt ?? '').trim();
  if (raw === '') return null;
  const t = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

/**
 * Order the grid. Whatever the key and direction, a recipe the value is unknown
 * for (no EBC, no IBU, no date, nothing priceable) sinks to the bottom rather
 * than riding to the top on a reversal, and ties fall back to the name so the
 * grid never reshuffles between renders.
 */
function sortRecipes(
  recipes: Recipe[],
  key: SortKey,
  dir: 'asc' | 'desc',
  stats: Map<string, Stats> | null,
): Recipe[] {
  const sign = dir === 'asc' ? 1 : -1;
  const byName = (a: Recipe, b: Recipe): number =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

  const byNumber =
    (pick: (r: Recipe) => number | null) =>
    (a: Recipe, b: Recipe): number => {
      const x = pick(a);
      const y = pick(b);
      if (x == null || y == null) {
        if (x == null && y == null) return byName(a, b);
        return x == null ? 1 : -1;
      }
      return x === y ? byName(a, b) : (x - y) * sign;
    };

  const comparators: Record<SortKey, (a: Recipe, b: Recipe) => number> = {
    name: (a, b) => byName(a, b) * sign,
    created: byNumber(createdTime),
    type: (a, b) => {
      // Family first, then the specific style inside it — "IPA" groups
      // American/New England/Imperial together, alphabetically within.
      const family =
        RECIPE_STYLE_CATEGORIES.indexOf(styleCategory(a)) -
        RECIPE_STYLE_CATEGORIES.indexOf(styleCategory(b));
      if (family !== 0) return family * sign;
      const style = a.style.localeCompare(b.style, undefined, { sensitivity: 'base' });
      return (style !== 0 ? style : byName(a, b)) * sign;
    },
    ebc: byNumber((r) => numeric(r.ebc)),
    ibu: byNumber((r) => numeric(r.ibu)),
    abv: byNumber((r) => numeric(r.abv)),
    hopsPerL: byNumber((r) => stats?.get(r.id)?.hopsPerL ?? null),
    price: byNumber((r) => stats?.get(r.id)?.usedDkk ?? null),
  };

  return [...recipes].sort(comparators[key]);
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
  // Restored from the last visit, so opening a recipe and coming back finds the
  // grid in the order it was left in.
  const [{ key: sort, dir }, setOrder] = useState<SortOrder>(loadOrder);
  // Recipe id → cost and hop rate. Null until a sort that needs them asks:
  // working these out means pulling every recipe's ingredient list upstream.
  const [stats, setStats] = useState<Map<string, Stats> | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);

  /**
   * Load (or reload) the list plus the current fermenter selection. The list
   * comes from the session cache, so returning from a recipe is instant; a
   * refresh drops that cache first, brew sheets included.
   */
  async function load(refresh = false): Promise<void> {
    if (refresh) {
      setRefreshing(true);
      invalidateRecipes();
    }
    try {
      const [list, current] = await Promise.all([
        loadRecipes(refresh),
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

  /**
   * Cost and weigh the whole account, once, the first time a sort needs it.
   * Until it lands every recipe reads as unknown, so the grid stays in a stable
   * order and simply re-sorts when the numbers arrive.
   */
  async function loadStats(refresh = false): Promise<void> {
    if (statsLoading) return;
    setStatsLoading(true);
    try {
      const { stats: list } = await loadRecipeStats(refresh);
      setStats(
        new Map(
          list.map((s) => [
            s.id,
            {
              usedDkk: s.usedDkk,
              hopsPerL: s.hopsPerL,
              fruitColor: s.fruitColor,
              fruitNote: s.fruitNote,
            },
          ]),
        ),
      );
      setStatsError(null);
    } catch (e) {
      // An empty map, not null, so a failed pass isn't retried on every render.
      setStats((prev) => prev ?? new Map());
      setStatsError(asCleanMessage(e));
    } finally {
      setStatsLoading(false);
    }
  }

  // The cards' fruit colours come from the same pass as the price and hop-rate
  // sorts, so it's fetched on every visit rather than only when those sorts are
  // picked. It doesn't block the grid — cards draw their malt colour first and
  // the fruited ones re-tint when it lands — and both caches make repeat visits
  // free.
  useEffect(() => {
    if (stats === null) void loadStats();
  }, [stats]);

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

  const sorted = useMemo(
    () => sortRecipes(filtered, sort, dir, stats),
    [filtered, sort, dir, stats],
  );

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
          {/* Search, sort and refresh; wraps rather than overflowing once the
              sort picker joins them on a narrow window. */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {recipes != null && recipes.length > 0 && (
              <>
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search recipes…"
                  aria-label="Search recipes"
                  className="w-48 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-[#f87a68]"
                />
                {/* Sort key + direction. Price is the one that costs an extra
                    round trip, so it's fetched on selection, not on load. */}
                <select
                  value={sort}
                  onChange={(e) => {
                    const key = e.target.value as SortKey;
                    setOrder(saveOrder({ key, dir: SORT_DEFAULT_DIRECTION[key] }));
                  }}
                  aria-label="Sort recipes by"
                  className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-[#f87a68]"
                >
                  {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                    <option key={key} value={key}>
                      Sort: {SORT_LABELS[key]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() =>
                    setOrder(saveOrder({ key: sort, dir: dir === 'asc' ? 'desc' : 'asc' }))
                  }
                  title={`Sorted ${SORT_DIRECTION_LABELS[sort][dir]}`}
                  aria-label={`Sorted ${SORT_DIRECTION_LABELS[sort][dir]}. Reverse the order.`}
                  className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100"
                >
                  {dir === 'asc' ? '↑' : '↓'}
                </button>
                <span className="hidden rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-400 sm:inline">
                  <span className="font-semibold text-zinc-100">{filtered.length}</span> recipe
                  {filtered.length === 1 ? '' : 's'}
                </span>
              </>
            )}
            {/* The server caches the list for a few minutes; this forces a
                re-read after editing a recipe on Brewer's Friend. Prices are
                cached separately and only re-read once they're on the page. */}
            <button
              type="button"
              onClick={() => {
                void load(true);
                if (stats) void loadStats(true);
              }}
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
          <>
            {/* Only for the sorts that depend on the second fetch — the orders
                that can be visibly incomplete. */}
            {STATS_SORTS.includes(sort) && (statsLoading || statsError) && (
              <div
                className={`mb-3 rounded-lg border px-4 py-2 text-sm ${
                  statsError
                    ? 'border-red-500/30 bg-red-500/10 text-red-300'
                    : 'border-zinc-800 bg-zinc-900 text-zinc-400'
                }`}
              >
                {statsError
                  ? `Ingredient figures unavailable — ${statsError}`
                  : 'Reading every recipe’s ingredients…'}
              </div>
            )}
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {sorted.map((r) => (
                <li key={r.id}>
                  <RecipeCard
                    recipe={r}
                    inFermenter={r.id === active?.id}
                    colors={colors}
                    stats={stats?.get(r.id) ?? null}
                    showHopRate={sort === 'hopsPerL'}
                  />
                </li>
              ))}
            </ul>
          </>
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
  stats,
  showHopRate,
}: {
  recipe: Recipe;
  inFermenter: boolean;
  colors: KegContentColors;
  /** Cost and hop rate; null until a sort that needs them has fetched them. */
  stats: Stats | null;
  /** Show the hop rate rather than leave the card silent about what it sorted on. */
  showHopRate: boolean;
}): JSX.Element {
  // The edge shows what the beer pours: its malt colour until the ingredient
  // pass reports fruit in it, which for a sour is the difference between straw
  // and deep red.
  const color = stats?.fruitColor ?? ebcColor(recipe.ebc);
  const styleMatch = matchContentOption(recipe.name, recipe.style);
  const ibu = num(recipe.ibu, 0);
  return (
    <Link
      to={`/recipes/${encodeURIComponent(recipe.id)}`}
      title={stats?.fruitNote ?? undefined}
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
        {ibu && ` · ${ibu} IBU`}
        {/* Only once known, so the line doesn't shift about on every load. The
            hop rate is shown when it's what the grid is ordered by; the cost is
            worth keeping visible either way, since it's the harder number to
            find elsewhere. */}
        {showHopRate && stats?.hopsPerL != null && ` · ${stats.hopsPerL.toFixed(1)} g/L`}
        {stats?.usedDkk != null && ` · ${Math.round(stats.usedDkk)} kr`}
      </span>
      <span className="mt-auto pl-[18px] pt-2 text-xs font-semibold text-[#f87a68]">
        {inFermenter ? '✓ In the fermenter' : ' '}
      </span>
    </Link>
  );
}
