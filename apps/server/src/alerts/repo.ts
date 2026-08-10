import type { Alert, AlertSeverity, AlertSource } from '@checklist/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { alerts } from '../db/schema.js';

/**
 * Persistence for the recorded alert history (see the `alerts` table). Kept
 * separate from the live, dashboard-derived feed: these rows survive restarts
 * and form the Alerts page's timeline.
 */

const nowIso = () => new Date().toISOString();

function toPublic(row: typeof alerts.$inferSelect): Alert {
  return {
    id: row.id,
    deviceId: row.deviceId,
    source: row.source as AlertSource,
    severity: row.severity as AlertSeverity,
    title: row.title,
    detail: row.detail,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    dismissedAt: row.dismissedAt,
  };
}

/** Insert a new alert row and return it. */
export function recordAlert(input: {
  source: AlertSource;
  severity: AlertSeverity;
  title: string;
  detail: string;
  deviceId?: number | null;
}): Alert {
  const row = db
    .insert(alerts)
    .values({
      deviceId: input.deviceId ?? null,
      source: input.source,
      severity: input.severity,
      title: input.title,
      detail: input.detail,
    })
    .returning()
    .get();
  return toPublic(row);
}

/**
 * The most recent alerts, newest first (capped; default 200). Dismissed alerts
 * are excluded — a user who clicks one away on the dashboard wants it gone from
 * the history page too.
 */
export function listAlerts(limit = 200): Alert[] {
  return db
    .select()
    .from(alerts)
    .where(isNull(alerts.dismissedAt))
    .orderBy(desc(alerts.createdAt), desc(alerts.id))
    .limit(limit)
    .all()
    .map(toPublic);
}

/**
 * Mark an alert dismissed (user clicked it away). It then drops out of every
 * feed but stays in the table, so {@link openOfflineAlert}'s dedup still sees it
 * and a device that's still offline doesn't immediately re-raise the same alert.
 * Returns false when no such (not-already-dismissed) alert exists.
 */
export function dismissAlert(id: number): boolean {
  const res = db
    .update(alerts)
    .set({ dismissedAt: nowIso() })
    .where(and(eq(alerts.id, id), isNull(alerts.dismissedAt)))
    .run();
  return res.changes > 0;
}

/**
 * Dismiss every alert still showing (the Alerts page's "Clear all"). Same
 * semantics as {@link dismissAlert}, applied in one statement so a long history
 * clears in a single round-trip; returns how many rows it closed.
 */
export function dismissAllAlerts(): number {
  const res = db
    .update(alerts)
    .set({ dismissedAt: nowIso() })
    .where(isNull(alerts.dismissedAt))
    .run();
  return res.changes;
}

/**
 * Narrows to one episode: a given source on a given device (or on no device at
 * all, for conditions that aren't tied to one). `deviceId: null` has to be an
 * `IS NULL` rather than an `= NULL`, which would match nothing.
 */
function episodeWhere(source: AlertSource, deviceId: number | null) {
  return and(
    deviceId == null ? isNull(alerts.deviceId) : eq(alerts.deviceId, deviceId),
    eq(alerts.source, source),
    isNull(alerts.resolvedAt),
  );
}

/**
 * The open (unresolved) alert of this kind for a device, if one exists — the
 * dedupe behind every episode source: a condition that persists (a device that
 * stays offline, a fridge that stays warm) raises a single alert, not one per
 * tick, and so buzzes the phones once.
 */
export function openAlert(source: AlertSource, deviceId: number | null): Alert | null {
  const row = db
    .select()
    .from(alerts)
    .where(episodeWhere(source, deviceId))
    .orderBy(desc(alerts.id))
    .get();
  return row ? toPublic(row) : null;
}

/**
 * Close any open alert of this kind for a device — the condition has ended (the
 * device reported again, the pressure recovered). Returns how many it closed, so
 * a caller can log a recovery only when there was something to recover from.
 */
export function resolveAlerts(source: AlertSource, deviceId: number | null): number {
  return db
    .update(alerts)
    .set({ resolvedAt: nowIso() })
    .where(episodeWhere(source, deviceId))
    .run().changes;
}
