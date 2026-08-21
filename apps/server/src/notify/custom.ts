import type {
  CustomAlertRule,
  CustomAlertSignal,
  CustomAlertTest,
  DeviceStatus,
} from '@checklist/shared';
import { RIG_POT_LABELS } from '@checklist/shared';
import type { FastifyBaseLogger } from 'fastify';
import { openAlert, recordAlert, resolveAlerts } from '../alerts/repo.js';
import { listEnabledAlertRules } from '../alerts/rules.js';
import { readBrewSystemState } from '../brewSystemClient.js';
import { listDeviceStatus } from '../devices/repo.js';
import { pushToEveryone } from './push.js';
import type { Verdict } from './signal.js';
import { CLEAR, MIN, UNKNOWN, history, latest, minutes, spans } from './signal.js';

/**
 * The rules the brewer wrote themselves — "tell me when the fermenter fridge is
 * over 25 °C", "tell me when the boil kettle reaches 100".
 *
 * These behave exactly like the built-in critical checks in critical.ts, and
 * for the same reasons: episodes rather than ticks (one alert when a condition
 * starts, resolved when it ends), real readings only, and a three-state
 * {@link Verdict} so a silent sensor leaves an open alert alone. What differs is
 * that the conditions are data rather than code, which forces two decisions the
 * built-in checks never had to make.
 *
 * **Symmetric confirmation instead of a hysteresis band.** The built-in checks
 * each carry a band sized to what they watch — a degree of temperature, a tenth
 * of a bar. A custom rule can watch anything the fleet reports, in any unit, so
 * there is no sensible band to pick. Instead a rule fires when its condition has
 * held for its whole hold window and clears when the *opposite* has held for the
 * same window. A reading dithering across the threshold fills neither window, so
 * it sits at `unknown` and the alert neither raises nor flaps — the same
 * protection, without having to guess the scale of the number.
 *
 * **The rig is polled, not stored.** The brewing rig is a separate Pi whose pot
 * temperatures never enter the readings table, so a rule watching one is judged
 * against {@link rigSamples} — a small in-memory history this module fills as it
 * ticks. It starts empty after a restart, which means a rule with a hold window
 * simply abstains until the window refills. That is the conservative answer, and
 * the same one {@link spans} gives for a device whose history is too short.
 */

/** Where a custom-rule push lands: the timeline of what the hub noticed. */
const ALERT_PATH = '/alerts';

/**
 * How much rig history to keep. The rig is polled once per tick (a minute by
 * default), so this covers a long brew day and costs a few hundred numbers.
 * Rules asking for a longer window than the buffer holds simply never confirm,
 * which is honest: the hub genuinely doesn't know what the kettle did yesterday.
 */
const RIG_BUFFER_SAMPLES = 1_000;

/** One poll of the rig's three pots, kept in the shape the span helpers want. */
interface RigSample {
  recordedAt: string;
  bk: number | null;
  mlt: number | null;
  hlt: number | null;
}

/**
 * The rig's recent temperatures, oldest first. Module-level and deliberately
 * not persisted: it is a cache of what the rig has been saying, and an empty one
 * after a restart is a true statement about what this process knows.
 */
const rigSamples: RigSample[] = [];

/** Test hook: forget the polled rig history, as a restart would. */
export function resetRigHistory(): void {
  rigSamples.length = 0;
}

/**
 * Poll the rig and remember what it said, if any rule is watching it. Returns
 * whether the rig answered — a rig that is off (the normal state between brew
 * sessions) is unknowable, not healthy, so its rules abstain rather than clear.
 */
async function sampleRig(rules: CustomAlertRule[]): Promise<boolean> {
  if (!rules.some((rule) => rule.signal.kind === 'rig')) return false;
  const state = await readBrewSystemState();
  if (!state) return false;
  rigSamples.push({
    recordedAt: new Date().toISOString(),
    bk: state.temperatures.bk,
    mlt: state.temperatures.mlt,
    hlt: state.temperatures.hlt,
  });
  if (rigSamples.length > RIG_BUFFER_SAMPLES) {
    rigSamples.splice(0, rigSamples.length - RIG_BUFFER_SAMPLES);
  }
  return true;
}

/**
 * Evaluate every enabled rule once. Safe to call on a timer; never throws.
 *
 * The rig is polled at most once per tick however many rules watch it, and not
 * at all when none does — a hub with no rig rules never reaches over the LAN.
 */
export async function runCustomRuleChecks(log: FastifyBaseLogger): Promise<void> {
  let rules: CustomAlertRule[];
  try {
    rules = listEnabledAlertRules();
  } catch (err) {
    log.error(err, 'custom alert rules could not be loaded');
    return;
  }
  if (rules.length === 0) return;

  let devices: DeviceStatus[];
  try {
    devices = listDeviceStatus();
  } catch (err) {
    log.error(err, 'custom alert rules failed to load devices');
    return;
  }
  const byId = new Map(devices.map((device) => [device.id, device]));

  const rigOnline = await sampleRig(rules);

  for (const rule of rules) {
    try {
      await settle(rule, evaluate(rule, byId, rigOnline), log);
    } catch (err) {
      log.error(err, `custom alert rule ${rule.id} (${rule.name}) failed`);
    }
  }
}

/**
 * Apply one rule's verdict to the alert history: raise (and push) on the edge
 * into the condition, resolve on the edge out of it, nothing in between.
 *
 * Every custom rule pushes as critical. A brewer writes one precisely because
 * they want to be interrupted by it — an alert about a boil that waits politely
 * on a page nobody is looking at has failed at the only job it had.
 */
async function settle(
  rule: CustomAlertRule,
  verdict: Verdict,
  log: FastifyBaseLogger,
): Promise<void> {
  const deviceId = rule.signal.kind === 'device' ? rule.signal.deviceId : null;
  const open = openAlert('custom', deviceId, rule.id);

  if (verdict.state === 'firing') {
    if (open) return; // already alerting on this episode
    recordAlert({
      deviceId,
      ruleId: rule.id,
      source: 'custom',
      severity: verdict.severity,
      title: verdict.title,
      detail: verdict.detail,
    });
    log.warn(`Custom alert: ${verdict.title} — ${verdict.detail}`);
    await pushToEveryone(
      {
        title: verdict.title,
        body: verdict.detail,
        path: ALERT_PATH,
        critical: true,
        // Per rule, so two rules firing together stay two notifications rather
        // than one replacing the other on the phone.
        collapseKey: `custom:${rule.id}`,
      },
      log,
    );
    return;
  }

  if (verdict.state === 'clear' && open) {
    resolveAlerts('custom', deviceId, rule.id);
    log.info(`Resolved custom alert “${rule.name}” — the condition has ended.`);
  }
}

// --- Evaluation -------------------------------------------------------------

/** One reading of whatever a rule watches, in the shape the span helpers want. */
interface Sample {
  recordedAt: string;
  value: number;
}

/**
 * Judge one rule against what its signal is currently doing. Returns `unknown`
 * — which changes nothing — whenever the signal can't be read at all: a device
 * that is offline or has never reported this metric, a rig that is powered off.
 */
function evaluate(
  rule: CustomAlertRule,
  devices: Map<number, DeviceStatus>,
  rigOnline: boolean,
): Verdict {
  const windowMs = rule.holdMinutes * MIN;
  const reading = read(rule.signal, devices, rigOnline, windowMs);
  if (!reading) return UNKNOWN;

  return rule.test.kind === 'flat'
    ? judgeFlat(rule, rule.test, reading)
    : judgeThreshold(rule, rule.test, reading);
}

/** The current value of a rule's signal and its recent history, or null. */
function read(
  signal: CustomAlertSignal,
  devices: Map<number, DeviceStatus>,
  rigOnline: boolean,
  windowMs: number,
): { current: number; samples: Sample[]; subject: string } | null {
  if (signal.kind === 'rig') {
    // A rig that didn't answer this tick tells us nothing about the kettle; the
    // buffer's last entry is however old the rig has been off.
    if (!rigOnline) return null;
    const samples = rigSamples
      .filter((s) => Date.parse(s.recordedAt) >= Date.now() - windowMs && s[signal.pot] != null)
      .map((s) => ({ recordedAt: s.recordedAt, value: s[signal.pot]! }));
    const newest = rigSamples[rigSamples.length - 1]?.[signal.pot];
    // The pot's own probe can drop out while the rig itself is answering.
    if (newest == null) return null;
    return { current: newest, samples, subject: RIG_POT_LABELS[signal.pot] };
  }

  const device = devices.get(signal.deviceId);
  // A rule pointed at a deleted device, or one that is offline: unknowable
  // rather than healthy, and the device-offline alert speaks for the silence.
  if (!device || !device.online) return null;
  const current = latest(device, signal.metric);
  if (current == null) return null;
  const samples = history(device.id, signal.metric, windowMs);
  return { current, samples, subject: `${device.name} ${metricWords(signal.metric)}` };
}

/**
 * A metric id as words for the alert text: `temp_c` → "temp", `hvac_state` →
 * "hvac state", `pressure_bar` → "pressure". The trailing unit is dropped
 * because the number beside it is already in that unit, and a rule's own name
 * is what carries the meaning of the reading.
 */
function metricWords(metric: string): string {
  const parts = metric.split('_');
  const withoutUnit = parts.length > 1 && UNIT_SUFFIXES.has(parts[parts.length - 1]!.toLowerCase())
    ? parts.slice(0, -1)
    : parts;
  return withoutUnit.join(' ');
}

/** Metric-name suffixes that name a unit rather than part of the reading. */
const UNIT_SUFFIXES: ReadonlySet<string> = new Set([
  'c', 'f', 'bar', 'psi', 'kwh', 'w', 'l', 'sg', 'pct', 'v', 'a', 'hpa', 'ppm',
]);

/**
 * The above / below / equals tests.
 *
 * With no hold window the latest reading decides, which is what a rule watching
 * for a moment — a kettle reaching boil — actually wants. With one, the
 * condition must hold across the whole window to fire and its opposite must
 * hold across the whole window to clear; anything else is `unknown`, so a
 * reading sitting on the threshold neither raises nor flaps.
 */
function judgeThreshold(
  rule: CustomAlertRule,
  test: Exclude<CustomAlertTest, { kind: 'flat' }>,
  reading: { current: number; samples: Sample[]; subject: string },
): Verdict {
  const holds = (value: number): boolean => {
    if (test.kind === 'above') return value >= test.value;
    if (test.kind === 'below') return value <= test.value;
    return value === test.value;
  };

  const windowMs = rule.holdMinutes * MIN;
  if (windowMs <= 0) {
    return holds(reading.current) ? firing(rule, describe(rule, test, reading)) : CLEAR;
  }

  const { samples } = reading;
  if (!spans(samples, windowMs)) return UNKNOWN; // too little history to judge
  if (samples.every((s) => holds(s.value))) return firing(rule, describe(rule, test, reading));
  if (samples.every((s) => !holds(s.value))) return CLEAR;
  return UNKNOWN; // crossed back and forth inside the window — no verdict
}

/**
 * The "hasn't moved" test: the spread across the whole window sits inside the
 * tolerance. The window is the test here, so there is no separate confirmation
 * — a full window that is still is the condition, and one that isn't, isn't.
 */
function judgeFlat(
  rule: CustomAlertRule,
  test: Extract<CustomAlertTest, { kind: 'flat' }>,
  reading: { current: number; samples: Sample[]; subject: string },
): Verdict {
  const windowMs = rule.holdMinutes * MIN;
  const { samples } = reading;
  if (!spans(samples, windowMs)) return UNKNOWN;
  const values = samples.map((s) => s.value);
  const spread = Math.max(...values) - Math.min(...values);
  if (spread > test.within) return CLEAR;
  return firing(
    rule,
    `${reading.subject} has held ${number(reading.current)} (within ${number(test.within)}) ` +
      `for ${minutes(windowMs)}.`,
  );
}

/** A firing verdict titled with the brewer's own words for the rule. */
function firing(rule: CustomAlertRule, detail: string): Verdict {
  // Always critical: see the note on settle().
  return { state: 'firing', severity: 'critical', title: rule.name, detail };
}

/** What the alert says happened, in the units the rule was written in. */
function describe(
  rule: CustomAlertRule,
  test: Exclude<CustomAlertTest, { kind: 'flat' }>,
  reading: { current: number; subject: string },
): string {
  const held = rule.holdMinutes > 0 ? ` for ${minutes(rule.holdMinutes * MIN)}` : '';
  const value = number(reading.current);
  if (test.kind === 'above') {
    return `${reading.subject} is ${value}${held}, at or above ${number(test.value)}.`;
  }
  if (test.kind === 'below') {
    return `${reading.subject} is ${value}${held}, at or below ${number(test.value)}.`;
  }
  return `${reading.subject} is ${value}${held}.`;
}

/**
 * A reading as text. A custom rule can watch anything the fleet reports — 100.4
 * degrees, 1.048 specific gravity, 0.05 bar — so the precision follows the size
 * of the number rather than assuming a unit the rule never named.
 */
function number(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const magnitude = Math.abs(value);
  if (magnitude >= 100) return value.toFixed(0);
  if (magnitude >= 1) return value.toFixed(1);
  return value.toFixed(3);
}
