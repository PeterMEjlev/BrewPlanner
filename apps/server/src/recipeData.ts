import type {
  RecipeDetail,
  RecipeEditInput,
  RecipeFermentable,
  RecipeHop,
  RecipeOrigin,
  RecipeOtherIngredient,
  PredictedColor,
  RecipeStats,
  RecipeVersionSummary,
  RecipeWaterProfile,
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
import { getWaterProfiles } from './repo.js';

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

/**
 * Resolve a recipe's saved-water-profile link against the current library.
 *
 * The link is live by design: a brewery that fixes a number in "House pale"
 * expects every recipe brewed to it to follow, which is the whole reason for
 * saving a profile instead of retyping one. So the stored ion columns are
 * overwritten here on every read rather than trusted.
 *
 * A link that no longer resolves — someone deleted the profile — falls back to
 * the stored snapshot and drops the id. That's the kinder failure: the recipe
 * keeps saying what it was brewed to, and stops claiming to follow something
 * that isn't there. `name` follows the profile too, so renaming one doesn't
 * leave recipes labelled with the old name.
 */
function resolveWaterProfile(profile: RecipeWaterProfile | null): RecipeWaterProfile | null {
  if (!profile?.profileId) return profile;
  const saved = getWaterProfiles().find((p) => p.id === profile.profileId);
  if (!saved) return { ...profile, profileId: null };
  return {
    ...profile,
    name: saved.name,
    calcium: String(saved.ca),
    magnesium: String(saved.mg),
    sodium: String(saved.na),
    chloride: String(saved.cl),
    sulfate: String(saved.so4),
    // null bicarbonate is a real answer, not a blank: the profile is deferring
    // to whatever the grist needs, which the water calculator solves per brew.
    bicarbonate: saved.hco3 == null ? null : String(saved.hco3),
  };
}

/**
 * What a stored sheet's beer pours, fruit included — without hydrating the rest
 * of it. Only the other-ingredients' weights are needed, and those are pure
 * arithmetic on what the sheet already says, so a list can afford this per row
 * where a full {@link hydrateRecipe} (catalogue matching, pricing) would cost
 * far more than a swatch is worth.
 */
export function pourColor(input: RecipeEditInput): PredictedColor | null {
  return predictBeerColor({
    ebc: input.ebc,
    batchSizeL: input.batchSizeL,
    additions: input.otherIngredients.map((line) => ({
      name: line.name,
      grams: toOtherGrams(line.amount, line.unit),
    })),
  });
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
    waterProfile: resolveWaterProfile(input.waterProfile),
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
    fruitAbvIncluded: recipe.fruitAbvIncluded,
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
    notes: recipe.notes,
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
