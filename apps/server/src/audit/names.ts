import { eq } from 'drizzle-orm';
import { brewDayName } from '../brewDays/repo.js';
import { db } from '../db/index.js';
import { checklists, recipes, steps, todos, users } from '../db/schema.js';
import { getDevice } from '../devices/repo.js';

/**
 * Resolve the human-readable name of an audited subject from its id, so the
 * change history reads "Deleted checklist 'Brew Day'" rather than "...#1". Each
 * returns null when the row no longer exists (e.g. looked up too late), letting
 * the caller fall back to the id. Kept tiny and synchronous (better-sqlite3) so
 * the audit hook can call them inline without going async.
 */

const num = (id: string): number => Number(id);

/** A checklist's name, or null if it's gone. */
export function checklistName(id: string): string | null {
  return db.select({ name: checklists.name }).from(checklists).where(eq(checklists.id, num(id))).get()?.name ?? null;
}

/** A step's text, or null if it's gone. */
export function stepText(id: string): string | null {
  return db.select({ text: steps.text }).from(steps).where(eq(steps.id, num(id))).get()?.text ?? null;
}

/** A to-do's text, or null if it's gone. */
export function todoText(id: string): string | null {
  return db.select({ text: todos.text }).from(todos).where(eq(todos.id, num(id))).get()?.text ?? null;
}

/** A device's display name (the same one shown in the device fleet), or null. */
export function deviceName(id: string): string | null {
  return getDevice(num(id))?.name ?? null;
}

/**
 * A library recipe's name, straight off its stored sheet. Reads the JSON rather
 * than going through the recipe repo: an audit line needs the name, not a
 * hydrated brew sheet priced against the whole catalogue.
 */
export function recipeSheetName(id: string): string | null {
  const row = db.select({ recipe: recipes.recipe }).from(recipes).where(eq(recipes.id, id)).get();
  if (!row) return null;
  try {
    const name = (JSON.parse(row.recipe) as { name?: unknown }).name;
    return typeof name === 'string' && name ? name : null;
  } catch {
    return null;
  }
}

/** The recipe a brew day was logged for, or null if the entry is gone. */
export function brewDayRecipeName(id: string): string | null {
  return brewDayName(num(id));
}

/** An account's username, or null if it's gone. */
export function accountName(id: string): string | null {
  return db.select({ username: users.username }).from(users).where(eq(users.id, num(id))).get()?.username ?? null;
}
