import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { AlertRuleInput } from '@checklist/shared';

/**
 * The alert rules a brewer writes for themselves (notify/custom.ts).
 *
 * The threshold arithmetic is not what's worth pinning down — it's four lines.
 * What decides whether these are trusted is the same set of judgements the
 * built-in checks are held to, plus the two this engine has to make because its
 * conditions are data rather than code:
 *
 * - **Episodes.** A kettle sits at boil for an hour. It must buzz the phone
 *   once, not once a minute, and clear itself when the kettle cools.
 * - **No flapping, without a unit to calibrate against.** A rule can watch
 *   °C, bar or specific gravity, so there is no fixed hysteresis band to pick.
 *   A reading dithering across the line must therefore fire nothing *and*
 *   resolve nothing — the symmetric hold window is what buys that.
 * - **Silence is not health.** An offline sensor, or a rig that is powered off
 *   between brew sessions, must leave an open alert exactly where it is.
 * - **One episode per rule, not per device.** Two rules watching the same
 *   fridge are two conditions; the second must not vanish into the first's
 *   dedup — which is the whole reason alerts carry a rule id.
 *
 * DATABASE_PATH must be set before the db module loads, hence dynamic imports.
 * No Firebase credentials are configured, so the push inside each raise is a
 * no-op — these assert the alert history, which is what push reads from.
 */

const dir = mkdtempSync(join(tmpdir(), 'brewplanner-custom-'));
process.env.DATABASE_PATH = join(dir, 'test.sqlite');
delete process.env.FCM_SERVICE_ACCOUNT_KEY;
delete process.env.FCM_SERVICE_ACCOUNT_KEY_FILE;

const MIN = 60_000;

let sqlite: import('better-sqlite3').Database;
let devices: typeof import('./devices/repo.js');
let alerts: typeof import('./alerts/repo.js');
let rules: typeof import('./alerts/rules.js');
let custom: typeof import('./notify/custom.js');

let fridgeId: number;

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

/** What the stubbed rig answers with, or null to play dead (powered off). */
let rigTemps: { bk: number | null; mlt: number | null; hlt: number | null } | null = null;
const realFetch = globalThis.fetch;

before(async () => {
  const db = await import('./db/index.js');
  db.runMigrations();
  sqlite = db.sqlite;
  devices = await import('./devices/repo.js');
  alerts = await import('./alerts/repo.js');
  rules = await import('./alerts/rules.js');
  custom = await import('./notify/custom.js');

  fridgeId = devices.createDevice('Fermenter', 'brew_controller').device.id;

  // Stand in for the brewing rig: a separate Pi the hub reaches over HTTP.
  process.env.BREW_SYSTEM_URL = 'http://rig.test';
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('http://rig.test')) return realFetch(input as RequestInfo);
    if (!rigTemps) throw new Error('rig is powered off');
    return new Response(
      JSON.stringify({
        temperatures: rigTemps,
        controlState: { pots: {}, pumps: {} },
        timer: {},
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.BREW_SYSTEM_URL;
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  sqlite.exec('DELETE FROM readings; DELETE FROM alerts; DELETE FROM alert_rules;');
  devices.invalidateReadingCounts();
  custom.resetRigHistory();
  rigTemps = null;
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
function flat(value: number, count = 10): number[] {
  return Array.from({ length: count }, () => value);
}

/** A shaped series — `count` readings, oldest first. */
function series(count: number, value: (i: number) => number): number[] {
  return Array.from({ length: count }, (_, i) => value(i));
}

/** A rule watching the fermenter's temperature, with sensible defaults. */
function fridgeRule(over: Partial<AlertRuleInput> = {}): AlertRuleInput {
  return {
    enabled: true,
    name: 'Fermenter fridge too warm',
    signal: { kind: 'device', deviceId: fridgeId, metric: 'temp_c' },
    test: { kind: 'above', value: 25 },
    holdMinutes: 0,
    ...over,
  };
}

const run = (): Promise<void> => custom.runCustomRuleChecks(noopLog);

/** Open (unresolved, undismissed) alerts raised by one rule. */
function open(ruleId: string): ReturnType<typeof alerts.listAlerts> {
  return alerts.listAlerts().filter((a) => a.ruleId === ruleId && a.resolvedAt == null);
}

describe('a threshold rule with no hold window', () => {
  it('fires the moment the reading crosses, and says what it saw', async () => {
    const rule = rules.createAlertRule(fridgeRule());
    log(fridgeId, 'temp_c', flat(26.4), 5 * MIN);
    await run();

    const raised = open(rule.id);
    assert.equal(raised.length, 1);
    assert.equal(raised[0]!.severity, 'critical');
    assert.equal(raised[0]!.deviceId, fridgeId);
    // The brewer's own words are the headline — that's what reaches the phone.
    assert.equal(raised[0]!.title, 'Fermenter fridge too warm');
    assert.match(raised[0]!.detail, /26\.4/);
    assert.match(raised[0]!.detail, /at or above 25/);
    // The metric is named, so "Fermenter is 26.4" can't be mistaken for the room.
    assert.match(raised[0]!.detail, /Fermenter temp/);
  });

  it('stays quiet below the line', async () => {
    const rule = rules.createAlertRule(fridgeRule());
    log(fridgeId, 'temp_c', flat(19), 5 * MIN);
    await run();
    assert.equal(open(rule.id).length, 0);
  });

  it('raises one alert however long the condition lasts, then clears itself', async () => {
    const rule = rules.createAlertRule(fridgeRule());
    log(fridgeId, 'temp_c', flat(26.4), 5 * MIN);
    await run();
    await run();
    await run();
    assert.equal(open(rule.id).length, 1, 'one episode, not one per tick');

    sqlite.exec('DELETE FROM readings');
    devices.invalidateReadingCounts();
    log(fridgeId, 'temp_c', flat(18), 5 * MIN);
    await run();
    assert.equal(open(rule.id).length, 0, 'resolved once the fridge caught up');

    // And the next crossing is a new episode, not a silent repeat of the old one.
    sqlite.exec('DELETE FROM readings');
    devices.invalidateReadingCounts();
    log(fridgeId, 'temp_c', flat(27), 5 * MIN);
    await run();
    assert.equal(open(rule.id).length, 1);
  });
});

describe('a threshold rule with a hold window', () => {
  it('waits for the condition to fill the window', async () => {
    const rule = rules.createAlertRule(fridgeRule({ holdMinutes: 30 }));

    // Hot, but only for the last couple of minutes: not yet a condition.
    log(fridgeId, 'temp_c', flat(26), 2 * MIN);
    await run();
    assert.equal(open(rule.id).length, 0, 'too little history to judge');

    sqlite.exec('DELETE FROM readings');
    devices.invalidateReadingCounts();
    log(fridgeId, 'temp_c', flat(26, 20), 35 * MIN);
    await run();
    assert.equal(open(rule.id).length, 1);
  });

  it('neither fires nor clears while a reading dithers across the line', async () => {
    const rule = rules.createAlertRule(fridgeRule({ holdMinutes: 30 }));
    // Sitting right on 25 and crossing back and forth — the case a hysteresis
    // band exists to absorb, and which this engine has no unit to size one in.
    log(fridgeId, 'temp_c', [24.9, 25.1, 24.8, 25.2, 24.9, 25.1, 24.9, 25.05], 35 * MIN);
    await run();
    assert.equal(open(rule.id).length, 0, 'never fired on a hovering reading');

    // Now genuinely hot, so an episode is open …
    sqlite.exec('DELETE FROM readings');
    devices.invalidateReadingCounts();
    log(fridgeId, 'temp_c', flat(27, 20), 35 * MIN);
    await run();
    assert.equal(open(rule.id).length, 1);

    // … and a reading that goes back to hovering must not close it either.
    sqlite.exec('DELETE FROM readings');
    devices.invalidateReadingCounts();
    log(fridgeId, 'temp_c', [24.9, 25.1, 24.8, 25.2, 24.9, 25.1, 24.9, 25.05], 35 * MIN);
    await run();
    assert.equal(open(rule.id).length, 1, 'an open episode survives an ambiguous window');
  });
});

describe('the “hasn’t moved” rule', () => {
  it('fires on a reading that has gone still, and clears when it moves again', async () => {
    const rule = rules.createAlertRule({
      enabled: true,
      name: 'Fermentation has stopped',
      signal: { kind: 'device', deviceId: fridgeId, metric: 'gravity_sg' },
      test: { kind: 'flat', within: 0.002 },
      holdMinutes: 120,
    });

    log(fridgeId, 'gravity_sg', series(14, (i) => 1.011 + (i % 3) * 0.0005), 130 * MIN);
    await run();
    assert.equal(open(rule.id).length, 1);
    assert.match(open(rule.id)[0]!.detail, /within 0\.002/);

    // Still dropping: not finished after all.
    sqlite.exec('DELETE FROM readings');
    devices.invalidateReadingCounts();
    log(fridgeId, 'gravity_sg', series(14, (i) => 1.04 - i * 0.002), 130 * MIN);
    await run();
    assert.equal(open(rule.id).length, 0);
  });

  it('abstains rather than calling a short history flat', async () => {
    const rule = rules.createAlertRule({
      enabled: true,
      name: 'Fermentation has stopped',
      signal: { kind: 'device', deviceId: fridgeId, metric: 'gravity_sg' },
      test: { kind: 'flat', within: 0.002 },
      holdMinutes: 120,
    });
    // Two identical readings a minute apart are not two hours of stillness.
    log(fridgeId, 'gravity_sg', [1.011, 1.011], 1 * MIN);
    await run();
    assert.equal(open(rule.id).length, 0);
  });
});

describe('an “is exactly” rule', () => {
  it('reads a tri-state metric, where above and below mean nothing', async () => {
    const rule = rules.createAlertRule({
      enabled: true,
      name: 'Fridge stuck heating',
      signal: { kind: 'device', deviceId: fridgeId, metric: 'hvac_state' },
      // +1 is heating (see devices/mock.ts).
      test: { kind: 'equals', value: 1 },
      holdMinutes: 60,
    });

    log(fridgeId, 'hvac_state', flat(1, 20), 90 * MIN);
    await run();
    assert.equal(open(rule.id).length, 1);

    sqlite.exec('DELETE FROM readings');
    devices.invalidateReadingCounts();
    log(fridgeId, 'hvac_state', flat(0, 20), 90 * MIN);
    await run();
    assert.equal(open(rule.id).length, 0);
  });
});

describe('the brewing rig', () => {
  it('fires when a pot reaches temperature', async () => {
    const rule = rules.createAlertRule({
      enabled: true,
      name: 'Boil kettle is at boil',
      signal: { kind: 'rig', pot: 'bk' },
      test: { kind: 'above', value: 100 },
      holdMinutes: 0,
    });

    rigTemps = { bk: 68, mlt: 66, hlt: 74 };
    await run();
    assert.equal(open(rule.id).length, 0, 'still mashing');

    rigTemps = { bk: 100.2, mlt: 40, hlt: 30 };
    await run();
    const raised = open(rule.id);
    assert.equal(raised.length, 1);
    // The rig is not a registered device, so the alert hangs off the rule alone.
    assert.equal(raised[0]!.deviceId, null);
    assert.equal(raised[0]!.ruleId, rule.id);
    assert.match(raised[0]!.detail, /Boil kettle/);
  });

  it('leaves an open alert alone once the rig is switched off', async () => {
    const rule = rules.createAlertRule({
      enabled: true,
      name: 'Boil kettle is at boil',
      signal: { kind: 'rig', pot: 'bk' },
      test: { kind: 'above', value: 100 },
      holdMinutes: 0,
    });

    rigTemps = { bk: 100.5, mlt: null, hlt: null };
    await run();
    assert.equal(open(rule.id).length, 1);

    // Powered down at the end of the brew day: unknowable, not "cooled off".
    rigTemps = null;
    await run();
    assert.equal(open(rule.id).length, 1);
  });

  it('never reaches for the rig when no rule watches it', async () => {
    rules.createAlertRule(fridgeRule());
    log(fridgeId, 'temp_c', flat(19), 5 * MIN);

    let asked = false;
    const stub = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input instanceof Request ? input.url : input).startsWith('http://rig.test')) {
        asked = true;
      }
      return stub(input as RequestInfo);
    }) as typeof fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = stub;
    }
    assert.equal(asked, false);
  });
});

describe('a silent sensor', () => {
  it('raises nothing, and leaves an open alert alone', async () => {
    const rule = rules.createAlertRule(fridgeRule());
    log(fridgeId, 'temp_c', flat(27), 5 * MIN);
    await run();
    assert.equal(open(rule.id).length, 1);

    // Last heard from two hours ago: the device-offline alert speaks for that,
    // and this rule must not conclude the fridge is fine.
    sqlite.exec('DELETE FROM readings');
    devices.invalidateReadingCounts();
    devices.insertReadings(fridgeId, [
      { metric: 'temp_c', value: 18, recordedAt: new Date(Date.now() - 120 * MIN).toISOString() },
    ]);
    await run();
    assert.equal(open(rule.id).length, 1);
  });
});

describe('rules as configuration', () => {
  it('gives every rule its own episode, even on the same sensor', async () => {
    const warm = rules.createAlertRule(fridgeRule({ name: 'Fridge warm', test: { kind: 'above', value: 25 } }));
    const hot = rules.createAlertRule(fridgeRule({ name: 'Fridge very hot', test: { kind: 'above', value: 30 } }));

    log(fridgeId, 'temp_c', flat(32), 5 * MIN);
    await run();

    assert.equal(open(warm.id).length, 1);
    assert.equal(open(hot.id).length, 1, 'the second rule is not swallowed by the first’s dedup');
  });

  it('ignores a disabled rule, and resolves what switching it off left open', async () => {
    const rule = rules.createAlertRule(fridgeRule());
    log(fridgeId, 'temp_c', flat(27), 5 * MIN);
    await run();
    assert.equal(open(rule.id).length, 1);

    rules.updateAlertRule(rule.id, { ...fridgeRule(), enabled: false });
    assert.equal(open(rule.id).length, 0, 'nothing is left alerting on a rule nobody is judging');

    await run();
    assert.equal(open(rule.id).length, 0, 'and it stays quiet while switched off');
  });

  it('resolves a deleted rule’s alert but keeps the record of it', async () => {
    const rule = rules.createAlertRule(fridgeRule());
    log(fridgeId, 'temp_c', flat(27), 5 * MIN);
    await run();

    assert.equal(rules.deleteAlertRule(rule.id), true);
    assert.equal(open(rule.id).length, 0);
    // The alert is history: it says what the brewery did while the rule existed.
    assert.equal(alerts.listAlerts().filter((a) => a.ruleId === rule.id).length, 1);
  });

  it('abstains on a rule pointed at a device that is gone', async () => {
    const rule = rules.createAlertRule(fridgeRule({ signal: { kind: 'device', deviceId: 9999, metric: 'temp_c' } }));
    await run();
    assert.equal(open(rule.id).length, 0);
  });
});
