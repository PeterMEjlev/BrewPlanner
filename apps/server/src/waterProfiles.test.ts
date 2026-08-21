import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/**
 * The brewery's saved target water profiles.
 *
 * The behaviour worth pinning is the upsert: saving over a name a brewer has
 * already used has to replace that profile rather than add a second one, and it
 * has to keep the id, because a recipe pointing at a profile by id should follow
 * the edit instead of dangling. Everything else here (a blob that isn't an
 * array, a missing key) is about the calculator staying usable when the stored
 * value is junk — an empty library, never a throw.
 *
 * DATABASE_PATH must be set before the db module loads, hence dynamic imports.
 */

let booted: Promise<typeof import('./repo.js')> | null = null;

function boot() {
  if (!booted) {
    booted = (async () => {
      process.env.DATABASE_PATH = join(tmpdir(), `brewplanner-water-${randomUUID()}.sqlite`);
      const database = await import('./db/index.js');
      database.runMigrations();
      return import('./repo.js');
    })();
  }
  return booted;
}

const PALE = { name: 'House pale', ca: 75, mg: 0, na: 0, cl: 75, so4: 80, hco3: null };

test('starts empty, and a saved profile comes back with an id', async () => {
  const repo = await boot();
  assert.deepEqual(repo.getWaterProfiles(), []);

  const list = repo.saveWaterProfile(PALE);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.name, 'House pale');
  assert.ok(list[0]!.id);
  assert.deepEqual(repo.getWaterProfiles(), list);
});

test('saving over a name replaces that profile and keeps its id', async () => {
  const repo = await boot();
  const before = repo.getWaterProfiles().find((p) => p.name === 'House pale');
  assert.ok(before);

  // Same profile, retyped with different case and a trailing space — plainly
  // the same one to a brewer, so it must not become a second entry.
  const list = repo.saveWaterProfile({ ...PALE, name: 'house pale ', so4: 200, hco3: 40 });
  assert.equal(list.filter((p) => p.name.toLowerCase().trim() === 'house pale').length, 1);

  const after = list.find((p) => p.id === before.id);
  assert.ok(after, 'the id must survive an overwrite');
  assert.equal(after.so4, 200);
  assert.equal(after.hco3, 40);
  assert.equal(after.name, 'house pale', 'the name is stored trimmed');
  assert.equal(after.createdAt, before.createdAt);
});

test('a distinct name adds a second profile, and delete removes just it', async () => {
  const repo = await boot();
  const added = repo.saveWaterProfile({ ...PALE, name: 'Stout liquor', hco3: 120 });
  assert.equal(added.length, 2);

  const stout = added.find((p) => p.name === 'Stout liquor');
  assert.ok(stout);
  // null vs 0 is a real distinction: this profile wants 120 ppm, while the pale
  // one defers to whatever the grist asks for.
  assert.equal(stout.hco3, 120);

  const left = repo.deleteWaterProfile(stout.id);
  assert.equal(left.length, 1);
  assert.equal(left[0]!.name, 'house pale');
  assert.deepEqual(repo.getWaterProfiles(), left);
});

test('a stored blob that is not an array reads as an empty library', async () => {
  const repo = await boot();
  repo.setSetting('water_profiles', '{"not":"an array"}');
  assert.deepEqual(repo.getWaterProfiles(), []);

  repo.setSetting('water_profiles', 'not json at all');
  assert.deepEqual(repo.getWaterProfiles(), []);
});

// ---------------------------------------------------------------------------
// The live link: a recipe following a saved profile
// ---------------------------------------------------------------------------

/**
 * A recipe's water profile is resolved against the library on every read, so
 * editing a saved profile has to change what every recipe pointing at it brews
 * to. The stored ion columns are a snapshot that only surfaces if the profile
 * is deleted — these tests pin both halves of that.
 */
const META = {
  id: 'r1',
  origin: 'local' as const,
  url: '',
  familyId: 'f1',
  version: 1,
  versionNote: '',
  versions: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function sheet(water: Record<string, unknown> | null) {
  return {
    name: 'Test beer',
    style: '',
    settings: undefined as never,
    og: '', preBoilGravity: '', postBoilGravity: '', fg: '', abv: '', ibu: '', ebc: '',
    ebcEstimated: false, batchSizeL: 20, mashTemp: '', fermentationTemp: '',
    fermentables: [], hops: [], yeast: [], otherIngredients: [],
    notes: '', mashGuidelines: null,
    waterProfile: water,
  } as never;
}

test('a linked recipe reads the profile as it stands now, not as it was stored', async () => {
  const repo = await boot();
  const { hydrateRecipe } = await import('./recipeData.js');

  const [profile] = repo.saveWaterProfile({ ...PALE, name: 'Linked', so4: 80, hco3: null });
  assert.ok(profile);

  // The stored snapshot is deliberately stale — the resolver must ignore it.
  const stored = {
    sourceName: null, profileId: profile.id, name: 'Whatever it was called', ph: null, notes: null,
    calcium: '1', magnesium: '1', sodium: '1', chloride: '1', sulfate: '1', bicarbonate: '1',
  };

  const before = hydrateRecipe(META, sheet(stored)).waterProfile;
  assert.equal(before?.sulfate, '80');
  assert.equal(before?.name, 'Linked', 'the profile owns the name too');
  assert.equal(before?.bicarbonate, null, 'null bicarbonate stays null, not "0"');

  // Edit the profile; the same stored sheet must now read differently.
  repo.saveWaterProfile({ ...PALE, name: 'Linked', so4: 250, hco3: 60 });
  const after = hydrateRecipe(META, sheet(stored)).waterProfile;
  assert.equal(after?.sulfate, '250');
  assert.equal(after?.bicarbonate, '60');
});

test('deleting the profile leaves the recipe on its stored snapshot, unlinked', async () => {
  const repo = await boot();
  const { hydrateRecipe } = await import('./recipeData.js');

  const linked = repo.getWaterProfiles().find((p) => p.name === 'Linked');
  assert.ok(linked);
  repo.deleteWaterProfile(linked.id);

  const stored = {
    sourceName: null, profileId: linked.id, name: 'Linked', ph: null, notes: null,
    calcium: '75', magnesium: '0', sodium: '0', chloride: '75', sulfate: '250', bicarbonate: '60',
  };
  const resolved = hydrateRecipe(META, sheet(stored)).waterProfile;
  assert.equal(resolved?.profileId, null, 'a dangling link is dropped');
  assert.equal(resolved?.sulfate, '250', 'the recipe still says what it was brewed to');
});

test('an unlinked recipe is passed through untouched', async () => {
  await boot();
  const { hydrateRecipe } = await import('./recipeData.js');
  const stored = {
    sourceName: null, profileId: null, name: 'Hand typed', ph: null, notes: null,
    calcium: '42', magnesium: '0', sodium: '0', chloride: '50', sulfate: '90', bicarbonate: null,
  };
  assert.deepEqual(hydrateRecipe(META, sheet(stored)).waterProfile, stored);
});
