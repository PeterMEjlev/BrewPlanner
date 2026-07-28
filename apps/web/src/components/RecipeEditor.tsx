import {
  applyRecipeCalculations,
  calculateRecipe,
  DEFAULT_RECIPE_SETTINGS,
  estimateFermentablePpg,
  getRecipeColor,
  HOP_STAGE_ORDER,
  isFermentableLine,
  withAutoBoilVolumes,
} from '@checklist/shared';
import type {
  HopStage,
  RecipeDetail,
  RecipeEditInput,
  RecipeFermentableEdit,
  RecipeHopEdit,
  RecipeMashStep,
  RecipeOtherIngredientEdit,
  RecipeSettings,
  RecipeWaterProfile,
  RecipeYeastEdit,
} from '@checklist/shared';
import { useId, useMemo, useState } from 'react';
import { TARGET_PRESETS } from '../water';
import {
  ALL_STYLE_CATEGORIES,
  ALL_SUBSTYLES,
  BATCH_TARGETS,
  categoryIsStyle,
  COUNT_UNITS,
  DEFAULT_STYLE_CATEGORIES,
  FLOCCULATION_OPTIONS,
  HOP_FORMS,
  isKnownStyleCategory,
  MASH_TYPES,
  OTHER_TYPES,
  OTHER_USES,
  PITCH_RATES,
  substylesFor,
  VOLUME_UNITS,
  WATER_SOURCES,
  WEIGHT_UNITS,
  YEAST_FORMS,
  YEAST_TYPES,
} from '../recipeCatalog';
import type { StyleChoice } from '../recipeCatalog';
import { setSetting, useSettings } from '../settings';
import { rangeForStyle } from '../styleRanges';
import { useKegContentColors } from '../kegContentColors';
import { IngredientSearchSelect, SearchableSelect } from './SearchableSelect';

interface Props {
  recipe: RecipeDetail;
  saving: boolean;
  error: string | null;
  onSave: (recipe: RecipeEditInput) => Promise<void>;
  onCancel: () => void;
}

const fieldClass =
  'mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-[#f06a5c] focus:ring-1 focus:ring-[#f06a5c]/40';

function editable(recipe: RecipeDetail): RecipeEditInput {
  return {
    name: recipe.name,
    style: recipe.style,
    settings: { ...DEFAULT_RECIPE_SETTINGS, ...recipe.settings },
    og: recipe.og,
    preBoilGravity: recipe.preBoilGravity,
    postBoilGravity: recipe.postBoilGravity,
    fg: recipe.fg,
    abv: recipe.abv,
    ibu: recipe.ibu,
    ebc: recipe.ebc,
    ebcEstimated: recipe.ebcEstimated,
    batchSizeL: recipe.batchSizeL,
    mashTemp: recipe.mashTemp,
    fermentationTemp: recipe.fermentationTemp,
    fermentables: recipe.fermentables.map(({ grams: _grams, price: _price, ...line }) => ({
      ...line,
      amount: fermentableAmountKg(line.amount, line.unit),
      unit: 'kg',
      ppg: line.ppg ?? null,
    })),
    hops: recipe.hops.map(({ grams: _grams, price: _price, ...line }) => ({
      ...line,
      form: line.form || 'Pellet',
      utilization: line.utilization || '',
    })),
    yeast: recipe.yeast.map(({ grams: _grams, units: _units, price: _price, ...line }) => line),
    otherIngredients: recipe.otherIngredients.map(
      ({ grams: _grams, units: _units, price: _price, ...line }) => ({
        ...line,
        timeUnit: line.timeUnit || '',
      }),
    ),
    mashGuidelines: recipe.mashGuidelines
      ? {
          startingThicknessLPerKg: recipe.mashGuidelines.startingThicknessLPerKg ?? null,
          grainTempC: recipe.mashGuidelines.grainTempC ?? null,
          autoStrikeVolume: recipe.mashGuidelines.autoStrikeVolume ?? false,
          steps: recipe.mashGuidelines.steps.map(normalizeMashStep),
          notes: recipe.mashGuidelines.notes,
        }
      : null,
    waterProfile: recipe.waterProfile ? { ...recipe.waterProfile } : null,
  };
}

function normalizeMashStep(step: RecipeMashStep): RecipeMashStep {
  if (step.amountUnit || !step.amount) return { ...step };
  const match = /^\s*([+-]?[\d.,]+)\s*(L|ml|gal|qt)\s*$/i.exec(step.amount);
  return match
    ? { ...step, amount: match[1]!, amountUnit: match[2]! }
    : { ...step };
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function nullableNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function fermentableAmountKg(amount: string, unit: string): string {
  const parsed = nullableNumber(amount);
  if (parsed == null) return amount;
  const kilograms = unit.trim().toLocaleLowerCase() === 'g'
    ? parsed / 1_000
    : unit.trim().toLocaleLowerCase() === 'lb' || unit.trim().toLocaleLowerCase() === 'lbs'
      ? parsed * 0.45359237
      : unit.trim().toLocaleLowerCase() === 'oz'
        ? parsed * 0.028349523125
        : parsed;
  return String(Math.round(kilograms * 10_000) / 10_000);
}

const WEIGHT_TO_KG: Record<string, number> = { kg: 1, g: 0.001, lb: 0.45359237, lbs: 0.45359237, oz: 0.028349523125 };

/**
 * A set of weighed lines summed to kilograms. An unrecognised or blank unit
 * falls back to `fallbackUnit` — the target the caller is about to display in
 * — so a bare number on an otherwise-untouched row reads as "already in that
 * unit" rather than as a stray kilogram.
 */
function sumWeightKg(lines: Array<{ amount: string; unit: string }>, fallbackUnit: 'kg' | 'g' = 'kg'): number {
  const fallback = WEIGHT_TO_KG[fallbackUnit] ?? 1;
  return lines.reduce((sum, line) => {
    const parsed = nullableNumber(line.amount);
    if (parsed == null) return sum;
    const factor = WEIGHT_TO_KG[line.unit.trim().toLocaleLowerCase()] ?? fallback;
    return sum + parsed * factor;
  }, 0);
}

/**
 * A section's grain/hop bill boiled down to one figure for its title — "12.5
 * kg" beside "Fermentables 5" — so the sheet's scale reads without opening
 * every row. Only sections where every line is a weight belong here: mixing a
 * hop's grams with a fining's millilitres would add units that don't add.
 * Null when nothing in the section has a usable amount yet, so an empty or
 * half-filled section's title stays plain.
 */
function totalWeight(lines: Array<{ amount: string; unit: string }>, displayUnit: 'kg' | 'g'): string | null {
  const totalKg = sumWeightKg(lines, displayUnit);
  if (totalKg <= 0) return null;
  const value = displayUnit === 'kg' ? totalKg : totalKg * 1_000;
  return `${Math.round(value * 100) / 100} ${displayUnit}`;
}

/** Strike water per kilo of grain when the recipe hasn't said otherwise. */
export const DEFAULT_MASH_THICKNESS_L_PER_KG = 3;

/**
 * The draft with the first mash step's strike volume filled in from the grain
 * bill — total malt weight × the section's own mash thickness — whenever
 * `autoStrikeVolume` is ticked. Deriving it on render rather than writing it
 * into the draft is what keeps the box a live readout: the "Calculate
 * automatically" checkbox owns the field the same way the boil-volume boxes
 * own theirs, and unticking it is what hands the current number back for the
 * brewer to adjust.
 *
 * Only the first step. A later infusion or sparge addition is a decision about
 * the schedule, not a function of the grain bill.
 */
function withDerivedStrikeVolume(recipe: RecipeEditInput): RecipeEditInput {
  const guidelines = recipe.mashGuidelines;
  const first = guidelines?.steps[0];
  if (!guidelines || !first || !guidelines.autoStrikeVolume) return recipe;
  const thickness = guidelines.startingThicknessLPerKg ?? DEFAULT_MASH_THICKNESS_L_PER_KG;
  const litres = sumWeightKg(recipe.fermentables) * thickness;
  return {
    ...recipe,
    mashGuidelines: {
      ...guidelines,
      steps: guidelines.steps.map((step, index) => index === 0
        ? { ...step, amount: litres > 0 ? String(Math.round(litres * 100) / 100) : '', amountUnit: step.amountUnit || 'L' }
        : step),
    },
  };
}

function options(values: readonly string[]): { value: string }[] {
  return values.map((value) => ({ value }));
}

export function RecipeEditor({ recipe, saving, error, onSave, onCancel }: Props): JSX.Element {
  const initial = useMemo(() => editable(recipe), [recipe]);
  const [draft, setDraft] = useState<RecipeEditInput>(initial);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  // The draft as the brewer sees it: a ticked "calculate automatically" box owns
  // its volume field, so the derived figure — not the stale stored one — is what
  // the field shows and what every statistic below is calculated from. Deriving
  // it on render rather than writing it back keeps the box's own number out of
  // the draft until the box is unticked or the recipe saved.
  const effective = useMemo(() => withAutoBoilVolumes(withDerivedStrikeVolume(draft)), [draft]);
  const calculation = useMemo(() => calculateRecipe(effective), [effective]);
  const styleRange = useMemo(
    () => rangeForStyle(draft.settings.styleSubcategory || draft.style),
    [draft.settings.styleSubcategory, draft.style],
  );
  const prefs = useSettings();
  // The same palette the keg board and recipe list wear a beer's colour from,
  // so a style reads as the same swatch everywhere it shows up.
  const kegColors = useKegContentColors();
  const [editingCategories, setEditingCategories] = useState(false);
  const [editingSubstyles, setEditingSubstyles] = useState(false);
  const categories = useMemo(() => {
    // The recipe's saved category stays selectable even when the brewer has
    // taken it out of the dropdown — a Brewer's Friend import arrives filed
    // under a BJCP group nobody put there by hand. Keyed off the *saved* value,
    // not the draft: the field reports every keystroke, and half-typed text is
    // not a category.
    const saved = initial.settings.styleCategory;
    return saved && !prefs.recipeStyleCategories.includes(saved)
      ? [...prefs.recipeStyleCategories, saved]
      : prefs.recipeStyleCategories;
  }, [prefs.recipeStyleCategories, initial.settings.styleCategory]);
  // A category we recognise narrows the substyles to its own — to none at all
  // for Brown Ale or Weissbeer, which have none. One we don't (blank, or typed
  // freehand) can't narrow anything, so it offers every substyle in the dropdown.
  const knownCategory = isKnownStyleCategory(draft.settings.styleCategory);
  const hiddenSubstyles = useMemo(
    () => new Set(prefs.recipeHiddenSubstyles),
    [prefs.recipeHiddenSubstyles],
  );
  const styleChoices: StyleChoice[] = useMemo(() => {
    const offered = (known: string): StyleChoice[] => substylesFor(known)
      .filter((value) => !hiddenSubstyles.has(value))
      .map((value) => ({ category: known, value }));
    const category = draft.settings.styleCategory;
    return isKnownStyleCategory(category) ? offered(category) : categories.flatMap(offered);
  }, [categories, draft.settings.styleCategory, hiddenSubstyles]);
  // A family with no substyle of its own becomes the recipe's style; the substyle
  // box stays empty for it rather than echoing the category back at the brewer.
  const substyle = draft.settings.styleSubcategory
    || (draft.style === draft.settings.styleCategory ? '' : draft.style);

  function cancel(): void {
    if (!dirty || window.confirm('Discard your unsaved recipe changes?')) onCancel();
  }

  function updateSettings(patch: Partial<RecipeSettings>): void {
    setDraft((current) => ({
      ...current,
      settings: { ...current.settings, ...patch },
    }));
  }

  /** Moving to another category drops the substyle that belonged to the old one. */
  function selectStyleCategory(styleCategory: string): void {
    setDraft((current) => {
      const settings = { ...current.settings, styleCategory };
      const chosen = current.settings.styleSubcategory || current.style;
      // The field reports every keystroke, so half-typed text must leave the
      // style alone: only a category we recognise may clear the substyle.
      if (!isKnownStyleCategory(styleCategory) || substylesFor(styleCategory).includes(chosen)) {
        return { ...current, settings };
      }
      settings.styleSubcategory = '';
      // A family carries the recipe until a substyle is picked; a BJCP group
      // heading ("21. IPA") names no beer, so it leaves the style empty.
      return { ...current, style: categoryIsStyle(styleCategory) ? styleCategory : '', settings };
    });
  }

  function selectStyleSubcategory(styleSubcategory: string): void {
    setDraft((current) => ({
      ...current,
      style: styleSubcategory
        || (categoryIsStyle(current.settings.styleCategory) ? current.settings.styleCategory : ''),
      settings: { ...current.settings, styleSubcategory },
    }));
  }

  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        // Saved from the effective draft, so the strike volume the brewer has
        // been reading is the one that lands on the sheet.
        void onSave(applyRecipeCalculations(withDerivedStrikeVolume(draft)));
      }}
    >
      <div className="rounded-xl border border-sky-500/25 bg-sky-500/10 px-4 py-3 text-sm text-sky-100">
        <div className="font-semibold">Stored in BrewPlanner</div>
        <p className="mt-0.5 text-sky-200/80">
          {recipe.url
            ? 'This recipe was imported from Brewer’s Friend. Changes are saved to the app; the original link remains available for reference.'
            : 'Search the local catalogues or type a custom ingredient. The complete brew sheet is saved directly to BrewPlanner.'}
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <EditorSection title="Recipe setup" description="The same core setup fields used by the Brewer’s Friend editor.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Recipe name" value={draft.name} required className="sm:col-span-2 lg:col-span-4" onChange={(name) => setDraft((d) => ({ ...d, name }))} />
          <div className="sm:col-span-2">
            <SearchableSelect
              label="Style category"
              value={draft.settings.styleCategory}
              options={categories.map((value) => ({ value, swatchColor: getRecipeColor({ name: '', style: value }, kegColors) }))}
              onChange={selectStyleCategory}
            />
            <EditListToggle open={editingCategories} onToggle={() => setEditingCategories((open) => !open)} />
          </div>
          <div className="sm:col-span-2">
            <SearchableSelect
              label="Style / subcategory"
              value={substyle}
              options={styleChoices.map((choice) => ({ value: choice.value, description: choice.category, swatchColor: getRecipeColor({ name: '', style: choice.value }, kegColors) }))}
              onChange={selectStyleSubcategory}
              placeholder={knownCategory && styleChoices.length === 0
                ? `No substyles — saved as ${draft.settings.styleCategory}`
                : undefined}
              testId="recipe-style-select"
            />
            <EditListToggle open={editingSubstyles} onToggle={() => setEditingSubstyles((open) => !open)} />
          </div>
          {editingCategories && (
            <StyleCategoryEditor
              categories={prefs.recipeStyleCategories}
              onChange={(next) => setSetting('recipeStyleCategories', next)}
              className="sm:col-span-2 lg:col-span-4"
            />
          )}
          {editingSubstyles && (
            <SubstyleEditor
              categories={prefs.recipeStyleCategories}
              hiddenSubstyles={prefs.recipeHiddenSubstyles}
              onChange={(next) => setSetting('recipeHiddenSubstyles', next)}
              className="sm:col-span-2 lg:col-span-4"
            />
          )}

          <Field label="Batch size" value={draft.batchSizeL} suffix="L" type="number" step="any" onChange={(value) => setDraft((d) => ({ ...d, batchSizeL: nullableNumber(value) }))} />
          <SelectField label="Batch target" value={draft.settings.batchTarget} options={options(BATCH_TARGETS)} onChange={(batchTarget) => updateSettings({ batchTarget })} />
          <Field label="Boil time" value={draft.settings.boilTimeMinutes} suffix="min" type="number" step="any" onChange={(value) => updateSettings({ boilTimeMinutes: nullableNumber(value) })} />
          <Field label="Brewhouse efficiency" value={draft.settings.efficiencyPercent} suffix="%" type="number" step="any" onChange={(value) => updateSettings({ efficiencyPercent: nullableNumber(value) })} />

          <div>
            <Field
              label="Pre-boil size"
              value={effective.settings.boilSizePreL}
              suffix="L"
              type="number"
              step="any"
              disabled={draft.settings.autoBoilSizePre}
              placeholder={draft.settings.autoBoilSizePre ? 'Needs a batch size' : undefined}
              onChange={(value) => updateSettings({ boilSizePreL: nullableNumber(value) })}
            />
            <Check
              label="Calculate automatically"
              checked={draft.settings.autoBoilSizePre}
              // Unticking hands back the number the box was showing, so the
              // brewer adjusts the calculated volume instead of an empty field.
              onChange={(autoBoilSizePre) => updateSettings(autoBoilSizePre
                ? { autoBoilSizePre }
                : { autoBoilSizePre, boilSizePreL: effective.settings.boilSizePreL })}
            />
          </div>
          <div>
            <Field
              label="Post-boil size"
              value={effective.settings.boilSizePostL}
              suffix="L"
              type="number"
              step="any"
              disabled={draft.settings.autoBoilSizePost}
              placeholder={draft.settings.autoBoilSizePost ? 'Needs a batch size' : undefined}
              onChange={(value) => updateSettings({ boilSizePostL: nullableNumber(value) })}
            />
            <Check
              label="Calculate automatically"
              checked={draft.settings.autoBoilSizePost}
              onChange={(autoBoilSizePost) => updateSettings(autoBoilSizePost
                ? { autoBoilSizePost }
                : { autoBoilSizePost, boilSizePostL: effective.settings.boilSizePostL })}
            />
          </div>
        </div>
      </EditorSection>

      <EditorSection title="Calculated recipe statistics" description="Updates live from the grain bill, batch volumes, hops, yeast attenuation, and water profile. Mash pH is an estimate.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          <CalculatedStat label="Pre-boil gravity" value={calculation.preBoilGravity} decimals={3} />
          <CalculatedStat label="Post-boil gravity" value={calculation.postBoilGravity} decimals={3} />
          <CalculatedStat label="Original gravity" value={calculation.originalGravity} decimals={3} />
          <CalculatedStat label="Final gravity" value={calculation.finalGravity} decimals={3} />
          <CalculatedStat label="ABV" value={calculation.abv} decimals={2} suffix="%" range={styleRange?.abv} compareToStyle />
          <CalculatedStat label="IBU" value={calculation.ibu} decimals={1} range={styleRange?.ibu} compareToStyle />
          <CalculatedStat label="EBC" value={calculation.ebc} decimals={1} range={styleRange?.ebc} compareToStyle />
          <CalculatedStat label="Mash pH estimate" value={calculation.mashPh} decimals={2} />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Mash temperature" value={draft.mashTemp} placeholder="67°C" onChange={(value) => setDraft((d) => ({ ...d, mashTemp: nullable(value) }))} />
          <Field label="Fermentation temperature" value={draft.fermentationTemp} placeholder="19°C" onChange={(value) => setDraft((d) => ({ ...d, fermentationTemp: nullable(value) }))} />
        </div>
      </EditorSection>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <div className="space-y-4">
          <EditorSection title="Fermentables" count={draft.fermentables.length} total={totalWeight(draft.fermentables, 'kg') ?? undefined} onAdd={() => setDraft((d) => ({ ...d, fermentables: [...d.fermentables, blankFermentable()] }))}>
            <div className="space-y-3">
              {draft.fermentables.map((line, index) => (
                <LineCard key={index} label={`Fermentable ${index + 1}`} onRemove={() => setDraft((d) => ({ ...d, fermentables: d.fermentables.filter((_, i) => i !== index) }))}>
                  <div className="grid gap-3 sm:grid-cols-8">
                    <Field label="Amount" value={line.amount} suffix="kg" className="sm:col-span-2" onChange={(amount) => updateFermentable(index, { amount, unit: 'kg' })} />
                    <IngredientSearchSelect kind="fermentable" label="Malt / fermentable" value={line.name} className="sm:col-span-4" onChange={(name, option) => updateFermentable(index, { name, ebc: option?.ebc ?? null, ppg: estimateFermentablePpg(name) })} />
                    <ReadOnlyField label="Selected colour" value={line.ebc} decimals={1} suffix="EBC" className="sm:col-span-2" />
                    {/* Filled in from the malt, and editable off a maltster's analysis sheet — this is what the gravities are calculated from. */}
                    <Field label="Extract potential" value={line.ppg} suffix="PPG" type="number" step="any" className="sm:col-span-2" disabled={!line.name.trim()} placeholder="Pick a malt" onChange={(value) => updateFermentable(index, { ppg: nullableNumber(value) })} />
                    <ReadOnlyField label="Share" value={calculation.fermentablePercents[index]} decimals={1} suffix="%" className="sm:col-span-2" />
                    <div className="flex flex-wrap items-end gap-x-5 sm:col-span-4">
                      <Check
                        label="Late addition"
                        checked={line.lateAddition}
                        title="Added after the boil has done its work — kept out of the boil gravity the hops are utilized against, but still counted in the OG."
                        onChange={(lateAddition) => updateFermentable(index, { lateAddition })}
                      />
                      <Check
                        label="Not fermentable"
                        checked={!isFermentableLine(line)}
                        title="Lactose, maltodextrin and the like: raises the gravity but never attenuates, so it lands in the FG instead of turning into alcohol."
                        onChange={(notFermentable) => updateFermentable(index, { fermentable: !notFermentable })}
                      />
                    </div>
                  </div>
                </LineCard>
              ))}
              <Empty message="No fermentables" show={draft.fermentables.length === 0} />
            </div>
          </EditorSection>

          <EditorSection title="Mash guidelines" count={draft.mashGuidelines?.steps.length} onAdd={() => setDraft((d) => {
            const steps = d.mashGuidelines?.steps ?? [];
            const isFirst = steps.length === 0;
            return {
              ...d,
              mashGuidelines: {
                startingThicknessLPerKg: d.mashGuidelines?.startingThicknessLPerKg ?? DEFAULT_MASH_THICKNESS_L_PER_KG,
                grainTempC: d.mashGuidelines?.grainTempC ?? null,
                autoStrikeVolume: isFirst ? true : d.mashGuidelines?.autoStrikeVolume ?? false,
                steps: [...steps, isFirst ? defaultFirstMashStep() : blankMashStep()],
                notes: d.mashGuidelines?.notes ?? null,
              },
            };
          })}>
            <div className="mb-3 grid gap-3 sm:grid-cols-2">
              <Field label="Starting mash thickness" value={draft.mashGuidelines?.startingThicknessLPerKg} suffix="L/kg" type="number" step="any" onChange={(value) => updateMashHeader({ startingThicknessLPerKg: nullableNumber(value) })} />
              <Field label="Grain temperature" value={draft.mashGuidelines?.grainTempC} suffix="°C" type="number" step="any" onChange={(value) => updateMashHeader({ grainTempC: nullableNumber(value) })} />
            </div>
            <div className="space-y-3">
              {(draft.mashGuidelines?.steps ?? []).map((line, index) => (
                <LineCard key={index} label={`Mash step ${index + 1}`} onRemove={() => setDraft((d) => ({ ...d, mashGuidelines: mashWith(d, { steps: (d.mashGuidelines?.steps ?? []).filter((_, i) => i !== index) }) }))}>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <div>
                      {/* Reads from the effective draft so an auto-calculated
                          first step shows the strike volume the grain bill
                          implies. */}
                      <Field
                        label="Amount"
                        value={effective.mashGuidelines?.steps[index]?.amount ?? line.amount ?? ''}
                        disabled={index === 0 && (draft.mashGuidelines?.autoStrikeVolume ?? false)}
                        onChange={(amount) => updateMashStep(index, { amount })}
                      />
                      {index === 0 && (
                        <Check
                          label="Calculate automatically"
                          checked={draft.mashGuidelines?.autoStrikeVolume ?? false}
                          // Unticking hands back the number the box was showing,
                          // so the brewer adjusts the strike volume instead of
                          // an empty field.
                          onChange={(autoStrikeVolume) => updateMashHeader(autoStrikeVolume
                            ? { autoStrikeVolume }
                            : {
                                autoStrikeVolume,
                                steps: (draft.mashGuidelines?.steps ?? []).map((step, i) => i === 0
                                  ? { ...step, amount: effective.mashGuidelines?.steps[0]?.amount ?? step.amount }
                                  : step),
                              })}
                        />
                      )}
                    </div>
                    <SelectField label="Unit" value={line.amountUnit} options={options(VOLUME_UNITS)} onChange={(amountUnit) => updateMashStep(index, { amountUnit })} />
                    <Field label="Start temperature" value={line.startTemp} suffix="°C" onChange={(value) => updateMashStep(index, { startTemp: nullable(value) })} />
                    <Field label="Target temperature" value={line.temp} suffix="°C" onChange={(value) => updateMashStep(index, { temp: nullable(value) })} />
                    <Field label="Time" value={line.time} suffix="min" onChange={(time) => updateMashStep(index, { time })} />
                    <SelectField label="Type" value={line.type || line.name} options={options(MASH_TYPES)} onChange={(type) => updateMashStep(index, { type, name: type })} />
                    <Field label="Description" value={line.description} className="sm:col-span-2 lg:col-span-3" onChange={(description) => updateMashStep(index, { description })} />
                  </div>
                </LineCard>
              ))}
              <label className="block text-xs font-medium text-zinc-400">
                Mash notes
                <textarea className={`${fieldClass} min-h-20 resize-y`} value={draft.mashGuidelines?.notes ?? ''} onChange={(event) => updateMashHeader({ notes: nullable(event.target.value) })} />
              </label>
            </div>
          </EditorSection>
        </div>

        <div className="space-y-4">
          <EditorSection title="Hops" count={draft.hops.length} total={totalWeight(draft.hops, 'g') ?? undefined} onAdd={() => setDraft((d) => ({ ...d, hops: [...d.hops, blankHop()] }))}>
            <div className="space-y-3">
              {draft.hops.map((line, index) => (
                <LineCard key={index} label={`Hop addition ${index + 1}`} onRemove={() => setDraft((d) => ({ ...d, hops: d.hops.filter((_, i) => i !== index) }))}>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-8">
                    <Field label="Amount" value={line.amount} onChange={(amount) => updateHop(index, { amount })} />
                    <SelectField label="Unit" value={line.unit} options={options(WEIGHT_UNITS)} onChange={(unit) => updateHop(index, { unit })} />
                    <IngredientSearchSelect kind="hop" label="Hop" value={line.name} className="sm:col-span-2 lg:col-span-4" onChange={(name, option) => updateHop(index, { name, aa: option?.aa == null ? '' : String(option.aa) })} />
                    <Field label="Alpha acid" value={line.aa} suffix="%" className="lg:col-span-2" onChange={(aa) => updateHop(index, { aa })} />
                    <Field label={line.stage === 'Dry Hop' ? 'Contact time' : 'Time'} value={line.time} className="lg:col-span-2" onChange={(time) => updateHop(index, { time })} />
                    <SelectField label="Time unit" value={line.timeUnit} options={[{ value: '', label: '—' }, { value: 'min', label: 'Minutes' }, { value: 'day', label: 'Days' }]} className="lg:col-span-2" onChange={(timeUnit) => updateHop(index, { timeUnit: timeUnit as RecipeHopEdit['timeUnit'] })} />
                    <SelectField label="Form" value={line.form} options={options(HOP_FORMS)} className="lg:col-span-2" onChange={(form) => updateHop(index, { form })} />
                    <SelectField label="Use" value={line.stage} options={options(HOP_STAGE_ORDER)} className="lg:col-span-2" onChange={(value) => {
                      const stage = value as HopStage;
                      updateHop(index, { stage, use: stage, timeUnit: stage === 'Dry Hop' ? 'day' : 'min' });
                    }} />
                    <ReadOnlyField label="IBU contribution" value={calculation.hopIbus[index]} decimals={2} className="lg:col-span-2" />
                  </div>
                </LineCard>
              ))}
              <Empty message="No hop additions" show={draft.hops.length === 0} />
            </div>
          </EditorSection>

          <EditorSection title="Other ingredients" count={draft.otherIngredients.length} onAdd={() => setDraft((d) => ({ ...d, otherIngredients: [...d.otherIngredients, blankOther()] }))}>
            <div className="space-y-3">
              {draft.otherIngredients.map((line, index) => (
                <LineCard key={index} label={`Ingredient ${index + 1}`} onRemove={() => setDraft((d) => ({ ...d, otherIngredients: d.otherIngredients.filter((_, i) => i !== index) }))}>
                  <div className="grid gap-3 sm:grid-cols-6">
                    <Field label="Amount" value={line.amount} onChange={(amount) => updateOther(index, { amount })} />
                    <SelectField label="Unit" value={line.unit} options={options([...WEIGHT_UNITS, ...VOLUME_UNITS, ...COUNT_UNITS])} onChange={(unit) => updateOther(index, { unit })} />
                    <IngredientSearchSelect kind="other" label="Ingredient" value={line.name} className="sm:col-span-4" onChange={(name) => updateOther(index, { name })} />
                    <Field label="Time" value={line.time} onChange={(time) => updateOther(index, { time })} />
                    <SelectField label="Time unit" value={line.timeUnit} options={[{ value: '', label: '—' }, { value: 'min', label: 'Minutes' }, { value: 'day', label: 'Days' }]} onChange={(timeUnit) => updateOther(index, { timeUnit: timeUnit as RecipeOtherIngredientEdit['timeUnit'] })} />
                    <SelectField label="Type" value={line.type} options={options(OTHER_TYPES)} className="sm:col-span-2" onChange={(type) => updateOther(index, { type })} />
                    <SelectField label="Use" value={line.use} options={options(OTHER_USES)} className="sm:col-span-2" onChange={(use) => updateOther(index, { use })} />
                  </div>
                </LineCard>
              ))}
              <Empty message="No other ingredients" show={draft.otherIngredients.length === 0} />
            </div>
          </EditorSection>

          <EditorSection title="Water chemistry" description="Source water, target profile, and target ion levels in ppm.">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <SearchableSelect label="Source water" value={draft.waterProfile?.sourceName ?? ''} options={options(WATER_SOURCES)} onChange={(value) => updateWater({ sourceName: nullable(value) })} className="sm:col-span-2" />
              <SearchableSelect label="Target water" value={draft.waterProfile?.name ?? ''} options={TARGET_PRESETS.map((preset) => ({ value: preset.name, description: preset.note }))} onChange={chooseWaterTarget} className="sm:col-span-2" />
              <ReadOnlyField label="Estimated mash pH" value={calculation.mashPh} decimals={2} />
              {waterFields.map(({ key, label }) => (
                <Field key={key} label={label} value={draft.waterProfile?.[key]} suffix="ppm" onChange={(value) => updateWater({ [key]: nullable(value) })} />
              ))}
              <label className="block text-xs font-medium text-zinc-400 sm:col-span-2 lg:col-span-4">
                Water notes
                <textarea className={`${fieldClass} min-h-20 resize-y`} value={draft.waterProfile?.notes ?? ''} onChange={(event) => updateWater({ notes: nullable(event.target.value) })} />
              </label>
            </div>
          </EditorSection>

          <EditorSection title="Yeast" count={draft.yeast.length} onAdd={() => setDraft((d) => ({ ...d, yeast: [...d.yeast, blankYeast()] }))}>
            <div className="space-y-3">
              {draft.yeast.map((line, index) => (
                <LineCard key={index} label={`Yeast ${index + 1}`} onRemove={() => setDraft((d) => ({ ...d, yeast: d.yeast.filter((_, i) => i !== index) }))}>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
                    <IngredientSearchSelect kind="yeast" label="Yeast / culture" value={line.name} className="sm:col-span-2 lg:col-span-4" onChange={(name) => updateYeast(index, { name })} />
                    <Field label="Lab" value={line.lab} className="lg:col-span-2" onChange={(lab) => updateYeast(index, { lab })} />
                    <Field label="Amount" value={line.amount} onChange={(amount) => updateYeast(index, { amount })} />
                    <SelectField label="Unit" value={line.amountUnit} options={options([...COUNT_UNITS, ...WEIGHT_UNITS])} onChange={(amountUnit) => updateYeast(index, { amountUnit })} />
                    <Field label="Attenuation" value={line.attenuation} suffix="%" onChange={(attenuation) => updateYeast(index, { attenuation })} />
                    <SelectField label="Type" value={line.type} options={options(YEAST_TYPES)} onChange={(type) => updateYeast(index, { type })} />
                    <SelectField label="Form" value={line.form} options={options(YEAST_FORMS)} onChange={(form) => updateYeast(index, { form })} />
                    <SelectField label="Flocculation" value={line.flocculation} options={options(FLOCCULATION_OPTIONS)} onChange={(flocculation) => updateYeast(index, { flocculation })} />
                    <Field label="Min temperature" value={line.minTempC} suffix="°C" type="number" step="any" onChange={(value) => updateYeast(index, { minTempC: nullableNumber(value) })} />
                    <Field label="Max temperature" value={line.maxTempC} suffix="°C" type="number" step="any" onChange={(value) => updateYeast(index, { maxTempC: nullableNumber(value) })} />
                    <Field label="Alcohol tolerance" value={line.alcoholTolerance} onChange={(alcoholTolerance) => updateYeast(index, { alcoholTolerance })} />
                    <Check label="Starter required" checked={line.starter} className="self-end pb-2" onChange={(starter) => updateYeast(index, { starter })} />
                  </div>
                </LineCard>
              ))}
              <Empty message="No yeast" show={draft.yeast.length === 0} />
              <div className="grid gap-3 sm:grid-cols-2">
                <SearchableSelect label="Pitch rate" value={draft.settings.pitchRate} options={options(PITCH_RATES)} onChange={(pitchRate) => updateSettings({ pitchRate })} />
                <Field label="Fermentation temperature" value={draft.fermentationTemp} suffix="°C" onChange={(value) => setDraft((d) => ({ ...d, fermentationTemp: nullable(value) }))} />
              </div>
            </div>
          </EditorSection>
        </div>
      </div>

      <div className="sticky bottom-3 z-30 flex items-center justify-end gap-2 rounded-xl border border-zinc-700 bg-zinc-900/95 p-3 shadow-2xl backdrop-blur">
        <button type="button" onClick={cancel} disabled={saving} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50">
          Cancel
        </button>
        <button type="submit" disabled={saving || !dirty} className="rounded-lg bg-gradient-to-br from-[#f87a68] to-[#e0463f] px-4 py-2 text-sm font-semibold text-white shadow transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50">
          {saving ? 'Saving…' : 'Save recipe'}
        </button>
      </div>
    </form>
  );

  function updateFermentable(index: number, patch: Partial<RecipeFermentableEdit>): void {
    setDraft((d) => ({ ...d, fermentables: d.fermentables.map((line, i) => i === index ? { ...line, ...patch } : line) }));
  }
  function updateHop(index: number, patch: Partial<RecipeHopEdit>): void {
    setDraft((d) => ({ ...d, hops: d.hops.map((line, i) => i === index ? { ...line, ...patch } : line) }));
  }
  function updateYeast(index: number, patch: Partial<RecipeYeastEdit>): void {
    setDraft((d) => ({ ...d, yeast: d.yeast.map((line, i) => i === index ? { ...line, ...patch } : line) }));
  }
  function updateOther(index: number, patch: Partial<RecipeOtherIngredientEdit>): void {
    setDraft((d) => ({ ...d, otherIngredients: d.otherIngredients.map((line, i) => i === index ? { ...line, ...patch } : line) }));
  }
  function updateMashStep(index: number, patch: Partial<RecipeMashStep>): void {
    setDraft((d) => ({ ...d, mashGuidelines: mashWith(d, { steps: (d.mashGuidelines?.steps ?? []).map((line, i) => i === index ? { ...line, ...patch } : line) }) }));
  }
  function updateMashHeader(patch: Partial<NonNullable<RecipeEditInput['mashGuidelines']>>): void {
    setDraft((d) => ({ ...d, mashGuidelines: mashWith(d, patch) }));
  }
  function updateWater(patch: Partial<RecipeWaterProfile>): void {
    setDraft((d) => ({ ...d, waterProfile: { ...blankWater(), ...(d.waterProfile ?? {}), ...patch } }));
  }
  function chooseWaterTarget(name: string): void {
    const preset = TARGET_PRESETS.find((candidate) => candidate.name === name);
    updateWater({
      name: nullable(name),
      ...(preset ? {
        calcium: String(preset.profile.ca),
        magnesium: String(preset.profile.mg),
        sodium: String(preset.profile.na),
        chloride: String(preset.profile.cl),
        sulfate: String(preset.profile.so4),
        bicarbonate: String(preset.profile.hco3),
      } : {}),
    });
  }
}

function mashWith(draft: RecipeEditInput, patch: Partial<NonNullable<RecipeEditInput['mashGuidelines']>>): NonNullable<RecipeEditInput['mashGuidelines']> {
  return {
    startingThicknessLPerKg: draft.mashGuidelines?.startingThicknessLPerKg ?? null,
    grainTempC: draft.mashGuidelines?.grainTempC ?? null,
    autoStrikeVolume: draft.mashGuidelines?.autoStrikeVolume ?? false,
    steps: draft.mashGuidelines?.steps ?? [],
    notes: draft.mashGuidelines?.notes ?? null,
    ...patch,
  };
}

/**
 * One panel of the brew sheet, collapsible so a long recipe can be worked on a
 * section at a time. Every section opens expanded — a new recipe is a form to
 * fill in, and a form that starts folded up hides what still needs answering.
 */
function EditorSection({ title, description, count, total, onAdd, children }: { title: string; description?: string; count?: number; total?: string; onAdd?: () => void; children: React.ReactNode }): JSX.Element {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
        >
          <span className={`mt-1 shrink-0 text-[10px] text-zinc-500 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>▶</span>
          <span className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100">
              {title}
              {count != null && <span className="ml-2 font-normal text-zinc-500">{count}</span>}
              {total && <span className="ml-2 font-normal text-zinc-500">{total}</span>}
            </h2>
            {description && <p className="mt-0.5 text-xs text-zinc-500">{description}</p>}
          </span>
        </button>
        {/* Adding a row to a folded section would drop it out of sight, so it
            unfolds first — the brewer asked to fill something in. */}
        {onAdd && <button type="button" onClick={() => { setOpen(true); onAdd(); }} className="shrink-0 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs font-semibold text-zinc-300 transition hover:bg-zinc-800">+ Add</button>}
      </div>
      {open && <div id={bodyId} className="mt-3">{children}</div>}
    </section>
  );
}

/** Opens the panel that edits what a style dropdown offers. */
function EditListToggle({ open, onToggle }: { open: boolean; onToggle: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="mt-2 text-[11px] font-medium text-zinc-500 underline-offset-2 transition hover:text-zinc-200 hover:underline"
    >
      {open ? 'Done editing list' : 'Edit list…'}
    </button>
  );
}

/** Header shared by both dropdown editors: what the list is, and a way back to the default. */
function StyleListHeader({ title, hint, isDefault, onReset }: { title: string; hint: string; isDefault: boolean; onReset: () => void }): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="text-xs font-semibold text-zinc-300">{title}</div>
        <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p>
      </div>
      {!isDefault && (
        <button
          type="button"
          onClick={onReset}
          className="shrink-0 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-300 transition hover:bg-zinc-800"
        >
          Reset
        </button>
      )}
    </div>
  );
}

/** One removable entry in the dropdown editors below. */
function StyleChip({ label, onRemove }: { label: string; onRemove: () => void }): JSX.Element {
  return (
    <span className="flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 py-1 pl-3 pr-1 text-xs text-zinc-200">
      {label}
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        className="flex h-5 w-5 items-center justify-center rounded-full text-zinc-500 transition hover:bg-red-500/15 hover:text-red-300"
      >
        ×
      </button>
    </span>
  );
}

/**
 * Add/remove panel for the "Style category" dropdown. Every category the app
 * knows is on offer — the brewery's own families plus the full BJCP taxonomy —
 * so the dropdown holds the beers this brewer actually makes.
 *
 * The list is a browser preference, not part of the recipe, so edits here save
 * immediately and apply to every recipe rather than to the one being edited.
 */
function StyleCategoryEditor({ categories, onChange, className = '' }: { categories: string[]; onChange: (categories: string[]) => void; className?: string }): JSX.Element {
  const listed = new Set(categories);
  const missing = ALL_STYLE_CATEGORIES.filter((category) => !listed.has(category));
  const isDefault = categories.length === DEFAULT_STYLE_CATEGORIES.length
    && categories.every((category, index) => category === DEFAULT_STYLE_CATEGORIES[index]);
  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 ${className}`}>
      <StyleListHeader
        title="Style category dropdown"
        hint="Saved in this browser and used by every recipe. Removing a category never changes recipes already saved under it — the dropdown still offers a recipe its own category."
        isDefault={isDefault}
        onReset={() => onChange([...DEFAULT_STYLE_CATEGORIES])}
      />
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {categories.map((category) => (
          <StyleChip
            key={category}
            label={category}
            onRemove={() => onChange(categories.filter((other) => other !== category))}
          />
        ))}
        {categories.length === 0 && (
          <span className="text-[11px] text-zinc-600">Empty — the dropdown offers nothing until you add a category.</span>
        )}
      </div>
      <SearchableSelect
        label="Add a category"
        value=""
        options={missing.map((value) => ({
          value,
          description: categoryIsStyle(value) ? 'Brewery style' : 'BJCP group',
        }))}
        // Only an actual pick counts: the field reports every keystroke, and a
        // half-typed word is not a category worth adding to anyone's dropdown.
        onChange={(_value, option) => option && onChange([...categories, option.value])}
        placeholder={missing.length === 0 ? 'Every category is already listed' : 'Search the full BJCP list…'}
        allowCustom={false}
        className="mt-2.5"
      />
    </div>
  );
}

/**
 * Add/remove panel for the "Style / subcategory" dropdown, grouped by the
 * category each substyle hangs off — the second dropdown only ever shows one
 * category's worth, so the grouping is what makes the list legible.
 *
 * Stored as removals rather than a kept list: adding a category should bring
 * its substyles with it, not leave this dropdown empty until they're re-added
 * one by one.
 */
function SubstyleEditor({ categories, hiddenSubstyles, onChange, className = '' }: { categories: string[]; hiddenSubstyles: string[]; onChange: (substyles: string[]) => void; className?: string }): JSX.Element {
  const listed = new Set(categories);
  const hidden = new Set(hiddenSubstyles);
  const belongsToListed = (owners: string[]): boolean => owners.some((owner) => listed.has(owner));
  // A substyle is in the dropdown when one of the categories it belongs to is
  // listed and the brewer hasn't taken it out; everything else can be added.
  const addable = ALL_SUBSTYLES
    .filter(({ value, categories: owners }) => hidden.has(value) || !belongsToListed(owners))
    .map(({ value, categories: owners }) => ({
      value,
      description: owners.join(' · '),
      // Greyed rather than dropped: a substyle whose category isn't in the other
      // dropdown should show *why* it can't be added, not vanish from the list.
      disabled: !belongsToListed(owners),
    }));
  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 ${className}`}>
      <StyleListHeader
        title="Substyle dropdown"
        hint="Grouped by the style category each one belongs to. A substyle can only be added once its category is in the category dropdown; the rest stay greyed out."
        isDefault={hiddenSubstyles.length === 0}
        onReset={() => onChange([])}
      />
      <div className="mt-2.5 space-y-2">
        {categories.map((category) => {
          const all = substylesFor(category);
          const shown = all.filter((value) => !hidden.has(value));
          return (
            <div key={category}>
              <div className="text-[11px] text-zinc-500">{category}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {shown.map((value) => (
                  <StyleChip
                    key={value}
                    label={value}
                    onRemove={() => onChange([...hiddenSubstyles, value])}
                  />
                ))}
                {shown.length === 0 && (
                  <span className="text-[11px] text-zinc-600">
                    {all.length === 0
                      ? `No substyles — a recipe is saved as ${category} itself.`
                      : 'All removed — add one back below.'}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {categories.length === 0 && (
          <span className="text-[11px] text-zinc-600">No style categories listed, so there are no substyles to offer.</span>
        )}
      </div>
      <SearchableSelect
        label="Add a substyle"
        value=""
        options={addable}
        onChange={(_value, option) => option && onChange(hiddenSubstyles.filter((other) => other !== option.value))}
        placeholder={addable.length === 0 ? 'Every substyle is already listed' : 'Search every substyle…'}
        allowCustom={false}
        className="mt-2.5"
      />
    </div>
  );
}

function LineCard({ label, onRemove, children }: { label: string; onRemove: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/35 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{label}</span>
        <button type="button" onClick={onRemove} className="rounded px-2 py-1 text-xs text-zinc-500 transition hover:bg-red-500/10 hover:text-red-300" aria-label={`Remove ${label}`}>Remove</button>
      </div>
      {children}
    </div>
  );
}

/**
 * Room to keep the suffix off the value, scaled to the suffix itself. A flat
 * reservation wide enough for "L/kg" leaves a "°C" field in a six-across row
 * with barely a character of usable width, which is how "71" comes out reading
 * as "7".
 */
function suffixPadding(suffix: string | undefined): string {
  if (!suffix) return '';
  if (suffix.length <= 2) return 'pr-8';
  return suffix.length === 3 ? 'pr-10' : 'pr-12';
}

function Field({ label, value, onChange, suffix, className = '', required = false, type = 'text', step, placeholder, disabled = false }: { label: string; value: string | number | null | undefined; onChange: (value: string) => void; suffix?: string; className?: string; required?: boolean; type?: string; step?: string; placeholder?: string; disabled?: boolean }): JSX.Element {
  return (
    <label className={`block text-xs font-medium text-zinc-400 ${className}`}>
      {label}
      <div className="relative">
        <input className={`${fieldClass} ${suffixPadding(suffix)} disabled:cursor-not-allowed disabled:bg-zinc-900 disabled:text-zinc-400`} value={value ?? ''} onChange={(event) => onChange(event.target.value)} required={required} type={type} step={step} placeholder={placeholder} disabled={disabled} />
        {suffix && <span className="pointer-events-none absolute inset-y-0 right-3 top-1 flex items-center text-xs text-zinc-600">{suffix}</span>}
      </div>
    </label>
  );
}

function ReadOnlyField({ label, value, decimals, suffix, className = '' }: { label: string; value: number | null | undefined; decimals: number; suffix?: string; className?: string }): JSX.Element {
  return (
    <label className={`block text-xs font-medium text-zinc-400 ${className}`}>
      {label}
      <div className={`${fieldClass} flex min-h-[38px] items-center justify-between bg-zinc-900 text-zinc-200`}>
        <span>{value == null ? '—' : value.toFixed(decimals)}</span>
        {suffix && <span className="text-xs text-zinc-600">{suffix}</span>}
      </div>
    </label>
  );
}

function CalculatedStat({ label, value, decimals, suffix = '', range, compareToStyle = false }: { label: string; value: number | null; decimals: number; suffix?: string; range?: [number, number]; compareToStyle?: boolean }): JSX.Element {
  const status = value == null
    ? { text: 'Needs more inputs', className: 'text-zinc-500' }
    : !range
      ? { text: 'No BJCP range', className: 'text-zinc-500' }
      : value < range[0]
        ? { text: `Below ${range[0]}–${range[1]}`, className: 'text-amber-300' }
        : value > range[1]
          ? { text: `Above ${range[0]}–${range[1]}`, className: 'text-amber-300' }
          : { text: `In range ${range[0]}–${range[1]}`, className: 'text-emerald-300' };
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2.5">
      <div className="text-[11px] font-medium text-zinc-500">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums text-zinc-100">
        {value == null ? '—' : value.toFixed(decimals)}
        {value != null && suffix && <span className="ml-1 text-xs font-normal text-zinc-500">{suffix}</span>}
      </div>
      {(compareToStyle || value == null) && <div className={`mt-1 text-[10px] ${status.className}`}>{status.text}</div>}
    </div>
  );
}

function SelectField({ label, value, options: choices, onChange, className = '' }: { label: string; value: string; options: Array<{ value: string; label?: string }>; onChange: (value: string) => void; className?: string }): JSX.Element {
  const all = choices.some((choice) => choice.value === value) || value === ''
    ? choices
    : [{ value }, ...choices];
  return (
    <label className={`block text-xs font-medium text-zinc-400 ${className}`}>
      {label}
      <select className={fieldClass} value={value} onChange={(event) => onChange(event.target.value)}>
        {all.map((choice) => <option key={choice.value} value={choice.value}>{choice.label ?? choice.value}</option>)}
      </select>
    </label>
  );
}

function Check({ label, checked, onChange, className = '', title }: { label: string; checked: boolean; onChange: (checked: boolean) => void; className?: string; title?: string }): JSX.Element {
  return (
    <label title={title} className={`mt-2 flex items-center gap-2 text-xs font-medium text-zinc-400 ${className}`}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 rounded border-zinc-600 bg-zinc-950 accent-[#e95449]" />
      {label}
    </label>
  );
}

function Empty({ message, show }: { message: string; show: boolean }): JSX.Element | null {
  return show ? <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-5 text-center text-sm text-zinc-600">{message}. Use Add to create a row.</div> : null;
}

function blankFermentable(): RecipeFermentableEdit {
  return { name: '', amount: '', unit: 'kg', percent: '', ebc: null, ppg: null, fermentable: null, lateAddition: false };
}
function blankHop(): RecipeHopEdit {
  return { name: '', amount: '', unit: 'g', use: 'Boil', stage: 'Boil', time: '', timeUnit: 'min', aa: '', ibu: '', form: 'Pellet', utilization: '', temp: '' };
}
function blankYeast(): RecipeYeastEdit {
  return { name: '', lab: '', attenuation: '', amount: '1', amountUnit: 'pkg', type: 'Ale', form: 'Dry', flocculation: '', minTempC: null, maxTempC: null, alcoholTolerance: '', starter: false };
}
function blankOther(): RecipeOtherIngredientEdit {
  return { name: '', amount: '', unit: 'g', use: 'Boil', time: '', timeUnit: 'min', type: 'Flavor' };
}
function blankMashStep(): RecipeMashStep {
  return { name: 'Strike', type: 'Strike', temp: null, startTemp: null, time: '', amount: '', amountUnit: 'L', description: '' };
}

/**
 * The mash guideline section's first row, filled in rather than left blank: a
 * single-infusion strike at this brewery's usual temperatures. The amount
 * starts empty — the caller is expected to also turn on `autoStrikeVolume`,
 * which is what makes {@link withDerivedStrikeVolume} fill it from the grain
 * bill. Only the first row gets this treatment; a later mash-out or sparge has
 * no one-size guess worth making, so it still starts from `blankMashStep`.
 */
export function defaultFirstMashStep(): RecipeMashStep {
  return {
    name: 'Strike',
    type: 'Strike',
    startTemp: '71',
    temp: '69',
    time: '60',
    amount: '',
    amountUnit: 'L',
    description: '',
  };
}
function blankWater(): RecipeWaterProfile {
  return { sourceName: null, name: null, ph: null, notes: null, calcium: null, magnesium: null, sodium: null, chloride: null, sulfate: null, bicarbonate: null };
}

const waterFields: { key: 'calcium' | 'magnesium' | 'sodium' | 'chloride' | 'sulfate' | 'bicarbonate'; label: string }[] = [
  { key: 'calcium', label: 'Calcium' },
  { key: 'magnesium', label: 'Magnesium' },
  { key: 'sodium', label: 'Sodium' },
  { key: 'chloride', label: 'Chloride' },
  { key: 'sulfate', label: 'Sulfate' },
  { key: 'bicarbonate', label: 'Bicarbonate' },
];
