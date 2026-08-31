import type { DeviceStatus, DeviceType, LatestReading } from '@checklist/shared';
import { describe, expect, it } from 'vitest';
import {
  findReading,
  groupByName,
  groupRank,
  isBreweryTempDevice,
  isFermenterDevice,
  isKegsTempDevice,
  latestDeviceTimestamp,
} from './deviceRoles';

function device(
  id: number,
  name: string,
  type: DeviceType,
  latest: LatestReading[] = [],
  lastSeenAt: string | null = null,
): DeviceStatus {
  return {
    id,
    name,
    type,
    latest,
    lastSeenAt,
    online: true,
    lastIp: null,
    mac: null,
    vendorName: null,
    reportingIntervalSec: 30,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('device roles', () => {
  it('separates ambient and keg controllers from fermenter controllers', () => {
    const brewery = device(1, 'Brewery Ambient', 'brew_controller');
    const kegs = device(2, 'Keg Fridge', 'brew_controller');
    const fermenter = device(3, 'Fermenter', 'brew_controller');

    expect(isBreweryTempDevice(brewery)).toBe(true);
    expect(isKegsTempDevice(kegs)).toBe(true);
    expect(isFermenterDevice(brewery)).toBe(false);
    expect(isFermenterDevice(kegs)).toBe(false);
    expect(isFermenterDevice(fermenter)).toBe(true);
    expect(isFermenterDevice(device(4, 'Tilt', 'hydrometer'))).toBe(true);
  });

  it('groups stations by name and ranks them by their most important member', () => {
    const devices = [
      device(1, 'Utilities', 'power_meter'),
      device(2, 'Fermenter', 'hydrometer'),
      device(3, 'Fermenter', 'pressure_sensor'),
    ];
    const groups = groupByName(devices);

    expect(groups.map((group) => group.map(({ id }) => id))).toEqual([[1], [2, 3]]);
    expect(groupRank(groups[1]!)).toBe(0);
  });

  it('finds typed readings and the latest device timestamp', () => {
    const reading = { metric: 'temp_c', value: 18.5, recordedAt: '2026-01-02T00:00:00.000Z' };
    const devices = [
      device(1, 'Tilt', 'hydrometer', [reading], '2026-01-02T00:00:00.000Z'),
      device(2, 'Controller', 'brew_controller', [reading], '2026-01-03T00:00:00.000Z'),
    ];

    expect(findReading(devices, 'temp_c', 'brew_controller')?.deviceId).toBe(2);
    expect(findReading(devices, 'gravity_sg')).toBeUndefined();
    expect(latestDeviceTimestamp(devices)).toBe('2026-01-03T00:00:00.000Z');
  });
});
