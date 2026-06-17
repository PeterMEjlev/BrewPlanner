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
 * An authenticated user. The password hash never leaves the server, so the
 * shape exposed to the client is intentionally just the public fields.
 */
export interface User {
  id: number;
  username: string;
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
 * A recipe from the user's Brewer's Friend account, normalized down to just the
 * fields the kiosk needs. The server proxies the Brewer's Friend API (key held
 * server-side) and maps each recipe to this shape.
 */
export interface Recipe {
  id: string;
  name: string;
  /** Beer style (e.g. "West Coast IPA"); may be empty if the recipe has none. */
  style: string;
}

/**
 * The single "currently in the fermenter" recipe selection (GET/PUT /api/recipe).
 * `recipe` is null when nothing has been chosen yet.
 */
export interface ActiveRecipe {
  recipe: Recipe | null;
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
 * A device enriched for the dashboard: whether it is currently considered
 * online (a fresh push within the staleness window) and its latest value per
 * metric. `online` is derived server-side from `lastSeenAt`.
 */
export interface DeviceStatus extends Device {
  online: boolean;
  latest: LatestReading[];
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
// Keg inventory (shared Google Sheet)
// ---------------------------------------------------------------------------

/**
 * Keg inventory lives in a published Google Sheet — the same one the brew-system
 * app reads. The sheet is CORS-enabled, so the web app pulls the CSV straight
 * from the browser; the server fetches the same URL for the keg-age notification.
 * Keeping the URL, column layout, and parsing here is the single source of truth
 * for both sides.
 */
const KEG_SHEET_ID = '1c5CWo_-7lS9C0HSklylLVgFAT4OwADm2Svqfr9x28Do';
export const KEG_SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${KEG_SHEET_ID}/export?format=csv&gid=0`;
/** Human-facing sheet URL for "open in a new tab" links. */
export const KEG_SHEET_VIEW_URL = `https://docs.google.com/spreadsheets/d/${KEG_SHEET_ID}/edit`;

export interface Keg {
  number: string;
  contents: string;
  /** Fill date as written in the sheet, DD/MM/YYYY. */
  date: string;
  note: string;
  volume: string;
  abv: string;
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
export function parseKegs(text: string): Keg[] {
  return parseCSV(text)
    .slice(2)
    .map((cols) => ({
      number: cols[1] || '',
      contents: cols[2] || '',
      date: cols[3] || '',
      note: cols[4] || '',
      volume: cols[5] || '',
      abv: cols[6] || '',
    }))
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
 * Body for `POST /api/commands/ack` — the ids of the commands a device has
 * applied and wants cleared from its pending queue.
 */
export const ackCommandsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
});
export type AckCommandsInput = z.infer<typeof ackCommandsSchema>;

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

// ---------------------------------------------------------------------------
// Path param helpers
// ---------------------------------------------------------------------------

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const stepIdParamSchema = z.object({
  stepId: z.coerce.number().int().positive(),
});
