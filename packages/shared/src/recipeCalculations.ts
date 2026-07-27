import type { RecipeEditInput, RecipeHopEdit } from './index.js';

export interface RecipeCalculationResult {
  originalGravity: number | null;
  preBoilGravity: number | null;
  postBoilGravity: number | null;
  finalGravity: number | null;
  abv: number | null;
  ibu: number | null;
  ebc: number | null;
  mashPh: number | null;
  /** Per-addition values, in the same order as `recipe.hops`. */
  hopIbus: Array<number | null>;
  /** Weight shares, in the same order as `recipe.fermentables`. */
  fermentablePercents: Array<number | null>;
}

const LITRES_PER_GALLON = 3.78541;

function recipeNumber(value: string | number | null | undefined): number | null {
  const parsed = typeof value === 'number'
    ? value
    : Number.parseFloat(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function weightPounds(amount: string, unit: string): number | null {
  const value = recipeNumber(amount);
  if (value == null || value < 0) return null;
  switch (unit.trim().toLowerCase()) {
    case 'kg': return value * 2.2046226218;
    case 'g': return value / 453.59237;
    case 'oz': return value / 16;
    case 'lb':
    case 'lbs': return value;
    default: return null;
  }
}

function weightGrams(amount: string, unit: string): number | null {
  const pounds = weightPounds(amount, unit);
  return pounds == null ? null : pounds * 453.59237;
}

/** A conservative extract-potential fallback for catalogue items without PPG metadata. */
export function estimateFermentablePpg(name: string): number {
  const value = name.toLocaleLowerCase();
  if (/rice hull|husk/.test(value)) return 0;
  if (/dextrose|corn sugar|table sugar|sucrose|candi sugar|invert sugar/.test(value)) return 46;
  if (/dry malt extract|\bdme\b/.test(value)) return 44;
  if (/liquid malt extract|\blme\b/.test(value)) return 36;
  if (/lactose|milk sugar/.test(value)) return 42;
  if (/wheat|pilsner|pale ale|\b2-row\b|\b6-row\b|vienna|munich/.test(value)) return 37;
  if (/oat|flaked|rye|maize|corn|rice/.test(value)) return 33;
  if (/crystal|caramel|cara|biscuit|amber|brown/.test(value)) return 34;
  if (/roast|chocolate|black|patent/.test(value)) return 30;
  return 36;
}

function gravityFromPointGallons(pointGallons: number, litres: number | null): number | null {
  if (litres == null || litres <= 0 || pointGallons <= 0) return null;
  return 1 + pointGallons / (litres / LITRES_PER_GALLON) / 1000;
}

function attenuation(recipe: RecipeEditInput): number | null {
  const values = recipe.yeast
    .map((line) => recipeNumber(line.attenuation))
    .filter((value): value is number => value != null && value >= 0 && value <= 100);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function hopMinutes(recipe: RecipeEditInput, hop: RecipeHopEdit): number | null {
  if (hop.stage === 'First Wort') return recipe.settings.boilTimeMinutes ?? 60;
  if (hop.stage === 'Mash') return 5;
  if (hop.stage !== 'Boil') return null;
  return recipeNumber(hop.time);
}

function tinsethUtilization(minutes: number, gravity: number): number {
  return 1.65 * Math.pow(0.000125, gravity - 1) * (1 - Math.exp(-0.04 * minutes)) / 4.15;
}

function hopIbu(recipe: RecipeEditInput, hop: RecipeHopEdit, boilGravity: number): number | null {
  const grams = weightGrams(hop.amount, hop.unit);
  const alpha = recipeNumber(hop.aa);
  const batchLitres = recipe.settings.boilSizePostL ?? recipe.batchSizeL;
  if (grams == null || alpha == null || batchLitres == null || batchLitres <= 0) return null;
  if (hop.stage === 'Dry Hop' || hop.stage === 'Other') return 0;

  if (hop.stage === 'Whirlpool') {
    const utilization = 5;
    return grams * (alpha / 100) * (utilization / 100) * 1000 / batchLitres;
  }

  const minutes = hopMinutes(recipe, hop);
  if (minutes == null || minutes < 0) return null;
  const pelletFactor = hop.form.toLocaleLowerCase().includes('pellet') ? 1.1 : 1;
  return grams * (alpha / 100) * tinsethUtilization(minutes, boilGravity)
    * pelletFactor * 1000 / batchLitres;
}

function recipeColor(recipe: RecipeEditInput): number | null {
  if (recipe.batchSizeL == null || recipe.batchSizeL <= 0) return null;
  const gallons = recipe.batchSizeL / LITRES_PER_GALLON;
  let mcu = 0;
  for (const line of recipe.fermentables) {
    const pounds = weightPounds(line.amount, line.unit);
    if (pounds == null || line.ebc == null) continue;
    const srm = line.ebc / 1.97;
    const lovibond = Math.max(0, (srm + 0.76) / 1.3546);
    mcu += pounds * lovibond / gallons;
  }
  if (mcu <= 0) return null;
  const srm = 1.4922 * Math.pow(mcu, 0.6859);
  return Math.max(0, srm * 1.97);
}

/**
 * Mash-pH estimate from grist colour, residual alkalinity, and acidulated malt.
 * Exact malt acidity and acid additions are not present in the recipe model, so
 * this value must stay visibly labelled as an estimate in consuming UIs.
 */
function recipeMashPh(recipe: RecipeEditInput, percents: Array<number | null>): number | null {
  const coloured = recipe.fermentables
    .map((line, index) => ({ line, percent: percents[index] }))
    .filter(({ line, percent }) => line.ebc != null && percent != null && percent > 0);
  if (!coloured.length) return null;

  const weightedLovibond = coloured.reduce((sum, { line, percent }) => {
    const srm = (line.ebc ?? 0) / 1.97;
    return sum + Math.max(0, (srm + 0.76) / 1.3546) * (percent ?? 0) / 100;
  }, 0);
  const acidulatedPercent = coloured.reduce((sum, { line, percent }) =>
    /acidulated|sauer\s?malz|sour malt/i.test(line.name) ? sum + (percent ?? 0) : sum, 0);

  const water = recipe.waterProfile;
  const calcium = recipeNumber(water?.calcium) ?? 0;
  const magnesium = recipeNumber(water?.magnesium) ?? 0;
  const bicarbonate = recipeNumber(water?.bicarbonate) ?? 0;
  const alkalinityAsCaco3 = bicarbonate * 50 / 61;
  const residualAlkalinity = alkalinityAsCaco3 - calcium / 3.5 - magnesium / 7;
  const estimated = 5.7
    - 0.17 * Math.log10(Math.max(1, weightedLovibond))
    + residualAlkalinity / 500
    - acidulatedPercent * 0.1;
  return Math.min(6.5, Math.max(3.5, estimated));
}

/** Calculate all recipe statistics from ingredient, volume, yeast, and water inputs. */
export function calculateRecipe(recipe: RecipeEditInput): RecipeCalculationResult {
  const efficiency = (recipe.settings.efficiencyPercent ?? 80) / 100;
  const pounds = recipe.fermentables.map((line) => weightPounds(line.amount, line.unit));
  const totalPounds = pounds.reduce((sum: number, value) => sum + (value ?? 0), 0);
  const fermentablePercents = pounds.map((value) =>
    value == null || totalPounds <= 0 ? null : value / totalPounds * 100);
  const pointGallons = recipe.fermentables.reduce((sum, line, index) => {
    const weight = pounds[index];
    if (weight == null) return sum;
    return sum + weight * (line.ppg ?? estimateFermentablePpg(line.name)) * efficiency;
  }, 0);
  const boilPointGallons = recipe.fermentables.reduce((sum, line, index) => {
    const weight = pounds[index];
    if (weight == null) return sum;
    return sum + weight * (line.ppg ?? estimateFermentablePpg(line.name)) * efficiency;
  }, 0);

  const originalGravity = gravityFromPointGallons(pointGallons, recipe.batchSizeL);
  const preBoilGravity = gravityFromPointGallons(
    boilPointGallons,
    recipe.settings.boilSizePreL ?? recipe.settings.boilSizePostL ?? recipe.batchSizeL,
  );
  const postBoilGravity = gravityFromPointGallons(
    pointGallons,
    recipe.settings.boilSizePostL ?? recipe.batchSizeL,
  );
  const yeastAttenuation = attenuation(recipe);
  const finalGravity = originalGravity == null || yeastAttenuation == null
    ? null
    : 1 + (originalGravity - 1) * (1 - yeastAttenuation / 100);
  const abv = originalGravity == null || finalGravity == null
    ? null
    : (originalGravity - finalGravity) * 131.25;
  const gravityForHops = preBoilGravity ?? postBoilGravity ?? originalGravity ?? 1;
  const hopIbus = recipe.hops.map((hop) => hopIbu(recipe, hop, gravityForHops));
  const ibuValues = hopIbus.filter((value): value is number => value != null);
  const ibu = recipe.hops.length && ibuValues.length
    ? ibuValues.reduce((sum, value) => sum + value, 0)
    : null;

  return {
    originalGravity,
    preBoilGravity,
    postBoilGravity,
    finalGravity,
    abv,
    ibu,
    ebc: recipeColor(recipe),
    mashPh: recipeMashPh(recipe, fermentablePercents),
    hopIbus,
    fermentablePercents,
  };
}

function calculatedText(value: number | null, decimals: number): string {
  return value == null ? '' : value.toFixed(decimals);
}

/** Store the displayed calculation outputs with a recipe snapshot. */
export function applyRecipeCalculations(recipe: RecipeEditInput): RecipeEditInput {
  const result = calculateRecipe(recipe);
  return {
    ...recipe,
    og: calculatedText(result.originalGravity, 3),
    preBoilGravity: result.preBoilGravity == null ? null : calculatedText(result.preBoilGravity, 3),
    postBoilGravity: result.postBoilGravity == null ? null : calculatedText(result.postBoilGravity, 3),
    fg: calculatedText(result.finalGravity, 3),
    abv: calculatedText(result.abv, 2),
    ibu: calculatedText(result.ibu, 2),
    ebc: calculatedText(result.ebc, 1),
    ebcEstimated: result.ebc != null,
    fermentables: recipe.fermentables.map((line, index) => ({
      ...line,
      percent: calculatedText(result.fermentablePercents[index] ?? null, 1),
    })),
    hops: recipe.hops.map((line, index) => ({
      ...line,
      ibu: calculatedText(result.hopIbus[index] ?? null, 2),
    })),
    waterProfile: recipe.waterProfile || result.mashPh != null
      ? {
          ...(recipe.waterProfile ?? {
            sourceName: null,
            name: null,
            notes: null,
            calcium: null,
            magnesium: null,
            sodium: null,
            chloride: null,
            sulfate: null,
            bicarbonate: null,
          }),
          ph: result.mashPh == null ? null : calculatedText(result.mashPh, 2),
        }
      : null,
  };
}
