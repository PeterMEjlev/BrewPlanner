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
 * A device enriched for the dashboard: whether it is currently considered
 * online (a fresh push within the staleness window) and its latest value per
 * metric. `online` is derived server-side from `lastSeenAt`.
 */
export interface DeviceStatus extends Device {
  online: boolean;
  latest: LatestReading[];
}

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

// ---------------------------------------------------------------------------
// Path param helpers
// ---------------------------------------------------------------------------

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const stepIdParamSchema = z.object({
  stepId: z.coerce.number().int().positive(),
});
