import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * All-time consumption totals (`energy_kwh`, `water_l`) are the sum of positive
 * step-to-step deltas, so a meter that resets to zero at midnight still totals
 * correctly. The sum is served from an in-memory running cursor that folds in
 * only the rows appended since the last read — the point of these tests is that
 * "resumed" and "recomputed from scratch" never disagree, because drift there
 * would show up as a quietly wrong number on the dashboard, not as a crash.
 *
 * DATABASE_PATH must be set before the db module is imported, hence the dynamic
 * imports in `before`.
 */

const dir = mkdtempSync(join(tmpdir(), 'brewplanner-total-'));
process.env.DATABASE_PATH = join(dir, 'test.sqlite');
process.env.READINGS_RETENTION_DAYS = '30';

let repo: typeof import('./devices/repo.js');
let retention: typeof import('./devices/retention.js');
let sqlite: import('better-sqlite3').Database;

/** A silent stand-in for the Fastify logger the retention job expects. */
const noopLog = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => noopLog,
  level: 'silent',
} as unknown as import('fastify').FastifyBaseLogger;

const HOUR = 60 * 60 * 1000;

before(async () => {
  const db = await import('./db/index.js');
  db.runMigrations();
  sqlite = db.sqlite;
  repo = await import('./devices/repo.js');
  retention = await import('./devices/retention.js');
});

after(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A fresh device with `values` logged one hour apart, oldest first. */
function deviceWith(name: string, metric: string, values: number[]): number {
  const startMs = Date.now() - values.length * HOUR;
  const { device } = repo.createDevice(name, 'power_meter');
  repo.insertReadings(
    device.id,
    values.map((value, i) => ({
      metric,
      value,
      recordedAt: new Date(startMs + i * HOUR).toISOString(),
    })),
  );
  return device.id;
}

describe('getMetricTotal', () => {
  it('is zero for a device that has never reported', () => {
    const { device } = repo.createDevice('silent', 'power_meter');
    assert.equal(repo.getMetricTotal(device.id, 'energy_kwh'), 0);
  });

  it('sums the climb of a monotonic meter', () => {
    const id = deviceWith('climbing', 'energy_kwh', [10, 12, 15, 20]);
    // The first reading has no predecessor, so the total is consumption observed
    // *since* the device started reporting: 20 − 10.
    assert.ok(Math.abs(repo.getMetricTotal(id, 'energy_kwh') - 10) < 1e-9);
  });

  it('keeps counting across a meter reset', () => {
    // The daily counters zero at midnight; last − first would report 3 and the
    // dashboard would silently lose a day's consumption.
    const id = deviceWith('resetting', 'energy_kwh', [0, 5, 9, 0, 3]);
    assert.ok(Math.abs(repo.getMetricTotal(id, 'energy_kwh') - 12) < 1e-9);
  });

  it('matches a from-scratch scan after each new batch', () => {
    const id = deviceWith('incremental', 'water_l', [0, 4, 9]);
    let previous = repo.getMetricTotal(id, 'water_l'); // seeds the cursor
    assert.ok(Math.abs(previous - 9) < 1e-9);

    // Append in batches, reading the (now resumed) total after each, and compare
    // it against the same total recomputed with an empty cache.
    for (const batch of [[11, 14], [14, 0], [6, 6, 13]]) {
      const at = Date.now();
      repo.insertReadings(
        id,
        batch.map((value, i) => ({
          metric: 'water_l',
          value,
          recordedAt: new Date(at + i * 1000).toISOString(),
        })),
      );
      const resumed = repo.getMetricTotal(id, 'water_l');
      repo.invalidateMetricTotals();
      const rescanned = repo.getMetricTotal(id, 'water_l');
      assert.ok(
        Math.abs(resumed - rescanned) < 1e-9,
        `resumed ${resumed} != rescanned ${rescanned}`,
      );
      assert.ok(resumed >= previous, 'a total may never go backwards');
      previous = resumed;
    }
  });

  it('matches a from-scratch scan when a reading arrives out of order', () => {
    // A backfill lands with an older timestamp than the cursor. Resuming would
    // skip it, so the cache has to notice and fall back to a full scan.
    const id = deviceWith('backfilled', 'energy_kwh', [0, 10, 20]);
    assert.ok(Math.abs(repo.getMetricTotal(id, 'energy_kwh') - 20) < 1e-9);

    repo.insertReadings(id, [
      {
        metric: 'energy_kwh',
        value: 5,
        recordedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      },
    ]);
    const resumed = repo.getMetricTotal(id, 'energy_kwh');
    repo.invalidateMetricTotals();
    const rescanned = repo.getMetricTotal(id, 'energy_kwh');
    assert.ok(Math.abs(resumed - rescanned) < 1e-9, `resumed ${resumed} != rescanned ${rescanned}`);
  });

  it('keeps two metrics on one device apart', () => {
    const { device } = repo.createDevice('two-metric', 'power_meter');
    const base = Date.now() - 5 * HOUR;
    repo.insertReadings(device.id, [
      { metric: 'energy_kwh', value: 0, recordedAt: new Date(base).toISOString() },
      { metric: 'water_l', value: 100, recordedAt: new Date(base).toISOString() },
      { metric: 'energy_kwh', value: 7, recordedAt: new Date(base + HOUR).toISOString() },
      { metric: 'water_l', value: 140, recordedAt: new Date(base + HOUR).toISOString() },
    ]);
    assert.ok(Math.abs(repo.getMetricTotal(device.id, 'energy_kwh') - 7) < 1e-9);
    assert.ok(Math.abs(repo.getMetricTotal(device.id, 'water_l') - 40) < 1e-9);
  });
});

describe('readings retention', () => {
  it('preserves the all-time total across a prune', () => {
    // Half this history is older than the retention window. Pruning has to fold
    // its consumption into the stored baseline — including the delta bridging
    // the gap — or the lifetime figure would shrink overnight.
    const old = Date.now() - 60 * 24 * HOUR;
    const { device } = repo.createDevice('long-lived', 'power_meter');
    repo.insertReadings(device.id, [
      { metric: 'energy_kwh', value: 0, recordedAt: new Date(old).toISOString() },
      { metric: 'energy_kwh', value: 30, recordedAt: new Date(old + HOUR).toISOString() },
      { metric: 'energy_kwh', value: 50, recordedAt: new Date(Date.now() - 2 * HOUR).toISOString() },
      { metric: 'energy_kwh', value: 65, recordedAt: new Date(Date.now() - HOUR).toISOString() },
    ]);
    const before = repo.getMetricTotal(device.id, 'energy_kwh');
    assert.ok(Math.abs(before - 65) < 1e-9, `expected 65, got ${before}`);

    assert.ok(retention.pruneOldReadings(noopLog) > 0, 'expected rows to be pruned');
    const after = repo.getMetricTotal(device.id, 'energy_kwh');
    assert.ok(Math.abs(after - before) < 1e-9, `total changed across prune: ${before} → ${after}`);
  });
});
