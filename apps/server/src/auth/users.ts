import type { User, UserRole } from '@checklist/shared';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { hashPassword, verifyPassword } from './password.js';

/** Public user shape (never includes the password hash). */
function toPublic(row: {
  id: number;
  username: string;
  role: string;
  createdAt: string;
}): User {
  // `role` is a free-form text column at the DB level; every write goes through
  // the typed helpers below, so the stored value is always a valid UserRole.
  return { id: row.id, username: row.username, role: row.role as UserRole, createdAt: row.createdAt };
}

export function countUsers(): number {
  const row = db.select({ n: sql<number>`count(*)` }).from(users).get();
  return row?.n ?? 0;
}

/** How many accounts are admins — used to refuse removing/demoting the last one. */
export function countAdmins(): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(eq(users.role, 'admin'))
    .get();
  return row?.n ?? 0;
}

/** All accounts (public shape) in creation order — for the admin Accounts UI. */
export function listUsers(): User[] {
  return db.select().from(users).orderBy(users.id).all().map(toPublic);
}

export function getUserById(id: number): User | null {
  const row = db.select().from(users).where(eq(users.id, id)).get();
  return row ? toPublic(row) : null;
}

/**
 * Verify a username/password pair, returning the public user on success.
 * The username match is case-insensitive (creation already forbids
 * case-insensitive duplicates, so the lookup is unambiguous).
 */
export function authenticate(username: string, password: string): User | null {
  const row = db
    .select()
    .from(users)
    .where(eq(sql`lower(${users.username})`, username.toLowerCase()))
    .get();
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

/**
 * Create a new account. Returns the public user, or 'taken' if the
 * (case-insensitive) username already exists. Used by the admin Accounts UI,
 * which always supplies the role.
 */
export function createUser(username: string, password: string, role: UserRole): User | 'taken' {
  const clash = db
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.username})`, username.toLowerCase()))
    .get();
  if (clash) return 'taken';
  const row = db
    .insert(users)
    .values({ username, passwordHash: hashPassword(password), role })
    .returning()
    .get();
  return toPublic(row);
}

/** Change an account's role. Returns the updated public user, or null if missing. */
export function setUserRole(id: number, role: UserRole): User | null {
  const row = db
    .update(users)
    .set({ role, updatedAt: new Date().toISOString() })
    .where(eq(users.id, id))
    .returning()
    .get();
  return row ? toPublic(row) : null;
}

/** Delete an account by id (admin Accounts UI). Returns true if a row was removed. */
export function deleteUserById(id: number): boolean {
  const res = db.delete(users).where(eq(users.id, id)).run();
  return res.changes > 0;
}

/** Delete a user by username (CLI). Returns true if a row was removed. */
export function deleteUser(username: string): boolean {
  const res = db.delete(users).where(eq(users.username, username)).run();
  return res.changes > 0;
}

/**
 * Create a user, or update the password if the username already exists (CLI).
 * A new row defaults to `admin`; an existing row keeps its current role (only
 * the password is touched), so re-running to reset a password never silently
 * re-privileges a guest.
 */
export function upsertUser(username: string, password: string, role: UserRole = 'admin'): User {
  const passwordHash = hashPassword(password);
  const now = new Date().toISOString();
  const row = db
    .insert(users)
    .values({ username, passwordHash, role })
    .onConflictDoUpdate({
      target: users.username,
      set: { passwordHash, updatedAt: now },
    })
    .returning()
    .get();
  return toPublic(row);
}
