import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

/**
 * The vertical change markers on the temperature charts are derived from the
 * controller's logged `setpoint_c` series rather than from any record of who
 * pressed what (see SetpointChange). The whole feature therefore rests on this
 * one query being right, and two of its edges are easy to get wrong in ways
 * that look plausible on screen: a windowed request must not report the first
 * reading in its window as a change, and it *must* still report a change that
 * happened between the last reading before the window and the first one inside
 * it.
 *
 * DATABASE_PATH must be set before the db module is imported, hence the dynamic
 * imports in `before`.
 */

const dir = mkdtempSync(join(tmpdir(), 'brewplanner-setpoint-'));
process.env.DATABASE_PATH = join(dir, 'test.sqlite');
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-be-accepted';
process.env.ADMIN_PASSWORD = 'test-admin-password';

let repo: typeof import('./devices/repo.js');
let app: FastifyInstance;
let sqlite: import('better-sqlite3').Database;

const MINUTE = 60 * 1000;
/** Fixed clock so windows in the tests are exact rather than "about now". */
const T0 = Date.parse('2026-03-01T00:00:00.000Z');

before(async () => {
  const db = await import('./db/index.js');
  db.runMigrations();
  sqlite = db.sqlite;
  repo = await import('./devices/repo.js');
  const { buildApp } = await import('./app.js');
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A controller logging `values` a minute apart from {@link T0}, oldest first. */
function controllerWith(name: string, values: number[]): number {
  const { device } = repo.createDevice(name, 'brew_controller');
  repo.insertReadings(
    device.id,
    values.map((value, i) => ({
      metric: 'setpoint_c',
      value,
      recordedAt: new Date(T0 + i * MINUTE).toISOString(),
    })),
  );
  return device.id;
}

const iso = (minute: number): string => new Date(T0 + minute * MINUTE).toISOString();

describe('getSetpointChanges', () => {
  it('finds nothing on a target that never moved', () => {
    const id = controllerWith('steady', [18, 18, 18, 18]);
    assert.deepEqual(repo.getSetpointChanges(id), []);
  });

  it('reports each step with the target it replaced, newest first', () => {
    const id = controllerWith('stepping', [18, 18, 20, 20, 20, 4]);
    assert.deepEqual(repo.getSetpointChanges(id), [
      { at: iso(5), from: 20, to: 4 },
      { at: iso(2), from: 18, to: 20 },
    ]);
  });

  it('does not call the first reading a change', () => {
    // Nothing precedes it, so there is no step to report — a chart that marked
    // it would put a line at the left edge of every window.
    const id = controllerWith('first', [18, 18, 18]);
    assert.deepEqual(repo.getSetpointChanges(id), []);
  });

  it('catches a step across the start of a window', () => {
    // The change is between minute 1 (still 18) and minute 2 (now 20); a window
    // opening at minute 2 has to reach back a row to see it.
    const id = controllerWith('crossing', [18, 18, 20, 20]);
    assert.deepEqual(repo.getSetpointChanges(id, { since: iso(2) }), [
      { at: iso(2), from: 18, to: 20 },
    ]);
  });

  it('excludes steps that happened before the window', () => {
    const id = controllerWith('earlier', [18, 20, 20, 20]);
    assert.deepEqual(repo.getSetpointChanges(id, { since: iso(2) }), []);
  });

  it('ignores float noise below a real dial step', () => {
    // The agent rounds to two decimals, so a controller reporting 18.001 has not
    // been touched — only the move to 18.5 has.
    const id = controllerWith('noisy', [18, 18.01, 17.99, 18.5]);
    assert.deepEqual(repo.getSetpointChanges(id), [{ at: iso(3), from: 17.99, to: 18.5 }]);
  });

  it('keeps the newest changes when limited', () => {
    const id = controllerWith('many', [1, 2, 3, 4, 5]);
    assert.deepEqual(repo.getSetpointChanges(id, { limit: 2 }), [
      { at: iso(4), from: 4, to: 5 },
      { at: iso(3), from: 3, to: 4 },
    ]);
  });

  it('reads only its own controller’s setpoints', () => {
    const id = controllerWith('mine', [18, 20]);
    const other = controllerWith('theirs', [5, 9]);
    assert.equal(repo.getSetpointChanges(other).length, 1);
    assert.deepEqual(repo.getSetpointChanges(id), [{ at: iso(1), from: 18, to: 20 }]);
  });

  it('ignores other metrics on the same device', () => {
    const id = controllerWith('mixed', [18, 18]);
    repo.insertReadings(id, [
      { metric: 'temp_c', value: 4, recordedAt: iso(0) },
      { metric: 'temp_c', value: 25, recordedAt: iso(1) },
    ]);
    assert.deepEqual(repo.getSetpointChanges(id), []);
  });
});

describe('GET /api/devices/:id/setpoint-changes', () => {
  /**
   * A controller reporting right now, so the fallback layer serves its own
   * readings. An offline `brew_controller` falls back to the fermenter mock
   * profile like everything else does (see devices/fallback.ts) — covered
   * below, since it is the difference between a chart drawing real markers and
   * drawing none.
   */
  function liveControllerWith(name: string, values: number[]): number {
    const { device } = repo.createDevice(name, 'brew_controller');
    const end = Date.now();
    repo.insertReadings(
      device.id,
      values.map((value, i) => ({
        metric: 'setpoint_c',
        value,
        recordedAt: new Date(end - (values.length - 1 - i) * 1000).toISOString(),
      })),
    );
    return device.id;
  }

  it('serves a live controller’s own changes to the LAN kiosk', async () => {
    const id = liveControllerWith('routed', [18, 18, 20]);
    const res = await app.inject({ url: `/api/devices/${id}/setpoint-changes` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { from: number; to: number }[];
    assert.equal(body.length, 1);
    assert.equal(body[0]!.from, 18);
    assert.equal(body[0]!.to, 20);
  });

  it('honours the window', async () => {
    const id = liveControllerWith('routed-window', [18, 20, 20]);
    const since = new Date(Date.now() + 60_000).toISOString();
    const res = await app.inject({
      url: `/api/devices/${id}/setpoint-changes?since=${encodeURIComponent(since)}`,
    });
    assert.deepEqual(res.json(), []);
  });

  it('answers from the mock for a controller served from mock data', async () => {
    // Its curve is synthesized too, so a real step out of a stale table would be
    // a marker on a line it never belonged to. What comes back is the mock
    // fermenter's own schedule (see devices/mock.ts) — the steps in the curve
    // the chart is actually drawing.
    const id = controllerWith('stale', [18, 20]);
    assert.ok(repo.getSetpointChanges(id).length > 0, 'the rows are there');
    const res = await app.inject({ url: `/api/devices/${id}/setpoint-changes` });
    const body = res.json() as { at: string }[];
    assert.equal(
      body.some((c) => c.at === iso(1)),
      false,
      'the stale table row must not surface',
    );
  });

  it('404s for a device that does not exist', async () => {
    const res = await app.inject({ url: '/api/devices/424242/setpoint-changes' });
    assert.equal(res.statusCode, 404);
  });

  it('rejects a malformed window rather than ignoring it', async () => {
    const id = liveControllerWith('routed-bad', [18, 20]);
    const res = await app.inject({ url: `/api/devices/${id}/setpoint-changes?since=yesterday` });
    assert.equal(res.statusCode, 400);
  });
});
