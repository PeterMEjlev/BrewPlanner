import { randomUUID } from 'node:crypto';
import type {
  ActiveState,
  Checklist,
  ChecklistSummary,
  ChecklistWithSteps,
  DeviceDataSources,
  DisplayStep,
  FermenterState,
  GraphColors,
  KegContentColors,
  NotificationSettings,
  Recipe,
  RecipeDefaults,
  SaveWaterProfileInput,
  SavedWaterProfile,
  Step,
  Todo,
  TodoCategory,
} from '@checklist/shared';
import {
  DEFAULT_DEVICE_DATA_SOURCES,
  DEFAULT_GRAPH_COLORS,
  DEFAULT_KEG_CONTENT_COLORS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_RECIPE_DEFAULTS,
} from '@checklist/shared';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import {
  checklists,
  runSteps,
  runs,
  settings,
  steps,
  todoCategories,
  todos,
} from './db/schema.js';

const now = () => new Date().toISOString();

/** Normalize an optional description: blank/whitespace-only becomes null. */
const cleanDescription = (d: string | null): string | null => {
  const trimmed = d?.trim();
  return trimmed ? trimmed : null;
};

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------

export function listChecklists(): ChecklistSummary[] {
  const rows = db
    .select({
      id: checklists.id,
      name: checklists.name,
      isActive: checklists.isActive,
      createdAt: checklists.createdAt,
      updatedAt: checklists.updatedAt,
      stepCount: sql<number>`count(${steps.id})`,
    })
    .from(checklists)
    .leftJoin(steps, eq(steps.checklistId, checklists.id))
    .groupBy(checklists.id)
    .orderBy(asc(checklists.name))
    .all();
  return rows;
}

export function getChecklist(id: number): ChecklistWithSteps | null {
  const checklist = db.select().from(checklists).where(eq(checklists.id, id)).get();
  if (!checklist) return null;
  const checklistSteps = db
    .select()
    .from(steps)
    .where(eq(steps.checklistId, id))
    .orderBy(asc(steps.position))
    .all();
  return { ...checklist, steps: checklistSteps };
}

export function createChecklist(name: string): ChecklistWithSteps {
  const inserted = db.insert(checklists).values({ name }).returning().get();
  return { ...inserted, steps: [] };
}

export function updateChecklist(id: number, name: string): ChecklistWithSteps | null {
  const updated = db
    .update(checklists)
    .set({ name, updatedAt: now() })
    .where(eq(checklists.id, id))
    .returning()
    .get();
  if (!updated) return null;
  return getChecklist(id);
}

export function deleteChecklist(id: number): boolean {
  const res = db.delete(checklists).where(eq(checklists.id, id)).run();
  return res.changes > 0;
}

export function activateChecklist(id: number): ChecklistWithSteps | null {
  const target = db.select().from(checklists).where(eq(checklists.id, id)).get();
  if (!target) return null;
  db.transaction((tx) => {
    tx.update(checklists).set({ isActive: false, updatedAt: now() }).run();
    tx.update(checklists).set({ isActive: true, updatedAt: now() }).where(eq(checklists.id, id)).run();
  });
  return getChecklist(id);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export function addStep(checklistId: number, text: string, required: boolean): Step | null {
  const parent = db.select().from(checklists).where(eq(checklists.id, checklistId)).get();
  if (!parent) return null;
  const maxPos = db
    .select({ max: sql<number | null>`max(${steps.position})` })
    .from(steps)
    .where(eq(steps.checklistId, checklistId))
    .get();
  const position = (maxPos?.max ?? -1) + 1;
  const step = db
    .insert(steps)
    .values({ checklistId, text, required, position })
    .returning()
    .get();
  touchChecklist(checklistId);
  return step;
}

export function updateStep(
  id: number,
  fields: { text?: string; required?: boolean; description?: string | null },
): Step | null {
  const updated = db
    .update(steps)
    .set({
      ...(fields.text !== undefined ? { text: fields.text } : {}),
      ...(fields.required !== undefined ? { required: fields.required } : {}),
      ...(fields.description !== undefined
        ? { description: cleanDescription(fields.description) }
        : {}),
      updatedAt: now(),
    })
    .where(eq(steps.id, id))
    .returning()
    .get();
  if (updated) touchChecklist(updated.checklistId);
  return updated ?? null;
}

export function deleteStep(id: number): boolean {
  const existing = db.select().from(steps).where(eq(steps.id, id)).get();
  if (!existing) return false;
  db.delete(steps).where(eq(steps.id, id)).run();
  touchChecklist(existing.checklistId);
  return true;
}

/**
 * Reorder steps to match the given id order. Returns false if the provided ids
 * don't exactly match the checklist's current steps.
 */
export function reorderSteps(checklistId: number, stepIds: number[]): ChecklistWithSteps | null {
  const current = db
    .select({ id: steps.id })
    .from(steps)
    .where(eq(steps.checklistId, checklistId))
    .all();
  const currentIds = new Set(current.map((s) => s.id));
  const sameSize = current.length === stepIds.length;
  const sameMembers = stepIds.every((id) => currentIds.has(id));
  if (!sameSize || !sameMembers || new Set(stepIds).size !== stepIds.length) return null;

  db.transaction((tx) => {
    stepIds.forEach((id, index) => {
      tx.update(steps).set({ position: index, updatedAt: now() }).where(eq(steps.id, id)).run();
    });
  });
  touchChecklist(checklistId);
  return getChecklist(checklistId);
}

function touchChecklist(id: number): void {
  db.update(checklists).set({ updatedAt: now() }).where(eq(checklists.id, id)).run();
}

// ---------------------------------------------------------------------------
// Runs / progress
// ---------------------------------------------------------------------------

function getActiveChecklist(): Checklist | null {
  return db.select().from(checklists).where(eq(checklists.isActive, true)).get() ?? null;
}

function latestRunId(checklistId: number): number | null {
  const run = db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.checklistId, checklistId))
    .orderBy(desc(runs.id))
    .limit(1)
    .get();
  return run?.id ?? null;
}

/** Return the current run id for a checklist, creating one if none exists. */
function ensureRun(checklistId: number): number {
  const existing = latestRunId(checklistId);
  if (existing !== null) return existing;
  const run = db.insert(runs).values({ checklistId }).returning({ id: runs.id }).get();
  return run.id;
}

/** Build the full display/active payload for whichever checklist is active. */
export function getActiveState(): ActiveState {
  const checklist = getActiveChecklist();
  if (!checklist) {
    return { checklist: null, runId: null, steps: [], progress: { completed: 0, total: 0 } };
  }
  const runId = ensureRun(checklist.id);
  const checklistSteps = db
    .select()
    .from(steps)
    .where(eq(steps.checklistId, checklist.id))
    .orderBy(asc(steps.position))
    .all();

  const states = db.select().from(runSteps).where(eq(runSteps.runId, runId)).all();
  const stateByStep = new Map(states.map((s) => [s.stepId, s]));

  const displaySteps: DisplayStep[] = checklistSteps.map((step) => {
    const state = stateByStep.get(step.id);
    return { ...step, checked: state?.checked ?? false, checkedAt: state?.checkedAt ?? null };
  });

  const completed = displaySteps.filter((s) => s.checked).length;
  return {
    checklist,
    runId,
    steps: displaySteps,
    progress: { completed, total: displaySteps.length },
  };
}

/** Ensure a current run exists for the active checklist. */
export function startRun(): ActiveState | null {
  const checklist = getActiveChecklist();
  if (!checklist) return null;
  ensureRun(checklist.id);
  return getActiveState();
}

/** Start a brand-new run for the active checklist (resets all progress). */
export function resetRun(): ActiveState | null {
  const checklist = getActiveChecklist();
  if (!checklist) return null;
  db.insert(runs).values({ checklistId: checklist.id }).run();
  return getActiveState();
}

/** Toggle a single step's checked state within the current run. */
export function toggleStep(stepId: number): ActiveState | null {
  const checklist = getActiveChecklist();
  if (!checklist) return null;

  // The step must belong to the active checklist.
  const step = db.select().from(steps).where(eq(steps.id, stepId)).get();
  if (!step || step.checklistId !== checklist.id) return null;

  const runId = ensureRun(checklist.id);
  const existing = db
    .select()
    .from(runSteps)
    .where(and(eq(runSteps.runId, runId), eq(runSteps.stepId, stepId)))
    .get();

  if (existing) {
    const checked = !existing.checked;
    db.update(runSteps)
      .set({ checked, checkedAt: checked ? now() : null })
      .where(eq(runSteps.id, existing.id))
      .run();
  } else {
    db.insert(runSteps).values({ runId, stepId, checked: true, checkedAt: now() }).run();
  }
  return getActiveState();
}

// ---------------------------------------------------------------------------
// Brewery to-do list (standalone, not tied to checklists)
// ---------------------------------------------------------------------------

export function listTodos(): Todo[] {
  // Manual order (drag-to-reorder); id breaks ties for any legacy rows.
  return db.select().from(todos).orderBy(asc(todos.position), asc(todos.id)).all();
}

export function createTodo(text: string, categoryId: number | null = null): Todo {
  const maxPos = db
    .select({ max: sql<number | null>`max(${todos.position})` })
    .from(todos)
    .get();
  const position = (maxPos?.max ?? -1) + 1;
  return db.insert(todos).values({ text, position, categoryId }).returning().get();
}

// --- Categories ------------------------------------------------------------
// Sections on the To-Do page. Ordered by position like the tasks themselves so
// the page has a stable order to render; there is no reordering UI yet, so in
// practice that is creation order.

export function listTodoCategories(): TodoCategory[] {
  return db
    .select()
    .from(todoCategories)
    .orderBy(asc(todoCategories.position), asc(todoCategories.id))
    .all();
}

export function createTodoCategory(name: string): TodoCategory {
  const maxPos = db
    .select({ max: sql<number | null>`max(${todoCategories.position})` })
    .from(todoCategories)
    .get();
  const position = (maxPos?.max ?? -1) + 1;
  return db.insert(todoCategories).values({ name, position }).returning().get();
}

export function renameTodoCategory(id: number, name: string): TodoCategory | null {
  const updated = db
    .update(todoCategories)
    .set({ name, updatedAt: now() })
    .where(eq(todoCategories.id, id))
    .returning()
    .get();
  return updated ?? null;
}

/**
 * Delete a category. Its tasks are kept and fall back to "Uncategorised" —
 * the `set null` on todos.category_id does that, with `foreign_keys = ON`
 * (see db/index.ts) making the database honour it.
 */
export function deleteTodoCategory(id: number): boolean {
  return db.delete(todoCategories).where(eq(todoCategories.id, id)).run().changes > 0;
}

/** Reorder the whole to-do list to match the given id order. */
export function reorderTodos(todoIds: number[]): Todo[] | null {
  const current = db.select({ id: todos.id }).from(todos).all();
  const currentIds = new Set(current.map((t) => t.id));
  const sameSize = current.length === todoIds.length;
  const sameMembers = todoIds.every((id) => currentIds.has(id));
  if (!sameSize || !sameMembers || new Set(todoIds).size !== todoIds.length) return null;

  db.transaction((tx) => {
    todoIds.forEach((id, index) => {
      tx.update(todos).set({ position: index, updatedAt: now() }).where(eq(todos.id, id)).run();
    });
  });
  return listTodos();
}

export function updateTodo(
  id: number,
  fields: {
    text?: string;
    done?: boolean;
    description?: string | null;
    categoryId?: number | null;
  },
): Todo | null {
  const updated = db
    .update(todos)
    .set({
      ...(fields.text !== undefined ? { text: fields.text } : {}),
      ...(fields.description !== undefined
        ? { description: cleanDescription(fields.description) }
        : {}),
      ...(fields.categoryId !== undefined ? { categoryId: fields.categoryId } : {}),
      ...(fields.done !== undefined
        ? { done: fields.done, doneAt: fields.done ? now() : null }
        : {}),
      updatedAt: now(),
    })
    .where(eq(todos.id, id))
    .returning()
    .get();
  return updated ?? null;
}

export function deleteTodo(id: number): boolean {
  return db.delete(todos).where(eq(todos.id, id)).run().changes > 0;
}

export function clearCompletedTodos(): Todo[] {
  db.delete(todos).where(eq(todos.done, true)).run();
  return listTodos();
}

// ---------------------------------------------------------------------------
// App settings (key-value) + the active Brewer's Friend recipe
// ---------------------------------------------------------------------------

const ACTIVE_RECIPE_KEY = 'active_recipe';
const FERMENTER_STATE_KEY = 'fermenter_state';
const NOTIFY_SETTINGS_KEY = 'notify_settings';
const GRAPH_COLORS_KEY = 'graph_colors';
const KEG_CONTENT_COLORS_KEY = 'keg_content_colors';
const DEVICE_SOURCES_KEY = 'device_sources';
const RECIPE_DEFAULTS_KEY = 'recipe_defaults';
const WATER_PROFILES_KEY = 'water_profiles';

/** Upsert a key-value setting (exported for the notification dedup markers). */
export function setSetting(key: string, value: string): void {
  db.insert(settings)
    .values({ key, value, updatedAt: now() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now() } })
    .run();
}

/** Read a key-value setting, or null when unset. */
export function getSetting(key: string): string | null {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

/**
 * Notification preferences, merged over defaults so an older/partial stored blob
 * still yields every key. Returns the defaults when nothing is stored yet.
 */
export function getNotificationSettings(): NotificationSettings {
  const raw = getSetting(NOTIFY_SETTINGS_KEY);
  if (!raw) return DEFAULT_NOTIFICATION_SETTINGS;
  try {
    return { ...DEFAULT_NOTIFICATION_SETTINGS, ...(JSON.parse(raw) as Partial<NotificationSettings>) };
  } catch {
    return DEFAULT_NOTIFICATION_SETTINGS;
  }
}

export function setNotificationSettings(s: NotificationSettings): NotificationSettings {
  setSetting(NOTIFY_SETTINGS_KEY, JSON.stringify(s));
  return s;
}

/**
 * Chart line colours, merged over defaults so a partial/older stored blob still
 * yields every key. Shared by every screen (desktop + kiosk), edited from the
 * desktop Settings page.
 */
export function getGraphColors(): GraphColors {
  const raw = getSetting(GRAPH_COLORS_KEY);
  if (!raw) return DEFAULT_GRAPH_COLORS;
  try {
    return { ...DEFAULT_GRAPH_COLORS, ...(JSON.parse(raw) as Partial<GraphColors>) };
  } catch {
    return DEFAULT_GRAPH_COLORS;
  }
}

export function setGraphColors(c: GraphColors): GraphColors {
  setSetting(GRAPH_COLORS_KEY, JSON.stringify(c));
  return c;
}

/**
 * Keg content colours, merged over defaults so older/partial stored palettes
 * still yield every known beer/state key. Used by `/api/kegs` and edited from
 * the desktop Settings page.
 */
export function getKegContentColors(): KegContentColors {
  const raw = getSetting(KEG_CONTENT_COLORS_KEY);
  if (!raw) return DEFAULT_KEG_CONTENT_COLORS;
  try {
    return {
      ...DEFAULT_KEG_CONTENT_COLORS,
      ...(JSON.parse(raw) as Partial<KegContentColors>),
    };
  } catch {
    return DEFAULT_KEG_CONTENT_COLORS;
  }
}

export function setKegContentColors(c: KegContentColors): KegContentColors {
  setSetting(KEG_CONTENT_COLORS_KEY, JSON.stringify(c));
  return c;
}

/**
 * The figures a blank brew sheet opens on, merged over the brewery's own so a
 * partial or older stored blob still yields every key. Read by the new-recipe
 * page and edited from the desktop Settings page; shared by every screen,
 * because they describe the brewhouse rather than the browser.
 */
export function getRecipeDefaults(): RecipeDefaults {
  const raw = getSetting(RECIPE_DEFAULTS_KEY);
  if (!raw) return DEFAULT_RECIPE_DEFAULTS;
  try {
    return { ...DEFAULT_RECIPE_DEFAULTS, ...(JSON.parse(raw) as Partial<RecipeDefaults>) };
  } catch {
    return DEFAULT_RECIPE_DEFAULTS;
  }
}

export function setRecipeDefaults(d: RecipeDefaults): RecipeDefaults {
  setSetting(RECIPE_DEFAULTS_KEY, JSON.stringify(d));
  return d;
}

/**
 * The brewery's saved target water profiles, oldest first. Stored as one JSON
 * array under a single settings key rather than a table of its own: this is a
 * short hand-curated list read whole every time, with no foreign keys pointing
 * at it yet, so a table would buy nothing a blob doesn't already give.
 *
 * A malformed or missing blob reads as an empty library rather than throwing —
 * the water calculator works perfectly well with no saved profiles, and failing
 * the whole page over a bad settings row would be the worse outcome.
 */
export function getWaterProfiles(): SavedWaterProfile[] {
  const raw = getSetting(WATER_PROFILES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as SavedWaterProfile[]) : [];
  } catch {
    return [];
  }
}

/**
 * Add a profile, or replace the one already using that name. Upserting by name
 * is what a brewer means by saving over their own profile: they've tweaked
 * "House pale" and want one of it, not two. Comparison is case-insensitive and
 * trimmed, since "house pale" and "House Pale " are plainly the same profile.
 *
 * The whole updated list comes back so the caller doesn't need a second read to
 * refresh its picker.
 */
export function saveWaterProfile(input: SaveWaterProfileInput): SavedWaterProfile[] {
  const key = input.name.trim().toLowerCase();
  const existing = getWaterProfiles();
  const previous = existing.find((p) => p.name.trim().toLowerCase() === key);
  const saved: SavedWaterProfile = {
    ...input,
    name: input.name.trim(),
    // Keep the id and creation time across an overwrite: anything pointing at
    // this profile by id should follow the edit rather than dangle.
    id: previous?.id ?? randomUUID(),
    createdAt: previous?.createdAt ?? now(),
  };
  const next = previous
    ? existing.map((p) => (p.id === previous.id ? saved : p))
    : [...existing, saved];
  setSetting(WATER_PROFILES_KEY, JSON.stringify(next));
  return next;
}

/** Remove one saved profile by id. Returns the list as it now stands. */
export function deleteWaterProfile(id: string): SavedWaterProfile[] {
  const next = getWaterProfiles().filter((p) => p.id !== id);
  setSetting(WATER_PROFILES_KEY, JSON.stringify(next));
  return next;
}

/**
 * Per-sensor mock/real choices, merged over the all-mock defaults so an older or
 * partial stored blob still yields every known sensor key. Read by the device
 * fallback layer (which sensor shows synthesized mock data vs. its real agent's
 * readings) and edited from the Settings page; shared across every screen.
 */
export function getDeviceDataSources(): DeviceDataSources {
  const raw = getSetting(DEVICE_SOURCES_KEY);
  if (!raw) return DEFAULT_DEVICE_DATA_SOURCES;
  try {
    // Defaults first so every known sensor key is present; the stored blob (a
    // full or partial map) overrides. Cast as a full map — not Partial — so the
    // merged index signature stays `DeviceDataSource` (no `| undefined`).
    return { ...DEFAULT_DEVICE_DATA_SOURCES, ...(JSON.parse(raw) as DeviceDataSources) };
  } catch {
    return DEFAULT_DEVICE_DATA_SOURCES;
  }
}

export function setDeviceDataSources(s: DeviceDataSources): DeviceDataSources {
  setSetting(DEVICE_SOURCES_KEY, JSON.stringify(s));
  return s;
}

/** The recipe currently in the fermenter, or null if none has been chosen. */
export function getActiveRecipe(): Recipe | null {
  const raw = getSetting(ACTIVE_RECIPE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Recipe;
  } catch {
    // Corrupt/legacy value — treat as "nothing selected" rather than throwing.
    return null;
  }
}

export function setActiveRecipe(recipe: Recipe): Recipe {
  setSetting(ACTIVE_RECIPE_KEY, JSON.stringify(recipe));
  return recipe;
}

export function clearActiveRecipe(): void {
  db.delete(settings).where(eq(settings.key, ACTIVE_RECIPE_KEY)).run();
}

/**
 * Whether the fermenter has been washed since the last beer left it. Null when
 * nobody has said — a fresh install has no business claiming either, and neither
 * has clearing the recipe, which is why this isn't touched by the calls above.
 */
export function getFermenterState(): FermenterState | null {
  const raw = getSetting(FERMENTER_STATE_KEY);
  return raw === 'clean' || raw === 'dirty' ? raw : null;
}

export function setFermenterState(state: FermenterState): FermenterState {
  setSetting(FERMENTER_STATE_KEY, state);
  return state;
}
