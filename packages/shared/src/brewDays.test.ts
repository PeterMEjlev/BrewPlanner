import { describe, expect, it } from 'vitest';
import {
  abvFromGravities,
  apparentAttenuation,
  calculateRecipe,
  DEFAULT_RECIPE_SETTINGS,
  extractPotential,
  measuredEfficiency,
} from './index.js';
import type { RecipeEditInput } from './index.js';

/**
 * What a brew day's measured gravities add up to. Both take the figures as the
 * brewer typed them, which is why the string cases matter as much as the maths.
 */

describe('apparentAttenuation', () => {
  it('is the share of the extract the yeast took', () => {
    // 1.060 → 1.012: 48 of the 60 points gone.
    expect(apparentAttenuation('1.060', '1.012')).toBeCloseTo(80, 5);
    expect(apparentAttenuation(1.05, 1.01)).toBeCloseTo(80, 5);
  });

  it('has no answer without both gravities', () => {
    expect(apparentAttenuation('', '1.012')).toBeNull();
    expect(apparentAttenuation('1.060', '')).toBeNull();
    expect(apparentAttenuation('not a gravity', '1.012')).toBeNull();
  });

  it('refuses a wort that never had any extract in it', () => {
    // OG at or below water is either a typo or a reading of the tap — either
    // way, dividing by it would report a confident nonsense.
    expect(apparentAttenuation('1.000', '0.998')).toBeNull();
    expect(apparentAttenuation('0.999', '0.998')).toBeNull();
  });
});

describe('abvFromGravities', () => {
  it('follows the same formula the recipe calculations use', () => {
    expect(abvFromGravities('1.060', '1.012')).toBeCloseTo(6.3, 1);
    expect(abvFromGravities(1.048, 1.01)).toBeCloseTo(4.99, 2);
  });

  it('is null until both have been measured', () => {
    expect(abvFromGravities('1.060', '')).toBeNull();
    expect(abvFromGravities('', '')).toBeNull();
  });

  it('reports a stalled ferment rather than hiding it', () => {
    // A finished beer that read higher than it started is a measurement worth
    // seeing, not one to clamp to zero.
    expect(abvFromGravities('1.010', '1.020')).toBeLessThan(0);
  });
});

/** A single-malt bill, so the arithmetic is checkable by hand. */
function baseRecipe(): RecipeEditInput {
  return {
    name: 'Efficiency test',
    style: '',
    settings: { ...DEFAULT_RECIPE_SETTINGS, efficiencyPercent: 75 },
    og: '',
    preBoilGravity: null,
    postBoilGravity: null,
    fg: '',
    abv: '',
    ibu: '',
    ebc: '',
    ebcEstimated: false,
    batchSizeL: 20,
    mashTemp: null,
    fermentationTemp: null,
    fermentables: [
      { name: 'Pale Ale Malt', amount: '5', unit: 'kg', percent: '', ebc: 6, ppg: 37, fermentable: null, lateAddition: false },
    ],
    hops: [],
    yeast: [],
    otherIngredients: [],
    mashGuidelines: null,
    waterProfile: null,
  };
}

describe('measuredEfficiency', () => {
  it('is the exact inverse of the gravity the recipe predicts', () => {
    // The strongest statement available: brew a recipe that says 75%, hit its
    // predicted OG in its stated volume, and the day must read back 75%.
    const recipe = baseRecipe();
    const predicted = calculateRecipe(recipe).originalGravity!;
    const potential = extractPotential(recipe.fermentables);

    expect(
      measuredEfficiency({
        gravity: predicted,
        litres: recipe.batchSizeL,
        mashedPointGallons: potential.mashedPointGallons,
        unmashedPointGallons: potential.unmashedPointGallons,
      }),
    ).toBeCloseTo(75, 6);
  });

  it('falls when the same wort is spread over more litres', () => {
    const potential = extractPotential(baseRecipe().fermentables);
    const at20 = measuredEfficiency({
      gravity: '1.050',
      litres: 20,
      ...potential,
    })!;
    const at23 = measuredEfficiency({ gravity: '1.050', litres: 23, ...potential })!;
    // More volume at the same gravity is more sugar, so a higher efficiency —
    // which is exactly why a misjudged volume is worth overriding.
    expect(at23).toBeGreaterThan(at20);
    expect(at23 / at20).toBeCloseTo(23 / 20, 6);
  });

  it('does not credit the mash with sugar that never went through it', () => {
    const recipe = baseRecipe();
    recipe.fermentables.push({
      name: 'Table Sugar',
      amount: '500',
      unit: 'g',
      percent: '',
      ebc: 0,
      ppg: null,
      fermentable: null,
      lateAddition: false,
    });
    const potential = extractPotential(recipe.fermentables);
    expect(potential.unmashedPointGallons).toBeGreaterThan(0);
    // The sugar dissolves whole, so it belongs to neither the mash's numerator
    // nor its denominator.
    const withSugar = measuredEfficiency({ gravity: '1.055', litres: 20, ...potential })!;
    const asIfMash = measuredEfficiency({
      gravity: '1.055',
      litres: 20,
      mashedPointGallons: potential.mashedPointGallons,
      unmashedPointGallons: 0,
    })!;
    expect(withSugar).toBeLessThan(asIfMash);
  });

  it('keeps a late addition out of the pre-boil kettle', () => {
    const recipe = baseRecipe();
    recipe.fermentables.push({
      name: 'Honey',
      amount: '1',
      unit: 'kg',
      percent: '',
      ebc: 2,
      ppg: null,
      fermentable: null,
      // Stirred in after the boil, so the pre-boil reading can't see it.
      lateAddition: true,
    });
    const potential = extractPotential(recipe.fermentables);
    expect(potential.unmashedPointGallons).toBeGreaterThan(0);
    expect(potential.preBoilUnmashedPointGallons).toBe(0);
  });

  it('says nothing rather than guessing', () => {
    const potential = extractPotential(baseRecipe().fermentables);
    expect(measuredEfficiency({ gravity: '', litres: 20, ...potential })).toBeNull();
    expect(measuredEfficiency({ gravity: '1.050', litres: null, ...potential })).toBeNull();
    // A bill with nothing to mash has no efficiency to report, however it went.
    expect(
      measuredEfficiency({
        gravity: '1.050',
        litres: 20,
        mashedPointGallons: null,
        unmashedPointGallons: 0,
      }),
    ).toBeNull();
  });

  it('lets an impossible figure through so it can be seen', () => {
    const potential = extractPotential(baseRecipe().fermentables);
    // 5 kg of 37 PPG malt cannot exceed 1.077 in 20 L however perfect the mash,
    // so 1.085 is a mistyped gravity or a misjudged volume. Clamping it to a
    // tidy 100% would hide the very thing worth noticing.
    expect(measuredEfficiency({ gravity: '1.085', litres: 20, ...potential })!).toBeGreaterThan(100);
    // And the ceiling itself reads as the 100% it is.
    expect(measuredEfficiency({ gravity: '1.0772', litres: 20, ...potential })!).toBeCloseTo(100, 1);
  });
});
