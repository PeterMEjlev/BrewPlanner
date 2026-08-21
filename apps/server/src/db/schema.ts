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

/**
 * Firebase Cloud Messaging registration tokens — one row per installed copy of
 * the Android app, so the hub can push "someone else changed something" to the
 * phones (see notify/push.ts).
 *
 * The row belongs to the account that was signed in when the token was
 * registered, because that is what tells us whose change *not* to announce: a
 * notification for your own edit is noise. `on delete cascade` means deleting an
 * account also stops its phone being pushed to. Re-registering an existing token
 * (the app does it every launch, and FCM rotates them) moves it to the current
 * account rather than duplicating the row — the token is unique.
 */
export const pushTokens = sqliteTable('push_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** The FCM registration token — opaque, device-specific, and rotated by FCM. */
  token: text('token').notNull().unique(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Only 'android' today; stored so an iOS build wouldn't need a migration. */
  platform: text('platform').notNull().default('android'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  /** Touched on every re-registration, so a stale device is recognisable. */
  lastSeenAt: text('last_seen_at')
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
 * BrewPlanner's recipe library. The editable brew sheet is stored as validated
 * JSON because it is a single aggregate: every save replaces the recipe and
 * its ordered ingredient/mash lists together. Imported Brewer's Friend ids are
 * kept as the app id so existing keg links and bookmarks continue to work;
 * recipes created here use UUIDs.
 */
export const recipes = sqliteTable(
  'recipes',
  {
    id: text('id').primaryKey(),
    /** 'local' | 'brewersfriend'. Origin is provenance, not the source of reads. */
    origin: text('origin').notNull().default('local'),
    brewersFriendId: text('brewers_friend_id'),
    brewersFriendUrl: text('brewers_friend_url').notNull().default(''),
    /** JSON encoded RecipeEditInput; parsed with recipeEditSchema on every read. */
    recipe: text('recipe').notNull(),
    /**
     * Every version of one beer shares a family id — the id of its first
     * version. A version is a whole row rather than a diff because that is what
     * keeps the rest of the app honest: a brew session, a keg and the fermenter
     * selection all point at `recipes.id`, so a batch stays attached to the
     * exact sheet it was brewed from even after v3 is written.
     */
    familyId: text('family_id').notNull().default(''),
    /** 1 for the original, ascending within the family. */
    version: integer('version').notNull().default(1),
    /** What the brewer changed here ("more Citra late"); empty when unsaid. */
    versionNote: text('version_note').notNull().default(''),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (t) => [
    unique('recipes_brewers_friend_id_unq').on(t.brewersFriendId),
    index('recipes_created_at_idx').on(t.createdAt),
    // The library lists one card per beer (its newest version) and a brew sheet
    // asks for its own siblings — both are "this family, by version".
    index('recipes_family_idx').on(t.familyId, t.version),
  ],
);

/**
 * The brewery's logbook: one row per batch, from the moment the brewer says
 * they're brewing a recipe until it's packaged.
 *
 * `recipeSnapshot` holds the recipe's identity, targets and cost as they read
 * that day. A log has to stay truthful about what was actually brewed, and the
 * recipe it came from keeps moving — re-costed as the shop's prices change,
 * edited between batches, deleted outright — so the snapshot is the record and
 * `recipeId` is only the link back (set-null on delete, so history outlives the
 * recipe). Measurements are columns rather than JSON because the list orders and
 * filters on them.
 */
export const brewSessions = sqliteTable(
  'brew_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    recipeId: text('recipe_id').references(() => recipes.id, { onDelete: 'set null' }),
    /** JSON encoded BrewSessionRecipeSnapshot, taken when the brew session started. */
    recipeSnapshot: text('recipe_snapshot').notNull(),
    /** 'brewing' | 'fermenting' | 'conditioning' | 'packaged'. */
    status: text('status').notNull().default('brewing'),
    /** The brew session itself. Editable, so a past brew can be logged after the fact. */
    brewedAt: text('brewed_at').notNull(),
    /** How long the brew session took, minutes — typed by the brewer, not clocked. */
    durationMinutes: integer('duration_minutes'),
    pitchedAt: text('pitched_at'),
    packagedAt: text('packaged_at'),
    /** Measured gravities, kept as text like the recipe's own figures. */
    preBoilGravity: text('pre_boil_gravity').notNull().default(''),
    /** The kettle volume that pre-boil gravity was read in — mash efficiency needs both. */
    preBoilVolumeL: real('pre_boil_volume_l'),
    /** The kettle at knockout, before anything was left behind with the trub. */
    postBoilGravity: text('post_boil_gravity').notNull().default(''),
    postBoilVolumeL: real('post_boil_volume_l'),
    measuredOg: text('measured_og').notNull().default(''),
    measuredFg: text('measured_fg').notNull().default(''),
    volumeL: real('volume_l'),
    mashTempC: real('mash_temp_c'),
    boilTimeMin: real('boil_time_min'),
    /**
     * A typed efficiency, which overrules the one calculated from the measured
     * OG and volume. Null — the normal case — means "use the calculation".
     */
    efficiencyPct: real('efficiency_pct'),
    waterL: real('water_l'),
    energyKwh: real('energy_kwh'),
    /** How the beer turned out, 1–5; null until it's been tasted. */
    rating: integer('rating'),
    notes: text('notes').notNull().default(''),
    tastingNotes: text('tasting_notes').notNull().default(''),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (t) => [
    // The list is chronological, and the recipe grid asks "how many times, and
    // when last?" per recipe.
    index('brew_sessions_brewed_at_idx').on(t.brewedAt),
    index('brew_sessions_recipe_idx').on(t.recipeId),
  ],
);

/**
 * The brewing rig's pot temperatures, logged every sample while a brew session is in
 * progress (see brewSessions/sampler.ts). Three columns rather than three rows in
 * `readings`: the rig is not a registered device, one row per sweep is a third
 * of the storage, and — the reason that matters — `readings` is pruned on a
 * retention schedule, while a brew session's temperature curve is meant to be
 * readable years later.
 */
export const brewSessionRigSamples = sqliteTable(
  'brew_session_rig_samples',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    brewSessionId: integer('brew_session_id')
      .notNull()
      .references(() => brewSessions.id, { onDelete: 'cascade' }),
    recordedAt: text('recorded_at').notNull(),
    /** °C in the boil kettle, mash tun and hot liquor tank; null when a sensor didn't answer. */
    bk: real('bk'),
    mlt: real('mlt'),
    hlt: real('hlt'),
  },
  (t) => [index('brew_session_rig_samples_session_time_idx').on(t.brewSessionId, t.recordedAt)],
);

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
    /**
     * The custom rule that raised this, for `source = 'custom'`; null for every
     * built-in source. Deliberately *not* a foreign key: an alert is history,
     * and deleting the rule must not delete the record of what it caught. The
     * rule repo resolves whatever episodes it leaves behind before it goes.
     */
    ruleId: text('rule_id'),
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
 * Alert rules the brewer wrote themselves: "tell me when the fermenter fridge
 * is over 25 °C", "tell me when the boil kettle reaches 100". Evaluated every
 * tick by notify/custom.ts against either a registered device's readings or a
 * live poll of the brewing rig.
 *
 * `signal` and `test` are JSON because they are discriminated unions whose
 * shape depends on their kind — a device signal carries a device and a metric,
 * a rig signal carries a pot — and columns for the union of every variant would
 * be mostly null and enforce nothing. Nothing queries inside them: the
 * evaluator loads the enabled rules and works in memory.
 */
export const alertRules = sqliteTable('alert_rules', {
  id: text('id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** The brewer's own words, used verbatim as the alert's title. */
  name: text('name').notNull(),
  /** JSON encoded CustomAlertSignal — which device metric, or which rig pot. */
  signal: text('signal').notNull(),
  /** JSON encoded CustomAlertTest — above/below/equals a number, or gone flat. */
  test: text('test').notNull(),
  /** Minutes the condition must hold before it counts (and before it clears). */
  holdMinutes: real('hold_minutes').notNull().default(0),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

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

/**
 * One thread of Bruce's text chat — a brew session's water questions kept apart
 * from last month's hop reading. Threads are shared, not per-account: this is
 * one brewery with a kiosk and a couple of logins, and a question asked on the
 * phone should still be there on the kiosk screen.
 *
 * `title` is seeded from the first question and can be renamed. `updatedAt` is
 * bumped on every new message so the list can order by recent activity.
 */
export const bruceConversations = sqliteTable(
  'bruce_conversations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (t) => [index('bruce_conversations_updated_idx').on(t.updatedAt)],
);

/**
 * Turns within a thread. Persisted rather than kept in memory so a
 * conversation survives a server restart and reads the same everywhere —
 * unlike the voice assistant's transcript, which is a deliberately throwaway
 * in-memory ring in apps/bruce.
 *
 * `sources` holds the JSON citation list for an assistant turn (which book,
 * section and page the answer came from); it is null on user turns. Old turns
 * are trimmed per thread by the repo on write, so this table stays small.
 */
export const bruceMessages = sqliteTable(
  'bruce_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    conversationId: integer('conversation_id')
      .notNull()
      .references(() => bruceConversations.id, { onDelete: 'cascade' }),
    /** 'user' | 'assistant'. */
    role: text('role').notNull(),
    content: text('content').notNull(),
    /** JSON array of { title, section?, page? } — assistant turns only. */
    sources: text('sources'),
    /**
     * JSON array of the tools called while writing this answer (see
     * BruceToolCall) — assistant turns only, null on turns stored before this
     * was recorded, which then show no tool entries rather than claiming none
     * were used.
     */
    toolCalls: text('tool_calls'),
    /**
     * What this answer cost in US dollars, estimated from the token counts
     * OpenAI reported and the price table in bruce/cost.ts. Assistant turns
     * only, and null for turns answered before this was recorded or priced
     * with a model the table doesn't know — the thread list then sums only
     * what it actually knows rather than showing a confident zero.
     */
    costUsd: real('cost_usd'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (t) => [
    index('bruce_messages_created_idx').on(t.createdAt),
    index('bruce_messages_conversation_idx').on(t.conversationId, t.id),
  ],
);

/**
 * The brewer's own pricing decisions, layered over the scraped catalogues in
 * `prices/` (see prices.ts). Two kinds of decision share the row: pinning which
 * listing an ingredient is priced against, and setting a price by hand for
 * something the shop doesn't stock — or stocks at a price the brewery doesn't
 * pay. Either may stand alone.
 *
 * Kept here rather than written back into `prices/*.json` on purpose: those files
 * are scraped and version-controlled, so an edit there would be lost to the next
 * scrape and would conflict on every deploy. This table is the layer that
 * survives both.
 *
 * Keyed on the ingredient's *match key* — its name reduced to significant words
 * by the same tokeniser that matches the catalogue — so "Voss Kveik" and "voss
 * kveik yeast" are one decision, and pricing it once holds in every recipe that
 * pitches it. `kind` is part of the key because the four catalogues are matched
 * by different rules and a name may occur in more than one.
 */
export const ingredientPrices = sqliteTable(
  'ingredient_prices',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 'fermentable' | 'hop' | 'yeast' | 'other'. */
    kind: text('kind').notNull(),
    /** Normalized match key; see prices.ts `ingredientKey`. */
    ingredient: text('ingredient').notNull(),
    /** The name as the brewer last saw it, for display in the settings list. */
    label: text('label').notNull(),
    /** Pinned catalogue listing; null when the price is entirely the brewer's own. */
    catalogueId: text('catalogue_id'),
    /** The typed price; null when only the product was pinned. */
    unitPriceDkk: real('unit_price_dkk'),
    /** 'kg' | 'pack' — what `unitPriceDkk` is quoted per. Null without a price. */
    priceUnit: text('price_unit'),
    /** The package that price refers to; null means one pack of no stated weight. */
    packageSizeG: real('package_size_g'),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (t) => [unique('ingredient_prices_kind_ingredient_unq').on(t.kind, t.ingredient)],
);
