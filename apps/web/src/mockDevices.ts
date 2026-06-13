import type { DeviceStatus, LatestReading, Reading } from '@checklist/shared';

/**
 * Design-time mock telemetry. While the real satellites are still being built,
 * this fills the dashboard's "Sensors & equipment" section with realistic,
 * live-looking device tiles (instead of the dimmed "Planned" placeholders) so
 * the layout can be designed against representative data — values, units,
 * online badges, and metric charts on the detail page all render as they will
 * in production.
 *
 * Flip {@link USE_MOCK_DEVICES} to false (or delete this module and its imports
 * in api.ts) once real devices are pushing to the hub.
 */
export const USE_MOCK_DEVICES = true;

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
    id: 3,
    name: 'Brewery Temperature',
    type: 'brew_controller',
    base: { temp_c: 21.3 },
  },
  {
    id: 4,
    name: 'Mains Power',
    type: 'power_meter',
    base: { power_w: 1850, energy_kwh: 142.6 },
  },
  {
    id: 5,
    name: 'Water Supply',
    type: 'water_meter',
    base: { flow_lpm: 3.4, water_l: 318.5 },
  },
  {
    // Named "Fermenter" (not "Tilt") so the kiosk hub merges the Tilt's beer
    // temperature + gravity into the single fermenter card alongside the
    // pressure sensor and fridge controller above.
    id: 6,
    name: 'Fermenter',
    type: 'hydrometer',
    base: { gravity_sg: 1.048, temp_c: 18.9 },
  },
];

/** Cumulative totals only ever climb; gravity falls as sugar is consumed. */
const CUMULATIVE = new Set(['energy_kwh', 'water_l']);

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

function latestReadings(d: MockDevice, nowIso: string): LatestReading[] {
  return Object.entries(d.base).map(([metric, base]) => ({
    metric,
    value: currentValue(metric, base),
    recordedAt: nowIso,
  }));
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
    online: true,
    latest: latestReadings(d, nowIso),
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
      value: historyValue(metric, base, frac, spanDays, t),
      recordedAt: new Date(t).toISOString(),
    });
  }
  // The API returns newest→oldest; callers reverse for the time axis.
  return out.reverse();
}

function historyValue(
  metric: string,
  base: number,
  frac: number,
  spanDays: number,
  t: number,
): number {
  if (metric === 'setpoint_c') return base; // flat target line

  if (metric === 'hvac_state') {
    // Step between cooling (-1) and idle (0) on a slow cycle.
    return Math.sin(t / (45 * 60 * 1000)) < -0.2 ? -1 : 0;
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
    // Active fermentation: ~0.006 SG drop per day, declining toward `base`.
    return base + 0.006 * spanDays * (1 - frac);
  }

  // Everything else: gentle noise around the base value.
  const amp = WANDER[metric] ?? base * 0.04;
  return base + Math.sin(t / (30 * 60 * 1000) + metric.length) * amp;
}
