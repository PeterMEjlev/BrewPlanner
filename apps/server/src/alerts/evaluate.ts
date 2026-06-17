import type { DeviceStatus, DeviceType } from '@checklist/shared';
import type { FastifyBaseLogger } from 'fastify';
import { listDeviceStatus } from '../devices/repo.js';
import { openOfflineAlert, recordAlert, resolveOfflineAlerts } from './repo.js';

/**
 * Turns live device state into durable alert history. Runs on a timer (and once
 * at boot) independently of the Telegram notifier, so the Alerts page has data
 * even when notifications are off. Each tick opens an offline alert for a device
 * that has gone stale and resolves it when the device reports again — one open
 * alert per outage, deduped via {@link openOfflineAlert}.
 */

const TYPE_LABEL: Record<DeviceType, string> = {
  pressure_sensor: 'Pressure',
  brew_controller: 'Controller',
  power_meter: 'Power',
  water_meter: 'Water',
  hydrometer: 'Hydrometer',
  other: 'Device',
};

/** Evaluate every device's online state and record/resolve offline alerts. */
export function evaluateDeviceAlerts(log: FastifyBaseLogger): void {
  let devices: DeviceStatus[];
  try {
    devices = listDeviceStatus();
  } catch (err) {
    log.error(err, 'alert evaluation failed to load devices');
    return;
  }

  for (const d of devices) {
    try {
      if (d.online) {
        resolveOfflineAlerts(d.id);
        continue;
      }
      // Skip devices that have never reported: an offline alert means "stopped
      // reporting", not "was registered but never connected".
      if (!d.lastSeenAt) continue;
      if (openOfflineAlert(d.id)) continue; // already alerting on this outage

      recordAlert({
        deviceId: d.id,
        source: 'device_offline',
        severity: 'critical',
        title: `${d.name} offline`,
        detail: `${TYPE_LABEL[d.type]} sensor hasn't reported recently.`,
      });
      log.info(`Recorded offline alert for device ${d.id} (${d.name}).`);
    } catch (err) {
      log.error(err, `alert evaluation failed for device ${d.id}`);
    }
  }
}
