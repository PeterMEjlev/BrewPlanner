'use strict';

/**
 * The sensor fleet itself — which satellites are reporting, how they are
 * configured, and what the Inkbird controllers are doing.
 *
 * Deliberately separate from src/functions/stats.js, which reads the *values*
 * the sensors produce (the dashboard's numbers). This module answers the other
 * question: is the thing that produces them actually alive, how often does it
 * log, and where does it live on the network. "How warm is the brewery" is
 * stats; "is the brewery sensor still online" is here.
 */

/** Seconds the API will accept for a logging cadence (see REPORTING_INTERVAL_SEC). */
const INTERVAL_MIN_SEC = 5;
const INTERVAL_MAX_SEC = 3600;

// ── Speech helpers ──────────────────────────────────────────────────────────

/** "4 minutes ago" — lastSeenAt is a real ISO-8601 UTC string, so this is safe. */
function ago(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'at an unknown time';
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} second${sec !== 1 ? 's' : ''} ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min !== 1 ? 's' : ''} ago`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days !== 1 ? 's' : ''} ago`;
}

/** "every 30 seconds" / "every 5 minutes" — whole minutes read better aloud. */
function cadence(seconds) {
  if (!Number.isFinite(seconds)) return 'on an unknown schedule';
  if (seconds % 60 === 0 && seconds >= 60) {
    const min = seconds / 60;
    return `every ${min} minute${min !== 1 ? 's' : ''}`;
  }
  return `every ${seconds} second${seconds !== 1 ? 's' : ''}`;
}

/** Human name for a device type, for the fleet listing. */
function typeLabel(type) {
  switch (type) {
    case 'brew_controller': return 'Inkbird controller';
    case 'pressure_sensor': return 'pressure sensor';
    case 'power_meter': return 'power meter';
    case 'water_meter': return 'water meter';
    case 'hydrometer': return 'hydrometer';
    default: return 'sensor';
  }
}

function reading(device, metric) {
  return (device.latest || []).find((r) => r.metric === metric);
}

/** -1 cooling, 0 idle, +1 heating — the tri-state fridge/heater output. */
function hvacWord(value) {
  return value < 0 ? 'cooling' : value > 0 ? 'heating' : 'idle';
}

/** Devices whose name contains `needle`, or all of them when nothing was asked. */
function filterByName(devices, needle) {
  if (!needle) return devices;
  const text = String(needle).toLowerCase();
  return devices.filter(
    (d) =>
      d.name.toLowerCase().includes(text) ||
      (d.vendorName || '').toLowerCase().includes(text),
  );
}

function register(bruce, apiCall) {
  // ── Fleet health ────────────────────────────────────────────────────────

  bruce.registerFunction(
    'get_device_status',
    'Check the sensor fleet itself: which devices are online or offline, when each last reported, how often it logs, and its network details. Use for "are all the sensors online?", "when did the power meter last report?", "how often does the fermenter log?". For the actual measurements — temperatures, pressure, gravity — call get_sensor_readings instead.',
    {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'Optional name filter — only devices whose name contains this text' },
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          description: '"summary" (default) is online/offline and last-seen; "full" adds logging interval, IP, MAC and how much each has logged',
        },
      },
      required: [],
    },
    async ({ device, detail = 'summary' } = {}) => {
      const all = await apiCall('GET', '/api/devices');
      if (all.length === 0) return 'No devices are registered yet.';

      const devices = filterByName(all, device);
      if (devices.length === 0) return `No device matches "${device}".`;

      const offline = devices.filter((d) => !d.online);
      const lines = [];

      if (!device) {
        lines.push(
          offline.length === 0
            ? `All ${devices.length} devices are online.`
            : `${devices.length - offline.length} of ${devices.length} devices are online. Offline: ${offline.map((d) => d.name).join(', ')}.`,
        );
      }

      for (const d of devices) {
        const parts = [`${d.name}, a ${typeLabel(d.type)}, is ${d.online ? 'online' : 'offline'}`];
        parts.push(`last reported ${ago(d.lastSeenAt)}`);
        if (detail === 'full') {
          parts.push(`logging ${cadence(d.reportingIntervalSec)}`);
          if (d.lastIp) parts.push(`at ${d.lastIp}`);
          if (d.vendorName) parts.push(`known as "${d.vendorName}" in its own app`);
          if (d.mac) parts.push(`MAC ${d.mac}`);
          if (d.readingCount != null) parts.push(`${d.readingCount.toLocaleString()} readings logged`);
        }
        lines.push(parts.join(', ') + '.');
      }

      return lines.join('\n');
    },
  );

  // ── The Inkbirds ────────────────────────────────────────────────────────
  //
  // Three ITC-308-WIFI controllers do most of the work in this brewery — the
  // fermenter fridge, the filled-keg fridge, and the brewery's own ambient
  // thermometer — and "how are the Inkbirds doing" is one question, not three.

  bruce.registerFunction(
    'get_inkbird_status',
    'Report the Inkbird temperature controllers — the fermenter fridge, the keg fridge and the brewery thermometer. Gives each one\'s current temperature, its target, whether it is cooling, heating or idle, any setpoint still waiting to be applied, and whether it is online. Use for "how are the Inkbirds?", "what\'s the keg fridge doing?", "is the fermenter fridge cooling?". Change a target with set_controller_setpoint.',
    {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'Optional name filter — e.g. "fermenter", "kegs", "brewery"' },
      },
      required: [],
    },
    async ({ device } = {}) => {
      const all = await apiCall('GET', '/api/devices');
      const controllers = filterByName(
        all.filter((d) => d.type === 'brew_controller'),
        device,
      );

      if (controllers.length === 0) {
        return device
          ? `No Inkbird controller matches "${device}".`
          : 'No Inkbird controllers are registered.';
      }

      const lines = [];
      for (const d of controllers) {
        if (!d.online) {
          lines.push(`${d.name} is offline — it last reported ${ago(d.lastSeenAt)}.`);
          continue;
        }

        const temp = reading(d, 'temp_c');
        const setpoint = reading(d, 'setpoint_c');
        const hvac = reading(d, 'hvac_state');

        if (!temp && !setpoint) {
          lines.push(`${d.name} is online but has not logged a temperature yet.`);
          continue;
        }

        const parts = [];
        if (temp) parts.push(`${temp.value.toFixed(1)}°C`);
        if (setpoint) parts.push(`target ${setpoint.value.toFixed(1)}°C`);
        if (hvac) parts.push(`currently ${hvacWord(hvac.value)}`);
        let line = `${d.name} — ${parts.join(', ')}`;
        if (d.pendingSetpointC != null) {
          line += `, with a change to ${d.pendingSetpointC}°C still waiting to reach the controller`;
        }
        lines.push(line + '.');
      }
      return lines.join('\n');
    },
  );

  // ── Logging cadence ─────────────────────────────────────────────────────

  bruce.registerFunction(
    'set_device_interval',
    'Change how often a device logs a reading. The agent picks the new cadence up on its next push, so it takes effect within one interval. Use for "log the fermenter every minute today" or "the power meter is too chatty, make it five minutes". Between 5 seconds and 1 hour.',
    {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'Which device, by name fragment — e.g. "fermenter", "power"' },
        seconds: { type: 'number', description: 'Seconds between readings (5–3600)' },
      },
      required: ['device', 'seconds'],
    },
    async ({ device, seconds }) => {
      const value = Math.round(seconds);
      if (!Number.isFinite(value) || value < INTERVAL_MIN_SEC || value > INTERVAL_MAX_SEC) {
        return `The logging interval must be between ${INTERVAL_MIN_SEC} seconds and 1 hour.`;
      }

      const all = await apiCall('GET', '/api/devices');
      const matches = filterByName(all, device);
      if (matches.length === 0) {
        return `No device matches "${device}". Registered devices: ${all.map((d) => d.name).join(', ')}.`;
      }
      if (matches.length > 1) {
        return `Several devices match "${device}" — ask the user which one: ${matches.map((d) => d.name).join(', ')}.`;
      }

      const target = matches[0];
      await apiCall('PATCH', `/api/devices/${target.id}`, { reportingIntervalSec: value });
      return `${target.name} will now log ${cadence(value)}, from its next push.`;
    },
  );
}

module.exports = { register };
