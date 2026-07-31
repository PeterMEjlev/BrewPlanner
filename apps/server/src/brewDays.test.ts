import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_RECIPE_SETTINGS, measuredEfficiency } from '@checklist/shared';
import type { RecipeEditInput } from '@checklist/shared';

/**
 * The brewery's logbook. What's worth pinning down here is everything the log
 * promises to still be right about later: the recipe as it read on the day, the
 * count of which brew this was, and the two temperature stories — the rig's,
 * which is kept with the entry, and the fermenter's, which is read back out of
 * the telemetry over the batch's own window.
 */

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
    fermentables: [
      { name: 'Pale Ale Malt', amount: '5', unit: 'kg', percent: '100', ebc: 6, ppg: 37, fermentable: null, lateAddition: false },
    ],
    hops: [
      {
        name: 'Citra',
        amount: '60',
        unit: 'g',
        use: 'Boil',
        stage: 'Boil',
        time: '60',
        timeUnit: 'min',
        aa: '12',
        ibu: '',
        form: 'Pellet',
        utilization: '',
        temp: '',
      },
    ],
    yeast: [
      {
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
      },
    ],
    otherIngredients: [],
    mashGuidelines: null,
    waterProfile: null,
  };
}

/**
 * One temporary database for the whole file. The db module reads DATABASE_PATH
 * when it is first imported and dynamic imports are cached, so a per-test
 * database isn't available to us — every test therefore works against its own
 * recipe and filters the log to it rather than assuming an empty table.
 */
let booted: Promise<{
  brewDays: typeof import('./brewDays/repo.js');
  recipes: typeof import('./recipeRepo.js');
  devices: typeof import('./devices/repo.js');
}> | null = null;

function boot() {
  if (!booted) {
    booted = (async () => {
      process.env.DATABASE_PATH = join(tmpdir(), `brewplanner-brew-days-${randomUUID()}.sqlite`);
      const database = await import('./db/index.js');
      database.runMigrations();
      return {
        brewDays: await import('./brewDays/repo.js'),
        recipes: await import('./recipeRepo.js'),
        devices: await import('./devices/repo.js'),
      };
    })();
  }
  return booted;
}

test('a brew day keeps the recipe as it read on the day', async () => {
  const { brewDays, recipes } = await boot();

  const saved = recipes.createRecipe(recipe('Citra Pale'));
  const brewDay = brewDays.startBrewDay(saved.id, recipes.getRecipe(saved.id)!);

  assert.equal(brewDay.status, 'brewing');
  assert.equal(brewDay.brewNumber, 1);
  assert.equal(brewDay.recipe.name, 'Citra Pale');
  assert.equal(brewDay.recipe.grainKg, 5);
  assert.equal(brewDay.recipe.hopGrams, 60);
  assert.equal(brewDay.recipe.yeast, 'US-05');
  assert.equal(brewDay.recipe.batchSizeL, 20);
  // Nothing is measured until the brewer measures it — the recipe's targets
  // must never leak into the entry's own figures.
  assert.equal(brewDay.measured.og, '');
  assert.equal(brewDay.measured.volumeL, null);
  assert.equal(brewDay.durationMinutes, null);

  // Renaming and reworking the recipe afterwards must not rewrite history.
  const edited = recipe('Citra Pale v2');
  edited.fermentables[0]!.amount = '9';
  recipes.updateRecipe(saved.id, edited);

  const reread = brewDays.getBrewDay(brewDay.id)!;
  assert.equal(reread.recipe.name, 'Citra Pale');
  assert.equal(reread.recipe.grainKg, 5);

  // Nor must deleting it: the entry loses its link, not its contents.
  recipes.deleteRecipe(saved.id);
  const orphaned = brewDays.getBrewDay(brewDay.id)!;
  assert.equal(orphaned.recipeId, null);
  assert.equal(orphaned.recipe.name, 'Citra Pale');
});

test('the snapshot carries what efficiency is measured against', async () => {
  const { brewDays, recipes } = await boot();

  const sheet = recipe('Efficiency Pale');
  // A kettle sugar and a honey stirred in afterwards: the first is in the wort
  // at the pre-boil reading, the second is not.
  sheet.fermentables.push(
    { name: 'Table Sugar', amount: '500', unit: 'g', percent: '', ebc: 0, ppg: null, fermentable: null, lateAddition: false },
    { name: 'Honey', amount: '1', unit: 'kg', percent: '', ebc: 2, ppg: null, fermentable: null, lateAddition: true },
  );
  const saved = recipes.createRecipe(sheet);
  const brewDay = brewDays.startBrewDay(saved.id, recipes.getRecipe(saved.id)!);
  const snapshot = brewDay.recipe;

  // 4.5 kg of 37 PPG malt ≈ 367 point-gallons at perfect extraction.
  assert.ok(snapshot.mashedPointGallons != null && snapshot.mashedPointGallons > 300);
  assert.ok(snapshot.unmashedPointGallons! > snapshot.preBoilUnmashedPointGallons!);
  assert.ok(snapshot.preBoilUnmashedPointGallons! > 0);

  // The figure the detail page shows is derived from the entry alone — no
  // second look at the recipe, which is the point of snapshotting it.
  const measured = brewDays.updateBrewDay(brewDay.id, {
    measured: { og: '1.055', volumeL: 20 },
  })!;
  const calculated = measuredEfficiency({
    gravity: measured.measured.og,
    litres: measured.measured.volumeL,
    mashedPointGallons: snapshot.mashedPointGallons,
    unmashedPointGallons: snapshot.unmashedPointGallons,
  });
  assert.ok(calculated != null && calculated > 0 && calculated < 100);

  // Nothing is stored for it: the field stays null until someone overrules the
  // calculation, and clearing that override hands the figure back.
  assert.equal(measured.measured.efficiencyPct, null);
  brewDays.updateBrewDay(brewDay.id, { measured: { efficiencyPct: 68 } });
  assert.equal(brewDays.getBrewDay(brewDay.id)?.measured.efficiencyPct, 68);
  brewDays.updateBrewDay(brewDay.id, { measured: { efficiencyPct: null } });
  assert.equal(brewDays.getBrewDay(brewDay.id)?.measured.efficiencyPct, null);
});

test('brews of one recipe are numbered by date, and back-dating renumbers them', async () => {
  const { brewDays, recipes } = await boot();
  const saved = recipes.createRecipe(recipe('House Bitter'));
  const detail = recipes.getRecipe(saved.id)!;

  const march = brewDays.startBrewDay(saved.id, detail, '2026-03-01T09:00:00.000Z');
  const june = brewDays.startBrewDay(saved.id, detail, '2026-06-01T09:00:00.000Z');
  assert.equal(brewDays.getBrewDay(march.id)?.brewNumber, 1);
  assert.equal(brewDays.getBrewDay(june.id)?.brewNumber, 2);

  // A batch remembered later slots into the sequence rather than onto the end.
  const january = brewDays.startBrewDay(saved.id, detail, '2026-01-15T09:00:00.000Z');
  assert.equal(brewDays.getBrewDay(january.id)?.brewNumber, 1);
  assert.equal(brewDays.getBrewDay(march.id)?.brewNumber, 2);
  assert.equal(brewDays.getBrewDay(june.id)?.brewNumber, 3);

  // The log itself reads newest first.
  assert.deepEqual(
    brewDays
      .listBrewDays()
      .filter((day) => day.recipeId === saved.id)
      .map((day) => day.id),
    [june.id, march.id, january.id],
  );

  const count = brewDays.recipeBrewCounts().find((row) => row.recipeId === saved.id);
  assert.equal(count?.count, 3);
  assert.equal(count?.lastBrewedAt, '2026-06-01T09:00:00.000Z');
});

test('an edit writes only what it names, and null clears a measurement', async () => {
  const { brewDays, recipes } = await boot();
  const saved = recipes.createRecipe(recipe('Saison'));
  const brewDay = brewDays.startBrewDay(saved.id, recipes.getRecipe(saved.id)!);

  brewDays.updateBrewDay(brewDay.id, {
    durationMinutes: 340,
    measured: { og: '1.058', volumeL: 21 },
    notes: 'Sparged too fast.',
  });
  const measured = brewDays.getBrewDay(brewDay.id)!;
  assert.equal(measured.durationMinutes, 340);
  assert.equal(measured.measured.og, '1.058');
  assert.equal(measured.measured.volumeL, 21);
  assert.equal(measured.notes, 'Sparged too fast.');

  // A later edit that says nothing about the OG must leave the OG alone.
  brewDays.updateBrewDay(brewDay.id, { measured: { fg: '1.006' } });
  const both = brewDays.getBrewDay(brewDay.id)!;
  assert.equal(both.measured.og, '1.058');
  assert.equal(both.measured.fg, '1.006');

  // Null is "we didn't take this reading", and has to be storable as such —
  // otherwise a mistyped figure could only ever be corrected to a zero.
  brewDays.updateBrewDay(brewDay.id, { measured: { volumeL: null } });
  assert.equal(brewDays.getBrewDay(brewDay.id)?.measured.volumeL, null);

  assert.equal(brewDays.deleteBrewDay(brewDay.id), true);
  assert.equal(brewDays.getBrewDay(brewDay.id), null);
});

test('the rig log follows the brew day, and stops when the batch moves on', async () => {
  const { brewDays, recipes } = await boot();
  const saved = recipes.createRecipe(recipe('Dunkel'));
  const brewDay = brewDays.startBrewDay(saved.id, recipes.getRecipe(saved.id)!);

  const inProgress = (): number[] => brewDays.brewDaysInProgress().map((row) => row.id);
  assert.ok(inProgress().includes(brewDay.id));

  brewDays.insertRigSample(brewDay.id, {
    recordedAt: '2026-07-14T09:00:00.000Z',
    bk: 20,
    mlt: 64,
    hlt: 78,
  });
  brewDays.insertRigSample(brewDay.id, {
    recordedAt: '2026-07-14T10:00:00.000Z',
    bk: 100,
    mlt: 68,
    // A sensor that dropped out contributes nothing rather than a zero.
    hlt: null,
  });

  const logged = brewDays.getBrewDay(brewDay.id)!;
  assert.equal(logged.rigSamples.length, 2);
  assert.deepEqual(logged.rigStats.bk, { min: 20, max: 100, avg: 60, count: 2 });
  assert.deepEqual(logged.rigStats.mlt, { min: 64, max: 68, avg: 66, count: 2 });
  assert.deepEqual(logged.rigStats.hlt, { min: 78, max: 78, avg: 78, count: 1 });

  // Once the wort is in the tank there is no more mash or boil to log.
  brewDays.updateBrewDay(brewDay.id, { status: 'fermenting' });
  assert.equal(inProgress().includes(brewDay.id), false);
});

test('fermentation figures are read from the fermenter over the batch window', async () => {
  const { brewDays, recipes, devices } = await boot();
  const saved = recipes.createRecipe(recipe('Kveik Pale'));
  const brewDay = brewDays.startBrewDay(saved.id, recipes.getRecipe(saved.id)!, '2026-05-01T08:00:00.000Z');

  const fermenter = devices.createDevice('Fermenter', 'brew_controller').device;
  // The keg fridge is a controller too, and its 3 °C must not be mistaken for
  // the fermenter running cold.
  const kegs = devices.createDevice('Keg fridge', 'brew_controller').device;

  devices.insertReadings(fermenter.id, [
    // Before pitching — outside the window, so outside the figures.
    { metric: 'temp_c', value: 40, recordedAt: '2026-05-01T09:00:00.000Z' },
    { metric: 'temp_c', value: 18, recordedAt: '2026-05-02T12:00:00.000Z' },
    { metric: 'temp_c', value: 22, recordedAt: '2026-05-05T12:00:00.000Z' },
    { metric: 'gravity_sg', value: 1.058, recordedAt: '2026-05-02T12:00:00.000Z' },
    { metric: 'gravity_sg', value: 1.012, recordedAt: '2026-05-05T12:00:00.000Z' },
    // After packaging — likewise outside.
    { metric: 'temp_c', value: 35, recordedAt: '2026-05-20T12:00:00.000Z' },
  ]);
  devices.insertReadings(kegs.id, [
    { metric: 'temp_c', value: 3, recordedAt: '2026-05-03T12:00:00.000Z' },
  ]);

  brewDays.updateBrewDay(brewDay.id, {
    pitchedAt: '2026-05-01T18:00:00.000Z',
    packagedAt: '2026-05-15T12:00:00.000Z',
    status: 'packaged',
  });

  const { fermentation } = brewDays.getBrewDay(brewDay.id)!;
  assert.deepEqual(fermentation.temp, { min: 18, max: 22, avg: 20, count: 2 });
  assert.equal(fermentation.deviceName, 'Fermenter');
  assert.equal(fermentation.gravity?.start, 1.058);
  assert.equal(fermentation.gravity?.end, 1.012);
  assert.equal(fermentation.days, 13);
});
