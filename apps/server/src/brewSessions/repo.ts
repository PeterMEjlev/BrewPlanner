import type {
  BrewSession,
  BrewSessionDetail,
  BrewSessionRecipeSnapshot,
  BrewSessionRigSample,
  BrewSessionRigStats,
  BrewSessionStatus,
  BrewSessionTempStats,
  RecipeBrewCount,
  RecipeDetail,
  UpdateBrewSessionInput,
} from '@checklist/shared';
import { BREW_SESSION_STATUSES, extractPotential, isFermentableLine } from '@checklist/shared';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { brewSessionRigSamples, brewSessions } from '../db/schema.js';
import { fermentationSummary } from './telemetry.js';

/**
 * The brewery's logbook. One row per batch, written the moment the brewer says
 * they're brewing a recipe and edited from then until it's packaged.
 *
 * Everything here is synchronous (better-sqlite3), like the rest of the repos.
 */

type BrewSessionRow = typeof brewSessions.$inferSelect;

const now = (): string => new Date().toISOString();

/** Sum a recipe's weighed lines, rounded, or null when nothing carries a weight. */
function totalGrams(lines: { grams: number | null }[]): number | null {
  const weighed = lines.filter((line) => line.grams != null);
  if (weighed.length === 0) return null;
  return Math.round(weighed.reduce((sum, line) => sum + (line.grams ?? 0), 0) * 10) / 10;
}

/**
 * The recipe as it reads right now, frozen for the log. Deliberately the
 * hydrated detail rather than the stored sheet: the cost and the gram weights
 * are what the brewer is about to spend and weigh out, and both are worked out
 * from today's catalogue — a week later the same recipe would snapshot differently,
 * which is exactly why the figure has to be captured on the day.
 */
export function recipeSnapshot(recipe: RecipeDetail): BrewSessionRecipeSnapshot {
  const grainGrams = totalGrams(recipe.fermentables.filter(isFermentableLine));
  // The denominator the day's efficiency is measured against. Frozen with the
  // rest: it belongs to the bill that was mashed, not to whatever the recipe
  // says a year later.
  const potential = extractPotential(recipe.fermentables);
  return {
    name: recipe.name,
    style: recipe.style,
    og: recipe.og,
    fg: recipe.fg,
    abv: recipe.abv,
    ibu: recipe.ibu,
    ebc: recipe.ebc,
    batchSizeL: recipe.batchSizeL,
    mashTemp: recipe.mashTemp,
    fermentationTemp: recipe.fermentationTemp,
    costDkk: recipe.cost.priced > 0 ? recipe.cost.usedDkk : null,
    grainKg: grainGrams == null ? null : Math.round(grainGrams / 100) / 10,
    hopGrams: totalGrams(recipe.hops),
    yeast: recipe.yeast
      .map((line) => line.name.trim())
      .filter(Boolean)
      .join(', '),
    // Zero means "nothing here the mash has to work for", which is not a
    // denominator — store it as unknown so efficiency stays silent rather than
    // dividing by it.
    mashedPointGallons: potential.mashedPointGallons > 0 ? potential.mashedPointGallons : null,
    unmashedPointGallons: potential.unmashedPointGallons,
    preBoilUnmashedPointGallons: potential.preBoilUnmashedPointGallons,
  };
}

/**
 * Rebuild the snapshot a row was stored with. A row whose JSON no longer parses
 * still lists — with the little the columns themselves know — rather than taking
 * the whole logbook down with it.
 */
function rowSnapshot(row: BrewSessionRow): BrewSessionRecipeSnapshot {
  try {
    return JSON.parse(row.recipeSnapshot) as BrewSessionRecipeSnapshot;
  } catch {
    return {
      name: 'Unknown recipe',
      style: '',
      og: '',
      fg: '',
      abv: '',
      ibu: '',
      ebc: '',
      batchSizeL: null,
      mashTemp: null,
      fermentationTemp: null,
      costDkk: null,
      grainKg: null,
      hopGrams: null,
      yeast: '',
      mashedPointGallons: null,
      unmashedPointGallons: null,
      preBoilUnmashedPointGallons: null,
    };
  }
}

function rowStatus(value: string): BrewSessionStatus {
  return (BREW_SESSION_STATUSES as string[]).includes(value) ? (value as BrewSessionStatus) : 'brewing';
}

/**
 * Which brew of its recipe a row was: 1 for the first, 2 for the second. Counted
 * by brew date among the rows sharing a recipe id, so back-dating a forgotten
 * batch renumbers the ones after it rather than appending out of order.
 *
 * Rows whose recipe has since been deleted are all `recipeId === null`, and
 * counting those together would number unrelated batches as one series — so they
 * are simply numbered 1 apiece.
 */
function brewNumbers(): Map<number, number> {
  const rows = db
    .select({ id: brewSessions.id, recipeId: brewSessions.recipeId, brewedAt: brewSessions.brewedAt })
    .from(brewSessions)
    .orderBy(asc(brewSessions.brewedAt), asc(brewSessions.id))
    .all();
  const seen = new Map<string, number>();
  const numbers = new Map<number, number>();
  for (const row of rows) {
    if (row.recipeId == null) {
      numbers.set(row.id, 1);
      continue;
    }
    const next = (seen.get(row.recipeId) ?? 0) + 1;
    seen.set(row.recipeId, next);
    numbers.set(row.id, next);
  }
  return numbers;
}

function rowToBrewSession(row: BrewSessionRow, brewNumber: number): BrewSession {
  return {
    id: row.id,
    recipeId: row.recipeId,
    recipe: rowSnapshot(row),
    status: rowStatus(row.status),
    brewedAt: row.brewedAt,
    durationMinutes: row.durationMinutes,
    brewNumber,
    pitchedAt: row.pitchedAt,
    packagedAt: row.packagedAt,
    measured: {
      preBoilGravity: row.preBoilGravity,
      preBoilVolumeL: row.preBoilVolumeL,
      og: row.measuredOg,
      fg: row.measuredFg,
      volumeL: row.volumeL,
      mashTempC: row.mashTempC,
      boilTimeMin: row.boilTimeMin,
      efficiencyPct: row.efficiencyPct,
      waterL: row.waterL,
      energyKwh: row.energyKwh,
    },
    rating: row.rating,
    notes: row.notes,
    tastingNotes: row.tastingNotes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The whole log, newest brew session first. */
export function listBrewSessions(): BrewSession[] {
  const numbers = brewNumbers();
  return db
    .select()
    .from(brewSessions)
    .orderBy(desc(brewSessions.brewedAt), desc(brewSessions.id))
    .all()
    .map((row) => rowToBrewSession(row, numbers.get(row.id) ?? 1));
}

/** One brew session with its logged rig temperatures and derived fermentation figures. */
export function getBrewSession(id: number): BrewSessionDetail | null {
  const row = db.select().from(brewSessions).where(eq(brewSessions.id, id)).get();
  if (!row) return null;
  const brewSession = rowToBrewSession(row, brewNumbers().get(row.id) ?? 1);
  const rigSamples = listRigSamples(id);
  return {
    ...brewSession,
    rigSamples,
    rigStats: rigStats(rigSamples),
    // Derived on read rather than stored: the readings are the record, and the
    // window moves whenever the brewer corrects the pitch/package dates.
    fermentation: fermentationSummary(brewSession),
  };
}

/** The rig's pot temperatures logged for one brew session, oldest first. */
export function listRigSamples(brewSessionId: number): BrewSessionRigSample[] {
  return db
    .select({
      at: brewSessionRigSamples.recordedAt,
      bk: brewSessionRigSamples.bk,
      mlt: brewSessionRigSamples.mlt,
      hlt: brewSessionRigSamples.hlt,
    })
    .from(brewSessionRigSamples)
    .where(eq(brewSessionRigSamples.brewSessionId, brewSessionId))
    .orderBy(asc(brewSessionRigSamples.recordedAt))
    .all();
}

/** Min/mean/max over one pot's samples, or null when that pot logged nothing. */
export function tempStats(values: (number | null)[]): BrewSessionTempStats | null {
  const numbers = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (numbers.length === 0) return null;
  const sum = numbers.reduce((total, v) => total + v, 0);
  return {
    min: Math.min(...numbers),
    max: Math.max(...numbers),
    avg: Math.round((sum / numbers.length) * 10) / 10,
    count: numbers.length,
  };
}

function rigStats(samples: BrewSessionRigSample[]): BrewSessionRigStats {
  return {
    bk: tempStats(samples.map((s) => s.bk)),
    mlt: tempStats(samples.map((s) => s.mlt)),
    hlt: tempStats(samples.map((s) => s.hlt)),
  };
}

/**
 * Begin the log for a batch. `brewedAt` is the brew session itself and defaults to
 * now; passing one back-dates a brew that has already happened.
 */
export function startBrewSession(
  recipeId: string,
  recipe: RecipeDetail,
  brewedAt?: string,
): BrewSession {
  const timestamp = now();
  const result = db
    .insert(brewSessions)
    .values({
      recipeId,
      recipeSnapshot: JSON.stringify(recipeSnapshot(recipe)),
      status: 'brewing',
      brewedAt: brewedAt ?? timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  return getBrewSession(Number(result.lastInsertRowid))!;
}

/**
 * Apply an edit. Only the fields present in `input` are written, so the detail
 * page can save one figure at a time; the nullable ones accept null to clear a
 * measurement back to unmeasured rather than to zero.
 */
export function updateBrewSession(id: number, input: UpdateBrewSessionInput): BrewSession | null {
  const fields: Partial<typeof brewSessions.$inferInsert> = { updatedAt: now() };
  if (input.status !== undefined) fields.status = input.status;
  if (input.brewedAt !== undefined) fields.brewedAt = input.brewedAt;
  if (input.durationMinutes !== undefined) fields.durationMinutes = input.durationMinutes;
  if (input.pitchedAt !== undefined) fields.pitchedAt = input.pitchedAt;
  if (input.packagedAt !== undefined) fields.packagedAt = input.packagedAt;
  if (input.rating !== undefined) fields.rating = input.rating;
  if (input.notes !== undefined) fields.notes = input.notes;
  if (input.tastingNotes !== undefined) fields.tastingNotes = input.tastingNotes;
  const m = input.measured;
  if (m) {
    if (m.preBoilGravity !== undefined) fields.preBoilGravity = m.preBoilGravity;
    if (m.preBoilVolumeL !== undefined) fields.preBoilVolumeL = m.preBoilVolumeL;
    if (m.og !== undefined) fields.measuredOg = m.og;
    if (m.fg !== undefined) fields.measuredFg = m.fg;
    if (m.volumeL !== undefined) fields.volumeL = m.volumeL;
    if (m.mashTempC !== undefined) fields.mashTempC = m.mashTempC;
    if (m.boilTimeMin !== undefined) fields.boilTimeMin = m.boilTimeMin;
    if (m.efficiencyPct !== undefined) fields.efficiencyPct = m.efficiencyPct;
    if (m.waterL !== undefined) fields.waterL = m.waterL;
    if (m.energyKwh !== undefined) fields.energyKwh = m.energyKwh;
  }
  const result = db.update(brewSessions).set(fields).where(eq(brewSessions.id, id)).run();
  if (result.changes === 0) return null;
  const row = db.select().from(brewSessions).where(eq(brewSessions.id, id)).get()!;
  return rowToBrewSession(row, brewNumbers().get(row.id) ?? 1);
}

export function deleteBrewSession(id: number): boolean {
  return db.delete(brewSessions).where(eq(brewSessions.id, id)).run().changes > 0;
}

/** The name a brew session is referred to by in the change history. */
export function brewSessionName(id: number): string | null {
  const row = db
    .select({ snapshot: brewSessions.recipeSnapshot })
    .from(brewSessions)
    .where(eq(brewSessions.id, id))
    .get();
  if (!row) return null;
  try {
    return (JSON.parse(row.snapshot) as BrewSessionRecipeSnapshot).name || null;
  } catch {
    return null;
  }
}

/**
 * How many times each recipe has been brewed, and when last — the badge on the
 * recipe grid. One grouped query rather than a count per card.
 */
export function recipeBrewCounts(): RecipeBrewCount[] {
  return db
    .select({
      recipeId: brewSessions.recipeId,
      count: sql<number>`count(${brewSessions.id})`,
      lastBrewedAt: sql<string>`max(${brewSessions.brewedAt})`,
    })
    .from(brewSessions)
    .where(sql`${brewSessions.recipeId} is not null`)
    .groupBy(brewSessions.recipeId)
    .all()
    .map((row) => ({
      recipeId: row.recipeId ?? '',
      count: row.count,
      lastBrewedAt: row.lastBrewedAt,
    }));
}

/**
 * The brew sessions the sampler should be logging the rig for: everything still on
 * the brew session itself. Ordinarily none or one — the brewery has one rig — but
 * the query doesn't assume it, so a batch someone forgot to advance can't
 * silently swallow another one's samples.
 */
export function brewSessionsInProgress(): { id: number }[] {
  return db
    .select({ id: brewSessions.id })
    .from(brewSessions)
    .where(eq(brewSessions.status, 'brewing'))
    .orderBy(desc(brewSessions.brewedAt))
    .all();
}

/** Whether a brew session already holds a sample at this second (the sampler's dedup). */
export function hasRigSampleAt(brewSessionId: number, recordedAt: string): boolean {
  return (
    db
      .select({ id: brewSessionRigSamples.id })
      .from(brewSessionRigSamples)
      .where(
        and(
          eq(brewSessionRigSamples.brewSessionId, brewSessionId),
          eq(brewSessionRigSamples.recordedAt, recordedAt),
        ),
      )
      .get() != null
  );
}

/** Log one sweep of the rig's three pots against a brew session. */
export function insertRigSample(
  brewSessionId: number,
  sample: { recordedAt: string; bk: number | null; mlt: number | null; hlt: number | null },
): void {
  db.insert(brewSessionRigSamples).values({ brewSessionId, ...sample }).run();
}
