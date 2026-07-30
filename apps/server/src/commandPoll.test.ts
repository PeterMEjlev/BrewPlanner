import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

/**
 * Command long-polling — the path that gets a setpoint change onto the hardware
 * now instead of on the agent's next read cycle.
 *
 * What's worth pinning is that the wake-up is genuinely event-driven: a poll
 * asking to be held for ten seconds must come back in milliseconds when someone
 * queues a setpoint. A regression here wouldn't fail anything loudly — it would
 * quietly go back to "your fridge changes temperature in up to five minutes",
 * which is exactly the bug this replaced.
 *
 * DATABASE_PATH must be set before the db module loads, hence dynamic imports.
 */

const dir = mkdtempSync(join(tmpdir(), 'brewplanner-commands-'));
process.env.DATABASE_PATH = join(dir, 'test.sqlite');
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-be-accepted';
process.env.ADMIN_PASSWORD = 'test-admin-password';

let app: FastifyInstance;
let sqlite: import('better-sqlite3').Database;
let repo: typeof import('./devices/repo.js');
let deviceId: number;
let auth: { authorization: string };

before(async () => {
  const { buildApp } = await import('./app.js');
  sqlite = (await import('./db/index.js')).sqlite;
  repo = await import('./devices/repo.js');
  app = await buildApp({ logger: false });
  await app.ready();

  const created = repo.createDevice('Test Controller', 'brew_controller');
  deviceId = created.device.id;
  auth = { authorization: `Bearer ${created.key}` };
});

after(async () => {
  await app.close();
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/commands', () => {
  it('answers immediately when no wait is asked for', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/commands', headers: auth });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  });

  it('hands over an already-queued command without parking', async () => {
    repo.queueSetpoint(deviceId, 12);
    const res = await app.inject({ method: 'GET', url: '/api/commands?wait=10', headers: auth });
    assert.equal(res.statusCode, 200);
    const [command] = res.json();
    assert.equal(command.command, 'set_setpoint');
    assert.equal(command.value, 12);
    repo.ackCommands(deviceId, [command.id]);
  });

  it('wakes a parked poll the moment a setpoint is queued', async () => {
    const started = Date.now();
    // Deliberately not awaited: the request has to be in flight and parked
    // before the setpoint is queued, which is the case this is here to prove.
    const parked = app.inject({ method: 'GET', url: '/api/commands?wait=10', headers: auth });
    await new Promise((resolve) => setTimeout(resolve, 50));

    repo.queueSetpoint(deviceId, 19.5);

    const res = await parked;
    const elapsed = Date.now() - started;
    assert.equal(res.statusCode, 200);
    const [command] = res.json();
    assert.equal(command.value, 19.5);
    // The whole point: woken by the queue, not by the 10s hold expiring.
    assert.ok(elapsed < 2000, `expected an event-driven wake-up, took ${elapsed}ms`);
    repo.ackCommands(deviceId, [command.id]);
  });

  it('gives up after the requested wait when nothing is queued', async () => {
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/api/commands?wait=1', headers: auth });
    const elapsed = Date.now() - started;
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
    assert.ok(elapsed >= 900, `expected the hub to hold the poll, returned after ${elapsed}ms`);
  });

  it('only wakes the device the command was queued for', async () => {
    const other = repo.createDevice('Other Controller', 'brew_controller');
    const started = Date.now();
    const parked = app.inject({
      method: 'GET',
      url: '/api/commands?wait=1',
      headers: { authorization: `Bearer ${other.key}` },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    repo.queueSetpoint(deviceId, 8);

    const res = await parked;
    assert.deepEqual(res.json(), []);
    assert.ok(Date.now() - started >= 900, 'another device’s command must not wake this poll');
    repo.ackCommands(deviceId, repo.pendingCommands(deviceId).map((c) => c.id));
  });

  it('rejects a wait beyond the cap rather than holding a connection open', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/commands?wait=600', headers: auth });
    assert.equal(res.statusCode, 400);
  });

  it('still requires a device key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/commands?wait=10' });
    assert.equal(res.statusCode, 401);
  });
});
