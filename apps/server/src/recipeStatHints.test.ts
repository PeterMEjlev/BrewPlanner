import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aromaHopRate,
  calculateRecipe,
  DEFAULT_RECIPE_SETTINGS,
  missingStatInput,
} from '@checklist/shared';
import type { RecipeEditInput, RecipeStatKey } from '@checklist/shared';

/**
 * The statistics panel explains every blank figure with the thing it is still
 * waiting for. Two properties matter and neither is about the wording: a hint
 * must appear exactly when the figure is blank, and it must name something the
 * sheet is genuinely short of — a tile asking for a yeast that has already been
 * pitched is worse than the generic line it replaced.
 */

const STATS: RecipeStatKey[] = [
  'preBoilGravity', 'postBoilGravity', 'originalGravity', 'finalGravity',
  'abv', 'ibu', 'ebc', 'mashPh', 'aromaRate',
];

function recipe(overrides: Partial<RecipeEditInput> = {}): RecipeEditInput {
  return {
    name: 'Test',
    style: '',
    settings: { ...DEFAULT_RECIPE_SETTINGS, boilSizePreL: 64, boilSizePostL: 57 },
    batchSizeL: 55,
    mashTemp: null,
    fermentationTemp: null,
    fermentables: [],
    hops: [],
    yeast: [],
    otherIngredients: [],
    mashGuidelines: null,
    waterProfile: null,
    ...overrides,
  } as RecipeEditInput;
}

function malt(over: Record<string, unknown> = {}): RecipeEditInput['fermentables'][number] {
  return {
    name: 'Weyermann Pilsner', amount: '5', unit: 'kg', percent: '', ebc: 3,
    ppg: 37, fermentable: null, lateAddition: false, grams: null, price: null,
    ...over,
  } as RecipeEditInput['fermentables'][number];
}

function hop(over: Record<string, unknown> = {}): RecipeEditInput['hops'][number] {
  return {
    name: 'Citra', amount: '40', unit: 'g', use: 'Boil', stage: 'Boil', time: '60',
    timeUnit: 'min', aa: '12', ibu: '', form: 'Pellet', utilization: '', temp: '',
    grams: null, price: null,
    ...over,
  } as RecipeEditInput['hops'][number];
}

function yeast(over: Record<string, unknown> = {}): RecipeEditInput['yeast'][number] {
  return {
    name: 'SafAle US-05', lab: '', attenuation: '81', amount: '1', amountUnit: 'each',
    type: 'Ale', form: 'Dry', flocculation: '', minTempC: null, maxTempC: null,
    alcoholTolerance: '', starter: false, grams: null, units: 1, price: null,
    ...over,
  } as RecipeEditInput['yeast'][number];
}

/** The figure a stat key stands for, so a hint can be checked against it. */
function valueOf(input: RecipeEditInput, stat: RecipeStatKey): number | null {
  if (stat === 'aromaRate') return aromaHopRate(input.hops, input.batchSizeL);
  return calculateRecipe(input)[stat];
}

const SHEETS: Array<{ what: string; input: RecipeEditInput }> = [
  { what: 'a blank sheet', input: recipe() },
  { what: 'an empty row of each kind', input: recipe({
    fermentables: [malt({ name: '', amount: '', ebc: null, ppg: null })],
    hops: [hop({ name: '', amount: '', aa: '', time: '' })],
    yeast: [yeast({ name: '', attenuation: '' })],
  }) },
  { what: 'malt named but not weighed', input: recipe({ fermentables: [malt({ amount: '' })] }) },
  { what: 'malt weighed, nothing else', input: recipe({ fermentables: [malt()] }) },
  { what: 'malt with no colour', input: recipe({ fermentables: [malt({ ebc: null })] }) },
  { what: 'malt + yeast without attenuation', input: recipe({
    fermentables: [malt()], yeast: [yeast({ attenuation: '' })],
  }) },
  { what: 'malt + yeast', input: recipe({ fermentables: [malt()], yeast: [yeast()] }) },
  { what: 'hop with no weight', input: recipe({ fermentables: [malt()], hops: [hop({ amount: '' })] }) },
  { what: 'hop with no alpha', input: recipe({ fermentables: [malt()], hops: [hop({ aa: '' })] }) },
  { what: 'boil hop with no time', input: recipe({ fermentables: [malt()], hops: [hop({ time: '' })] }) },
  { what: 'a dry hop only', input: recipe({
    fermentables: [malt()], hops: [hop({ stage: 'Dry Hop', time: '3', timeUnit: 'day' })],
  }) },
  // A weight on one row and an alpha on the next bitter nothing: the check has
  // to be per addition, not "both appear somewhere in the schedule".
  { what: 'hop figures split across two rows', input: recipe({
    fermentables: [malt()],
    hops: [hop({ aa: '' }), hop({ amount: '' })],
  }) },
  { what: 'one complete hop beside an empty row', input: recipe({
    fermentables: [malt()], hops: [hop(), hop({ name: '', amount: '', aa: '', time: '' })],
  }) },
  { what: 'no batch size', input: recipe({
    batchSizeL: null, settings: { ...DEFAULT_RECIPE_SETTINGS }, fermentables: [malt()],
  }) },
  { what: 'a bill of only late additions', input: recipe({
    fermentables: [malt({ lateAddition: true })],
  }) },
  { what: 'a full sheet', input: recipe({
    fermentables: [malt()], hops: [hop(), hop({ stage: 'Whirlpool', time: '20' })], yeast: [yeast()],
  }) },
];

test('a hint appears exactly when the figure it explains is blank', () => {
  for (const { what, input } of SHEETS) {
    for (const stat of STATS) {
      const blank = valueOf(input, stat) == null;
      const hint = missingStatInput(input, stat);
      assert.equal(
        hint != null,
        blank,
        `${stat} on ${what}: figure ${blank ? 'is' : 'is not'} blank but hint was ${JSON.stringify(hint)}`,
      );
    }
  }
});

test('a hint never asks for something the sheet already has', () => {
  const has = {
    'Needs a malt': (r: RecipeEditInput) => r.fermentables.some((l) => l.name.trim() !== ''),
    'Needs a malt weight': (r: RecipeEditInput) =>
      r.fermentables.some((l) => l.name.trim() !== '' && Number(l.amount) > 0),
    'Needs a malt colour': (r: RecipeEditInput) => r.fermentables.some((l) => l.ebc != null),
    'Needs a yeast': (r: RecipeEditInput) => r.yeast.some((l) => l.name.trim() !== ''),
    'Needs yeast attenuation': (r: RecipeEditInput) => r.yeast.some((l) => Number(l.attenuation) > 0),
    // "Needs a hop" is about a hop having been named — the editor starts every
    // sheet with an empty row, so a row existing is not a hop being chosen.
    'Needs a hop': (r: RecipeEditInput) => r.hops.some((l) => l.name.trim() !== ''),
    'Needs a hop weight': (r: RecipeEditInput) => r.hops.some((l) => Number(l.amount) > 0),
    'Needs hop alpha acid': (r: RecipeEditInput) => r.hops.some((l) => Number(l.aa) > 0),
    'Needs a batch size': (r: RecipeEditInput) => (r.batchSizeL ?? 0) > 0,
  } as const;

  for (const { what, input } of SHEETS) {
    for (const stat of STATS) {
      const hint = missingStatInput(input, stat);
      const already = hint == null ? undefined : has[hint as keyof typeof has];
      if (already) {
        assert.equal(already(input), false, `${stat} on ${what}: asked for "${hint}", which is present`);
      }
    }
  }
});

test('an untouched hop row asks for a hop, not for its weight', () => {
  // The editor opens every new sheet with one blank row of each kind, so this
  // is what the panel actually shows a brewer starting a recipe.
  const blank = recipe({ hops: [hop({ name: '', amount: '', aa: '', time: '' })] });
  assert.equal(missingStatInput(blank, 'ibu'), 'Needs a hop');
  // Named but not yet weighed is a different, later question.
  assert.equal(missingStatInput(recipe({ hops: [hop({ amount: '' })] }), 'ibu'), 'Needs a hop weight');
});

test('the kettle gravities name late additions as the reason they are blank', () => {
  const lateOnly = recipe({ fermentables: [malt({ lateAddition: true })] });
  assert.equal(missingStatInput(lateOnly, 'preBoilGravity'), 'All malt is a late addition');
  assert.equal(missingStatInput(lateOnly, 'postBoilGravity'), 'All malt is a late addition');
  // OG counts it either way, so it is not blank and has nothing to explain.
  assert.equal(missingStatInput(lateOnly, 'originalGravity'), null);
});

test('no two blank figures on a fresh sheet give the same generic answer', () => {
  const blank = recipe();
  const hints = STATS.map((stat) => missingStatInput(blank, stat));
  assert.ok(hints.every((hint) => hint != null), 'every figure on a blank sheet is blank');
  assert.ok(!hints.includes('Needs more inputs'));
  // Grain, hops and aroma are three different asks, not one repeated.
  assert.ok(new Set(hints).size >= 3, `expected varied hints, got ${JSON.stringify(hints)}`);
});
