import type {
  Device,
  DeviceStatus,
  DeviceType,
  LatestReading,
  Reading,
  SetpointChange,
} from '@checklist/shared';

const MOCK_ID_BASE = 900_000;
const MOCK_DEVICE_AGE_DAYS = 21;
/** Stand-in push cadence for synthesized devices, matching the real ~30s agents. */
const MOCK_PUSH_INTERVAL_SEC = 30;
/** First three octets of the brewery LAN the mock satellites pretend to sit on. */
const MOCK_LAN_PREFIX = '192.168.0';

/** A stable, collision-free LAN address for a mock device, derived from its id. */
function mockIp(profile: MockProfile): string {
  return `${MOCK_LAN_PREFIX}.${100 + profile.id}`;
}

/**
 * A stable, believable MAC for a mock device, derived from its id. Uses the
 * Raspberry Pi Foundation OUI (b8:27:eb) so the demo fleet looks like the real
 * Pis the agents run on, mirroring how {@link mockIp} fakes a LAN address.
 */
function mockMac(profile: MockProfile): string {
  return `b8:27:eb:00:00:${profile.id.toString(16).padStart(2, '0')}`;
}

/**
 * A believable lifetime reading count for a mock device: ~30s pushes over its
 * age, one row per metric. Lets the Devices page show a non-zero "data points"
 * figure that's proportional to how chatty the sensor is.
 */
function mockReadingCount(profile: MockProfile): number {
  const pushesPerDay = (24 * 60 * 60) / MOCK_PUSH_INTERVAL_SEC;
  return Math.round(pushesPerDay * MOCK_DEVICE_AGE_DAYS * Object.keys(profile.base).length);
}

export interface MockProfile {
  id: number;
  /**
   * The {@link SensorCatalogEntry} key this profile maps to — the key under which
   * the operator's mock/real choice is stored. Keeps the per-sensor source toggle
   * in sync with the fleet without depending on (name, type) string matching.
   */
  key: string;
  name: string;
  type: DeviceType;
  base: Record<string, number>;
  /**
   * A controller whose cooling relay is unused (only heats) — e.g. the brewery
   * freeze-safety Inkbird, which warms the room if it drops near freezing but has
   * nothing wired to its cooling socket. Its hvac_state is heating or idle, never
   * cooling, even when the temperature sits above the setpoint.
   */
  heatOnly?: boolean;
}

export const MOCK_PROFILES: readonly MockProfile[] = [
  {
    id: 1,
    key: 'fermenter_pressure',
    name: 'Fermenter',
    type: 'pressure_sensor',
    base: { pressure_bar: 1.18 },
  },
  {
    id: 2,
    key: 'fermenter_controller',
    name: 'Fermenter',
    type: 'brew_controller',
    base: { temp_c: 18.4, setpoint_c: 18.0, hvac_state: -1 },
  },
  {
    // Heat-only freeze-safety Inkbird: warms the brewery if it drops toward
    // freezing, otherwise idle. Sits well above its low setpoint day-to-day, so
    // it reads idle — never cooling (nothing is wired to its cooling socket).
    id: 3,
    key: 'brewery_temp',
    name: 'Brewery',
    type: 'brew_controller',
    base: { temp_c: 21.3, setpoint_c: 6.0, hvac_state: 0 },
    heatOnly: true,
  },
  {
    // Inkbird in the second fridge that holds the filled kegs — kept at cold
    // serving temperature, so it sits actively cooling against a low setpoint.
    id: 7,
    key: 'kegs_controller',
    name: 'Kegs',
    type: 'brew_controller',
    base: { temp_c: 4.1, setpoint_c: 3.5, hvac_state: -1 },
  },
  {
    id: 4,
    key: 'power',
    name: 'Power',
    type: 'power_meter',
    base: { power_w: 1850, energy_kwh: 142.6 },
  },
  {
    id: 5,
    key: 'water',
    name: 'Water',
    type: 'water_meter',
    base: { flow_lpm: 3.4, water_l: 318.5 },
  },
  {
    id: 6,
    key: 'fermenter_gravity',
    name: 'Fermenter',
    type: 'hydrometer',
    base: { gravity_sg: 1.019, temp_c: 18.9 },
  },
];

const CUMULATIVE = new Set(['energy_kwh', 'water_l']);

// Deadband (°C) around the setpoint within which the controller sits idle,
// mirroring the Inkbird agent's logic (deploy/agents/inkbird-agent/agent.py).
const HVAC_DEADBAND_C = 0.3;

/**
 * Relay state a controller would drive given the current temp vs its setpoint:
 * cooling (-1) when too warm, heating (+1) when too cold, idle (0) inside the
 * deadband. The real agent reports this straight from the hardware relay
 * (Tuya DPS 115); the mock has to infer it so it stays consistent when the
 * operator moves the setpoint above or below the current temperature.
 *
 * `heatOnly` controllers never cool: above the setpoint they idle rather than
 * report cooling (see {@link MockProfile.heatOnly}).
 */
function hvacStateFor(tempC: number, setpointC: number, heatOnly = false): number {
  if (tempC < setpointC - HVAC_DEADBAND_C) return 1; // heating
  if (heatOnly) return 0; // cooling relay unused — idle whenever not heating
  if (tempC > setpointC + HVAC_DEADBAND_C) return -1; // cooling
  return 0; // idle
}

/**
 * The mock fermenter's target programme: what its Inkbird is "set to" over time.
 *
 * A synthesized target used to be one number for all of history, which drew the
 * charts' target line as a flat rule and left the change markers with nothing to
 * point at — the one part of the fermenter card that could not be developed
 * against mock data. The phases below are a fermentation schedule in miniature:
 * primary, a diacetyl rest, then cooling toward a crash.
 *
 * It cycles rather than running once, so every window has steps in it whenever
 * you look. Keyed off epoch time (not the clock or the server's start) so it is
 * a pure function of the moment: the history, the live value and the change list
 * are three views of the same schedule and cannot drift apart, and a poll five
 * seconds later redraws the same line rather than sliding it.
 */
const FERMENT_PROGRAMME: readonly { holdHours: number; targetC: number }[] = [
  { holdHours: 10, targetC: 18 },
  { holdHours: 6, targetC: 20 },
  { holdHours: 8, targetC: 12 },
];

const HOUR_MS = 60 * 60 * 1000;
const PROGRAMME_MS = FERMENT_PROGRAMME.reduce((total, p) => total + p.holdHours * HOUR_MS, 0);

/** How long the mock fridge takes to travel to a new target, for the temp curve. */
const FERMENT_PULL_MS = 45 * 60 * 1000;

const FERMENT_FG = 1.01;
const FERMENT_K = 0.12;
const FERMENT_AGE_DAYS = 14;

const WANDER: Record<string, number> = {
  pressure_bar: 0.04,
  temp_c: 0.2,
  power_w: 220,
  flow_lpm: 1.2,
};

const APPLY_LATENCY_MS = 6000;

interface PendingSetpoint {
  value: number;
  at: number;
}

/**
 * A mock setpoint the operator has changed and the fake agent has "applied".
 * Synthesized history is generated from the *current* target, so the change is
 * kept as an event as well — otherwise a mock controller's history would show
 * the new target as though it had always been held, and the charts' change
 * markers (see {@link mockSetpointChanges}) would have nothing to draw.
 */
interface AppliedSetpoint {
  value: number;
  /** Target it replaced, so the marker can read "18.0° -> 20.0°". */
  from: number;
  /** When the fake agent applied it (epoch ms). */
  at: number;
}

const pendingSetpoints = new Map<number, PendingSetpoint>();
const appliedSetpoints = new Map<number, AppliedSetpoint>();

export function mockDeviceId(profile: MockProfile): number {
  return MOCK_ID_BASE + profile.id;
}

export function profileByMockDeviceId(id: number): MockProfile | null {
  return MOCK_PROFILES.find((profile) => mockDeviceId(profile) === id) ?? null;
}

export function profileKey(profile: MockProfile): string {
  return `${profile.type}:${profile.id}`;
}

export function findProfileForDevice(device: Pick<Device, 'name' | 'type'>): MockProfile | null {
  const name = normalizeName(device.name);
  const exact = MOCK_PROFILES.find(
    (profile) => profile.type === device.type && normalizeName(profile.name) === name,
  );
  if (exact) return exact;

  if (device.type === 'brew_controller') {
    if (name.includes('brewery') || name.includes('ambient'))
      return profileByKind('brew_controller', 'Brewery');
    if (name.includes('keg')) return profileByKind('brew_controller', 'Kegs');
    return profileByKind('brew_controller', 'Fermenter');
  }
  if (device.type === 'pressure_sensor') return profileByKind('pressure_sensor', 'Fermenter');
  if (device.type === 'hydrometer') return profileByKind('hydrometer', 'Fermenter');
  if (device.type === 'power_meter') return profileByKind('power_meter', 'Power');
  if (device.type === 'water_meter') return profileByKind('water_meter', 'Water');
  return null;
}

export function mockStatus(
  profile: MockProfile,
  overrides: Partial<Pick<Device, 'id' | 'name' | 'type' | 'createdAt'>> = {},
): DeviceStatus {
  const now = new Date();
  const nowIso = now.toISOString();
  const id = overrides.id ?? mockDeviceId(profile);
  return {
    id,
    name: overrides.name ?? profile.name,
    type: overrides.type ?? profile.type,
    createdAt:
      overrides.createdAt ??
      new Date(now.getTime() - MOCK_DEVICE_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    lastSeenAt: nowIso,
    lastIp: mockIp(profile),
    mac: mockMac(profile),
    // No manufacturer app behind a simulated device, so nothing to report.
    vendorName: null,
    online: true,
    latest: latestReadings(profile, id, nowIso),
    reportingIntervalSec: MOCK_PUSH_INTERVAL_SEC,
    readingCount: mockReadingCount(profile),
    pendingSetpointC: resolvePendingSetpoint(profile, id),
  };
}

export function mockHistory(
  profile: MockProfile,
  deviceId: number,
  opts: { metric?: string; since?: string; limit?: number; buckets?: number } = {},
): Reading[] {
  const metric = opts.metric ?? Object.keys(profile.base)[0]!;
  // The target and the temperature are both functions of the moment now (see
  // FERMENT_PROGRAMME), so they read the profile per point rather than taking
  // one value for the whole window as everything else here does.
  const base = profile.base[metric] ?? 0;
  const end = Date.now();
  const start = opts.since ? Date.parse(opts.since) : end - 24 * 60 * 60 * 1000;
  const spanMs = Math.max(end - start, 60 * 1000);
  const spanDays = spanMs / (24 * 60 * 60 * 1000);

  // Synthesized history is already spread evenly across the window, so a
  // `buckets` request is just a point count — there's no raw sample behind it to
  // average, and the curve is smooth to begin with.
  const points = Math.min(opts.buckets ?? opts.limit ?? 240, 240);
  const out: Reading[] = [];
  for (let i = 0; i < points; i++) {
    const frac = i / (points - 1 || 1);
    const t = start + frac * spanMs;
    out.push({
      id: i + 1,
      deviceId,
      metric,
      value: historyValue(metric, base, frac, spanDays, t, profile, deviceId),
      recordedAt: new Date(t).toISOString(),
    });
  }
  return out.reverse();
}

export function mockMetricTotal(metric: string): number {
  if (!CUMULATIVE.has(metric)) return 0;
  const perDay = metric === 'energy_kwh' ? 1.8 * 24 : 2.0 * 24;
  return Math.round(perDay * MOCK_DEVICE_AGE_DAYS);
}

export function queueMockSetpoint(deviceId: number, profile: MockProfile, value: number): boolean {
  if (profile.type !== 'brew_controller') return false;
  pendingSetpoints.set(deviceId, { value, at: Date.now() });
  return true;
}

function profileByKind(type: DeviceType, name: string): MockProfile | null {
  return (
    MOCK_PROFILES.find(
      (profile) => profile.type === type && normalizeName(profile.name) === normalizeName(name),
    ) ?? null
  );
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function wander(metric: string, amp: number): number {
  const phase = metric.length * 1.3;
  return Math.sin(Date.now() / 60000 + phase) * amp;
}

function currentValue(metric: string, base: number): number {
  if (CUMULATIVE.has(metric) || metric === 'hvac_state' || metric === 'setpoint_c') return base;
  return base + wander(metric, WANDER[metric] ?? 0);
}

/**
 * Only the fermenter's controller runs a programme. The brewery's freeze-safety
 * Inkbird and the keg fridge are both set once and left there for the year, so a
 * target that wandered would be a worse mock, not a livelier one.
 */
function hasTargetProgramme(profile: MockProfile): boolean {
  return profile.key === 'fermenter_controller';
}

/** Where `t` falls in {@link FERMENT_PROGRAMME}: its target, and its two ends. */
function programmePhaseAt(t: number): { targetC: number; startedAt: number; endsAt: number } {
  let startedAt = Math.floor(t / PROGRAMME_MS) * PROGRAMME_MS;
  for (const phase of FERMENT_PROGRAMME) {
    const endsAt = startedAt + phase.holdHours * HOUR_MS;
    if (t < endsAt) return { targetC: phase.targetC, startedAt, endsAt };
    startedAt = endsAt;
  }
  // Unreachable — the phases sum to PROGRAMME_MS — but a total is cheaper to
  // guard than to prove at every call site.
  const last = FERMENT_PROGRAMME[FERMENT_PROGRAMME.length - 1]!;
  return { targetC: last.targetC, startedAt, endsAt: startedAt + last.holdHours * HOUR_MS };
}

/**
 * The target a mock controller was holding at `t`.
 *
 * A setpoint the operator changed through the UI wins from the moment it was
 * applied onward: taking manual control of a mock fridge and then watching the
 * schedule quietly undo it a few hours later would be a worse lie than the
 * schedule itself.
 */
function mockTargetAt(profile: MockProfile, deviceId: number, t: number): number {
  const applied = appliedSetpoints.get(deviceId);
  if (applied && t >= applied.at) return applied.value;
  if (hasTargetProgramme(profile)) return programmePhaseAt(t).targetC;
  return profile.base.setpoint_c ?? 0;
}

/** Every programme step in (`from`, `to`], oldest first. */
function programmeStepsBetween(from: number, to: number): { at: number; from: number; to: number }[] {
  const steps: { at: number; from: number; to: number }[] = [];
  // Walk the phase boundaries from the one containing `from`; a window wider
  // than a cycle simply yields more of them.
  let phase = programmePhaseAt(from);
  let previous = phase.targetC;
  while (phase.endsAt <= to) {
    const next = programmePhaseAt(phase.endsAt);
    if (phase.endsAt > from && Math.abs(next.targetC - previous) >= 0.05) {
      steps.push({ at: phase.endsAt, from: previous, to: next.targetC });
    }
    previous = next.targetC;
    phase = next;
  }
  return steps;
}

function resolvePendingSetpoint(profile: MockProfile, deviceId: number): number | null {
  const pending = pendingSetpoints.get(deviceId);
  if (!pending) return null;
  if (Date.now() - pending.at >= APPLY_LATENCY_MS) {
    const at = Date.now();
    // What it was holding a moment before the change — the programme's value
    // when nothing has been set by hand yet.
    const from = mockTargetAt(profile, deviceId, at - 1);
    appliedSetpoints.set(deviceId, { value: pending.value, from, at });
    pendingSetpoints.delete(deviceId);
    return null;
  }
  return pending.value;
}

function effectiveSetpoint(profile: MockProfile, deviceId: number): number {
  resolvePendingSetpoint(profile, deviceId);
  return mockTargetAt(profile, deviceId, Date.now());
}

/**
 * Target changes for a synthesized controller: the steps its programme took
 * across the window (see {@link FERMENT_PROGRAMME}), plus any change the
 * operator made through the mock setpoint control this session.
 *
 * The two are read from the same schedule the history is drawn from, so a
 * marker always lands on the step in the target line rather than beside it.
 * Programme steps stop at a hand-set change, which holds from then on.
 */
export function mockSetpointChanges(
  profile: MockProfile,
  deviceId: number,
  opts: { since?: string } = {},
): SetpointChange[] {
  if (profile.type !== 'brew_controller') return [];
  resolvePendingSetpoint(profile, deviceId);
  const applied = appliedSetpoints.get(deviceId);
  const now = Date.now();
  const from = opts.since ? Date.parse(opts.since) : now - 30 * 24 * HOUR_MS;
  if (!Number.isFinite(from)) return [];

  const changes: SetpointChange[] = [];
  if (hasTargetProgramme(profile)) {
    for (const step of programmeStepsBetween(from, Math.min(applied?.at ?? now, now))) {
      changes.push({ at: new Date(step.at).toISOString(), from: step.from, to: step.to });
    }
  }
  if (applied && applied.at >= from && Math.abs(applied.value - applied.from) >= 0.05) {
    changes.push({
      at: new Date(applied.at).toISOString(),
      from: applied.from,
      to: applied.value,
    });
  }
  // The API answers newest first, like the real query does.
  return changes.reverse();
}

function latestReadings(profile: MockProfile, deviceId: number, nowIso: string): LatestReading[] {
  return Object.entries(profile.base).map(([metric, base]) => ({
    metric,
    value: latestValue(profile, deviceId, metric, base),
    recordedAt: nowIso,
  }));
}

function latestValue(
  profile: MockProfile,
  deviceId: number,
  metric: string,
  base: number,
): number {
  if (metric === 'setpoint_c') return effectiveSetpoint(profile, deviceId);
  if (metric === 'temp_c') return mockTempAt(profile, deviceId, Date.now(), base);
  if (metric === 'hvac_state') {
    const temp = mockTempAt(profile, deviceId, Date.now(), profile.base.temp_c ?? 0);
    return hvacStateFor(temp, effectiveSetpoint(profile, deviceId), profile.heatOnly);
  }
  return currentValue(metric, base);
}

/** When the target in force at `t` was set — a programme boundary, or a hand-set change. */
function targetSetAt(profile: MockProfile, deviceId: number, t: number): number {
  const applied = appliedSetpoints.get(deviceId);
  if (applied && t >= applied.at) return applied.at;
  return programmePhaseAt(t).startedAt;
}

/**
 * A controller's own temperature at `t`: for one running a programme, the target
 * it was chasing then, eased across each step and wobbling around it the way a
 * hysteresis controller does. Anything else keeps its flat base value.
 *
 * Without this the mock fermenter would sit at one temperature while its target
 * stepped away from it — a fridge permanently failing to reach a setpoint, which
 * is a strange thing for the demo fleet to be showing.
 */
function mockTempAt(profile: MockProfile, deviceId: number, t: number, base: number): number {
  if (!hasTargetProgramme(profile)) return currentValue('temp_c', base);
  const target = mockTargetAt(profile, deviceId, t);
  // Ease from the target this one replaced, so a step reads as a fridge
  // travelling to it rather than teleporting — including one set by hand.
  const setAt = targetSetAt(profile, deviceId, t);
  const previous = mockTargetAt(profile, deviceId, setAt - 1);
  const progress = Math.min(1, Math.max(0, (t - setAt) / FERMENT_PULL_MS));
  const held = previous + (target - previous) * progress;
  // The compressor cycling around it — the same sort of ±0.4 °C swing the
  // previews are built to smooth (see SERIES_BUCKETS in the web app).
  return held + Math.sin(t / (7 * 60 * 1000)) * 0.4;
}

function historyValue(
  metric: string,
  base: number,
  frac: number,
  spanDays: number,
  t: number,
  profile: MockProfile,
  deviceId: number,
): number {
  if (metric === 'setpoint_c') return mockTargetAt(profile, deviceId, t);

  if (metric === 'temp_c' && hasTargetProgramme(profile)) {
    return mockTempAt(profile, deviceId, t, base);
  }

  if (metric === 'hvac_state') {
    // Derive the relay state from the temp series vs the setpoint at this
    // instant, so cooling/heating tracks the target through the window.
    const temp = historyValue('temp_c', profile.base.temp_c ?? 0, frac, spanDays, t, profile, deviceId);
    const setpoint = mockTargetAt(profile, deviceId, t);
    return hvacStateFor(temp, setpoint, profile.heatOnly);
  }

  if (metric === 'energy_kwh') {
    return base - 1.8 * 24 * spanDays * (1 - frac);
  }
  if (metric === 'water_l') {
    return base - 2.0 * 24 * spanDays * (1 - frac);
  }
  if (metric === 'gravity_sg') {
    const daysAgo = spanDays * (1 - frac);
    const sincePitch = Math.min(daysAgo, FERMENT_AGE_DAYS);
    return FERMENT_FG + (base - FERMENT_FG) * Math.exp(FERMENT_K * sincePitch);
  }

  const amp = WANDER[metric] ?? base * 0.04;
  return base + Math.sin(t / (30 * 60 * 1000) + metric.length) * amp;
}
