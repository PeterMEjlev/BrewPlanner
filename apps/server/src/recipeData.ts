import type {
  RecipeDetail,
  RecipeEditInput,
  RecipeFermentable,
  RecipeHop,
  RecipeOrigin,
  RecipeOtherIngredient,
  RecipeStats,
  RecipeVersionSummary,
  RecipeYeast,
} from '@checklist/shared';
import { predictBeerColor } from '@checklist/shared';
import {
  priceFermentable,
  priceHop,
  priceOther,
  priceYeast,
  pricingInfo,
  recipeCost,
} from './prices.js';

export interface RecipeMetadata {
  id: string;
  origin: RecipeOrigin;
  url: string;
  /** Which beer this is a version of, which version, and what changed in it. */
  familyId: string;
  version: number;
  versionNote: string;
  /** The beer's other versions, newest first — the version picker's list. */
  versions: RecipeVersionSummary[];
  createdAt: string;
  updatedAt: string;
}

function positiveNumber(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toGrams(amount: string, unit: string): number | null {
  const n = positiveNumber(amount);
  if (n == null) return null;
  switch (unit.toLowerCase()) {
    case 'g':
    case 'gram':
    case 'grams':
      return n;
    case 'kg':
      return n * 1_000;
    case 'oz':
      return n * 28.3495;
    case 'lb':
    case 'lbs':
      return n * 453.592;
    case 'mg':
      return n / 1_000;
    default:
      return unit === '' ? n : null;
  }
}

function toOtherGrams(amount: string, unit: string): number | null {
  const direct = toGrams(amount, unit);
  if (direct != null) return direct;
  const n = positiveNumber(amount);
  if (n == null) return null;
  switch (unit.toLowerCase()) {
    case 'ml':
      return n;
    case 'l':
    case 'liter':
    case 'litre':
      return n * 1_000;
    default:
      return null;
  }
}

function toUnits(amount: string, unit: string): number | null {
  const n = positiveNumber(amount);
  if (n == null) return null;
  return ['pkg', 'pkgs', 'each', 'items', 'vial'].includes(unit.toLowerCase()) ? n : null;
}

/** Rebuild weights, catalogue matches and totals from a stored editable sheet. */
export function hydrateRecipe(meta: RecipeMetadata, input: RecipeEditInput): RecipeDetail {
  const fermentables: RecipeFermentable[] = input.fermentables.map((line) => {
    const grams = toGrams(line.amount, line.unit);
    return {
      ...line,
      grams,
      price: grams == null ? null : priceFermentable(line.name, grams, line.ebc),
    };
  });
  const hops: RecipeHop[] = input.hops.map((line) => {
    const grams = toGrams(line.amount, line.unit);
    return { ...line, grams, price: grams == null ? null : priceHop(line.name, grams) };
  });
  const yeast: RecipeYeast[] = input.yeast.map((line) => {
    const grams = toGrams(line.amount, line.amountUnit);
    const units = toUnits(line.amount, line.amountUnit);
    return {
      ...line,
      grams,
      units,
      price: grams == null && units == null ? null : priceYeast(line.name, { grams, units }),
    };
  });
  const otherIngredients: RecipeOtherIngredient[] = input.otherIngredients.map((line) => {
    const grams = toOtherGrams(line.amount, line.unit);
    const units = toUnits(line.amount, line.unit);
    return {
      ...line,
      grams,
      units,
      price: grams == null && units == null ? null : priceOther(line.name, { grams, units }),
    };
  });
  const ingredients = [...fermentables, ...hops, ...yeast, ...otherIngredients];

  return {
    ...meta,
    ...input,
    fermentables,
    hops,
    yeast,
    otherIngredients,
    pricing: pricingInfo(),
    cost: recipeCost(ingredients),
  };
}

/** Strip server-derived pricing and normalized quantities before persistence. */
export function editableRecipe(recipe: RecipeDetail): RecipeEditInput {
  return {
    name: recipe.name,
    style: recipe.style,
    settings: { ...recipe.settings },
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
    fermentables: recipe.fermentables.map(({ grams: _grams, price: _price, ...line }) => line),
    hops: recipe.hops.map(({ grams: _grams, price: _price, ...line }) => line),
    yeast: recipe.yeast.map(
      ({ grams: _grams, units: _units, price: _price, ...line }) => line,
    ),
    otherIngredients: recipe.otherIngredients.map(
      ({ grams: _grams, units: _units, price: _price, ...line }) => line,
    ),
    mashGuidelines: recipe.mashGuidelines
      ? {
          startingThicknessLPerKg: recipe.mashGuidelines.startingThicknessLPerKg,
          grainTempC: recipe.mashGuidelines.grainTempC,
          autoStrikeVolume: recipe.mashGuidelines.autoStrikeVolume,
          steps: recipe.mashGuidelines.steps.map((step) => ({ ...step })),
          notes: recipe.mashGuidelines.notes,
        }
      : null,
    waterProfile: recipe.waterProfile ? { ...recipe.waterProfile } : null,
  };
}

export function recipeStats(recipe: RecipeDetail): RecipeStats {
  const weighed = recipe.hops.filter((hop) => hop.grams != null);
  const hopGrams =
    weighed.length === 0
      ? null
      : Math.round(weighed.reduce((sum, hop) => sum + (hop.grams ?? 0), 0) * 10) / 10;
  const predicted = predictBeerColor({
    ebc: recipe.ebc,
    batchSizeL: recipe.batchSizeL,
    additions: recipe.otherIngredients,
  });
  return {
    id: recipe.id,
    usedDkk: recipe.cost.priced > 0 ? recipe.cost.usedDkk : null,
    unpriced: recipe.cost.unpriced,
    hopGrams,
    batchSizeL: recipe.batchSizeL,
    hopsPerL:
      hopGrams == null || recipe.batchSizeL == null
        ? null
        : Math.round((hopGrams / recipe.batchSizeL) * 100) / 100,
    fruitColor: predicted?.fruit ? predicted.hex : null,
    fruitNote: predicted?.fruit?.note ?? null,
  };
}
