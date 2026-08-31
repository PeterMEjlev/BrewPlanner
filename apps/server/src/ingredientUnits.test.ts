import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_RECIPE_SETTINGS } from '@checklist/shared';
import type { RecipeEditInput } from '@checklist/shared';
import { countUnits, weightToGrams } from './ingredientUnits.js';

test('weight and count conversion covers every supported unit and blank-unit policy', () => {
  assert.equal(weightToGrams('2', 'kg', 'reject'), 2_000);
  assert.equal(weightToGrams('25', 'g', 'reject'), 25);
  assert.equal(weightToGrams('1', 'lb', 'reject'), 453.592);
  assert.equal(weightToGrams('2', 'lbs', 'reject'), 907.184);
  assert.equal(weightToGrams('1', 'oz', 'reject'), 28.3495);
  assert.equal(weightToGrams('500', 'mg', 'reject'), 0.5);
  assert.equal(weightToGrams('12', '', 'assume-grams'), 12);
  assert.equal(weightToGrams('12', '', 'reject'), null);
  assert.equal(weightToGrams('1', 'pkg', 'assume-grams'), null);
  assert.equal(weightToGrams('0', 'kg', 'assume-grams'), null);
  assert.equal(weightToGrams('not-a-number', 'kg', 'assume-grams'), null);

  for (const unit of ['pkg', 'pkgs', 'each', 'items', 'vial']) {
    assert.equal(countUnits('2', unit), 2);
  }
  assert.equal(countUnits('2', 'g'), null);
  assert.equal(countUnits('-1', 'pkg'), null);
});

test('stored and Brewer’s Friend recipes retain their caller-specific unit semantics', async () => {
  const databasePath = join(tmpdir(), `brewplanner-ingredient-units-${randomUUID()}.sqlite`);
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousApiKey = process.env.BREWERS_FRIEND_API_KEY;
  const realFetch = globalThis.fetch;
  process.env.DATABASE_PATH = databasePath;
  process.env.BREWERS_FRIEND_API_KEY = 'ingredient-unit-test-key';

  const database = await import('./db/index.js');
  database.runMigrations();

  try {
    const { hydrateRecipe } = await import('./recipeData.js');
    const stored: RecipeEditInput = {
      name: 'Stored unit matrix',
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
      mashTemp: null,
      fermentationTemp: null,
      fermentables: [
        { name: 'Kilograms', amount: '1', unit: 'kg', percent: '', ebc: null, ppg: null, fermentable: null, lateAddition: false },
        { name: 'Grams', amount: '25', unit: 'g', percent: '', ebc: null, ppg: null, fermentable: null, lateAddition: false },
        { name: 'Pounds', amount: '1', unit: 'lb', percent: '', ebc: null, ppg: null, fermentable: null, lateAddition: false },
        { name: 'Ounces', amount: '1', unit: 'oz', percent: '', ebc: null, ppg: null, fermentable: null, lateAddition: false },
        { name: 'Implicit grams', amount: '5', unit: '', percent: '', ebc: null, ppg: null, fermentable: null, lateAddition: false },
      ],
      hops: [],
      yeast: [{
        name: 'Counted yeast', lab: '', attenuation: '', amount: '2', amountUnit: 'pkg',
        type: '', form: '', flocculation: '', minTempC: null, maxTempC: null,
        alcoholTolerance: '', starter: false,
      }],
      otherIngredients: [
        { name: 'Liquid ml', amount: '250', unit: 'ml', use: '', time: '', timeUnit: '', type: '' },
        { name: 'Liquid L', amount: '1', unit: 'L', use: '', time: '', timeUnit: '', type: '' },
      ],
      notes: null,
      mashGuidelines: null,
      waterProfile: null,
    };
    const hydrated = hydrateRecipe({
      id: 'stored-units',
      origin: 'local',
      url: '',
      familyId: 'stored-units',
      version: 1,
      versionNote: '',
      versions: [],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    }, stored);

    assert.deepEqual(hydrated.fermentables.map((line) => line.grams), [
      1_000, 25, 453.592, 28.3495, 5,
    ]);
    assert.equal(hydrated.yeast[0]?.grams, null);
    assert.equal(hydrated.yeast[0]?.units, 2);
    assert.deepEqual(hydrated.otherIngredients.map((line) => line.grams), [250, 1_000]);

    globalThis.fetch = (async () => new Response(JSON.stringify({
      recipes: [{
        id: 'imported-units',
        title: 'Imported unit matrix',
        batchsize: 20,
        batchsizeunit: 'l',
        fermentables: [
          { name: 'Kilograms', amount: 1, unit: ' kg ' },
          { name: 'Grams', amount: 25, unit: 'g' },
          { name: 'Pounds', amount: 1, unit: 'lb' },
          { name: 'Ounces', amount: 1, unit: 'oz' },
          { name: 'Implicit grams', amount: 5, unit: '' },
        ],
        hops: [],
        yeasts: [{ name: 'Counted yeast', amount: 2, unit: 'vial' }],
        others: [
          { name: 'Liquid ml', amount: 250, unit: 'ml' },
          { name: 'Liquid L', amount: 1, unit: 'l' },
        ],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const { getRecipe } = await import('./brewersfriend.js');
    const imported = await getRecipe('imported-units');
    assert.deepEqual(imported.fermentables.map((line) => line.grams), [
      1_000, 25, 453.592, 28.3495, 5,
    ]);
    assert.equal(imported.yeast[0]?.grams, null);
    assert.equal(imported.yeast[0]?.units, 2);
    assert.deepEqual(imported.otherIngredients.map((line) => line.grams), [250, 1_000]);
  } finally {
    globalThis.fetch = realFetch;
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousApiKey === undefined) delete process.env.BREWERS_FRIEND_API_KEY;
    else process.env.BREWERS_FRIEND_API_KEY = previousApiKey;
    database.sqlite.close();
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
  }
});
