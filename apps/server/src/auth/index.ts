import type { AuthState, User } from '@checklist/shared';
import { changePasswordSchema, changeUsernameSchema, loginSchema } from '@checklist/shared';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hashPassword } from './password.js';
import {
  authenticate,
  changeUserPassword,
  countUsers,
  getUserById,
  renameUser,
  upsertUser,
  verifyUserPassword,
} from './users.js';
import { randomBytes } from 'node:crypto';

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
  if (getSessionUser(req)) return;
  await reply.status(401).send({ error: 'Authentication required' });
}

/** Auth endpoints, registered under /api/auth (intentionally unguarded). */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me', async (req): Promise<AuthState> => {
    return { user: getSessionUser(req), isLocal: isLocalRequest(req) };
  });

  app.post('/login', async (req, reply) => {
    const result = loginSchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', issues: result.error.issues });
    }
    const user = authenticate(result.data.username, result.data.password);
    if (!user) return reply.status(401).send({ error: 'Invalid username or password' });
    setSessionCookie(reply, user.id);
    return { user, isLocal: isLocalRequest(req) } satisfies AuthState;
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
