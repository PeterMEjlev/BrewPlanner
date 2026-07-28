import type {
  CostTotal,
  HopStage,
  Recipe,
  RecipeDetail,
  RecipeEditInput,
  RecipeFermentable,
  RecipeHop,
  RecipeOtherIngredient,
  RecipePricing,
  RecipeWaterProfile,
  RecipeYeast,
  UnpricedIngredient,
} from '@checklist/shared';
import {
  HOP_STAGE_ORDER,
  aromaHopRate,
  ebcColor,
  estimateFermentationDays,
  isFermentableLine,
  predictBeerColor,
  sumCost,
  unpricedIngredients,
} from '@checklist/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { canControl, useAuth } from '../auth';
import { DashboardShell } from '../components/DashboardShell';
import { IngredientName, PriceCell } from '../components/PricePicker';
import type { PricedLine } from '../components/PricePicker';
import { RecipeEditor } from '../components/RecipeEditor';
import { SheetSection } from '../components/SheetSection';
import { UnpricedIngredientsDialog } from '../components/UnpricedIngredients';
import { kr } from '../money';
import { invalidateRecipes, loadRecipeDetail } from '../recipeStore';
import { asCleanMessage } from '../util';

/**
 * One recipe's full brew sheet — the page the Recipes grid opens. Everything the
 * brewer needs while actually brewing: the numbers up top, then the grain bill,
 * hop schedule, yeast, mash steps and water targets, each collapsible so a long
 * recipe can be narrowed to the section in use.
 *
 * The data is a separate (heavier) server call than the recipe list — Brewer's
 * Friend only returns ingredients when asked — so this page fetches on open and
 * keeps what it fetched for the session (see recipeStore): moving between
 * recipes, or back to the grid and in again, then costs nothing.
 */

/** Which sections are folded away. Persisted so a preference survives reloads. */
type SectionKey = 'fermentables' | 'hops' | 'other' | 'yeast' | 'mash' | 'water';

const COLLAPSE_KEY = 'brewplanner.recipeSections';

/** Everything starts open: the point of the page is reading the whole sheet. */
const ALL_OPEN: Record<SectionKey, boolean> = {
  fermentables: false,
  hops: false,
  other: false,
  yeast: false,
  mash: false,
  water: false,
};

function loadCollapsed(): Record<SectionKey, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (!raw) return ALL_OPEN;
    return { ...ALL_OPEN, ...(JSON.parse(raw) as Partial<Record<SectionKey, boolean>>) };
  } catch {
    return ALL_OPEN;
  }
}

/** Round for display, leaving a value we can't parse to show as-is. */
function fmt(value: string | number | null | undefined, decimals: number): string {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n.toFixed(decimals) : String(value ?? '—');
}

/** Fermentable amounts, normalized to kg so the grain bill can be totalled. */
function toKg(amount: string, unit: string): number {
  const n = Number.parseFloat(amount);
  if (!Number.isFinite(n)) return 0;
  switch (unit.toLowerCase()) {
    case 'g':
      return n / 1000;
    case 'lb':
    case 'lbs':
      return n * 0.453592;
    case 'oz':
      return n * 0.0283495;
    default:
      return n;
  }
}

/** Hop amounts, normalized to grams. */
function toG(amount: string, unit: string): number {
  const n = Number.parseFloat(amount);
  if (!Number.isFinite(n)) return 0;
  switch (unit.toLowerCase()) {
    case 'oz':
      return n * 28.3495;
    case 'kg':
      return n * 1000;
    default:
      return n;
  }
}

/** A section's cost for its header: "254 kr", plus a note when coverage is short. */
function costMeta(cost: CostTotal): string {
  const parts: string[] = [];
  if (cost.priced > 0) parts.push(kr(cost.usedDkk, 0));
  if (cost.unpriced > 0) parts.push(`${cost.unpriced} unpriced`);
  return parts.join(' · ');
}

/**
 * "20 min", "5 days", or '' when the addition states no time.
 *
 * An addition that gives a time but no unit is read as minutes everywhere a
 * kettle is involved — a whirlpool stand or a boil charge is timed in minutes,
 * and an imported sheet that leaves the unit off shouldn't lose its stand time.
 * A dry hop keeps its silence: "5" days and "5" minutes are both plausible
 * there, and guessing wrong turns a five-day charge into a five-minute one.
 */
function hopTiming(hop: RecipeHop): string {
  if (!hop.time) return '';
  if (hop.timeUnit === 'day') {
    return `${hop.time} ${Number.parseFloat(hop.time) === 1 ? 'day' : 'days'}`;
  }
  if (!hop.timeUnit && hop.stage === 'Dry Hop') return '';
  return `${hop.time} min`;
}

export function RecipeDetailPage(): JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { auth } = useAuth();
  const controllable = canControl(auth);

  const [recipe, setRecipe] = useState<RecipeDetail | null>(null);
  const [active, setActive] = useState<Recipe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>(loadCollapsed);

  function toggle(key: SectionKey): void {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        // Per-browser convenience only.
      }
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    setRecipe(null);
    setError(null);
    void (async () => {
      try {
        // The active-recipe read is what decides whether this recipe shows as
        // "in the fermenter"; a failure there shouldn't hide the brew sheet.
        const [detail, current] = await Promise.all([
          // From the session cache when this recipe has been opened before —
          // reopening a brew sheet mid-brew shouldn't wait on Brewer's Friend.
          loadRecipeDetail(id),
          api.getActiveRecipe().catch(() => null),
        ]);
        if (cancelled) return;
        setRecipe(detail);
        setActive(current);
      } catch (e) {
        if (!cancelled) setError(asCleanMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const isActive = recipe != null && active?.id === recipe.id;

  /**
   * Re-read the brew sheet after a price decision. A decision is stored against
   * the ingredient rather than this recipe, so the whole account's costs move
   * with it — hence dropping every cached recipe, not just this one, and letting
   * the Recipes grid re-cost itself the next time it's opened.
   */
  const reprice = useCallback(() => {
    invalidateRecipes();
    void loadRecipeDetail(id, true)
      .then(setRecipe)
      .catch((e) => setError(asCleanMessage(e)));
  }, [id]);

  /** Put this recipe in the fermenter (or take it out again). */
  async function setFermenter(next: boolean): Promise<void> {
    if (!recipe || saving) return;
    setSaving(true);
    try {
      if (next) {
        setActive(
          await api.setActiveRecipe({
            id: recipe.id,
            name: recipe.name,
            style: recipe.style,
            abv: recipe.abv,
            url: recipe.url,
            ibu: recipe.ibu,
            ebc: recipe.ebc,
          }),
        );
      } else {
        await api.clearActiveRecipe();
        setActive(null);
      }
      setError(null);
    } catch (e) {
      setError(asCleanMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit(draft: RecipeEditInput): Promise<void> {
    if (editSaving) return;
    setEditSaving(true);
    setError(null);
    try {
      const saved = await api.updateRecipe(id, draft);
      invalidateRecipes();
      setRecipe(saved);
      if (active?.id === saved.id) {
        setActive({ ...active, name: saved.name, style: saved.style, abv: saved.abv, ibu: saved.ibu, ebc: saved.ebc });
      }
      setEditing(false);
    } catch (e) {
      setError(asCleanMessage(e));
    } finally {
      setEditSaving(false);
    }
  }

  async function deleteRecipe(): Promise<void> {
    if (!recipe || deleting) return;
    if (!window.confirm(`Delete “${recipe.name}” from BrewPlanner? This cannot be undone.`)) return;
    setDeleting(true);
    setError(null);
    try {
      await api.deleteRecipe(recipe.id);
      invalidateRecipes();
      navigate('/recipes', { replace: true });
    } catch (e) {
      setError(asCleanMessage(e));
      setDeleting(false);
    }
  }

  // Section costs, summed the same way everywhere via the shared helper.
  const costs = useMemo(
    () =>
      recipe
        ? {
            fermentables: sumCost(recipe.fermentables),
            hops: sumCost(recipe.hops),
            yeast: sumCost(recipe.yeast),
            other: sumCost(recipe.otherIngredients),
          }
        : null,
    [recipe],
  );

  const totals = useMemo(() => {
    if (!recipe) return null;
    return {
      grainKg: recipe.fermentables.reduce((sum, f) => sum + toKg(f.amount, f.unit), 0),
      hopsG: recipe.hops.reduce((sum, h) => sum + toG(h.amount, h.unit), 0),
      aromaRate: aromaHopRate(recipe.hops, recipe.batchSizeL),
    };
  }, [recipe]);

  /**
   * Roughly how long this beer will take to ferment — the strain, the
   * temperature the sheet holds it at, and the gravity it has to get through.
   * A planning figure for when the fermenter comes free, so it says "≈" and
   * carries its own caveats in the tooltip.
   */
  const fermentation = useMemo(
    () =>
      recipe
        ? estimateFermentationDays({
            og: recipe.og,
            temperatureC: recipe.fermentationTemp,
            yeast: recipe.yeast,
          })
        : null,
    [recipe],
  );

  if (error && !recipe) {
    return (
      <DashboardShell active="recipes">
        <main className="w-full max-w-[1100px] px-5 py-5">
          <BackLink />
          <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        </main>
      </DashboardShell>
    );
  }

  if (!recipe) {
    return (
      <DashboardShell active="recipes">
        <main className="w-full max-w-[1100px] px-5 py-5">
          <BackLink />
          <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-400">
            Loading recipe…
          </div>
        </main>
      </DashboardShell>
    );
  }

  if (editing) {
    return (
      <DashboardShell active="recipes">
        {/* Wider than the read view below: the editor spends this width on a
            contents rail and a column of live statistics either side of the
            sheet, not on the sheet itself. */}
        <main className="w-full max-w-[1600px] px-5 py-5">
          <BackLink />
          <div className="mt-4 flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[#f06a5c]">Edit recipe</p>
              <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-zinc-50">{recipe.name}</h1>
            </div>
          </div>
          <RecipeEditor recipe={recipe} saving={editSaving} error={error} onSave={saveEdit} onCancel={() => { setEditing(false); setError(null); }} />
        </main>
      </DashboardShell>
    );
  }

  // What the beer actually pours: the malt colour, restained by any fruit in
  // the other-ingredients list. The swatch means "what's in the glass", so a
  // fruited sour shows red here rather than the straw its grain bill implies.
  const predicted = predictBeerColor({
    ebc: recipe.ebc,
    batchSizeL: recipe.batchSizeL,
    additions: recipe.otherIngredients,
  });
  const color = predicted?.hex ?? ebcColor(recipe.ebc);
  const colorTitle = predicted?.fruit?.note;
  const sorted = [...recipe.fermentables].sort(
    (a, b) => toKg(b.amount, b.unit) - toKg(a.amount, a.unit),
  );

  return (
    <DashboardShell active="recipes">
      <main className="w-full max-w-[1100px] px-5 py-5">
        <BackLink />

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* Title block: name, style, and the two actions on this recipe. */}
        <header className="mt-4 flex flex-wrap items-start justify-between gap-4 rounded-xl border border-zinc-800 bg-zinc-900 px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <Swatch color={color} className="h-4 w-4" ebc={recipe.ebc} title={colorTitle} />
              <h1 className="min-w-0 text-xl font-semibold tracking-tight text-zinc-50">
                {recipe.name}
              </h1>
            </div>
            <p className="mt-1 pl-[26px] text-sm text-zinc-400">
              {recipe.style || 'No style set'}
              {recipe.batchSizeL != null && ` · ${recipe.batchSizeL} L batch`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {controllable && (
              <button
                type="button"
                onClick={() => { setError(null); setEditing(true); }}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-200 transition hover:bg-zinc-800 hover:text-white"
              >
                Edit recipe
              </button>
            )}
            {controllable && (
              <button
                type="button"
                onClick={() => void deleteRecipe()}
                disabled={deleting}
                className="rounded-lg border border-red-500/30 px-3 py-1.5 text-sm font-medium text-red-300 transition hover:bg-red-500/10 disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            )}
            {recipe.url && (
              <a
                href={recipe.url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100"
              >
                Open on Brewer&rsquo;s Friend ↗
              </a>
            )}
            {controllable && (
              <button
                type="button"
                onClick={() => void setFermenter(!isActive)}
                disabled={saving}
                title={
                  isActive
                    ? 'Take this beer out of the fermenter'
                    : 'Show this beer on the Overview and the kiosk'
                }
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition disabled:opacity-50 ${
                  isActive
                    ? 'border border-emerald-500/50 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
                    : 'bg-gradient-to-br from-[#f87a68] to-[#e0463f] text-white shadow hover:brightness-110'
                }`}
              >
                {saving ? 'Saving…' : isActive ? '✓ In the fermenter' : 'Set in fermenter'}
              </button>
            )}
          </div>
        </header>

        {recipe.origin === 'brewersfriend' && (
          <div className="mt-3 rounded-lg border border-sky-500/25 bg-sky-500/10 px-4 py-2.5 text-sm text-sky-100">
            Imported from Brewer&rsquo;s Friend. This brew sheet now lives in BrewPlanner; its
            original link is retained for reference.
          </div>
        )}

        {/* The numbers, in brew order: gravities → ABV/IBU/colour → temps. */}
        <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
          {recipe.preBoilGravity && <Stat label="Pre-boil" value={fmt(recipe.preBoilGravity, 3)} />}
          {recipe.postBoilGravity && (
            <Stat label="Post-boil" value={fmt(recipe.postBoilGravity, 3)} />
          )}
          <Stat label="OG" value={fmt(recipe.og, 3)} />
          <Stat label="FG" value={fmt(recipe.fg, 3)} />
          <Stat label="ABV" value={`${fmt(recipe.abv, 1)}%`} />
          <Stat label="IBU" value={fmt(recipe.ibu, 1)} />
          {/* Brewer's Friend reports 0 for this account's recipes, so the server
              falls back to calculating from the grain bill — flagged as "est."
              rather than passed off as the recipe's own figure. */}
          <Stat
            label={recipe.ebcEstimated ? 'EBC (est.)' : 'EBC'}
            value={fmt(recipe.ebc, 1)}
            swatch={color}
            ebc={recipe.ebc}
            title={
              recipe.ebcEstimated
                ? "Calculated from the grain bill (Morey) — the recipe didn't report a colour"
                : undefined
            }
            // The figure is the malt's EBC; the swatch beside it is the pour,
            // fruit included, so it says so on hover rather than reading as a
            // swatch that disagrees with its own number.
            swatchTitle={colorTitle}
          />
          {recipe.mashTemp && <Stat label="Mash" value={recipe.mashTemp} />}
          {recipe.fermentationTemp && <Stat label="Fermentation" value={recipe.fermentationTemp} />}
          {/* When the fermenter comes free, near enough to plan a brew day
              around. An estimate from the strain, the temperature and the
              gravity — never a substitute for a hydrometer, which is what the
              tooltip says. */}
          {fermentation && (
            <Stat
              label="Ferment"
              value={`≈${fermentation.days} days`}
              title={`${fermentation.minDays}–${fermentation.maxDays} days. ${fermentation.note}`}
            />
          )}
          {/* Grid auto-flow puts this beside EBC (its usual neighbour once the
              gravity/ABV/IBU stats fill the row above); a col-span this wide
              only fits when there's room left in the current row — otherwise it
              wraps to its own row below, which is the same graceful fallback the
              narrower breakpoints already rely on. */}
          {costs && (
            <div className="col-span-2 sm:col-span-2 lg:col-span-4">
              <CostSummary
                recipe={recipe}
                fermentables={costs.fermentables}
                hops={costs.hops}
                yeast={costs.yeast}
                other={costs.other}
                editable={controllable}
                onChanged={reprice}
              />
            </div>
          )}
        </div>

        <div className="mt-4 space-y-3">
          {recipe.fermentables.length > 0 && totals && costs && (
            <SheetSection
              title="Fermentables"
              icon="🌾"
              meta={[`${totals.grainKg.toFixed(2)} kg`, costMeta(costs.fermentables)]
                .filter(Boolean)
                .join(' · ')}
              open={!collapsed.fermentables}
              onToggle={() => toggle('fermentables')}
            >
              <ul className="divide-y divide-zinc-800">
                {sorted.map((f, i) => (
                  <FermentableRow
                    key={`${f.name}-${i}`}
                    fermentable={f}
                    editable={controllable}
                    onChanged={reprice}
                  />
                ))}
              </ul>
            </SheetSection>
          )}

          {recipe.hops.length > 0 && totals && costs && (
            <SheetSection
              title="Hops"
              icon="🌿"
              meta={[
                `${totals.hopsG.toFixed(0)} g`,
                totals.aromaRate != null ? `${totals.aromaRate.toFixed(1)} g/L aroma` : '',
                costMeta(costs.hops),
              ]
                .filter(Boolean)
                .join(' · ')}
              metaTitle="Aroma hop rate — grams per litre of whirlpool and dry hops (the bittering charge doesn't add aroma)"
              open={!collapsed.hops}
              onToggle={() => toggle('hops')}
            >
              <HopSchedule hops={recipe.hops} editable={controllable} onChanged={reprice} />
            </SheetSection>
          )}

          {/* Fruit purées live here, and in a sour they can outweigh the grain
              bill in cost — so this section is costed like any other. */}
          {recipe.otherIngredients.length > 0 && costs && (
            <SheetSection
              title="Other ingredients"
              icon="🧪"
              meta={[`${recipe.otherIngredients.length}`, costMeta(costs.other)]
                .filter(Boolean)
                .join(' · ')}
              open={!collapsed.other}
              onToggle={() => toggle('other')}
            >
              <ul className="divide-y divide-zinc-800">
                {recipe.otherIngredients.map((m, i) => (
                  <OtherRow
                    key={`${m.name}-${i}`}
                    ingredient={m}
                    editable={controllable}
                    onChanged={reprice}
                  />
                ))}
              </ul>
            </SheetSection>
          )}

          {recipe.yeast.length > 0 && costs && (
            <SheetSection
              title="Yeast"
              icon="🧫"
              meta={costMeta(costs.yeast)}
              open={!collapsed.yeast}
              onToggle={() => toggle('yeast')}
            >
              <ul className="divide-y divide-zinc-800">
                {recipe.yeast.map((y, i) => (
                  <YeastRow
                    key={`${y.name}-${i}`}
                    yeast={y}
                    editable={controllable}
                    onChanged={reprice}
                  />
                ))}
              </ul>
            </SheetSection>
          )}

          {recipe.mashGuidelines && (
            <SheetSection
              title="Mash guidelines"
              icon="🌡️"
              meta={
                recipe.mashGuidelines.steps.length > 0
                  ? `${recipe.mashGuidelines.steps.length} step${
                      recipe.mashGuidelines.steps.length === 1 ? '' : 's'
                    }`
                  : undefined
              }
              open={!collapsed.mash}
              onToggle={() => toggle('mash')}
            >
              {(recipe.mashGuidelines.startingThicknessLPerKg != null ||
                recipe.mashGuidelines.grainTempC != null) && (
                <div className="flex flex-wrap gap-3 border-b border-zinc-800 px-4 py-2 text-xs text-zinc-400">
                  {recipe.mashGuidelines.startingThicknessLPerKg != null && (
                    <span>Thickness {recipe.mashGuidelines.startingThicknessLPerKg} L/kg</span>
                  )}
                  {recipe.mashGuidelines.grainTempC != null && (
                    <span>Grain {recipe.mashGuidelines.grainTempC}°C</span>
                  )}
                </div>
              )}
              <ol className="divide-y divide-zinc-800">
                {recipe.mashGuidelines.steps.map((s, i) => (
                  <li key={i} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-700 text-xs font-semibold text-zinc-400">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-100">
                      {s.type || s.name || `Step ${i + 1}`}
                      {s.description && (
                        <span className="ml-2 text-xs text-zinc-500">{s.description}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-sm text-zinc-400">
                      {[
                        s.startTemp && `start ${s.startTemp}°C`,
                        s.temp,
                        s.time && `${s.time} min`,
                        s.amount && `${s.amount}${s.amountUnit ? ` ${s.amountUnit}` : ''}`,
                      ].filter(Boolean).join(' · ')}
                    </span>
                  </li>
                ))}
                {recipe.mashGuidelines.notes && (
                  <li className="px-4 py-2.5 text-sm text-zinc-400">
                    <span className="text-xs uppercase tracking-wide text-zinc-500">Notes </span>
                    {recipe.mashGuidelines.notes}
                  </li>
                )}
              </ol>
            </SheetSection>
          )}

          {recipe.waterProfile && (
            <SheetSection
              title="Water profile"
              icon="💧"
              meta={recipe.waterProfile.name ?? undefined}
              open={!collapsed.water}
              onToggle={() => toggle('water')}
            >
              <WaterSection profile={recipe.waterProfile} recipe={recipe} />
            </SheetSection>
          )}
        </div>
      </main>
    </DashboardShell>
  );
}

function BackLink(): JSX.Element {
  return (
    <Link
      to="/recipes"
      className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-400 transition hover:text-zinc-100"
    >
      ← Recipes
    </Link>
  );
}

/** A beer/grain colour dot; hollow when the EBC value is missing. */
function Swatch({
  color,
  ebc,
  className,
  title,
}: {
  color: string | null;
  ebc: string | number | null;
  className: string;
  /** Overrides the plain "12 EBC" tooltip — used to explain a fruited colour. */
  title?: string;
}): JSX.Element {
  return (
    <span
      className={`${className} shrink-0 rounded-full ${color ? '' : 'border border-zinc-600'}`}
      style={color ? { backgroundColor: color } : undefined}
      title={title ?? (color ? `${ebc} EBC` : 'Colour unknown')}
      aria-hidden
    />
  );
}

/** One figure from the brew sheet. */
function Stat({
  label,
  value,
  swatch,
  ebc,
  title,
  swatchTitle,
}: {
  label: string;
  value: string;
  swatch?: string | null;
  ebc?: string;
  /** Tooltip, for a figure that needs a caveat. */
  title?: string;
  /** Tooltip for the swatch alone, when it says more than the figure does. */
  swatchTitle?: string;
}): JSX.Element {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-3.5 py-2.5" title={title}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-0.5 flex items-center gap-2 text-lg font-semibold text-zinc-50">
        {value}
        {swatch !== undefined && (
          <Swatch color={swatch} ebc={ebc ?? null} className="h-3.5 w-3.5" title={swatchTitle} />
        )}
      </div>
    </div>
  );
}

/**
 * What every ingredient row shares: the price cell can be opened from the row's
 * name as well as from the figure, so the open state lives one level up from
 * both. The four sections lay their rows out differently enough that they each
 * keep their own component rather than sharing one.
 */
function usePricePicker(): { open: boolean; setOpen: (open: boolean) => void } {
  const [open, setOpen] = useState(false);
  return { open, setOpen };
}

/** Props every ingredient row takes for its price cell. */
interface RowPricing {
  /** False for a read-only guest: prices show, the picker doesn't open. */
  editable: boolean;
  /** Called after a price decision, so the page can re-read the recipe. */
  onChanged: () => void;
}

function FermentableRow({
  fermentable: f,
  editable,
  onChanged,
}: { fermentable: RecipeFermentable } & RowPricing): JSX.Element {
  const { open, setOpen } = usePricePicker();
  const line: PricedLine = {
    kind: 'fermentable',
    name: f.name,
    grams: f.grams,
    // The colour is part of the automatic match, so the picker has to know it to
    // mark the same listing as cheapest that the costing actually chose.
    ebc: f.ebc,
    price: f.price,
  };
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <Swatch color={ebcColor(f.ebc)} className="h-3 w-3" ebc={f.ebc} />
      <IngredientName
        name={f.name}
        editable={editable}
        onClick={() => setOpen(!open)}
        className="min-w-0 flex-1 text-sm text-zinc-100"
      />
      <span className="shrink-0 text-sm text-zinc-400">
        {f.amount} {f.unit}
        {f.percent && <span className="text-zinc-500"> · {fmt(f.percent, 1)}%</span>}
        {f.ebc != null && <span className="text-zinc-500"> · {f.ebc} EBC</span>}
        {f.ppg != null && <span className="text-zinc-500"> · {f.ppg} PPG</span>}
        {f.lateAddition && <span className="text-zinc-500" title="Kept out of the boil gravity the hops are utilized against"> · late</span>}
        {!isFermentableLine(f) && <span className="text-zinc-500" title="Raises the gravity but never attenuates — it lands in the FG"> · unfermentable</span>}
      </span>
      <PriceCell
        line={line}
        editable={editable}
        open={open}
        onOpenChange={setOpen}
        onChanged={onChanged}
      />
    </li>
  );
}

function OtherRow({
  ingredient: m,
  editable,
  onChanged,
}: { ingredient: RecipeOtherIngredient } & RowPricing): JSX.Element {
  const { open, setOpen } = usePricePicker();
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <IngredientName
        name={m.name}
        editable={editable}
        onClick={() => setOpen(!open)}
        className="min-w-0 flex-1 text-sm text-zinc-100"
      />
      <span className="shrink-0 text-sm text-zinc-400">
        {[`${m.amount}${m.unit ? ` ${m.unit}` : ''}`, m.type, m.use, m.time && `${m.time} ${m.timeUnit || 'min'}`]
          .filter(Boolean)
          .join(' · ')}
      </span>
      <PriceCell
        line={{ kind: 'other', name: m.name, grams: m.grams, units: m.units, price: m.price }}
        editable={editable}
        open={open}
        onOpenChange={setOpen}
        onChanged={onChanged}
      />
    </li>
  );
}

/**
 * What the batch costs in ingredients. Two figures, because they answer different
 * questions: the headline is what the recipe consumes (the true cost of the beer,
 * with leftover hops carried into the next batch), while the buy-in is what the
 * shop charges when a 40 g addition still means a 100 g bag.
 *
 * Coverage is stated plainly — the catalogue doesn't price everything, and a
 * total drawn from part of the ingredients has to say so.
 */
function CostSummary({
  recipe,
  fermentables,
  hops,
  yeast,
  other,
  editable,
  onChanged,
}: {
  recipe: RecipeDetail;
  fermentables: CostTotal;
  hops: CostTotal;
  yeast: CostTotal;
  /** Fruit purées and the rest — often the biggest line in a sour. */
  other: CostTotal;
} & RowPricing): JSX.Element | null {
  const pricing: RecipePricing = recipe.pricing;
  // Which ingredients the total is short of, for the panel the count opens.
  const missing = useMemo(() => unpricedIngredients(recipe), [recipe]);
  // The panel keeps the list it opened with: each price saved re-reads the
  // recipe, which takes that ingredient off `missing`, and rows disappearing
  // from under the brewer mid-list is no way to work down one.
  const [pricingGaps, setPricingGaps] = useState<UnpricedIngredient[] | null>(null);
  // The recipe-wide figures come from the server, which pools repeats of one
  // product before rounding to packages — summing the per-line prices here would
  // charge three bags for three small additions of the same hop.
  const { usedDkk, buyDkk, priced, unpriced, purchase } = recipe.cost;
  if (!pricing.available || priced + unpriced === 0) return null;

  const perLitre = recipe.batchSizeL ? usedDkk / recipe.batchSizeL : null;
  const shoppingList = purchase
    .map(
      (p) =>
        `${p.packages}×${p.packageSizeG != null ? `${p.packageSizeG} g ` : ''}${p.name} — ${kr(
          p.totalDkk,
          0,
        )}`,
    )
    .join('\n');

  return (
    <section className="h-full rounded-xl border border-zinc-800 bg-zinc-900 px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            Ingredient cost
          </div>
          <div className="text-2xl font-semibold tabular-nums text-zinc-50">
            {priced > 0 ? kr(usedDkk, 0) : '—'}
          </div>
        </div>
        {perLitre != null && priced > 0 && (
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Per litre
            </div>
            <div className="text-lg font-semibold tabular-nums text-zinc-200">
              {kr(perLitre, 2)}
            </div>
          </div>
        )}
        {priced > 0 && buyDkk > usedDkk && (
          <div
            title={`What the shop charges — whole packages, pooled per product:\n\n${shoppingList}`}
          >
            <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              To buy
            </div>
            <div className="text-lg font-semibold tabular-nums text-zinc-200">{kr(buyDkk, 0)}</div>
          </div>
        )}
        <div className="ml-auto text-right text-xs text-zinc-500">
          <div>
            {[
              fermentables.priced > 0 && `Malt ${kr(fermentables.usedDkk, 0)}`,
              hops.priced > 0 && `Hops ${kr(hops.usedDkk, 0)}`,
              yeast.priced > 0 && `Yeast ${kr(yeast.usedDkk, 0)}`,
              other.priced > 0 && `Other ${kr(other.usedDkk, 0)}`,
            ]
              .filter(Boolean)
              .join(' · ') || 'Nothing priced'}
          </div>
          <div className="mt-0.5">
            {unpriced > 0 && (
              <span className="text-amber-500/80">
                {/* The count is the natural place to ask "which ones?", so it
                    opens the list — and, for an admin, the boxes that price
                    them. A guest sees the same sentence as plain text. */}
                {editable && missing.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setPricingGaps(missing)}
                    title="Show these ingredients and set their prices"
                    className="underline decoration-amber-500/40 underline-offset-4 transition hover:text-amber-300 hover:decoration-amber-400"
                  >
                    {unpriced} of {priced + unpriced} ingredient
                    {priced + unpriced === 1 ? '' : 's'} not in the catalogue
                  </button>
                ) : (
                  <>
                    {unpriced} of {priced + unpriced} ingredient
                    {priced + unpriced === 1 ? '' : 's'} not in the catalogue
                  </>
                )}
                {' · '}
              </span>
            )}
            {pricing.source} prices
            {pricing.lastChecked && `, checked ${pricing.lastChecked}`}
          </div>
        </div>
      </div>
      {pricingGaps && (
        <UnpricedIngredientsDialog
          lines={pricingGaps}
          onClose={() => setPricingGaps(null)}
          onChanged={onChanged}
        />
      )}
    </section>
  );
}

/**
 * The hop schedule, split into the stages of brew day — bittering in the boil,
 * then whirlpool, then dry hops — because that's how the additions are actually
 * used, and a flat list of seven rows makes "what goes in when" hard to read.
 * Each stage carries its own weight subtotal.
 *
 * Only stages this recipe uses get a heading, and within a stage the additions
 * run in the order the brewer performs them. For the kettle that's longest
 * contact first — a 60 min charge goes in before a 20 min one. Dry hops sort the
 * other way: their shorter contact times are the high-krausen charges dropped in
 * during active fermentation, so ascending puts those ahead of the longer
 * post-fermentation dry hop that follows.
 */
function HopSchedule({
  hops,
  editable,
  onChanged,
}: { hops: RecipeHop[] } & RowPricing): JSX.Element {
  const stages = HOP_STAGE_ORDER.map((stage) => ({
    stage,
    additions: hops
      .filter((h) => h.stage === stage)
      .sort((a, b) => {
        const byTime = (Number.parseFloat(a.time) || 0) - (Number.parseFloat(b.time) || 0);
        return stage === 'Dry Hop' ? byTime : -byTime;
      }),
  })).filter((group) => group.additions.length > 0);

  return (
    <div>
      {stages.map(({ stage, additions }) => {
        const grams = additions.reduce((sum, h) => sum + toG(h.amount, h.unit), 0);
        const ibu = additions.reduce((sum, h) => sum + (Number.parseFloat(h.ibu) || 0), 0);
        const cost = sumCost(additions);
        return (
          <div key={stage} className="border-b border-zinc-800 last:border-b-0">
            <div className="flex items-center gap-2 bg-zinc-950/50 px-4 py-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-300">
                {stage}
              </span>
              <span className="text-[11px] text-zinc-500">
                {grams.toFixed(0)} g
                {ibu > 0 && ` · ${ibu.toFixed(1)} IBU`}
              </span>
              {cost.priced > 0 && (
                <span className="ml-auto text-[11px] tabular-nums text-zinc-400">
                  {kr(cost.usedDkk, 0)}
                </span>
              )}
            </div>
            <ul className="divide-y divide-zinc-800/60">
              {additions.map((h, i) => (
                <HopRow
                  key={`${h.name}-${i}`}
                  hop={h}
                  stage={stage}
                  editable={editable}
                  onChanged={onChanged}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/**
 * One hop addition. Priced per addition even though repeats of one hop pool into
 * a single bag at the till — a decision made here therefore moves every other
 * addition of the same hop, which is what the picker's footnote says.
 */
function HopRow({
  hop: h,
  stage,
  editable,
  onChanged,
}: { hop: RecipeHop; stage: HopStage } & RowPricing): JSX.Element {
  const { open, setOpen } = usePricePicker();
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <IngredientName
            name={h.name}
            editable={editable}
            onClick={() => setOpen(!open)}
            className="min-w-0 text-sm text-zinc-100"
          />
          {h.aa && (
            <span className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-400">
              {h.aa}% AA
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-zinc-500">
          {[
            `${h.amount}${h.unit ? ` ${h.unit}` : ''}`,
            h.form,
            hopTiming(h),
            h.temp && `@ ${h.temp}°C`,
            h.utilization && `${h.utilization}% utilisation`,
            // The recipe's own wording, but only when it says more than the
            // stage heading already does.
            h.use !== stage ? h.use : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
      {h.ibu && Number.parseFloat(h.ibu) > 0 && (
        <span className="shrink-0 text-sm text-zinc-400">{fmt(h.ibu, 1)} IBU</span>
      )}
      <PriceCell
        line={{ kind: 'hop', name: h.name, grams: h.grams, price: h.price }}
        editable={editable}
        open={open}
        onOpenChange={setOpen}
        onChanged={onChanged}
      />
    </li>
  );
}

/**
 * One yeast pitch, with whatever the producer's data includes — the temperature
 * range matters most (it's the number you set the fermenter's Inkbird to), so it
 * gets its own line rather than being buried in the meta list.
 */
function YeastRow({
  yeast: y,
  editable,
  onChanged,
}: { yeast: RecipeYeast } & RowPricing): JSX.Element {
  const { open, setOpen } = usePricePicker();
  const range =
    y.minTempC != null && y.maxTempC != null
      ? `${y.minTempC}–${y.maxTempC}°C`
      : y.minTempC != null
        ? `from ${y.minTempC}°C`
        : y.maxTempC != null
          ? `up to ${y.maxTempC}°C`
          : null;

  const facts = [
    y.amount && `${y.amount}${y.amountUnit ? ` ${y.amountUnit}` : ''}`,
    y.lab,
    y.form,
    y.type,
    y.attenuation && `${y.attenuation}% attenuation`,
    y.flocculation && `${y.flocculation} flocculation`,
    y.alcoholTolerance && `${y.alcoholTolerance} alcohol tolerance`,
    y.starter ? 'starter' : '',
  ].filter(Boolean);

  return (
    <li className="px-4 py-2.5">
      <div className="flex items-center gap-3">
        <IngredientName
          name={y.name}
          editable={editable}
          onClick={() => setOpen(!open)}
          className="min-w-0 flex-1 text-sm text-zinc-100"
        />
        {range && (
          <span
            className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs font-semibold text-zinc-200"
            title="Producer's recommended fermentation temperature"
          >
            {range}
          </span>
        )}
        <PriceCell
          line={{ kind: 'yeast', name: y.name, grams: y.grams, units: y.units, price: y.price }}
          editable={editable}
          open={open}
          onOpenChange={setOpen}
          onChanged={onChanged}
        />
      </div>
      {facts.length > 0 && (
        <div className="mt-0.5 text-xs text-zinc-500">{facts.join(' · ')}</div>
      )}
    </li>
  );
}

/** The six brewing ions, in the order the water calculator lists them. */
const IONS: { key: keyof RecipeWaterProfile; label: string; symbol: string; param: string }[] = [
  { key: 'calcium', label: 'Calcium', symbol: 'Ca²⁺', param: 'ca' },
  { key: 'magnesium', label: 'Magnesium', symbol: 'Mg²⁺', param: 'mg' },
  { key: 'sodium', label: 'Sodium', symbol: 'Na⁺', param: 'na' },
  { key: 'chloride', label: 'Chloride', symbol: 'Cl⁻', param: 'cl' },
  { key: 'sulfate', label: 'Sulfate', symbol: 'SO₄²⁻', param: 'so4' },
  { key: 'bicarbonate', label: 'Bicarbonate', symbol: 'HCO₃⁻', param: 'hco3' },
];

/**
 * The recipe's target water chemistry as ppm, plus a hand-off to the water
 * calculator. Deliberately no salt weights here: turning a target profile into
 * grams of gypsum depends on the source water and the *total* mash + sparge
 * volume, which the calculator already solves properly — so this section states
 * the targets and sends them there rather than doing its own arithmetic.
 */
function WaterSection({
  profile,
  recipe,
}: {
  profile: RecipeWaterProfile;
  recipe: RecipeDetail;
}): JSX.Element {
  const present = IONS.filter((ion) => profile[ion.key] != null);

  // Everything the calculator needs to open on this recipe's target.
  const params = new URLSearchParams();
  for (const ion of present) params.set(ion.param, String(profile[ion.key]));
  if (recipe.batchSizeL != null) params.set('volume', String(recipe.batchSizeL));
  params.set('recipe', recipe.name);
  params.set('recipeId', recipe.id);

  return (
    <div className="space-y-3 p-4">
      {profile.sourceName && (
        <div className="text-sm text-zinc-400">
          Source water: <span className="text-zinc-200">{profile.sourceName}</span>
        </div>
      )}
      {present.length > 0 && (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          {present.map((ion) => (
            <div key={ion.key} className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
              <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                {ion.label}
              </div>
              <div className="text-base font-semibold text-zinc-50">{profile[ion.key]}</div>
              <div className="text-[11px] text-zinc-500">
                {ion.symbol} · ppm
              </div>
            </div>
          ))}
        </div>
      )}

      {(profile.ph || profile.notes) && (
        <dl className="space-y-1 text-sm">
          {profile.ph && (
            <div className="flex gap-2">
              {/* The mash pH the grist and water are calculated to land at —
                  what the editor stores here — not a target anybody typed. */}
              <dt className="text-zinc-500">Estimated mash pH</dt>
              <dd className="text-zinc-200">{profile.ph}</dd>
            </div>
          )}
          {profile.notes && (
            <div className="flex gap-2">
              <dt className="shrink-0 text-zinc-500">Notes</dt>
              <dd className="text-zinc-200">{profile.notes}</dd>
            </div>
          )}
        </dl>
      )}

      {present.length > 0 && (
        <Link
          to={`/water?${params.toString()}`}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-[#f87a68] to-[#e0463f] px-3 py-1.5 text-sm font-semibold text-white shadow transition hover:brightness-110"
        >
          Open in water calculator →
        </Link>
      )}
    </div>
  );
}
