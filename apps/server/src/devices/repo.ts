import type {
  Device,
  DeviceStatus,
  DeviceType,
  LatestReading,
  Reading,
} from '@checklist/shared';
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { devices, readings } from '../db/schema.js';

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
  }));
}

export function getDeviceStatus(id: number): DeviceStatus | null {
  const device = getDevice(id);
  if (!device) return null;
  return { ...device, online: isOnline(device.lastSeenAt), latest: latestPerMetric(id) };
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
