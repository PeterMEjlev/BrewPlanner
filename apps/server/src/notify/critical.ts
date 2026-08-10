import type {
  AlertSeverity,
  CriticalAlertSource,
  DeviceStatus,
  NotificationSettings,
  Reading,
} from '@checklist/shared';
import type { FastifyBaseLogger } from 'fastify';
import { openAlert, recordAlert, resolveAlerts } from '../alerts/repo.js';
import { sensorKeyFor } from '../devices/catalog.js';
import { getHistory, listDeviceStatus } from '../devices/repo.js';
import { pushToEveryone } from './push.js';

/**
 * The checks that watch for something going wrong in the brewery *right now* —
 * a fermenter that has lost its seal, a fridge that has stopped cooling, kegs
 * warming up — and interrupt whoever is carrying a phone.
 *
 * Three rules shape everything here.
 *
 * **Real readings only.** These read the raw device repository, not the
 * mock-aware fallback layer: a demo hub full of synthesized telemetry must never
 * raise an alarm, and a sensor left on the "mock" source is still alerted on
 * when it is genuinely reporting, because the raw repository is what the
 * hardware wrote.
 *
 * **Episodes, not ticks.** Every condition is a state, so each is raised once
 * when it starts and resolved when the readings come back — one buzz per real
 * event, however long the fridge stays broken. That is the whole reason each
 * check returns a three-state {@link Verdict} rather than a boolean: `unknown`
 * is what a check says when the sensor is offline, when there isn't enough
 * history yet, or when a reading is sitting inside the hysteresis band, and it
 * leaves an open alert open rather than flapping it shut.
 *
 * **Sustained, not instantaneous.** A single sample is a glitch; a condition
 * that holds for minutes is a fault. Each check has a confirmation window sized
 * to how fast the thing it watches actually moves — seconds for pressure, an
 * hour for a keg fridge whose door someone just opened.
 *
 * A check that throws never stops the others: failures are logged and retried on
 * the next tick.
 */

const MIN = 60_000;
const HOUR = 3_600_000;

// --- Tuning ----------------------------------------------------------------
// Timings and hysteresis bands, env-overridable for tuning without a redeploy.
// The *thresholds* live in NotificationSettings instead, because those are the
// numbers a brewer wants to change from the Settings page.

/** How long pressure must sit at zero before it counts as lost, not a blip. */
const PRESSURE_LOST_CONFIRM_MS = Number(process.env.ALERT_PRESSURE_CONFIRM_MIN ?? 15) * MIN;
/** How far back to look for the pressure that arms the "lost" check. */
const PRESSURE_ARM_WINDOW_MS = Number(process.env.ALERT_PRESSURE_ARM_HOURS ?? 48) * HOUR;
/** Bar the fermenter must have held to count as having been pressurised. */
const PRESSURE_ARM_BAR = Number(process.env.ALERT_PRESSURE_ARM_BAR ?? 0.2);
/** For how many of those hours, so a brief test pressurisation doesn't arm it. */
const PRESSURE_ARM_HOLD_HOURS = Number(process.env.ALERT_PRESSURE_ARM_HOLD_HOURS ?? 2);
/** Over-pressure is dangerous — confirm it quickly. */
const PRESSURE_HIGH_CONFIRM_MS = 5 * MIN;
/** Bar of recovery below the ceiling before over-pressure counts as over. */
const PRESSURE_HYSTERESIS_BAR = 0.1;

/** A fermenter chamber has thermal mass; ten minutes of hot is really hot. */
const FERMENTER_HOT_CONFIRM_MS = 10 * MIN;
/** An hour, so opening the keg fridge for a pour doesn't cry wolf. */
const KEGS_WARM_CONFIRM_MS = 60 * MIN;
/** The brewery cools slowly; half an hour is plenty of confirmation. */
const BREWERY_COLD_CONFIRM_MS = 30 * MIN;
/** °C of recovery past a temperature threshold before the episode is over. */
const TEMP_HYSTERESIS_C = 1;

/** How long the fermenter must fail to make progress before it counts as stalled. */
const STALL_WINDOW_MS = Number(process.env.ALERT_STALL_HOURS ?? 3) * HOUR;
/** °C the chamber may sit from brewery ambient and still count as "tracking the room". */
const STALL_AMBIENT_TOLERANCE_C = Number(process.env.ALERT_STALL_AMBIENT_C ?? 5);
/** °C ambient must be from the target before sitting at ambient means anything. */
const STALL_SETPOINT_MARGIN_C = Number(process.env.ALERT_STALL_SETPOINT_C ?? 5);
/** °C of movement toward the setpoint that counts as the fridge doing its job. */
const STALL_PROGRESS_C = 0.5;
/** Deadband the Inkbird idles within, mirroring the agent (see devices/mock.ts). */
const HVAC_DEADBAND_C = 0.3;

// --- Verdicts ---------------------------------------------------------------

/**
 * What one check concluded this tick. `unknown` deliberately does nothing: it
 * covers a silent sensor, a history too short to judge, and the hysteresis band
 * around a threshold — in all three the honest answer is "no new information",
 * which must not close an alert that is still open.
 */
type Verdict =
  | { state: 'firing'; severity: AlertSeverity; title: string; detail: string }
  | { state: 'clear' }
  | { state: 'unknown' };

const CLEAR: Verdict = { state: 'clear' };
const UNKNOWN: Verdict = { state: 'unknown' };

/** Where a critical push lands: the timeline of what the hub noticed. */
const ALERT_PATH = '/alerts';

// --- The tick ---------------------------------------------------------------

/**
 * Run every enabled critical check once. Safe to call on a timer; never throws.
 */
export async function runCriticalChecks(
  settings: NotificationSettings,
  log: FastifyBaseLogger,
): Promise<void> {
  let devices: DeviceStatus[];
  try {
    devices = listDeviceStatus();
  } catch (err) {
    log.error(err, 'critical alert checks failed to load devices');
    return;
  }

  const byKey = new Map<string, DeviceStatus>();
  for (const device of devices) {
    const key = sensorKeyFor(device);
    // First registered device wins a key. Two fermenter controllers is a
    // misconfiguration, not a supported fleet, and picking one beats alerting
    // on an arbitrary mixture of both.
    if (key && !byKey.has(key)) byKey.set(key, device);
  }

  const fermenterPressure = byKey.get('fermenter_pressure');
  const fermenter = byKey.get('fermenter_controller');
  const kegs = byKey.get('kegs_controller');
  const brewery = byKey.get('brewery_temp');

  await Promise.all([
    settle(
      'fermenter_pressure_lost',
      fermenterPressure,
      () => checkPressureLost(fermenterPressure!, settings),
      settings.pressureLostEnabled,
      log,
    ),
    settle(
      'fermenter_pressure_high',
      fermenterPressure,
      () => checkPressureHigh(fermenterPressure!, settings),
      settings.pressureHighEnabled,
      log,
    ),
    settle(
      'fermenter_hot',
      fermenter,
      () => checkFermenterHot(fermenter!, settings),
      settings.fermenterHotEnabled,
      log,
    ),
    settle(
      'fermenter_stalled',
      fermenter,
      () => checkFermenterStalled(fermenter!, brewery),
      settings.fermenterStalledEnabled,
      log,
    ),
    settle('kegs_warm', kegs, () => checkKegsWarm(kegs!, settings), settings.kegsWarmEnabled, log),
    settle(
      'brewery_cold',
      brewery,
      () => checkBreweryCold(brewery!, settings),
      settings.breweryColdEnabled,
      log,
    ),
  ]);
}

/**
 * Apply one check's verdict to the alert history: raise (and push) on the edge
 * into a condition, resolve on the edge out of it, and do nothing in between.
 *
 * A check that is switched off doesn't merely stop firing — it also resolves
 * whatever it left open, so turning an alert off in Settings clears the alert
 * rather than stranding it unresolved forever.
 */
async function settle(
  source: CriticalAlertSource,
  device: DeviceStatus | undefined,
  check: () => Verdict,
  enabled: boolean,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    // No such sensor in the fleet: nothing to judge, and nothing that could have
    // raised an alert against a device id that doesn't exist.
    if (!device) return;

    if (!enabled) {
      if (resolveAlerts(source, device.id) > 0) {
        log.info(`Resolved ${source} for device ${device.id} — the check was switched off.`);
      }
      return;
    }

    // An offline sensor is unknowable, not healthy: leave any open alert alone
    // and let the device-offline alert speak for the silence.
    if (!device.online) return;

    const verdict = check();
    const open = openAlert(source, device.id);

    if (verdict.state === 'firing') {
      if (open) return; // already alerting on this episode
      recordAlert({
        deviceId: device.id,
        source,
        severity: verdict.severity,
        title: verdict.title,
        detail: verdict.detail,
      });
      log.warn(`Critical alert: ${verdict.title} — ${verdict.detail}`);
      await pushToEveryone(
        { title: verdict.title, body: verdict.detail, path: ALERT_PATH, critical: true, collapseKey: source },
        log,
      );
      return;
    }

    if (verdict.state === 'clear' && open) {
      resolveAlerts(source, device.id);
      log.info(`Resolved ${source} for device ${device.id} — readings are back to normal.`);
    }
  } catch (err) {
    log.error(err, `critical alert check ${source} failed`);
  }
}

// --- Individual checks ------------------------------------------------------

/**
 * Pressure fell to nothing on a fermenter that *was* pressurised — a blown seal,
 * a knocked-off PRV, a spunding valve left open.
 *
 * The arming is the point. An empty or unpitched fermenter reads zero for weeks
 * at a time, so "pressure is zero" on its own would be a permanent false alarm.
 * The check therefore only fires when the recent history shows the vessel
 * genuinely held pressure for a few hours and has since dropped — self-arming,
 * with nothing for the brewer to remember to switch on.
 */
function checkPressureLost(device: DeviceStatus, settings: NotificationSettings): Verdict {
  const current = latest(device, 'pressure_bar');
  if (current == null) return UNKNOWN;

  // Recovered — and past the hysteresis band, so a reading hovering on the
  // threshold doesn't close and reopen the episode every few minutes.
  if (current > settings.pressureLostBar + PRESSURE_HYSTERESIS_BAR) return CLEAR;
  if (current > settings.pressureLostBar) return UNKNOWN;

  const recent = history(device.id, 'pressure_bar', PRESSURE_LOST_CONFIRM_MS);
  if (!sustained(recent, (r) => r.value <= settings.pressureLostBar, PRESSURE_LOST_CONFIRM_MS)) {
    return UNKNOWN; // too new to call — wait for the window to fill
  }

  const peak = armingPressure(device.id);
  // Never pressurised in the lookback window. That is an idle vessel, not a
  // fault — and `unknown` rather than `clear` so an alert raised while it *was*
  // armed isn't resolved days later simply because the evidence aged out.
  if (peak == null) return UNKNOWN;

  return {
    state: 'firing',
    severity: 'critical',
    title: 'Fermenter pressure lost',
    detail:
      `Pressure has been at ${pressure(current)} for ${minutes(PRESSURE_LOST_CONFIRM_MS)} ` +
      `after holding ${pressure(peak)}. Check the lid seal, the PRV and the spunding valve.`,
  };
}

/**
 * The pressure the fermenter held before it dropped, or null when it never held
 * any. Read as hourly buckets rather than raw samples: two days of 30-second
 * pushes is thousands of rows, and all this needs to know is how many hours sat
 * above the arming threshold.
 */
function armingPressure(deviceId: number): number | null {
  const hours = Math.max(1, Math.round(PRESSURE_ARM_WINDOW_MS / HOUR));
  const buckets = getHistory(deviceId, {
    metric: 'pressure_bar',
    since: new Date(Date.now() - PRESSURE_ARM_WINDOW_MS).toISOString(),
    buckets: hours,
  });
  const pressurised = buckets.filter((b) => b.value >= PRESSURE_ARM_BAR);
  if (pressurised.length < PRESSURE_ARM_HOLD_HOURS) return null;
  return Math.max(...pressurised.map((b) => b.max ?? b.value));
}

/** Pressure past the safe ceiling — a stuck spunding valve or a runaway ferment. */
function checkPressureHigh(device: DeviceStatus, settings: NotificationSettings): Verdict {
  const current = latest(device, 'pressure_bar');
  if (current == null) return UNKNOWN;
  if (current < settings.pressureHighBar - PRESSURE_HYSTERESIS_BAR) return CLEAR;
  if (current < settings.pressureHighBar) return UNKNOWN;

  const recent = history(device.id, 'pressure_bar', PRESSURE_HIGH_CONFIRM_MS);
  if (!sustained(recent, (r) => r.value >= settings.pressureHighBar, PRESSURE_HIGH_CONFIRM_MS)) {
    return UNKNOWN;
  }

  return {
    state: 'firing',
    severity: 'critical',
    title: 'Fermenter over-pressure',
    detail:
      `Pressure is ${pressure(current)}, past the ${pressure(settings.pressureHighBar)} limit. ` +
      `Check the spunding valve and vent the fermenter.`,
  };
}

/** The fermenter chamber running hot — usually a heat belt or pad stuck on. */
function checkFermenterHot(device: DeviceStatus, settings: NotificationSettings): Verdict {
  return temperatureCeiling(device, settings.fermenterHotC, FERMENTER_HOT_CONFIRM_MS, {
    severity: 'critical',
    title: 'Fermenter is overheating',
    advice: 'The heater may be stuck on — check it before the yeast throws off flavours.',
  });
}

/** The fridge holding the filled kegs losing its cool. */
function checkKegsWarm(device: DeviceStatus, settings: NotificationSettings): Verdict {
  return temperatureCeiling(device, settings.kegsWarmC, KEGS_WARM_CONFIRM_MS, {
    severity: 'warning',
    title: 'Keg fridge is warming up',
    advice: 'The beer is getting warm — check the fridge is running.',
  });
}

/** Shared shape of the two "too warm for this long" checks. */
function temperatureCeiling(
  device: DeviceStatus,
  limitC: number,
  confirmMs: number,
  copy: { severity: AlertSeverity; title: string; advice: string },
): Verdict {
  const current = latest(device, 'temp_c');
  if (current == null) return UNKNOWN;
  if (current < limitC - TEMP_HYSTERESIS_C) return CLEAR;
  if (current < limitC) return UNKNOWN;

  const recent = history(device.id, 'temp_c', confirmMs);
  if (!sustained(recent, (r) => r.value >= limitC, confirmMs)) return UNKNOWN;

  return {
    state: 'firing',
    severity: copy.severity,
    title: copy.title,
    detail:
      `${degrees(current)} for ${minutes(confirmMs)}, past the ${degrees(limitC)} limit. ` +
      copy.advice,
  };
}

/** The brewery itself dropping toward freezing, taps and lines included. */
function checkBreweryCold(device: DeviceStatus, settings: NotificationSettings): Verdict {
  const current = latest(device, 'temp_c');
  if (current == null) return UNKNOWN;
  if (current > settings.breweryColdC + TEMP_HYSTERESIS_C) return CLEAR;
  if (current > settings.breweryColdC) return UNKNOWN;

  const recent = history(device.id, 'temp_c', BREWERY_COLD_CONFIRM_MS);
  if (!sustained(recent, (r) => r.value <= settings.breweryColdC, BREWERY_COLD_CONFIRM_MS)) {
    return UNKNOWN;
  }

  return {
    state: 'firing',
    severity: 'warning',
    title: 'Brewery is close to freezing',
    detail:
      `${degrees(current)} for ${minutes(BREWERY_COLD_CONFIRM_MS)}, at or below the ` +
      `${degrees(settings.breweryColdC)} limit. Check the frost heater and anything holding water.`,
  };
}

/**
 * The controller is calling for heat or cooling, and nothing is happening: the
 * chamber has simply equilibrated with the brewery around it.
 *
 * That combination is what separates a dead fridge from a slow one. A working
 * fridge pulls the chamber *away* from the room; an unplugged one lets it drift
 * to whatever the room is, and stays there. Hence the three gates — demand, the
 * chamber sitting at ambient, and no progress toward the target over hours —
 * plus the one that stops it crying wolf: if the room already happens to be near
 * the target, sitting at room temperature proves nothing.
 *
 * `brewery` is the ambient reference. Without it there is nothing to compare
 * against, so the check abstains rather than guesses.
 */
function checkFermenterStalled(device: DeviceStatus, brewery: DeviceStatus | undefined): Verdict {
  const temp = latest(device, 'temp_c');
  const setpoint = latest(device, 'setpoint_c');
  if (temp == null || setpoint == null) return UNKNOWN;
  if (!brewery || !brewery.online) return UNKNOWN;
  const ambient = latest(brewery, 'temp_c');
  if (ambient == null) return UNKNOWN;

  // Is the controller actually asking for something? Prefer the relay state the
  // agent reads off the hardware; fall back to the setpoint gap when the
  // controller doesn't report one.
  const hvac = latest(device, 'hvac_state');
  const demanding = hvac != null ? hvac !== 0 : Math.abs(temp - setpoint) > HVAC_DEADBAND_C;
  if (!demanding) return CLEAR;

  // The room is already about where we want the beer, so a chamber sitting at
  // room temperature tells us nothing about whether the fridge works.
  if (Math.abs(ambient - setpoint) <= STALL_SETPOINT_MARGIN_C) return CLEAR;

  // The chamber has pulled away from the room — something is working.
  if (Math.abs(temp - ambient) > STALL_AMBIENT_TOLERANCE_C) return CLEAR;

  const temps = history(device.id, 'temp_c', STALL_WINDOW_MS);
  if (!spans(temps, STALL_WINDOW_MS)) return UNKNOWN; // not enough history yet

  // A setpoint moved during the window means the fridge has only just been given
  // this job; judging it on the hours before that would be unfair.
  const setpoints = history(device.id, 'setpoint_c', STALL_WINDOW_MS);
  if (setpoints.some((r) => Math.abs(r.value - setpoint) > 0.1)) return UNKNOWN;

  // Has it been at room temperature for the whole window, or only just arrived?
  if (temps.some((r) => Math.abs(r.value - ambient) > STALL_AMBIENT_TOLERANCE_C)) return CLEAR;

  // Movement toward the target counts as working, however slowly.
  const oldest = temps[0]!.value;
  const towardTarget = Math.sign(setpoint - temp) * (temp - oldest);
  if (towardTarget >= STALL_PROGRESS_C) return CLEAR;

  const wanted = hvac != null ? (hvac > 0 ? 'Heating' : 'Cooling') : 'Calling for temperature';
  return {
    state: 'firing',
    severity: 'critical',
    title: "Fermenter fridge isn't responding",
    detail:
      `${wanted} for ${hours(STALL_WINDOW_MS)} but the chamber is still ${degrees(temp)} — ` +
      `the same as the brewery (${degrees(ambient)}) and nowhere near the ${degrees(setpoint)} ` +
      `target. Check the fridge's power and the controller's sockets.`,
  };
}

// --- Reading helpers --------------------------------------------------------

/** The device's most recent value for a metric, or null if it has none. */
function latest(device: DeviceStatus, metric: string): number | null {
  const reading = device.latest.find((r) => r.metric === metric);
  return reading ? reading.value : null;
}

/** Raw readings for a metric over the last `windowMs`, oldest first. */
function history(deviceId: number, metric: string, windowMs: number): Reading[] {
  const rows = getHistory(deviceId, {
    metric,
    since: new Date(Date.now() - windowMs).toISOString(),
    // Newest-first with a cap would silently drop the *oldest* rows — exactly the
    // ones the span checks below depend on. Agents push at most every 30s, so
    // this covers a long window with room to spare.
    limit: 5000,
  });
  return rows.slice().reverse();
}

/** Whether the readings actually cover `windowMs` rather than a recent sliver. */
function spans(readings: Reading[], windowMs: number): boolean {
  if (readings.length < 2) return false;
  const oldest = Date.parse(readings[0]!.recordedAt);
  const newest = Date.parse(readings[readings.length - 1]!.recordedAt);
  if (!Number.isFinite(oldest) || !Number.isFinite(newest)) return false;
  // Allow a little slack: a 5-minute window sampled every 30s starts ~4m30s back.
  return newest - oldest >= windowMs * 0.8;
}

/** Whether every reading in a full window satisfies the predicate. */
function sustained(
  readings: Reading[],
  predicate: (r: Reading) => boolean,
  windowMs: number,
): boolean {
  return spans(readings, windowMs) && readings.every(predicate);
}

// --- Formatting -------------------------------------------------------------

/**
 * Pressure in both units. The hub stores bar and the phone shows whichever the
 * browser is set to, but a notification is plain text with no settings behind
 * it — so it carries both rather than guessing which one the reader thinks in.
 */
function pressure(bar: number): string {
  return `${bar.toFixed(2)} bar (${Math.round(bar * 14.5038)} psi)`;
}

function degrees(c: number): string {
  return `${c.toFixed(1)} °C`;
}

function minutes(ms: number): string {
  const m = Math.round(ms / MIN);
  return m >= 60 ? hours(ms) : `${m} min`;
}

function hours(ms: number): string {
  const h = ms / HOUR;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}
