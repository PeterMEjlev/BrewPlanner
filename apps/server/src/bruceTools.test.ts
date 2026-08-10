import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_NOTIFICATION_SETTINGS, DEFAULT_RECIPE_SETTINGS } from '@checklist/shared';
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
type Devices = typeof import('./devices/repo.js');
type BrewSessions = typeof import('./brewSessions/repo.js');

let tools: Tools;
let repo: Repo;
let recipeRepo: RecipeRepo;
let audit: Audit;
let devices: Devices;
let brewSessions: BrewSessions;
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
  devices = await import('./devices/repo.js');
  brewSessions = await import('./brewSessions/repo.js');

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
    // Seeded and asserted from the defaults, so the point of the test — that one
    // named field moves and nothing else does — survives new settings being added.
    repo.setNotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, kegAlertDays: 30 });

    const reply = await tools.runBruceTool('update_notification_settings', { keg_alert_days: 21 }, ASKER);
    assert.match(reply, /keg age threshold 21 days/);
    assert.deepEqual(repo.getNotificationSettings(), {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      kegAlertDays: 21,
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

  // --- Speaking short -------------------------------------------------------
  //
  // A spoken answer cannot be skimmed, so the tools hand a voice session the
  // summary and the written chat the whole thing. This is enforced in the tool
  // rather than only in the persona for one reason: a model given an eight-row
  // keg table reads out an eight-row keg table, however firmly it was told to
  // be brief. The escape hatch is `detail`, which the brewer can ask for.

  it('summarises the to-do list out loud and lists it in writing', async () => {
    for (const text of ['Order more CO2', 'Clean the mash tun', 'Descale the HLT', 'Replace a gasket']) {
      repo.createTodo(text);
    }

    const spoken = await tools.runBruceTool('get_todos', {}, ASKER, true);
    const written = await tools.runBruceTool('get_todos', {}, ASKER);
    assert.match(spoken, /^4 outstanding: Order more CO2, Clean the mash tun, Descale the HLT and 1 more\.$/);
    assert.ok(spoken.length < written.length, 'the spoken form is the shorter one');
    assert.match(written, /Replace a gasket/, 'writing names every job');
    assert.doesNotMatch(spoken, /Replace a gasket/, 'speech stops counting at three');

    // What the brewer says when they want it all, whichever way they asked.
    const askedForAll = await tools.runBruceTool('get_todos', { detail: 'full' }, ASKER, true);
    assert.match(askedForAll, /Replace a gasket/);

    // And the reverse: a written answer can be asked to summarise.
    const askedShort = await tools.runBruceTool('get_todos', { detail: 'brief' }, ASKER);
    assert.match(askedShort, /4 outstanding/);
  });

  it('answers "what is in our kegs" with counts out loud', async () => {
    // The board is a Google sheet, so this drives the summariser directly —
    // what matters is the shape of the sentence, not where the rows came from.
    const summary = tools.kegSummaryForTest([
      { number: '1', contents: 'IPA', volume: '19L', abv: '6.2%', date: '', note: '' },
      { number: '2', contents: 'IPA', volume: '19L', abv: '6.2%', date: '', note: '' },
      { number: '3', contents: 'Stout', volume: '19L', abv: '5.1%', date: '', note: '' },
      { number: '4', contents: 'IPA', volume: '19L', abv: '6.2%', date: '', note: '' },
      { number: '5', contents: 'Pilsner', volume: '19L', abv: '4.8%', date: '', note: '' },
      { number: '6', contents: 'Dirty', volume: '19L', abv: '', date: '', note: '' },
    ]);
    // Most-of first: with three IPA and one pilsner, the IPA is the answer.
    assert.match(summary, /On tap: 3 × IPA, 1 × Pilsner, 1 × Stout\./);
    assert.match(summary, /Empty or unassigned: 1 dirty\./);
    assert.match(summary, /6 kegs in total/);
    // None of the per-keg detail a screen would show.
    assert.doesNotMatch(summary, /6\.2%/);
  });

  it('gives a recipe by its headline numbers out loud and its brew sheet in writing', async () => {
    // A real grain bill and hop schedule, because that is what makes the
    // difference the tool exists for: an empty sheet is short either way.
    recipeRepo.createRecipe({
      ...sheet('Spoken Saison'),
      fermentables: [
        { name: 'Pilsner malt', amount: '4.5', unit: 'kg', percent: '85', ebc: 4, ppg: 37, fermentable: null, lateAddition: false },
        { name: 'Wheat malt', amount: '0.8', unit: 'kg', percent: '15', ebc: 4, ppg: 38, fermentable: null, lateAddition: false },
      ],
      hops: [
        { name: 'Saaz', amount: '30', unit: 'g', use: 'Boil', stage: 'Boil', time: '60', timeUnit: 'min', aa: '3.5', ibu: '', form: 'Pellet', utilization: '', temp: '' },
        { name: 'Styrian Golding', amount: '25', unit: 'g', use: 'Boil', stage: 'Boil', time: '10', timeUnit: 'min', aa: '5.0', ibu: '', form: 'Pellet', utilization: '', temp: '' },
      ],
      yeast: [
        {
          name: 'Belle Saison',
          lab: 'Lallemand',
          attenuation: '85',
          amount: '1',
          amountUnit: 'pkg',
          type: 'Ale',
          form: 'Dry',
          flocculation: 'Low',
          minTempC: 15,
          maxTempC: 35,
          alcoholTolerance: '',
          starter: false,
        },
      ],
    });

    const spoken = await tools.runBruceTool('get_recipe', { name: 'Spoken Saison' }, ASKER, true);
    const written = await tools.runBruceTool('get_recipe', { name: 'Spoken Saison' }, ASKER);
    assert.match(spoken, /\*\*Spoken Saison\*\* — American IPA/);
    assert.match(spoken, /2 fermentables, 2 hop additions, Belle Saison/);
    // Out loud he says what is in it, not how much of each.
    assert.doesNotMatch(spoken, /Pilsner malt|Saaz/);
    assert.match(written, /Pilsner malt/, 'writing gets the grain bill');
    assert.match(written, /Saaz/, 'writing gets the hop schedule');
    assert.ok(spoken.length < written.length / 2, 'the spoken form is far shorter');

    const askedForAll = await tools.runBruceTool(
      'get_recipe',
      { name: 'Spoken Saison', detail: 'full' },
      ASKER,
      true,
    );
    assert.ok(askedForAll.length > spoken.length, 'asking out loud for the sheet gets the sheet');
  });

  // --- Sensor history -------------------------------------------------------
  //
  // The tool that answers "has it been stable?", which the latest-reading tool
  // structurally cannot. A device of type `other` is used deliberately: every
  // other type has a mock profile behind it, and the fallback layer would serve
  // invented demo numbers instead of the rows this test inserts.

  it('summarises a sensor over a window rather than reporting its last reading', async () => {
    const { device } = devices.createDevice('Test cellar probe', 'other');
    const at = (minutesAgo: number): string =>
      new Date(Date.now() - minutesAgo * 60_000).toISOString();
    devices.insertReadings(device.id, [
      { metric: 'temp_c', value: 18, recordedAt: at(180) },
      { metric: 'temp_c', value: 22, recordedAt: at(120) },
      { metric: 'temp_c', value: 20, recordedAt: at(60) },
    ]);

    const history = await tools.runBruceTool(
      'get_sensor_history',
      { sensor: 'cellar probe', hours: 6 },
      ASKER,
    );
    assert.match(history, /Test cellar probe/);
    assert.match(history, /20\.0 °C average/);
    assert.match(history, /18\.0 °C to 22\.0 °C/);
    // Oldest first: read backwards this says the cellar was warming, not cooling.
    assert.match(history, /started 18\.0 °C, ended 20\.0 °C/);
    assert.match(history, /3 readings/);
  });

  it('says a window is empty rather than inventing a trend, and names the sensors it has', async () => {
    const quiet = await tools.runBruceTool(
      'get_sensor_history',
      { sensor: 'cellar probe', hours: 1 },
      ASKER,
    );
    assert.match(quiet, /logged nothing/);

    const missing = await tools.runBruceTool('get_sensor_history', { sensor: 'the mash tun' }, ASKER);
    assert.match(missing, /No sensor here matches "the mash tun"/);
    assert.match(missing, /Test cellar probe/);
  });

  // --- Brew sessions ------------------------------------------------------------

  it('reads the brew-session log and works the efficiency back from the gravities', async () => {
    const empty = await tools.runBruceTool('get_brew_sessions', {}, ASKER);
    assert.match(empty, /Nothing has been logged/);

    const recipe = recipeRepo.createRecipe(sheet('Efficiency Ale'));
    const entry = brewSessions.startBrewSession(recipe.id, recipe);
    brewSessions.updateBrewSession(entry.id, {
      status: 'fermenting',
      measured: {
        ...recipe.measured,
        og: '1.058',
        fg: '1.011',
        volumeL: 20,
        preBoilGravity: '',
        preBoilVolumeL: null,
        mashTempC: 67,
        boilTimeMin: 60,
        efficiencyPct: null,
        waterL: null,
        energyKwh: null,
      },
    });

    const list = await tools.runBruceTool('get_brew_sessions', {}, ASKER);
    assert.match(list, /Efficiency Ale/);
    assert.match(list, /1\.058/);
    // ABV is derived from the gravities, not read off the recipe's target.
    assert.match(list, /6\.2 %/);

    const detail = await tools.runBruceTool(
      'get_brew_sessions',
      { recipe: 'Efficiency', full_writeup: true },
      ASKER,
    );
    assert.match(detail, /brew #1/);
    assert.match(detail, /Mashed at 67 °C/);
    assert.match(detail, /apparent attenuation/);

    const unknown = await tools.runBruceTool('get_brew_sessions', { recipe: 'Vienna Lager' }, ASKER);
    assert.match(unknown, /No brew session matches "Vienna Lager"/);
    assert.match(unknown, /Efficiency Ale/);

    const noSuchId = await tools.runBruceTool('get_brew_sessions', { id: 9999 }, ASKER);
    assert.match(noSuchId, /no brew session with id 9999/);
  });

  // --- Calculators ----------------------------------------------------------
  //
  // The figures matter more than the prose: these exist precisely so the model
  // stops doing polynomial fits in its head, and a wrong answer here would be
  // spoken with total confidence.

  it('calculates dilution, hydrometer correction and carbonation pressure', async () => {
    // 20 L at 1.060 diluted to 1.050 → 24 L, i.e. 4 L of water.
    const water = await tools.runBruceTool(
      'brewing_calculator',
      { kind: 'dilution', volume_l: 20, current_gravity: 1.06, desired_gravity: 1.05 },
      ASKER,
    );
    assert.match(water, /Add \*\*4\.0 L\*\* of water/);
    assert.match(water, /becomes 24\.0 L/);

    // Warm sample, calibrated at 20 °C: the true gravity is above what was read.
    const corrected = await tools.runBruceTool(
      'brewing_calculator',
      { kind: 'hydrometer', reading: 1050, sample_temp_c: 30 },
      ASKER,
    );
    assert.match(corrected, /Corrected gravity \*\*1\.05[23]\*\*/);

    // 2.4 volumes at 4 °C (39 °F) is ~11 PSI on a force-carbonation chart —
    // the figure this is here to stop the model guessing at.
    const pressure = await tools.runBruceTool(
      'brewing_calculator',
      { kind: 'carbonation', co2_volumes: 2.4, keg_temp_c: 4 },
      ASKER,
    );
    assert.match(pressure, /Set the regulator to \*\*0\.74 bar\*\* \(10\.8 PSI\)/);

    // A style alone is answered with the range and a question, never a guess.
    const style = await tools.runBruceTool(
      'brewing_calculator',
      { kind: 'carbonation', style: 'German wheat beer' },
      ASKER,
    );
    assert.match(style, /3\.3–4\.5 volumes/);
    assert.doesNotMatch(style, /Set the regulator/);
  });

  it('refuses impossible calculations instead of returning a number', async () => {
    const backwards = await tools.runBruceTool(
      'brewing_calculator',
      { kind: 'dilution', volume_l: 20, current_gravity: 1.04, desired_gravity: 1.06 },
      ASKER,
    );
    assert.match(backwards, /only lowers gravity/);

    const missing = await tools.runBruceTool('brewing_calculator', { kind: 'carbonation' }, ASKER);
    assert.match(missing, /needs the volumes of CO2 and the keg temperature/);
  });

  // --- The rig, read-only ---------------------------------------------------

  it('reports the rig as unconfigured rather than pretending to read it', async () => {
    const previous = process.env.BREW_SYSTEM_URL;
    delete process.env.BREW_SYSTEM_URL;
    try {
      const rig = await tools.runBruceTool('get_rig_status', {}, ASKER);
      assert.match(rig, /not configured on this hub/);
    } finally {
      if (previous != null) process.env.BREW_SYSTEM_URL = previous;
    }
  });

  // --- Kegs, written --------------------------------------------------------
  //
  // The keg board is a Google spreadsheet, so only the paths that never touch it
  // are pinned here. That is deliberate rather than a gap: the guards below are
  // what stops a misheard sentence reaching a real brewery's board, and the
  // write itself is refused outright without KEG_SHEET_WRITE_URL — which this
  // test removes so that it cannot possibly write to the live sheet.

  it('will not touch the keg board on a half-formed instruction', async () => {
    const previous = process.env.KEG_SHEET_WRITE_URL;
    delete process.env.KEG_SHEET_WRITE_URL;
    try {
      const nameless = await tools.runBruceTool('manage_keg', { action: 'empty' }, ASKER);
      assert.match(nameless, /Which keg\?/);

      const aimless = await tools.runBruceTool('manage_keg', { number: '3' }, ASKER);
      assert.match(aimless, /fill, empty, clean or edit/);

      const nonsense = await tools.runBruceTool('manage_keg', { number: '3', action: 'burn' }, ASKER);
      assert.match(nonsense, /not one of fill, empty, clean or edit/);

      // Filling without saying what with is a question, not a write — and it is
      // answered before the sheet is read, so this makes no network call.
      const contentless = await tools.runBruceTool('manage_keg', { number: '3', action: 'fill' }, ASKER);
      assert.match(contentless, /what went in it/);
    } finally {
      if (previous != null) process.env.KEG_SHEET_WRITE_URL = previous;
    }
  });

  // --- The brewery speaker --------------------------------------------------
  //
  // Everything that reaches the speaker needs one on the network, so what is
  // pinned here is the half that doesn't: which track a spoken phrase picks out
  // of the queue, and the refusals that happen before any command is sent.

  const QUEUE = [
    { position: 1, title: 'Thunder Road', artist: 'Bruce Springsteen', album: null, albumArtUrl: null, uri: 'x:1' },
    { position: 2, title: 'Born to Run', artist: 'Bruce Springsteen', album: null, albumArtUrl: null, uri: 'x:2' },
    { position: 3, title: 'Thunder Road (Live)', artist: 'Bruce Springsteen', album: null, albumArtUrl: null, uri: 'x:3' },
    { position: 4, title: 'Hoppy Days', artist: 'The Brewers', album: null, albumArtUrl: null, uri: 'x:4' },
    // The same song queued twice — a duplicate, not an ambiguity.
    { position: 5, title: 'Born to Run', artist: 'Bruce Springsteen', album: null, albumArtUrl: null, uri: 'x:2' },
  ];

  it('picks a queued track by title or artist, and refuses to choose between several', () => {
    const byTitle = tools.matchQueueTracks(QUEUE, 'thunder road');
    assert.deepEqual(byTitle.map((t) => t.position), [1], 'the exact title beats the live version');

    const byArtist = tools.matchQueueTracks(QUEUE, 'The Brewers');
    assert.deepEqual(byArtist.map((t) => t.position), [4]);

    // "play the Springsteen one" is three songs — a question, not a coin flip.
    const ambiguous = tools.matchQueueTracks(QUEUE, 'Springsteen');
    assert.deepEqual(ambiguous.map((t) => t.position), [1, 2, 3]);

    // Both copies of one song are the same request; play the first.
    assert.deepEqual(tools.matchQueueTracks(QUEUE, 'Born to Run').map((t) => t.position), [2]);

    assert.deepEqual(tools.matchQueueTracks(QUEUE, 'Fermentation Blues'), []);
    assert.deepEqual(tools.matchQueueTracks(QUEUE, '   '), []);
  });

  it('says what is playing as a sentence out loud and a list on screen', () => {
    const now = {
      state: 'playing' as const,
      title: 'Thunder Road',
      artist: 'Bruce Springsteen',
      album: 'Born to Run',
      albumArtUrl: null,
      durationSec: 289,
      positionSec: 65,
      volume: 22,
      room: 'Brewery',
      queuePosition: 1,
      shuffle: true,
      repeat: 'one' as const,
    };

    const spoken = tools.nowPlayingText(now, true);
    assert.match(spoken, /Thunder Road by Bruce Springsteen/);
    assert.match(spoken, /Shuffle is on and the current track repeats/);
    assert.doesNotMatch(spoken, /[*|#]/, 'nothing to read aloud as "asterisk"');

    const written = tools.nowPlayingText(now, false);
    assert.match(written, /\*\*Thunder Road\*\* by Bruce Springsteen/);
    assert.match(written, /1:05 of 4:49/);
    assert.match(written, /Volume 22/);

    // A speaker with nothing loaded still answers the play mode, since "is
    // shuffle on?" is a fair question with the music stopped.
    const idle = tools.nowPlayingText(
      { ...now, state: 'no_media' as const, title: null, artist: null, shuffle: false, repeat: 'off' as const },
      true,
    );
    assert.match(idle, /not playing anything/);
    assert.match(idle, /Shuffle is off and repeat is off/);
  });

  it('reads the queue as a count and what is next out loud, and in full on screen', () => {
    const queue = { tracks: QUEUE, currentPosition: 2 };

    const spoken = tools.queueText(queue, true);
    assert.match(spoken, /^5 tracks in the queue, on number 2\./);
    // Three named, then counted — a queue read out track by track is unusable.
    assert.match(spoken, /Coming up: Thunder Road \(Live\) by Bruce Springsteen, Hoppy Days by The Brewers and Born to Run by Bruce Springsteen\./);

    const written = tools.queueText(queue, false);
    assert.match(written, /\| # \| Track \| Artist \|/);
    assert.match(written, /\| 2 ▶ \| Born to Run \| Bruce Springsteen \|/);
    assert.equal(written.split('\n').filter((line) => /^\| \d/.test(line)).length, QUEUE.length);

    const empty = tools.queueText({ tracks: [], currentPosition: null }, true);
    assert.match(empty, /no queue on the speaker/);
  });

  it('answers a half-formed music command without reaching for the speaker', async () => {
    // Both of these are refused before any Sonos call, so they run offline.
    const trackless = await tools.runBruceTool('control_music', { action: 'play_track' }, ASKER);
    assert.match(trackless, /Which track\?/);

    const nonsense = await tools.runBruceTool('control_music', { action: 'crank_it' }, ASKER);
    assert.match(nonsense, /not something control_music does/);
  });
});
