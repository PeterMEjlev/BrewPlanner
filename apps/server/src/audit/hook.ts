import type { GraphColors, NotificationSettings, RecipeDefaults } from '@checklist/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getRequestUser, isLocalRequest } from '../auth/index.js';
import {
  getGraphColors,
  getKegContentColors,
  getNotificationSettings,
  getRecipeDefaults,
} from '../repo.js';
import {
  accountName,
  brewSessionRecipeName,
  checklistName,
  deviceName,
  deviceSetpointC,
  recipeSheet,
  recipeSheetName,
  stepText,
  todoText,
} from './names.js';
import type { FieldLabel } from './details.js';
import {
  asText,
  changedFields,
  changedRecipeSections,
  describeChanges,
  describeKegWrite,
  joinSections,
  onOff,
  withUnit,
} from './details.js';
import { pushChangeToOthers } from '../notify/push.js';
import { recordAudit } from './repo.js';

/**
 * How the saved-whole settings objects are spoken about when one of their
 * fields moves. Only the fields worth naming in a notification are listed; a
 * change to anything else falls back to the route's general sentence.
 */
const NOTIFICATION_FIELDS: readonly FieldLabel<NotificationSettings>[] = [
  { key: 'kegAlertEnabled', label: 'keg-age alerts', value: onOff },
  { key: 'kegAlertDays', label: 'the keg-age alert threshold', value: withUnit('days') },
  { key: 'fermentDoneEnabled', label: 'fermentation-done alerts', value: onOff },
  // Switching a critical alert off is exactly the change someone will want to
  // find in the history later, when the thing it watches for goes wrong quietly.
  { key: 'pressureLostEnabled', label: 'pressure-lost alerts', value: onOff },
  { key: 'pressureLostBar', label: 'the pressure-lost threshold', value: withUnit('bar', 2) },
  { key: 'pressureHighEnabled', label: 'over-pressure alerts', value: onOff },
  { key: 'pressureHighBar', label: 'the over-pressure threshold', value: withUnit('bar', 2) },
  { key: 'fermenterHotEnabled', label: 'fermenter-overheating alerts', value: onOff },
  { key: 'fermenterHotC', label: 'the fermenter-overheating threshold', value: withUnit('°C', 1) },
  { key: 'fermenterStalledEnabled', label: 'fermenter-fridge alerts', value: onOff },
  { key: 'kegsWarmEnabled', label: 'keg-fridge alerts', value: onOff },
  { key: 'kegsWarmC', label: 'the keg-fridge threshold', value: withUnit('°C', 1) },
  { key: 'breweryColdEnabled', label: 'brewery-freezing alerts', value: onOff },
  { key: 'breweryColdC', label: 'the brewery-freezing threshold', value: withUnit('°C', 1) },
  { key: 'sensorOfflineEnabled', label: 'sensor-offline alerts', value: onOff },
];

const GRAPH_COLOR_FIELDS: readonly FieldLabel<GraphColors>[] = [
  { key: 'pressure', label: 'the pressure graph colour', value: asText },
  { key: 'gravity', label: 'the gravity graph colour', value: asText },
  { key: 'power', label: 'the power graph colour', value: asText },
  { key: 'water', label: 'the water graph colour', value: asText },
  { key: 'beerTemp', label: 'the beer-temperature graph colour', value: asText },
  { key: 'fridgeTemp', label: 'the fridge-temperature graph colour', value: asText },
  { key: 'setpoint', label: 'the setpoint graph colour', value: asText },
];

const RECIPE_DEFAULT_FIELDS: readonly FieldLabel<RecipeDefaults>[] = [
  { key: 'batchSizeL', label: 'the batch size', value: withUnit('L', 1) },
  { key: 'batchTarget', label: 'what the batch size measures', value: asText },
  { key: 'boilTimeMinutes', label: 'the boil time', value: withUnit('min') },
  { key: 'efficiencyPercent', label: 'the brewhouse efficiency', value: withUnit('%') },
  { key: 'boilOffLPerHour', label: 'the boil-off rate', value: withUnit('L/h', 1) },
  { key: 'trubChillerLossL', label: 'the trub/chiller loss', value: withUnit('L', 1) },
  { key: 'pitchRate', label: 'the pitch rate', value: asText },
  { key: 'mashThicknessLPerKg', label: 'the mash thickness', value: withUnit('L/kg', 1) },
];

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Pre-handler snapshot of an audited subject, captured by the audit
     * `preHandler` before the route runs. Needed for changes that can't be read
     * afterwards — a delete (the row is gone), a rename (the old name is
     * overwritten), or a whole-object save where only a diff against the
     * previous state says what actually changed. Usually the subject's name;
     * `unknown` because the settings rules snapshot the object itself.
     * Undefined/null when the rule doesn't need it.
     */
    auditBefore?: unknown;
  }
}

/**
 * Centralised change logging. Registered inside each admin-mutation route plugin
 * (the API, devices, and account-admin plugins), this records one audit-log row
 * for every *successful* mutating request — POST/PUT/PATCH/DELETE that returned a
 * 2xx — capturing who made the change and a human-readable summary that refers to
 * entities by name (kegs keep their keg #, devices use their fleet display name).
 *
 * Two hooks cooperate: a `preHandler` snapshots a subject's name *before* the
 * handler runs, for the cases where it'd be unreadable afterwards (deletes wipe
 * the row; renames overwrite the old name); an `onResponse` builds the summary
 * (reading the now-current row for non-destructive changes) and writes the row.
 * `onResponse` runs after the response is sent, so the small synchronous insert
 * never delays the client, and any failure is swallowed (logged) rather than
 * allowed to affect the request it was auditing. An unmatched mutating route
 * still gets a generic entry so "anything changed" is never silently dropped; a
 * few routes that change nothing meaningful (run progress, test sends) opt out.
 */
export function registerAuditHook(app: FastifyInstance): void {
  // Stash a per-request snapshot slot (mirrors the `device` decoration pattern).
  if (!app.hasRequestDecorator('auditBefore')) {
    app.decorateRequest('auditBefore', null);
  }

  // Before the handler runs, snapshot the subject's name for rules that need the
  // pre-change state (deletes/renames). Never throws into the request.
  app.addHook('preHandler', async (req: FastifyRequest) => {
    try {
      if (!isMutation(req.method)) return;
      const path = req.url.split('?')[0] ?? req.url;
      const rule = matchRule(req.method, path);
      if (rule?.before) req.auditBefore = rule.before(path.match(rule.re)!);
    } catch (err) {
      req.log.error(err, 'Failed to snapshot audit subject');
    }
  });

  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      if (!isMutation(req.method)) return;
      if (reply.statusCode < 200 || reply.statusCode >= 300) return;

      const path = req.url.split('?')[0] ?? req.url;
      const change = describeChange(req.method, path, req.body, req.auditBefore ?? null);
      if (!change) return;

      // Resolve the actor: a logged-in account — by session cookie in a browser
      // or by bearer token from the Android app, which cannot hold a
      // cross-origin cookie — or the trusted-local kiosk/LAN (which has no user
      // but full control). Anything else shouldn't reach an admin route, but
      // guard rather than record a mystery entry.
      const user = getRequestUser(req);
      let userId: number | null = null;
      let username: string;
      if (user) {
        userId = user.id;
        username = user.username;
      } else if (isLocalRequest(req)) {
        username = 'Local kiosk';
      } else {
        return;
      }

      recordAudit({
        userId,
        username,
        action: change.action,
        entity: change.entity,
        method: req.method,
        path,
      });

      // Tell the *other* accounts' phones about the changes worth interrupting
      // someone for (the `push` rules above). Deliberately not awaited: the
      // response has already gone, FCM is a network round trip per device, and a
      // notification that fails is never worth surfacing to the person who made
      // the change.
      const openAt = matchRule(req.method, path)?.push;
      if (openAt) {
        void pushChangeToOthers(
          userId,
          { title: `${username} — ${change.entity}`, body: change.action, path: openAt },
          req.log,
        );
      }
    } catch (err) {
      req.log.error(err, 'Failed to record audit-log entry');
    }
  });
}

function isMutation(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

/** A described change, or null to skip logging this request. */
interface Change {
  entity: string;
  action: string;
}

interface BuildCtx {
  /** Path-pattern match — capture groups are the path ids. */
  m: RegExpMatchArray;
  /** Parsed request body (unknown shape). */
  body: unknown;
  /**
   * Pre-handler snapshot, if the rule requested one — the subject's name for
   * most rules, the previous state of the object for the settings diffs.
   */
  before: unknown;
}

/** Safely read a string field from a request body of unknown shape. */
function str(body: unknown, key: string): string | undefined {
  if (body && typeof body === 'object' && key in body) {
    const v = (body as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return undefined;
}

/** `"Brew Session"` when the name is known, else `#<id>` — for naming a subject. */
function named(name: unknown, id: string): string {
  return typeof name === 'string' && name ? `"${name}"` : `#${id}`;
}

type Rule = {
  method: string;
  re: RegExp;
  /**
   * Optional: snapshot the subject BEFORE the handler runs, for changes whose
   * previous state can't be read afterwards — the name for deletes/renames, or
   * the whole object for a settings save, where only a diff says what moved.
   * Stashed on the request and handed back to `build` as `ctx.before`.
   */
  before?: (m: RegExpMatchArray) => unknown;
  build: (ctx: BuildCtx) => Change | null;
  /**
   * Push this change to the *other* accounts' phones (see notify/push.ts), with
   * the in-app path a tap should open. Absent on most rules: the history page is
   * there to be read, while a notification interrupts someone, so only the
   * handful of changes a second brewer would want to hear about carry one —
   * setpoints, keg contents, saved recipes, a started brew session, to-dos
   * added or removed, and settings.
   */
  push?: string;
};

/**
 * Ordered route → summary rules. The first whose method and path pattern match
 * wins; capture groups in the pattern are the path ids. Entities are referred to
 * by name (looked up live for non-destructive changes, or via the pre-handler
 * snapshot for deletes/renames); kegs keep their keg #, devices use their fleet
 * display name. Bodies are read only for safe, identifying fields — never a
 * password.
 */
const RULES: Rule[] = [
  // --- Checklists & steps ---------------------------------------------------
  { method: 'POST', re: /^\/api\/checklists$/, build: ({ body }) => ({ entity: 'Checklist', action: str(body, 'name') ? `Created checklist "${str(body, 'name')}"` : 'Created a checklist' }) },
  {
    method: 'PATCH',
    re: /^\/api\/checklists\/(\d+)$/,
    before: (m) => checklistName(m[1] ?? ''),
    build: ({ m, body, before }) => {
      const newName = str(body, 'name');
      const old = named(before, m[1] ?? '');
      return { entity: 'Checklist', action: newName ? `Renamed checklist ${old} to "${newName}"` : `Renamed checklist ${old}` };
    },
  },
  { method: 'DELETE', re: /^\/api\/checklists\/(\d+)$/, before: (m) => checklistName(m[1] ?? ''), build: ({ m, before }) => ({ entity: 'Checklist', action: `Deleted checklist ${named(before, m[1] ?? '')}` }) },
  { method: 'POST', re: /^\/api\/checklists\/(\d+)\/activate$/, build: ({ m }) => ({ entity: 'Checklist', action: `Activated checklist ${named(checklistName(m[1] ?? ''), m[1] ?? '')}` }) },
  {
    method: 'POST',
    re: /^\/api\/checklists\/(\d+)\/steps$/,
    build: ({ m, body }) => {
      const text = str(body, 'text');
      const cl = named(checklistName(m[1] ?? ''), m[1] ?? '');
      return { entity: 'Step', action: text ? `Added a step "${text}" to checklist ${cl}` : `Added a step to checklist ${cl}` };
    },
  },
  { method: 'POST', re: /^\/api\/checklists\/(\d+)\/reorder-steps$/, build: ({ m }) => ({ entity: 'Step', action: `Reordered steps in checklist ${named(checklistName(m[1] ?? ''), m[1] ?? '')}` }) },
  { method: 'PATCH', re: /^\/api\/steps\/(\d+)$/, build: ({ m }) => ({ entity: 'Step', action: `Edited step ${named(stepText(m[1] ?? ''), m[1] ?? '')}` }) },
  { method: 'DELETE', re: /^\/api\/steps\/(\d+)$/, before: (m) => stepText(m[1] ?? ''), build: ({ m, before }) => ({ entity: 'Step', action: `Deleted step ${named(before, m[1] ?? '')}` }) },
  // Run progress is operational checklist state (mostly the kiosk ticking
  // boxes), reset every run — deliberately not part of the change history.
  { method: 'POST', re: /^\/api\/runs\//, build: () => null },

  // --- To-dos ---------------------------------------------------------------
  { method: 'POST', re: /^\/api\/todos$/, push: '/todos', build: ({ body }) => ({ entity: 'To-do', action: str(body, 'text') ? `Added a to-do "${str(body, 'text')}"` : 'Added a to-do' }) },
  { method: 'POST', re: /^\/api\/todos\/reorder$/, build: () => ({ entity: 'To-do', action: 'Reordered the to-do list' }) },
  { method: 'POST', re: /^\/api\/todos\/clear-completed$/, build: () => ({ entity: 'To-do', action: 'Cleared completed to-dos' }) },
  {
    method: 'PATCH',
    re: /^\/api\/todos\/(\d+)$/,
    build: ({ m, body }) => {
      const label = named(todoText(m[1] ?? ''), m[1] ?? '');
      const done = body && typeof body === 'object' ? (body as Record<string, unknown>).done : undefined;
      if (done === true) return { entity: 'To-do', action: `Completed to-do ${label}` };
      if (done === false) return { entity: 'To-do', action: `Reopened to-do ${label}` };
      return { entity: 'To-do', action: `Edited to-do ${label}` };
    },
  },
  { method: 'DELETE', re: /^\/api\/todos\/(\d+)$/, before: (m) => todoText(m[1] ?? ''), push: '/todos', build: ({ m, before }) => ({ entity: 'To-do', action: `Deleted to-do ${named(before, m[1] ?? '')}` }) },

  // --- Alerts ---------------------------------------------------------------
  // Clearing the whole feed is worth a line in the history; dismissing a single
  // alert is everyday tidying and falls through to the generic entry.
  { method: 'POST', re: /^\/api\/alerts\/clear$/, build: () => ({ entity: 'Alert', action: 'Cleared all alerts' }) },

  // --- Active recipe --------------------------------------------------------
  // Costing the sheet in the editor saves nothing — it's a POST only because the
  // whole draft is the question, and it repeats as the brewer types.
  { method: 'POST', re: /^\/api\/recipes\/price$/, build: () => null },
  { method: 'POST', re: /^\/api\/recipes$/, push: '/recipes', build: ({ body }) => ({ entity: 'Recipe', action: `Created recipe${str(body, 'name') ? ` "${str(body, 'name')}"` : ''}` }) },
  {
    method: 'PUT',
    re: /^\/api\/recipes\/([^/]+)$/,
    push: '/recipes',
    // The sheet as it read before the save, so the summary can name the parts
    // that moved — every save is an "edit", but only some are worth opening.
    before: (m) => recipeSheet(decodeURIComponent(m[1] ?? '')),
    build: ({ m, body, before }) => {
      const name = str(body, 'name');
      const subject = `recipe${name ? ` "${name}"` : ''}`;
      // Against the sheet as it was *stored*, not against the request body: the
      // server recalculates a recipe on save (IBU, grain percentages, kettle
      // gravities), so a raw-body diff reports the targets and the grain bill as
      // changed on every save, including one that only moved a hop.
      const sections = joinSections(
        changedRecipeSections(before, recipeSheet(decodeURIComponent(m[1] ?? ''))),
      );
      return {
        entity: 'Recipe',
        action: sections ? `Edited ${subject}: ${sections}` : `Edited ${subject}`,
      };
    },
  },
  // A new version of an existing beer. Its own line in the history rather than
  // reading as a plain "created recipe": what happened is that a recipe the
  // brewery already has was revised, and the note says what changed.
  {
    method: 'POST',
    re: /^\/api\/recipes\/([^/]+)\/versions$/,
    push: '/recipes',
    build: ({ body }) => {
      const name = str(body, 'name');
      const note = str(body, 'versionNote');
      return {
        entity: 'Recipe',
        action: `Created a new version of${name ? ` "${name}"` : ' a recipe'}${note ? `: ${note}` : ''}`,
      };
    },
  },
  { method: 'DELETE', re: /^\/api\/recipes\/([^/]+)$/, build: () => ({ entity: 'Recipe', action: 'Deleted a recipe from BrewPlanner' }) },
  { method: 'POST', re: /^\/api\/recipes\/import\/brewersfriend$/, build: () => ({ entity: 'Recipe', action: 'Imported recipes from Brewer\'s Friend' }) },
  // The nightly backup writes no audit row (it isn't a request); a backup
  // somebody asked for is worth recording, since it copies the library offsite.
  { method: 'POST', re: /^\/api\/recipes\/backup$/, build: () => ({ entity: 'Recipe', action: 'Backed up the recipe library' }) },
  { method: 'PUT', re: /^\/api\/recipe$/, build: ({ body }) => ({ entity: 'Recipe', action: `Set the active recipe${str(body, 'name') ? ` to "${str(body, 'name')}"` : ''}` }) },
  { method: 'DELETE', re: /^\/api\/recipe$/, build: () => ({ entity: 'Recipe', action: 'Cleared the active recipe' }) },
  { method: 'PUT', re: /^\/api\/fermenter$/, build: ({ body }) => ({ entity: 'Recipe', action: `Marked the fermenter ${str(body, 'state') === 'clean' ? 'clean' : 'dirty'}` }) },

  // --- Brew sessions ------------------------------------------------------------
  // Starting one is the brewery's own record that a batch happened, so it earns
  // a line. Editing the log is where the measurements are typed — worth
  // recording that the entry changed, without repeating every figure into the
  // history (the brew session itself holds those).
  {
    method: 'POST',
    re: /^\/api\/brew-sessions$/,
    push: '/brew-sessions',
    build: ({ body }) => {
      const id = str(body, 'recipeId');
      // The row doesn't exist yet at describe time, so the name has to come from
      // the recipe the request names.
      const name = id ? recipeSheetName(id) : null;
      return { entity: 'Brew session', action: `Started a brew session${name ? ` for "${name}"` : ''}` };
    },
  },
  {
    method: 'PATCH',
    re: /^\/api\/brew-sessions\/(\d+)$/,
    build: ({ m, body }) => {
      const label = named(brewSessionRecipeName(m[1] ?? ''), m[1] ?? '');
      const status = str(body, 'status');
      if (status) return { entity: 'Brew session', action: `Moved brew session ${label} to ${status}` };
      return { entity: 'Brew session', action: `Updated brew session ${label}` };
    },
  },
  { method: 'DELETE', re: /^\/api\/brew-sessions\/(\d+)$/, before: (m) => brewSessionRecipeName(m[1] ?? ''), build: ({ m, before }) => ({ entity: 'Brew session', action: `Deleted brew session ${named(before, m[1] ?? '')}` }) },

  // --- Ingredient prices ----------------------------------------------------
  // Worth recording: a price decision is stored per ingredient, so it re-costs
  // every recipe that uses it, not just the brew sheet it was made from.
  {
    method: 'PUT',
    re: /^\/api\/prices\/override$/,
    build: ({ body }) => {
      const name = str(body, 'name') || 'an ingredient';
      const price = body != null && typeof body === 'object' ? (body as Record<string, unknown>).unitPriceDkk : null;
      const unit = str(body, 'priceUnit') === 'pack' ? 'pack' : 'kg';
      return {
        entity: 'Recipe',
        action:
          typeof price === 'number'
            ? `Priced ${name} at ${price} kr per ${unit}`
            : `Changed which product ${name} is priced against`,
      };
    },
  },
  { method: 'DELETE', re: /^\/api\/prices\/override$/, build: () => ({ entity: 'Recipe', action: 'Reset an ingredient to automatic pricing' }) },

  // --- Keg inventory (referred to by keg #, per the sheet) ------------------
  {
    method: 'PUT',
    re: /^\/api\/kegs\/([^/]+)$/,
    push: '/kegs',
    build: ({ m, body }) => ({
      entity: 'Keg',
      action: describeKegWrite(decodeURIComponent(m[1] ?? ''), {
        contents: str(body, 'contents'),
        abv: str(body, 'abv'),
        date: str(body, 'date'),
        note: str(body, 'note'),
      }),
    }),
  },

  // --- Settings family ------------------------------------------------------
  // These routes all save the whole object, so what moved only exists as a diff
  // against the state before the handler ran. Each falls back to its old general
  // sentence when the snapshot is unreadable or nothing recognisable changed.
  {
    method: 'PUT',
    re: /^\/api\/notifications\/settings$/,
    push: '/settings',
    before: () => getNotificationSettings(),
    build: ({ before }) => {
      // Read back what was stored rather than trusting the body: the value that
      // matters is the one the brewery is now running on.
      const after = getNotificationSettings();
      const detail = describeChanges(changedFields(before, after, NOTIFICATION_FIELDS), after);
      return {
        entity: 'Settings',
        action: detail ? `Changed ${detail}` : 'Updated notification settings',
      };
    },
  },
  // A test notification sends a message but changes nothing on the server.
  { method: 'POST', re: /^\/api\/notifications\/test$/, build: () => null },
  // A phone handing over its push token on launch (and back on sign-out) is
  // bookkeeping between the app and the hub, not a change to the brewery.
  { method: 'POST', re: /^\/api\/push\/(register|unregister)$/, build: () => null },
  {
    method: 'PUT',
    re: /^\/api\/recipe-defaults$/,
    push: '/settings',
    before: () => getRecipeDefaults(),
    build: ({ before }) => {
      const after = getRecipeDefaults();
      const detail = describeChanges(changedFields(before, after, RECIPE_DEFAULT_FIELDS), after);
      return {
        entity: 'Settings',
        action: detail
          ? `Changed what a new recipe starts from: ${detail}`
          : 'Changed what a new recipe starts from',
      };
    },
  },
  {
    method: 'PUT',
    re: /^\/api\/graph-colors$/,
    push: '/settings',
    before: () => getGraphColors(),
    build: ({ before }) => {
      const after = getGraphColors();
      const detail = describeChanges(changedFields(before, after, GRAPH_COLOR_FIELDS), after);
      return {
        entity: 'Settings',
        action: detail ? `Changed ${detail}` : 'Updated graph colours',
      };
    },
  },
  {
    // The keg palette is keyed by beer, so its "fields" are whatever the sheet
    // currently pours — built from the saved body rather than a fixed list.
    method: 'PUT',
    re: /^\/api\/keg-content-colors$/,
    push: '/settings',
    before: () => getKegContentColors(),
    build: ({ before }) => {
      const after = getKegContentColors();
      const fields: FieldLabel<Record<string, string>>[] = Object.keys(after).map((key) => ({
        key,
        label: `the "${key}" keg colour`,
        value: asText,
      }));
      const detail = describeChanges(changedFields(before, after, fields), after, 2);
      return {
        entity: 'Settings',
        action: detail ? `Changed ${detail}` : 'Updated keg colours',
      };
    },
  },

  // --- System ---------------------------------------------------------------
  { method: 'POST', re: /^\/api\/system\/update$/, build: () => ({ entity: 'System', action: 'Triggered a software update' }) },

  // --- Devices (referred to by their fleet display name) --------------------
  {
    method: 'POST',
    re: /^\/api\/devices\/(\d+)\/setpoint$/,
    push: '/devices',
    // The temperature it was holding before. Read ahead of the handler because
    // queueing the change is what makes it stale, and "20°C" alone doesn't say
    // whether someone nudged the fermenter or crashed it.
    before: (m) => deviceSetpointC(m[1] ?? ''),
    build: ({ m, body, before }) => {
      const dn = deviceName(m[1] ?? '');
      const ref = dn ? `"${dn}"` : `device #${m[1]}`;
      const value = str(body, 'value');
      const was = typeof before === 'number' ? ` (was ${before}°C)` : '';
      return {
        entity: 'Device',
        action: value ? `Set ${ref} to ${value}°C${was}` : `Changed ${ref}'s setpoint`,
      };
    },
  },
  {
    method: 'PATCH',
    re: /^\/api\/devices\/(\d+)$/,
    build: ({ m, body }) => {
      const dn = deviceName(m[1] ?? '');
      const ref = dn ? `"${dn}"` : `device #${m[1]}`;
      const value = str(body, 'reportingIntervalSec');
      return { entity: 'Device', action: `Set ${ref} logging interval${value ? ` to ${value}s` : ''}` };
    },
  },

  // --- Brew system (heater/pump commands proxied to the brewing rig) --------
  {
    method: 'POST',
    re: /^\/api\/brew-system\/pot\/([A-Z]+)\/power$/,
    build: ({ m, body }) => ({ entity: 'Brew system', action: `Turned the ${m[1]} heater ${str(body, 'on') === 'true' ? 'on' : 'off'}` }),
  },
  {
    method: 'POST',
    re: /^\/api\/brew-system\/pot\/([A-Z]+)\/regulation$/,
    build: ({ m, body }) => ({ entity: 'Brew system', action: `Turned ${m[1]} regulation ${str(body, 'enabled') === 'true' ? 'on' : 'off'}` }),
  },
  { method: 'POST', re: /^\/api\/brew-system\/pot\/([A-Z]+)\/sv$/, build: ({ m, body }) => ({ entity: 'Brew system', action: `Set the ${m[1]} target temperature${str(body, 'value') ? ` to ${str(body, 'value')}°C` : ''}` }) },
  {
    method: 'POST',
    re: /^\/api\/brew-system\/pump\/([A-Z0-9]+)\/power$/,
    build: ({ m, body }) => ({ entity: 'Brew system', action: `Turned pump ${m[1]} ${str(body, 'on') === 'true' ? 'on' : 'off'}` }),
  },
  // Slider spam (efficiency/speed while dragging) and timer taps are operational
  // noise, not configuration changes — deliberately kept out of the history.
  { method: 'POST', re: /^\/api\/brew-system\/pot\/[A-Z]+\/efficiency$/, build: () => null },
  { method: 'POST', re: /^\/api\/brew-system\/pump\/[A-Z0-9]+\/speed$/, build: () => null },
  { method: 'POST', re: /^\/api\/brew-system\/timer$/, build: () => null },

  // --- Bruce (voice assistant) ----------------------------------------------
  { method: 'POST', re: /^\/api\/bruce\/speak$/, build: ({ body }) => ({ entity: 'Bruce', action: `Sent Bruce a message to speak${str(body, 'message') ? `: "${str(body, 'message')}"` : ''}` }) },
  // Volume nudges are operational noise (slider drags), not configuration.
  { method: 'POST', re: /^\/api\/bruce\/volume$/, build: () => null },
  // Asking Bruce a question changes nothing but his own chat thread, which the
  // Bruce page already shows in full. It also answers as a hijacked stream, so
  // the `onResponse` hook this rule lives in never sees it — the rule is here so
  // that reads as a decision rather than an oversight.
  { method: 'POST', re: /^\/api\/bruce\/chat$/, build: () => null },
  // Talking to Bruce from a browser. All three are silent here, and each for
  // its own reason:
  //
  // - `voice/session` mints a credential and changes nothing in the brewery.
  // - `voice/tool` is one function call out of a live conversation, and the
  //   tools record their own entries (see bruce/tools.ts) — "Bruce: set the
  //   fermenter to 20°C" said once, rather than that plus a POST beside it.
  //   Without this rule every *read* he made would land in the history too.
  // - `voice/turn` only writes the chat thread, which the Bruce page shows.
  { method: 'POST', re: /^\/api\/bruce\/voice\/(session|tool|turn)$/, build: () => null },

  // --- Accounts (never log the password itself) -----------------------------
  { method: 'POST', re: /^\/api\/accounts$/, build: ({ body }) => ({ entity: 'Account', action: `Created account${str(body, 'username') ? ` "${str(body, 'username')}"` : ''}${str(body, 'role') ? ` (${str(body, 'role')})` : ''}` }) },
  { method: 'PATCH', re: /^\/api\/accounts\/(\d+)\/role$/, build: ({ m, body }) => ({ entity: 'Account', action: `Changed account ${named(accountName(m[1] ?? ''), m[1] ?? '')} role${str(body, 'role') ? ` to ${str(body, 'role')}` : ''}` }) },
  { method: 'POST', re: /^\/api\/accounts\/(\d+)\/password$/, build: ({ m }) => ({ entity: 'Account', action: `Reset the password for account ${named(accountName(m[1] ?? ''), m[1] ?? '')}` }) },
  { method: 'DELETE', re: /^\/api\/accounts\/(\d+)$/, before: (m) => accountName(m[1] ?? ''), build: ({ m, before }) => ({ entity: 'Account', action: `Deleted account ${named(before, m[1] ?? '')}` }) },
];

/** The first rule whose method and path pattern match, or undefined. */
function matchRule(method: string, path: string): Rule | undefined {
  return RULES.find((rule) => rule.method === method && rule.re.test(path));
}

/**
 * The changes that push a notification to the other accounts' phones, as
 * method + pattern + the page a tap opens. Exported for the test that pins the
 * set: which changes are worth interrupting someone for is a judgement, and one
 * that should not drift by accident when a route is added.
 */
export function notifyRules(): { method: string; pattern: RegExp; path: string }[] {
  return RULES.filter((rule) => rule.push).map((rule) => ({
    method: rule.method,
    pattern: rule.re,
    path: rule.push!,
  }));
}

/**
 * Map a finished request to a change summary. Returns null when the request
 * shouldn't be logged (an opted-out route). An unmatched mutating route falls
 * back to a generic method+path entry so new endpoints are still recorded.
 */
function describeChange(
  method: string,
  path: string,
  body: unknown,
  before: unknown,
): Change | null {
  const rule = matchRule(method, path);
  if (!rule) return { entity: 'Other', action: `${method} ${path}` };
  const m = path.match(rule.re);
  if (!m) return null;
  return rule.build({ m, body, before });
}
