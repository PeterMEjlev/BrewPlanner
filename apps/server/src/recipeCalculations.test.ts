import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aromaHopRate,
  calculateRecipe,
  DEFAULT_RECIPE_SETTINGS,
  estimateFermentablePpg,
  estimateFermentationDays,
  estimateFruitAbvContribution,
  fermentableExtract,
  isFermentableLine,
  withAutoBoilVolumes,
} from '@checklist/shared';
import type {
  RecipeEditInput,
  RecipeFermentableEdit,
  RecipeHopEdit,
  RecipeYeastEdit,
} from '@checklist/shared';

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

test('fruit juice and puree add their fermentable sugar to estimated ABV', () => {
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
    addAfterDays: '',
    heldAtC: '',
  }];
  const base = { ...grainBill({ amount: '7', name: 'Pale Malt' }), batchSizeL: 55, yeast };
  const rhapsody = {
    ...base,
    otherIngredients: [{
      name: 'Raspberry puree',
      amount: '5',
      unit: 'L',
      use: 'Primary',
      time: '5',
      timeUnit: 'day' as const,
      type: 'Flavor',
    }],
  };
  const plain = calculateRecipe(base);
  const fruited = calculateRecipe(rhapsody);

  // Typical unsweetened raspberry puree is estimated at 9 Brix. Five litres
  // in a 55 L batch contribute about 0.48 percentage points when fermented dry.
  assert.ok(Math.abs(fruited.fruitAbv - (5 / 55) * 9 * 0.59) < 0.0001);
  assert.ok(Math.abs((fruited.abv! - plain.abv!) - fruited.fruitAbv) < 0.0001);
  // It is a post-kettle alcohol contribution, not an invented boil gravity.
  assert.equal(fruited.originalGravity, plain.originalGravity);
  assert.equal(fruited.finalGravity, plain.finalGravity);

  // Danish compounds and weight-entered puree use the same 1 kg/L convention.
  assert.ok(Math.abs(estimateFruitAbvContribution([{
    ...rhapsody.otherIngredients[0]!,
    name: 'Hindbærpuré',
    amount: '5',
    unit: 'kg',
  }], 55) - fruited.fruitAbv) < 0.0001);
  // Other liquid additions must not be mistaken for fermentable fruit.
  assert.equal(estimateFruitAbvContribution([{
    ...rhapsody.otherIngredients[0]!,
    name: 'Lactic acid',
  }], 55), 0);
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

test('bitterness is diluted into the batch, not into the kettle', () => {
  // 50 g of 12% pellets at 60 minutes, Tinseth against the pre-boil gravity,
  // into a 20 L batch — the trub the kettle keeps back doesn't take IBUs with
  // it, so the divisor is the batch size rather than the 22 L post-boil volume.
  const brew = {
    ...grainBill({ amount: '5', name: 'Pilsner Malt' }),
    hops: [{
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
    }],
  };
  const boiled = withAutoBoilVolumes(brew);
  assert.equal(boiled.settings.boilSizePostL, 22);
  assert.equal(Number(calculateRecipe(boiled).ibu!.toFixed(2)), 81.36);

  // With no batch size at all the post-boil volume is the only thing to divide
  // by, and it is used rather than dropping the figure.
  const unsized = withAutoBoilVolumes({ ...brew, batchSizeL: null });
  assert.equal(calculateRecipe({
    ...unsized,
    settings: { ...unsized.settings, boilSizePostL: 22 },
  }).ibu != null, true);
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

function hop(line: Partial<RecipeHopEdit>): RecipeHopEdit {
  return {
    name: 'Citra',
    amount: '50',
    unit: 'g',
    use: 'Boil',
    stage: 'Boil',
    time: '',
    timeUnit: 'min',
    aa: '12',
    ibu: '',
    form: 'Pellet',
    utilization: '',
    temp: '',
    ...line,
  };
}

test('a whirlpool bitters by its time and temperature, and falls back without them', () => {
  const brew = (line: Partial<RecipeHopEdit>): number =>
    calculateRecipe({ ...grainBill({ amount: '5', name: 'Pilsner Malt' }), hops: [hop(line)] }).ibu!;

  // Nothing stated: the flat 5% the app has always used, so imported sheets
  // keep the IBUs they were saved with.
  const flat = brew({ stage: 'Whirlpool' });
  assert.equal(Number(flat.toFixed(2)), 15);

  // A stand at boiling for 20 minutes isomerises like a 20-minute boil charge…
  const boiling = brew({ stage: 'Whirlpool', time: '20', temp: '100' });
  const kettle = brew({ stage: 'Boil', time: '20' });
  // …bar the pellet factor, which the whirlpool path doesn't apply.
  assert.ok(Math.abs(boiling - kettle / 1.1) < 0.01);

  // The same 20 minutes held cooler is worth much less, and cooler still less
  // again — which is the whole reason a hopstand is a hopstand.
  const hot = brew({ stage: 'Whirlpool', time: '20', temp: '90' });
  const warm = brew({ stage: 'Whirlpool', time: '20', temp: '80' });
  assert.ok(boiling > hot && hot > warm);
  assert.ok(warm < flat);

  // Longer at the same temperature is more; a thermometer reading above
  // boiling is not.
  assert.ok(brew({ stage: 'Whirlpool', time: '40', temp: '80' }) > warm);
  assert.equal(brew({ stage: 'Whirlpool', time: '20', temp: '110' }), boiling);

  // A utilization typed on the addition is the brewer's own measurement.
  assert.equal(
    Number(brew({ stage: 'Whirlpool', time: '20', temp: '80', utilization: '10' }).toFixed(2)),
    30,
  );

  // Days on a whirlpool is a mis-stage, not a three-minute stand.
  assert.equal(brew({ stage: 'Whirlpool', time: '3', timeUnit: 'day', temp: '80' }), flat);
});

test('the aroma hop rate counts the whirlpool and the dry hop only', () => {
  const hops = [
    hop({ stage: 'Boil', amount: '50', time: '60' }),
    hop({ stage: 'Whirlpool', amount: '100' }),
    hop({ stage: 'Dry Hop', amount: '0.15', unit: 'kg' }),
  ];
  // 100 g + 150 g over 20 L, with the bittering charge left out. (Weights are
  // normalized through pounds, so the figure is compared as it is displayed.)
  assert.equal(Number(aromaHopRate(hops, 20)!.toFixed(4)), 12.5);
  assert.equal(aromaHopRate(hops, null), null);
  assert.equal(aromaHopRate(hops, 0), null);
  assert.equal(aromaHopRate([hop({ stage: 'Boil', time: '60' })], 20), null);
});

function pitch(line: Partial<RecipeYeastEdit>): RecipeYeastEdit {
  return {
    name: 'Fermentis SafAle US-05',
    lab: '',
    attenuation: '81',
    amount: '1',
    amountUnit: 'pkg',
    type: 'Ale',
    form: 'Dry',
    flocculation: '',
    minTempC: null,
    maxTempC: null,
    alcoholTolerance: '',
    starter: false,
    addAfterDays: '',
    ...line,
  };
}

test('fermentation time follows the strain, the temperature and the gravity', () => {
  const ale = estimateFermentationDays({ og: 1.05, temperatureC: '20', yeast: [pitch({})] });
  assert.ok(ale != null);
  assert.equal(ale.days, 5);
  assert.equal(ale.family, 'ale');
  assert.equal(ale.temperatureAssumed, false);
  assert.ok(ale.minDays < ale.days && ale.maxDays > ale.days);

  // Cooler is slower, warmer is faster — the rule of thumb every brewer knows.
  const cool = estimateFermentationDays({ og: 1.05, temperatureC: 16, yeast: [pitch({})] });
  const warm = estimateFermentationDays({ og: 1.05, temperatureC: 24, yeast: [pitch({})] });
  assert.ok(cool!.days > ale.days && warm!.days < ale.days);

  // A bigger beer is more work at the same temperature.
  const big = estimateFermentationDays({ og: 1.09, temperatureC: 20, yeast: [pitch({})] });
  assert.ok(big!.days > ale.days);

  // A lager at lager temperatures is a fortnight; kveik pitched hot is days.
  const lager = estimateFermentationDays({
    og: 1.05,
    temperatureC: 11,
    yeast: [pitch({ name: 'Fermentis SafLager W-34/70', type: 'Lager' })],
  });
  const kveik = estimateFermentationDays({
    og: 1.05,
    temperatureC: 32,
    yeast: [pitch({ name: 'Lallemand Voss Kveik' })],
  });
  assert.equal(lager!.family, 'lager');
  assert.equal(kveik!.family, 'kveik');
  assert.ok(lager!.days > 10 && kveik!.days <= 3);

  // Co-pitched, the slowest strain decides when the fermenter is free.
  const mixed = estimateFermentationDays({
    og: 1.05,
    temperatureC: 20,
    yeast: [pitch({}), pitch({ name: 'Brettanomyces Bruxellensis', type: 'Brett' })],
  });
  assert.equal(mixed!.family, 'mixed');
  assert.ok(mixed!.days > ale.days);

  // A single-strain souring yeast sours the wort itself and is done in a week.
  // Every word in its name and type also appears in a blended culture's, so
  // this is the case that used to come back as "46 days" for a beer that is in
  // the fermenter for one.
  for (const name of ['WildBrew Philly Sour', 'Philly Sour', 'Lachancea thermotolerans']) {
    const souring = estimateFermentationDays({
      og: 1.045,
      temperatureC: 22,
      yeast: [pitch({ name, type: 'Sour' })],
    });
    assert.equal(souring!.family, 'sour', `${name} is a souring yeast, not a mixed culture`);
    assert.ok(souring!.days <= 10, `${name} should finish in about a week, got ${souring!.days}`);
  }

  // The real shape of a modern sour, and the case this whole model exists for:
  // a souring yeast first, then a kveik on day four with the fermenter turned
  // up to finish it. It must come out *faster* than the souring yeast left to
  // plod on alone, not slower — a finishing pitch finishes, it doesn't restart.
  const sourAlone = estimateFermentationDays({
    og: 1.045,
    temperatureC: 22,
    yeast: [pitch({ name: 'WildBrew Philly Sour', type: 'Sour' })],
  });
  const staged = estimateFermentationDays({
    og: 1.045,
    temperatureC: 22,
    yeast: [
      pitch({ name: 'WildBrew Philly Sour', type: 'Sour' }),
      pitch({ name: 'Lallemand Voss Kveik', addAfterDays: '4', heldAtC: '33' }),
    ],
  });
  assert.ok(
    staged!.days < sourAlone!.days,
    'a kveik pitched warm on day four should finish the beer sooner, not later',
  );
  assert.equal(staged!.days, 5, "Charlotte's shape: soured for four days, then finished warm");

  // Turning the fermenter up is what buys those days: the same staged pitch
  // without the ramp has nothing to speed the remaining extract along.
  const noRamp = estimateFermentationDays({
    og: 1.045,
    temperatureC: 22,
    yeast: [
      pitch({ name: 'WildBrew Philly Sour', type: 'Sour' }),
      pitch({ name: 'Lallemand Voss Kveik', addAfterDays: '4' }),
    ],
  });
  assert.ok(noRamp!.days > staged!.days, 'the temperature ramp has to move the answer');

  // And a late pitch is never charged with a whole fermentation: by day four
  // the souring yeast has eaten most of the extract, so the kveik cannot add
  // its full five-day run on top. That mistake is what read as nine days.
  assert.ok(noRamp!.days <= sourAlone!.days, 'a finishing pitch adds no time of its own here');

  // With nothing pitched before it, though, a delayed strain does wait: there is
  // no earlier yeast to have eaten anything, so day four is simply four days
  // later. Checked kveik-against-kveik, so the comparison is like for like.
  const kveikNow = estimateFermentationDays({
    og: 1.045,
    temperatureC: 22,
    yeast: [pitch({ name: 'Lallemand Voss Kveik' })],
  });
  const kveikLater = estimateFermentationDays({
    og: 1.045,
    temperatureC: 22,
    yeast: [pitch({ name: 'Lallemand Voss Kveik', addAfterDays: '4' })],
  });
  assert.equal(kveikLater!.days - kveikNow!.days, 4);

  // A pitch at the start is unchanged by the feature existing.
  assert.equal(
    estimateFermentationDays({ og: 1.05, temperatureC: '20', yeast: [pitch({ addAfterDays: '' })] })!.days,
    ale.days,
  );

  // A true blended culture is still the slow one, and still wins a co-pitch.
  const blend = estimateFermentationDays({
    og: 1.045,
    temperatureC: 22,
    yeast: [pitch({ name: 'WildBrew Philly Sour', type: 'Sour' }), pitch({ name: 'Lactobacillus Brevis', type: 'Lacto' })],
  });
  assert.equal(blend!.family, 'mixed');
  assert.ok(blend!.days > 30);
});

test('a fermentation estimate needs a yeast, and falls back to the strain’s own range', () => {
  assert.equal(estimateFermentationDays({ og: 1.05, temperatureC: 20, yeast: [] }), null);
  assert.equal(
    estimateFermentationDays({ og: 1.05, temperatureC: 20, yeast: [pitch({ name: '  ' })] }),
    null,
  );

  // No fermentation temperature on the sheet: the producer's range stands in,
  // and the readout is told so it can say as much.
  const assumed = estimateFermentationDays({
    og: 1.05,
    temperatureC: null,
    yeast: [pitch({ minTempC: 12, maxTempC: 18 })],
  });
  assert.equal(assumed!.temperatureC, 15);
  assert.equal(assumed!.temperatureAssumed, true);

  // No gravity yet either: a 1.050 wort is assumed rather than the estimate
  // disappearing while the grain bill is still being typed.
  const noGravity = estimateFermentationDays({ og: null, temperatureC: 20, yeast: [pitch({})] });
  assert.equal(noGravity!.days, 5);
  assert.match(noGravity!.note, /assumed 1\.050/);
});
