import type { DeviceStatus, Reading } from '@checklist/shared';
import * as mock from './mock.js';
import * as real from './repo.js';

/**
 * User-facing telemetry reads prefer live real devices, but synthesize the
 * planned sensor fleet when hardware is missing, stale, or has not reported any
 * readings yet. The raw repository stays real-only for ingestion, commands, and
 * offline alert evaluation.
 */
function hasRealSensorData(status: DeviceStatus): boolean {
  return status.online && status.latest.length > 0;
}

function statusWithMockFallback(status: DeviceStatus): DeviceStatus {
  if (hasRealSensorData(status)) return status;
  const profile = mock.findProfileForDevice(status);
  return profile
    ? mock.mockStatus(profile, {
        id: status.id,
        name: status.name,
        type: status.type,
        createdAt: status.createdAt,
      })
    : status;
}

export function listDeviceStatus(): DeviceStatus[] {
  const realStatuses = real.listDeviceStatus();
  const coveredProfiles = new Set<string>();
  const statuses = realStatuses.map((status) => {
    const profile = mock.findProfileForDevice(status);
    if (profile) coveredProfiles.add(mock.profileKey(profile));
    return statusWithMockFallback(status);
  });

  for (const profile of mock.MOCK_PROFILES) {
    if (!coveredProfiles.has(mock.profileKey(profile))) {
      statuses.push(mock.mockStatus(profile));
    }
  }

  return statuses.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

export function getDeviceStatus(id: number): DeviceStatus | null {
  const realStatus = real.getDeviceStatus(id);
  if (realStatus) return statusWithMockFallback(realStatus);

  const profile = mock.profileByMockDeviceId(id);
  return profile ? mock.mockStatus(profile) : null;
}

export function getHistory(
  id: number,
  opts: { metric?: string; since?: string; limit?: number },
): Reading[] | null {
  const realStatus = real.getDeviceStatus(id);
  if (realStatus) {
    const profile = mock.findProfileForDevice(realStatus);
    if (hasRealSensorData(realStatus)) {
      const history = real.getHistory(id, opts);
      if (history.length > 0 || !profile) return history;
    }
    return profile ? mock.mockHistory(profile, id, opts) : real.getHistory(id, opts);
  }

  const profile = mock.profileByMockDeviceId(id);
  return profile ? mock.mockHistory(profile, id, opts) : null;
}

export function getMetricTotal(id: number, metric: string): number | null {
  const realStatus = real.getDeviceStatus(id);
  if (realStatus) {
    const profile = mock.findProfileForDevice(realStatus);
    if (hasRealSensorData(realStatus)) {
      const hasMetric = real.getHistory(id, { metric, limit: 1 }).length > 0;
      if (hasMetric || !profile) return real.getMetricTotal(id, metric);
    }
    return profile ? mock.mockMetricTotal(metric) : real.getMetricTotal(id, metric);
  }

  const profile = mock.profileByMockDeviceId(id);
  return profile ? mock.mockMetricTotal(metric) : null;
}

export function queueSetpoint(id: number, value: number): boolean {
  const realStatus = real.getDeviceStatus(id);
  if (realStatus) {
    if (hasRealSensorData(realStatus)) {
      real.queueSetpoint(id, value);
      return true;
    }
    const profile = mock.findProfileForDevice(realStatus);
    return profile ? mock.queueMockSetpoint(id, profile, value) : false;
  }

  const profile = mock.profileByMockDeviceId(id);
  return profile ? mock.queueMockSetpoint(id, profile, value) : false;
}
