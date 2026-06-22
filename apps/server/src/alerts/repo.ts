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
 * The open (unresolved) offline alert for a device, if one exists — used to
 * dedupe so a device that stays offline raises a single alert, not one per tick.
 */
export function openOfflineAlert(deviceId: number): Alert | null {
  const row = db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.deviceId, deviceId),
        eq(alerts.source, 'device_offline'),
        isNull(alerts.resolvedAt),
      ),
    )
    .orderBy(desc(alerts.id))
    .get();
  return row ? toPublic(row) : null;
}

/** Close any open offline alerts for a device (it came back online). */
export function resolveOfflineAlerts(deviceId: number): void {
  db.update(alerts)
    .set({ resolvedAt: nowIso() })
    .where(
      and(
        eq(alerts.deviceId, deviceId),
        eq(alerts.source, 'device_offline'),
        isNull(alerts.resolvedAt),
      ),
    )
    .run();
}
