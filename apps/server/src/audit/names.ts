import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { checklists, steps, todos, users } from '../db/schema.js';
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

/** An account's username, or null if it's gone. */
export function accountName(id: string): string | null {
  return db.select({ username: users.username }).from(users).where(eq(users.id, num(id))).get()?.username ?? null;
}
