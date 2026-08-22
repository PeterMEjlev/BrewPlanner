import type { BrewSessionRecipeSnapshot, RecipeDetail } from '@checklist/shared';
import {
  ebcColor,
  estimateFruitAbvContribution,
  extractPotential,
  predictBeerColor,
} from '@checklist/shared';

/**
 * The recipe's headline figures, in the one shape every page that reads them
 * uses.
 *
 * Two pages show the same beer's numbers — the brew sheet, and the brew session
 * logged against it — and they used to work them out separately, which is how
 * the sheet came to read 5.1% ABV while the log beside it said 4.59%. Everything
 * either page prints is derived here instead, so a figure can only disagree with
 * itself if the recipe genuinely changed underneath it.
 */
export interface RecipeFigures {
  /**
   * Whether these came from the recipe as it stands, or from the copy frozen
   * onto a brew session — the fallback for a batch whose recipe was deleted,
   * which is the only case where the two can't be the same numbers.
   */
  source: 'recipe' | 'snapshot';
  name: string;
  style: string;
  /** Gravities and the rest, as bare strings in the shape the sheet holds them. */
  og: string;
  fg: string;
  abv: string;
  ibu: string;
  ebc: string;
  /**
   * The share of `abv` that comes from fruit rather than the grain bill; 0 for
   * a beer with no fruit in it. The sheet's ABV already includes this — it is
   * kept apart only so the breakdown under the figure can say where it came from.
   */
  fruitAbv: number;
  /** True when `ebc` was calculated from the grain bill rather than stated. */
  ebcEstimated: boolean;
  /** What the beer actually pours, fruit staining included; null if unknown. */
  pourHex: string | null;
  /** Why the swatch disagrees with the EBC figure, when it does. */
  pourNote: string | null;
  preBoilGravity: string | null;
  postBoilGravity: string | null;
  preBoilVolumeL: number | null;
  postBoilVolumeL: number | null;
  boilTimeMin: number | null;
  efficiencyPct: number | null;
  batchSizeL: number | null;
  /** Pre-formatted, as the sheet states them (e.g. "67°C"); null if unstated. */
  mashTemp: string | null;
  fermentationTemp: string | null;
  costDkk: number | null;
  grainKg: number | null;
  hopGrams: number | null;
  /** Every strain the sheet pitches, comma-joined; empty when it names none. */
  yeast: string;
  /**
   * The grain bill's extract at perfect extraction, in point-gallons — the
   * denominator a brew session's measured efficiency is a percentage of. Null
   * where nothing in the bill is a malt the fermentable table recognises, so
   * efficiency stays silent rather than being divided by a wrong number.
   */
  mashedPointGallons: number | null;
  unmashedPointGallons: number | null;
  preBoilUnmashedPointGallons: number | null;
}

/** Round for display, leaving a value we can't parse to show as-is. */
export function fmt(value: string | number | null | undefined, decimals: number): string {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n.toFixed(decimals) : String(value ?? '—');
}

/** Fermentable amounts, normalized to kg so the grain bill can be totalled. */
export function toKg(amount: string, unit: string): number {
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
export function toG(amount: string, unit: string): number {
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
 * The figures as the recipe reads right now — the preferred source everywhere.
 *
 * A brew session is judged against the version of the sheet it was brewed to
 * (its `recipeId` points at that row, not at the beer's newest version), so a
 * revision made afterwards lands in a new version and leaves an old log alone.
 * Correcting a typo in the version that *was* brewed does move the log's
 * targets, which is the point: the log should say what the recipe says.
 */
export function figuresFromRecipe(recipe: RecipeDetail): RecipeFigures {
  const potential = extractPotential(recipe.fermentables);
  const predicted = predictBeerColor({
    ebc: recipe.ebc,
    batchSizeL: recipe.batchSizeL,
    additions: recipe.otherIngredients,
  });
  const grainKg = recipe.fermentables.reduce((sum, f) => sum + toKg(f.amount, f.unit), 0);
  const hopGrams = recipe.hops.reduce((sum, h) => sum + toG(h.amount, h.unit), 0);
  return {
    source: 'recipe',
    name: recipe.name,
    style: recipe.style,
    og: recipe.og,
    fg: recipe.fg,
    abv: recipe.abv,
    ibu: recipe.ibu,
    ebc: recipe.ebc,
    fruitAbv: estimateFruitAbvContribution(recipe.otherIngredients, recipe.batchSizeL),
    ebcEstimated: recipe.ebcEstimated,
    pourHex: predicted?.hex ?? ebcColor(recipe.ebc),
    pourNote: predicted?.fruit?.note ?? null,
    preBoilGravity: recipe.preBoilGravity,
    postBoilGravity: recipe.postBoilGravity,
    // Off the settings rather than recalculated: a sheet is saved with its
    // automatic boil volumes already resolved, so these are the litres the
    // brewer was looking at when they decided to brew it.
    preBoilVolumeL: recipe.settings.boilSizePreL,
    postBoilVolumeL: recipe.settings.boilSizePostL,
    boilTimeMin: recipe.settings.boilTimeMinutes,
    efficiencyPct: recipe.settings.efficiencyPercent,
    batchSizeL: recipe.batchSizeL,
    mashTemp: recipe.mashTemp,
    fermentationTemp: recipe.fermentationTemp,
    costDkk: recipe.cost.priced > 0 ? recipe.cost.usedDkk : null,
    grainKg: grainKg > 0 ? grainKg : null,
    hopGrams: hopGrams > 0 ? hopGrams : null,
    yeast: recipe.yeast
      .map((line) => line.name.trim())
      .filter(Boolean)
      .join(', '),
    // Zero means "nothing here the mash has to work for", which is not a
    // denominator — report it as unknown rather than dividing by it.
    mashedPointGallons: potential.mashedPointGallons > 0 ? potential.mashedPointGallons : null,
    unmashedPointGallons: potential.unmashedPointGallons,
    preBoilUnmashedPointGallons: potential.preBoilUnmashedPointGallons,
  };
}

/**
 * The figures a brew session froze when it started. Only reached once the recipe
 * behind the batch has been deleted — there is then no live sheet to read, and
 * the copy taken on the day is all that is left of it.
 *
 * The fruit share and the pour colour need the other-ingredients list, which the
 * snapshot doesn't carry, so a deleted fruited beer loses its breakdown and
 * falls back to the malt colour. That is a fair description of what is known.
 */
export function figuresFromSnapshot(snapshot: BrewSessionRecipeSnapshot): RecipeFigures {
  return {
    source: 'snapshot',
    name: snapshot.name,
    style: snapshot.style,
    og: snapshot.og,
    fg: snapshot.fg,
    abv: snapshot.abv,
    ibu: snapshot.ibu,
    ebc: snapshot.ebc,
    fruitAbv: 0,
    ebcEstimated: false,
    pourHex: ebcColor(snapshot.ebc),
    pourNote: null,
    preBoilGravity: snapshot.preBoilGravity,
    postBoilGravity: snapshot.postBoilGravity,
    preBoilVolumeL: snapshot.preBoilVolumeL,
    postBoilVolumeL: snapshot.postBoilVolumeL,
    boilTimeMin: snapshot.boilTimeMin,
    efficiencyPct: snapshot.efficiencyPct,
    batchSizeL: snapshot.batchSizeL,
    mashTemp: snapshot.mashTemp,
    fermentationTemp: snapshot.fermentationTemp,
    costDkk: snapshot.costDkk,
    grainKg: snapshot.grainKg,
    hopGrams: snapshot.hopGrams,
    yeast: snapshot.yeast,
    mashedPointGallons: snapshot.mashedPointGallons,
    unmashedPointGallons: snapshot.unmashedPointGallons,
    preBoilUnmashedPointGallons: snapshot.preBoilUnmashedPointGallons,
  };
}
