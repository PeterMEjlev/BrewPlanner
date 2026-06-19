import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSessionUser, isLocalRequest } from '../auth/index.js';
import { recordAudit } from './repo.js';

/**
 * Centralised change logging. Registered inside each admin-mutation route plugin
 * (the API, devices, and account-admin plugins), this `onResponse` hook records
 * one audit-log row for every *successful* mutating request — POST/PUT/PATCH/
 * DELETE that returned a 2xx — capturing who made the change and a human-readable
 * summary of what changed. Read-only GETs and failed requests are ignored.
 *
 * It runs after the response is sent, so the small synchronous insert never
 * delays the client, and any failure is swallowed (logged) rather than allowed
 * to affect the request it was auditing. `describeChange` maps the route to a
 * friendly summary; an unmatched mutating route still gets a generic entry so
 * "anything changed" is never silently dropped, and a handful of routes that
 * change nothing meaningful (run progress, test sends) opt out by returning null.
 */
export function registerAuditHook(app: FastifyInstance): void {
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      if (!isMutation(req.method)) return;
      if (reply.statusCode < 200 || reply.statusCode >= 300) return;

      const path = req.url.split('?')[0] ?? req.url;
      const change = describeChange(req.method, path, req.params, req.body);
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

/** Safely read a string field from a request body of unknown shape. */
function str(body: unknown, key: string): string | undefined {
  if (body && typeof body === 'object' && key in body) {
    const v = (body as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return undefined;
}

/** `" \"Brew Day\""` when the body has the named field, else `""`. */
function quoted(body: unknown, key: string): string {
  const v = str(body, key);
  return v ? ` "${v}"` : '';
}

type Rule = {
  method: string;
  re: RegExp;
  build: (m: RegExpMatchArray, body: unknown) => Change | null;
};

/**
 * Ordered route → summary rules. The first whose method and path pattern match
 * wins; capture groups in the pattern are the path ids. Bodies are read only for
 * safe, identifying fields — never a password.
 */
const RULES: Rule[] = [
  // --- Checklists & steps ---------------------------------------------------
  { method: 'POST', re: /^\/api\/checklists$/, build: (_m, b) => ({ entity: 'Checklist', action: `Created checklist${quoted(b, 'name')}` }) },
  { method: 'PATCH', re: /^\/api\/checklists\/(\d+)$/, build: (m, b) => ({ entity: 'Checklist', action: `Renamed checklist #${m[1]}${b && str(b, 'name') ? ` to "${str(b, 'name')}"` : ''}` }) },
  { method: 'DELETE', re: /^\/api\/checklists\/(\d+)$/, build: (m) => ({ entity: 'Checklist', action: `Deleted checklist #${m[1]}` }) },
  { method: 'POST', re: /^\/api\/checklists\/(\d+)\/activate$/, build: (m) => ({ entity: 'Checklist', action: `Activated checklist #${m[1]}` }) },
  { method: 'POST', re: /^\/api\/checklists\/(\d+)\/steps$/, build: (m, b) => ({ entity: 'Step', action: `Added a step${quoted(b, 'text')} to checklist #${m[1]}` }) },
  { method: 'POST', re: /^\/api\/checklists\/(\d+)\/reorder-steps$/, build: (m) => ({ entity: 'Step', action: `Reordered steps in checklist #${m[1]}` }) },
  { method: 'PATCH', re: /^\/api\/steps\/(\d+)$/, build: (m) => ({ entity: 'Step', action: `Edited step #${m[1]}` }) },
  { method: 'DELETE', re: /^\/api\/steps\/(\d+)$/, build: (m) => ({ entity: 'Step', action: `Deleted step #${m[1]}` }) },
  // Run progress is operational checklist state (mostly the kiosk ticking
  // boxes), reset every run — deliberately not part of the change history.
  { method: 'POST', re: /^\/api\/runs\//, build: () => null },

  // --- To-dos ---------------------------------------------------------------
  { method: 'POST', re: /^\/api\/todos$/, build: (_m, b) => ({ entity: 'To-do', action: `Added a to-do${quoted(b, 'text')}` }) },
  { method: 'POST', re: /^\/api\/todos\/reorder$/, build: () => ({ entity: 'To-do', action: 'Reordered the to-do list' }) },
  { method: 'POST', re: /^\/api\/todos\/clear-completed$/, build: () => ({ entity: 'To-do', action: 'Cleared completed to-dos' }) },
  { method: 'PATCH', re: /^\/api\/todos\/(\d+)$/, build: (m, b) => ({ entity: 'To-do', action: todoUpdate(m[1] ?? '', b) }) },
  { method: 'DELETE', re: /^\/api\/todos\/(\d+)$/, build: (m) => ({ entity: 'To-do', action: `Deleted to-do #${m[1]}` }) },

  // --- Active recipe --------------------------------------------------------
  { method: 'PUT', re: /^\/api\/recipe$/, build: (_m, b) => ({ entity: 'Recipe', action: `Set the active recipe${b && str(b, 'name') ? ` to "${str(b, 'name')}"` : ''}` }) },
  { method: 'DELETE', re: /^\/api\/recipe$/, build: () => ({ entity: 'Recipe', action: 'Cleared the active recipe' }) },

  // --- Keg inventory --------------------------------------------------------
  { method: 'PUT', re: /^\/api\/kegs\/([^/]+)$/, build: (m, b) => ({ entity: 'Keg', action: `Updated keg #${decodeURIComponent(m[1] ?? '')}${b && str(b, 'contents') ? ` (${str(b, 'contents')})` : ''}` }) },

  // --- Settings family ------------------------------------------------------
  { method: 'PUT', re: /^\/api\/notifications\/settings$/, build: () => ({ entity: 'Settings', action: 'Updated notification settings' }) },
  // A test notification sends a message but changes nothing on the server.
  { method: 'POST', re: /^\/api\/notifications\/test$/, build: () => null },
  { method: 'PUT', re: /^\/api\/graph-colors$/, build: () => ({ entity: 'Settings', action: 'Updated graph colours' }) },
  { method: 'PUT', re: /^\/api\/keg-content-colors$/, build: () => ({ entity: 'Settings', action: 'Updated keg colours' }) },

  // --- Devices --------------------------------------------------------------
  { method: 'POST', re: /^\/api\/devices\/(\d+)\/setpoint$/, build: (m, b) => ({ entity: 'Device', action: `Set device #${m[1]} setpoint${b && str(b, 'value') ? ` to ${str(b, 'value')}°C` : ''}` }) },

  // --- Accounts (never log the password itself) -----------------------------
  { method: 'POST', re: /^\/api\/accounts$/, build: (_m, b) => ({ entity: 'Account', action: `Created account${quoted(b, 'username')}${b && str(b, 'role') ? ` (${str(b, 'role')})` : ''}` }) },
  { method: 'PATCH', re: /^\/api\/accounts\/(\d+)\/role$/, build: (m, b) => ({ entity: 'Account', action: `Changed account #${m[1]} role${b && str(b, 'role') ? ` to ${str(b, 'role')}` : ''}` }) },
  { method: 'POST', re: /^\/api\/accounts\/(\d+)\/password$/, build: (m) => ({ entity: 'Account', action: `Reset the password for account #${m[1]}` }) },
  { method: 'DELETE', re: /^\/api\/accounts\/(\d+)$/, build: (m) => ({ entity: 'Account', action: `Deleted account #${m[1]}` }) },
];

function todoUpdate(id: string, body: unknown): string {
  const done = body && typeof body === 'object' ? (body as Record<string, unknown>).done : undefined;
  if (done === true) return `Completed to-do #${id}`;
  if (done === false) return `Reopened to-do #${id}`;
  return `Edited to-do #${id}`;
}

/**
 * Map a finished request to a change summary. Returns null when the request
 * shouldn't be logged (an opted-out route). An unmatched mutating route falls
 * back to a generic method+path entry so new endpoints are still recorded.
 */
function describeChange(
  method: string,
  path: string,
  _params: unknown,
  body: unknown,
): Change | null {
  for (const rule of RULES) {
    if (rule.method !== method) continue;
    const m = path.match(rule.re);
    if (m) return rule.build(m, body);
  }
  return { entity: 'Other', action: `${method} ${path}` };
}
