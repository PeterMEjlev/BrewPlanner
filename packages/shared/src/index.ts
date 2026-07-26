import { z } from 'zod';

/**
 * Shared types and validation schemas used by both the server and the web app.
 * Keeping these in one place guarantees the API contract stays in sync.
 */

// ---------------------------------------------------------------------------
// Domain models (shapes returned by the API)
// ---------------------------------------------------------------------------

export interface Checklist {
  id: number;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Step {
  id: number;
  checklistId: number;
  position: number;
  text: string;
  /** Optional longer explanation shown behind an info icon on the display. */
  description: string | null;
  required: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A checklist together with its ordered steps (admin detail view). */
export interface ChecklistWithSteps extends Checklist {
  steps: Step[];
}

/** A checklist row in the admin list, with a precomputed step count. */
export interface ChecklistSummary extends Checklist {
  stepCount: number;
}

/** A step enriched with the current run's check state (display view). */
export interface DisplayStep extends Step {
  checked: boolean;
  checkedAt: string | null;
}

/** Payload for the /display page and GET /api/active. */
export interface ActiveState {
  checklist: Checklist | null;
  runId: number | null;
  steps: DisplayStep[];
  progress: { completed: number; total: number };
}

/**
 * A brewery to-do item. This is a standalone, ongoing list — intentionally
 * separate from procedure checklists (no steps, no runs, no progress reset).
 */
export interface Todo {
  id: number;
  text: string;
  /** Optional longer explanation shown behind an info icon on the display. */
  description: string | null;
  done: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
}

/**
 * Account privilege. `admin` can do everything (control devices, edit kegs,
 * manage settings and other accounts); `guest` is read-only — it can view the
 * dashboard and graphs but cannot change anything, and cannot open the Brew
 * System page. Trusted-local requests (the Pi kiosk on the LAN) are treated as
 * admin-equivalent regardless of role; see `AuthState.isLocal`.
 */
export type UserRole = 'admin' | 'guest';

/**
 * An authenticated user. The password hash never leaves the server, so the
 * shape exposed to the client is intentionally just the public fields.
 */
export interface User {
  id: number;
  username: string;
  role: UserRole;
  createdAt: string;
}

/**
 * Result of GET /api/auth/me. `isLocal` is true when the request reached the
 * server directly on the LAN/loopback (e.g. the Pi's own kiosk) rather than
 * through the public Cloudflare tunnel — those requests are trusted without a
 * login so operators are never locked out of the physical touchscreen.
 */
export interface AuthState {
  user: User | null;
  isLocal: boolean;
}

// ---------------------------------------------------------------------------
// Brewer's Friend recipes
// ---------------------------------------------------------------------------

/**
 * A recipe from the user's Brewer's Friend account, normalized down to the
 * fields the list views need. The server proxies the Brewer's Friend API (key
 * held server-side) and maps each recipe to this shape. The full brew sheet —
 * ingredients, mash, water — is a separate, heavier fetch: {@link RecipeDetail}.
 */
export interface Recipe {
  id: string;
  name: string;
  /** Beer style (e.g. "West Coast IPA"); may be empty if the recipe has none. */
  style: string;
  /** Target ABV as a bare number string (e.g. "5.2"); empty if unknown. */
  abv: string;
  /** Public Brewer's Friend recipe page URL; empty if unknown. */
  url: string;
  /**
   * Bitterness (Tinseth IBU) as a bare number string; empty if unknown.
   * Optional because the stored "active recipe" predates these two fields —
   * a selection saved by an older build won't have them.
   */
  ibu?: string;
  /** Colour in EBC as a bare number string; empty if unknown. */
  ebc?: string;
}

/**
 * The single "currently in the fermenter" recipe selection (GET/PUT /api/recipe).
 * `recipe` is null when nothing has been chosen yet.
 */
export interface ActiveRecipe {
  recipe: Recipe | null;
}

/** One malt/sugar in a recipe's grain bill. */
export interface RecipeFermentable {
  name: string;
  /** Amount as written in the recipe, with `unit` (kg, g, lb, oz). */
  amount: string;
  unit: string;
  /** Share of the total grain bill, as a bare number string; may be empty. */
  percent: string;
  /** Grain colour in EBC, converted from the API's Lovibond; null if unknown. */
  ebc: number | null;
}

/**
 * How a hop addition gets used, normalized into the stages a brewer works in.
 * Brewer's Friend's own `hopuse` strings carry qualifiers ("Dry Hop (High
 * Krausen)"), so they're grouped down to these to drive the hop schedule's
 * sub-sections; the original string stays on the addition as `use`.
 */
export type HopStage = 'Mash' | 'First Wort' | 'Boil' | 'Whirlpool' | 'Dry Hop' | 'Other';

/** Hop stages in the order they happen on brew day, for grouped display. */
export const HOP_STAGE_ORDER: HopStage[] = [
  'Mash',
  'First Wort',
  'Boil',
  'Whirlpool',
  'Dry Hop',
  'Other',
];

/** One hop addition. */
export interface RecipeHop {
  name: string;
  amount: string;
  unit: string;
  /** The recipe's own wording, e.g. "Dry Hop (High Krausen)". */
  use: string;
  /** `use` reduced to a brew-day stage, for grouping. */
  stage: HopStage;
  /** Contact time as a bare number string; the unit is `timeUnit`. */
  time: string;
  /**
   * What `time` is measured in. Boil and whirlpool additions are minutes; dry
   * hops are days (Brewer's Friend stores them that way, so rendering them as
   * minutes turns a 5-day dry hop into "5 min"). Empty when there's no time.
   */
  timeUnit: 'min' | 'day' | '';
  /** Alpha acid %, as a bare number string. */
  aa: string;
  /** This addition's own IBU contribution. */
  ibu: string;
  /**
   * Whirlpool/hopstand temperature in °C — only set where it means something
   * (a whirlpool/hopstand). Empty elsewhere, including for the boiling-point
   * placeholder the API returns on additions that have no hopstand.
   */
  temp: string;
}

/** A yeast (or bacteria/brett) pitch. */
export interface RecipeYeast {
  name: string;
  /** Producer, e.g. "Fermentis". */
  lab: string;
  /** Expected apparent attenuation %, as a bare number string. */
  attenuation: string;
  amount: string;
  amountUnit: string;
  /** "Ale", "Lager", "Brett"…; empty when the recipe doesn't say. */
  type: string;
  /** "Dry", "Liquid", "Slant"…; empty when unknown. */
  form: string;
  /** "Low", "Medium", "High"…; empty when unknown. */
  flocculation: string;
  /** Bottom of the producer's recommended range, °C; null when unknown. */
  minTempC: number | null;
  /** Top of the producer's recommended range, °C; null when unknown. */
  maxTempC: number | null;
  /** Alcohol tolerance as the producer states it (often "%" or "high"). */
  alcoholTolerance: string;
  /** Whether the recipe calls for a starter. */
  starter: boolean;
}

/** Anything that isn't malt, hops or yeast: salts, finings, spices, sugar. */
export interface RecipeOtherIngredient {
  name: string;
  amount: string;
  unit: string;
  /** "Mash", "Boil", "Primary"… */
  use: string;
  /** Time in minutes, as a bare number string. */
  time: string;
  /** "Water Agt", "Fining", "Spice"… */
  type: string;
}

/** One rest in the mash schedule. */
export interface RecipeMashStep {
  /** Step name or type ("Infusion", "Sacc rest"); may be empty. */
  name: string;
  /** Temperature with unit, pre-formatted (e.g. "67°C"); null if unset. */
  temp: string | null;
  /** Rest length in minutes, as a bare number string; may be empty. */
  time: string;
  /** Infusion/strike amount with unit, when the step lists one. */
  amount?: string;
}

export interface RecipeMashGuidelines {
  steps: RecipeMashStep[];
  notes: string | null;
}

/**
 * A recipe's *target* brewing-water profile: ion concentrations in ppm (mg/L),
 * as entered on Brewer's Friend. Deliberately just the targets — turning them
 * into salt additions is the water calculator's job (see `apps/web/src/water.ts`),
 * which solves for actual salt masses rather than pretending ppm × litres is a
 * weight of gypsum.
 */
export interface RecipeWaterProfile {
  /** Profile name ("Balanced", "Burton"…); null when unnamed. */
  name: string | null;
  /** Target mash pH; null when unset. */
  ph: string | null;
  notes: string | null;
  /** Ca²⁺, ppm. Null when the recipe leaves it blank. */
  calcium: string | null;
  /** Mg²⁺, ppm. */
  magnesium: string | null;
  /** Na⁺, ppm. */
  sodium: string | null;
  /** Cl⁻, ppm. */
  chloride: string | null;
  /** SO₄²⁻, ppm. */
  sulfate: string | null;
  /** HCO₃⁻, ppm. */
  bicarbonate: string | null;
}

/**
 * The full brew sheet for one recipe (GET /api/recipes/:id) — everything the
 * Recipes detail page shows. Numbers stay strings in the shape Brewer's Friend
 * returns them; the UI formats them, so a value we can't parse still displays
 * rather than becoming NaN.
 */
export interface RecipeDetail {
  id: string;
  name: string;
  style: string;
  /** Original gravity, e.g. "1.062". */
  og: string;
  /** Pre-boil gravity; null when the recipe doesn't state one. */
  preBoilGravity: string | null;
  /** Post-boil gravity; null when the recipe doesn't state one. */
  postBoilGravity: string | null;
  /** Final gravity. */
  fg: string;
  abv: string;
  /** Tinseth IBU. */
  ibu: string;
  /** Colour in EBC. */
  ebc: string;
  /**
   * True when `ebc` was calculated here from the grain bill because the recipe
   * carried no usable colour figure — surfaced in the UI so an estimate isn't
   * mistaken for the recipe's own number.
   */
  ebcEstimated: boolean;
  /** Public Brewer's Friend recipe page URL. */
  url: string;
  /** Batch size in litres (converted from gallons if needed); null if unknown. */
  batchSizeL: number | null;
  /** Headline mash temperature, pre-formatted (e.g. "67°C"); null if unknown. */
  mashTemp: string | null;
  /** Primary fermentation temperature, pre-formatted; null if unknown. */
  fermentationTemp: string | null;
  fermentables: RecipeFermentable[];
  hops: RecipeHop[];
  yeast: RecipeYeast[];
  otherIngredients: RecipeOtherIngredient[];
  /** Null when the recipe has neither mash steps nor mash notes. */
  mashGuidelines: RecipeMashGuidelines | null;
  /** Null when the recipe specifies no water targets at all. */
  waterProfile: RecipeWaterProfile | null;
}

// ---------------------------------------------------------------------------
// Telemetry: satellite devices and their sensor readings
// ---------------------------------------------------------------------------

/**
 * Known device kinds. Kept as a string union (not an enum) so a new satellite
 * can be added without a schema migration — the dashboard renders an unknown
 * type with a generic tile. Each kind only picks a tile icon; the actual metrics
 * a device reports are free-form (see `Reading.metric`), so adding a metric to
 * an existing kind needs no change here.
 *
 * - `pressure_sensor` — fermentation pressure (`pressure_bar`).
 * - `brew_controller` — Inkbird ITC-308 fridge/heater, also reused for the
 *   brewery ambient thermometer (`temp_c`, `setpoint_c`, `hvac_state`).
 * - `power_meter`     — mains electricity (`power_w`, `energy_kwh`).
 * - `water_meter`     — water flow/usage (`flow_lpm`, `water_l`).
 * - `hydrometer`      — Tilt floating gravity sensor (`gravity_sg`, `temp_c`).
 */
export type DeviceType =
  | 'pressure_sensor'
  | 'brew_controller'
  | 'power_meter'
  | 'water_meter'
  | 'hydrometer'
  | 'other';

/**
 * A satellite that pushes data to the hub (e.g. the fermentation-pressure Pi).
 * The API key never leaves the server — only its hash is stored — so the shape
 * exposed to the client deliberately omits it.
 */
export interface Device {
  id: number;
  name: string;
  type: DeviceType;
  /** ISO timestamp of the last accepted push, or null if never seen. */
  lastSeenAt: string | null;
  /**
   * The client IP that sent the device's most recent push, or null if never
   * seen. Satellites push to the hub directly over the LAN, so this is the
   * device's local address (e.g. `192.168.0.42`) — useful for SSHing in or
   * spotting a sensor that moved networks. Captured server-side on each push.
   */
  lastIp: string | null;
  /**
   * The device's own network MAC address (lowercase, colon-separated), reported
   * by its agent on push. Unlike `lastIp` — which a DHCP lease can change — this
   * is a stable hardware id for the satellite. The link-layer address never
   * survives the trip to the hub, so the agent has to send it; agents that can't
   * determine a real MAC (and mock/placeholder devices) leave it null. The
   * dashboard only shows it when present.
   */
  mac: string | null;
  /**
   * The name the device carries in its own manufacturer app — e.g. what an
   * Inkbird controller is called in the Inkbird/Tuya app ("Birdy Boi"). Reported
   * by the agent, because the name is an account-side attribute the device never
   * exposes on the LAN (the Tuya local protocol returns only data points).
   *
   * Deliberately separate from {@link Device.name}, the name the device was
   * registered under here: that one is load-bearing on the Overview page, which
   * picks out the brewery and keg-fridge controllers by name and groups a
   * fermenter station from the devices sharing one. This is the physical label,
   * shown so an operator can tell which box on the shelf a card refers to. Null
   * until an agent reports one (and for mock/placeholder devices).
   */
  vendorName: string | null;
  /**
   * How often (seconds) this device should log a reading — the single cadence
   * the operator tunes per device from the dashboard. The hub returns it to the
   * agent on every push so the agent matches its sample/push rate to it, and the
   * dashboards poll this device at the same rate. Defaults to 30.
   */
  reportingIntervalSec: number;
  createdAt: string;
}

/** A single time-series sample pushed by a device. */
export interface Reading {
  id: number;
  deviceId: number;
  /** Stable key for the quantity, e.g. `pressure_bar`, `temp_c`. */
  metric: string;
  value: number;
  recordedAt: string;
}

/** The most recent value for one metric on a device. */
export interface LatestReading {
  metric: string;
  value: number;
  recordedAt: string;
}

/**
 * All-time consumption for a cumulative metric (e.g. total energy or water).
 * It's the sum of positive step-to-step deltas across the metric's whole
 * history, so a meter that resets to zero — as the daily `energy_kwh`/`water_l`
 * counters do at midnight — still totals correctly over its lifetime.
 */
export interface MetricTotal {
  metric: string;
  total: number;
}

/**
 * A device enriched for the dashboard: whether it is currently considered online
 * and its latest value per metric. `online` is derived server-side from the
 * freshness of the device's most recent *reading* — it flips offline only after
 * several of the device's own reporting cycles pass with no new reading, so a
 * sensor whose local read fails intermittently rides through the odd miss but a
 * genuinely silent one is flagged.
 */
export interface DeviceStatus extends Device {
  online: boolean;
  latest: LatestReading[];
  /**
   * How many readings this device has logged over its whole lifetime (all
   * metrics). A coarse "is data actually flowing / how much have we stored"
   * signal for the Devices page; absent when not computed.
   */
  readingCount?: number;
  /**
   * A target setpoint the operator has requested but the controller hasn't yet
   * confirmed — i.e. there's a pending `set_setpoint` command waiting for the
   * agent to write it to the device. Null when nothing is pending; cleared once
   * the agent applies it (after which the device's own `setpoint_c` reading
   * reflects the new value). Lets the UI show "Setting to N°…".
   */
  pendingSetpointC?: number | null;
}

/**
 * A command queued for a satellite device to apply on its hardware. The hub
 * stores these; the device pulls its pending commands (device-key auth), acts,
 * then acks them. Today the only command is `set_setpoint` (target °C for a
 * brew controller), but the shape is generic so future controls fit without a
 * schema change.
 */
export interface DeviceCommand {
  id: number;
  deviceId: number;
  /** Command kind, e.g. `set_setpoint`. */
  command: string;
  /** The command's numeric argument (for `set_setpoint`, the target in °C). */
  value: number;
  createdAt: string;
}

/** The only command kind today: set a brew controller's target temperature. */
export const SET_SETPOINT_COMMAND = 'set_setpoint';

// ---------------------------------------------------------------------------
// Device data sources (mock vs. real sensor data)
// ---------------------------------------------------------------------------

/**
 * For each planned sensor, whether the dashboard shows synthesized **mock**
 * telemetry — the demo data the app ships with, so every tile looks alive before
 * any hardware exists — or the **real** readings pushed by that sensor's agent.
 * A sensor set to `real` that isn't reporting renders as "not connected" (greyed
 * out) instead of silently falling back to mock. The choice is stored on the hub
 * and shared across every screen (see {@link DeviceDataSources}).
 */
export type DeviceDataSource = 'mock' | 'real';

/**
 * One planned sensor the operator can flip between mock and real. `key` is the
 * stable id used as the map key in {@link DeviceDataSources}; `type` lets the UI
 * pick an icon. The catalog mirrors the server's mock-profile fleet (one entry
 * per planned sensor); the three Inkbird controllers are split by role — the
 * fermenter's fridge controller, the filled-keg fridge controller, and the
 * brewery's ambient thermometer.
 */
export interface SensorCatalogEntry {
  key: string;
  label: string;
  /** A short note shown under the label in Settings. */
  hint: string;
  type: DeviceType;
}

export const SENSOR_CATALOG: readonly SensorCatalogEntry[] = [
  {
    key: 'fermenter_pressure',
    label: 'Fermenter pressure',
    hint: 'Fermentation pressure sensor',
    type: 'pressure_sensor',
  },
  {
    key: 'fermenter_controller',
    label: 'Fermenter controller',
    hint: 'Inkbird fridge/heater — temperature, setpoint, cooling/heating',
    type: 'brew_controller',
  },
  {
    key: 'kegs_controller',
    label: 'Kegs controller',
    hint: 'Inkbird fridge/heater for the filled-keg fridge — temperature, setpoint, cooling/heating',
    type: 'brew_controller',
  },
  {
    key: 'brewery_temp',
    label: 'Brewery temperature',
    hint: 'Ambient Inkbird thermometer',
    type: 'brew_controller',
  },
  { key: 'power', label: 'Power meter', hint: 'Mains electricity — power and energy', type: 'power_meter' },
  { key: 'water', label: 'Water meter', hint: 'Water flow and usage', type: 'water_meter' },
  {
    key: 'fermenter_gravity',
    label: 'Fermenter gravity',
    hint: 'Tilt hydrometer — gravity and beer temperature',
    type: 'hydrometer',
  },
];

/** Per-sensor source choice, keyed by {@link SensorCatalogEntry.key}. */
export type DeviceDataSources = Record<string, DeviceDataSource>;

/** Every planned sensor defaults to mock, preserving the ships-with demo data. */
export const DEFAULT_DEVICE_DATA_SOURCES: DeviceDataSources = Object.fromEntries(
  SENSOR_CATALOG.map((s) => [s.key, 'mock' as DeviceDataSource]),
);

// ---------------------------------------------------------------------------
// Alerts (server-recorded history)
// ---------------------------------------------------------------------------

/** Severity of an alert, most urgent first. Drives the badge/row colour. */
export type AlertSeverity = 'critical' | 'warning' | 'info';

/**
 * What produced an alert. `device_offline` is raised when a previously-seen
 * device stops reporting (and cleared when it returns); the others mirror the
 * Telegram notification checks and are one-shot events.
 */
export type AlertSource = 'device_offline' | 'keg_age' | 'ferment_done';

/**
 * A recorded alert event, kept as history on the server — unlike the
 * dashboard's live-derived "active alerts" feed. `resolvedAt` is set when a
 * self-clearing condition ends (today only `device_offline`, when the device
 * comes back online); event alerts (keg age, fermentation done) never resolve.
 * `dismissedAt` is set when a user clicks the alert away on the dashboard, which
 * removes it from every feed (the server omits dismissed alerts from listings).
 */
export interface Alert {
  id: number;
  /** The device this concerns, or null for alerts not tied to one. */
  deviceId: number | null;
  source: AlertSource;
  severity: AlertSeverity;
  title: string;
  detail: string;
  createdAt: string;
  resolvedAt: string | null;
  dismissedAt: string | null;
}

/** Query for `GET /api/alerts`: how many of the most recent alerts to return. */
export const alertsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
});
export type AlertsQuery = z.infer<typeof alertsQuerySchema>;

// ---------------------------------------------------------------------------
// Change history (server-recorded audit log)
// ---------------------------------------------------------------------------

/**
 * One recorded change to server state — every successful admin mutation is
 * logged by the audit hook and surfaced on the History page, newest first.
 * `username` is a snapshot taken when the change happened, so the entry still
 * reads sensibly after the account is renamed or deleted (`userId` then becomes
 * null but the name stays). Trusted-local kiosk/LAN changes, which have no
 * logged-in user, are attributed to "Local kiosk". `action` is the
 * human-readable summary; `entity` is a coarse category (e.g. "Checklist",
 * "Keg", "Account") for the row's chip; `method`/`path` are kept for reference.
 */
export interface AuditEntry {
  id: number;
  userId: number | null;
  username: string;
  action: string;
  entity: string | null;
  method: string;
  path: string;
  createdAt: string;
}

/** Query for `GET /api/history`: how many of the most recent entries to return. */
export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

// ---------------------------------------------------------------------------
// Keg inventory (shared Google Sheet)
// ---------------------------------------------------------------------------

/**
 * Keg inventory lives in a published Google Sheet — the same one the brew-system
 * app reads. The sheet is CORS-enabled, so the web app pulls the CSV straight
 * from the browser; the server fetches the same URL for the keg-age notification.
 * Keeping the URL, column layout, parsing, and default per-content colours here
 * gives both sides the same starting point. The server can override the colours
 * from its saved Settings palette.
 */
const KEG_SHEET_ID = '1c5CWo_-7lS9C0HSklylLVgFAT4OwADm2Svqfr9x28Do';
export const KEG_SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${KEG_SHEET_ID}/export?format=csv&gid=0`;
/** Human-facing sheet URL for "open in a new tab" links. */
export const KEG_SHEET_VIEW_URL = `https://docs.google.com/spreadsheets/d/${KEG_SHEET_ID}/edit`;

/**
 * Per-content colours, chosen to evoke the actual appearance of each beer / keg
 * state. Mirrors the brew-system app so a keg looks the same everywhere.
 */
export const DEFAULT_KEG_CONTENT_COLORS = {
  IPA: '#C8782A', // amber copper
  NEIPA: '#3ee849', // hazy orange-gold
  Wiessbeer: '#E8C84A', // cloudy banana-gold
  Sour: '#D64878', // tart raspberry pink
  'Brown Ale': '#7A3B1A', // rich mahogany
  Starsan: '#b8faff', // sanitiser blue
  SIPA: '#2a9826', // session IPA green
  Pilsner: '#DEC05C', // pale straw gold
  Stout: '#3A2A1A', // near-black dark roast
  Dirty: '#ff0000', // warning red
  Clean: '#ffffff', // fresh
  '???': '#707070', // neutral grey
};
export type KegContent = keyof typeof DEFAULT_KEG_CONTENT_COLORS;
export type KegContentColors = Record<KegContent, string>;
export const KEG_CONTENT_COLORS: KegContentColors = DEFAULT_KEG_CONTENT_COLORS;

/**
 * The selectable keg-content values, in display order, for the desktop editor's
 * dropdown. Derived from the colour palette so the two never drift — every
 * option has a colour and vice versa.
 */
export const KEG_CONTENT_OPTIONS = Object.keys(DEFAULT_KEG_CONTENT_COLORS) as KegContent[];

/**
 * Best-effort map of a recipe's name/style onto one of the known content
 * options, so linking a Brewer's Friend recipe can pre-fill the contents field
 * (e.g. "Galaxy NEIPA" → "NEIPA", "My Tropical Gose" → "Sour"). Returns null
 * when nothing matches, leaving the caller to fall back to the recipe name.
 * Order matters: more specific terms are checked before generic ones.
 */
export function matchContentOption(recipeName: string, recipeStyle = ''): KegContent | null {
  for (const text of [recipeName, recipeStyle]) {
    if (!text) continue;
    const t = text.toLowerCase();
    if (t.includes('neipa') || t.includes('hazy')) return 'NEIPA';
    if (t.includes('sipa') || t.includes('session ipa')) return 'SIPA';
    if (t.includes('brown ale')) return 'Brown Ale';
    if (t.includes('ipa')) return 'IPA';
    if (t.includes('wiessbeer') || t.includes('weiss') || t.includes('hefeweizen') || t.includes('wheat'))
      return 'Wiessbeer';
    if (t.includes('sour') || t.includes('gose') || t.includes('berliner')) return 'Sour';
    if (t.includes('pilsner') || t.includes('pils') || t.includes('lager')) return 'Pilsner';
    if (t.includes('stout') || t.includes('porter')) return 'Stout';
  }
  return null;
}

/** Colour for a keg's contents, or null when the content is unrecognised. */
export function getContentColor(
  contents: string,
  colors: KegContentColors = DEFAULT_KEG_CONTENT_COLORS,
): string | null {
  const key = (Object.keys(DEFAULT_KEG_CONTENT_COLORS) as KegContent[]).find(
    (k) => k.toLowerCase() === contents.trim().toLowerCase(),
  );
  return key ? colors[key] : null;
}

/**
 * Colour for a recipe's beer style, borrowed from the keg palette so a beer
 * wears the same colour everywhere it shows up — keg card, recipe list, and the
 * fermenter's title dot. Null when the style doesn't match a known content type.
 */
export function getRecipeColor(
  recipe: { name: string; style: string },
  colors: KegContentColors = DEFAULT_KEG_CONTENT_COLORS,
): string | null {
  const match = matchContentOption(recipe.name, recipe.style);
  return match ? colors[match] : null;
}

export interface Keg {
  number: string;
  contents: string;
  /** Resolved display colour for `contents`, as #rrggbb, or null if unknown. */
  color: string | null;
  /** Fill date as written in the sheet, DD/MM/YYYY. */
  date: string;
  note: string;
  volume: string;
  abv: string;
  /** Linked Brewer's Friend recipe id (sheet column H); empty if none. */
  recipeId: string;
}

/** Minimal CSV parser that respects quoted fields (no embedded newlines). */
function parseCSV(text: string): string[][] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const cols: string[] = [];
      let cur = '';
      let inQuotes = false;
      for (const ch of line) {
        if (ch === '"') {
          inQuotes = !inQuotes;
          continue;
        }
        if (ch === ',' && !inQuotes) {
          cols.push(cur.trim());
          cur = '';
          continue;
        }
        cur += ch;
      }
      cols.push(cur.trim());
      return cols;
    });
}

/** Parse the keg sheet CSV into rows. Row 0 is a banner, row 1 the headers. */
export function parseKegs(
  text: string,
  colors: KegContentColors = DEFAULT_KEG_CONTENT_COLORS,
): Keg[] {
  return parseCSV(text)
    .slice(2)
    .map((cols) => {
      const contents = cols[2] || '';
      return {
        number: cols[1] || '',
        contents,
        color: getContentColor(contents, colors),
        date: cols[3] || '',
        note: cols[4] || '',
        volume: cols[5] || '',
        abv: cols[6] || '',
        recipeId: cols[7] || '',
      };
    })
    .filter((k) => k.number);
}

/** Sheet dates are DD/MM/YYYY; returns an epoch-ms timestamp, or 0 if unparseable. */
export function parseKegDate(d: string): number {
  if (!d) return 0;
  const parts = d.split('/');
  if (parts.length === 3) {
    return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`).getTime() || 0;
  }
  return new Date(d).getTime() || 0;
}

// ---------------------------------------------------------------------------
// Notification settings (server-side, editable from the Settings page)
// ---------------------------------------------------------------------------

/**
 * Operator-tunable notification preferences. Persisted server-side (the
 * key-value `settings` table) — unlike the kiosk's localStorage prefs — because
 * the background scheduler that actually sends the alerts runs on the server and
 * must see one shared, authoritative value regardless of which browser changed
 * it. Telegram credentials themselves are env vars, never stored here.
 */
export interface NotificationSettings {
  /** Alert when a beer keg has been filled for at least `kegAlertDays`. */
  kegAlertEnabled: boolean;
  /** Age (days) at which a keg triggers the "drink it" alert. */
  kegAlertDays: number;
  /** Alert when the Tilt's gravity has held flat (fermentation complete). */
  fermentDoneEnabled: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  kegAlertEnabled: true,
  kegAlertDays: 30,
  fermentDoneEnabled: true,
};

// ---------------------------------------------------------------------------
// Graph colours (server-side, editable from the desktop Settings page)
// ---------------------------------------------------------------------------

/**
 * Per-metric line colours for every chart in the app. Persisted server-side (the
 * key-value `settings` table) so the palette is shared across screens — editing
 * it on the desktop Settings page also recolours the Pi kiosk's graphs. Beer and
 * fridge temperatures get their own keys because they're drawn together (both are
 * `temp_c`) and must stay distinguishable. Values are `#rrggbb` hex strings.
 */
export interface GraphColors {
  pressure: string;
  gravity: string;
  power: string;
  water: string;
  /** Beer/wort temperature (the fermenter's main temp line). */
  beerTemp: string;
  /** Fridge / brewery-ambient temperature (the muted "other" temp line). */
  fridgeTemp: string;
  /** The target-temperature reference line. */
  setpoint: string;
}

/** Defaults match the palette the dashboard shipped with (see Dashboard.tsx). */
export const DEFAULT_GRAPH_COLORS: GraphColors = {
  pressure: '#22d3ee', // cyan
  gravity: '#a78bfa', // purple
  power: '#eab308', // yellow
  water: '#3b82f6', // blue
  beerTemp: '#fb923c', // amber / orange
  fridgeTemp: '#d97706', // muted amber / orange
  setpoint: '#f59e0b', // amber reference line
};

// ---------------------------------------------------------------------------
// Request validation schemas (Zod)
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username is required').max(200),
  password: z.string().min(1, 'Password is required').max(500),
});
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Optional free-text description for a step or to-do. An empty/blank value is
 * accepted and normalized to "no description" (null) by the repository layer.
 */
const descriptionField = z.string().trim().max(2000).nullable();

export const createChecklistSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
});
export type CreateChecklistInput = z.infer<typeof createChecklistSchema>;

export const updateChecklistSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
});
export type UpdateChecklistInput = z.infer<typeof updateChecklistSchema>;

export const createStepSchema = z.object({
  text: z.string().trim().min(1, 'Step text is required').max(500),
  required: z.boolean().default(true),
});
export type CreateStepInput = z.infer<typeof createStepSchema>;

export const updateStepSchema = z
  .object({
    text: z.string().trim().min(1, 'Step text is required').max(500).optional(),
    required: z.boolean().optional(),
    description: descriptionField.optional(),
  })
  .refine(
    (v) => v.text !== undefined || v.required !== undefined || v.description !== undefined,
    { message: 'Provide at least one field to update' },
  );
export type UpdateStepInput = z.infer<typeof updateStepSchema>;

export const reorderStepsSchema = z.object({
  stepIds: z.array(z.number().int().positive()).min(1),
});
export type ReorderStepsInput = z.infer<typeof reorderStepsSchema>;

export const createTodoSchema = z.object({
  text: z.string().trim().min(1, 'To-do text is required').max(500),
});
export type CreateTodoInput = z.infer<typeof createTodoSchema>;

export const updateTodoSchema = z
  .object({
    text: z.string().trim().min(1, 'To-do text is required').max(500).optional(),
    done: z.boolean().optional(),
    description: descriptionField.optional(),
  })
  .refine(
    (v) => v.text !== undefined || v.done !== undefined || v.description !== undefined,
    { message: 'Provide at least one field to update' },
  );
export type UpdateTodoInput = z.infer<typeof updateTodoSchema>;

export const reorderTodosSchema = z.object({
  todoIds: z.array(z.number().int().positive()).min(1),
});
export type ReorderTodosInput = z.infer<typeof reorderTodosSchema>;

// --- Telemetry --------------------------------------------------------------

export const deviceTypeSchema = z.enum([
  'pressure_sensor',
  'brew_controller',
  'power_meter',
  'water_meter',
  'hydrometer',
  'other',
]);

export const createDeviceSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  type: deviceTypeSchema.default('other'),
});
export type CreateDeviceInput = z.infer<typeof createDeviceSchema>;

/**
 * Body for `POST /api/ingest`. A device pushes one or more readings; the
 * request itself doubles as a heartbeat, so an empty `readings` array is a
 * valid "I'm still alive" ping. `recordedAt` defaults to the server's receive
 * time when a sample omits it (satellites needn't have an accurate clock).
 */
export const ingestSchema = z.object({
  readings: z
    .array(
      z.object({
        metric: z.string().trim().min(1).max(64),
        value: z.number().finite(),
        // Accept any RFC3339 timestamp (a trailing `Z` or a `±hh:mm` offset),
        // since satellites may format their clock either way.
        recordedAt: z.string().datetime({ offset: true }).optional(),
      }),
    )
    .max(500)
    .default([]),
  /**
   * The device's own MAC address — heartbeat metadata, not a reading. Optional,
   * since older agents omit it. Accepts the usual colon- or hyphen-separated hex
   * and is normalized to canonical lowercase colon form so the stored value is
   * stable regardless of how the agent formatted it.
   */
  mac: z
    .string()
    .trim()
    .regex(/^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/, 'Must be a MAC address')
    .transform((m) => m.toLowerCase().replace(/-/g, ':'))
    .optional(),
  /**
   * The device's own LAN IP — heartbeat metadata, optional. Normally the hub just
   * uses the push's source IP (`req.ip`), which is correct when the agent runs on
   * the device itself. But an agent that polls a *separate* networked device (the
   * Inkbird controller is a Tuya box elsewhere on the LAN) knows the device's real
   * address and sends it here so the Devices page shows the controller's IP, not
   * the shared satellite host's. When present it overrides the source IP.
   *
   * A malformed value is dropped (treated as absent) rather than rejecting the
   * whole push — cosmetic metadata must never drop telemetry; the hub then just
   * uses the source IP for that push.
   */
  ip: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v && z.string().ip().safeParse(v).success ? v : undefined)),
  /**
   * The name the device carries in its manufacturer's app (see
   * {@link DeviceStatus.vendorName}) — heartbeat metadata, optional. An agent
   * that knows it (the Inkbird agent reads it from the tinytuya wizard's
   * `devices.json`) sends it so the Devices page can show which physical box a
   * card is. Never touches the device's registered `name`.
   *
   * An empty or over-long value is dropped rather than rejecting the push:
   * cosmetic metadata must never cost telemetry.
   */
  vendorName: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v && v.length <= 64 ? v : undefined)),
});
export type IngestInput = z.infer<typeof ingestSchema>;

/** Query for `GET /api/devices/:id/history`. */
export const historyQuerySchema = z.object({
  metric: z.string().trim().min(1).max(64).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().positive().max(5000).default(1000),
});
export type HistoryQuery = z.infer<typeof historyQuerySchema>;

/** Query for `GET /api/devices/:id/total` — the metric to total over all time. */
export const metricTotalQuerySchema = z.object({
  metric: z.string().trim().min(1).max(64),
});
export type MetricTotalQuery = z.infer<typeof metricTotalQuerySchema>;

/**
 * Body for `POST /api/devices/:id/setpoint` — the new target temperature (°C)
 * the operator wants the controller to hold. Bounded well inside the ITC-308's
 * physical range as a guard against a fat-fingered value reaching the hardware
 * (cold-crash to fridge-cold through hot-liquor warm covers every brewing need).
 */
export const setSetpointSchema = z.object({
  value: z.number().finite().min(-10).max(50),
});
export type SetSetpointInput = z.infer<typeof setSetpointSchema>;

/**
 * Allowed range for a device's logging cadence: from 5s (the fastest the agents
 * sample) up to an hour. Shared so the server validation and the dashboard's
 * picker agree on the bounds.
 */
export const REPORTING_INTERVAL_SEC = { min: 5, max: 3600 } as const;

/**
 * Cadences offered in the dashboard's per-device interval picker, in seconds.
 * Starts at 30s: sub-minute logging buries the history table in readings a
 * fridge or fermenter never moves fast enough to justify. The 5s/10s floor stays
 * legal in {@link REPORTING_INTERVAL_SEC} so devices already set that way keep
 * working — the picker just lists their current value alongside these.
 */
export const REPORTING_INTERVAL_OPTIONS = [30, 60, 300, 600] as const;

/** Body for `PATCH /api/devices/:id` — the device's new logging cadence (seconds). */
export const setReportingIntervalSchema = z.object({
  reportingIntervalSec: z
    .number()
    .int()
    .min(REPORTING_INTERVAL_SEC.min)
    .max(REPORTING_INTERVAL_SEC.max),
});
export type SetReportingIntervalInput = z.infer<typeof setReportingIntervalSchema>;

/**
 * Body for `POST /api/commands/ack` — the ids of the commands a device has
 * applied and wants cleared from its pending queue.
 */
export const ackCommandsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
});
export type AckCommandsInput = z.infer<typeof ackCommandsSchema>;

// --- Device data sources (mock vs. real) ------------------------------------

/**
 * Body for `PUT /api/device-sources`. Like the colour palettes, the whole map is
 * sent each save (last-write-wins) with every known sensor key present; the
 * server merges any older/partial stored blob over the defaults on read.
 */
export const deviceDataSourcesSchema = z.object(
  Object.fromEntries(SENSOR_CATALOG.map((s) => [s.key, z.enum(['mock', 'real'])])),
) as unknown as z.ZodType<DeviceDataSources>;
export type DeviceDataSourcesInput = z.infer<typeof deviceDataSourcesSchema>;

// --- Brewer's Friend recipe selection --------------------------------------

/**
 * Body for `PUT /api/recipe` — the recipe the operator picked from their
 * Brewer's Friend account. The client sends the already-fetched recipe so the
 * server needn't re-query Brewer's Friend just to persist the choice.
 */
export const setActiveRecipeSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1, 'Recipe name is required').max(300),
  style: z.string().trim().max(300).default(''),
  abv: z.string().trim().max(20).default(''),
  url: z.string().trim().max(500).default(''),
  // Carried through so the stored selection is a complete Recipe. Optional
  // rather than defaulted: a client that doesn't send them (or a selection
  // saved by an older build) leaves them absent instead of storing ''.
  ibu: z.string().trim().max(20).optional(),
  ebc: z.string().trim().max(20).optional(),
});
export type SetActiveRecipeInput = z.infer<typeof setActiveRecipeSchema>;

// --- Notification settings -------------------------------------------------

/**
 * Body for `PUT /api/notifications/settings`. The Settings page sends the whole
 * object each save (last-write-wins). `kegAlertDays` is bounded to a sane range
 * so a fat-fingered value can't disable the alert (0) or push it years out.
 */
export const notificationSettingsSchema = z.object({
  kegAlertEnabled: z.boolean(),
  kegAlertDays: z.number().int().min(1).max(365),
  fermentDoneEnabled: z.boolean(),
});
export type NotificationSettingsInput = z.infer<typeof notificationSettingsSchema>;

// --- Graph colours ----------------------------------------------------------

/** A `#rrggbb` hex colour (the format `<input type="color">` produces). */
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a #rrggbb hex colour');

// --- Keg content colours ----------------------------------------------------

const kegContentColorShape = Object.fromEntries(
  (Object.keys(DEFAULT_KEG_CONTENT_COLORS) as KegContent[]).map((key) => [key, hexColor]),
) as Record<KegContent, typeof hexColor>;

/** Body for `PUT /api/keg-content-colors`. The whole palette is sent each save. */
export const kegContentColorsSchema = z.object(kegContentColorShape);
export type KegContentColorsInput = z.infer<typeof kegContentColorsSchema>;

// --- Keg inventory edits (write-back to the shared sheet) -------------------

/** Path param for `PUT /api/kegs/:number` — the keg number whose row to update. */
export const kegNumberParamSchema = z.object({
  number: z.string().trim().min(1).max(20),
});

/**
 * Body for `PUT /api/kegs/:number` — the editable keg fields written back to the
 * shared sheet. Volume is intentionally omitted: it's a fixed physical property
 * of the keg, so the writer leaves that cell untouched. A blank date/note/abv
 * clears that cell; the desktop editor pre-fills existing values so a bulk
 * "assign content" can keep them. Contents is the one always-required field.
 * `recipeId` is the linked Brewer's Friend recipe (sheet column H); blank
 * unlinks. It's optional in the body so older clients that omit it leave the
 * cell untouched.
 */
export const updateKegSchema = z.object({
  contents: z.string().trim().min(1, 'Contents is required').max(100),
  date: z.string().trim().max(40),
  note: z.string().trim().max(200),
  abv: z.string().trim().max(20),
  recipeId: z.string().trim().max(200).optional(),
});
export type UpdateKegInput = z.infer<typeof updateKegSchema>;

/** Body for `PUT /api/graph-colors`. The whole palette is sent each save. */
export const graphColorsSchema = z.object({
  pressure: hexColor,
  gravity: hexColor,
  power: hexColor,
  water: hexColor,
  beerTemp: hexColor,
  fridgeTemp: hexColor,
  setpoint: hexColor,
});
export type GraphColorsInput = z.infer<typeof graphColorsSchema>;

// --- Account (username / password changes) ---------------------------------

/**
 * Body for `POST /api/auth/change-password`. The current password is required so
 * a hijacked session can't silently lock the owner out. The 8-char floor is a
 * gentle minimum, not a policy — this is a single-brewery appliance.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(500),
  newPassword: z.string().min(8, 'New password must be at least 8 characters').max(500),
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/** Body for `POST /api/auth/change-username` — current password re-confirms identity. */
export const changeUsernameSchema = z.object({
  username: z.string().trim().min(1, 'Username is required').max(200),
  currentPassword: z.string().min(1, 'Current password is required').max(500),
});
export type ChangeUsernameInput = z.infer<typeof changeUsernameSchema>;

// --- Account administration (admin-only: manage other accounts) -------------

export const userRoleSchema = z.enum(['admin', 'guest']);

/**
 * Body for `POST /api/accounts` — an admin creates a new login account. The
 * password floor mirrors the self-service change-password rule (8 chars); this
 * is a single-brewery appliance, not a policy engine.
 */
export const createUserSchema = z.object({
  username: z.string().trim().min(1, 'Username is required').max(200),
  password: z.string().min(8, 'Password must be at least 8 characters').max(500),
  role: userRoleSchema,
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

/** Body for `PATCH /api/accounts/:id/role` — change an account's privilege. */
export const setUserRoleSchema = z.object({
  role: userRoleSchema,
});
export type SetUserRoleInput = z.infer<typeof setUserRoleSchema>;

/** Body for `POST /api/accounts/:id/password` — an admin resets an account's password. */
export const adminSetPasswordSchema = z.object({
  newPassword: z.string().min(8, 'New password must be at least 8 characters').max(500),
});
export type AdminSetPasswordInput = z.infer<typeof adminSetPasswordSchema>;

// ---------------------------------------------------------------------------
// Path param helpers
// ---------------------------------------------------------------------------

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const stepIdParamSchema = z.object({
  stepId: z.coerce.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Music: Sonos / IKEA SYMFONISK now-playing + transport control
// ---------------------------------------------------------------------------

/**
 * Snapshot of what the brewery speaker is doing (GET /api/music/now-playing).
 * The IKEA SYMFONISK runs Sonos firmware, so the server controls it over the
 * LAN (no Spotify account/OAuth) via the `sonos` library. `state` is `no_media`
 * when nothing is queued; durations/positions are seconds and may be null for a
 * live stream that doesn't report them. `albumArtUrl` points straight at the
 * speaker (an `http://<sonos-ip>:1400/...` URL the kiosk loads on the LAN).
 */
export interface NowPlaying {
  state: 'playing' | 'paused' | 'stopped' | 'transitioning' | 'no_media';
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtUrl: string | null;
  durationSec: number | null;
  positionSec: number | null;
  /** Speaker volume, 0–100. */
  volume: number;
  /** The zone/room name of the controlled speaker, when known. */
  room: string | null;
}

/** Body for POST /api/music/volume — an absolute level, 0–100. */
export const setVolumeSchema = z.object({
  volume: z.coerce.number().int().min(0).max(100),
});

/** Body for POST /api/music/seek — an absolute position within the track, in seconds. */
export const seekSchema = z.object({
  positionSec: z.coerce.number().int().min(0),
});

// ---------------------------------------------------------------------------
// Brew system (the brewing rig — a separate Raspberry Pi running brew-system-v3)
// ---------------------------------------------------------------------------
// The BrewPlanner server proxies /api/brew-system/* to the rig's unauthenticated
// FastAPI over the LAN (BREW_SYSTEM_URL), so BrewPlanner's session auth is the
// only way to reach it remotely. These shapes mirror the rig's API responses.

/** BK and HLT have heaters; MLT is a read-only temperature (no control state). */
export type BrewPot = 'BK' | 'HLT';
export type BrewPump = 'P1' | 'P2';

export interface BrewPotControl {
  heaterOn: boolean;
  /** Target temperature (set value), °C. */
  sv: number;
  /** Heating element duty cycle, 0–100 %. */
  efficiency: number;
  regulationEnabled: boolean;
}

export interface BrewPumpControl {
  on: boolean;
  /** Pump PWM duty cycle, 0–100 %. */
  speed: number;
}

export interface BrewTimerState {
  running: boolean;
  /** Counts up as a stopwatch when target is 0, down toward 0 otherwise. */
  seconds: number;
  /** Countdown target in seconds; 0 = stopwatch mode. */
  target: number;
}

/** The rig's GET /api/hardware/state response. Temperatures are null when a sensor fails. */
export interface BrewSystemState {
  temperatures: { bk: number | null; mlt: number | null; hlt: number | null };
  controlState: {
    pots: Record<BrewPot, BrewPotControl>;
    pumps: Record<BrewPump, BrewPumpControl>;
  };
  timer: BrewTimerState;
}

export interface BrewAutoEfficiencyStep {
  /** Degrees below setpoint at which this power step kicks in. */
  threshold: number;
  /** Duty cycle applied for this step, 0–100 %. */
  power: number;
}

export interface BrewPotAutoEfficiency {
  enabled: boolean;
  steps: BrewAutoEfficiencyStep[];
}

/** The `app` block of the rig's /api/settings — only what the dashboard needs. */
export interface BrewSystemAppSettings {
  max_watts?: number;
  bk_element_watts?: number;
  hlt_element_watts?: number;
  auto_efficiency?: { bk?: BrewPotAutoEfficiency; hlt?: BrewPotAutoEfficiency };
}

/**
 * Envelope for GET /api/brew-system/state. `configured` is false when the
 * server has no BREW_SYSTEM_URL; `online` is false when the rig didn't answer
 * (it's normally powered off between brew days). `state` only when online.
 */
export interface BrewSystemStatus {
  configured: boolean;
  online: boolean;
  state?: BrewSystemState;
}

/** Envelope for GET /api/brew-system/config — the rig's app settings + theme colours. */
export interface BrewSystemConfig {
  configured: boolean;
  online: boolean;
  app?: BrewSystemAppSettings;
  /** The rig's custom theme colours (keys like `accentBlue`), if the user changed any. */
  theme?: Record<string, string>;
}

/** Body for POST /api/brew-system/pot/:pot/power and /pump/:pump/power. */
export const brewOnSchema = z.object({ on: z.boolean() });
/** Body for efficiency / speed / sv — the rig treats all three as 0–100. */
export const brewValueSchema = z.object({ value: z.coerce.number().min(0).max(100) });
/** Body for POST /api/brew-system/pot/:pot/regulation. */
export const brewEnabledSchema = z.object({ enabled: z.boolean() });
/** Body for POST /api/brew-system/timer — mirrors the rig's timer actions. */
export const brewTimerActionSchema = z.object({
  action: z.enum(['start', 'stop', 'reset', 'set']),
  seconds: z.coerce.number().int().min(0).optional(),
});
export type BrewTimerActionInput = z.infer<typeof brewTimerActionSchema>;

// ---------------------------------------------------------------------------
// Bruce, the voice assistant (apps/bruce). Bruce exposes a loopback status API
// on his Pi; the server proxies it as /api/bruce/* behind session auth, and
// the dashboard's Bruce page renders these shapes.

export type BruceState = 'idle' | 'listening' | 'thinking' | 'speaking';

/** One line of Bruce's rolling conversation transcript. */
export interface BruceTranscriptEntry {
  /** `system` = injected events (dashboard speak requests, reminders). */
  type: 'user' | 'assistant' | 'function_call' | 'system';
  content: string;
  /** Epoch milliseconds. */
  timestamp: number;
}

/** Bruce's live status (GET /status on his loopback API). */
export interface BruceStatus {
  state: BruceState;
  /** True while the OpenAI session is open (it idles out between conversations — that's normal, not an error). */
  connected: boolean;
  /** Realtime model in use, e.g. `gpt-realtime-mini`. */
  model: string;
  /** Speech volume, 0–200 (100 = native). */
  volumePercent: number;
  /** ISO timestamp of when the Bruce service started. */
  startedAt: string;
  transcript: BruceTranscriptEntry[];
}

/** Envelope for GET /api/bruce/status — `online: false` when the Bruce service is down/unreachable. */
export type BruceServiceStatus = { online: false } | ({ online: true } & BruceStatus);

/** Body for POST /api/bruce/speak. */
export const bruceSpeakSchema = z.object({ message: z.string().trim().min(1).max(500) });
export type BruceSpeakInput = z.infer<typeof bruceSpeakSchema>;

/** Body for POST /api/bruce/volume — 0–200 %, 100 = native. */
export const bruceVolumeSchema = z.object({ percent: z.coerce.number().min(0).max(200) });
export type BruceVolumeInput = z.infer<typeof bruceVolumeSchema>;
