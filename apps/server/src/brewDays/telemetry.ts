import type { BrewDay, BrewDayFermentation, Device } from '@checklist/shared';
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { db } from '../db/index.js';
import { readings } from '../db/schema.js';
import { listDevices } from '../devices/repo.js';
import { tempStats } from './repo.js';

/**
 * The fermentation half of a brew day's record, read out of the telemetry the
 * hub is already collecting.
 *
 * Derived on every read rather than copied onto the brew day: the readings are
 * the record, and the window they're read over moves whenever the brewer
 * corrects the pitch or package date. The one thing it can't recover is a window
 * that has aged past READINGS_RETENTION_DAYS — those samples are gone, and an
 * old batch then simply reports nothing rather than a partial average, which is
 * why the rig's brew-day curve gets its own unpruned table instead.
 */

/** The metric the Inkbird and Tilt agents both report temperature under. */
const TEMP_METRIC = 'temp_c';
/** The Tilt's specific gravity. */
const GRAVITY_METRIC = 'gravity_sg';

/**
 * Devices that measure the fermenter, as opposed to the room or the keg fridge.
 * The same rule the dashboard groups its fermenter station by: pressure sensors
 * and hydrometers are always the tank, and a temperature controller is too
 * unless its name says it's watching the brewery or the kegs.
 */
function fermenterDevices(): Device[] {
  return listDevices().filter(
    (device) =>
      device.type === 'pressure_sensor' ||
      device.type === 'hydrometer' ||
      (device.type === 'brew_controller' && !/keg|brewery|ambient/i.test(device.name)),
  );
}

/** Readings for one metric from a set of devices, within a window, oldest first. */
function windowReadings(
  deviceIds: number[],
  metric: string,
  from: string,
  to: string,
): { deviceId: number; value: number }[] {
  if (deviceIds.length === 0) return [];
  return db
    .select({ deviceId: readings.deviceId, value: readings.value })
    .from(readings)
    .where(
      and(
        inArray(readings.deviceId, deviceIds),
        eq(readings.metric, metric),
        gte(readings.recordedAt, from),
        lte(readings.recordedAt, to),
      ),
    )
    .orderBy(asc(readings.recordedAt))
    .all();
}

/** Whole days between two instants, floored; null when the window is nonsense. */
function daysBetween(from: string, to: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.floor((end - start) / (24 * 60 * 60 * 1000));
}

export function fermentationSummary(brewDay: BrewDay): BrewDayFermentation {
  // Pitching is the honest start; before it's recorded, the brew day itself is
  // the best the log has. The end is packaging, or now while it's still going.
  const from = brewDay.pitchedAt ?? brewDay.brewedAt;
  const to = brewDay.packagedAt ?? new Date().toISOString();
  const empty: BrewDayFermentation = {
    temp: null,
    gravity: null,
    days: daysBetween(from, to),
    deviceName: null,
  };
  if (Date.parse(to) < Date.parse(from)) return empty;

  const devices = fermenterDevices();
  if (devices.length === 0) return empty;
  const byId = new Map(devices.map((device) => [device.id, device]));
  const ids = devices.map((device) => device.id);

  const temps = windowReadings(ids, TEMP_METRIC, from, to);
  const gravities = windowReadings(ids, GRAVITY_METRIC, from, to);

  const gravityValues = gravities.map((row) => row.value);
  return {
    temp: tempStats(temps.map((row) => row.value)),
    gravity:
      gravityValues.length === 0
        ? null
        : {
            start: gravityValues[0]!,
            end: gravityValues[gravityValues.length - 1]!,
            min: Math.min(...gravityValues),
            max: Math.max(...gravityValues),
            count: gravityValues.length,
          },
    days: empty.days,
    // Name the device the temperatures actually came from, so the caption isn't
    // claiming a station that reported nothing for this batch.
    deviceName: temps.length > 0 ? (byId.get(temps[0]!.deviceId)?.name ?? null) : null,
  };
}
