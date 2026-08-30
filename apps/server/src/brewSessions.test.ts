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
  brewSessions: typeof import('./brewSessions/repo.js');
  recipes: typeof import('./recipeRepo.js');
  devices: typeof import('./devices/repo.js');
}> | null = null;

function boot() {
  if (!booted) {
    booted = (async () => {
      process.env.DATABASE_PATH = join(tmpdir(), `brewplanner-brew-sessions-${randomUUID()}.sqlite`);
      const database = await import('./db/index.js');
      database.runMigrations();
      return {
        brewSessions: await import('./brewSessions/repo.js'),
        recipes: await import('./recipeRepo.js'),
        devices: await import('./devices/repo.js'),
      };
    })();
  }
  return booted;
}

test('a brew session keeps the recipe as it read on the day', async () => {
  const { brewSessions, recipes } = await boot();

  const saved = recipes.createRecipe(recipe('Citra Pale'));
  const brewSession = brewSessions.startBrewSession(saved.id, recipes.getRecipe(saved.id)!);

  assert.equal(brewSession.status, 'brewing');
  assert.equal(brewSession.brewNumber, 1);
  assert.equal(brewSession.recipe.name, 'Citra Pale');
  assert.equal(brewSession.recipe.grainKg, 5);
  assert.equal(brewSession.recipe.hopGrams, 60);
  assert.equal(brewSession.recipe.yeast, 'US-05');
  assert.equal(brewSession.recipe.batchSizeL, 20);
  // Nothing is measured until the brewer measures it — the recipe's targets
  // must never leak into the entry's own figures.
  assert.equal(brewSession.measured.og, '');
  assert.equal(brewSession.measured.volumeL, null);
  assert.equal(brewSession.durationMinutes, null);

  // Renaming and reworking the recipe afterwards must not rewrite history.
  const edited = recipe('Citra Pale v2');
  edited.fermentables[0]!.amount = '9';
  recipes.updateRecipe(saved.id, edited);

  const reread = brewSessions.getBrewSession(brewSession.id)!;
  assert.equal(reread.recipe.name, 'Citra Pale');
  assert.equal(reread.recipe.grainKg, 5);

  // Nor must deleting it: the entry loses its link, not its contents.
  recipes.deleteRecipe(saved.id);
  const orphaned = brewSessions.getBrewSession(brewSession.id)!;
  assert.equal(orphaned.recipeId, null);
  assert.equal(orphaned.recipe.name, 'Citra Pale');
});

test('the snapshot carries what efficiency is measured against', async () => {
  const { brewSessions, recipes } = await boot();

  const sheet = recipe('Efficiency Pale');
  // A kettle sugar and a honey stirred in afterwards: the first is in the wort
  // at the pre-boil reading, the second is not.
  sheet.fermentables.push(
    { name: 'Table Sugar', amount: '500', unit: 'g', percent: '', ebc: 0, ppg: null, fermentable: null, lateAddition: false },
    { name: 'Honey', amount: '1', unit: 'kg', percent: '', ebc: 2, ppg: null, fermentable: null, lateAddition: true },
  );
  const saved = recipes.createRecipe(sheet);
  const brewSession = brewSessions.startBrewSession(saved.id, recipes.getRecipe(saved.id)!);
  const snapshot = brewSession.recipe;

  // 4.5 kg of 37 PPG malt ≈ 367 point-gallons at perfect extraction.
  assert.ok(snapshot.mashedPointGallons != null && snapshot.mashedPointGallons > 300);
  assert.ok(snapshot.unmashedPointGallons! > snapshot.preBoilUnmashedPointGallons!);
  assert.ok(snapshot.preBoilUnmashedPointGallons! > 0);

  // The figure the detail page shows is derived from the entry alone — no
  // second look at the recipe, which is the point of snapshotting it.
  const measured = brewSessions.updateBrewSession(brewSession.id, {
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
  brewSessions.updateBrewSession(brewSession.id, { measured: { efficiencyPct: 68 } });
  assert.equal(brewSessions.getBrewSession(brewSession.id)?.measured.efficiencyPct, 68);
  brewSessions.updateBrewSession(brewSession.id, { measured: { efficiencyPct: null } });
  assert.equal(brewSessions.getBrewSession(brewSession.id)?.measured.efficiencyPct, null);
});

test('the snapshot carries the kettle the day is compared against', async () => {
  const { brewSessions, recipes } = await boot();

  const saved = recipes.createRecipe(recipe('Kettle Pale'));
  const stored = recipes.getRecipe(saved.id)!;
  const brewSession = brewSessions.startBrewSession(saved.id, stored);
  const snapshot = brewSession.recipe;

  // Both sides of the boil, in the units the sheet holds them: the gravities as
  // text, the volumes as litres already resolved from the automatic boil sizes.
  assert.equal(snapshot.preBoilGravity, stored.preBoilGravity);
  assert.equal(snapshot.postBoilGravity, stored.postBoilGravity);
  assert.equal(snapshot.preBoilVolumeL, stored.settings.boilSizePreL);
  assert.equal(snapshot.postBoilVolumeL, stored.settings.boilSizePostL);
  assert.ok(snapshot.preBoilVolumeL != null && snapshot.postBoilVolumeL != null);
  // The kettle loses volume over the boil, which is the whole reason the two
  // pre-boil and post-boil figures are different questions.
  assert.ok(snapshot.preBoilVolumeL > snapshot.postBoilVolumeL);
  assert.equal(snapshot.boilTimeMin, stored.settings.boilTimeMinutes);
  assert.equal(snapshot.efficiencyPct, stored.settings.efficiencyPercent);

  // And they are frozen like the rest of the snapshot: shortening the boil on
  // the sheet afterwards must not change what this batch was brewed to.
  const edited = recipe('Kettle Pale');
  edited.settings.boilTimeMinutes = 90;
  recipes.updateRecipe(saved.id, edited);
  assert.equal(brewSessions.getBrewSession(brewSession.id)!.recipe.boilTimeMin, 60);
});

test('a snapshot written before a field existed reads as unstated', async () => {
  const { brewSessions, recipes } = await boot();
  const saved = recipes.createRecipe(recipe('Legacy Ale'));
  const brewSession = brewSessions.startBrewSession(saved.id, recipes.getRecipe(saved.id)!);

  // What an entry logged before the kettle targets were recorded holds: the old
  // shape, with none of the newer keys present at all.
  const { sqlite } = await import('./db/index.js');
  sqlite
    .prepare('UPDATE brew_sessions SET recipe_snapshot = ? WHERE id = ?')
    .run(JSON.stringify({ name: 'Legacy Ale', style: 'American IPA', og: '1.060' }), brewSession.id);

  const reread = brewSessions.getBrewSession(brewSession.id)!;
  assert.equal(reread.recipe.name, 'Legacy Ale');
  assert.equal(reread.recipe.og, '1.060');
  // Not undefined — the type says these are always present, and a comparison
  // against an absent target has to read as "the recipe never said".
  assert.equal(reread.recipe.preBoilGravity, null);
  assert.equal(reread.recipe.postBoilVolumeL, null);
  assert.equal(reread.recipe.boilTimeMin, null);
  assert.equal(reread.recipe.batchSizeL, null);
  assert.equal(reread.recipe.yeast, '');

  // And a snapshot that no longer parses still lists rather than throwing.
  sqlite.prepare('UPDATE brew_sessions SET recipe_snapshot = ? WHERE id = ?').run('{ not json', brewSession.id);
  assert.equal(brewSessions.getBrewSession(brewSession.id)!.recipe.name, 'Unknown recipe');
});

test('brews of one recipe are numbered by date, and back-dating renumbers them', async () => {
  const { brewSessions, recipes } = await boot();
  const saved = recipes.createRecipe(recipe('House Bitter'));
  const detail = recipes.getRecipe(saved.id)!;

  const march = brewSessions.startBrewSession(saved.id, detail, '2026-03-01T09:00:00.000Z');
  const june = brewSessions.startBrewSession(saved.id, detail, '2026-06-01T09:00:00.000Z');
  assert.equal(brewSessions.getBrewSession(march.id)?.brewNumber, 1);
  assert.equal(brewSessions.getBrewSession(june.id)?.brewNumber, 2);

  // A batch remembered later slots into the sequence rather than onto the end.
  const january = brewSessions.startBrewSession(saved.id, detail, '2026-01-15T09:00:00.000Z');
  assert.equal(brewSessions.getBrewSession(january.id)?.brewNumber, 1);
  assert.equal(brewSessions.getBrewSession(march.id)?.brewNumber, 2);
  assert.equal(brewSessions.getBrewSession(june.id)?.brewNumber, 3);

  // The log itself reads newest first.
  assert.deepEqual(
    brewSessions
      .listBrewSessions()
      .filter((day) => day.recipeId === saved.id)
      .map((day) => day.id),
    [june.id, march.id, january.id],
  );

  const count = brewSessions.recipeBrewCounts().find((row) => row.recipeId === saved.id);
  assert.equal(count?.count, 3);
  assert.equal(count?.lastBrewedAt, '2026-06-01T09:00:00.000Z');
});

test('a recipe’s own history lists its batches, numbered as the whole log numbers them', async () => {
  const { brewSessions, recipes } = await boot();
  const bitter = recipes.createRecipe(recipe('House Bitter'));
  const stout = recipes.createRecipe(recipe('Dry Stout'));

  const march = brewSessions.startBrewSession(
    bitter.id,
    recipes.getRecipe(bitter.id)!,
    '2026-03-01T09:00:00.000Z',
  );
  const june = brewSessions.startBrewSession(
    bitter.id,
    recipes.getRecipe(bitter.id)!,
    '2026-06-01T09:00:00.000Z',
  );
  // Another recipe brewed in between, which this history must not pick up.
  brewSessions.startBrewSession(stout.id, recipes.getRecipe(stout.id)!, '2026-04-01T09:00:00.000Z');

  const history = brewSessions.listRecipeBrewSessions(bitter.id);
  assert.deepEqual(history.map((brew) => brew.id), [june.id, march.id]);
  // Numbered from the whole log, so a batch is the "#2" here that it is in the
  // logbook — not the second row of this list.
  assert.deepEqual(history.map((brew) => brew.brewNumber), [2, 1]);

  // A recipe nobody has brewed has no history rather than an error.
  assert.deepEqual(brewSessions.listRecipeBrewSessions('nothing-brewed'), []);
});

test('an edit writes only what it names, and null clears a measurement', async () => {
  const { brewSessions, recipes } = await boot();
  const saved = recipes.createRecipe(recipe('Saison'));
  const brewSession = brewSessions.startBrewSession(saved.id, recipes.getRecipe(saved.id)!);

  brewSessions.updateBrewSession(brewSession.id, {
    durationMinutes: 340,
    measured: { og: '1.058', volumeL: 21 },
    notes: 'Sparged too fast.',
  });
  const measured = brewSessions.getBrewSession(brewSession.id)!;
  assert.equal(measured.durationMinutes, 340);
  assert.equal(measured.measured.og, '1.058');
  assert.equal(measured.measured.volumeL, 21);
  assert.equal(measured.notes, 'Sparged too fast.');

  // A later edit that says nothing about the OG must leave the OG alone.
  brewSessions.updateBrewSession(brewSession.id, { measured: { fg: '1.006' } });
  const both = brewSessions.getBrewSession(brewSession.id)!;
  assert.equal(both.measured.og, '1.058');
  assert.equal(both.measured.fg, '1.006');

  // Null is "we didn't take this reading", and has to be storable as such —
  // otherwise a mistyped figure could only ever be corrected to a zero.
  brewSessions.updateBrewSession(brewSession.id, { measured: { volumeL: null } });
  assert.equal(brewSessions.getBrewSession(brewSession.id)?.measured.volumeL, null);

  // The kettle at knockout is its own reading, kept apart from the OG that
  // reached the fermenter — the two differ by what was left with the trub.
  brewSessions.updateBrewSession(brewSession.id, {
    measured: { postBoilGravity: '1.062', postBoilVolumeL: 23.5 },
  });
  const knockout = brewSessions.getBrewSession(brewSession.id)!;
  assert.equal(knockout.measured.postBoilGravity, '1.062');
  assert.equal(knockout.measured.postBoilVolumeL, 23.5);
  assert.equal(knockout.measured.og, '1.058');
  brewSessions.updateBrewSession(brewSession.id, { measured: { postBoilVolumeL: null } });
  assert.equal(brewSessions.getBrewSession(brewSession.id)?.measured.postBoilVolumeL, null);

  assert.equal(brewSessions.deleteBrewSession(brewSession.id), true);
  assert.equal(brewSessions.getBrewSession(brewSession.id), null);
});

test('the rig log follows the brew session, and stops when the batch moves on', async () => {
  const { brewSessions, recipes } = await boot();
  const saved = recipes.createRecipe(recipe('Dunkel'));
  const brewSession = brewSessions.startBrewSession(saved.id, recipes.getRecipe(saved.id)!);

  const inProgress = (): number[] => brewSessions.brewSessionsInProgress().map((row) => row.id);
  assert.ok(inProgress().includes(brewSession.id));

  brewSessions.insertRigSample(brewSession.id, {
    recordedAt: '2026-07-14T09:00:00.000Z',
    bk: 20,
    mlt: 64,
    hlt: 78,
  });
  brewSessions.insertRigSample(brewSession.id, {
    recordedAt: '2026-07-14T10:00:00.000Z',
    bk: 100,
    mlt: 68,
    // A sensor that dropped out contributes nothing rather than a zero.
    hlt: null,
  });

  const logged = brewSessions.getBrewSession(brewSession.id)!;
  assert.equal(logged.rigSamples.length, 2);
  assert.deepEqual(logged.rigStats.bk, { min: 20, max: 100, avg: 60, count: 2 });
  assert.deepEqual(logged.rigStats.mlt, { min: 64, max: 68, avg: 66, count: 2 });
  assert.deepEqual(logged.rigStats.hlt, { min: 78, max: 78, avg: 78, count: 1 });

  // Once the wort is in the tank there is no more mash or boil to log.
  brewSessions.updateBrewSession(brewSession.id, { status: 'fermenting' });
  assert.equal(inProgress().includes(brewSession.id), false);
});

test('the brew stages the rig stepped through are kept with the entry', async () => {
  const { brewSessions, recipes } = await boot();
  const saved = recipes.createRecipe(recipe('Stage Marks'));
  const brewSession = brewSessions.startBrewSession(saved.id, recipes.getRecipe(saved.id)!);

  const at = (minute: number): string =>
    new Date(Date.parse('2026-07-14T08:00:00.000Z') + minute * 60_000).toISOString();

  brewSessions.recordStageMarkers(brewSession.id, [
    { index: 0, name: 'Heating', at: at(0) },
    { index: 1, name: 'Mash', at: at(30) },
  ]);

  // The sampler hands over the rig's whole marker list on every sweep, so
  // re-recording what is already there must not multiply it.
  brewSessions.recordStageMarkers(brewSession.id, [
    { index: 0, name: 'Heating', at: at(0) },
    { index: 1, name: 'Mash', at: at(30) },
    { index: 2, name: 'Boil', at: at(95) },
  ]);

  assert.deepEqual(
    brewSessions.getBrewSession(brewSession.id)!.stageMarkers,
    [
      { index: 0, name: 'Heating', at: at(0) },
      { index: 1, name: 'Mash', at: at(30) },
      { index: 2, name: 'Boil', at: at(95) },
    ],
  );

  // Stepping back out of a stage and into it again re-stamps the rig's mark;
  // the entry follows it rather than keeping the first, wrong attempt.
  brewSessions.recordStageMarkers(brewSession.id, [{ index: 2, name: 'Boil', at: at(101) }]);
  const restamped = brewSessions.getBrewSession(brewSession.id)!.stageMarkers;
  assert.equal(restamped.length, 3);
  assert.equal(restamped[2]!.at, at(101));

  // A rig that reboots mid-brew comes back with an empty marker list. The
  // morning's stages are not the rig's to forget on the entry's behalf.
  brewSessions.recordStageMarkers(brewSession.id, []);
  assert.equal(brewSessions.getBrewSession(brewSession.id)!.stageMarkers.length, 3);

  // And they belong to this entry alone.
  const other = brewSessions.startBrewSession(saved.id, recipes.getRecipe(saved.id)!);
  assert.deepEqual(brewSessions.getBrewSession(other.id)!.stageMarkers, []);
});

test('a brew session with no rig stages reports none rather than failing', async () => {
  const { brewSessions, recipes } = await boot();
  const saved = recipes.createRecipe(recipe('No Stages'));
  const brewSession = brewSessions.startBrewSession(saved.id, recipes.getRecipe(saved.id)!);
  // Every entry brewed before the hub started recording these is this case.
  assert.deepEqual(brewSessions.getBrewSession(brewSession.id)!.stageMarkers, []);
});

test('fermentation figures are read from the fermenter over the batch window', async () => {
  const { brewSessions, recipes, devices } = await boot();
  const saved = recipes.createRecipe(recipe('Kveik Pale'));
  const brewSession = brewSessions.startBrewSession(saved.id, recipes.getRecipe(saved.id)!, '2026-05-01T08:00:00.000Z');

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

  brewSessions.updateBrewSession(brewSession.id, {
    pitchedAt: '2026-05-01T18:00:00.000Z',
    packagedAt: '2026-05-15T12:00:00.000Z',
    status: 'packaged',
  });

  const { fermentation } = brewSessions.getBrewSession(brewSession.id)!;
  assert.deepEqual(fermentation.temp, { min: 18, max: 22, avg: 20, count: 2 });
  assert.equal(fermentation.deviceName, 'Fermenter');
  assert.equal(fermentation.gravity?.start, 1.058);
  assert.equal(fermentation.gravity?.end, 1.012);
  assert.equal(fermentation.days, 13);
});
