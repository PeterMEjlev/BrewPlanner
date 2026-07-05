'use strict';

/**
 * BrewPlanner dashboard data, spoken: fermenter status, sensor readings, and
 * active alerts. All read-only, straight from the local server's API — the
 * same data the web dashboard shows.
 */

// ── Metric formatting ────────────────────────────────────────────────────────
//
// Metrics are free-form names with a unit suffix (see SENSORS.md): temp_c,
// setpoint_c, pressure_bar, gravity_sg, power_w, energy_kwh, flow_lpm,
// water_l, hvac_state. Unknown metrics fall back to "name value" so a new
// sensor still gets spoken without a code change here.

function formatMetric(metric, value) {
  switch (metric) {
    case 'temp_c': return `temperature ${value.toFixed(1)}°C`;
    case 'setpoint_c': return `target ${value.toFixed(1)}°C`;
    case 'pressure_bar': return `pressure ${value.toFixed(2)} bar`;
    case 'gravity_sg': return `gravity ${value.toFixed(3)}`;
    case 'power_w': return `power ${Math.round(value)} watts`;
    case 'energy_kwh': return `energy ${value.toFixed(1)} kilowatt hours`;
    case 'flow_lpm': return `flow ${value.toFixed(1)} litres per minute`;
    case 'water_l': return `water ${Math.round(value)} litres`;
    // Tri-state fridge/heater output: -1 = cooling, 0 = idle, +1 = heating.
    case 'hvac_state': return value < 0 ? 'currently cooling' : value > 0 ? 'currently heating' : 'currently idle';
    default: return `${metric.replace(/_/g, ' ')} ${value}`;
  }
}

/** One spoken line for a device: "Fermenter controller — temperature 18.9°C, target 19°C, currently cooling". */
function deviceLine(device) {
  if (!device.online) return `${device.name} is offline.`;
  if (!device.latest.length) return `${device.name} is online but has no readings yet.`;
  const readings = device.latest.map((r) => formatMetric(r.metric, r.value)).join(', ');
  return `${device.name} — ${readings}.`;
}

function register(bruce, apiCall) {
  // ── Fermenter status ────────────────────────────────────────────────────

  bruce.registerFunction(
    'get_fermenter_status',
    'Get the current fermentation status: what beer is fermenting, fermenter temperature and target, whether it is cooling or heating, fermentation pressure, and gravity. Use this when the user asks how the fermenter or the beer is doing.',
    { type: 'object', properties: {}, required: [] },
    async () => {
      const [devices, active] = await Promise.all([
        apiCall('GET', '/api/devices'),
        apiCall('GET', '/api/recipe').catch(() => null),
      ]);

      const lines = [];

      const recipe = active?.recipe;
      if (recipe) {
        let brew = `Currently fermenting: ${recipe.name}`;
        if (recipe.style) brew += `, a ${recipe.style}`;
        if (recipe.abv) brew += `, target ABV ${recipe.abv}%`;
        lines.push(brew + '.');
      }

      // The fermentation-related sensors: anything named for the fermenter,
      // plus the pressure sensor and hydrometer types (there is only one of
      // each, and both sit on the fermenter).
      const fermenterDevices = devices.filter(
        (d) => /ferment/i.test(d.name) || d.type === 'pressure_sensor' || d.type === 'hydrometer'
      );

      if (fermenterDevices.length === 0) {
        lines.push('No fermenter sensors are registered.');
      } else {
        for (const device of fermenterDevices) lines.push(deviceLine(device));
      }

      return lines.join('\n');
    }
  );

  // ── All sensors / dashboard overview ────────────────────────────────────

  bruce.registerFunction(
    'get_sensor_readings',
    'Get the latest readings from BrewPlanner sensors (fermenter, brewery temperature, kegs fridge, power meter, water meter, and so on) — the same data as the dashboard. Optionally filter by a device name fragment (e.g. "power", "brewery", "kegs").',
    {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'Optional name filter — only devices whose name contains this text are included (case-insensitive)' },
      },
      required: [],
    },
    async ({ device } = {}) => {
      let devices = await apiCall('GET', '/api/devices');
      if (device) {
        const needle = device.toLowerCase();
        devices = devices.filter((d) => d.name.toLowerCase().includes(needle));
        if (devices.length === 0) return `No sensor matches "${device}".`;
      }
      if (devices.length === 0) return 'No sensors are registered yet.';

      const offline = devices.filter((d) => !d.online).length;
      const lines = devices.map(deviceLine);
      if (!device) {
        lines.unshift(
          offline === 0
            ? `All ${devices.length} sensors are online.`
            : `${devices.length - offline} of ${devices.length} sensors are online.`
        );
      }
      return lines.join('\n');
    }
  );

  // ── Active alerts ──────────────────────────────────────────────────────

  bruce.registerFunction(
    'get_active_alerts',
    'Get current BrewPlanner alerts (sensor offline, keg too old, fermentation complete). Use when the user asks if anything needs attention or whether there are any warnings.',
    { type: 'object', properties: {}, required: [] },
    async () => {
      const alerts = await apiCall('GET', '/api/alerts');
      const active = alerts.filter((a) => a.resolvedAt == null && a.dismissedAt == null);
      if (active.length === 0) return 'No active alerts — everything looks fine.';

      const lines = [`There ${active.length === 1 ? 'is 1 active alert' : `are ${active.length} active alerts`}.`];
      for (const alert of active) {
        lines.push(`${alert.severity === 'critical' ? 'Critical: ' : ''}${alert.title}. ${alert.detail}`);
      }
      return lines.join('\n');
    }
  );
}

module.exports = { register };
