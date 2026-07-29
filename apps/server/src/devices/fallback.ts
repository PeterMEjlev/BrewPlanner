import type { DeviceDataSources, DeviceStatus, Reading } from '@checklist/shared';
import { getDeviceDataSources } from '../repo.js';
import * as mock from './mock.js';
import * as real from './repo.js';

/**
 * User-facing telemetry reads resolve each planned sensor through its operator
 * chosen data source (see {@link getDeviceDataSources}):
 *
 * - **mock** (the default): prefer live real readings when the sensor is actually
 *   reporting, otherwise synthesize the planned-sensor fleet so the dashboard
 *   looks alive before any hardware exists.
 * - **real**: always serve the sensor's own readings — even when it's offline or
 *   has never reported — so an unconnected sensor surfaces as a greyed-out,
 *   "not connected" tile instead of being papered over with mock data.
 *
 * A device with no matching mock profile (e.g. an `other`-type sensor) has no
 * mock to fall back to, so it's always served as-is. The raw repository stays
 * real-only for ingestion, commands, and offline alert evaluation.
 */
function hasRealSensorData(status: DeviceStatus): boolean {
  return status.online && status.latest.length > 0;
}

/** True when the planned sensor backing `profile` is pinned to real data. */
function isReal(profile: mock.MockProfile, sources: DeviceDataSources): boolean {
  return sources[profile.key] === 'real';
}

/**
 * A never-/not-connected placeholder for a planned sensor pinned to real data
 * that has no registered device yet: the tile still appears, but offline with no
 * readings, so the dashboard greys it out and shows "not connected".
 */
function placeholderStatus(profile: mock.MockProfile): DeviceStatus {
  return {
    id: mock.mockDeviceId(profile),
    name: profile.name,
    type: profile.type,
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    lastIp: null,
    mac: null,
    vendorName: null,
    online: false,
    latest: [],
    // No real device behind this placeholder; show the agents' default cadence.
    reportingIntervalSec: 30,
    readingCount: 0,
    pendingSetpointC: null,
  };
}

/** Resolve a real device's status against its sensor's chosen source. */
function statusWithSource(status: DeviceStatus, sources: DeviceDataSources): DeviceStatus {
  const profile = mock.findProfileForDevice(status);
  if (!profile) return status; // no mock profile → always its own (real) data
  if (isReal(profile, sources)) return status; // real: show it, online or not
  if (hasRealSensorData(status)) return status; // mock: keep genuinely live readings
  return mock.mockStatus(profile, {
    id: status.id,
    name: status.name,
    type: status.type,
    createdAt: status.createdAt,
  });
}

export function listDeviceStatus(): DeviceStatus[] {
  const sources = getDeviceDataSources();
  const realStatuses = real.listDeviceStatus();
  const coveredProfiles = new Set<string>();
  const statuses = realStatuses.map((status) => {
    const profile = mock.findProfileForDevice(status);
    if (profile) coveredProfiles.add(mock.profileKey(profile));
    return statusWithSource(status, sources);
  });

  // Planned sensors with no registered device: synthesize a mock tile, or — when
  // pinned to real — a greyed "not connected" placeholder.
  for (const profile of mock.MOCK_PROFILES) {
    if (coveredProfiles.has(mock.profileKey(profile))) continue;
    statuses.push(isReal(profile, sources) ? placeholderStatus(profile) : mock.mockStatus(profile));
  }

  return statuses.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

export function getDeviceStatus(id: number): DeviceStatus | null {
  const sources = getDeviceDataSources();
  const realStatus = real.getDeviceStatus(id);
  if (realStatus) return statusWithSource(realStatus, sources);

  const profile = mock.profileByMockDeviceId(id);
  if (!profile) return null;
  return isReal(profile, sources) ? placeholderStatus(profile) : mock.mockStatus(profile);
}

export function getHistory(
  id: number,
  opts: { metric?: string; since?: string; limit?: number; buckets?: number },
): Reading[] | null {
  const sources = getDeviceDataSources();
  const realStatus = real.getDeviceStatus(id);
  if (realStatus) {
    const profile = mock.findProfileForDevice(realStatus);
    if (!profile || isReal(profile, sources)) return real.getHistory(id, opts);
    // mock source: serve real history when the sensor is live and actually has
    // points for the requested metric, otherwise synthesize it.
    if (hasRealSensorData(realStatus)) {
      const history = real.getHistory(id, opts);
      if (history.length > 0) return history;
    }
    return mock.mockHistory(profile, id, opts);
  }

  const profile = mock.profileByMockDeviceId(id);
  if (!profile) return null;
  // A real-pinned placeholder has no real device behind it, so no history.
  return isReal(profile, sources) ? [] : mock.mockHistory(profile, id, opts);
}

export function getMetricTotal(id: number, metric: string): number | null {
  const sources = getDeviceDataSources();
  const realStatus = real.getDeviceStatus(id);
  if (realStatus) {
    const profile = mock.findProfileForDevice(realStatus);
    if (!profile || isReal(profile, sources)) return real.getMetricTotal(id, metric);
    if (hasRealSensorData(realStatus)) {
      const hasMetric = real.getHistory(id, { metric, limit: 1 }).length > 0;
      if (hasMetric) return real.getMetricTotal(id, metric);
    }
    return mock.mockMetricTotal(metric);
  }

  const profile = mock.profileByMockDeviceId(id);
  if (!profile) return null;
  return isReal(profile, sources) ? 0 : mock.mockMetricTotal(metric);
}

export function queueSetpoint(id: number, value: number): boolean {
  const sources = getDeviceDataSources();
  const realStatus = real.getDeviceStatus(id);
  if (realStatus) {
    const profile = mock.findProfileForDevice(realStatus);
    // A real device (or a sensor pinned to real): queue the command for its
    // agent. This works even while it's offline — the agent applies it on
    // reconnect. Falls through to the mock queue only for a mock-pinned sensor
    // that isn't actually reporting.
    if (!profile || isReal(profile, sources) || hasRealSensorData(realStatus)) {
      real.queueSetpoint(id, value);
      return true;
    }
    return mock.queueMockSetpoint(id, profile, value);
  }

  const profile = mock.profileByMockDeviceId(id);
  if (!profile) return false;
  // A real-pinned placeholder has no agent to receive the command.
  return isReal(profile, sources) ? false : mock.queueMockSetpoint(id, profile, value);
}
