import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

/**
 * Push-notification plumbing: who a change is announced to, and which changes
 * are worth announcing at all.
 *
 * The rule that carries the weight is "not the person who made the change" —
 * get it wrong and every edit buzzes the phone of whoever just made it. That
 * depends on the token being stored against an *account*, which is why
 * registration is refused when there's no account behind the request.
 *
 * Sending itself isn't exercised: it needs Firebase credentials, and with none
 * configured (the state these tests run in) the hub is expected to stay silent
 * rather than fail — which is asserted through the routes, not by reaching out.
 *
 * DATABASE_PATH must be set before the db module loads, hence dynamic imports.
 */

const dir = mkdtempSync(join(tmpdir(), 'brewplanner-push-'));
process.env.DATABASE_PATH = join(dir, 'test.sqlite');
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-be-accepted';
process.env.ADMIN_PASSWORD = 'test-admin-password';
delete process.env.FCM_SERVICE_ACCOUNT_KEY;
delete process.env.FCM_SERVICE_ACCOUNT_KEY_FILE;

/** Headers Cloudflare adds, which mark a request as *not* trusted-local. */
const REMOTE = { 'cf-connecting-ip': '203.0.113.7', 'cf-ray': 'test-ray' };

const TOKEN_A = 'fcm-token-aaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = 'fcm-token-bbbbbbbbbbbbbbbbbbbbbbbb';

let app: FastifyInstance;
let sqlite: import('better-sqlite3').Database;
let push: typeof import('./notify/pushTokens.js');
let adminId: number;
let adminAuth: Record<string, string>;

before(async () => {
  const { buildApp } = await import('./app.js');
  sqlite = (await import('./db/index.js')).sqlite;
  push = await import('./notify/pushTokens.js');
  app = await buildApp({ logger: false });
  await app.ready();

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: process.env.ADMIN_PASSWORD },
  });
  adminId = login.json().user.id as number;
  adminAuth = { ...REMOTE, authorization: `Bearer ${login.json().token as string}` };
});

after(async () => {
  await app.close();
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('push token registry', () => {
  it('keeps one row per device however often the app re-registers', () => {
    push.registerPushToken(TOKEN_A, adminId);
    push.registerPushToken(TOKEN_A, adminId);
    const rows = push.pushTargetsExcept(null).filter((t) => t.token === TOKEN_A);
    assert.equal(rows.length, 1, 're-registering the same token should not duplicate it');
  });

  it('leaves the actor out and keeps everyone else in', () => {
    const other = sqlite
      .prepare("insert into users (username, password_hash) values ('someone-else', 'x') returning id")
      .get() as { id: number };
    push.registerPushToken(TOKEN_B, other.id);

    const forOthers = push.pushTargetsExcept(adminId).map((t) => t.token);
    assert.ok(!forOthers.includes(TOKEN_A), "the actor's own phone should not be pushed to");
    assert.ok(forOthers.includes(TOKEN_B), "another account's phone should be");

    // The kiosk has no account, so its changes are announced to everyone.
    const forKiosk = push.pushTargetsExcept(null).map((t) => t.token);
    assert.ok(forKiosk.includes(TOKEN_A) && forKiosk.includes(TOKEN_B));
  });

  it('moves a phone to whoever signs in on it, rather than adding a second row', () => {
    const other = sqlite.prepare("select id from users where username = 'someone-else'").get() as {
      id: number;
    };
    push.registerPushToken(TOKEN_B, adminId);
    const rows = push.pushTargetsExcept(null).filter((t) => t.token === TOKEN_B);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.userId, adminId, 'the token should now belong to the new signer-in');
    push.registerPushToken(TOKEN_B, other.id);
  });

  it('forgets a phone that signs out', () => {
    push.registerPushToken('fcm-token-cccccccccccccccccccccccc', adminId);
    push.unregisterPushToken('fcm-token-cccccccccccccccccccccccc');
    const tokens = push.pushTargetsExcept(null).map((t) => t.token);
    assert.ok(!tokens.includes('fcm-token-cccccccccccccccccccccccc'));
  });
});

describe('POST /api/push/register', () => {
  it('registers the token of a signed-in account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/register',
      headers: adminAuth,
      payload: { token: 'fcm-token-dddddddddddddddddddddddd' },
    });
    assert.equal(res.statusCode, 200);
    // No Firebase key in the test environment: registration still succeeds, and
    // says so, rather than pretending notifications will arrive.
    assert.deepEqual(res.json(), { registered: true, configured: false });
  });

  it('refuses a request with no account behind it', async () => {
    // The LAN kiosk is trusted for control but has no user to attribute a
    // phone to — storing the token ownerless would push a change back to the
    // account that made it.
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/register',
      payload: { token: 'fcm-token-eeeeeeeeeeeeeeeeeeeeeeee' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('rejects a token that is obviously not one', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/register',
      headers: adminAuth,
      payload: { token: 'nope' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('is not itself recorded in the change history', async () => {
    const before = (
      sqlite.prepare('select count(*) c from audit_log').get() as { c: number }
    ).c;
    await app.inject({
      method: 'POST',
      url: '/api/push/register',
      headers: adminAuth,
      payload: { token: 'fcm-token-ffffffffffffffffffffffff' },
    });
    const after = (sqlite.prepare('select count(*) c from audit_log').get() as { c: number }).c;
    assert.equal(after, before, 'a phone handing over its token is not a brewery change');
  });
});

describe('who a change is attributed to', () => {
  it('names the account behind a bearer token, not just a cookie session', async () => {
    // The Android app can't hold a cross-origin cookie, so it authenticates with
    // a bearer token. If the actor were resolved from the cookie alone, every
    // change made from a phone would be recorded as nobody — and, since a push
    // is addressed by "everyone but the actor", it would either go nowhere or
    // come straight back to the phone that made it.
    const res = await app.inject({
      method: 'POST',
      url: '/api/todos',
      headers: adminAuth,
      payload: { text: 'Check the airlock' },
    });
    assert.equal(res.statusCode, 201);

    const row = sqlite
      .prepare('select username, user_id from audit_log order by id desc limit 1')
      .get() as { username: string; user_id: number | null };
    assert.equal(row.username, 'admin');
    assert.equal(row.user_id, adminId, 'the change must carry the account id push filters on');
  });
});

/** `/^\/api\/todos\/(\d+)$/` → `/api/todos/:id`, so the pinned set below reads. */
function readable(pattern: RegExp): string {
  return pattern.source
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\\\//g, '/')
    .replace(/\((\\d\+|\[\^\/]\+)\)/g, ':id');
}

describe('which changes are announced', () => {
  it('covers exactly the changes worth interrupting someone for', async () => {
    const { notifyRules } = await import('./audit/hook.js');
    const set = Object.fromEntries(
      notifyRules().map((rule) => [`${rule.method} ${readable(rule.pattern)}`, rule.path]),
    );
    assert.deepEqual(
      set,
      {
        'POST /api/todos': '/todos',
        'DELETE /api/todos/:id': '/todos',
        'POST /api/recipes': '/recipes',
        'PUT /api/recipes/:id': '/recipes',
        'POST /api/brew-sessions': '/brew-sessions',
        'PUT /api/kegs/:id': '/kegs',
        'PUT /api/notifications/settings': '/settings',
        'PUT /api/recipe-defaults': '/settings',
        'PUT /api/graph-colors': '/settings',
        'PUT /api/keg-content-colors': '/settings',
        'POST /api/devices/:id/setpoint': '/devices',
      },
      'the notify-worthy set changed — was that deliberate?',
    );
  });
});
