import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_RECIPE_SETTINGS } from '@checklist/shared';
import type { RecipeEditInput } from '@checklist/shared';

/**
 * The tools Bruce's text chat can reach (bruce/tools.ts), driven against a real
 * temp-file database.
 *
 * The reads are worth little here — they format rows nobody disputes. What is
 * pinned is the *writing* half, because a chat model holds the trigger:
 *
 *   - a change touches only what was asked for (the other settings survive)
 *   - an ambiguous or missing target changes nothing at all
 *   - out-of-range values are refused rather than clamped into the database
 *   - every change that lands leaves an audit entry naming who asked, since the
 *     request-level audit hook cannot see these (the chat route hijacks its own
 *     response, so `onResponse` never fires for it)
 *
 * DATABASE_PATH must be set before the db module loads, hence dynamic imports.
 */

const dir = mkdtempSync(join(tmpdir(), 'brewplanner-brucetools-'));
process.env.DATABASE_PATH = join(dir, 'test.sqlite');

type Tools = typeof import('./bruce/tools.js');
type Repo = typeof import('./repo.js');
type RecipeRepo = typeof import('./recipeRepo.js');
type Audit = typeof import('./audit/repo.js');

let tools: Tools;
let repo: Repo;
let recipeRepo: RecipeRepo;
let audit: Audit;
let sqlite: import('better-sqlite3').Database;

/**
 * The account asking the questions. It has to be a real row: the audit log's
 * `user_id` is a foreign key, and `foreign_keys = ON`, so recording against an
 * invented id fails — which is exactly what a silently-swallowed audit write
 * would then hide. Filled in by `before`.
 */
let ASKER = { userId: 0, username: 'peter' };

/** Enough of a brew sheet to save; nothing here is under test. */
function sheet(name: string): RecipeEditInput {
  return {
    name,
    style: 'American IPA',
    settings: { ...DEFAULT_RECIPE_SETTINGS },
    og: '1.060',
    preBoilGravity: null,
    postBoilGravity: null,
    fg: '1.012',
    abv: '6.3',
    ibu: '55',
    ebc: '12',
    ebcEstimated: false,
    batchSizeL: 20,
    mashTemp: '67°C',
    fermentationTemp: '19°C',
    fermentables: [],
    hops: [],
    yeast: [],
    otherIngredients: [],
    mashGuidelines: null,
    waterProfile: null,
  };
}

/** The newest audit entry's action text, or null when nothing was recorded. */
function lastAudit(): string | null {
  return audit.listAudit(1)[0]?.action ?? null;
}

before(async () => {
  const database = await import('./db/index.js');
  database.runMigrations();
  sqlite = database.sqlite;
  tools = await import('./bruce/tools.js');
  repo = await import('./repo.js');
  recipeRepo = await import('./recipeRepo.js');
  audit = await import('./audit/repo.js');

  const { upsertUser } = await import('./auth/users.js');
  ASKER = { userId: upsertUser('peter', 'a-long-enough-test-password').id, username: 'peter' };
});

after(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Bruce chat tools', () => {
  it('offers every tool with a name and a phase', () => {
    const definitions = tools.bruceToolDefinitions() as { name?: string }[];
    assert.ok(definitions.length >= 8, 'the brewery tools are attached');
    for (const definition of definitions) {
      assert.ok(definition.name, 'every tool is named');
      assert.ok(tools.bruceToolPhase(definition.name, {}), `${definition.name} reports a phase`);
    }
    assert.equal(tools.bruceToolPhase('invented_tool', {}), null);
  });

  it('answers an unknown tool in text rather than throwing', async () => {
    const reply = await tools.runBruceTool('invented_tool', {}, ASKER);
    assert.match(reply, /no tool called invented_tool/);
  });

  // --- To-dos ---------------------------------------------------------------

  it('adds, completes and deletes to-dos, and refuses to guess between them', async () => {
    const added = await tools.runBruceTool('manage_todo', { action: 'add', text: 'Order more CO2' }, ASKER);
    assert.match(added, /Added "Order more CO2"/);
    assert.match(lastAudit() ?? '', /^Bruce: added a to-do "Order more CO2"$/);
    await tools.runBruceTool('manage_todo', { action: 'add', text: 'Order more caps' }, ASKER);

    // "order more" matches both — that has to be a question, not a coin flip.
    const ambiguous = await tools.runBruceTool('manage_todo', { action: 'complete', text: 'order more' }, ASKER);
    assert.match(ambiguous, /Several to-dos match/);
    assert.match(ambiguous, /Nothing was changed/);
    assert.equal(repo.listTodos().filter((t) => t.done).length, 0);

    const ticked = await tools.runBruceTool('manage_todo', { action: 'complete', text: 'CO2' }, ASKER);
    assert.match(ticked, /Ticked off "Order more CO2"/);
    assert.equal(repo.listTodos().find((t) => t.text === 'Order more CO2')?.done, true);
    assert.match(lastAudit() ?? '', /completed the to-do "Order more CO2"/);

    // complete_todo works on outstanding items only, so a done one is a miss.
    const again = await tools.runBruceTool('manage_todo', { action: 'complete', text: 'CO2' }, ASKER);
    assert.match(again, /Nothing on the to-do list matches/);

    const removed = await tools.runBruceTool('manage_todo', { action: 'delete', text: 'caps' }, ASKER);
    assert.match(removed, /Deleted "Order more caps"/);
    assert.equal(repo.listTodos().some((t) => t.text === 'Order more caps'), false);

    const cleared = await tools.runBruceTool('manage_todo', { action: 'clear_completed' }, ASKER);
    assert.match(cleared, /Cleared 1 completed item/);
    assert.equal(repo.listTodos().length, 0);

    const nothing = await tools.runBruceTool('manage_todo', { action: 'clear_completed' }, ASKER);
    assert.match(nothing, /no completed items to clear/);
  });

  it('records the change against whoever asked, not against Bruce', async () => {
    await tools.runBruceTool('manage_todo', { action: 'add', text: 'Swap the CO2 bottle' }, ASKER);
    const entry = audit.listAudit(1)[0];
    assert.equal(entry?.username, 'peter');
    assert.equal(entry?.userId, ASKER.userId);
    assert.equal(entry?.entity, 'To-do');
    assert.match(entry?.action ?? '', /^Bruce: /);
    await tools.runBruceTool('manage_todo', { action: 'delete', text: 'Swap the CO2 bottle' }, ASKER);
  });

  // --- The fermenter --------------------------------------------------------

  it('sets the fermenter from a loose recipe name, and keeps clean/dirty separate', async () => {
    recipeRepo.createRecipe(sheet('Hazy Boi NEIPA v3'));

    const missing = await tools.runBruceTool('set_fermenter', { action: 'set', name: 'gueuze' }, ASKER);
    assert.match(missing, /No recipe matches "gueuze", so nothing changed/);
    assert.equal(repo.getActiveRecipe(), null);

    const set = await tools.runBruceTool('set_fermenter', { action: 'set', name: 'the NEIPA' }, ASKER);
    assert.match(set, /Hazy Boi NEIPA v3/);
    assert.equal(repo.getActiveRecipe()?.name, 'Hazy Boi NEIPA v3');

    repo.setFermenterState('dirty');
    const cleared = await tools.runBruceTool('set_fermenter', { action: 'clear' }, ASKER);
    assert.match(cleared, /no longer in it/);
    assert.equal(repo.getActiveRecipe(), null);
    assert.equal(repo.getFermenterState(), 'dirty', 'emptying the tank does not wash it');

    const washed = await tools.runBruceTool('set_fermenter', { action: 'mark_clean' }, ASKER);
    assert.match(washed, /marked \*\*clean\*\*/);
    assert.equal(repo.getFermenterState(), 'clean');

    const empty = await tools.runBruceTool('set_fermenter', { action: 'clear' }, ASKER);
    assert.match(empty, /already empty, so nothing changed/);
  });

  // --- Settings -------------------------------------------------------------

  it('changes only the notification field it was given', async () => {
    repo.setNotificationSettings({ kegAlertEnabled: true, kegAlertDays: 30, fermentDoneEnabled: true });

    const reply = await tools.runBruceTool('update_notification_settings', { keg_alert_days: 21 }, ASKER);
    assert.match(reply, /keg age threshold 21 days/);
    assert.deepEqual(repo.getNotificationSettings(), {
      kegAlertEnabled: true,
      kegAlertDays: 21,
      fermentDoneEnabled: true,
    });

    const refused = await tools.runBruceTool('update_notification_settings', { keg_alert_days: 900 }, ASKER);
    assert.match(refused, /between 1 and 365/);
    assert.match(refused, /Nothing changed/);
    assert.equal(repo.getNotificationSettings().kegAlertDays, 21);

    const empty = await tools.runBruceTool('update_notification_settings', {}, ASKER);
    assert.match(empty, /nothing changed/);
  });

  it('bounds the recipe defaults instead of clamping them', async () => {
    const before = repo.getRecipeDefaults();

    const ok = await tools.runBruceTool('update_recipe_defaults', { batch_size_l: 50, efficiency_percent: 75 }, ASKER);
    assert.match(ok, /batch size l 50 L/);
    assert.equal(repo.getRecipeDefaults().batchSizeL, 50);
    assert.equal(repo.getRecipeDefaults().efficiencyPercent, 75);
    assert.equal(repo.getRecipeDefaults().boilTimeMinutes, before.boilTimeMinutes, 'untouched fields survive');
    assert.equal(repo.getRecipeDefaults().pitchRate, before.pitchRate, 'the free-text fields are never written');

    const refused = await tools.runBruceTool('update_recipe_defaults', { efficiency_percent: 250 }, ASKER);
    assert.match(refused, /must be between 1 and 100/);
    assert.equal(repo.getRecipeDefaults().efficiencyPercent, 75);
  });

  it('recolours one line at a time and rejects anything that is not a hex value', async () => {
    const named = await tools.runBruceTool(
      'set_color',
      { target: 'graph_line', item: 'electricity', color: 'reddish' },
      ASKER,
    );
    assert.match(named, /not a #rrggbb hex colour/);

    const done = await tools.runBruceTool(
      'set_color',
      { target: 'graph_line', item: 'electricity', color: '#EF4444' },
      ASKER,
    );
    assert.match(done, /`#ef4444`/);
    const colors = repo.getGraphColors();
    assert.equal(colors.power, '#ef4444');
    assert.equal(colors.water, '#3b82f6', 'the other lines are carried over');

    const keg = await tools.runBruceTool(
      'set_color',
      { target: 'keg_content', item: 'stout', color: '#101010' },
      ASKER,
    );
    assert.match(keg, /Stout kegs are now/);
    assert.equal(repo.getKegContentColors().Stout, '#101010');
    assert.equal(repo.getKegContentColors().IPA, '#C8782A', 'the rest of the palette is carried over');

    const unknown = await tools.runBruceTool(
      'set_color',
      { target: 'keg_content', item: 'Gose', color: '#101010' },
      ASKER,
    );
    assert.match(unknown, /no keg content called "Gose"/);
  });

  it('says out loud what switching a sensor to mock means', async () => {
    // Every sensor ships set to mock, so start from the interesting side.
    await tools.runBruceTool('set_device_source', { sensor: 'fermenter_controller', source: 'real' }, ASKER);

    const mocked = await tools.runBruceTool(
      'set_device_source',
      { sensor: 'fermenter_controller', source: 'mock' },
      ASKER,
    );
    assert.match(mocked, /mock demo data/);
    assert.match(mocked, /invented numbers/);
    const sources = repo.getDeviceDataSources();
    assert.equal(sources.fermenter_controller, 'mock');

    const noop = await tools.runBruceTool(
      'set_device_source',
      { sensor: 'fermenter_controller', source: 'mock' },
      ASKER,
    );
    assert.match(noop, /already set to mock, so nothing changed/);

    const back = await tools.runBruceTool(
      'set_device_source',
      { sensor: 'fermenter_controller', source: 'real' },
      ASKER,
    );
    assert.match(back, /real readings/);
    assert.equal(repo.getDeviceDataSources().fermenter_controller, 'real');

    const unknown = await tools.runBruceTool('set_device_source', { sensor: 'kettle', source: 'real' }, ASKER);
    assert.match(unknown, /no sensor called "kettle"/);
  });

  // --- Devices --------------------------------------------------------------

  it('refuses to configure a device it cannot pin down', async () => {
    const missing = await tools.runBruceTool(
      'configure_device',
      { device: 'nothing-like-this', interval_seconds: 60 },
      ASKER,
    );
    assert.match(missing, /No device matches/);
    assert.match(missing, /Nothing changed/);

    const nothingAsked = await tools.runBruceTool('configure_device', { device: 'fermenter' }, ASKER);
    assert.match(nothingAsked, /Neither a logging interval nor a setpoint/);
  });

  it('will not queue a setpoint onto a device that has no setpoint', async () => {
    const { createDevice } = await import('./devices/repo.js');
    createDevice('Test water meter', 'water_meter');
    // Pinned to real, so the fallback layer treats it as the device it is.
    repo.setDeviceDataSources({ ...repo.getDeviceDataSources(), water: 'real' });

    const refused = await tools.runBruceTool(
      'configure_device',
      { device: 'Test water meter', setpoint_c: 4 },
      ASKER,
    );
    assert.match(refused, /has no setpoint/);
    assert.match(refused, /Nothing changed/);

    const bounds = await tools.runBruceTool(
      'configure_device',
      { device: 'Test water meter', interval_seconds: 99999 },
      ASKER,
    );
    assert.match(bounds, /must be between/);

    const cadence = await tools.runBruceTool(
      'configure_device',
      { device: 'Test water meter', interval_seconds: 120 },
      ASKER,
    );
    assert.match(cadence, /every 120 s/);
    assert.match(lastAudit() ?? '', /logging interval to 120s/);
  });

  // --- Reads ----------------------------------------------------------------

  it('reads the hub without needing any devices to exist', async () => {
    const overview = await tools.runBruceTool('get_brewery_status', {}, ASKER);
    assert.match(overview, /## Fermenter/);
    assert.match(overview, /## Alerts/);

    const settings = await tools.runBruceTool('get_settings', { section: 'notifications' }, ASKER);
    assert.match(settings, /Keg age alert/);

    const bogus = await tools.runBruceTool('get_settings', { section: 'nonsense' }, ASKER);
    assert.match(bogus, /no settings section called "nonsense"/);

    const todos = await tools.runBruceTool('get_todos', {}, ASKER);
    assert.match(todos, /to-do list is empty|Outstanding/);
  });
});
