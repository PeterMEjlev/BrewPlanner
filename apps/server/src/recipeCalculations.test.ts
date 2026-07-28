import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateRecipe,
  DEFAULT_RECIPE_SETTINGS,
  estimateFermentablePpg,
  fermentableExtract,
  isFermentableLine,
} from '@checklist/shared';
import type { RecipeEditInput, RecipeFermentableEdit } from '@checklist/shared';

function grainBill(...fermentables: Array<Partial<RecipeFermentableEdit>>): RecipeEditInput {
  return {
    name: 'Gravity fixture',
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
    batchSizeL: 20,
    mashTemp: '',
    fermentationTemp: '',
    fermentables: fermentables.map((line) => ({
      name: '',
      amount: '',
      unit: 'kg',
      percent: '',
      ebc: null,
      ppg: null,
      ...line,
      // Spreading a Partial widens these two to `undefined`, which the row type
      // doesn't allow — so they get the schema's defaults explicitly.
      fermentable: line.fermentable ?? null,
      lateAddition: line.lateAddition ?? false,
    })),
    hops: [],
    yeast: [],
    otherIngredients: [],
    mashGuidelines: null,
    waterProfile: null,
  };
}

test('an amount with no malt chosen yet contributes no gravity', () => {
  const result = calculateRecipe(grainBill({ amount: '10' }));
  assert.equal(result.originalGravity, null);
  assert.equal(result.preBoilGravity, null);
  assert.equal(result.postBoilGravity, null);
  // The share is a weight ratio, so it still reads — only the sugar is unknown.
  assert.equal(result.fermentablePercents[0], 100);
});

test('gravity appears, and moves, with the malt the row names', () => {
  const pilsner = calculateRecipe(grainBill({ amount: '10', name: 'Pilsner Malt' })).originalGravity;
  const roasted = calculateRecipe(grainBill({ amount: '10', name: 'Roasted Barley' })).originalGravity;
  assert.ok(pilsner != null && roasted != null);
  // 10 kg = 22.046 lb; Pilsner is 37 PPG against roasted barley's 25, both at
  // the default 80% brewhouse efficiency into 20 L (5.283 gal).
  assert.equal(Number(pilsner.toFixed(3)), 1.124);
  assert.equal(Number(roasted.toFixed(3)), 1.083);
});

test('efficiency scales mashed grain but not sugar', () => {
  const half = { ...DEFAULT_RECIPE_SETTINGS, efficiencyPercent: 50 };
  const sugarAtFull = calculateRecipe(grainBill({ amount: '1', name: 'Table Sugar' }));
  const sugarAtHalf = calculateRecipe({
    ...grainBill({ amount: '1', name: 'Table Sugar' }),
    settings: half,
  });
  assert.equal(sugarAtFull.originalGravity, sugarAtHalf.originalGravity);

  const maltAtFull = calculateRecipe(grainBill({ amount: '1', name: 'Pilsner Malt' }));
  const maltAtHalf = calculateRecipe({
    ...grainBill({ amount: '1', name: 'Pilsner Malt' }),
    settings: half,
  });
  assert.ok(maltAtHalf.originalGravity! < maltAtFull.originalGravity!);
});

test("a brewer's own PPG overrides the malt's, and rice hulls stay inert", () => {
  const stock = calculateRecipe(grainBill({ amount: '5', name: 'Maris Otter' })).originalGravity;
  const measured = calculateRecipe(
    grainBill({ amount: '5', name: 'Maris Otter', ppg: 30 }),
  ).originalGravity;
  assert.ok(measured! < stock!);
  assert.equal(calculateRecipe(grainBill({ amount: '1', name: 'Rice Hulls' })).originalGravity, null);
});

test('lactose lifts the FG and costs ABV instead of turning into alcohol', () => {
  const yeast = [{
    name: 'US-05',
    lab: '',
    attenuation: '75',
    amount: '1',
    amountUnit: 'pkg',
    type: 'Ale',
    form: 'Dry',
    flocculation: '',
    minTempC: null,
    maxTempC: null,
    alcoholTolerance: '',
    starter: false,
  }];
  const plain = { ...grainBill({ amount: '5', name: 'Pale Malt' }), yeast };
  const milky = {
    ...grainBill({ amount: '5', name: 'Pale Malt' }, { amount: '0.5', name: 'Lactose' }),
    yeast,
  };
  const plainResult = calculateRecipe(plain);
  const milkyResult = calculateRecipe(milky);

  // The lactose raises OG like any sugar…
  assert.ok(milkyResult.originalGravity! > plainResult.originalGravity!);
  // …but every one of its points survives fermentation, so FG climbs by more
  // than attenuation would have left behind, and the ABV barely moves.
  assert.ok(milkyResult.finalGravity! > plainResult.finalGravity!);
  assert.ok(Math.abs(milkyResult.abv! - plainResult.abv!) < 0.05);

  // Ticking "not fermentable" on the pale malt is the same lever by hand.
  const overridden = calculateRecipe({
    ...grainBill({ amount: '5', name: 'Pale Malt', fermentable: false }),
    yeast,
  });
  assert.equal(overridden.finalGravity, overridden.originalGravity);
  assert.equal(overridden.abv, 0);
});

test('a late addition stays out of the boil gravity but still counts in the OG', () => {
  const hops = [{
    name: 'Magnum',
    amount: '50',
    unit: 'g',
    use: 'Boil',
    stage: 'Boil' as const,
    time: '60',
    timeUnit: 'min' as const,
    aa: '12',
    ibu: '',
    form: 'Pellet',
    utilization: '',
    temp: '',
  }];
  const inBoil = {
    ...grainBill({ amount: '5', name: 'Pale Malt' }, { amount: '1', name: 'Table Sugar' }),
    hops,
  };
  const late = {
    ...grainBill(
      { amount: '5', name: 'Pale Malt' },
      { amount: '1', name: 'Table Sugar', lateAddition: true },
    ),
    hops,
  };
  const inBoilResult = calculateRecipe(inBoil);
  const lateResult = calculateRecipe(late);

  assert.equal(lateResult.originalGravity, inBoilResult.originalGravity);
  assert.ok(lateResult.preBoilGravity! < inBoilResult.preBoilGravity!);
  assert.ok(lateResult.postBoilGravity! < inBoilResult.postBoilGravity!);
  // Thinner wort in the kettle means the hops isomerise better.
  assert.ok(lateResult.ibu! > inBoilResult.ibu!);
});

test('fermentable lookup separates grains from pre-converted sugars', () => {
  assert.deepEqual(fermentableExtract('Honey Malt'), { ppg: 37, mashed: true, fermentable: true });
  assert.deepEqual(fermentableExtract('Honey'), { ppg: 35, mashed: false, fermentable: true });
  assert.deepEqual(fermentableExtract('Pale Chocolate Malt'), { ppg: 28, mashed: true, fermentable: true });
  assert.deepEqual(fermentableExtract('Dry Malt Extract - Light'), { ppg: 44, mashed: false, fermentable: true });
  assert.deepEqual(fermentableExtract('Lactose (Milk Sugar)'), { ppg: 35, mashed: false, fermentable: false });
  assert.equal(fermentableExtract('   '), null);
  assert.equal(estimateFermentablePpg(''), null);
  assert.equal(estimateFermentablePpg('Weyermann Vienna'), 36);
});

test('the fermentability flag reads the brewer first and the fermentable second', () => {
  assert.equal(isFermentableLine({ name: 'Lactose', fermentable: null }), false);
  assert.equal(isFermentableLine({ name: 'Lactose', fermentable: true }), true);
  assert.equal(isFermentableLine({ name: 'Pilsner Malt', fermentable: null }), true);
  assert.equal(isFermentableLine({ name: 'Pilsner Malt', fermentable: false }), false);
  assert.equal(isFermentableLine({ name: '', fermentable: null }), true);
});
