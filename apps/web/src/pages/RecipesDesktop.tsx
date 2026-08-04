import type {
  FermenterState,
  KegContent,
  KegContentColors,
  Recipe,
  RecipeBackupStatus,
  RecipeBrewCount,
  RecipeStats,
  RecipeStyleCategory,
} from '@checklist/shared';
import {
  RECIPE_STYLE_CATEGORIES,
  ebcColor,
  getRecipeColor,
  styleCategory,
} from '@checklist/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { canControl, useAuth } from '../auth';
import { brewDate } from '../brewSessions';
import { DashboardShell } from '../components/DashboardShell';
import { FermenterIcon } from '../components/icons';
import { Select } from '../components/Select';
import { useKegContentColors } from '../kegContentColors';
import {
  invalidateRecipes,
  loadRecipeStats,
  loadRecipes,
  revalidateRecipes,
} from '../recipeStore';
import { asCleanMessage, relativeTime } from '../util';

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

/** The stats payload keyed by recipe, as the grid holds it. */
function toStatsMap(list: RecipeStats[]): Map<string, Stats> {
  return new Map(
    list.map((s) => [
      s.id,
      {
        usedDkk: s.usedDkk,
        hopsPerL: s.hopsPerL,
        fruitColor: s.fruitColor,
        fruitNote: s.fruitNote,
      },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * One numeric bound pair, held as the strings the inputs contain rather than as
 * numbers: a half-typed "1." has to survive until the second character arrives,
 * and an empty box has to stay empty rather than becoming a 0.
 */
interface Range {
  min: string;
  max: string;
}

/** Everything narrowing the grid, beyond the search box. */
interface Filters {
  /** Style families to include; empty means every family (no narrowing). */
  families: RecipeStyleCategory[];
  abv: Range;
  ibu: Range;
  ebc: Range;
  price: Range;
  hops: Range;
}

type RangeKey = 'abv' | 'ibu' | 'ebc' | 'price' | 'hops';

/**
 * The numeric filters, in the order the panel lays them out. `pick` returns null
 * for a recipe that can't answer — no EBC set, nothing priceable — and such a
 * recipe drops out once a bound is set, the same way it sinks under a sort.
 */
const RANGE_FIELDS: {
  key: RangeKey;
  label: string;
  step: string;
  pick: (recipe: Recipe, stats: Stats | null) => number | null;
  /** Whether the answer comes from the heavier ingredient pass. */
  needsStats?: boolean;
}[] = [
  { key: 'abv', label: 'ABV %', step: '0.1', pick: (r) => numeric(r.abv) },
  { key: 'ibu', label: 'IBU', step: '1', pick: (r) => numeric(r.ibu) },
  { key: 'ebc', label: 'Colour (EBC)', step: '1', pick: (r) => numeric(r.ebc) },
  { key: 'price', label: 'Price (kr)', step: '10', pick: (_r, s) => s?.usedDkk ?? null, needsStats: true },
  { key: 'hops', label: 'Hops (g/L)', step: '0.5', pick: (_r, s) => s?.hopsPerL ?? null, needsStats: true },
];

const EMPTY_RANGE: Range = { min: '', max: '' };

const NO_FILTERS: Filters = {
  families: [],
  abv: EMPTY_RANGE,
  ibu: EMPTY_RANGE,
  ebc: EMPTY_RANGE,
  price: EMPTY_RANGE,
  hops: EMPTY_RANGE,
};

const FILTERS_KEY = 'brewplanner.recipeFilters';

/**
 * The filters the grid was last left in, persisted for the same reason the sort
 * order is: opening a recipe unmounts this page, and coming back to an
 * unfiltered grid loses the brewer's place. Anything malformed — a family that
 * has since been renamed, a range that isn't a range — falls back to unfiltered
 * rather than leaving the grid narrowed by something the panel can't show.
 */
function loadFilters(): Filters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return NO_FILTERS;
    const saved = JSON.parse(raw) as Partial<Filters>;
    const families = Array.isArray(saved.families)
      ? saved.families.filter((f): f is RecipeStyleCategory =>
          (RECIPE_STYLE_CATEGORIES as readonly string[]).includes(f),
        )
      : [];
    const range = (r: unknown): Range =>
      r && typeof r === 'object'
        ? {
            min: String((r as Range).min ?? ''),
            max: String((r as Range).max ?? ''),
          }
        : EMPTY_RANGE;
    return {
      families,
      abv: range(saved.abv),
      ibu: range(saved.ibu),
      ebc: range(saved.ebc),
      price: range(saved.price),
      hops: range(saved.hops),
    };
  } catch {
    return NO_FILTERS;
  }
}

function saveFilters(filters: Filters): Filters {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  } catch {
    // Per-browser convenience only.
  }
  return filters;
}

/** How many filters are actually narrowing the grid, for the toolbar badge. */
function activeFilterCount(filters: Filters): number {
  const ranges = RANGE_FIELDS.filter(
    ({ key }) => filters[key].min.trim() !== '' || filters[key].max.trim() !== '',
  ).length;
  return (filters.families.length > 0 ? 1 : 0) + ranges;
}

/**
 * Whether a value sits inside a bound pair. An unset bound doesn't constrain, so
 * an empty pair passes everything — including a recipe with no value at all.
 */
function inRange(value: number | null, range: Range): boolean {
  const min = numeric(range.min.trim() || null);
  const max = numeric(range.max.trim() || null);
  if (min == null && max == null) return true;
  // A bound is set and this recipe can't answer it — it isn't a match.
  if (value == null) return false;
  return (min == null || value >= min) && (max == null || value <= max);
}

/**
 * Whether a recipe survives the filter panel. The price and hop-rate bounds are
 * skipped entirely until the ingredient pass has landed: applying them against
 * figures that haven't arrived would empty the grid for a second and then
 * refill it, which reads as a bug.
 */
function matchesFilters(
  recipe: Recipe,
  filters: Filters,
  stats: Map<string, Stats> | null,
): boolean {
  if (filters.families.length > 0 && !filters.families.includes(styleCategory(recipe))) {
    return false;
  }
  const recipeStats = stats?.get(recipe.id) ?? null;
  for (const field of RANGE_FIELDS) {
    if (field.needsStats && stats == null) continue;
    if (!inRange(field.pick(recipe, recipeStats), filters[field.key])) return false;
  }
  return true;
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

/** That date as a card reads it, e.g. "14 Mar 2026"; null when it has none. */
function createdLabel(recipe: Recipe): string | null {
  const t = createdTime(recipe);
  if (t == null) return null;
  return new Date(t).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
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
 * What the beer pours — its colour computed from the recipe's EBC, or the
 * shifted colour when there's fruit in it. Hollow when the recipe states no
 * colour at all. The style's palette colour rides on the card's left edge
 * instead, which is the pairing the keg board uses.
 *
 * The pale ring is what makes a stout legible: near-black on a near-black card
 * is otherwise a hole rather than a swatch.
 */
function BeerDot({
  color,
  label,
  className = 'h-2.5 w-2.5',
}: {
  color: string | null;
  /** What decided the colour (a fruit note), for the tooltip. */
  label: string | null;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={`${className} shrink-0 rounded-full ${
        color ? 'ring-1 ring-white/70' : 'border border-zinc-600'
      }`}
      title={label ?? (color ? 'Predicted colour' : 'No colour set')}
      aria-hidden
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

/**
 * The filter panel — style families as toggle chips, then a min/max pair for
 * every number the grid knows about a recipe. Open from the toolbar; it stays
 * mounted while open so a half-typed bound isn't lost to a re-render.
 *
 * Every control is additive and independent: no chip selected means every
 * family, an empty box means no bound, and "Clear" puts both back.
 */
function RecipeFilters({
  filters,
  onChange,
  statsPending,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  /** The ingredient pass hasn't landed, so the price/hops bounds don't bite yet. */
  statsPending: boolean;
}): JSX.Element {
  const active = activeFilterCount(filters);

  function toggleFamily(family: RecipeStyleCategory): void {
    const families = filters.families.includes(family)
      ? filters.families.filter((f) => f !== family)
      : [...filters.families, family];
    onChange({ ...filters, families });
  }

  return (
    <section className="mb-5 rounded-xl border border-zinc-800 bg-zinc-900 px-5 py-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Style</div>
        <button
          type="button"
          onClick={() => onChange(NO_FILTERS)}
          disabled={active === 0}
          className="rounded-lg border border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          Clear filters
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {RECIPE_STYLE_CATEGORIES.map((family) => {
          const on = filters.families.includes(family);
          return (
            <button
              key={family}
              type="button"
              onClick={() => toggleFamily(family)}
              aria-pressed={on}
              className={`rounded-full border px-3 py-1 text-sm transition ${
                on
                  ? 'border-[#f87a68] bg-[#f87a68]/15 text-zinc-100'
                  : 'border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
              }`}
            >
              {family}
            </button>
          );
        })}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {RANGE_FIELDS.map(({ key, label, step, needsStats }) => (
          <div key={key}>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
              {label}
              {needsStats && statsPending && (
                <span className="ml-1.5 normal-case tracking-normal text-zinc-600">
                  · reading ingredients…
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {(['min', 'max'] as const).map((bound) => (
                <input
                  key={bound}
                  type="number"
                  inputMode="decimal"
                  step={step}
                  value={filters[key][bound]}
                  onChange={(e) =>
                    onChange({ ...filters, [key]: { ...filters[key], [bound]: e.target.value } })
                  }
                  placeholder={bound === 'min' ? 'Min' : 'Max'}
                  aria-label={`${label} ${bound}`}
                  className="w-full min-w-0 rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-[#f87a68]"
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The two things an empty fermenter can be. The label doubles as the keg
 * palette's key, so "Dirty" wears the same warning red it does on the keg board.
 */
const FERMENTER_STATES: { state: FermenterState; content: KegContent }[] = [
  { state: 'clean', content: 'Clean' },
  { state: 'dirty', content: 'Dirty' },
];

/**
 * Whether the empty fermenter has been washed since the last beer left it —
 * shown only while nothing is linked, since a full tank is neither.
 *
 * Two buttons rather than one toggle: a fermenter nobody has spoken for is in
 * neither state, and shouldn't be pushed into one by whichever side the first
 * click happens to land on. Read-only guests see the answer without the buttons.
 */
function FermenterStateControl({
  state,
  colors,
  controllable,
  busy,
  onPick,
}: {
  state: FermenterState | null;
  colors: KegContentColors;
  controllable: boolean;
  busy: boolean;
  onPick: (state: FermenterState) => void;
}): JSX.Element | null {
  if (!controllable) {
    const current = FERMENTER_STATES.find((f) => f.state === state);
    if (!current) return null;
    return (
      <span className="flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-400">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: colors[current.content] }}
          aria-hidden
        />
        {current.content}
      </span>
    );
  }
  return (
    <div className="flex items-center gap-1 rounded-lg border border-zinc-800 p-1">
      {FERMENTER_STATES.map(({ state: option, content }) => (
        <button
          key={option}
          type="button"
          onClick={() => onPick(option)}
          disabled={busy}
          aria-pressed={state === option}
          title={`Mark the fermenter ${option}`}
          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium transition disabled:opacity-40 ${
            state === option
              ? 'bg-zinc-800 text-zinc-100'
              : 'text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300'
          }`}
        >
          <span
            className={`h-2 w-2 shrink-0 rounded-full transition ${
              state === option ? '' : 'opacity-50'
            }`}
            style={{ backgroundColor: colors[content] }}
            aria-hidden
          />
          {content}
        </button>
      ))}
    </div>
  );
}

/**
 * Desktop Recipes — the brewery's Brewer's Friend account, browsable from the
 * sidebar. The list comes from the server (the API key stays server-side); each
 * card opens that recipe's full brew sheet at /recipes/:id, where the grain bill,
 * hop schedule, mash steps and water targets live, and where a recipe can be put
 * in the fermenter.
 *
 * Two colour systems meet on this page, deliberately, and they're paired the way
 * the Kegs page pairs them: a card's left edge is the brewery's own style palette
 * (the colour that style wears on the kegs and the Overview), while the dot by
 * the name — on every card and on the "In the fermenter" block alike — is the
 * beer's physical colour computed from its EBC, which is what a brewer reading a
 * recipe expects to see, and what the detail page shows.
 */
export function RecipesDesktopPage(): JSX.Element {
  const { auth } = useAuth();
  // Clearing the fermenter's recipe is admin-only server-side (DELETE
  // /api/recipe), so a read-only guest gets the same list without the control.
  const controllable = canControl(auth);
  const colors = useKegContentColors();
  const navigate = useNavigate();

  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [active, setActive] = useState<Recipe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [backup, setBackup] = useState<RecipeBackupStatus | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [clearing, setClearing] = useState(false);
  // Whether the tank has been washed, for while it's empty. Null until someone
  // has said — clearing a recipe deliberately doesn't answer it.
  const [fermenter, setFermenter] = useState<FermenterState | null>(null);
  const [markingFermenter, setMarkingFermenter] = useState(false);
  // Both restored from the last visit, so opening a recipe and coming back finds
  // the grid in the order — and narrowed the way — it was left in.
  const [{ key: sort, dir }, setOrder] = useState<SortOrder>(loadOrder);
  const [filters, setFilters] = useState<Filters>(loadFilters);
  // The panel opens on its own the first time a stored filter is still in force,
  // so a grid that comes back narrowed always says why.
  const [showFilters, setShowFilters] = useState(() => activeFilterCount(filters) > 0);
  // Recipe id → cost and hop rate, derived from the stored ingredient lists.
  const [stats, setStats] = useState<Map<string, Stats> | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  // Recipe id → how many times it's been brewed, for the card badges.
  const [brewCounts, setBrewCounts] = useState<Map<string, RecipeBrewCount>>(new Map());
  /** The recipe whose brew session is being started, so its card can say so. */
  const [starting, setStarting] = useState<string | null>(null);

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
      const [list, current, state] = await Promise.all([
        loadRecipes(refresh),
        api.getActiveRecipe(),
        api.getFermenterState(),
      ]);
      setRecipes(list);
      setActive(current);
      setFermenter(state);
      setError(null);
    } catch (e) {
      // The list is the page, so a server failure leaves the empty state with
      // the reason on it.
      setRecipes((prev) => prev ?? []);
      setError(asCleanMessage(e));
    } finally {
      setRefreshing(false);
    }
  }

  /**
   * Cost and weigh the whole account. The cards' fruit colours come from the
   * same pass as the price and hop-rate sorts, so it runs on every visit rather
   * than only when those sorts are picked. It doesn't block the grid — cards
   * draw their malt colour first and the fruited ones re-tint when it lands —
   * and both caches make repeat visits free.
   */
  async function loadStats(refresh = false): Promise<void> {
    if (statsLoading) return;
    setStatsLoading(true);
    try {
      const { stats: list } = await loadRecipeStats(refresh);
      setStats(toStatsMap(list));
      setStatsError(null);
    } catch (e) {
      // An empty map, not null, so a failed pass isn't retried on every render.
      setStats((prev) => prev ?? new Map());
      setStatsError(asCleanMessage(e));
    } finally {
      setStatsLoading(false);
    }
  }

  // Draw what's cached, then quietly check the shared library for edits made by
  // another client. Deliberately silent:
  // nothing spins, and a check that fails leaves the cached grid alone. Only
  // what actually changed comes back, so an unchanged library never redraws.
  //
  // The check is sequenced after the cached read rather than run alongside it,
  // so a slow fermenter lookup can't let fresh data land first and then be
  // overwritten by the cached copy it was meant to replace.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.all([load(), loadStats(), loadBrewCounts()]);
      if (cancelled) return;
      const fresh = await revalidateRecipes();
      if (cancelled) return;
      if (fresh.recipes) setRecipes(fresh.recipes);
      if (fresh.stats) setStats(toStatsMap(fresh.stats.stats));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * How often each recipe has been brewed. Its own small fetch rather than a
   * field on the recipe: the count changes when a brew session is logged, not when
   * the recipe is edited, so it has no business invalidating the recipe cache.
   */
  async function loadBrewCounts(): Promise<void> {
    try {
      const counts = await api.listRecipeBrewCounts();
      setBrewCounts(new Map(counts.map((count) => [count.recipeId, count])));
    } catch {
      // A badge nobody has brewed anything for yet is the same as no badge —
      // never let this cost the grid its recipes.
    }
  }

  /**
   * Say this recipe is being brewed. The server snapshots the sheet onto the new
   * entry and puts the beer in the fermenter; we land on the entry, which is
   * where the brewer types what actually happened.
   */
  async function startBrewSession(recipeId: string): Promise<void> {
    if (starting) return;
    setStarting(recipeId);
    try {
      const brewSession = await api.startBrewSession(recipeId);
      navigate(`/brew-sessions/${brewSession.id}`);
    } catch (e) {
      setError(asCleanMessage(e));
      setStarting(null);
    }
  }

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

  /** Record whether the empty fermenter has been washed. */
  async function markFermenter(state: FermenterState): Promise<void> {
    if (markingFermenter) return;
    setMarkingFermenter(true);
    try {
      setFermenter(await api.setFermenterState(state));
      setError(null);
    } catch (e) {
      setError(asCleanMessage(e));
    } finally {
      setMarkingFermenter(false);
    }
  }

  // What the nightly backup last managed, read once on open. A failure here is
  // silent: the page is the recipe library, not a backup console.
  useEffect(() => {
    let cancelled = false;
    void api
      .getRecipeBackupStatus()
      .then((status) => {
        if (!cancelled) setBackup(status);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Back the library up now. Always takes a copy — unlike the nightly run,
   * which skips a day nothing changed — because somebody asked for one.
   */
  async function backupNow(): Promise<void> {
    if (backingUp) return;
    setBackingUp(true);
    setNotice(null);
    setError(null);
    try {
      const result = await api.backupRecipes();
      const status = await api.getRecipeBackupStatus();
      setBackup(status);
      const saved = `Backed up ${result.recipeCount} recipe${result.recipeCount === 1 ? '' : 's'}`;
      // The local copy is the backup; Drive is where it goes to be safe from the
      // Pi. Saying which half worked is the whole point of the message — and a
      // server with no Google credentials hasn't failed at anything, so that
      // reads as a note rather than as a red banner.
      if (result.driveError && status.driveConfigured) {
        setError(`${saved} to the Pi, but not to Google Drive. ${result.driveError}`);
      } else if (result.driveError) {
        setNotice(`${saved} to the Pi. Google Drive isn’t set up on this server yet, so there is no offsite copy — see deploy/README-recipe-backup.md.`);
      } else {
        setNotice(`${saved} to the Pi and to Google Drive.`);
      }
    } catch (e) {
      setError(asCleanMessage(e));
    } finally {
      setBackingUp(false);
    }
  }

  async function importLegacyRecipes(): Promise<void> {
    if (importing) return;
    setImporting(true);
    setNotice(null);
    try {
      const result = await api.importBrewersFriendRecipes();
      invalidateRecipes();
      await Promise.all([load(true), loadStats(true)]);
      setNotice(
        result.imported > 0
          ? `Imported ${result.imported} recipe${result.imported === 1 ? '' : 's'} from Brewer’s Friend${result.skipped ? `; ${result.skipped} already existed` : ''}.`
          : `No new recipes to import${result.skipped ? `; ${result.skipped} already existed` : ''}.`,
      );
    } catch (e) {
      setError(asCleanMessage(e));
    } finally {
      setImporting(false);
    }
  }

  // The tank's own colour: the style of the beer in it, or — once it's empty and
  // someone has said — whether it still needs washing.
  const activeColor = active ? getRecipeColor(active, colors) : null;
  const emptyContent = FERMENTER_STATES.find((f) => f.state === fermenter)?.content ?? null;
  const vesselColor = active ? activeColor : emptyContent && colors[emptyContent];
  // What the beer in it pours, for the dot — the same reading as a card's.
  const activePour = active ? (stats?.get(active.id)?.fruitColor ?? ebcColor(active.ebc)) : null;
  const activeFruitNote = active ? (stats?.get(active.id)?.fruitNote ?? null) : null;

  const activeFilters = activeFilterCount(filters);
  // The ingredient figures back two sorts and two bounds; whichever is in use,
  // the grid can be visibly incomplete until that pass lands.
  const dependsOnStats =
    STATS_SORTS.includes(sort) ||
    RANGE_FIELDS.some(
      (f) => f.needsStats && (filters[f.key].min.trim() !== '' || filters[f.key].max.trim() !== ''),
    );

  const filtered = useMemo(() => {
    if (!recipes) return [];
    const q = search.trim().toLowerCase();
    return recipes.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q) && !r.style.toLowerCase().includes(q)) {
        return false;
      }
      return matchesFilters(r, filters, stats);
    });
  }, [recipes, search, filters, stats]);

  const sorted = useMemo(
    () => sortRecipes(filtered, sort, dir, stats),
    [filtered, sort, dir, stats],
  );

  return (
    <DashboardShell active="recipes">
      <main className="w-full max-w-[1100px] px-5 py-5">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm text-zinc-500">
              Your BrewPlanner recipe library. Build recipes here, open a full brew sheet, or
              set what is in the fermenter.
            </p>
            {backup && <BackupLine status={backup} />}
          </div>
          {/* Search, sort and refresh; wraps rather than overflowing once the
              sort picker joins them on a narrow window.

              A phone doesn't have the width for that wrap: right-aligned, the
              controls came out as four ragged rows that started in a different
              place each time. So the toolbar stacks there instead — page
              actions, then the search box, then the ordering — as three
              full-width rows. Each row is a wrapper that becomes
              `display: contents` at `sm`, which dissolves it and hands its
              children back to this flex row exactly as they sat before. */}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
            {controllable && (
              <div className="flex gap-2 sm:contents">
                {/* `flex-auto`, not `flex-1`: these three share the row in
                    proportion to their labels rather than being forced into
                    equal thirds a long label would then spill out of. */}
                <Link
                  to="/recipes/new"
                  className="flex-auto whitespace-nowrap rounded-lg bg-gradient-to-br from-[#f87a68] to-[#e0463f] px-3 py-2 text-center text-sm font-semibold text-white shadow transition hover:brightness-110 sm:flex-none"
                >
                  + New recipe
                </Link>
                <button
                  type="button"
                  onClick={() => void backupNow()}
                  disabled={backingUp}
                  title="Write every recipe to a JSON file on the Pi and upload it to the shared Google Drive folder"
                  className="flex-auto whitespace-nowrap rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40 sm:flex-none"
                >
                  {/* The tail of each label is what a phone can't fit, and is
                      the part the title already explains. */}
                  {backingUp ? (
                    'Backing up…'
                  ) : (
                    <>
                      Back up<span className="hidden sm:inline"> now</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => void importLegacyRecipes()}
                  disabled={importing}
                  title="One-way import; existing BrewPlanner recipes are never overwritten"
                  className="flex-auto whitespace-nowrap rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40 sm:flex-none"
                >
                  {importing ? (
                    'Importing…'
                  ) : (
                    <>
                      Import<span className="hidden sm:inline"> from Brewer’s Friend</span>
                    </>
                  )}
                </button>
              </div>
            )}
            {/* The search box and the reload share the phone's second row: the
                box is the one control here that wants every pixel it can get,
                and the reload is a single glyph. `sm:order-last` puts the
                reload back at the end of the toolbar, where it has always sat,
                once the rows dissolve. */}
            <div className="flex items-center gap-2 sm:contents">
              {recipes != null && recipes.length > 0 && (
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search recipes…"
                  aria-label="Search recipes"
                  className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-[#f87a68] sm:w-48 sm:flex-none"
                />
              )}
              {/* Reload the shared app library, including changes from another client. */}
              <button
                type="button"
                onClick={() => {
                  void load(true);
                  if (stats) void loadStats(true);
                }}
                disabled={refreshing}
                title="Reload recipe library"
                aria-label="Reload recipe library"
                className="shrink-0 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40 sm:order-last"
              >
                {refreshing ? '…' : '↻'}
              </button>
            </div>
            {recipes != null && recipes.length > 0 && (
              <div className="flex items-center gap-2 sm:contents">
                {/* Sort key + direction. Price is the one that costs an extra
                    round trip, so it's fetched on selection, not on load. */}
                <Select
                  value={sort}
                  onChange={(key) => setOrder(saveOrder({ key, dir: SORT_DEFAULT_DIRECTION[key] }))}
                  aria-label="Sort recipes by"
                  className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-[#f87a68] sm:flex-none"
                  options={(Object.keys(SORT_LABELS) as SortKey[]).map((key) => ({
                    value: key,
                    label: `Sort: ${SORT_LABELS[key]}`,
                  }))}
                />
                <button
                  type="button"
                  onClick={() =>
                    setOrder(saveOrder({ key: sort, dir: dir === 'asc' ? 'desc' : 'asc' }))
                  }
                  title={`Sorted ${SORT_DIRECTION_LABELS[sort][dir]}`}
                  aria-label={`Sorted ${SORT_DIRECTION_LABELS[sort][dir]}. Reverse the order.`}
                  className="shrink-0 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100"
                >
                  {dir === 'asc' ? '↑' : '↓'}
                </button>
                {/* The panel is a lot of controls for a page whose usual answer
                    is "all of them", so it's behind a toggle — with the count of
                    what's in force on it, since a filtered grid that doesn't say
                    so looks like a grid missing recipes. */}
                <button
                  type="button"
                  onClick={() => setShowFilters((open) => !open)}
                  aria-expanded={showFilters}
                  className={`shrink-0 rounded-lg border px-3 py-2 text-sm transition ${
                    activeFilters > 0
                      ? 'border-[#f87a68] bg-[#f87a68]/15 text-zinc-100'
                      : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100'
                  }`}
                >
                  Filters{activeFilters > 0 ? ` · ${activeFilters}` : ''}
                </button>
                <span className="hidden rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-400 sm:inline">
                  <span className="font-semibold text-zinc-100">{filtered.length}</span>
                  {/* "of 34" only while something is actually narrowing the
                      grid — otherwise the two numbers are the same. */}
                  {filtered.length !== recipes.length && ` of ${recipes.length}`} recipe
                  {filtered.length === 1 ? '' : 's'}
                </span>
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
        {notice && (
          <div className="mb-5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200">
            {notice}
          </div>
        )}

        {/* What's fermenting right now — set from a recipe's own page, shown here
            so the page answers "what's in the tank?" without a detour. */}
        <section className="mb-5 flex flex-wrap items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900 px-5 py-4">
          <FermenterIcon
            className="h-10 w-10 shrink-0 text-white"
            strokeWidth={2.6}
            style={vesselColor ? { color: vesselColor } : undefined}
          />
          {/* The floor of 10rem is what makes the row wrap on a phone rather
              than squeeze: with `min-w-0` alone this column shrank to whatever
              was left beside the Clean/Dirty control, and the sentence came out
              two or three words wide. It still shrinks below its text — the
              recipe name truncates the same as before — just not below legible. */}
          <div className="min-w-[10rem] flex-1">
            <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              In the fermenter
            </div>
            {active ? (
              <>
                <div className="flex items-center gap-2">
                  <BeerDot color={activePour} label={activeFruitNote} />
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
          {/* An empty tank's one open question: has it been washed since the
              last beer came out? Only asked while nothing is linked. */}
          {!active && (
            <FermenterStateControl
              state={fermenter}
              colors={colors}
              controllable={controllable}
              busy={markingFermenter}
              onPick={(state) => void markFermenter(state)}
            />
          )}
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

        {/* Above the grid rather than up in the toolbar, so it sits with what it
            narrows — and stays put when the grid empties, which is exactly when
            the way out of it needs to be to hand. */}
        {showFilters && recipes != null && recipes.length > 0 && (
          <RecipeFilters
            filters={filters}
            onChange={(next) => setFilters(saveFilters(next))}
            statsPending={stats == null}
          />
        )}

        {recipes === null ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-400">
            Loading recipes…
          </div>
        ) : recipes.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-400">
            No recipes yet. Create one from scratch or import your existing Brewer&rsquo;s Friend
            library.
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-400">
            {/* Say which of the two emptied the grid — searching and filtering
                fail identically, and the filters may well be collapsed out of
                sight, so the way back also travels with the message. */}
            <span>
              {search.trim() && activeFilters > 0
                ? `No recipes match “${search.trim()}” with these filters.`
                : search.trim()
                  ? `No recipes match “${search.trim()}”.`
                  : 'No recipes match these filters.'}
            </span>
            {activeFilters > 0 && (
              <button
                type="button"
                onClick={() => setFilters(saveFilters(NO_FILTERS))}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100"
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Only when something on screen depends on the second fetch — the
                orders and the bounds that can be visibly incomplete. */}
            {dependsOnStats && (statsLoading || statsError) && (
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
                    brewCount={brewCounts.get(r.id) ?? null}
                    onBrew={controllable ? () => void startBrewSession(r.id) : undefined}
                    starting={starting === r.id}
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
 * is the style's colour from the keg palette, matching how that beer looks on the
 * keg boards, while the dot by the name is the beer's own colour from its EBC. The
 * one in the fermenter keeps the coral highlight.
 */
function RecipeCard({
  recipe,
  inFermenter,
  colors,
  stats,
  showHopRate,
  brewCount,
  onBrew,
  starting,
}: {
  recipe: Recipe;
  inFermenter: boolean;
  colors: KegContentColors;
  /** Cost and hop rate; null until a sort that needs them has fetched them. */
  stats: Stats | null;
  /** Show the hop rate rather than leave the card silent about what it sorted on. */
  showHopRate: boolean;
  /** How often it's been brewed; null when never. */
  brewCount: RecipeBrewCount | null;
  /** Start a brew session for this recipe. Absent for a read-only guest. */
  onBrew?: () => void;
  starting: boolean;
}): JSX.Element {
  // The dot shows what the beer pours: its malt colour until the ingredient
  // pass reports fruit in it, which for a sour is the difference between straw
  // and deep red. The edge carries the style, as the keg board does.
  const pour = stats?.fruitColor ?? ebcColor(recipe.ebc);
  const styleColor = getRecipeColor(recipe, colors);
  const ibu = num(recipe.ibu, 0);
  const created = createdLabel(recipe);
  return (
    // A card, not a link: the brew-session button lives in its footer, and a button
    // inside an anchor is neither valid markup nor reliably clickable. The link
    // covers everything above the footer instead, which is the whole card as far
    // as clicking to read the sheet is concerned.
    <div
      style={styleColor ? { borderLeftColor: styleColor, borderLeftWidth: 3 } : undefined}
      className={`group flex h-full flex-col rounded-xl border transition ${
        inFermenter
          ? 'border-[#f87a68] bg-gradient-to-br from-[#f87a68]/25 to-[#e0463f]/25'
          : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700 hover:bg-zinc-800/60'
      }`}
    >
    <Link
      to={`/recipes/${encodeURIComponent(recipe.id)}`}
      title={stats?.fruitNote ?? undefined}
      className="flex flex-1 flex-col gap-1 px-4 pb-1 pt-3.5"
    >
      <span className="flex w-full items-center gap-2">
        <BeerDot color={pour} label={stats?.fruitNote ?? null} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">
          {recipe.name}
        </span>
        {/* How often it's been made — the one thing about a recipe that isn't on
            the recipe. A house beer on its eighth batch reads differently from
            one that has been written but never brewed. */}
        {brewCount && (
          <span
            className="shrink-0 rounded border border-zinc-700 bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-300"
            title={`Brewed ${brewCount.count} time${brewCount.count === 1 ? '' : 's'} · last on ${brewDate(brewCount.lastBrewedAt)}`}
          >
            ×{brewCount.count}
          </span>
        )}
        {recipe.origin === 'brewersfriend' && (
          <span
            className="shrink-0 rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-300"
            title="Originally imported from Brewer's Friend"
          >
            BF
          </span>
        )}
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
      {/* When it was written on Brewer's Friend — the one thing the figures
          above don't say, and what the default sort orders the grid by. */}
      {created && (
        <span className="w-full truncate pl-[18px] text-xs text-zinc-600">
          Created {created}
        </span>
      )}
    </Link>
      <div className="mt-auto flex items-center gap-2 px-4 pb-3 pl-[34px] pt-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[#f87a68]">
          {inFermenter ? '✓ In the fermenter' : ' '}
        </span>
        {/* The button the whole feature hangs off: say you're brewing this, and
            the log takes over from here. Quiet until the card is hovered — the
            grid is read far more often than it is brewed from — but always
            there on a touchscreen, which has no hover to give. */}
        {onBrew && (
          <button
            type="button"
            onClick={onBrew}
            disabled={starting}
            title={`Start a brew session for ${recipe.name}`}
            className="shrink-0 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs font-semibold text-zinc-300 opacity-100 transition hover:border-[#f87a68] hover:bg-[#f87a68]/15 hover:text-[#f9a094] disabled:opacity-50 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
          >
            {starting ? 'Starting…' : 'Brew'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One line on what the nightly backup last managed. Deliberately quiet: a
 * backup that is working is not news, so it reads as a timestamp until
 * something has gone wrong, when it turns amber and says what.
 *
 * "Local only" is its own state rather than an error — a Pi with no Google
 * credentials is backing itself up perfectly well, just not off itself.
 */
function BackupLine({ status }: { status: RecipeBackupStatus }): JSX.Element {
  const when = status.lastOkAt ? relativeTime(status.lastOkAt) : null;
  // A server with no Google credentials hasn't failed at anything — it is
  // backing itself up perfectly well, just not off itself. Only a Drive that
  // was asked for and didn't work is a problem worth colouring.
  const problem = status.driveConfigured ? status.lastError : null;
  const detail = problem
    ?? (status.driveConfigured
      ? 'Written to the Pi and to the shared Google Drive folder, nightly.'
      : 'Written to the Pi nightly. Add Google credentials to copy them to Drive as well — see deploy/README-recipe-backup.md.');
  return (
    <p className={`mt-1 text-xs ${problem ? 'text-amber-300/90' : 'text-zinc-600'}`} title={detail}>
      {when
        ? `Recipes backed up ${when}${status.lastRecipeCount != null ? ` · ${status.lastRecipeCount} recipes` : ''}`
        : 'Recipes have not been backed up yet'}
      {problem ? ' · Drive upload failed' : status.driveConfigured ? '' : ' · local only'}
    </p>
  );
}
