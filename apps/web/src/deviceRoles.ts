import type { DeviceStatus, DeviceType, LatestReading } from '@checklist/shared';

type DeviceIdentity = Pick<DeviceStatus, 'name' | 'type'>;

/** Display priority shared by the overview and kiosk device groups. */
export const TYPE_RANK: Record<DeviceType, number> = {
  pressure_sensor: 0,
  hydrometer: 1,
  brew_controller: 2,
  other: 3,
  power_meter: 4,
  water_meter: 5,
};

export function isBreweryTempDevice(device: DeviceIdentity): boolean {
  return device.type === 'brew_controller' && /brewery|ambient/i.test(device.name);
}

export function isKegsTempDevice(device: DeviceIdentity): boolean {
  return device.type === 'brew_controller' && /keg/i.test(device.name);
}

export function isFermenterDevice(device: DeviceIdentity): boolean {
  return (
    device.type === 'pressure_sensor' ||
    device.type === 'hydrometer' ||
    (device.type === 'brew_controller' &&
      !isBreweryTempDevice(device) &&
      !isKegsTempDevice(device))
  );
}

export function groupByName(devices: DeviceStatus[]): DeviceStatus[][] {
  const groups = new Map<string, DeviceStatus[]>();
  for (const device of devices) {
    const group = groups.get(device.name);
    if (group) group.push(device);
    else groups.set(device.name, [device]);
  }
  return [...groups.values()];
}

export function groupRank(group: DeviceIdentity[]): number {
  return Math.min(...group.map((device) => TYPE_RANK[device.type]));
}

export interface ReadingSource {
  reading: LatestReading;
  deviceId: number;
}

export function findReading(
  devices: DeviceStatus[],
  metric: string,
  type?: DeviceType,
): ReadingSource | undefined {
  for (const device of devices) {
    if (type && device.type !== type) continue;
    const reading = device.latest.find((candidate) => candidate.metric === metric);
    if (reading) return { reading, deviceId: device.id };
  }
  return undefined;
}

export function latestDeviceTimestamp(devices: DeviceStatus[]): string | null {
  let latest: string | null = null;
  for (const device of devices) {
    if (!device.lastSeenAt) continue;
    if (!latest || Date.parse(device.lastSeenAt) > Date.parse(latest)) latest = device.lastSeenAt;
  }
  return latest;
}
