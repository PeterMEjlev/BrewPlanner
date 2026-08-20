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
        // A new version of a beer is a change to the library the same way a new
        // recipe is — the brewery should hear about it.
        'POST /api/recipes/:id/versions': '/recipes',
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

/** The action text of the most recently recorded change — the push body. */
function lastAction(): string {
  return (
    sqlite.prepare('select action from audit_log order by id desc limit 1').get() as {
      action: string;
    }
  ).action;
}

/**
 * What the notification actually says. The audit action is the push body, so a
 * sentence that doesn't name what moved is a phone buzzing for nothing — these
 * pin the specifics rather than the wording, which is free to be reworded.
 */
describe('what a change notification says', () => {
  it('names the setting that moved, not just that settings were saved', async () => {
    // Save the current state first, so the next save is a known one-field diff
    // rather than a diff against whatever the defaults happen to be.
    await app.inject({
      method: 'PUT',
      url: '/api/notifications/settings',
      headers: adminAuth,
      payload: { kegAlertEnabled: true, kegAlertDays: 30, fermentDoneEnabled: true },
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/notifications/settings',
      headers: adminAuth,
      payload: { kegAlertEnabled: true, kegAlertDays: 21, fermentDoneEnabled: false },
    });
    assert.equal(res.statusCode, 200);

    const action = lastAction();
    assert.match(action, /21 days/, 'the new threshold is the point of the change');
    assert.match(action, /fermentation-done alerts to off/);
    assert.doesNotMatch(action, /^Updated notification settings$/);
  });

  it('names which graph colour changed', async () => {
    const palette = (await app.inject({ method: 'GET', url: '/api/graph-colors' })).json();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/graph-colors',
      headers: adminAuth,
      payload: { ...palette, gravity: '#123456' },
    });
    assert.equal(res.statusCode, 200);
    assert.match(lastAction(), /gravity graph colour to #123456/);
  });

  it('names the parts of a brew sheet an edit touched', async () => {
    const { DEFAULT_RECIPE_SETTINGS } = await import('@checklist/shared');
    const sheet = {
      name: 'Notification IPA',
      style: 'American IPA',
      settings: { ...DEFAULT_RECIPE_SETTINGS },
      og: '1.060', preBoilGravity: '1.048', postBoilGravity: '1.060', fg: '1.012',
      abv: '6.3', ibu: '55', ebc: '12', ebcEstimated: false,
      batchSizeL: 20, mashTemp: '67°C', fermentationTemp: '19°C',
      fermentables: [{ name: 'Pale Ale Malt', amount: '5', unit: 'kg', percent: '100', ebc: 6, ppg: 37, fermentable: null, lateAddition: false }],
      hops: [{ name: 'Citra', amount: '60', unit: 'g', use: 'Boil', stage: 'Boil', time: '60', timeUnit: 'min', aa: '12', ibu: '', form: 'Pellet', utilization: '', temp: '' }],
      yeast: [{ name: 'US-05', lab: 'Fermentis', attenuation: '80', amount: '1', amountUnit: 'pkg', type: 'Ale', form: 'Dry', flocculation: 'Medium', minTempC: 18, maxTempC: 22, alcoholTolerance: '9%', starter: false }],
      otherIngredients: [], mashGuidelines: null, waterProfile: null,
    };
    const created = await app.inject({
      method: 'POST',
      url: '/api/recipes',
      headers: adminAuth,
      payload: sheet,
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().id as string;

    // One more hop and a warmer fermentation: two sections, named as such.
    const edited = await app.inject({
      method: 'PUT',
      url: `/api/recipes/${encodeURIComponent(id)}`,
      headers: adminAuth,
      payload: {
        ...sheet,
        fermentationTemp: '21°C',
        hops: [
          ...sheet.hops,
          { name: 'Mosaic', amount: '80', unit: 'g', use: 'Dry Hop', stage: 'Dry Hop', time: '4', timeUnit: 'day', aa: '11', ibu: '', form: 'Pellet', utilization: '', temp: '' },
        ],
      },
    });
    assert.equal(edited.statusCode, 200);

    const action = lastAction();
    assert.match(action, /Notification IPA/);
    assert.match(action, /the hops/);
    assert.match(action, /fermentation temperature/);
  });

  it('says a keg was emptied rather than "updated"', async () => {
    // The sheet write needs Google credentials this hub hasn't got, so the
    // sentence is exercised where it's built rather than through the route.
    const { describeKegWrite } = await import('./audit/details.js');
    assert.equal(describeKegWrite('3', { contents: '???' }), 'Emptied keg #3');
    assert.equal(
      describeKegWrite('3', { contents: 'Konfus IPA', abv: '6.5', date: '04/08/2026' }),
      'Put "Konfus IPA" in keg #3 — 6.5%, filled 04/08/2026',
    );
  });
});
