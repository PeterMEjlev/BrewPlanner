import { DEFAULT_RECIPE_SETTINGS } from '@checklist/shared';
import type { RecipeDetail, RecipeEditInput } from '@checklist/shared';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { DashboardShell } from '../components/DashboardShell';
import { DEFAULT_MASH_THICKNESS_L_PER_KG, defaultFirstMashStep, RecipeEditor } from '../components/RecipeEditor';
import { invalidateRecipes } from '../recipeStore';
import { asCleanMessage } from '../util';

const EMPTY_RECIPE: RecipeDetail = {
  id: '',
  origin: 'local',
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
    amountUnit: 'pkg',
    type: 'Ale',
    form: 'Dry',
    flocculation: '',
    minTempC: null,
    maxTempC: null,
    alcoholTolerance: '',
    starter: false,
    grams: null,
    units: 1,
    price: null,
  }],
  otherIngredients: [],
  mashGuidelines: {
    startingThicknessLPerKg: DEFAULT_MASH_THICKNESS_L_PER_KG,
    grainTempC: null,
    autoStrikeVolume: true,
    steps: [defaultFirstMashStep()],
    notes: null,
  },
  waterProfile: null,
  pricing: { currency: 'DKK', lastChecked: '', source: '', available: false },
  cost: { usedDkk: 0, buyDkk: 0, priced: 0, unpriced: 0, purchase: [] },
};

export function RecipeCreatePage(): JSX.Element {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <main className="w-full max-w-[1100px] px-5 py-5">
        <Link to="/recipes" className="text-sm text-zinc-400 transition hover:text-zinc-100">
          ← Recipes
        </Link>
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#f06a5c]">New recipe</p>
          <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-zinc-50">
            Build a recipe from scratch
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            Add your batch details and ingredients; recipe statistics update as you build.
          </p>
        </div>
        <RecipeEditor
          recipe={EMPTY_RECIPE}
          saving={saving}
          error={error}
          onSave={create}
          onCancel={() => navigate('/recipes')}
        />
      </main>
    </DashboardShell>
  );
}
