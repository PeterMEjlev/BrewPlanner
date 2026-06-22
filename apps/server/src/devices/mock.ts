import type { Device, DeviceStatus, DeviceType, LatestReading, Reading } from '@checklist/shared';

const MOCK_ID_BASE = 900_000;
const MOCK_DEVICE_AGE_DAYS = 21;

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
    id: 3,
    key: 'brewery_temp',
    name: 'Brewery',
    type: 'brew_controller',
    base: { temp_c: 21.3, setpoint_c: 20.0, hvac_state: 0 },
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

const pendingSetpoints = new Map<number, PendingSetpoint>();
const appliedSetpoints = new Map<number, number>();

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
    return profileByKind(
      'brew_controller',
      name.includes('brewery') || name.includes('ambient') ? 'Brewery' : 'Fermenter',
    );
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
    online: true,
    latest: latestReadings(profile, id, nowIso),
    pendingSetpointC: resolvePendingSetpoint(id),
  };
}

export function mockHistory(
  profile: MockProfile,
  deviceId: number,
  opts: { metric?: string; since?: string; limit?: number } = {},
): Reading[] {
  const metric = opts.metric ?? Object.keys(profile.base)[0]!;
  const baseFromProfile = profile.base[metric] ?? 0;
  const base = metric === 'setpoint_c' ? effectiveSetpoint(deviceId, baseFromProfile) : baseFromProfile;
  const end = Date.now();
  const start = opts.since ? Date.parse(opts.since) : end - 24 * 60 * 60 * 1000;
  const spanMs = Math.max(end - start, 60 * 1000);
  const spanDays = spanMs / (24 * 60 * 60 * 1000);

  const points = Math.min(opts.limit ?? 240, 240);
  const out: Reading[] = [];
  for (let i = 0; i < points; i++) {
    const frac = i / (points - 1 || 1);
    const t = start + frac * spanMs;
    out.push({
      id: i + 1,
      deviceId,
      metric,
      value: historyValue(metric, base, frac, spanDays, t),
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

function resolvePendingSetpoint(deviceId: number): number | null {
  const pending = pendingSetpoints.get(deviceId);
  if (!pending) return null;
  if (Date.now() - pending.at >= APPLY_LATENCY_MS) {
    appliedSetpoints.set(deviceId, pending.value);
    pendingSetpoints.delete(deviceId);
    return null;
  }
  return pending.value;
}

function effectiveSetpoint(deviceId: number, base: number): number {
  resolvePendingSetpoint(deviceId);
  return appliedSetpoints.get(deviceId) ?? base;
}

function latestReadings(profile: MockProfile, deviceId: number, nowIso: string): LatestReading[] {
  return Object.entries(profile.base).map(([metric, base]) => ({
    metric,
    value: metric === 'setpoint_c' ? effectiveSetpoint(deviceId, base) : currentValue(metric, base),
    recordedAt: nowIso,
  }));
}

function historyValue(
  metric: string,
  base: number,
  frac: number,
  spanDays: number,
  t: number,
): number {
  if (metric === 'setpoint_c') return base;

  if (metric === 'hvac_state') {
    return Math.sin(t / (45 * 60 * 1000)) < -0.2 ? -1 : 0;
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
