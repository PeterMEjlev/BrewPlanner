import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

/**
 * Database schema. Edit this file, then run `npm run db:generate` to produce a
 * new SQL migration in ./drizzle. Migrations are applied automatically on boot
 * (see db/index.ts) and can also be run manually with `npm run db:migrate`.
 */

/**
 * Login accounts. The appliance ships with a single admin account, but this is
 * a real table so more users (and later, roles) can be added without rework.
 * `passwordHash` is a scrypt hash — see auth/password.ts.
 */
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
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
