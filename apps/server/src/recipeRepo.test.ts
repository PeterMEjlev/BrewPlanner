import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyRecipeCalculations,
  calculateRecipe,
  DEFAULT_RECIPE_SETTINGS,
  recipeEditSchema,
} from '@checklist/shared';
import type { RecipeEditInput } from '@checklist/shared';

function recipe(name: string): RecipeEditInput {
  return {
    name,
    style: 'American IPA',
    settings: { ...DEFAULT_RECIPE_SETTINGS },
    og: '1.060',
    preBoilGravity: '1.048',
    postBoilGravity: '1.060',
    fg: '1.012',
    abv: '6.3',
    ibu: '55',
    ebc: '12',
    ebcEstimated: false,
    batchSizeL: 20,
    mashTemp: '67°C',
    fermentationTemp: '19°C',
    fermentables: [{ name: 'Pale Ale Malt', amount: '4', unit: 'kg', percent: '100', ebc: 6, ppg: 37, fermentable: null, lateAddition: false }],
    hops: [
      {
        name: 'Citra',
        amount: '50',
        unit: 'g',
        use: 'Dry Hop',
        stage: 'Dry Hop',
        time: '4',
        timeUnit: 'day',
        aa: '12',
        ibu: '',
        form: 'Pellet',
        utilization: '',
        temp: '',
      },
    ],
    yeast: [],
    otherIngredients: [],
    notes: 'Charlotte likes it dry.\n\nNext time: dry hop a day earlier.',
    mashGuidelines: null,
    waterProfile: null,
  };
}

test('older stored recipe JSON receives the new editor defaults', () => {
  const current = recipe('Legacy shape');
  // `notes` too: every recipe written before the field existed is re-parsed
  // through this schema on every read, so a missing key has to read as
  // "unwritten" rather than failing the whole library to load.
  const { settings: _settings, notes: _notes, ...legacy } = current;
  const parsed = recipeEditSchema.parse({
    ...legacy,
    settings: {
      abvFormula: 'alternate',
      ibuFormula: 'rager',
      colorFormula: 'daniels',
      diastaticPowerFormula: 'windisch-kolbach',
    },
    // Written before the row carried an extract potential or either of the
    // Brewer's Friend checkboxes, and with a key the editor never had.
    fermentables: legacy.fermentables.map((
      { ppg: _ppg, fermentable: _fermentable, lateAddition: _late, ...line },
    ) => ({
      ...line,
      steepable: true,
    })),
    hops: legacy.hops.map(({ form: _form, utilization: _util, ...line }) => line),
    mashGuidelines: {
      steps: [{ name: 'Infusion', temp: '67°C', time: '60', amount: '15 L' }],
      notes: null,
    },
    waterProfile: {
      name: 'Balanced',
      ph: '5.3',
      notes: null,
      calcium: '80',
      magnesium: '5',
      sodium: '25',
      chloride: '75',
      sulfate: '80',
      bicarbonate: '0',
    },
  });

  assert.deepEqual(parsed.settings, DEFAULT_RECIPE_SETTINGS);
  assert.equal('steepable' in (parsed.fermentables[0] ?? {}), false);
  assert.equal(parsed.fermentables[0]?.ppg, null);
  // Null defers to what the fermentable is; nothing imported is late by default.
  assert.equal(parsed.fermentables[0]?.fermentable, null);
  assert.equal(parsed.fermentables[0]?.lateAddition, false);
  assert.equal(parsed.hops[0]?.form, 'Pellet');
  assert.equal(parsed.mashGuidelines?.steps[0]?.amountUnit, '');
  assert.equal(parsed.waterProfile?.sourceName, null);
  assert.equal(parsed.notes, null, 'a sheet stored without general notes still loads');
  assert.equal('notes' in parsed, true);
});

test('recipe statistics are calculated from the brewing inputs', () => {
  const input = recipe('Calculated batch');
  input.batchSizeL = 20;
  input.settings = {
    ...input.settings,
    efficiencyPercent: 80,
    boilSizePreL: 25,
    boilSizePostL: 21,
  };
  input.fermentables = [
    { name: 'Pale Ale Malt', amount: '5', unit: 'kg', percent: '', ebc: 6, ppg: 37, fermentable: null, lateAddition: false },
  ];
  input.hops = [{
    name: 'Citra',
    amount: '50',
    unit: 'g',
    use: 'Boil',
    stage: 'Boil',
    time: '60',
    timeUnit: 'min',
    aa: '10',
    ibu: '',
    form: 'Pellet',
    utilization: '',
    temp: '',
  }];
  input.yeast = [{
    name: 'US-05',
    lab: 'Fermentis',
    attenuation: '80',
    amount: '1',
    amountUnit: 'pkg',
    type: 'Ale',
    form: 'Dry',
    flocculation: 'Medium',
    minTempC: 18,
    maxTempC: 22,
    alcoholTolerance: '9%',
    starter: false,
  }];

  const result = calculateRecipe(input);
  assert.ok(result.originalGravity != null && Math.abs(result.originalGravity - 1.0618) < 0.0002);
  assert.ok(result.preBoilGravity != null && Math.abs(result.preBoilGravity - 1.0494) < 0.0002);
  assert.ok(result.postBoilGravity != null && Math.abs(result.postBoilGravity - 1.0588) < 0.0002);
  assert.ok(result.finalGravity != null && Math.abs(result.finalGravity - 1.0124) < 0.0002);
  assert.ok(result.abv != null && result.abv > 6.4 && result.abv < 6.6);
  assert.ok(result.ibu != null && result.ibu > 55 && result.ibu < 65);
  assert.ok(result.ebc != null && result.ebc > 9 && result.ebc < 11);
  assert.ok(result.mashPh != null && result.mashPh > 5.5 && result.mashPh < 5.7);

  const stored = applyRecipeCalculations(input);
  assert.equal(stored.og, '1.062');
  assert.equal(stored.fermentables[0]?.percent, '100.0');
  assert.notEqual(stored.hops[0]?.ibu, '');
  assert.equal(stored.waterProfile?.ph, result.mashPh?.toFixed(2));

  const whirlpool = calculateRecipe({
    ...input,
    hops: [{
      ...input.hops[0]!,
      use: 'Whirlpool',
      stage: 'Whirlpool',
      time: '20',
      utilization: '',
    }],
  });
  // 50 g at 10% alpha, the flat 5% whirlpool utilization, into the 20 L batch:
  // 50 × 0.10 × 0.05 × 1000 / 20. The divisor is the batch rather than the 21 L
  // post-boil volume — bitterness is a concentration in the finished beer.
  assert.ok(whirlpool.hopIbus[0] != null && Math.abs(whirlpool.hopIbus[0] - 12.5) < 0.001);
});

test('recipe library supports local CRUD and non-destructive legacy imports', async () => {
  const databasePath = join(tmpdir(), `brewplanner-recipes-${randomUUID()}.sqlite`);
  process.env.DATABASE_PATH = databasePath;

  const database = await import('./db/index.js');
  database.runMigrations();
  const repo = await import('./recipeRepo.js');
  const data = await import('./recipeData.js');
  const prices = await import('./prices.js');
  const settings = await import('./repo.js');

  try {
    const created = repo.createRecipe(recipe('Built here'));
    assert.equal(created.origin, 'local');
    assert.equal(created.url, '');
    assert.equal(created.og, '1.049');
    assert.equal(created.fermentables[0]?.grams, 4_000);
    assert.deepEqual(repo.listIngredientNames('hop', 'cit'), ['Citra']);
    assert.equal(repo.listRecipeIngredientOptions('fermentable', 'pale')[0]?.ebc, 6);
    assert.equal(repo.listRecipeIngredientOptions('hop', 'cit')[0]?.aa, 12);
    assert.ok(prices.searchCatalogue('fermentable', 'Pale Ale', { grams: 1_000, units: null })[0]?.ebcMin != null);
    assert.equal(prices.searchCatalogue('hop', 'Motueka', { grams: 100, units: null })[0]?.aa, 8.48);
    assert.match(created.id, /^[0-9a-f-]{36}$/);

    const updated = repo.updateRecipe(created.id, recipe('Edited here'));
    assert.equal(updated?.name, 'Edited here');
    // General notes survive the save/read round trip, blank lines and all —
    // they are prose, not a figure, so nothing may collapse the paragraphs.
    assert.equal(updated?.notes, 'Charlotte likes it dry.\n\nNext time: dry hop a day earlier.');
    assert.equal(repo.getRecipe(created.id)?.notes, updated?.notes);
    // And are cleared, not left behind, when the brewer empties the box.
    assert.equal(repo.updateRecipe(created.id, { ...recipe('Edited here'), notes: null })?.notes, null);
    assert.equal(repo.listRecipeStats()[0]?.hopGrams, 50);

    // A pre-migration local override must win when its BF recipe is imported.
    settings.setSetting(
      'recipe_edits',
      JSON.stringify({
        '42': { recipe: recipe('Legacy local edit'), savedAt: new Date().toISOString(), url: '' },
      }),
    );
    const importedSheet = data.hydrateRecipe(
      {
        id: '42',
        origin: 'brewersfriend',
        url: 'https://www.brewersfriend.com/homebrew/recipe/view/42',
        familyId: '42',
        version: 1,
        versionNote: '',
        versions: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
      },
      recipe('Upstream name'),
    );
    assert.equal(repo.importBrewersFriendRecipe(importedSheet), true);
    assert.equal(repo.getRecipe('42')?.name, 'Legacy local edit');
    assert.equal(repo.getRecipe('42')?.url, importedSheet.url);

    // Re-importing never overwrites app state.
    assert.equal(repo.updateRecipe('42', recipe('Kept app edit'))?.name, 'Kept app edit');
    assert.equal(repo.importBrewersFriendRecipe(importedSheet), false);
    assert.equal(repo.getRecipe('42')?.name, 'Kept app edit');

    // --- Versions of a beer ------------------------------------------------
    // A version is a whole sheet of its own in the same family, so the recipe a
    // batch was brewed from stays exactly as it was brewed.
    const v1 = repo.createRecipe(recipe('House IPA'));
    assert.equal(v1.version, 1);
    assert.equal(v1.familyId, v1.id, 'a new beer is the first version of its own family');
    assert.deepEqual(v1.versions.map((v) => v.version), [1]);

    const v2 = repo.createRecipeVersion(v1.id, recipe('House IPA'), 'more Citra late');
    assert.equal(v2?.version, 2);
    assert.equal(v2?.familyId, v1.familyId, 'a version stays with the beer it revises');
    assert.notEqual(v2?.id, v1.id, 'a version is its own row, so a brewed batch keeps pointing at what it was brewed from');
    assert.equal(v2?.versionNote, 'more Citra late');
    assert.equal(repo.createRecipeVersion('nope', recipe('Nowhere')), null);

    // v1 is untouched, and now knows about its sibling.
    const reread = repo.getRecipe(v1.id);
    assert.equal(reread?.version, 1);
    assert.equal(reread?.name, 'House IPA');
    assert.deepEqual(reread?.versions.map((v) => v.version), [2, 1], 'the picker lists newest first');

    // The library shows the beer once, as its newest version.
    const family = repo.listRecipes().filter((r) => r.familyId === v1.familyId);
    assert.deepEqual(family.map((r) => r.id), [v2!.id]);
    assert.equal(family[0]?.versionCount, 2);

    // Numbering runs off the versions still in the family, so a gap in the
    // middle is never filled in: with v1 and v3 present, the next one is v4.
    const v3 = repo.createRecipeVersion(v1.id, recipe('House IPA'), 'dropped the wheat');
    assert.equal(v3?.version, 3);
    assert.equal(repo.deleteRecipe(v2!.id), true);
    const v4 = repo.createRecipeVersion(v1.id, recipe('House IPA'), 'back to the wheat');
    assert.equal(v4?.version, 4, 'a deleted v2 must not be refilled under the newest version');
    assert.equal(repo.deleteRecipe(v4!.id), true);

    // Saving an edit leaves the note alone unless a new one is passed — a client
    // that knows nothing about versions can't blank it.
    repo.updateRecipe(v3!.id, recipe('House IPA'));
    assert.equal(repo.getRecipe(v3!.id)?.versionNote, 'dropped the wheat');
    repo.updateRecipe(v3!.id, recipe('House IPA'), 'and the oats');
    assert.equal(repo.getRecipe(v3!.id)?.versionNote, 'and the oats');

    assert.equal(repo.recipeFamilyId(v3!.id), v1.familyId);
    assert.equal(repo.recipeFamilyId('nope'), null);

    // A copy is a beer of its own: the same sheet, but its own family, and so
    // its own version chain and brew history from the moment it is saved.
    const copy = repo.createRecipe(recipe('House IPA (copy)'));
    assert.equal(copy.familyId, copy.id);
    assert.notEqual(copy.familyId, v1.familyId);
    assert.equal(copy.version, 1);

    assert.equal(repo.deleteRecipe(created.id), true);
    assert.equal(repo.getRecipe(created.id), null);
  } finally {
    database.sqlite.close();
    for (const path of [databasePath, `${databasePath}-shm`, `${databasePath}-wal`]) {
      rmSync(path, { force: true });
    }
  }
});
