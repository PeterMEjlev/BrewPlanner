import type { User } from '@checklist/shared';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { hashPassword, verifyPassword } from './password.js';

/** Public user shape (never includes the password hash). */
function toPublic(row: { id: number; username: string; createdAt: string }): User {
  return { id: row.id, username: row.username, createdAt: row.createdAt };
}

export function countUsers(): number {
  const row = db.select({ n: sql<number>`count(*)` }).from(users).get();
  return row?.n ?? 0;
}

export function getUserById(id: number): User | null {
  const row = db.select().from(users).where(eq(users.id, id)).get();
  return row ? toPublic(row) : null;
}

/** Verify a username/password pair, returning the public user on success. */
export function authenticate(username: string, password: string): User | null {
  const row = db.select().from(users).where(eq(users.username, username)).get();
  if (!row) return null;
  if (!verifyPassword(password, row.passwordHash)) return null;
  return toPublic(row);
}

/** Verify a user's current password by id (for self-service account changes). */
export function verifyUserPassword(id: number, password: string): boolean {
  const row = db.select().from(users).where(eq(users.id, id)).get();
  return !!row && verifyPassword(password, row.passwordHash);
}

/** Set a new password for a user. Returns the public user, or null if missing. */
export function changeUserPassword(id: number, newPassword: string): User | null {
  const row = db
    .update(users)
    .set({ passwordHash: hashPassword(newPassword), updatedAt: new Date().toISOString() })
    .where(eq(users.id, id))
    .returning()
    .get();
  return row ? toPublic(row) : null;
}

/**
 * Rename a user. Returns the updated public user, null if the user is missing,
 * or 'taken' if another account already uses that (case-insensitive) username.
 */
export function renameUser(id: number, username: string): User | 'taken' | null {
  const clash = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(sql`lower(${users.username})`, username.toLowerCase()), ne(users.id, id)))
    .get();
  if (clash) return 'taken';
  const row = db
    .update(users)
    .set({ username, updatedAt: new Date().toISOString() })
    .where(eq(users.id, id))
    .returning()
    .get();
  return row ? toPublic(row) : null;
}

/** All usernames, for the CLI listing. */
export function listUsernames(): string[] {
  return db
    .select({ username: users.username })
    .from(users)
    .all()
    .map((r) => r.username);
}

/** Delete a user by username. Returns true if a row was removed. */
export function deleteUser(username: string): boolean {
  const res = db.delete(users).where(eq(users.username, username)).run();
  return res.changes > 0;
}

/** Create a user, or update the password if the username already exists. */
export function upsertUser(username: string, password: string): User {
  const passwordHash = hashPassword(password);
  const now = new Date().toISOString();
  const row = db
    .insert(users)
    .values({ username, passwordHash })
    .onConflictDoUpdate({
      target: users.username,
      set: { passwordHash, updatedAt: now },
    })
    .returning()
    .get();
  return toPublic(row);
}
