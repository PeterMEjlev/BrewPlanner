import type { AuditEntry } from '@checklist/shared';
import { desc } from 'drizzle-orm';
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

/** The most recent changes, newest first (capped; default 200). */
export function listAudit(limit = 200): AuditEntry[] {
  return db
    .select()
    .from(auditLog)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit)
    .all()
    .map(toPublic);
}
