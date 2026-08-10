import type { DeviceStatus, DeviceType } from '@checklist/shared';
import type { FastifyBaseLogger } from 'fastify';
import { isCriticalSensor } from '../devices/catalog.js';
import { listDeviceStatus } from '../devices/repo.js';
import { pushToEveryone } from '../notify/push.js';
import { getNotificationSettings } from '../repo.js';
import { openAlert, recordAlert, resolveAlerts } from './repo.js';

/**
 * Turns live device state into durable alert history. Runs on a timer (and once
 * at boot) independently of the notification scheduler, so the Alerts page has
 * data even when every notification is switched off. Each tick opens an offline
 * alert for a device that has gone stale and resolves it when the device reports
 * again — one open alert per outage, deduped via {@link openAlert}.
 *
 * A sensor going quiet is also the only warning you get that a batch is
 * unwatched, so an outage on one of the {@link isCriticalSensor} devices is
 * pushed to the phones as well. The rest are recorded and left on the page.
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

  const pushOffline = getNotificationSettings().sensorOfflineEnabled;

  for (const d of devices) {
    try {
      if (d.online) {
        resolveAlerts('device_offline', d.id);
        continue;
      }
      // Skip devices that have never reported: an offline alert means "stopped
      // reporting", not "was registered but never connected".
      if (!d.lastSeenAt) continue;
      if (openAlert('device_offline', d.id)) continue; // already alerting on this outage

      const title = `${d.name} offline`;
      const detail = `${TYPE_LABEL[d.type]} sensor hasn't reported recently.`;
      recordAlert({ deviceId: d.id, source: 'device_offline', severity: 'critical', title, detail });
      log.info(`Recorded offline alert for device ${d.id} (${d.name}).`);

      if (pushOffline && isCriticalSensor(d)) {
        // Not awaited: this loop keeps the alert history moving, and a push that
        // fails is never worth holding the tick up for.
        void pushToEveryone(
          {
            title,
            body: `${detail} The brewery is running unwatched until it comes back.`,
            path: '/devices',
            critical: true,
            collapseKey: `device_offline:${d.id}`,
          },
          log,
        );
      }
    } catch (err) {
      log.error(err, `alert evaluation failed for device ${d.id}`);
    }
  }
}
