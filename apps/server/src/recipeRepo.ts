import { randomUUID } from 'node:crypto';
import type {
  Recipe,
  RecipeDetail,
  RecipeEditInput,
  RecipeHeadline,
  IngredientKind,
  RecipeOrigin,
  RecipeIngredientOption,
  RecipeStats,
  RecipeVersionSummary,
} from '@checklist/shared';
import {
  applyRecipeCalculations,
  estimateFruitAbvContribution,
  recipeEditSchema,
} from '@checklist/shared';
import { desc, eq, inArray } from 'drizzle-orm';
import { db } from './db/index.js';
import { recipes } from './db/schema.js';
import { editableRecipe, hydrateRecipe, pourColor, recipeStats } from './recipeData.js';
import { getSetting } from './repo.js';

type RecipeRow = typeof recipes.$inferSelect;

function rowToDetail(row: RecipeRow, versions: RecipeVersionSummary[] = []): RecipeDetail {
  const input = rowInput(row);
  const origin: RecipeOrigin = row.origin === 'brewersfriend' ? 'brewersfriend' : 'local';
  return hydrateRecipe(
    {
      id: row.id,
      origin,
      url: row.brewersFriendUrl,
      familyId: familyOf(row),
      version: row.version,
      versionNote: row.versionNote,
      // Only a sheet fetched on its own carries its siblings: the list views
      // hydrate every recipe they hold, and a version query apiece would be a
      // query per card for something no card shows.
      versions,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    input,
  );
}

/**
 * A row's family, tolerating one that has none.
 *
 * The column is backfilled by migration, so this only stands in for a row
 * written by a build that predates versioning and inserted since — a recipe on
 * its own is its own family, which is exactly what the migration says too.
 */
function familyOf(row: Pick<RecipeRow, 'id' | 'familyId'>): string {
  return row.familyId || row.id;
}

function rowInput(row: RecipeRow): RecipeEditInput {
  const input = recipeEditSchema.parse(JSON.parse(row.recipe));
  if (input.fruitAbvIncluded) return input;

  // Recipes written before fruit sugar was part of the calculator (including
  // the one-time Brewer's Friend import) carry the base beer's ABV. Bring those
  // forward on read so an existing fruited sour benefits immediately, without
  // waiting for somebody to open and re-save every old sheet. New writes set
  // the marker in applyRecipeCalculations and therefore never add this twice.
  const fruitAbv = estimateFruitAbvContribution(input.otherIngredients, input.batchSizeL);
  const baseAbv = Number.parseFloat(input.abv.replace(',', '.'));
  return {
    ...input,
    abv:
      fruitAbv > 0 && Number.isFinite(baseAbv)
        ? (baseAbv + fruitAbv).toFixed(2)
        : input.abv,
    fruitAbvIncluded: true,
  };
}

/**
 * The headline figures of particular recipe rows — no ingredient hydration, no
 * pricing, just the sheet's own numbers with the fruit-ABV migration applied.
 *
 * Cheap enough to call once per list: the brew-session log uses it so every
 * entry is described by the recipe as it stands rather than by the copy frozen
 * onto it when the batch started. Ids with no row left simply do not appear.
 */
export function recipeHeadlines(ids: string[]): Map<string, RecipeHeadline> {
  const wanted = [...new Set(ids)];
  const headlines = new Map<string, RecipeHeadline>();
  if (wanted.length === 0) return headlines;
  for (const row of db.select().from(recipes).where(inArray(recipes.id, wanted)).all()) {
    const input = rowInput(row);
    const pour = pourColor(input);
    headlines.set(row.id, {
      name: input.name,
      style: input.style,
      og: input.og,
      fg: input.fg,
      abv: input.abv,
      ibu: input.ibu,
      ebc: input.ebc,
      batchSizeL: input.batchSizeL,
      pourHex: pour?.hex ?? null,
      pourNote: pour?.fruit?.note ?? null,
    });
  }
  return headlines;
}

function rowToSummary(row: RecipeRow, versionCount = 1): Recipe {
  const input = rowInput(row);
  return {
    id: row.id,
    origin: row.origin === 'brewersfriend' ? 'brewersfriend' : 'local',
    familyId: familyOf(row),
    version: row.version,
    versionCount,
    name: input.name,
    style: input.style,
    abv: input.abv,
    url: row.brewersFriendUrl,
    ibu: input.ibu,
    ebc: input.ebc,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The library as the grid shows it: one entry per beer, being its newest
 * version. Older versions are reachable from the sheet's version picker rather
 * than as cards of their own — a beer brewed four times with three revisions is
 * one beer, and listing every revision would bury the rest of the library.
 */
export function listRecipes(): Recipe[] {
  const rows = db.select().from(recipes).orderBy(desc(recipes.createdAt)).all();
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(familyOf(row), (counts.get(familyOf(row)) ?? 0) + 1);
  return newestPerFamily(rows).map((row) => rowToSummary(row, counts.get(familyOf(row)) ?? 1));
}

/**
 * One row per family — the highest version number in each, with the row's own
 * order otherwise preserved so the caller's `ORDER BY` still decides the list.
 *
 * Highest version rather than most recently created: back-filling notes onto v1
 * after writing v2 must not make v1 the one the library opens on.
 */
function newestPerFamily(rows: RecipeRow[]): RecipeRow[] {
  const newest = new Map<string, RecipeRow>();
  for (const row of rows) {
    const current = newest.get(familyOf(row));
    if (!current || row.version > current.version) newest.set(familyOf(row), row);
  }
  return rows.filter((row) => newest.get(familyOf(row)) === row);
}

/** Every version of one beer, newest first — what a sheet's version picker lists. */
export function listRecipeVersions(familyId: string): RecipeVersionSummary[] {
  return db
    .select({
      id: recipes.id,
      version: recipes.version,
      versionNote: recipes.versionNote,
      createdAt: recipes.createdAt,
      updatedAt: recipes.updatedAt,
    })
    .from(recipes)
    .where(eq(recipes.familyId, familyId))
    .orderBy(desc(recipes.version))
    .all();
}

/**
 * Which beer a recipe id belongs to, or null if there is no such recipe. Used
 * by the brew log, which counts and lists batches per beer rather than per
 * version.
 */
export function recipeFamilyId(id: string): string | null {
  const row = db
    .select({ id: recipes.id, familyId: recipes.familyId })
    .from(recipes)
    .where(eq(recipes.id, id))
    .get();
  return row ? familyOf(row) : null;
}

/** Every version id of one beer, for queries that span a family. */
export function recipeFamilyIds(familyId: string): string[] {
  return db
    .select({ id: recipes.id })
    .from(recipes)
    .where(eq(recipes.familyId, familyId))
    .all()
    .map((row) => row.id);
}

export function listRecipeDetails(): RecipeDetail[] {
  return db.select().from(recipes).orderBy(desc(recipes.createdAt)).all().map((row) => rowToDetail(row));
}

export function listRecipeStats(): RecipeStats[] {
  return listRecipeDetails().map(recipeStats);
}

/**
 * Every stored recipe as the sheet the brewer wrote, with the identity it was
 * saved under — what a backup holds, and what restoring one would replay.
 *
 * The editable sheet rather than the hydrated detail: prices and gram weights
 * are worked out from the shop catalogue on every read, so backing them up
 * would store today's prices as though they were part of the recipe.
 *
 * A row whose stored JSON no longer parses is reported rather than thrown on:
 * one unreadable recipe must not be the reason the other forty go un-backed-up.
 */
export function listRecipeBackups(): { entries: RecipeBackupEntry[]; unreadable: string[] } {
  const entries: RecipeBackupEntry[] = [];
  const unreadable: string[] = [];
  for (const row of db.select().from(recipes).orderBy(desc(recipes.createdAt)).all()) {
    try {
      entries.push({
        id: row.id,
        origin: row.origin === 'brewersfriend' ? 'brewersfriend' : 'local',
        url: row.brewersFriendUrl,
        familyId: familyOf(row),
        version: row.version,
        versionNote: row.versionNote,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        recipe: rowInput(row),
      });
    } catch {
      unreadable.push(row.id);
    }
  }
  return { entries, unreadable };
}

/** One recipe in a backup file: its identity, and the sheet itself. */
export interface RecipeBackupEntry {
  id: string;
  origin: RecipeOrigin;
  url: string;
  /** Which beer this is a version of, and which version — so a restore keeps the chain. */
  familyId: string;
  version: number;
  versionNote: string;
  createdAt: string;
  updatedAt: string;
  recipe: RecipeEditInput;
}

/** Ingredients already used in this library, including brewing metadata for the comboboxes. */
export function listRecipeIngredientOptions(
  kind: IngredientKind,
  query = '',
  limit = 60,
): RecipeIngredientOption[] {
  const wanted = query.trim().toLocaleLowerCase();
  const options = new Map<string, RecipeIngredientOption>();
  const add = (name: string, metadata: Pick<RecipeIngredientOption, 'ebc' | 'aa' | 'yeast'> = {}) => {
    const trimmed = name.trim();
    if (!trimmed || (wanted && !trimmed.toLocaleLowerCase().includes(wanted))) return;
    const key = trimmed.toLocaleLowerCase();
    const existing = options.get(key);
    options.set(key, {
      name: existing?.name ?? trimmed,
      source: 'recipe',
      ebc: existing?.ebc ?? metadata.ebc ?? null,
      aa: existing?.aa ?? metadata.aa ?? null,
      yeast: existing?.yeast ?? metadata.yeast ?? null,
    });
  };
  for (const row of db.select().from(recipes).all()) {
    const input = rowInput(row);
    if (kind === 'fermentable') {
      for (const line of input.fermentables) add(line.name, { ebc: line.ebc });
    } else if (kind === 'hop') {
      for (const line of input.hops) {
        const aa = Number.parseFloat(line.aa.replace(',', '.'));
        add(line.name, { aa: Number.isFinite(aa) ? aa : null });
      }
    } else if (kind === 'yeast') {
      // A strain this brewery has pitched before is described by how the recipe
      // it came from describes it, which beats the built-in table: the numbers
      // travelled with the recipe from Brewer's Friend, and where the brewer
      // has since corrected one, the correction is what should come back.
      for (const line of input.yeast) {
        add(line.name, {
          yeast: {
            lab: line.lab,
            type: line.type,
            form: line.form,
            attenuation: line.attenuation,
            flocculation: line.flocculation,
            minTempC: line.minTempC,
            maxTempC: line.maxTempC,
            alcoholTolerance: line.alcoholTolerance,
          },
        });
      }
    } else {
      for (const line of input.otherIngredients) add(line.name);
    }
  }
  return [...options.values()]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .slice(0, limit);
}

export function listIngredientNames(kind: IngredientKind, query = '', limit = 60): string[] {
  return listRecipeIngredientOptions(kind, query, limit).map((option) => option.name);
}

export function getRecipe(id: string): RecipeDetail | null {
  const row = db.select().from(recipes).where(eq(recipes.id, id)).get();
  if (!row) return null;
  const versions = listRecipeVersions(familyOf(row));
  // A row is always a version of itself. It wouldn't be in the list above if
  // its `family_id` were blank — only reachable for a row written by a build
  // that predates versioning — and a version picker that doesn't list the
  // version on screen has nothing to show as selected.
  return rowToDetail(
    row,
    versions.some((v) => v.id === row.id)
      ? versions
      : [
          {
            id: row.id,
            version: row.version,
            versionNote: row.versionNote,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          },
          ...versions,
        ],
  );
}

/**
 * The version of a beer that a link to it should open: its newest. Given any
 * version's id, so a bookmark, a keg or an old brew session can all be followed
 * to "this beer as it stands now".
 */
export function latestRecipeInFamily(familyId: string): RecipeDetail | null {
  const row = db
    .select()
    .from(recipes)
    .where(eq(recipes.familyId, familyId))
    .orderBy(desc(recipes.version))
    .get();
  return row ? rowToDetail(row, listRecipeVersions(familyOf(row))) : null;
}

/** A new beer: version 1 of a family of its own. Also what cloning writes. */
export function createRecipe(input: RecipeEditInput, versionNote = ''): RecipeDetail {
  const now = new Date().toISOString();
  const id = randomUUID();
  const calculated = applyRecipeCalculations(input);
  db.insert(recipes)
    .values({
      id,
      origin: 'local',
      recipe: JSON.stringify(calculated),
      brewersFriendUrl: '',
      // Its own family, which it is the first member of. A clone is a new beer
      // rather than a version of the one it was copied from: it gets its own
      // family, and so its own brew history, from the moment it is saved.
      familyId: id,
      version: 1,
      versionNote,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getRecipe(id)!;
}

/**
 * The next version of an existing beer: a new row in the same family, numbered
 * one past the highest version there.
 *
 * A whole row rather than a diff against v1, because a version has to be
 * brewable on its own — a brew session, a keg and the fermenter selection all
 * point at a recipe id, and each must go on meaning the sheet it meant.
 *
 * Numbered one past the highest version still in the family rather than off its
 * row count, so a family that lost its v2 goes 1 → 3 → 4 rather than minting a
 * second v3. Deleting the newest version does free its number again, which is
 * harmless: deleting a recipe row nulls the `recipeId` of every batch brewed
 * from it, so a reissued number can't collide with a batch that still refers
 * to the version it replaced.
 *
 * Null when `sourceId` names no recipe — the caller answers 404.
 */
export function createRecipeVersion(
  sourceId: string,
  input: RecipeEditInput,
  versionNote = '',
): RecipeDetail | null {
  const source = db
    .select({ id: recipes.id, familyId: recipes.familyId, origin: recipes.origin, brewersFriendUrl: recipes.brewersFriendUrl })
    .from(recipes)
    .where(eq(recipes.id, sourceId))
    .get();
  if (!source) return null;
  const familyId = familyOf(source);
  const highest = db
    .select({ version: recipes.version })
    .from(recipes)
    .where(eq(recipes.familyId, familyId))
    .orderBy(desc(recipes.version))
    .get();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.insert(recipes)
    .values({
      id,
      // A version of an imported recipe is this brewery's own work, not
      // Brewer's Friend's — and it has no page over there to link to.
      origin: 'local',
      recipe: JSON.stringify(applyRecipeCalculations(input)),
      brewersFriendUrl: '',
      familyId,
      version: (highest?.version ?? 0) + 1,
      versionNote,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getRecipe(id)!;
}

/**
 * Save an edit to one version. `versionNote` is left alone when null, so a
 * client that doesn't know about versions can't blank the note by saving.
 */
export function updateRecipe(
  id: string,
  input: RecipeEditInput,
  versionNote: string | null = null,
): RecipeDetail | null {
  const calculated = applyRecipeCalculations(input);
  const result = db
    .update(recipes)
    .set({
      recipe: JSON.stringify(calculated),
      ...(versionNote == null ? {} : { versionNote }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(recipes.id, id))
    .run();
  return result.changes > 0 ? getRecipe(id) : null;
}

export function deleteRecipe(id: string): boolean {
  return db.delete(recipes).where(eq(recipes.id, id)).run().changes > 0;
}

/**
 * Insert one legacy recipe without overwriting an app-owned edit. Re-running an
 * import is therefore safe: existing ids are skipped and only new BF recipes
 * join the library.
 */
export function importBrewersFriendRecipe(recipe: RecipeDetail): boolean {
  const input = legacyEditedInput(recipe.id) ?? editableRecipe(recipe);
  const result = db
    .insert(recipes)
    .values({
      id: recipe.id,
      origin: 'brewersfriend',
      brewersFriendId: recipe.id,
      brewersFriendUrl: recipe.url,
      recipe: JSON.stringify(input),
      familyId: recipe.id,
      version: 1,
      createdAt: recipe.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();
  return result.changes > 0;
}

/** Number of durable app recipes, used to decide whether initial import is due. */
export function recipeCount(): number {
  return db.select({ id: recipes.id }).from(recipes).all().length;
}

/**
 * Compatibility with the short-lived local-override format from older builds.
 * If an imported recipe had already been edited, its edited sheet wins during
 * migration so upgrading cannot silently put the upstream values back.
 */
function legacyEditedInput(id: string): RecipeEditInput | null {
  const raw = getSetting('recipe_edits');
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as Record<string, { recipe?: unknown }>;
    const parsed = recipeEditSchema.safeParse(record[id]?.recipe);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
