import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_RECIPE_SETTINGS } from '@checklist/shared';
import type { RecipeBackupFile, RecipeEditInput } from '@checklist/shared';

function sheet(name: string): RecipeEditInput {
  return {
    name,
    style: 'IPA',
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
    fermentables: [{
      name: 'Pilsner Malt',
      amount: '5',
      unit: 'kg',
      percent: '',
      ebc: 4,
      ppg: 37,
      fermentable: null,
      lateAddition: false,
    }],
    hops: [],
    yeast: [],
    otherIngredients: [],
    mashGuidelines: null,
    waterProfile: null,
  };
}

test('a backup holds every recipe as a restorable sheet, and repeats itself only when asked', async () => {
  const databasePath = join(tmpdir(), `brewplanner-backup-${randomUUID()}.sqlite`);
  const backupDir = mkdtempSync(join(tmpdir(), 'brewplanner-backups-'));
  process.env.DATABASE_PATH = databasePath;
  process.env.RECIPE_BACKUP_DIR = backupDir;
  // Whatever the developer's own environment holds: this test is about the
  // local half, and must never try to reach Google.
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  delete process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  const database = await import('./db/index.js');
  database.runMigrations();
  const repo = await import('./recipeRepo.js');
  const backup = await import('./recipeBackup.js');

  try {
    repo.createRecipe(sheet('Backup me'));
    repo.createRecipe(sheet('And me'));

    const first = await backup.runRecipeBackup('manual');
    assert.equal(first.skipped, false);
    assert.equal(first.recipeCount, 2);
    assert.deepEqual(first.unreadableIds, []);
    // No credentials here, so the Drive half reports itself rather than failing
    // the run — the local copy is what makes it a backup.
    assert.equal(first.driveFileId, null);
    assert.match(first.driveError ?? '', /No Google Drive credentials/);

    const files = readdirSync(backupDir);
    assert.equal(files.length, 1);
    const file = JSON.parse(readFileSync(join(backupDir, files[0]!), 'utf8')) as RecipeBackupFile;
    assert.equal(file.kind, 'recipe-library');
    assert.equal(file.version, 1);
    assert.equal(file.recipes.length, 2);
    assert.deepEqual(
      file.recipes.map((r) => r.recipe.name).sort(),
      ['And me', 'Backup me'],
    );
    // The editable sheet, not the priced one: costs come from the shop
    // catalogue on every read and have no business in a recipe backup.
    const grain = file.recipes[0]?.recipe.fermentables[0] as Record<string, unknown> | undefined;
    assert.equal(grain?.name, 'Pilsner Malt');
    assert.equal('price' in (grain ?? {}), false);
    assert.equal('grams' in (grain ?? {}), false);

    // A nightly run over an unchanged library files nothing…
    const nightly = await backup.runRecipeBackup('scheduled');
    assert.equal(nightly.skipped, true);
    assert.equal(readdirSync(backupDir).length, 1);

    // …until something changes.
    repo.createRecipe(sheet('Written today'));
    const afterEdit = await backup.runRecipeBackup('scheduled');
    assert.equal(afterEdit.skipped, false);
    assert.equal(afterEdit.recipeCount, 3);
    assert.equal(readdirSync(backupDir).length, 2);

    // A backup somebody asked for is always taken, changed or not.
    const asked = await backup.runRecipeBackup('manual');
    assert.equal(asked.skipped, false);
    assert.equal(readdirSync(backupDir).length, 3);

    assert.equal(backup.recipeBackupStatus().lastRecipeCount, 3);
    assert.equal(backup.recipeBackupStatus().driveConfigured, false);
  } finally {
    database.sqlite.close();
    for (const path of [databasePath, `${databasePath}-shm`, `${databasePath}-wal`]) {
      rmSync(path, { force: true });
    }
    rmSync(backupDir, { recursive: true, force: true });
  }
});
