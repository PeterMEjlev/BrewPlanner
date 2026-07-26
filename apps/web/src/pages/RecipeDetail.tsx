import type {
  Recipe,
  RecipeDetail,
  RecipeHop,
  RecipeWaterProfile,
} from '@checklist/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { canControl, useAuth } from '../auth';
import { ebcColor } from '../beerColor';
import { DashboardShell } from '../components/DashboardShell';
import { asCleanMessage } from '../util';

/**
 * One recipe's full brew sheet — the page the Recipes grid opens. Everything the
 * brewer needs while actually brewing: the numbers up top, then the grain bill,
 * hop schedule, yeast, mash steps and water targets, each collapsible so a long
 * recipe can be narrowed to the section in use.
 *
 * The data is a separate (heavier) server call than the recipe list — Brewer's
 * Friend only returns ingredients when asked — so this page fetches on open.
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

/**
 * A 60-minute addition is the bittering charge. It's excluded from the hop-rate
 * figure because that number is about aroma intensity — a big first-wort charge
 * would inflate it without making the beer smell of anything.
 */
function isBittering(hop: RecipeHop): boolean {
  return Number.parseFloat(hop.time) === 60;
}

export function RecipeDetailPage(): JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const { auth } = useAuth();
  const controllable = canControl(auth);

  const [recipe, setRecipe] = useState<RecipeDetail | null>(null);
  const [active, setActive] = useState<Recipe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
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
          api.getRecipe(id),
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

  const totals = useMemo(() => {
    if (!recipe) return null;
    const grainKg = recipe.fermentables.reduce((sum, f) => sum + toKg(f.amount, f.unit), 0);
    const hopsG = recipe.hops.reduce((sum, h) => sum + toG(h.amount, h.unit), 0);
    const aromaG = recipe.hops
      .filter((h) => !isBittering(h))
      .reduce((sum, h) => sum + toG(h.amount, h.unit), 0);
    return {
      grainKg,
      hopsG,
      // Only meaningful with a batch size to divide by.
      aromaRate: recipe.batchSizeL ? aromaG / recipe.batchSizeL : null,
    };
  }, [recipe]);

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

  const color = ebcColor(recipe.ebc);
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
              <Swatch color={color} className="h-4 w-4" ebc={recipe.ebc} />
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
          <Stat label="EBC" value={fmt(recipe.ebc, 1)} swatch={color} ebc={recipe.ebc} />
          {recipe.mashTemp && <Stat label="Mash" value={recipe.mashTemp} />}
          {recipe.fermentationTemp && <Stat label="Fermentation" value={recipe.fermentationTemp} />}
        </div>

        <div className="mt-4 space-y-3">
          {recipe.fermentables.length > 0 && totals && (
            <Section
              title="Fermentables"
              icon="🌾"
              meta={`${totals.grainKg.toFixed(2)} kg`}
              open={!collapsed.fermentables}
              onToggle={() => toggle('fermentables')}
            >
              <ul className="divide-y divide-zinc-800">
                {sorted.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center gap-3 px-4 py-2.5">
                    <Swatch color={ebcColor(f.ebc)} className="h-3 w-3" ebc={f.ebc} />
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-100">{f.name}</span>
                    <span className="shrink-0 text-sm text-zinc-400">
                      {f.amount} {f.unit}
                      {f.percent && <span className="text-zinc-500"> · {f.percent}%</span>}
                      {f.ebc != null && <span className="text-zinc-500"> · {f.ebc} EBC</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {recipe.hops.length > 0 && totals && (
            <Section
              title="Hops"
              icon="🌿"
              meta={
                totals.aromaRate != null
                  ? `${totals.hopsG.toFixed(0)} g · ${totals.aromaRate.toFixed(1)} g/L aroma`
                  : `${totals.hopsG.toFixed(0)} g`
              }
              metaTitle="Aroma hop rate — grams per litre, excluding the 60 min bittering charge"
              open={!collapsed.hops}
              onToggle={() => toggle('hops')}
            >
              <ul className="divide-y divide-zinc-800">
                {recipe.hops.map((h, i) => (
                  <li key={`${h.name}-${i}`} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm text-zinc-100">{h.name}</span>
                        {h.aa && (
                          <span className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-400">
                            {h.aa}% AA
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-zinc-500">
                        {[
                          `${h.amount}${h.unit ? ` ${h.unit}` : ''}`,
                          h.use && h.temp ? `${h.use} @ ${h.temp}°C` : h.use,
                          h.time && `${h.time} min`,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>
                    {h.ibu && (
                      <span className="shrink-0 text-sm text-zinc-400">{fmt(h.ibu, 1)} IBU</span>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {recipe.otherIngredients.length > 0 && (
            <Section
              title="Other ingredients"
              icon="🧪"
              meta={`${recipe.otherIngredients.length}`}
              open={!collapsed.other}
              onToggle={() => toggle('other')}
            >
              <ul className="divide-y divide-zinc-800">
                {recipe.otherIngredients.map((m, i) => (
                  <li key={`${m.name}-${i}`} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-100">{m.name}</span>
                    <span className="shrink-0 text-sm text-zinc-400">
                      {[
                        `${m.amount}${m.unit ? ` ${m.unit}` : ''}`,
                        m.type,
                        m.use,
                        m.time && `${m.time} min`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {recipe.yeast.length > 0 && (
            <Section
              title="Yeast"
              icon="🧫"
              open={!collapsed.yeast}
              onToggle={() => toggle('yeast')}
            >
              <ul className="divide-y divide-zinc-800">
                {recipe.yeast.map((y, i) => (
                  <li key={`${y.name}-${i}`} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-100">{y.name}</span>
                    <span className="shrink-0 text-sm text-zinc-400">
                      {[
                        y.amount && `${y.amount}${y.amountUnit ? ` ${y.amountUnit}` : ''}`,
                        y.lab,
                        y.attenuation && `${y.attenuation}% attenuation`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {recipe.mashGuidelines && (
            <Section
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
              <ol className="divide-y divide-zinc-800">
                {recipe.mashGuidelines.steps.map((s, i) => (
                  <li key={i} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-700 text-xs font-semibold text-zinc-400">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-100">
                      {s.name || `Step ${i + 1}`}
                    </span>
                    <span className="shrink-0 text-sm text-zinc-400">
                      {[s.temp, s.time && `${s.time} min`, s.amount].filter(Boolean).join(' · ')}
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
            </Section>
          )}

          {recipe.waterProfile && (
            <Section
              title="Water profile"
              icon="💧"
              meta={recipe.waterProfile.name ?? undefined}
              open={!collapsed.water}
              onToggle={() => toggle('water')}
            >
              <WaterSection profile={recipe.waterProfile} recipe={recipe} />
            </Section>
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
}: {
  color: string | null;
  ebc: string | number | null;
  className: string;
}): JSX.Element {
  return (
    <span
      className={`${className} shrink-0 rounded-full ${color ? '' : 'border border-zinc-600'}`}
      style={color ? { backgroundColor: color } : undefined}
      title={color ? `${ebc} EBC` : 'Colour unknown'}
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
}: {
  label: string;
  value: string;
  swatch?: string | null;
  ebc?: string;
}): JSX.Element {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-3.5 py-2.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-0.5 flex items-center gap-2 text-lg font-semibold text-zinc-50">
        {value}
        {swatch !== undefined && <Swatch color={swatch} ebc={ebc ?? null} className="h-3.5 w-3.5" />}
      </div>
    </div>
  );
}

/** A collapsible block of the brew sheet. */
function Section({
  title,
  icon,
  meta,
  metaTitle,
  open,
  onToggle,
  children,
}: {
  title: string;
  icon: string;
  /** Summary shown next to the title (a total, a count, a profile name). */
  meta?: string;
  /** Tooltip explaining `meta` when the number needs a caveat. */
  metaTitle?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition hover:bg-zinc-800/50"
      >
        <span aria-hidden>{icon}</span>
        <span className="text-sm font-semibold text-zinc-100">{title}</span>
        {meta && (
          <span className="truncate text-xs text-zinc-500" title={metaTitle}>
            {meta}
          </span>
        )}
        <span
          className={`ml-auto shrink-0 text-zinc-500 transition-transform ${open ? '' : '-rotate-90'}`}
          aria-hidden
        >
          ⌄
        </span>
      </button>
      {open && <div className="border-t border-zinc-800">{children}</div>}
    </section>
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
              <dt className="text-zinc-500">Target pH</dt>
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
