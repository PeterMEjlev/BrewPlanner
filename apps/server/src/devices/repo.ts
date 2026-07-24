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
import { and, asc, desc, eq, gte, inArray, isNull, like, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { deviceCommands, devices, readings, settings } from '../db/schema.js';
import { getSetting } from '../repo.js';

/**
 * How many of a device's own reporting cycles it may miss before it's shown
 * offline. Online/offline is derived from the freshest *reading* (see
 * {@link isOnline}), so this is literally "how many consecutive readings the
 * sensor may drop before we flag a problem". Sized so a flaky poll — the
 * Inkbird's local Tuya read fails now and then — rides through a couple of
 * misses, while a controller that has genuinely stopped reporting goes offline.
 * Override with DEVICE_ONLINE_MISS_CYCLES.
 */
const ONLINE_MISS_CYCLES = Math.max(
  1,
  Number(process.env.DEVICE_ONLINE_MISS_CYCLES ?? 3),
);

/**
 * Floor for the online window (ms). The reporting interval is operator-settable
 * down to 5s, so the miss-cycle window alone could be as short as 15s and flap on
 * ordinary scheduling jitter; never let it fall below this. Kept under the name
 * DEVICE_ONLINE_WINDOW_SECONDS for back-compat with existing hub configs.
 */
const ONLINE_WINDOW_FLOOR_MS =
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
    lastIp: row.lastIp,
    mac: row.mac,
    reportingIntervalSec: row.reportingIntervalSec,
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

/**
 * Stamp the heartbeat. Called on every accepted push. When the caller knows the
 * client IP (the ingestion guard passes `req.ip`), it's recorded too so the
 * Devices page can show where each satellite is reaching the hub from. A missing
 * IP leaves the stored value untouched rather than nulling a known address.
 */
export function touchLastSeen(id: number, ip?: string | null): void {
  const patch: { lastSeenAt: string; lastIp?: string } = { lastSeenAt: nowIso() };
  if (ip) patch.lastIp = ip;
  db.update(devices).set(patch).where(eq(devices.id, id)).run();
}

/**
 * Record the MAC address a device reported on a push. Like {@link touchLastSeen}
 * this is heartbeat metadata, but the MAC rides in the ingest body (the
 * link-layer address never reaches the hub on its own), so it's stamped from the
 * ingest handler rather than the auth guard. The MAC is effectively static, so
 * the write is skipped unless the value actually changed — keeping the common
 * push a no-op.
 */
export function recordDeviceMac(id: number, mac: string): void {
  db.update(devices)
    .set({ mac })
    .where(and(eq(devices.id, id), or(isNull(devices.mac), ne(devices.mac, mac))))
    .run();
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
  const row = db.select({ id: devices.id }).from(devices).where(eq(devices.name, name)).get();
  if (!row) return false;
  db.delete(devices).where(eq(devices.id, row.id)).run();
  // Drop any total baselines the retention job stored for this device.
  db.delete(settings).where(like(settings.key, `metricTotalBase:${row.id}:%`)).run();
  readingCounts?.delete(row.id);
  return true;
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
 * Per-device stored-readings counts, kept in memory. The Devices page and nav
 * badge poll device status every few seconds, and a `count(*)` over a
 * years-long readings table per device per poll blocks the event loop
 * (better-sqlite3 is synchronous) and grows with the table. Seeded lazily with
 * one grouped query, incremented on every insert, dropped with the device, and
 * invalidated by the retention job after it prunes rows (next read re-seeds).
 */
let readingCounts: Map<number, number> | null = null;

function ensureReadingCounts(): Map<number, number> {
  readingCounts ??= new Map(
    db
      .select({ deviceId: readings.deviceId, n: sql<number>`count(*)` })
      .from(readings)
      .groupBy(readings.deviceId)
      .all()
      .map((r) => [r.deviceId, Number(r.n)] as const),
  );
  return readingCounts;
}

/** Drop the cached per-device reading counts; the next read re-seeds them. */
export function invalidateReadingCounts(): void {
  readingCounts = null;
}

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
  const counts = readingCounts;
  if (counts) counts.set(deviceId, (counts.get(deviceId) ?? 0) + samples.length);
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

/**
 * The most recent value per metric for *every* device at once — the batched
 * counterpart of {@link latestPerMetric}, so listing N devices costs two
 * queries instead of 2×N.
 */
function latestForAllDevices(): Map<number, LatestReading[]> {
  const byDevice = new Map<number, LatestReading[]>();
  const ids = db
    .select({ maxId: sql<number>`max(${readings.id})` })
    .from(readings)
    .groupBy(readings.deviceId, readings.metric)
    .all()
    .map((r) => r.maxId);
  if (ids.length === 0) return byDevice;
  const rows = db
    .select({
      deviceId: readings.deviceId,
      metric: readings.metric,
      value: readings.value,
      recordedAt: readings.recordedAt,
    })
    .from(readings)
    .where(inArray(readings.id, ids))
    .orderBy(asc(readings.metric))
    .all();
  for (const { deviceId, ...reading } of rows) {
    const list = byDevice.get(deviceId);
    if (list) list.push(reading);
    else byDevice.set(deviceId, [reading]);
  }
  return byDevice;
}

/** Epoch-ms of the most recent reading among `latest`, or null when there are none. */
function newestReadingMs(latest: LatestReading[]): number | null {
  let newest: number | null = null;
  for (const r of latest) {
    const t = Date.parse(r.recordedAt);
    if (!Number.isNaN(t) && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

/**
 * Whether a device is currently online.
 *
 * Online means "we've received an actual reading from this device within its
 * tolerance window" — {@link ONLINE_MISS_CYCLES} of the device's own reporting
 * interval, never shorter than {@link ONLINE_WINDOW_FLOOR_MS}. Deriving this from
 * the freshest *reading* rather than the last time the agent contacted the hub is
 * deliberate: an agent keeps chatting to the hub every cycle to poll for commands
 * even while its sensor read is failing, so a contact-based signal would show a
 * silent controller as online. Reading-freshness instead flips a controller
 * offline after a few genuinely missed reads — the real-problem signal we want —
 * while tolerating the odd dropped poll.
 *
 * A device that has contacted the hub but never produced a reading falls back to
 * `lastSeenAt`, so a brand-new or heartbeat-only device isn't wrongly greyed out.
 */
function isOnline(
  latest: LatestReading[],
  reportingIntervalSec: number,
  lastSeenAt: string | null,
): boolean {
  const windowMs = Math.max(
    ONLINE_WINDOW_FLOOR_MS,
    ONLINE_MISS_CYCLES * reportingIntervalSec * 1000,
  );
  const ref = newestReadingMs(latest) ?? (lastSeenAt ? Date.parse(lastSeenAt) : NaN);
  if (Number.isNaN(ref)) return false;
  return Date.now() - ref <= windowMs;
}

/** Stored readings for a device (all metrics), from the in-memory counts. */
function readingCount(deviceId: number): number {
  return ensureReadingCounts().get(deviceId) ?? 0;
}

/** Enrich a real device row with the live/derived fields the dashboards need. */
function enrich(device: Device): DeviceStatus {
  const latest = latestPerMetric(device.id);
  return {
    ...device,
    online: isOnline(latest, device.reportingIntervalSec, device.lastSeenAt),
    latest,
    readingCount: readingCount(device.id),
    pendingSetpointC: pendingSetpoint(device.id),
  };
}

/**
 * Update a device's logging cadence (seconds). Returns true when the device
 * exists. The new value is handed to the agent on its next push (the ingest
 * response) so its sample/push rate follows without a redeploy.
 */
export function setReportingInterval(id: number, seconds: number): boolean {
  return (
    db
      .update(devices)
      .set({ reportingIntervalSec: seconds, updatedAt: nowIso() })
      .where(eq(devices.id, id))
      .run().changes > 0
  );
}

/**
 * Devices enriched with online state + latest value per metric (dashboard).
 * This is the hot path — the nav badge and Devices page poll it every few
 * seconds from every open client — so everything is batched: one grouped
 * latest-readings query pair, one pending-setpoints query, and the in-memory
 * reading counts. Cost stays flat as devices and history grow.
 */
export function listDeviceStatus(): DeviceStatus[] {
  const latest = latestForAllDevices();
  const counts = ensureReadingCounts();
  const pending = pendingSetpointsForAll();
  return listDevices().map((device) => {
    const deviceLatest = latest.get(device.id) ?? [];
    return {
      ...device,
      online: isOnline(deviceLatest, device.reportingIntervalSec, device.lastSeenAt),
      latest: deviceLatest,
      readingCount: counts.get(device.id) ?? 0,
      pendingSetpointC: pending.get(device.id) ?? null,
    };
  });
}

export function getDeviceStatus(id: number): DeviceStatus | null {
  const device = getDevice(id);
  if (!device) return null;
  return enrich(device);
}

/** settings key holding the pruned-consumption baseline for one device+metric. */
export function metricTotalBaselineKey(deviceId: number, metric: string): string {
  return `metricTotalBase:${deviceId}:${metric}`;
}

/** The pruning baseline for a metric's all-time total (0 when never pruned). */
export function getMetricTotalBaseline(deviceId: number, metric: string): number {
  return Number(getSetting(metricTotalBaselineKey(deviceId, metric)) ?? 0);
}

/**
 * All-time consumption for a cumulative metric (`energy_kwh`, `water_l`): the
 * sum of positive step-to-step deltas across the whole history. Summing deltas
 * rather than taking last − first means a meter that resets to zero — as the
 * daily counters do at midnight — still totals correctly: each climb is counted
 * and the negative reset step is dropped. The first reading has no predecessor
 * (`prev` is NULL), so it isn't counted, i.e. the total is consumption observed
 * since this device started reporting.
 *
 * The retention job (devices/retention.ts) deletes raw rows past the retention
 * window, folding their consumption into a stored baseline first — added here
 * so the total keeps covering the device's whole reporting lifetime.
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
  return getMetricTotalBaseline(deviceId, metric) + Number(row?.total ?? 0);
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

/**
 * Recent readings for one metric across all devices, oldest first. Used by the
 * notification checker (e.g. the Tilt's `gravity_sg` history) where the relevant
 * device isn't known up front — just the metric.
 */
export function getRecentReadingsByMetric(metric: string, since: string): Reading[] {
  return db
    .select()
    .from(readings)
    .where(and(eq(readings.metric, metric), gte(readings.recordedAt, since)))
    .orderBy(asc(readings.recordedAt))
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
 * Newest pending setpoint target per device — the batched counterpart of
 * {@link pendingSetpoint} for {@link listDeviceStatus}. Rows come back in id
 * order, so the last write per device wins.
 */
function pendingSetpointsForAll(): Map<number, number> {
  const rows = db
    .select({ deviceId: deviceCommands.deviceId, value: deviceCommands.value })
    .from(deviceCommands)
    .where(
      and(eq(deviceCommands.command, SET_SETPOINT_COMMAND), eq(deviceCommands.status, 'pending')),
    )
    .orderBy(asc(deviceCommands.id))
    .all();
  const byDevice = new Map<number, number>();
  for (const row of rows) byDevice.set(row.deviceId, row.value);
  return byDevice;
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
