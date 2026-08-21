import { DEFAULT_RECIPE_SETTINGS } from '@checklist/shared';
import type {
  OutdoorTemperature,
  RecipeDefaults,
  RecipeDetail,
  RecipeEditInput,
} from '@checklist/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { DashboardShell } from '../components/DashboardShell';
import { defaultFirstMashStep, RecipeEditor } from '../components/RecipeEditor';
import { useRecipeDefaults } from '../recipeDefaults';
import { invalidateRecipes } from '../recipeStore';
import { asCleanMessage } from '../util';

const EMPTY_RECIPE: RecipeDetail = {
  id: '',
  origin: 'local',
  // A sheet that hasn't been saved belongs to no family yet; saving it makes it
  // version 1 of one of its own.
  familyId: '',
  version: 1,
  versionNote: '',
  versions: [],
  name: '',
  style: '',
  settings: { ...DEFAULT_RECIPE_SETTINGS },
  og: '',
  preBoilGravity: null,
  postBoilGravity: null,
  fg: '',
  abv: '',
  ibu: '',
  ebc: '',
  ebcEstimated: false,
  url: '',
  createdAt: '',
  updatedAt: '',
  // This brewery's usual batch size, so a new recipe opens on real numbers.
  batchSizeL: 55,
  mashTemp: null,
  fermentationTemp: null,
  fermentables: [{
    name: '',
    amount: '',
    unit: 'kg',
    percent: '',
    ebc: null,
    ppg: null,
    fermentable: null,
    lateAddition: false,
    grams: null,
    price: null,
  }],
  hops: [{
    name: '',
    amount: '',
    unit: 'g',
    use: 'Boil',
    stage: 'Boil',
    time: '',
    timeUnit: 'min',
    aa: '',
    ibu: '',
    form: 'Pellet',
    utilization: '',
    temp: '',
    grams: null,
    price: null,
  }],
  yeast: [{
    name: '',
    lab: '',
    attenuation: '',
    amount: '1',
    amountUnit: 'each',
    type: 'Ale',
    form: 'Dry',
    flocculation: '',
    minTempC: null,
    maxTempC: null,
    alcoholTolerance: '',
    starter: false,
    // Blank: the ordinary case is one pitch, at the start, at the recipe's
    // own fermentation temperature.
    addAfterDays: '',
    heldAtC: '',
    grams: null,
    units: 1,
    price: null,
  }],
  otherIngredients: [],
  notes: null,
  mashGuidelines: null,
  waterProfile: null,
  pricing: { currency: 'DKK', lastChecked: '', source: '', available: false },
  cost: { usedDkk: 0, buyDkk: 0, priced: 0, unpriced: 0, purchase: [] },
};

/**
 * The blank sheet as the brewhouse writes it: the empty rows above, with every
 * figure a recipe *starts* from taken from the Recipes settings rather than
 * from this file. Only the opening draft — once the brewer changes a volume
 * here it belongs to the recipe, and later editing the setting won't move it.
 */
function blankRecipe(defaults: RecipeDefaults, grainTempC: number | null): RecipeDetail {
  return {
    ...EMPTY_RECIPE,
    batchSizeL: defaults.batchSizeL,
    settings: {
      ...EMPTY_RECIPE.settings,
      batchTarget: defaults.batchTarget,
      boilTimeMinutes: defaults.boilTimeMinutes,
      efficiencyPercent: defaults.efficiencyPercent,
      boilOffLPerHour: defaults.boilOffLPerHour,
      trubChillerLossL: defaults.trubChillerLossL,
      pitchRate: defaults.pitchRate,
    },
    mashGuidelines: {
      startingThicknessLPerKg: defaults.mashThicknessLPerKg,
      grainTempC,
      autoStrikeVolume: true,
      steps: [defaultFirstMashStep(defaults)],
      notes: null,
    },
  };
}

/**
 * The temperature the grain is assumed to start at, looked up once per page
 * open. The editor takes its opening draft when it mounts and never re-reads
 * it, so the sheet waits for the lookup to settle rather than having a figure
 * appear under the brewer mid-edit; a failed or slow lookup simply leaves the
 * field empty, which is where it stood before.
 */
function useOutdoorTemperature(): { settled: boolean; reading: OutdoorTemperature | null } {
  const [state, setState] = useState<{ settled: boolean; reading: OutdoorTemperature | null }>({
    settled: false,
    reading: null,
  });
  useEffect(() => {
    let cancelled = false;
    const settle = (reading: OutdoorTemperature | null) => {
      if (!cancelled) setState({ settled: true, reading });
    };
    // Never hold the page hostage to the weather: the editor opens regardless.
    const giveUp = window.setTimeout(() => settle(null), 4_000);
    void api
      .getOutdoorTemperature()
      .then(settle)
      .catch(() => settle(null))
      .finally(() => window.clearTimeout(giveUp));
    return () => {
      cancelled = true;
      window.clearTimeout(giveUp);
    };
  }, []);
  return state;
}

export function RecipeCreatePage(): JSX.Element {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const outdoor = useOutdoorTemperature();
  const defaults = useRecipeDefaults();
  const blank = useMemo<RecipeDetail>(
    () => blankRecipe(defaults, outdoor.reading?.temperatureC ?? null),
    [defaults, outdoor.reading],
  );

  async function create(recipe: RecipeEditInput): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.createRecipe(recipe);
      invalidateRecipes();
      navigate(`/recipes/${encodeURIComponent(saved.id)}`, { replace: true });
    } catch (e) {
      setError(asCleanMessage(e));
      setSaving(false);
    }
  }

  return (
    <DashboardShell active="recipes">
      {/* Wider than the pages that only read a recipe: the editor spends this
          width on a contents rail and a column of live statistics either side
          of the sheet, not on the sheet itself. */}
      <main className="w-full max-w-[1600px] px-5 py-5">
        <Link to="/recipes" className="text-sm text-zinc-400 transition hover:text-zinc-100">
          ← Recipes
        </Link>
        {outdoor.settled ? (
          <RecipeEditor
            recipe={blank}
            saving={saving}
            error={error}
            onSave={create}
            onCancel={() => navigate('/recipes')}
            // A blank sheet is filled from the shop: the ingredient pickers
            // offer Humlecentralen's catalogue only, not the names older
            // recipes happened to use — those can be neither priced nor bought.
            catalogueOnly
          />
        ) : (
          <p className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-6 text-sm text-zinc-500">
            Opening a blank brew sheet…
          </p>
        )}
      </main>
    </DashboardShell>
  );
}
