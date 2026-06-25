import type { DeviceStatus, LatestReading, Reading } from '@checklist/shared';

/**
 * Legacy browser-side mock telemetry; the server owns live/mock fallback now.
 * this fills the dashboard's "Sensors & equipment" section with realistic,
 * live-looking device tiles (instead of the dimmed "Planned" placeholders) so
 * the layout can be designed against representative data — values, units,
 * online badges, and metric charts on the detail page all render as they will
 * in production.
 */
export const USE_MOCK_DEVICES = false;

/**
 * The mock fleet — one entry per planned sensor plus the fermentation pressure
 * and fridge controller, so every `DeviceType` and every planned-sensor tile is
 * represented. `base` holds each metric's "current" value; live timestamps and
 * a little wander are added per request so tiles read as freshly reporting.
 */
interface MockDevice {
  id: number;
  name: string;
  type: DeviceStatus['type'];
  /** Metric → current value. Order here is the order shown on the tile. */
  base: Record<string, number>;
  /** Heat-only controller (cooling relay unused) — never reports cooling. */
  heatOnly?: boolean;
}

const MOCK_FLEET: MockDevice[] = [
  {
    id: 1,
    name: 'Fermenter',
    type: 'pressure_sensor',
    base: { pressure_bar: 1.18 },
  },
  {
    id: 2,
    name: 'Fermenter',
    type: 'brew_controller',
    base: { temp_c: 18.4, setpoint_c: 18.0, hvac_state: -1 },
  },
  {
    // Heat-only freeze-safety Inkbird: warms the brewery near freezing, else idle.
    id: 3,
    name: 'Brewery',
    type: 'brew_controller',
    base: { temp_c: 21.3, setpoint_c: 6.0, hvac_state: 0 },
    heatOnly: true,
  },
  {
    // Inkbird on the filled-keg fridge, held at cold serving temperature.
    id: 7,
    name: 'Kegs',
    type: 'brew_controller',
    base: { temp_c: 4.1, setpoint_c: 3.5, hvac_state: -1 },
  },
  {
    id: 4,
    name: 'Power',
    type: 'power_meter',
    base: { power_w: 1850, energy_kwh: 142.6 },
  },
  {
    id: 5,
    name: 'Water',
    type: 'water_meter',
    base: { flow_lpm: 3.4, water_l: 318.5 },
  },
  {
    // Named "Fermenter" (not "Tilt") so the kiosk hub merges the Tilt's beer
    // temperature + gravity into the single fermenter card alongside the
    // pressure sensor and fridge controller above. The gravity sits mid-late
    // fermentation (see FERMENT_* below) so the dashboard's gravity forecast has
    // a clear declining curve to fit and a finish a couple of days out.
    id: 6,
    name: 'Fermenter',
    type: 'hydrometer',
    base: { gravity_sg: 1.019, temp_c: 18.9 },
  },
];

/** Cumulative totals only ever climb; gravity falls as sugar is consumed. */
const CUMULATIVE = new Set(['energy_kwh', 'water_l']);

// Deadband (°C) around the setpoint within which the controller sits idle,
// mirroring the Inkbird agent (deploy/agents/inkbird-agent/agent.py).
const HVAC_DEADBAND_C = 0.3;

/**
 * Relay state a controller would drive given the current temp vs its setpoint:
 * cooling (-1) when too warm, heating (+1) when too cold, idle (0) inside the
 * deadband. The real device reports this from its relay; the mock infers it so
 * cooling/heating stays correct when the operator moves the setpoint past the
 * current temperature.
 */
function hvacStateFor(tempC: number, setpointC: number, heatOnly = false): number {
  if (tempC < setpointC - HVAC_DEADBAND_C) return 1; // heating
  if (heatOnly) return 0; // cooling relay unused — idle whenever not heating
  if (tempC > setpointC + HVAC_DEADBAND_C) return -1; // cooling
  return 0; // idle
}

/**
 * Mock fermentation shape for the gravity history + forecast demo. A clean
 * exponential approach toward terminal gravity {@link FERMENT_FG}, pitched
 * {@link FERMENT_AGE_DAYS} ago so the dashboard's 14-day forecast window is all
 * active fermentation — no flat lag plateau, which the forecast's curve fit
 * can't model. Tuned so the gravity card fits FG≈1.010 and predicts "done"
 * ~2 days out under the default 2-day / 0.002 SG stable-window rule.
 */
const FERMENT_FG = 1.01; // terminal gravity the curve approaches
const FERMENT_K = 0.12; // attenuation rate, per day
const FERMENT_AGE_DAYS = 14; // days since pitch at "now"

/**
 * A small, smooth, time-based offset so a metric subtly drifts between polls
 * and the dashboard feels live. Deterministic (no RNG) and bounded by `amp`.
 * Cumulative metrics and the discrete hvac state are left untouched by callers.
 */
function wander(metric: string, amp: number): number {
  const phase = metric.length * 1.3;
  return Math.sin(Date.now() / 60000 + phase) * amp;
}

/** Per-metric wander amplitude; 0 keeps a value pinned (setpoints, totals). */
const WANDER: Record<string, number> = {
  pressure_bar: 0.04,
  temp_c: 0.2,
  power_w: 220,
  flow_lpm: 1.2,
};

function currentValue(metric: string, base: number): number {
  if (CUMULATIVE.has(metric) || metric === 'hvac_state' || metric === 'setpoint_c') return base;
  return base + wander(metric, WANDER[metric] ?? 0);
}

// --- Mock setpoint command queue --------------------------------------------
// Mirrors the real hub→agent path so the stepper control can be designed and
// exercised without a backend: a requested setpoint stays "pending" for a short
// latency (the stand-in for the agent writing it to the controller), then is
// "applied" — the device's reported setpoint_c jumps to it and pending clears.

const APPLY_LATENCY_MS = 6000;

interface PendingSetpoint {
  value: number;
  at: number;
}
const pendingSetpoints = new Map<number, PendingSetpoint>();
const appliedSetpoints = new Map<number, number>();

/** Queue a new target setpoint for a mock device (the api.setDeviceSetpoint mock). */
export function mockSetSetpoint(id: number, value: number): { pendingSetpointC: number } {
  if (!MOCK_FLEET.some((m) => m.id === id)) throw new Error(`404: mock device ${id} not found`);
  pendingSetpoints.set(id, { value, at: Date.now() });
  return { pendingSetpointC: value };
}

/** A device's pending setpoint, promoting it to "applied" once the latency elapses. */
function resolvePendingSetpoint(id: number): number | null {
  const p = pendingSetpoints.get(id);
  if (!p) return null;
  if (Date.now() - p.at >= APPLY_LATENCY_MS) {
    appliedSetpoints.set(id, p.value);
    pendingSetpoints.delete(id);
    return null;
  }
  return p.value;
}

/** The setpoint the device reports — the last applied target, else its baseline. */
function effectiveSetpoint(id: number, base: number): number {
  return appliedSetpoints.get(id) ?? base;
}

function latestReadings(d: MockDevice, nowIso: string): LatestReading[] {
  return Object.entries(d.base).map(([metric, base]) => ({
    metric,
    value: latestValue(d, metric, base),
    recordedAt: nowIso,
  }));
}

function latestValue(d: MockDevice, metric: string, base: number): number {
  if (metric === 'setpoint_c') return effectiveSetpoint(d.id, base);
  if (metric === 'hvac_state') {
    const temp = currentValue('temp_c', d.base.temp_c ?? 0);
    const setpoint = effectiveSetpoint(d.id, d.base.setpoint_c ?? temp);
    return hvacStateFor(temp, setpoint, d.heatOnly);
  }
  return currentValue(metric, base);
}

function toStatus(d: MockDevice): DeviceStatus {
  const now = new Date();
  const nowIso = now.toISOString();
  return {
    id: d.id,
    name: d.name,
    type: d.type,
    // Created a few weeks ago; last seen "just now" so it reads as online.
    createdAt: new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000).toISOString(),
    lastSeenAt: nowIso,
    lastIp: null,
    reportingIntervalSec: 30,
    online: true,
    latest: latestReadings(d, nowIso),
    pendingSetpointC: resolvePendingSetpoint(d.id),
  };
}

export function mockListDevices(): DeviceStatus[] {
  return MOCK_FLEET.map(toStatus);
}

export function mockGetDevice(id: number): DeviceStatus {
  const d = MOCK_FLEET.find((m) => m.id === id);
  if (!d) throw new Error(`404: mock device ${id} not found`);
  return toStatus(d);
}

/**
 * Synthesize a plausible history for one metric over `[since, now]`. Cumulative
 * totals ramp up to the current value, gravity declines toward it, the hvac
 * state steps between cooling/idle, and everything else wanders around it with
 * gentle noise — enough variation to design and sanity-check the chart view.
 */
export function mockGetDeviceHistory(
  id: number,
  opts: { metric?: string; since?: string; limit?: number } = {},
): Reading[] {
  const d = MOCK_FLEET.find((m) => m.id === id);
  if (!d) throw new Error(`404: mock device ${id} not found`);

  const metric = opts.metric ?? Object.keys(d.base)[0]!;
  const base = d.base[metric] ?? 0;
  const end = Date.now();
  const start = opts.since ? Date.parse(opts.since) : end - 24 * 60 * 60 * 1000;
  const spanMs = Math.max(end - start, 60 * 1000);
  const spanDays = spanMs / (24 * 60 * 60 * 1000);

  const points = Math.min(opts.limit ?? 240, 240);
  const out: Reading[] = [];
  for (let i = 0; i < points; i++) {
    const frac = i / (points - 1 || 1); // 0 (oldest) → 1 (now)
    const t = start + frac * spanMs;
    out.push({
      id: i + 1,
      deviceId: id,
      metric,
      value: historyValue(d, metric, base, frac, spanDays, t),
      recordedAt: new Date(t).toISOString(),
    });
  }
  // The API returns newest→oldest; callers reverse for the time axis.
  return out.reverse();
}

/**
 * All-time total for a cumulative metric, mirroring the server's sum-of-deltas.
 * The mock history climbs monotonically to `base` over the requested span, so a
 * representative "all-time" figure is simply a few weeks of that daily rate —
 * enough to design the stat against. Non-cumulative metrics total to 0.
 */
export function mockGetDeviceTotal(id: number, metric: string): { metric: string; total: number } {
  const d = MOCK_FLEET.find((m) => m.id === id);
  if (!d) throw new Error(`404: mock device ${id} not found`);
  if (!CUMULATIVE.has(metric)) return { metric, total: 0 };
  // ~21 days (the mock's device age) of the per-day rate baked into the history.
  const perDay = metric === 'energy_kwh' ? 1.8 * 24 : 2.0 * 24;
  return { metric, total: Math.round(perDay * 21) };
}

function historyValue(
  d: MockDevice,
  metric: string,
  base: number,
  frac: number,
  spanDays: number,
  t: number,
): number {
  if (metric === 'setpoint_c') return base; // flat target line

  if (metric === 'hvac_state') {
    // Track the temp series vs the (effective) setpoint so cooling/heating
    // follows wherever the operator set the target.
    const temp = historyValue(d, 'temp_c', d.base.temp_c ?? 0, frac, spanDays, t);
    const setpoint = effectiveSetpoint(d.id, d.base.setpoint_c ?? temp);
    return hvacStateFor(temp, setpoint, d.heatOnly);
  }

  if (metric === 'energy_kwh') {
    // Total climbs ~1.8 kWh/h up to the current reading at "now".
    return base - 1.8 * 24 * spanDays * (1 - frac);
  }
  if (metric === 'water_l') {
    // Slow steady draw climbing to the current total at "now".
    return base - 2.0 * 24 * spanDays * (1 - frac);
  }
  if (metric === 'gravity_sg') {
    // Active fermentation: a strictly monotonic exponential approach to terminal
    // gravity. Gravity only ever falls (sugar → alcohol) — never oscillates — so
    // the curve decreases smoothly, anchored at the current reading (`base`) now
    // and rising backward toward OG at pitch (then flat before pitch). This gives
    // the gravity forecast a clean declining curve to fit (see FERMENT_*).
    const daysAgo = spanDays * (1 - frac);
    const sincePitch = Math.min(daysAgo, FERMENT_AGE_DAYS);
    return FERMENT_FG + (base - FERMENT_FG) * Math.exp(FERMENT_K * sincePitch);
  }

  // Everything else: gentle noise around the base value.
  const amp = WANDER[metric] ?? base * 0.04;
  return base + Math.sin(t / (30 * 60 * 1000) + metric.length) * amp;
}
