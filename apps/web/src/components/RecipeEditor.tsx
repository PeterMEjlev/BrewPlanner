import {
  applyRecipeCalculations,
  calculateRecipe,
  DEFAULT_RECIPE_SETTINGS,
  estimateFermentablePpg,
  HOP_STAGE_ORDER,
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
import { useMemo, useState } from 'react';
import { TARGET_PRESETS } from '../water';
import {
  BATCH_TARGETS,
  COUNT_UNITS,
  FLOCCULATION_OPTIONS,
  HOP_FORMS,
  MASH_TYPES,
  OTHER_TYPES,
  OTHER_USES,
  PITCH_RATES,
  STYLE_CATEGORIES,
  STYLE_SUBCATEGORIES,
  VOLUME_UNITS,
  WATER_SOURCES,
  WEIGHT_UNITS,
  YEAST_FORMS,
  YEAST_TYPES,
} from '../recipeCatalog';
import { rangeForStyle } from '../styleRanges';
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

function options(values: readonly string[]): { value: string }[] {
  return values.map((value) => ({ value }));
}

export function RecipeEditor({ recipe, saving, error, onSave, onCancel }: Props): JSX.Element {
  const initial = useMemo(() => editable(recipe), [recipe]);
  const [draft, setDraft] = useState<RecipeEditInput>(initial);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const calculation = useMemo(() => calculateRecipe(draft), [draft]);
  const styleRange = useMemo(
    () => rangeForStyle(draft.settings.styleSubcategory || draft.style),
    [draft.settings.styleSubcategory, draft.style],
  );
  const styleChoices = draft.settings.styleCategory
    ? STYLE_SUBCATEGORIES.filter((choice) => choice.category === draft.settings.styleCategory)
    : STYLE_SUBCATEGORIES;

  function cancel(): void {
    if (!dirty || window.confirm('Discard your unsaved recipe changes?')) onCancel();
  }

  function updateSettings(patch: Partial<RecipeSettings>): void {
    setDraft((current) => ({
      ...current,
      settings: { ...current.settings, ...patch },
    }));
  }

  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(applyRecipeCalculations(draft));
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
          <Field label="Recipe name" value={draft.name} required className="sm:col-span-2" onChange={(name) => setDraft((d) => ({ ...d, name }))} />
          <SearchableSelect
            label="Style category"
            value={draft.settings.styleCategory}
            options={options(STYLE_CATEGORIES)}
            onChange={(styleCategory) => updateSettings({ styleCategory })}
            className="sm:col-span-2"
          />
          <SearchableSelect
            label="Style / subcategory"
            value={draft.settings.styleSubcategory || draft.style}
            options={styleChoices.map((choice) => ({ value: choice.value, description: choice.category }))}
            onChange={(styleSubcategory) => setDraft((current) => ({
              ...current,
              style: styleSubcategory,
              settings: { ...current.settings, styleSubcategory },
            }))}
            className="sm:col-span-2"
            testId="recipe-style-select"
          />

          <Field label="Batch size" value={draft.batchSizeL} suffix="L" type="number" step="any" onChange={(value) => setDraft((d) => ({ ...d, batchSizeL: nullableNumber(value) }))} />
          <SelectField label="Batch target" value={draft.settings.batchTarget} options={options(BATCH_TARGETS)} onChange={(batchTarget) => updateSettings({ batchTarget })} />
          <Field label="Boil time" value={draft.settings.boilTimeMinutes} suffix="min" type="number" step="any" onChange={(value) => updateSettings({ boilTimeMinutes: nullableNumber(value) })} />
          <Field label="Brewhouse efficiency" value={draft.settings.efficiencyPercent} suffix="%" type="number" step="any" onChange={(value) => updateSettings({ efficiencyPercent: nullableNumber(value) })} />

          <div>
            <Field label="Pre-boil size" value={draft.settings.boilSizePreL} suffix="L" type="number" step="any" onChange={(value) => updateSettings({ boilSizePreL: nullableNumber(value) })} />
            <Check label="Calculate automatically" checked={draft.settings.autoBoilSizePre} onChange={(autoBoilSizePre) => updateSettings({ autoBoilSizePre })} />
          </div>
          <div>
            <Field label="Post-boil size" value={draft.settings.boilSizePostL} suffix="L" type="number" step="any" onChange={(value) => updateSettings({ boilSizePostL: nullableNumber(value) })} />
            <Check label="Calculate automatically" checked={draft.settings.autoBoilSizePost} onChange={(autoBoilSizePost) => updateSettings({ autoBoilSizePost })} />
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
          <EditorSection title="Fermentables" count={draft.fermentables.length} onAdd={() => setDraft((d) => ({ ...d, fermentables: [...d.fermentables, blankFermentable()] }))}>
            <div className="space-y-3">
              {draft.fermentables.map((line, index) => (
                <LineCard key={index} label={`Fermentable ${index + 1}`} onRemove={() => setDraft((d) => ({ ...d, fermentables: d.fermentables.filter((_, i) => i !== index) }))}>
                  <div className="grid gap-3 sm:grid-cols-8">
                    <Field label="Amount" value={line.amount} suffix="kg" className="sm:col-span-2" onChange={(amount) => updateFermentable(index, { amount, unit: 'kg' })} />
                    <IngredientSearchSelect kind="fermentable" label="Malt / fermentable" value={line.name} className="sm:col-span-4" onChange={(name, option) => updateFermentable(index, { name, ebc: option?.ebc ?? null, ppg: estimateFermentablePpg(name) })} />
                    <ReadOnlyField label="Selected colour" value={line.ebc} decimals={1} suffix="EBC" className="sm:col-span-2" />
                    <ReadOnlyField label="Share" value={calculation.fermentablePercents[index]} decimals={1} suffix="%" className="sm:col-span-2" />
                  </div>
                </LineCard>
              ))}
              <Empty message="No fermentables" show={draft.fermentables.length === 0} />
            </div>
          </EditorSection>

          <EditorSection title="Mash guidelines" count={draft.mashGuidelines?.steps.length} onAdd={() => setDraft((d) => ({
            ...d,
            mashGuidelines: {
              startingThicknessLPerKg: d.mashGuidelines?.startingThicknessLPerKg ?? null,
              grainTempC: d.mashGuidelines?.grainTempC ?? null,
              steps: [...(d.mashGuidelines?.steps ?? []), blankMashStep()],
              notes: d.mashGuidelines?.notes ?? null,
            },
          }))}>
            <div className="mb-3 grid gap-3 sm:grid-cols-2">
              <Field label="Starting mash thickness" value={draft.mashGuidelines?.startingThicknessLPerKg} suffix="L/kg" type="number" step="any" onChange={(value) => updateMashHeader({ startingThicknessLPerKg: nullableNumber(value) })} />
              <Field label="Grain temperature" value={draft.mashGuidelines?.grainTempC} suffix="°C" type="number" step="any" onChange={(value) => updateMashHeader({ grainTempC: nullableNumber(value) })} />
            </div>
            <div className="space-y-3">
              {(draft.mashGuidelines?.steps ?? []).map((line, index) => (
                <LineCard key={index} label={`Mash step ${index + 1}`} onRemove={() => setDraft((d) => ({ ...d, mashGuidelines: mashWith(d, { steps: (d.mashGuidelines?.steps ?? []).filter((_, i) => i !== index) }) }))}>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
                    <Field label="Amount" value={line.amount ?? ''} onChange={(amount) => updateMashStep(index, { amount })} />
                    <SelectField label="Unit" value={line.amountUnit} options={options(VOLUME_UNITS)} onChange={(amountUnit) => updateMashStep(index, { amountUnit })} />
                    <Field label="Start temperature" value={line.startTemp} suffix="°C" onChange={(value) => updateMashStep(index, { startTemp: nullable(value) })} />
                    <Field label="Target temperature" value={line.temp} suffix="°C" onChange={(value) => updateMashStep(index, { temp: nullable(value) })} />
                    <Field label="Time" value={line.time} suffix="min" onChange={(time) => updateMashStep(index, { time })} />
                    <SelectField label="Type" value={line.type || line.name} options={options(MASH_TYPES)} onChange={(type) => updateMashStep(index, { type, name: type })} />
                    <Field label="Description" value={line.description} className="sm:col-span-2 lg:col-span-6" onChange={(description) => updateMashStep(index, { description })} />
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
          <EditorSection title="Hops" count={draft.hops.length} onAdd={() => setDraft((d) => ({ ...d, hops: [...d.hops, blankHop()] }))}>
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
    steps: draft.mashGuidelines?.steps ?? [],
    notes: draft.mashGuidelines?.notes ?? null,
    ...patch,
  };
}

function EditorSection({ title, description, count, onAdd, children }: { title: string; description?: string; count?: number; onAdd?: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="mb-3 flex items-center gap-2">
        <div>
          <h2 className="text-base font-semibold text-zinc-100">{title}{count != null && <span className="ml-2 font-normal text-zinc-500">{count}</span>}</h2>
          {description && <p className="mt-0.5 text-xs text-zinc-500">{description}</p>}
        </div>
        {onAdd && <button type="button" onClick={onAdd} className="ml-auto rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs font-semibold text-zinc-300 transition hover:bg-zinc-800">+ Add</button>}
      </div>
      {children}
    </section>
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

function Field({ label, value, onChange, suffix, className = '', required = false, type = 'text', step, placeholder }: { label: string; value: string | number | null | undefined; onChange: (value: string) => void; suffix?: string; className?: string; required?: boolean; type?: string; step?: string; placeholder?: string }): JSX.Element {
  return (
    <label className={`block text-xs font-medium text-zinc-400 ${className}`}>
      {label}
      <div className="relative">
        <input className={`${fieldClass} ${suffix ? 'pr-12' : ''}`} value={value ?? ''} onChange={(event) => onChange(event.target.value)} required={required} type={type} step={step} placeholder={placeholder} />
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

function Check({ label, checked, onChange, className = '' }: { label: string; checked: boolean; onChange: (checked: boolean) => void; className?: string }): JSX.Element {
  return (
    <label className={`mt-2 flex items-center gap-2 text-xs font-medium text-zinc-400 ${className}`}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 rounded border-zinc-600 bg-zinc-950 accent-[#e95449]" />
      {label}
    </label>
  );
}

function Empty({ message, show }: { message: string; show: boolean }): JSX.Element | null {
  return show ? <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-5 text-center text-sm text-zinc-600">{message}. Use Add to create a row.</div> : null;
}

function blankFermentable(): RecipeFermentableEdit {
  return { name: '', amount: '', unit: 'kg', percent: '', ebc: null, ppg: null };
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
