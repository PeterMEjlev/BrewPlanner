import type { AuthState, User } from '@checklist/shared';
import {
  adminSetPasswordSchema,
  changePasswordSchema,
  changeUsernameSchema,
  createUserSchema,
  idParamSchema,
  loginSchema,
  setUserRoleSchema,
} from '@checklist/shared';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hashPassword } from './password.js';
import {
  authenticate,
  changeUserPassword,
  countAdmins,
  countUsers,
  createUser,
  deleteUserById,
  getUserById,
  listUsers,
  renameUser,
  setUserRole,
  upsertUser,
  verifyUserPassword,
} from './users.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'bp_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

const COOKIE_SECURE =
  process.env.COOKIE_SECURE === 'true' ||
  (process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production');

/**
 * Decide whether a request is "trusted local" — i.e. it reached this server
 * directly on the LAN/loopback rather than through the public Cloudflare
 * tunnel. Those requests (notably the Pi's own kiosk on localhost) don't need
 * a login. Anything arriving through Cloudflare carries `cf-connecting-ip` /
 * `cf-ray`; Cloudflare overwrites any client-supplied value, so the public
 * internet cannot forge a "local" request. Set TRUST_LOCAL=false to require a
 * login everywhere instead.
 */
export function isLocalRequest(req: FastifyRequest): boolean {
  if (process.env.TRUST_LOCAL === 'false') return false;
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) return false;
  return isPrivateOrLoopback(req.ip);
}

function isPrivateOrLoopback(ip: string): boolean {
  // Normalize IPv4-mapped IPv6 addresses (e.g. ::ffff:192.168.1.5).
  const addr = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (addr === '::1' || addr === '127.0.0.1' || addr.startsWith('127.')) return true;
  if (addr === 'localhost') return true;
  if (addr.startsWith('10.') || addr.startsWith('192.168.')) return true;
  if (addr.startsWith('169.254.')) return true; // link-local
  // 172.16.0.0 – 172.31.255.255
  const m = /^172\.(\d+)\./.exec(addr);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd]/i.test(addr) || /^fe[89ab]/i.test(addr)) return true;
  return false;
}

/**
 * A long-lived read-only token for headless clients that can't hold a session
 * cookie (notably the Garmin watch app, whose Connect IQ HTTP client has no
 * cookie jar). When `WATCH_API_TOKEN` is set, a request carrying
 * `Authorization: Bearer <token>` is allowed through `requireAuth`. The token
 * grants the same read access as a logged-in user — there is no separate
 * read-only scope — so treat it like a password: set it long and random, e.g.
 * `openssl rand -base64 32`. Unset (the default) disables this path entirely.
 */
function hasValidBearerToken(req: FastifyRequest): boolean {
  const expected = process.env.WATCH_API_TOKEN;
  if (!expected) return false;
  const header = req.headers.authorization;
  const presented = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented) return false;
  // Constant-time compare; equalize lengths first so timingSafeEqual never throws.
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Resolve the logged-in user from the signed session cookie, if any. */
export function getSessionUser(req: FastifyRequest): User | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  const id = Number(unsigned.value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return getUserById(id);
}

/**
 * A full-access token for a native client that can't hold a session cookie —
 * notably the Android (Capacitor) app, whose bundled web view runs from a
 * `localhost` origin and talks to this server cross-origin over the tunnel, so
 * the browser won't attach the session cookie. The token is just the user id
 * signed with the *same* secret as the session cookie (minted at login, see the
 * /login handler), so it's verified the same way and carries that user's role.
 *
 * This is deliberately distinct from the read-only `WATCH_API_TOKEN` above: that
 * one is a shared, view-only env secret; this one identifies a real account and
 * therefore grants whatever that account may do (including admin control).
 */
export function getBearerUser(req: FastifyRequest): User | null {
  const header = req.headers.authorization;
  const presented = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented) return null;
  const unsigned = req.unsignCookie(presented);
  if (!unsigned.valid || !unsigned.value) return null;
  const id = Number(unsigned.value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return getUserById(id);
}

/** Mint a full-access token (signed user id) for {@link getBearerUser}. */
export function mintAuthToken(req: FastifyRequest, userId: number): string {
  return req.server.signCookie(String(userId));
}

/** The user behind a request, whether by session cookie or full-access bearer token. */
export function getRequestUser(req: FastifyRequest): User | null {
  return getSessionUser(req) ?? getBearerUser(req);
}

function setSessionCookie(reply: FastifyReply, userId: number): void {
  reply.setCookie(SESSION_COOKIE, String(userId), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    signed: true,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/**
 * preHandler guard for protected routes. Allows the request through when it is
 * trusted-local or carries a valid session; otherwise replies 401.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (isLocalRequest(req)) return;
  if (getRequestUser(req)) return;
  if (hasValidBearerToken(req)) return;
  await reply.status(401).send({ error: 'Authentication required' });
}

/**
 * preHandler guard for admin-only actions: device control (setpoints), keg
 * edits, settings, and account management. Trusted-local requests (the Pi kiosk
 * on the LAN) pass as admin-equivalent so the physical appliance keeps full
 * control without a login; a logged-in admin passes; a logged-in guest is
 * refused with 403; anyone unauthenticated gets 401. The read-only watch bearer
 * token is deliberately NOT accepted here — it grants viewing, never control.
 */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (isLocalRequest(req)) return;
  const user = getRequestUser(req);
  if (user?.role === 'admin') return;
  if (user) {
    await reply.status(403).send({ error: 'Admin privileges required' });
    return;
  }
  await reply.status(401).send({ error: 'Authentication required' });
}

/** Parse with a Zod schema, replying 400 on failure. Returns null when invalid. */
function parseBody<T>(schema: z.ZodType<T>, data: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    reply.status(400).send({ error: 'Validation failed', issues: result.error.issues });
    return null;
  }
  return result.data;
}

/** Auth endpoints, registered under /api/auth (intentionally unguarded). */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me', async (req): Promise<AuthState> => {
    return { user: getRequestUser(req), isLocal: isLocalRequest(req) };
  });

  // Throttle login attempts per client IP (see the rate-limit registration in
  // index.ts for how the key is derived behind the Cloudflare tunnel). 10/min is
  // generous for a human fat-fingering a password but blunts online guessing; on
  // exceed the plugin replies 429 before this handler runs.
  app.post('/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const result = loginSchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', issues: result.error.issues });
    }
    const user = authenticate(result.data.username, result.data.password);
    if (!user) return reply.status(401).send({ error: 'Invalid username or password' });
    setSessionCookie(reply, user.id);
    // Also hand back a full-access bearer token. Browsers ignore it (they use the
    // cookie just set); the native app, which can't hold a cross-origin cookie,
    // stores it and sends it as `Authorization: Bearer` on every request.
    const state: AuthState = { user, isLocal: isLocalRequest(req) };
    return { ...state, token: mintAuthToken(req, user.id) };
  });

  app.post('/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  // Self-service account changes. These need a real logged-in session: a
  // trusted-local request with no session (e.g. the Pi kiosk on the LAN) has no
  // "current user" to act on, so it's rejected with 401. The current password is
  // re-verified each time so a borrowed session can't take over the account.
  app.post('/change-password', async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.status(401).send({ error: 'Sign in to change your password.' });
    const result = changePasswordSchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', issues: result.error.issues });
    }
    if (!verifyUserPassword(user.id, result.data.currentPassword)) {
      return reply.status(403).send({ error: 'Current password is incorrect.' });
    }
    const updated = changeUserPassword(user.id, result.data.newPassword);
    if (!updated) return reply.status(404).send({ error: 'Account no longer exists.' });
    // Keep the session alive (same user id) and refresh the cookie's max-age.
    setSessionCookie(reply, updated.id);
    return { user: updated, isLocal: isLocalRequest(req) } satisfies AuthState;
  });

  app.post('/change-username', async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.status(401).send({ error: 'Sign in to change your username.' });
    const result = changeUsernameSchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', issues: result.error.issues });
    }
    if (!verifyUserPassword(user.id, result.data.currentPassword)) {
      return reply.status(403).send({ error: 'Current password is incorrect.' });
    }
    const updated = renameUser(user.id, result.data.username);
    if (updated === 'taken') {
      return reply.status(409).send({ error: 'That username is already taken.' });
    }
    if (!updated) return reply.status(404).send({ error: 'Account no longer exists.' });
    return { user: updated, isLocal: isLocalRequest(req) } satisfies AuthState;
  });
}

/**
 * Account administration (admin-only), mounted under /api/accounts. An admin can
 * list every account, create or delete one, change a role, or reset a password.
 * Guarded by requireAdmin (so trusted-local and admins pass; guests get 403).
 * The last-admin guards refuse any delete/demote that would leave no admins, so
 * an operator can never lock everyone out of account management.
 */
export async function accountAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  // Record account changes (create/delete, role change, password reset) into
  // the change history. Imported lazily to avoid an import cycle (the audit hook
  // imports getSessionUser/isLocalRequest from this module).
  const { registerAuditHook } = await import('../audit/hook.js');
  registerAuditHook(app);

  // Every account with its role (never the password hash).
  app.get('/', async () => listUsers());

  // Create a new login account.
  app.post('/', async (req, reply) => {
    const body = parseBody(createUserSchema, req.body, reply);
    if (!body) return;
    const created = createUser(body.username, body.password, body.role);
    if (created === 'taken') {
      return reply.status(409).send({ error: 'That username is already taken.' });
    }
    return reply.status(201).send(created);
  });

  // Change an account's privilege (admin <-> guest).
  app.patch('/:id/role', async (req, reply) => {
    const params = parseBody(idParamSchema, req.params, reply);
    if (!params) return;
    const body = parseBody(setUserRoleSchema, req.body, reply);
    if (!body) return;
    const target = getUserById(params.id);
    if (!target) return reply.status(404).send({ error: 'Account not found.' });
    if (target.role === 'admin' && body.role !== 'admin' && countAdmins() <= 1) {
      return reply.status(409).send({ error: 'Cannot demote the last admin account.' });
    }
    const updated = setUserRole(params.id, body.role);
    if (!updated) return reply.status(404).send({ error: 'Account not found.' });
    return updated;
  });

  // Reset an account's password (no current-password check — admin privilege).
  app.post('/:id/password', async (req, reply) => {
    const params = parseBody(idParamSchema, req.params, reply);
    if (!params) return;
    const body = parseBody(adminSetPasswordSchema, req.body, reply);
    if (!body) return;
    const updated = changeUserPassword(params.id, body.newPassword);
    if (!updated) return reply.status(404).send({ error: 'Account not found.' });
    return updated;
  });

  // Delete an account.
  app.delete('/:id', async (req, reply) => {
    const params = parseBody(idParamSchema, req.params, reply);
    if (!params) return;
    const target = getUserById(params.id);
    if (!target) return reply.status(404).send({ error: 'Account not found.' });
    if (target.role === 'admin' && countAdmins() <= 1) {
      return reply.status(409).send({ error: 'Cannot delete the last admin account.' });
    }
    deleteUserById(params.id);
    return reply.status(204).send();
  });
}

/**
 * Ensure an admin account exists on first boot. Uses ADMIN_USERNAME /
 * ADMIN_PASSWORD when provided; otherwise creates `admin` with a random
 * password that is logged once so the operator can sign in and change it.
 */
export function seedAdminUser(log: FastifyBaseLogger): void {
  if (countUsers() > 0) return;
  const username = process.env.ADMIN_USERNAME?.trim() || 'admin';
  const provided = process.env.ADMIN_PASSWORD;
  const password = provided && provided.length > 0 ? provided : randomBytes(9).toString('base64url');
  upsertUser(username, password);
  if (provided) {
    log.info(`Created initial admin user "${username}" from ADMIN_PASSWORD.`);
  } else {
    log.warn(
      `No users existed. Created admin user "${username}" with a generated password: ${password}\n` +
        '  Log in and change it, or set ADMIN_PASSWORD and recreate the account.',
    );
  }
}

export { hashPassword };
