import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

/**
 * Route-level tests, driven through `app.inject()` against a temp-file database
 * — no socket, no port. What's worth pinning here is the auth boundary: the Pi's
 * kiosk on the LAN is trusted without a login, while anything arriving over the
 * Cloudflare tunnel is not, and that difference is decided by request headers. A
 * regression there wouldn't crash anything; it would quietly open up the API.
 *
 * DATABASE_PATH must be set before the db module loads, hence dynamic imports.
 */

const dir = mkdtempSync(join(tmpdir(), 'brewplanner-app-'));
process.env.DATABASE_PATH = join(dir, 'test.sqlite');
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-be-accepted';
process.env.ADMIN_PASSWORD = 'test-admin-password';

/** Headers Cloudflare adds, which mark a request as *not* trusted-local. */
const REMOTE = { 'cf-connecting-ip': '203.0.113.7', 'cf-ray': 'test-ray' };

let app: FastifyInstance;
let sqlite: import('better-sqlite3').Database;

before(async () => {
  const { buildApp } = await import('./app.js');
  sqlite = (await import('./db/index.js')).sqlite;
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/auth/me', () => {
  it('trusts a LAN request without a login', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { user: null, isLocal: true });
  });

  it('does not trust a request that came through the tunnel', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: REMOTE });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { user: null, isLocal: false });
  });
});

/**
 * The brew-stage controls on the Brew System page (and on the rig's own screen,
 * which asks this server the same question) are gated on this flag: a stage mark
 * exists to label a logged session's temperature curve, so with nothing at
 * `brewing` there is nothing for one to belong to and the card goes inert.
 *
 * It is answered from this server's logbook, not the rig, which is why it has to
 * be on the envelope even on the sweeps where there is no rig to reach — the
 * panel would otherwise lose its stage controls whenever the rig was off.
 */
describe('GET /api/brew-system/state', () => {
  it('says whether a brew session is being brewed, rig or no rig', async () => {
    const active = async (): Promise<unknown> =>
      (await app.inject({ method: 'GET', url: '/api/brew-system/state' })).json()
        .brewSessionActive;

    assert.equal(await active(), false);

    const at = new Date().toISOString();
    const row = sqlite
      .prepare(
        `INSERT INTO brew_sessions (recipe_snapshot, status, brewed_at, created_at, updated_at)
         VALUES ('{}', 'brewing', ?, ?, ?)`,
      )
      .run(at, at, at);
    assert.equal(await active(), true);

    // Once the wort is in the tank the brewing system is no longer in use — the
    // batch stays in the logbook for weeks, the brew day is over.
    sqlite
      .prepare(`UPDATE brew_sessions SET status = 'fermenting' WHERE id = ?`)
      .run(row.lastInsertRowid);
    assert.equal(await active(), false);
  });
});

describe('guarded routes', () => {
  it('serves the device list to the LAN kiosk', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/devices' });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json()));
  });

  it('rejects an anonymous remote read with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/devices', headers: REMOTE });
    assert.equal(res.statusCode, 401);
  });

  it('rejects an anonymous remote write with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/devices/1/setpoint',
      headers: REMOTE,
      payload: { value: 18 },
    });
    assert.equal(res.statusCode, 401);
  });

  it('rejects ingestion without a device key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ingest',
      payload: { readings: [] },
    });
    assert.equal(res.statusCode, 401);
  });
});

describe('login', () => {
  it('refuses a wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'not-the-password' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('issues a bearer token that authenticates an otherwise-refused remote read', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: process.env.ADMIN_PASSWORD },
    });
    assert.equal(login.statusCode, 200);
    const token = login.json().token as string;
    assert.ok(token, 'login should return a bearer token for the native app');

    const res = await app.inject({
      method: 'GET',
      url: '/api/devices',
      headers: { ...REMOTE, authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
  });
});

describe('request handling', () => {
  it('400s a history request with an unparseable `since`', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/devices/1/history?since=yesterday' });
    assert.equal(res.statusCode, 400);
  });

  it('404s an unknown API route rather than falling through to the SPA', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: 'Not found' });
  });
});
