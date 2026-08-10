import type { Device } from '@checklist/shared';
import { findProfileForDevice } from './mock.js';

/**
 * Which planned sensor a registered device *is* — its {@link SENSOR_CATALOG}
 * key, e.g. `fermenter_controller`.
 *
 * The fleet has no column for this: a device is registered with a free-text name
 * and a coarse type, and everything downstream (the operator's mock/real source
 * toggle, the dashboard's fermenter grouping) infers the rest from that pair.
 * {@link findProfileForDevice} is where that inference lives, so it is the one
 * place to ask — the mock profiles simply happen to be keyed the same way. This
 * wrapper exists so alerting doesn't have to reach into the mock module (and
 * doesn't get a mock profile back when all it wanted was a name).
 */
export function sensorKeyFor(device: Pick<Device, 'name' | 'type'>): string | null {
  return findProfileForDevice(device)?.key ?? null;
}

/**
 * The sensors whose silence is worth waking someone for. A beer ferments (or
 * spoils) unattended for weeks, so losing sight of the fermenter or the fridge
 * holding the finished kegs is itself the emergency — you find out that the
 * temperature ran away only if you were told the sensor stopped reporting. The
 * power and water meters are omitted deliberately: a gap in those costs a hole
 * in a graph, not a batch.
 */
export const CRITICAL_SENSOR_KEYS: ReadonlySet<string> = new Set([
  'fermenter_pressure',
  'fermenter_controller',
  'fermenter_gravity',
  'kegs_controller',
]);

/** Whether losing this device's readings should reach the phones. */
export function isCriticalSensor(device: Pick<Device, 'name' | 'type'>): boolean {
  const key = sensorKeyFor(device);
  return key != null && CRITICAL_SENSOR_KEYS.has(key);
}
