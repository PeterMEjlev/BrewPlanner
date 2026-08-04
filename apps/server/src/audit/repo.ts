import type { AuditEntry, AuditFilters, AuditQuery } from '@checklist/shared';
import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditLog } from '../db/schema.js';

/**
 * Persistence for the change history (see the `audit_log` table). The audit hook
 * appends one row per successful admin mutation; the History page reads them
 * back newest-first. Kept deliberately small — recording must never get in the
 * way of the request it's logging.
 */

function toPublic(row: typeof auditLog.$inferSelect): AuditEntry {
  return {
    id: row.id,
    userId: row.userId,
    username: row.username,
    action: row.action,
    entity: row.entity,
    method: row.method,
    path: row.path,
    createdAt: row.createdAt,
  };
}

/** Append one change-history entry and return it. */
export function recordAudit(input: {
  userId: number | null;
  username: string;
  action: string;
  entity: string | null;
  method: string;
  path: string;
}): AuditEntry {
  const row = db
    .insert(auditLog)
    .values({
      userId: input.userId,
      username: input.username,
      action: input.action,
      entity: input.entity,
      method: input.method,
      path: input.path,
    })
    .returning()
    .get();
  return toPublic(row);
}

/**
 * The most recent changes, newest first (capped; default 200), narrowed by any
 * of the History page's filters.
 *
 * The filters are applied in SQL rather than after the fact so the cap counts
 * matching rows: asking for one account's keg changes returns the newest 200 of
 * *those*, not however many of them happen to be in the newest 200 overall.
 */
export function listAudit(query: AuditQuery = {}): AuditEntry[] {
  const where = [
    query.since ? gte(auditLog.createdAt, query.since) : undefined,
    query.username ? eq(auditLog.username, query.username) : undefined,
    query.entity ? eq(auditLog.entity, query.entity) : undefined,
  ].filter((clause) => clause != null);

  return db
    .select()
    .from(auditLog)
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(query.limit ?? 200)
    .all()
    .map(toPublic);
}

/**
 * The accounts and categories the log actually contains, each sorted for a
 * stable dropdown. Deliberately unfiltered by the current selection: options
 * that disappear as you narrow make a filter bar impossible to back out of.
 */
export function auditFilters(): AuditFilters {
  const rows = db
    .selectDistinct({ username: auditLog.username, entity: auditLog.entity })
    .from(auditLog)
    .all();
  const usernames = new Set<string>();
  const entities = new Set<string>();
  for (const row of rows) {
    if (row.username) usernames.add(row.username);
    if (row.entity) entities.add(row.entity);
  }
  return {
    usernames: [...usernames].sort((a, b) => a.localeCompare(b)),
    entities: [...entities].sort((a, b) => a.localeCompare(b)),
  };
}
