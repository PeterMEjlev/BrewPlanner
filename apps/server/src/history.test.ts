import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/**
 * Narrowing the change history.
 *
 * What matters here is that the filters run in SQL: the log is read newest-first
 * under a cap, so a filter applied after the fact would only ever search the most
 * recent page of it — "everything Peter did to the kegs" would stop wherever the
 * cap happened to fall. The test that pins this is the one that asks for an old
 * entry with a cap of 1: it can only pass if the filter reached the database.
 *
 * DATABASE_PATH must be set before the db module loads, hence dynamic imports.
 */

let booted: Promise<typeof import('./audit/repo.js')> | null = null;

function boot() {
  if (!booted) {
    booted = (async () => {
      process.env.DATABASE_PATH = join(tmpdir(), `brewplanner-history-${randomUUID()}.sqlite`);
      const database = await import('./db/index.js');
      database.runMigrations();
      return import('./audit/repo.js');
    })();
  }
  return booted;
}

/** Insert one entry, back-dated, so ordering and time windows are testable. */
async function record(
  username: string,
  entity: string,
  action: string,
  createdAt: string,
): Promise<void> {
  const { sqlite } = await import('./db/index.js');
  sqlite
    .prepare(
      'insert into audit_log (user_id, username, action, entity, method, path, created_at) values (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(null, username, action, entity, 'PUT', '/api/test', createdAt);
}

const DAY = 86_400_000;
const ago = (days: number): string => new Date(Date.now() - days * DAY).toISOString();

test('the change history narrows by time, account and category', async () => {
  const audit = await boot();

  await record('peter', 'Keg', 'Put "IPA" in keg #3', ago(200));
  await record('peter', 'Keg', 'Emptied keg #4', ago(2));
  await record('peter', 'Settings', 'Changed keg-age alerts to off', ago(1));
  await record('anna', 'Keg', 'Emptied keg #1', ago(3));
  await record('anna', 'Recipe', 'Edited recipe "Saison": the hops', ago(400));

  assert.equal(audit.listAudit().length, 5);

  // Newest first, whoever made them.
  assert.deepEqual(
    audit.listAudit().map((e) => e.action),
    [
      'Changed keg-age alerts to off',
      'Emptied keg #4',
      'Emptied keg #1',
      'Put "IPA" in keg #3',
      'Edited recipe "Saison": the hops',
    ],
  );

  // One filter at a time.
  assert.equal(audit.listAudit({ username: 'anna' }).length, 2);
  assert.equal(audit.listAudit({ entity: 'Keg' }).length, 3);
  assert.equal(audit.listAudit({ since: ago(7) }).length, 3);

  // …and together, which is the combination the page actually sends.
  const annasKegs = audit.listAudit({ username: 'anna', entity: 'Keg', since: ago(7) });
  assert.deepEqual(annasKegs.map((e) => e.action), ['Emptied keg #1']);
});

test('the cap counts matching rows, not rows it then throws away', async () => {
  const audit = await boot();

  // The oldest entry in the log, and the only recipe one belonging to anna. A
  // filter applied after the cap would find nothing here — the newest single
  // row is one of peter's, and this entry is four rows further down.
  const oldest = audit.listAudit({ username: 'anna', entity: 'Recipe', limit: 1 });
  assert.deepEqual(oldest.map((e) => e.action), ['Edited recipe "Saison": the hops']);
});

test('the filter options are drawn from the log itself, sorted and deduplicated', async () => {
  const audit = await boot();
  assert.deepEqual(audit.auditFilters(), {
    usernames: ['anna', 'peter'],
    entities: ['Keg', 'Recipe', 'Settings'],
  });
});
