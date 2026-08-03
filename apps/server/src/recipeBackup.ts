import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { RecipeBackupFile, RecipeBackupResult, RecipeBackupStatus } from '@checklist/shared';
import { databasePath } from './db/index.js';
import { DRIVE_FOLDER_ID, DriveError, driveAuthMethod, driveConfigured, uploadJsonToDrive } from './googleDrive.js';
import { listRecipeBackups } from './recipeRepo.js';
import { getSetting, setSetting } from './repo.js';

/**
 * Nightly (and on-demand) backup of the recipe library.
 *
 * Two destinations, in that order of dependability. Every backup is written to
 * a folder on the Pi first — that copy needs no credentials, no network and no
 * Google, and is what makes this a backup at all — and is then uploaded to the
 * shared Drive folder, which is what makes it a backup of the *Pi*. A failed
 * upload is recorded and reported, never allowed to lose the local file.
 *
 * The format is JSON: the editable sheet of every recipe, exactly as the
 * library stores it, so a restore is a replay of `POST /api/recipes` rather
 * than an interpretation. Prices and gram weights are deliberately absent —
 * they are derived from the shop catalogue on every read, and freezing today's
 * prices into a backup would be recording the shop, not the recipe.
 */

const STATE_KEY = 'recipe_backup_state';

/** Where local copies live. Beside the database, so one folder holds the lot. */
const BACKUP_DIR = resolve(
  process.env.RECIPE_BACKUP_DIR ?? join(dirname(databasePath), 'recipe-backups'),
);

/**
 * How many local backups to keep. A year of dailies is a few tens of megabytes,
 * which is nothing on a laptop and a real bite out of a Pi's SD card — and the
 * Drive folder is the long tail anyway.
 */
const KEEP_LOCAL = Number(process.env.RECIPE_BACKUP_KEEP ?? 30);

const FILE_PREFIX = 'brewplanner-recipes-';

/** What the last run did, kept across restarts so the page can report it. */
interface BackupState {
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  lastFilename: string | null;
  lastRecipeCount: number | null;
  /** Digest of the last backed-up payload — see {@link runRecipeBackup}. */
  lastDigest: string | null;
  lastDriveFileId: string | null;
}

const EMPTY_STATE: BackupState = {
  lastRunAt: null,
  lastOkAt: null,
  lastError: null,
  lastFilename: null,
  lastRecipeCount: null,
  lastDigest: null,
  lastDriveFileId: null,
};

function readState(): BackupState {
  const raw = getSetting(STATE_KEY);
  if (!raw) return EMPTY_STATE;
  try {
    return { ...EMPTY_STATE, ...(JSON.parse(raw) as Partial<BackupState>) };
  } catch {
    return EMPTY_STATE;
  }
}

function writeState(state: BackupState): void {
  setSetting(STATE_KEY, JSON.stringify(state));
}

/**
 * `brewplanner-recipes-20260728T031500123Z.json` — ISO basic format, so the
 * names sort chronologically wherever they are listed.
 *
 * Milliseconds and not merely seconds: a manual backup taken in the same second
 * as another one has to be a second file, or the first is silently overwritten
 * locally while Drive quietly keeps two files of the same name.
 */
function backupFilename(at: Date): string {
  return `${FILE_PREFIX}${at.toISOString().replace(/[-:.]/g, '')}.json`;
}

/** The library as one JSON document, and the digest that says whether it moved. */
export function buildRecipeBackup(at = new Date()): {
  filename: string;
  json: string;
  file: RecipeBackupFile;
  digest: string;
} {
  const { entries, unreadable } = listRecipeBackups();
  const file: RecipeBackupFile = {
    app: 'BrewPlanner',
    kind: 'recipe-library',
    version: 1,
    exportedAt: at.toISOString(),
    recipeCount: entries.length,
    unreadableIds: unreadable,
    recipes: entries,
  };
  const json = `${JSON.stringify(file, null, 2)}\n`;
  // Digested without the timestamp, so "has anything changed since yesterday"
  // isn't answered by the fact that it is a different day.
  const digest = createHash('sha256')
    .update(JSON.stringify({ ...file, exportedAt: '' }))
    .digest('hex');
  return { filename: backupFilename(at), json, file, digest };
}

/** Delete all but the newest {@link KEEP_LOCAL} local backups. */
function pruneLocal(log?: FastifyBaseLogger): void {
  if (!(KEEP_LOCAL > 0)) return;
  try {
    const files = readdirSync(BACKUP_DIR)
      .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith('.json'))
      .sort();
    for (const name of files.slice(0, Math.max(0, files.length - KEEP_LOCAL))) {
      rmSync(join(BACKUP_DIR, name), { force: true });
    }
  } catch (err) {
    // Housekeeping: a full disk is worth a line in the log, not a failed backup.
    log?.warn(err, 'Could not prune old recipe backups');
  }
}

/**
 * Take a backup now.
 *
 * `trigger` is the one thing that changes the behaviour: a nightly run whose
 * payload is byte-identical to the last one is skipped rather than filed, so a
 * week of not touching the recipes leaves one backup rather than seven copies
 * of it. A backup the brewer asked for is always taken — they asked.
 */
export async function runRecipeBackup(
  trigger: 'manual' | 'scheduled',
  log?: FastifyBaseLogger,
): Promise<RecipeBackupResult> {
  const at = new Date();
  const { filename, json, file, digest } = buildRecipeBackup(at);
  const state = readState();

  if (trigger === 'scheduled' && digest === state.lastDigest) {
    writeState({ ...state, lastRunAt: at.toISOString() });
    return {
      at: at.toISOString(),
      skipped: true,
      filename: state.lastFilename,
      recipeCount: file.recipeCount,
      unreadableIds: file.unreadableIds,
      localPath: null,
      driveFileId: null,
      driveError: null,
    };
  }

  // The local copy first: it needs nothing but a working disk, and it is what
  // makes the rest of this best-effort rather than load-bearing.
  mkdirSync(BACKUP_DIR, { recursive: true });
  const localPath = join(BACKUP_DIR, filename);
  writeFileSync(localPath, json, 'utf8');
  pruneLocal(log);

  let driveFileId: string | null = null;
  let driveError: string | null = null;
  if (driveConfigured()) {
    try {
      driveFileId = await uploadJsonToDrive(filename, json);
    } catch (err) {
      driveError = err instanceof DriveError ? err.message : `Google Drive upload failed: ${String(err)}`;
      log?.error(err, 'Recipe backup upload to Google Drive failed');
    }
  } else {
    driveError = 'No Google Drive credentials on this server — the backup was written locally only.';
  }

  writeState({
    lastRunAt: at.toISOString(),
    // "OK" means the library was captured somewhere durable, which the local
    // file already is; the Drive half reports itself separately.
    lastOkAt: at.toISOString(),
    lastError: driveError,
    lastFilename: filename,
    lastRecipeCount: file.recipeCount,
    lastDigest: digest,
    lastDriveFileId: driveFileId,
  });

  return {
    at: at.toISOString(),
    skipped: false,
    filename,
    recipeCount: file.recipeCount,
    unreadableIds: file.unreadableIds,
    localPath,
    driveFileId,
    driveError,
  };
}

/** What the Recipes page shows about backups without taking one. */
export function recipeBackupStatus(): RecipeBackupStatus {
  const state = readState();
  return {
    lastRunAt: state.lastRunAt,
    lastOkAt: state.lastOkAt,
    lastError: state.lastError,
    lastFilename: state.lastFilename,
    lastRecipeCount: state.lastRecipeCount,
    lastDriveFileId: state.lastDriveFileId,
    driveConfigured: driveConfigured(),
    driveAuthMethod: driveAuthMethod(),
    driveFolderId: DRIVE_FOLDER_ID,
    localDir: BACKUP_DIR,
    keepLocal: KEEP_LOCAL,
  };
}

/**
 * Once a day, plus one shortly after boot so a Pi that is only switched on for
 * brew sessions still files something. Unref'd like the other schedulers, so it
 * never holds the process open.
 */
export function startRecipeBackupScheduler(log: FastifyBaseLogger): void {
  const tick = (): void => {
    void runRecipeBackup('scheduled', log).catch((err) => {
      log.error(err, 'Scheduled recipe backup failed');
    });
  };
  setInterval(tick, 24 * 60 * 60 * 1000).unref();
  setTimeout(tick, 5 * 60 * 1000).unref();
  log.info(
    driveConfigured()
      ? `Daily recipe backup enabled (local copies in ${BACKUP_DIR}, uploaded to Drive folder ${DRIVE_FOLDER_ID}).`
      : `Daily recipe backup enabled, local only (${BACKUP_DIR}) — no Google Drive credentials configured.`,
  );
}
