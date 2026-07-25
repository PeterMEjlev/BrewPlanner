import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

/**
 * Database schema. Edit this file, then run `npm run db:generate` to produce a
 * new SQL migration in ./drizzle. Migrations are applied automatically on boot
 * (see db/index.ts) and can also be run manually with `npm run db:migrate`.
 */

/**
 * Login accounts. `passwordHash` is a scrypt hash — see auth/password.ts.
 * `role` gates privilege: an `admin` can do everything (control devices, edit
 * kegs, manage settings and other accounts); a `guest` is read-only — it can
 * view the dashboard and graphs but cannot change anything. Defaults to `admin`
 * so the seeded first account (and any pre-roles row) keeps full access.
 */
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('admin'),
  /**
   * Monotonic counter embedded in every session cookie / bearer token minted
   * for this account. Verification rejects a token whose version no longer
   * matches, so bumping it (done on every password change) instantly revokes
   * all outstanding sessions and native-app tokens for the account.
   */
  tokenVersion: integer('token_version').notNull().default(0),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

export const checklists = sqliteTable('checklists', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

export const steps = sqliteTable('steps', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  checklistId: integer('checklist_id')
    .notNull()
    .references(() => checklists.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  text: text('text').notNull(),
  description: text('description'),
  required: integer('required', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

/**
 * A run is one pass through a checklist. The "current" run for a checklist is
 * simply its most recently created run. Keeping historical runs as rows leaves
 * the door open for a future audit trail without a schema change.
 */
export const runs = sqliteTable('runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  checklistId: integer('checklist_id')
    .notNull()
    .references(() => checklists.id, { onDelete: 'cascade' }),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

/**
 * Brewery to-do list: a single ongoing list of ad-hoc tasks, deliberately
 * unrelated to checklists/runs so the two never get mixed up.
 */
export const todos = sqliteTable('todos', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  text: text('text').notNull(),
  description: text('description'),
  done: integer('done', { mode: 'boolean' }).notNull().default(false),
  position: integer('position').notNull().default(0),
  doneAt: text('done_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

/**
 * Generic key-value app settings (one row per key, value is free-form text —
 * JSON for structured values). Currently holds the "active recipe" selection
 * picked from Brewer's Friend; deliberately generic so future singletons don't
 * each need their own table.
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

/**
 * Satellite devices that push telemetry to the hub (fermentation-pressure Pi,
 * brew controller, …). Each device authenticates with its own API key; only a
 * SHA-256 hash of that key is stored. The key is high-entropy and random, so an
 * unsalted hash is safe here and lets us look a device up by an indexed column
 * on every push. `lastSeenAt` is the heartbeat used to derive online/offline.
 */
export const devices = sqliteTable('devices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').notNull().default('other'),
  apiKeyHash: text('api_key_hash').notNull().unique(),
  lastSeenAt: text('last_seen_at'),
  /** Client IP of the most recent push (the device's LAN address). Null until first seen. */
  lastIp: text('last_ip'),
  /**
   * The device's own MAC address (canonical lowercase colon form), as reported by
   * its agent on push. A stable hardware id that — unlike `lastIp` — survives DHCP
   * lease changes. Null until an agent reports one (or for devices that can't).
   */
  mac: text('mac'),
  /**
   * The name the device carries in its manufacturer's app (e.g. what an Inkbird
   * controller is called in the Inkbird/Tuya app), as reported by its agent on
   * push. Kept apart from `name` — the name it's registered under here, which the
   * Overview page matches on — so the two can differ freely. Null until an agent
   * reports one, or for devices that have no such name.
   */
  vendorName: text('vendor_name'),
  /**
   * How often (seconds) this device should log a reading. The operator sets it
   * per device from the dashboard; the hub hands it back to the agent on every
   * push (the `/api/ingest` response) so the agent self-adjusts its sample/push
   * cadence without a redeploy. Defaults to the agents' built-in 30s.
   */
  reportingIntervalSec: integer('reporting_interval_sec').notNull().default(30),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

/**
 * Time-series sensor samples. Deliberately generic — any numeric metric from
 * any device fits without a schema change. Indexed by (device, metric, time)
 * so both "latest per metric" and "history for a metric" queries stay fast.
 */
export const readings = sqliteTable(
  'readings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceId: integer('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    metric: text('metric').notNull(),
    value: real('value').notNull(),
    recordedAt: text('recorded_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (t) => [index('readings_device_metric_time_idx').on(t.deviceId, t.metric, t.recordedAt)],
);

/**
 * Outbound commands for satellite devices (the reverse of `readings`). The hub
 * queues a command — today only `set_setpoint`, the target °C for a brew
 * controller — and the device pulls its pending rows (device-key auth), applies
 * them on its hardware, then acks them, which deletes them. Kept generic so
 * future controls need no schema change. Indexed by (device, status) for the
 * device's "what's pending for me?" poll.
 */
export const deviceCommands = sqliteTable(
  'device_commands',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceId: integer('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    command: text('command').notNull(),
    value: real('value').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (t) => [index('device_commands_device_status_idx').on(t.deviceId, t.status)],
);

/**
 * Recorded alert history. The dashboard's live "active alerts" feed is derived
 * on the fly from device state, but this table keeps a durable log: device
 * offline/online episodes plus the keg-age and fermentation-complete events the
 * notifier raises. `resolvedAt` closes a self-clearing alert (a device coming
 * back online); one-shot event alerts leave it null. `dismissedAt` is set when a
 * user clicks an alert away on the dashboard: dismissed alerts drop out of every
 * feed (card, badge and history) but stay in the table so a still-offline device
 * doesn't re-raise the same alert. `deviceId` is nullable and set-null on device
 * delete so history outlives the device it referenced.
 */
export const alerts = sqliteTable(
  'alerts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceId: integer('device_id').references(() => devices.id, { onDelete: 'set null' }),
    source: text('source').notNull(),
    severity: text('severity').notNull().default('warning'),
    title: text('title').notNull(),
    detail: text('detail').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    resolvedAt: text('resolved_at'),
    dismissedAt: text('dismissed_at'),
  },
  (t) => [index('alerts_created_idx').on(t.createdAt)],
);

/**
 * Audit log of admin changes. The centralized audit hook (see audit/hook.ts)
 * appends one row per successful mutating request: who made it, a human-readable
 * summary of the change, and the raw method/path for reference. `username` is a
 * snapshot taken at write time so an entry still reads sensibly after the account
 * is renamed or deleted; `userId` is nullable and set-null on delete so the link
 * survives the account it pointed at. Trusted-local kiosk/LAN changes (which have
 * no user) are recorded against the username "Local kiosk". Read newest-first by
 * the History page; indexed by time for that listing.
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    username: text('username').notNull(),
    action: text('action').notNull(),
    entity: text('entity'),
    method: text('method').notNull(),
    path: text('path').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (t) => [index('audit_log_created_idx').on(t.createdAt)],
);

/** Per-run check state for a single step. */
export const runSteps = sqliteTable(
  'run_steps',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepId: integer('step_id')
      .notNull()
      .references(() => steps.id, { onDelete: 'cascade' }),
    checked: integer('checked', { mode: 'boolean' }).notNull().default(false),
    checkedAt: text('checked_at'),
  },
  (t) => [unique('run_steps_run_step_unique').on(t.runId, t.stepId)],
);
