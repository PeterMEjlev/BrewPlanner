import type {
  Device,
  DeviceCommand,
  DeviceStatus,
  DeviceType,
  LatestReading,
  Reading,
} from '@checklist/shared';
import { SET_SETPOINT_COMMAND } from '@checklist/shared';
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { deviceCommands, devices, readings } from '../db/schema.js';

/**
 * A device is considered online when its last push arrived within this window.
 * Sized for a ~30s push interval with a couple of misses tolerated; override
 * with DEVICE_ONLINE_WINDOW_SECONDS.
 */
const ONLINE_WINDOW_MS =
  Number(process.env.DEVICE_ONLINE_WINDOW_SECONDS ?? 90) * 1000;

const nowIso = () => new Date().toISOString();

// --- API keys ---------------------------------------------------------------

/** Mint a fresh, high-entropy device key. Shown to the operator exactly once. */
export function generateDeviceKey(): string {
  return `bp_${randomBytes(24).toString('base64url')}`;
}

/**
 * Hash a device key for storage/lookup. The key is random and high-entropy, so
 * a plain SHA-256 (no salt) is safe and — unlike a salted password hash — lets
 * us find the device by an indexed column on every push.
 */
export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Public device shape (never includes the key hash). */
function toPublic(row: typeof devices.$inferSelect): Device {
  return {
    id: row.id,
    name: row.name,
    type: row.type as DeviceType,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  };
}

// --- Device management ------------------------------------------------------

/**
 * Register a device and return it together with its plaintext key. The key is
 * not recoverable later — only its hash is stored — so the caller must surface
 * it to the operator immediately.
 */
export function createDevice(
  name: string,
  type: DeviceType,
): { device: Device; key: string } {
  const key = generateDeviceKey();
  const row = db
    .insert(devices)
    .values({ name, type, apiKeyHash: hashKey(key) })
    .returning()
    .get();
  return { device: toPublic(row), key };
}

/** Resolve a device by its plaintext API key (hashing internally). */
export function deviceByKey(key: string): Device | null {
  const row = db.select().from(devices).where(eq(devices.apiKeyHash, hashKey(key))).get();
  return row ? toPublic(row) : null;
}

/** Stamp the heartbeat. Called on every accepted push. */
export function touchLastSeen(id: number): void {
  db.update(devices).set({ lastSeenAt: nowIso() }).where(eq(devices.id, id)).run();
}

export function getDevice(id: number): Device | null {
  const row = db.select().from(devices).where(eq(devices.id, id)).get();
  return row ? toPublic(row) : null;
}

export function listDevices(): Device[] {
  return db.select().from(devices).orderBy(asc(devices.name)).all().map(toPublic);
}

/** Delete a device (and its readings, via cascade) by name. */
export function deleteDeviceByName(name: string): boolean {
  return db.delete(devices).where(eq(devices.name, name)).run().changes > 0;
}

/** Rotate a device's key by name, returning the new plaintext key. */
export function rotateKeyByName(name: string): string | null {
  const row = db.select().from(devices).where(eq(devices.name, name)).get();
  if (!row) return null;
  const key = generateDeviceKey();
  db.update(devices)
    .set({ apiKeyHash: hashKey(key), updatedAt: nowIso() })
    .where(eq(devices.id, row.id))
    .run();
  return key;
}

// --- Readings ---------------------------------------------------------------

/**
 * Append readings for a device. Every row gets an ISO-8601 `recordedAt` (the
 * sample's own timestamp, or the server receive time) so all timestamps share
 * one format and sort lexicographically — important for history queries.
 */
export function insertReadings(
  deviceId: number,
  samples: { metric: string; value: number; recordedAt?: string }[],
): void {
  if (samples.length === 0) return;
  const receivedAt = nowIso();
  db.insert(readings)
    .values(
      samples.map((s) => ({
        deviceId,
        metric: s.metric,
        value: s.value,
        recordedAt: s.recordedAt ?? receivedAt,
      })),
    )
    .run();
}

/** The most recent value for each metric a device has reported. */
function latestPerMetric(deviceId: number): LatestReading[] {
  // max(id) per metric is the newest inserted row for that metric.
  const ids = db
    .select({ maxId: sql<number>`max(${readings.id})` })
    .from(readings)
    .where(eq(readings.deviceId, deviceId))
    .groupBy(readings.metric)
    .all()
    .map((r) => r.maxId);
  if (ids.length === 0) return [];
  return db
    .select({ metric: readings.metric, value: readings.value, recordedAt: readings.recordedAt })
    .from(readings)
    .where(inArray(readings.id, ids))
    .orderBy(asc(readings.metric))
    .all();
}

function isOnline(lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - Date.parse(lastSeenAt) <= ONLINE_WINDOW_MS;
}

/** Devices enriched with online state + latest value per metric (dashboard). */
export function listDeviceStatus(): DeviceStatus[] {
  return listDevices().map((d) => ({
    ...d,
    online: isOnline(d.lastSeenAt),
    latest: latestPerMetric(d.id),
    pendingSetpointC: pendingSetpoint(d.id),
  }));
}

export function getDeviceStatus(id: number): DeviceStatus | null {
  const device = getDevice(id);
  if (!device) return null;
  return {
    ...device,
    online: isOnline(device.lastSeenAt),
    latest: latestPerMetric(id),
    pendingSetpointC: pendingSetpoint(id),
  };
}

/**
 * All-time consumption for a cumulative metric (`energy_kwh`, `water_l`): the
 * sum of positive step-to-step deltas across the whole history. Summing deltas
 * rather than taking last − first means a meter that resets to zero — as the
 * daily counters do at midnight — still totals correctly: each climb is counted
 * and the negative reset step is dropped. The first reading has no predecessor
 * (`prev` is NULL), so it isn't counted, i.e. the total is consumption observed
 * since this device started reporting.
 */
export function getMetricTotal(deviceId: number, metric: string): number {
  const row = db.get<{ total: number }>(sql`
    SELECT COALESCE(SUM(CASE WHEN value > prev THEN value - prev ELSE 0 END), 0) AS total
    FROM (
      SELECT value, LAG(value) OVER (ORDER BY recorded_at, id) AS prev
      FROM readings
      WHERE device_id = ${deviceId} AND metric = ${metric}
    )
  `);
  return Number(row?.total ?? 0);
}

/** History for a device, newest first, optionally filtered by metric/since. */
export function getHistory(
  deviceId: number,
  opts: { metric?: string; since?: string; limit?: number },
): Reading[] {
  const conds = [eq(readings.deviceId, deviceId)];
  if (opts.metric) conds.push(eq(readings.metric, opts.metric));
  if (opts.since) conds.push(gte(readings.recordedAt, opts.since));
  return db
    .select()
    .from(readings)
    .where(and(...conds))
    .orderBy(desc(readings.recordedAt))
    .limit(opts.limit ?? 1000)
    .all();
}

// --- Device commands (hub → device) -----------------------------------------

/** Build the public command shape from a row. */
function toCommand(row: typeof deviceCommands.$inferSelect): DeviceCommand {
  return {
    id: row.id,
    deviceId: row.deviceId,
    command: row.command,
    value: row.value,
    createdAt: row.createdAt,
  };
}

/**
 * The target of the device's outstanding setpoint change, or null when none is
 * pending. Surfaced on {@link DeviceStatus} so the dashboard can show "setting
 * to N°" until the controller confirms the new value.
 */
export function pendingSetpoint(deviceId: number): number | null {
  const row = db
    .select({ value: deviceCommands.value })
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, deviceId),
        eq(deviceCommands.command, SET_SETPOINT_COMMAND),
        eq(deviceCommands.status, 'pending'),
      ),
    )
    .orderBy(desc(deviceCommands.id))
    .get();
  return row ? row.value : null;
}

/**
 * Queue a new target setpoint for a device. Only the latest target matters, so
 * any existing pending setpoint command is dropped first ("last write wins") —
 * the device never has to reconcile a backlog of stale targets.
 */
export function queueSetpoint(deviceId: number, value: number): void {
  db.delete(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, deviceId),
        eq(deviceCommands.command, SET_SETPOINT_COMMAND),
        eq(deviceCommands.status, 'pending'),
      ),
    )
    .run();
  db.insert(deviceCommands)
    .values({ deviceId, command: SET_SETPOINT_COMMAND, value })
    .run();
}

/** The commands a device still needs to apply, oldest first. */
export function pendingCommands(deviceId: number): DeviceCommand[] {
  return db
    .select()
    .from(deviceCommands)
    .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.status, 'pending')))
    .orderBy(asc(deviceCommands.id))
    .all()
    .map(toCommand);
}

/**
 * Clear the commands a device reports it has applied. Scoped to the device's own
 * ids so one device can't ack another's queue; returns how many rows cleared.
 */
export function ackCommands(deviceId: number, ids: number[]): number {
  if (ids.length === 0) return 0;
  return db
    .delete(deviceCommands)
    .where(and(eq(deviceCommands.deviceId, deviceId), inArray(deviceCommands.id, ids)))
    .run().changes;
}
