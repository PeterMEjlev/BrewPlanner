import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSessionUser, isLocalRequest } from '../auth/index.js';
import { accountName, checklistName, deviceName, stepText, todoText } from './names.js';
import { recordAudit } from './repo.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Pre-handler snapshot of an audited subject's name, captured by the audit
     * `preHandler` before the route runs. Needed for changes whose name can't be
     * read afterwards — a delete (the row is gone) or a rename (the old name is
     * overwritten). Undefined/null when the rule doesn't need it.
     */
    auditBefore?: string | null;
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

      // Resolve the actor: a logged-in account, or the trusted-local kiosk/LAN
      // (which has no user but full control). Anything else shouldn't reach an
      // admin route, but guard rather than record a mystery entry.
      const user = getSessionUser(req);
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
  /** Pre-handler snapshot of the subject's name, if the rule requested one. */
  before: string | null;
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

/** `"Brew Day"` when the name is known, else `#<id>` — for naming a subject. */
function named(name: string | null | undefined, id: string): string {
  return name ? `"${name}"` : `#${id}`;
}

type Rule = {
  method: string;
  re: RegExp;
  /**
   * Optional: resolve the subject's name BEFORE the handler runs, for changes
   * whose name can't be read afterwards (deletes/renames). Stashed on the request
   * and handed back to `build` as `ctx.before`.
   */
  before?: (m: RegExpMatchArray) => string | null;
  build: (ctx: BuildCtx) => Change | null;
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
  { method: 'POST', re: /^\/api\/todos$/, build: ({ body }) => ({ entity: 'To-do', action: str(body, 'text') ? `Added a to-do "${str(body, 'text')}"` : 'Added a to-do' }) },
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
  { method: 'DELETE', re: /^\/api\/todos\/(\d+)$/, before: (m) => todoText(m[1] ?? ''), build: ({ m, before }) => ({ entity: 'To-do', action: `Deleted to-do ${named(before, m[1] ?? '')}` }) },

  // --- Active recipe --------------------------------------------------------
  { method: 'PUT', re: /^\/api\/recipe$/, build: ({ body }) => ({ entity: 'Recipe', action: `Set the active recipe${str(body, 'name') ? ` to "${str(body, 'name')}"` : ''}` }) },
  { method: 'DELETE', re: /^\/api\/recipe$/, build: () => ({ entity: 'Recipe', action: 'Cleared the active recipe' }) },

  // --- Keg inventory (referred to by keg #, per the sheet) ------------------
  { method: 'PUT', re: /^\/api\/kegs\/([^/]+)$/, build: ({ m, body }) => ({ entity: 'Keg', action: `Updated keg #${decodeURIComponent(m[1] ?? '')}${str(body, 'contents') ? ` (${str(body, 'contents')})` : ''}` }) },

  // --- Settings family ------------------------------------------------------
  { method: 'PUT', re: /^\/api\/notifications\/settings$/, build: () => ({ entity: 'Settings', action: 'Updated notification settings' }) },
  // A test notification sends a message but changes nothing on the server.
  { method: 'POST', re: /^\/api\/notifications\/test$/, build: () => null },
  { method: 'PUT', re: /^\/api\/graph-colors$/, build: () => ({ entity: 'Settings', action: 'Updated graph colours' }) },
  { method: 'PUT', re: /^\/api\/keg-content-colors$/, build: () => ({ entity: 'Settings', action: 'Updated keg colours' }) },

  // --- System ---------------------------------------------------------------
  { method: 'POST', re: /^\/api\/system\/update$/, build: () => ({ entity: 'System', action: 'Triggered a software update' }) },

  // --- Devices (referred to by their fleet display name) --------------------
  {
    method: 'POST',
    re: /^\/api\/devices\/(\d+)\/setpoint$/,
    build: ({ m, body }) => {
      const dn = deviceName(m[1] ?? '');
      const ref = dn ? `"${dn}"` : `device #${m[1]}`;
      const value = str(body, 'value');
      return { entity: 'Device', action: `Set ${ref} setpoint${value ? ` to ${value}°C` : ''}` };
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
 * Map a finished request to a change summary. Returns null when the request
 * shouldn't be logged (an opted-out route). An unmatched mutating route falls
 * back to a generic method+path entry so new endpoints are still recorded.
 */
function describeChange(
  method: string,
  path: string,
  body: unknown,
  before: string | null,
): Change | null {
  const rule = matchRule(method, path);
  if (!rule) return { entity: 'Other', action: `${method} ${path}` };
  const m = path.match(rule.re);
  if (!m) return null;
  return rule.build({ m, body, before });
}
