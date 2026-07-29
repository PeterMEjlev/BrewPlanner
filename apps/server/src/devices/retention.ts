import type { FastifyBaseLogger } from 'fastify';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { readings } from '../db/schema.js';
import { setSetting } from '../repo.js';
import {
  getMetricTotalBaseline,
  invalidateMetricTotals,
  invalidateReadingCounts,
  metricTotalBaselineKey,
} from './repo.js';

/**
 * Readings retention. Raw samples arrive every few seconds and would otherwise
 * grow the SQLite file forever (~17k rows/day per metric at a 5s cadence) —
 * slowing every count/history query and wearing the Pi's SD card. A nightly
 * job deletes rows older than READINGS_RETENTION_DAYS (default 90; 0 disables).
 *
 * Pruning must not corrupt all-time consumption totals: `getMetricTotal` sums
 * positive step-to-step deltas over a metric's *whole* history, so deleting the
 * oldest rows would silently shrink the lifetime energy/water figures. Before
 * deleting, the consumption contained in the doomed rows — their internal
 * deltas plus the bridging delta to the first surviving row — is folded into a
 * per-(device, metric) baseline stored in `settings`, which `getMetricTotal`
 * adds back. The fold runs for every metric with prunable rows (a metric's
 * baseline is only meaningful if someone asks for its total, and storing a few
 * unused ones is harmless), so totals stay exact no matter which metrics gain
 * a total later.
 */

export const RETENTION_DAYS = Number(process.env.READINGS_RETENTION_DAYS ?? 90);

/** Sum of positive step-to-step deltas among rows older than `cutoff`. */
function prunedDeltaSum(deviceId: number, metric: string, cutoff: string): number {
  const row = db.get<{ total: number }>(sql`
    SELECT COALESCE(SUM(CASE WHEN value > prev THEN value - prev ELSE 0 END), 0) AS total
    FROM (
      SELECT value, LAG(value) OVER (ORDER BY recorded_at, id) AS prev
      FROM readings
      WHERE device_id = ${deviceId} AND metric = ${metric} AND recorded_at < ${cutoff}
    )
  `);
  return Number(row?.total ?? 0);
}

/**
 * The delta between the newest doomed row and the oldest surviving row — the
 * one step the post-prune history can no longer see (its LAG becomes NULL).
 */
function bridgeDelta(deviceId: number, metric: string, cutoff: string): number {
  const lastDeleted = db
    .select({ value: readings.value })
    .from(readings)
    .where(and(eq(readings.deviceId, deviceId), eq(readings.metric, metric), lt(readings.recordedAt, cutoff)))
    .orderBy(sql`recorded_at DESC, id DESC`)
    .limit(1)
    .get();
  const firstKept = db
    .select({ value: readings.value })
    .from(readings)
    .where(and(eq(readings.deviceId, deviceId), eq(readings.metric, metric), gte(readings.recordedAt, cutoff)))
    .orderBy(sql`recorded_at ASC, id ASC`)
    .limit(1)
    .get();
  if (!lastDeleted || !firstKept) return 0;
  return firstKept.value > lastDeleted.value ? firstKept.value - lastDeleted.value : 0;
}

/**
 * Delete readings older than the retention window, folding their consumption
 * into the total baselines first. Returns the number of rows removed.
 */
export function pruneOldReadings(log: FastifyBaseLogger): number {
  if (!(RETENTION_DAYS > 0)) return 0;
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();

  const deleted = db.transaction(() => {
    // Every (device, metric) pair that has rows about to be pruned.
    const pairs = db
      .selectDistinct({ deviceId: readings.deviceId, metric: readings.metric })
      .from(readings)
      .where(lt(readings.recordedAt, cutoff))
      .all();

    for (const { deviceId, metric } of pairs) {
      const pruned = prunedDeltaSum(deviceId, metric, cutoff) + bridgeDelta(deviceId, metric, cutoff);
      if (pruned > 0) {
        setSetting(
          metricTotalBaselineKey(deviceId, metric),
          String(getMetricTotalBaseline(deviceId, metric) + pruned),
        );
      }
    }

    return db.delete(readings).where(lt(readings.recordedAt, cutoff)).run().changes;
  });

  if (deleted > 0) {
    // The in-memory per-device counts just went stale; re-seed on next read.
    invalidateReadingCounts();
    // So did the running delta sums: the rows they were summed over are gone,
    // and their consumption now lives in the baselines set above. Re-seeding
    // sums only what survived, so the two stop double-counting.
    invalidateMetricTotals();
    // A big delete can leave the WAL file large; fold it back into the DB.
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    log.info(`Readings retention: pruned ${deleted} rows older than ${RETENTION_DAYS} days.`);
  }
  return deleted;
}
