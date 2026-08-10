import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from '@checklist/shared';

/**
 * The critical telemetry alerts (notify/critical.ts) — the ones that interrupt
 * someone's evening.
 *
 * What is worth pinning here is not that a threshold comparison works, but the
 * three judgements that decide whether a brewer trusts these at all:
 *
 * - **Arming.** An empty fermenter reads zero pressure for weeks. "Pressure is
 *   zero" must therefore not be enough to alert; only zero *after* the vessel
 *   held pressure is a fault. Get this wrong and the alert is noise from day one.
 * - **Episodes.** A broken fridge stays broken. A condition must raise one alert
 *   and then stay quiet until it clears, or the phone buzzes every five minutes
 *   all night.
 * - **The stall rule's escape hatches.** "Cooling but sitting at room
 *   temperature" is only evidence of a dead fridge when the room isn't already
 *   near the target and the chamber isn't slowly getting there. Both exceptions
 *   are the difference between a useful alert and one that fires every autumn.
 *
 * DATABASE_PATH must be set before the db module loads, hence dynamic imports.
 * No Firebase credentials are configured, so the push inside each raise is a
 * no-op — these assert the alert history, which is what push reads from.
 */

const dir = mkdtempSync(join(tmpdir(), 'brewplanner-critical-'));
process.env.DATABASE_PATH = join(dir, 'test.sqlite');
delete process.env.FCM_SERVICE_ACCOUNT_KEY;
delete process.env.FCM_SERVICE_ACCOUNT_KEY_FILE;

const MIN = 60_000;
const HOUR = 60 * MIN;

let sqlite: import('better-sqlite3').Database;
let devices: typeof import('./devices/repo.js');
let alerts: typeof import('./alerts/repo.js');
let critical: typeof import('./notify/critical.js');

/** Device ids, registered once — the fleet these checks watch. */
let pressureId: number;
let fermenterId: number;
let breweryId: number;
let kegsId: number;

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

before(async () => {
  const db = await import('./db/index.js');
  db.runMigrations();
  sqlite = db.sqlite;
  devices = await import('./devices/repo.js');
  alerts = await import('./alerts/repo.js');
  critical = await import('./notify/critical.js');

  // The names matter: the fleet has no "which sensor is this" column, so the
  // (name, type) pair is what maps a device onto a planned sensor.
  pressureId = devices.createDevice('Fermenter', 'pressure_sensor').device.id;
  fermenterId = devices.createDevice('Fermenter', 'brew_controller').device.id;
  breweryId = devices.createDevice('Brewery', 'brew_controller').device.id;
  kegsId = devices.createDevice('Kegs', 'brew_controller').device.id;
});

after(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  sqlite.exec('DELETE FROM readings; DELETE FROM alerts;');
  devices.invalidateReadingCounts();
});

/**
 * Log `values` for one metric spread evenly over the last `windowMs`, oldest
 * first — so the newest lands on "now" and the device reads as online.
 */
function log(deviceId: number, metric: string, values: number[], windowMs: number): void {
  const now = Date.now();
  const step = values.length > 1 ? windowMs / (values.length - 1) : 0;
  devices.insertReadings(
    deviceId,
    values.map((value, i) => ({
      metric,
      value,
      recordedAt: new Date(now - windowMs + i * step).toISOString(),
    })),
  );
}

/** `count` copies of one value, for a metric that is meant to sit still. */
function flat(value: number, count = 8): number[] {
  return Array.from({ length: count }, () => value);
}

/** A fermenter that held 1.2 bar for most of the last two days. */
function pressurisedHistory(): void {
  const now = Date.now();
  devices.insertReadings(
    pressureId,
    Array.from({ length: 24 }, (_, i) => ({
      metric: 'pressure_bar',
      value: 1.2,
      // 40h ago through 2h ago, well inside the 48h arming window.
      recordedAt: new Date(now - 40 * HOUR + i * 1.6 * HOUR).toISOString(),
    })),
  );
}

async function run(overrides: Partial<NotificationSettings> = {}): Promise<void> {
  await critical.runCriticalChecks({ ...DEFAULT_NOTIFICATION_SETTINGS, ...overrides }, noopLog);
}

/** Open (unresolved, undismissed) alerts of one kind. */
function open(source: string): ReturnType<typeof alerts.listAlerts> {
  return alerts.listAlerts().filter((a) => a.source === source && a.resolvedAt == null);
}

describe('fermenter pressure lost', () => {
  it('stays quiet on a fermenter that was never pressurised', async () => {
    // An empty vessel: zero for hours, and zero right now.
    log(pressureId, 'pressure_bar', flat(0), 20 * MIN);
    await run();
    assert.equal(open('fermenter_pressure_lost').length, 0);
  });

  it('fires once pressure collapses on a fermenter that was holding it', async () => {
    pressurisedHistory();
    log(pressureId, 'pressure_bar', flat(0.01), 20 * MIN);
    await run();

    const raised = open('fermenter_pressure_lost');
    assert.equal(raised.length, 1);
    assert.equal(raised[0]!.deviceId, pressureId);
    assert.equal(raised[0]!.severity, 'critical');
    assert.match(raised[0]!.detail, /1\.20 bar/, 'says what it had been holding');
  });

  it('waits for the confirmation window rather than firing on one sample', async () => {
    pressurisedHistory();
    // Two minutes of zero — a sensor glitch looks exactly like this.
    log(pressureId, 'pressure_bar', flat(0), 2 * MIN);
    await run();
    assert.equal(open('fermenter_pressure_lost').length, 0);
  });

  it('raises one alert per episode, however long the fermenter stays flat', async () => {
    pressurisedHistory();
    log(pressureId, 'pressure_bar', flat(0), 20 * MIN);
    await run();
    await run();
    await run();
    assert.equal(open('fermenter_pressure_lost').length, 1);
  });

  it('resolves when pressure comes back', async () => {
    pressurisedHistory();
    log(pressureId, 'pressure_bar', flat(0), 20 * MIN);
    await run();
    assert.equal(open('fermenter_pressure_lost').length, 1);

    log(pressureId, 'pressure_bar', flat(0.9), 5 * MIN);
    await run();
    assert.equal(open('fermenter_pressure_lost').length, 0);
    const [alert] = alerts.listAlerts().filter((a) => a.source === 'fermenter_pressure_lost');
    assert.ok(alert?.resolvedAt, 'the episode is closed, not deleted');
  });

  it('resolves what it left open when the check is switched off', async () => {
    pressurisedHistory();
    log(pressureId, 'pressure_bar', flat(0), 20 * MIN);
    await run();
    assert.equal(open('fermenter_pressure_lost').length, 1);

    await run({ pressureLostEnabled: false });
    assert.equal(open('fermenter_pressure_lost').length, 0);
  });
});

describe('fermenter over-pressure', () => {
  it('fires above the ceiling and clears below it', async () => {
    log(pressureId, 'pressure_bar', flat(2.4), 10 * MIN);
    await run();
    const raised = open('fermenter_pressure_high');
    assert.equal(raised.length, 1);
    assert.match(raised[0]!.detail, /psi/, 'carries both units, since a push has no settings');

    log(pressureId, 'pressure_bar', flat(1.2), 10 * MIN);
    await run();
    assert.equal(open('fermenter_pressure_high').length, 0);
  });

  it('holds the episode open inside the hysteresis band', async () => {
    log(pressureId, 'pressure_bar', flat(2.4), 10 * MIN);
    await run();
    // Just under the limit but not clear of it: a reading hovering here must not
    // close and reopen the alert every tick.
    log(pressureId, 'pressure_bar', flat(1.95), 10 * MIN);
    await run();
    assert.equal(open('fermenter_pressure_high').length, 1);
  });
});

describe('temperature ceilings', () => {
  it('alerts on a fermenter chamber running hot', async () => {
    log(fermenterId, 'temp_c', flat(42), 20 * MIN);
    log(fermenterId, 'setpoint_c', flat(18), 20 * MIN);
    await run();
    const raised = open('fermenter_hot');
    assert.equal(raised.length, 1);
    assert.match(raised[0]!.detail, /42\.0 °C/);
  });

  it('alerts on a keg fridge that has been warm for an hour, not for a door opening', async () => {
    log(kegsId, 'temp_c', flat(15), 10 * MIN);
    await run();
    assert.equal(open('kegs_warm').length, 0, 'ten minutes is someone pouring a beer');

    log(kegsId, 'temp_c', flat(15), 90 * MIN);
    await run();
    assert.equal(open('kegs_warm').length, 1);
  });

  it('alerts on a brewery approaching freezing', async () => {
    log(breweryId, 'temp_c', flat(1), 45 * MIN);
    await run();
    assert.equal(open('brewery_cold').length, 1);
  });
});

describe('fermenter fridge not responding', () => {
  /** A controller cooling hard against `setpoint`, with the chamber at `temps`. */
  function coolingTowards(setpoint: number, temps: number[]): void {
    log(fermenterId, 'temp_c', temps, 4 * HOUR);
    log(fermenterId, 'setpoint_c', flat(setpoint), 4 * HOUR);
    log(fermenterId, 'hvac_state', flat(-1), 4 * HOUR);
  }

  it('fires when the chamber just sits at brewery temperature', async () => {
    log(breweryId, 'temp_c', flat(21.2), 4 * HOUR);
    coolingTowards(5, flat(21));
    await run();

    const raised = open('fermenter_stalled');
    assert.equal(raised.length, 1);
    assert.equal(raised[0]!.deviceId, fermenterId);
    assert.match(raised[0]!.detail, /Cooling/);
  });

  it('stays quiet when the brewery is already near the target', async () => {
    // Same standstill, but the room is where we want the beer — sitting at room
    // temperature proves nothing about the fridge.
    log(breweryId, 'temp_c', flat(21.2), 4 * HOUR);
    coolingTowards(20, flat(21));
    await run();
    assert.equal(open('fermenter_stalled').length, 0);
  });

  it('stays quiet while the chamber is still making progress', async () => {
    log(breweryId, 'temp_c', flat(21.2), 4 * HOUR);
    coolingTowards(5, [21, 20.6, 20.2, 19.8, 19.4, 19]);
    await run();
    assert.equal(open('fermenter_stalled').length, 0);
  });

  it('stays quiet when the controller is idle', async () => {
    log(breweryId, 'temp_c', flat(21.2), 4 * HOUR);
    log(fermenterId, 'temp_c', flat(21), 4 * HOUR);
    log(fermenterId, 'setpoint_c', flat(21), 4 * HOUR);
    log(fermenterId, 'hvac_state', flat(0), 4 * HOUR);
    await run();
    assert.equal(open('fermenter_stalled').length, 0);
  });

  it('abstains without an ambient reference to compare against', async () => {
    coolingTowards(5, flat(21));
    // No brewery readings at all: the check has nothing to judge "the same as
    // the room" against and must not guess.
    await run();
    assert.equal(open('fermenter_stalled').length, 0);
  });

  it('gives the fridge time after the setpoint moves', async () => {
    log(breweryId, 'temp_c', flat(21.2), 4 * HOUR);
    log(fermenterId, 'temp_c', flat(21), 4 * HOUR);
    log(fermenterId, 'hvac_state', flat(-1), 4 * HOUR);
    // Was holding at room temperature quite legitimately, and has only just been
    // asked to chill.
    log(fermenterId, 'setpoint_c', [21, 21, 21, 21, 5, 5], 4 * HOUR);
    await run();
    assert.equal(open('fermenter_stalled').length, 0);
  });
});

describe('a silent sensor', () => {
  it('raises nothing, and leaves an open alert alone', async () => {
    pressurisedHistory();
    log(pressureId, 'pressure_bar', flat(0), 20 * MIN);
    await run();
    assert.equal(open('fermenter_pressure_lost').length, 1);

    // The sensor stops reporting: the last reading ages past the online window.
    sqlite.exec(
      `UPDATE readings SET recorded_at = datetime('now', '-3 hours') WHERE device_id = ${pressureId}`,
    );
    await run();
    assert.equal(
      open('fermenter_pressure_lost').length,
      1,
      'silence is unknowable, not a recovery — the device-offline alert speaks for it',
    );
  });
});
