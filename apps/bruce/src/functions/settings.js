'use strict';

/**
 * BrewPlanner's settings, read and changed by voice.
 *
 * Five separate resources sit behind one spoken idea of "settings": alert
 * preferences, what a blank brew sheet opens on, the chart palette, the keg
 * colours, and which sensors show mock data instead of their real agent's.
 * Bruce reads any of them, and can change all five.
 *
 * Every one of those endpoints takes the *whole* object — the schemas require
 * every field — so each setter reads the current values first and sends them
 * back with one thing changed. A voice edit of "keg alerts at 21 days" must not
 * silently reset the fermentation-done alert.
 */

// ── Field maps ──────────────────────────────────────────────────────────────
//
// Each entry is [apiKey, spokenLabel, ...aliases]. The aliases are what a
// person actually says: "the beer line", "electricity", "the keg fridge".

const GRAPH_LINES = [
  ['pressure', 'fermentation pressure', 'pressure'],
  ['gravity', 'gravity', 'tilt', 'hydrometer'],
  ['power', 'power', 'electricity', 'watts', 'power meter'],
  ['water', 'water', 'water meter'],
  ['beerTemp', 'beer temperature', 'beer', 'wort', 'wort temperature'],
  ['fridgeTemp', 'fridge temperature', 'fridge', 'ambient', 'ambient temperature'],
  ['setpoint', 'target temperature line', 'setpoint', 'target'],
];

const SENSOR_SOURCES = [
  ['fermenter_pressure', 'fermenter pressure sensor', 'pressure'],
  ['fermenter_controller', 'fermenter controller', 'fermenter fridge', 'fermenter'],
  ['kegs_controller', 'kegs controller', 'keg fridge', 'kegs'],
  ['brewery_temp', 'brewery thermometer', 'brewery', 'brewery temperature'],
  ['power', 'power meter', 'electricity'],
  ['water', 'water meter'],
  ['fermenter_gravity', 'fermenter gravity', 'tilt', 'hydrometer'],
];

/**
 * The recipe-default fields Bruce may set, as [apiKey, spokenLabel, unit].
 * `batchTarget` and `pitchRate` are free text on the Settings page and are read
 * out but not set here — "Manufacturer recommended" is not something anyone
 * dictates, and a typo in it silently changes every new recipe.
 */
const RECIPE_DEFAULT_FIELDS = [
  ['batchSizeL', 'batch size', 'litres', 1, 10000],
  ['boilTimeMinutes', 'boil time', 'minutes', 0, 1000],
  ['efficiencyPercent', 'brewhouse efficiency', 'percent', 1, 100],
  ['boilOffLPerHour', 'boil-off rate', 'litres per hour', 0, 1000],
  ['trubChillerLossL', 'trub and chiller loss', 'litres', 0, 10000],
  ['mashThicknessLPerKg', 'mash thickness', 'litres per kilo', 0.1, 100],
  ['mashStrikeTempC', 'strike temperature', '°C', 0, 120],
  ['mashTargetTempC', 'mash temperature', '°C', 0, 120],
  ['mashStepMinutes', 'mash rest length', 'minutes', 0, 1000],
];

/**
 * Colours by name, because nobody dictates a hex triplet. Values are the ones
 * the dashboard already uses for these lines, so "make the power line yellow"
 * lands on the shade the app was designed around rather than pure #ffff00.
 */
const NAMED_COLORS = {
  red: '#ef4444',
  orange: '#fb923c',
  amber: '#f59e0b',
  yellow: '#eab308',
  gold: '#dec05c',
  green: '#22c55e',
  teal: '#14b8a6',
  cyan: '#22d3ee',
  blue: '#3b82f6',
  'light blue': '#7dd3fc',
  indigo: '#6366f1',
  purple: '#a78bfa',
  violet: '#a78bfa',
  magenta: '#e879f9',
  pink: '#f472b6',
  brown: '#7a3b1a',
  black: '#111111',
  grey: '#707070',
  gray: '#707070',
  white: '#ffffff',
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalize(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve a spoken name to one entry of a field map. Exact alias first, then
 * anything containing the phrase — so "the beer line" finds `beerTemp` without
 * also matching `fridgeTemp`, whose aliases share no word with it.
 */
function pickField(fields, spoken) {
  const target = normalize(spoken);
  if (!target) return null;

  for (const field of fields) {
    if (field.slice(1).some((alias) => normalize(alias) === target)) return field;
  }
  const partial = fields.filter((field) =>
    field.slice(1).some((alias) => {
      const a = normalize(alias);
      return a.includes(target) || target.includes(a);
    }),
  );
  return partial.length === 1 ? partial[0] : null;
}

/** `#rrggbb` from a hex string or a colour name; null when neither. */
function resolveColor(spoken) {
  const raw = String(spoken == null ? '' : spoken).trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
  const named = NAMED_COLORS[normalize(raw)];
  return named || null;
}

/** The colour names Bruce can offer when he was given something unusable. */
function colorNameList() {
  return Object.keys(NAMED_COLORS).filter((name) => name !== 'gray' && name !== 'violet').join(', ');
}

function register(bruce, apiCall) {
  // ── Reading settings ────────────────────────────────────────────────────

  bruce.registerFunction(
    'get_settings',
    'Read BrewPlanner\'s settings: alert preferences (keg age, fermentation done), what a blank recipe starts from (batch size, boil time, efficiency, mash figures), the chart colours, the keg colours, and which sensors are showing mock demo data instead of their real readings. Ask for one section unless the user wants everything.',
    {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['all', 'notifications', 'recipe_defaults', 'graph_colors', 'keg_colors', 'device_sources'],
          description: 'Which settings to read (default "all")',
        },
      },
      required: [],
    },
    async ({ section = 'all' } = {}) => {
      const want = (name) => section === 'all' || section === name;
      const lines = [];

      if (want('notifications')) {
        const n = await apiCall('GET', '/api/notifications/settings');
        lines.push(
          `Alerts — keg age alert is ${n.kegAlertEnabled ? `on, at ${n.kegAlertDays} days` : 'off'}; the fermentation-complete alert is ${n.fermentDoneEnabled ? 'on' : 'off'}.`,
        );
      }

      if (want('recipe_defaults')) {
        const d = await apiCall('GET', '/api/recipe-defaults');
        lines.push(
          `New recipes start at ${d.batchSizeL} litres into the ${String(d.batchTarget).toLowerCase()}, ${d.boilTimeMinutes} minute boil, ${d.efficiencyPercent}% efficiency, boiling off ${d.boilOffLPerHour} litres an hour with ${d.trubChillerLossL} litres lost to trub. Mash: ${d.mashThicknessLPerKg} litres per kilo, strike at ${d.mashStrikeTempC}°C for a ${d.mashTargetTempC}°C rest of ${d.mashStepMinutes} minutes. Pitch rate: ${d.pitchRate}.`,
        );
      }

      if (want('graph_colors')) {
        const c = await apiCall('GET', '/api/graph-colors');
        const parts = GRAPH_LINES.map(([key, label]) => `${label} ${c[key]}`);
        lines.push(`Graph colours — ${parts.join(', ')}.`);
      }

      if (want('keg_colors')) {
        const c = await apiCall('GET', '/api/keg-content-colors');
        const parts = Object.entries(c).map(([content, hex]) => `${content} ${hex}`);
        lines.push(`Keg colours — ${parts.join(', ')}.`);
      }

      if (want('device_sources')) {
        const s = await apiCall('GET', '/api/device-sources');
        const mock = SENSOR_SOURCES.filter(([key]) => s[key] === 'mock').map(([, label]) => label);
        lines.push(
          mock.length === 0
            ? 'Every sensor is showing its real readings.'
            : `Showing mock demo data instead of real readings: ${mock.join(', ')}. The rest are real.`,
        );
      }

      return lines.length ? lines.join('\n') : 'I do not have a settings section by that name.';
    },
  );

  // ── Alert preferences ───────────────────────────────────────────────────

  bruce.registerFunction(
    'set_notification_settings',
    'Change the alert preferences: whether a keg raises an alert once it has been full for a while (and after how many days), and whether an alert fires when fermentation looks finished. Use for "stop nagging me about old kegs", "warn me when a keg is three weeks old", "tell me when fermentation is done". Only send the fields the user actually changed.',
    {
      type: 'object',
      properties: {
        keg_alert_enabled: { type: 'boolean', description: 'Whether old kegs raise an alert' },
        keg_alert_days: { type: 'number', description: 'Age in days at which a keg raises one (1–365)' },
        ferment_done_enabled: { type: 'boolean', description: 'Whether a finished fermentation raises an alert' },
      },
      required: [],
    },
    async ({ keg_alert_enabled, keg_alert_days, ferment_done_enabled } = {}) => {
      if (keg_alert_enabled == null && keg_alert_days == null && ferment_done_enabled == null) {
        return 'Tell me which alert setting to change before I change anything.';
      }
      if (keg_alert_days != null && (keg_alert_days < 1 || keg_alert_days > 365)) {
        return 'The keg alert age must be between 1 and 365 days.';
      }

      const current = await apiCall('GET', '/api/notifications/settings');
      const next = {
        kegAlertEnabled: keg_alert_enabled != null ? keg_alert_enabled : current.kegAlertEnabled,
        kegAlertDays: keg_alert_days != null ? Math.round(keg_alert_days) : current.kegAlertDays,
        fermentDoneEnabled:
          ferment_done_enabled != null ? ferment_done_enabled : current.fermentDoneEnabled,
      };
      await apiCall('PUT', '/api/notifications/settings', next);

      const changes = [];
      if (keg_alert_enabled != null) changes.push(`keg age alerts ${next.kegAlertEnabled ? 'on' : 'off'}`);
      if (keg_alert_days != null) changes.push(`keg age threshold ${next.kegAlertDays} days`);
      if (ferment_done_enabled != null) {
        changes.push(`fermentation-complete alerts ${next.fermentDoneEnabled ? 'on' : 'off'}`);
      }
      return `Alert settings updated: ${changes.join(', ')}.`;
    },
  );

  // ── What a new recipe starts from ───────────────────────────────────────

  bruce.registerFunction(
    'set_recipe_defaults',
    'Change the figures a blank brew sheet opens on — batch size, boil time, brewhouse efficiency, boil-off rate, trub loss, and the mash figures (thickness, strike and target temperature, rest length). These describe the brewhouse, so they apply to every new recipe on every screen. Recipes already saved are never touched. Only send the fields the user changed.',
    {
      type: 'object',
      properties: {
        batch_size_l: { type: 'number', description: 'Litres into the fermenter' },
        boil_time_minutes: { type: 'number', description: 'Boil length in minutes' },
        efficiency_percent: { type: 'number', description: 'Brewhouse efficiency %' },
        boil_off_l_per_hour: { type: 'number', description: 'Litres the kettle boils off per hour' },
        trub_chiller_loss_l: { type: 'number', description: 'Litres left behind with the trub' },
        mash_thickness_l_per_kg: { type: 'number', description: 'Strike water per kilo of grain' },
        mash_strike_temp_c: { type: 'number', description: 'Strike water temperature in °C' },
        mash_target_temp_c: { type: 'number', description: 'Temperature the mash settles to, °C' },
        mash_step_minutes: { type: 'number', description: 'How long the first rest holds' },
      },
      required: [],
    },
    async (args = {}) => {
      // Voice arguments are snake_case; the API is camelCase.
      const wanted = {
        batchSizeL: args.batch_size_l,
        boilTimeMinutes: args.boil_time_minutes,
        efficiencyPercent: args.efficiency_percent,
        boilOffLPerHour: args.boil_off_l_per_hour,
        trubChillerLossL: args.trub_chiller_loss_l,
        mashThicknessLPerKg: args.mash_thickness_l_per_kg,
        mashStrikeTempC: args.mash_strike_temp_c,
        mashTargetTempC: args.mash_target_temp_c,
        mashStepMinutes: args.mash_step_minutes,
      };

      const given = RECIPE_DEFAULT_FIELDS.filter(([key]) => wanted[key] != null);
      if (given.length === 0) return 'Tell me which recipe default to change before I change anything.';

      for (const [key, label, unit, min, max] of given) {
        const v = wanted[key];
        if (!Number.isFinite(v) || v < min || v > max) {
          return `The ${label} must be between ${min} and ${max} ${unit}.`;
        }
      }

      const current = await apiCall('GET', '/api/recipe-defaults');
      const next = { ...current };
      for (const [key] of given) next[key] = wanted[key];
      await apiCall('PUT', '/api/recipe-defaults', next);

      const changes = given.map(([key, label, unit]) => `${label} ${next[key]} ${unit}`);
      return `New recipes will now start with ${changes.join(', ')}.`;
    },
  );

  // ── Colours ─────────────────────────────────────────────────────────────

  bruce.registerFunction(
    'set_graph_color',
    'Recolour one line on the charts — pressure, gravity, power, water, beer temperature, fridge temperature, or the target-temperature line. The palette is shared, so the change shows on the desktop dashboard and the brewery kiosk alike. Colours can be given by name ("make the power line yellow") or as a #rrggbb hex value.',
    {
      type: 'object',
      properties: {
        line: { type: 'string', description: 'Which line — e.g. "power", "beer temperature", "setpoint"' },
        color: { type: 'string', description: 'A colour name (e.g. "amber") or a #rrggbb hex value' },
      },
      required: ['line', 'color'],
    },
    async ({ line, color }) => {
      const field = pickField(GRAPH_LINES, line);
      if (!field) {
        return `I am not sure which line "${line}" is. The chart lines are: ${GRAPH_LINES.map(([, label]) => label).join(', ')}.`;
      }
      const hex = resolveColor(color);
      if (!hex) {
        return `I could not turn "${color}" into a colour. Try one of: ${colorNameList()}, or a hex value like #22d3ee.`;
      }

      const [key, label] = field;
      const current = await apiCall('GET', '/api/graph-colors');
      await apiCall('PUT', '/api/graph-colors', { ...current, [key]: hex });
      return `The ${label} line is now ${hex}.`;
    },
  );

  bruce.registerFunction(
    'set_keg_color',
    'Recolour one beer or keg state on the keg board — IPA, NEIPA, Stout, Sour, Clean, Dirty and so on. Call get_settings with section "keg_colors" first if you are not sure which contents exist. Colours can be given by name or as a #rrggbb hex value.',
    {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The keg content or state, e.g. "NEIPA", "Stout", "Clean"' },
        color: { type: 'string', description: 'A colour name (e.g. "amber") or a #rrggbb hex value' },
      },
      required: ['content', 'color'],
    },
    async ({ content, color }) => {
      const current = await apiCall('GET', '/api/keg-content-colors');
      // The palette's own keys are the field map here — the keg contents are
      // the brewery's, not a fixed list this file should carry a copy of.
      const fields = Object.keys(current).map((key) => [key, key]);
      const field = pickField(fields, content);
      if (!field) {
        return `There is no keg content called "${content}". The ones with colours are: ${Object.keys(current).join(', ')}.`;
      }
      const hex = resolveColor(color);
      if (!hex) {
        return `I could not turn "${color}" into a colour. Try one of: ${colorNameList()}, or a hex value like #c8782a.`;
      }

      const [key] = field;
      await apiCall('PUT', '/api/keg-content-colors', { ...current, [key]: hex });
      return `${key} kegs are now ${hex}.`;
    },
  );

  // ── Mock vs. real telemetry ─────────────────────────────────────────────

  bruce.registerFunction(
    'set_device_source',
    'Switch one sensor between its real readings and the built-in mock demo data. Setting a sensor to mock makes the dashboard show invented numbers for it on every screen — say so plainly when you confirm the change. Use "real" to put an actual sensor back; a real sensor that is not reporting then shows as not connected rather than quietly reading as mock.',
    {
      type: 'object',
      properties: {
        sensor: { type: 'string', description: 'Which sensor — e.g. "fermenter controller", "power meter", "brewery"' },
        source: { type: 'string', enum: ['real', 'mock'], description: '"real" = the sensor\'s own readings, "mock" = invented demo data' },
      },
      required: ['sensor', 'source'],
    },
    async ({ sensor, source }) => {
      const field = pickField(SENSOR_SOURCES, sensor);
      if (!field) {
        return `I am not sure which sensor "${sensor}" is. The ones that can be switched are: ${SENSOR_SOURCES.map(([, label]) => label).join(', ')}.`;
      }

      const [key, label] = field;
      const current = await apiCall('GET', '/api/device-sources');
      if (current[key] === source) {
        return `The ${label} is already set to ${source === 'mock' ? 'mock demo data' : 'its real readings'}.`;
      }
      await apiCall('PUT', '/api/device-sources', { ...current, [key]: source });

      return source === 'mock'
        ? `The ${label} is now showing mock demo data — every screen will show invented numbers for it until you switch it back to real.`
        : `The ${label} is now showing its real readings. If it is not reporting, it will show as not connected.`;
    },
  );
}

module.exports = { register, pickField, resolveColor, GRAPH_LINES, SENSOR_SOURCES };
