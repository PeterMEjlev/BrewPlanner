'use strict';
/**
 * Bruce test suite — `npm test --workspace @checklist/bruce`.
 *
 * Pure logic only: no microphone, no speaker, no OpenAI, no BrewPlanner
 * server. The engine's RealtimeClient/AudioManager methods are stubbed per
 * test, and the watchdog/session timeouts are shrunk via the BRUCE_* env
 * overrides (which must be set before config.js is first required).
 */
process.env.BRUCE_THINKING_TIMEOUT_MS = '300';
process.env.BRUCE_SPEAKING_TIMEOUT_MS = '400';
process.env.BRUCE_LISTENING_GRACE_MS = '100';
process.env.BRUCE_MAX_UTTERANCE_MS = '200';
process.env.BRUCE_SESSION_IDLE_TIMEOUT_MS = '500';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { EventEmitter } = require('events');

// Reminder persistence goes to a throwaway dir, never the real ~/.bruce.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruce-test-'));
process.env.BRUCE_STATE_DIR = stateDir;

const BruceAssistant = require('../src/engine');
const RealtimeClient = require('../src/engine/RealtimeClient.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(name) {
  passed++;
  console.log(`  PASS  ${name}`);
}

function makeBruce() {
  const bruce = new BruceAssistant({
    picovoiceKey: 'fake',
    openaiKey: 'fake',
    wakeWordPath: path.join(__dirname, '..', 'wake-words', 'Bruce_en_windows_v3_0_0.ppn'),
  });
  bruce.on('error', () => {}); // tests inspect state, not stderr
  return bruce;
}

/** An EventEmitter standing in for the assistant in function-module tests. */
function makeStub(spoken = []) {
  const stub = new EventEmitter();
  stub.handlers = new Map();
  stub.registerFunction = (name, _d, _p, h) => stub.handlers.set(name, h);
  stub.speak = (t) => spoken.push(t);
  return stub;
}

(async () => {
  // ── Engine: watchdog ─────────────────────────────────────────────────────

  {
    const bruce = makeBruce();
    let idleEmitted = false;
    bruce.on('idle', () => { idleEmitted = true; });
    bruce._setState('thinking');
    await sleep(500);
    assert.strictEqual(bruce.state, 'idle');
    assert.ok(idleEmitted);
    ok('thinking watchdog forces idle after timeout');
  }

  {
    const bruce = makeBruce();
    bruce._setState('thinking');
    await sleep(100);
    bruce._setState('idle'); // normal exit clears the watchdog
    let forced = false;
    bruce.on('idle', () => { forced = true; });
    await sleep(500);
    assert.strictEqual(forced, false);
    ok('watchdog cleared on normal state exit');
  }

  // ── Engine: session lifecycle ────────────────────────────────────────────

  {
    const bruce = makeBruce();
    bruce._setState('thinking');
    bruce._realtime.emit('disconnected', { code: 1006, deliberate: false });
    assert.strictEqual(bruce.state, 'idle');
    ok('unexpected disconnect mid-conversation forces idle');

    bruce._setState('thinking');
    bruce._realtime.emit('disconnected', { code: 1000, deliberate: true });
    assert.strictEqual(bruce.state, 'thinking');
    bruce._setState('idle');
    ok('deliberate disconnect is ignored');
  }

  {
    const bruce = makeBruce();
    let calls = 0;
    bruce._realtime.connect = () => { calls++; return sleep(100); };
    await Promise.all([bruce._ensureConnected(), bruce._ensureConnected()]);
    assert.strictEqual(calls, 1);
    Object.defineProperty(bruce._realtime, 'isReady', { get: () => true });
    await bruce._ensureConnected();
    assert.strictEqual(calls, 1);
    ok('_ensureConnected dedupes and respects isReady');
  }

  {
    const bruce = makeBruce();
    let disconnected = false;
    Object.defineProperty(bruce._realtime, 'isReady', { get: () => !disconnected });
    bruce._realtime.disconnect = () => { disconnected = true; };
    bruce._setState('idle');
    await sleep(800);
    assert.ok(disconnected);
    ok('idle timeout closes the OpenAI session');
  }

  {
    const bruce = makeBruce();
    let connected = false;
    let sent = null;
    Object.defineProperty(bruce._realtime, 'isReady', { get: () => connected });
    bruce._realtime.connect = async () => { connected = true; };
    bruce._realtime.sendText = (text) => { sent = text; };
    await bruce.speak('hello from a reminder');
    assert.strictEqual(sent, 'hello from a reminder');
    ok('speak() reconnects a closed session and delivers');
  }

  {
    const bruce = makeBruce();
    bruce._setState('listening');
    bruce._commitAudio(); // realtime is not ready — must not wedge in listening
    assert.strictEqual(bruce.state, 'idle');
    ok('commit with dead session bails to idle');
  }

  // ── Engine: barge-in ─────────────────────────────────────────────────────

  {
    const bruce = makeBruce();
    bruce._setState('speaking');
    let cancelled = false;
    bruce._realtime.cancelResponse = () => { cancelled = true; };
    bruce._realtime.startStreaming = () => {};
    bruce._onBargeIn();
    assert.strictEqual(bruce.state, 'listening');
    assert.ok(cancelled);
    // Stale events from the cancelled response must not reopen the speaker
    // or start a follow-up window while the user is talking:
    let phantomSpeaker = false;
    bruce._audio.endPlayback = () => { phantomSpeaker = true; };
    bruce._realtime.emit('audioDone');
    assert.strictEqual(phantomSpeaker, false);
    bruce._audio.emit('speakingEnd');
    assert.strictEqual(bruce.state, 'listening');
    bruce._cancelTimers();
    bruce._setState('idle');
    ok('barge-in flips to listening; stale audio events ignored');
  }

  {
    const client = new RealtimeClient({ apiKey: 'x', registry: { getToolDefinitions: () => [] } });
    client._send = () => {};
    client._responsePhase = 'results';
    client.cancelResponse();
    assert.strictEqual(client._responsePhase, null);
    let responseDone = false;
    client.on('responseDone', () => { responseDone = true; });
    await client._handleServerEvent({ type: 'response.done' });
    assert.strictEqual(responseDone, false, 'cancelled done swallowed');
    await client._handleServerEvent({ type: 'response.done' });
    assert.strictEqual(responseDone, true, 'next legit done processed');
    let errored = false;
    client.on('error', () => { errored = true; });
    await client._handleServerEvent({ type: 'error', error: { code: 'response_cancel_not_active' } });
    assert.strictEqual(errored, false);
    ok('cancelResponse suppresses exactly one response.done; benign cancel error ignored');
  }

  // ── Functions: reminders ─────────────────────────────────────────────────

  {
    const tools = require('../src/functions/tools.js');
    const spoken = [];

    const stub1 = makeStub(spoken);
    tools.register(stub1);
    stub1.emit('ready');
    const r1 = await stub1.handlers.get('set_reminder')({ message: 'add hops', minutes: 30 });
    assert.match(r1, /Reminder 1 set: "add hops" in 30 minutes\./);
    await stub1.handlers.get('set_reminder')({ message: 'check the mash', hours: 1 });
    const file = JSON.parse(fs.readFileSync(path.join(stateDir, 'reminders.json'), 'utf-8'));
    assert.strictEqual(file.length, 2);

    // "Restart": a fresh registration restores from disk
    const stub2 = makeStub(spoken);
    tools.register(stub2);
    stub2.emit('ready');
    const listed = await stub2.handlers.get('list_reminders')();
    assert.match(listed, /You have 2 reminders:/);

    const cancelled = await stub2.handlers.get('cancel_reminder')({ message: 'hops' });
    assert.match(cancelled, /Cancelled reminder \d+: "add hops"\./);
    const after = JSON.parse(fs.readFileSync(path.join(stateDir, 'reminders.json'), 'utf-8'));
    assert.strictEqual(after.length, 1);

    // A reminder 2 minutes overdue is spoken belatedly on restore
    fs.writeFileSync(
      path.join(stateDir, 'reminders.json'),
      JSON.stringify([{ id: 9, message: 'flame out', firesAt: Date.now() - 120000 }])
    );
    const stub3 = makeStub(spoken);
    const before = spoken.length;
    tools.register(stub3);
    stub3.emit('ready');
    assert.strictEqual(spoken.length, before + 1);
    assert.match(spoken[spoken.length - 1], /flame out/);
    assert.match(spoken[spoken.length - 1], /late/);
    ok('reminders persist, restore, list, cancel, and fire belatedly');
  }

  // ── Functions: brew timer watch ──────────────────────────────────────────

  {
    const brewSystem = require('../src/functions/brewSystem.js');
    const spoken = [];
    const stub = makeStub(spoken);
    let stateResponse = {
      configured: true,
      online: true,
      state: { timer: { running: true, seconds: 1, target: 1 } },
    };
    const apiCall = async (_method, endpoint) => {
      if (endpoint === '/api/brew-system/state') return stateResponse;
      if (endpoint === '/api/brew-system/timer') return { timer: { seconds: 1 } };
      return {};
    };
    brewSystem.register(stub, apiCall);
    await stub.handlers.get('control_timer')({ action: 'start', seconds: 1 });
    stateResponse = {
      configured: true,
      online: true,
      state: { timer: { running: false, seconds: 0, target: 1 } },
    };
    await sleep(3200); // the watch checks ~1.5s after the expected end
    assert.strictEqual(spoken.length, 1);
    assert.match(spoken[0], /brew timer/);
    ok('timer watch announces countdown completion');
  }

  // ── Functions: keg summary grammar ───────────────────────────────────────

  {
    const kegs = require('../src/functions/kegs.js');
    const stub = makeStub();
    const data = [
      { number: '1', contents: 'NEIPA', volume: '19L', abv: '5.9', date: '', note: '' },
      { number: '2', contents: '???', volume: '', abv: '', date: '', note: '' },
    ];
    kegs.register(stub, async () => data);
    const out = await stub.handlers.get('get_keg_status')({});
    assert.match(out, /You have 1 keg with beer out of 2 total\./);
    assert.match(out, /1 keg of NEIPA/);
    assert.match(out, /1 keg is empty or unassigned\./);
    ok('keg summary pluralizes singular counts');
  }

  // ── RealtimeClient: GA session configuration ─────────────────────────────

  {
    const client = new RealtimeClient({
      apiKey: 'x',
      voice: 'alloy',
      registry: { getToolDefinitions: () => [{ type: 'function', name: 'f', description: 'd', parameters: {} }] },
    });
    const sends = [];
    client._send = (e) => sends.push(e);
    client._configureSession();
    const session = sends[0].session;
    assert.strictEqual(session.type, 'realtime', 'GA session shape');
    assert.deepStrictEqual(session.output_modalities, ['audio']);
    assert.strictEqual(session.audio.input.turn_detection, null, 'manual VAD retained');
    assert.strictEqual(session.audio.output.voice, 'alloy');
    assert.strictEqual(session.audio.input.transcription.model, 'gpt-4o-mini-transcribe');
    assert.strictEqual(session.tool_choice, 'auto');
    assert.strictEqual(session.temperature, undefined, 'no beta-only fields');
    // refreshTools re-sends config only when the session is live:
    client.refreshTools();
    assert.strictEqual(sends.length, 1, 'not ready — no resend');
    client._sessionReady = true;
    client.refreshTools();
    assert.strictEqual(sends.length, 2, 'ready — config resent');
    ok('GA session config + refreshTools');
  }

  // ── Engine: volume ────────────────────────────────────────────────────────

  {
    const bruce = makeBruce();
    bruce.setVolume(0.5);
    assert.strictEqual(bruce.volume, 0.5);
    bruce.setVolume(1.7);
    assert.strictEqual(bruce.volume, 1.7, 'boost above 1.0 allowed');
    bruce.setVolume(9);
    assert.strictEqual(bruce.volume, 2, 'clamped to 2.0');
    bruce.setVolume(-1);
    assert.strictEqual(bruce.volume, 0, 'clamped to 0');

    // The voice function drives the same knob in percent:
    const tools = require('../src/functions/tools.js');
    const stub = makeStub();
    stub.setVolume = (g) => bruce.setVolume(g);
    tools.register(stub);
    const reply = await stub.handlers.get('set_volume')({ percent: 60 });
    assert.match(reply, /Volume set to 60 percent\./);
    assert.strictEqual(bruce.volume, 0.6);
    ok('volume clamps, boosts, and has a voice function');
  }

  // ── Functions: keg updates ────────────────────────────────────────────────

  {
    const kegs = require('../src/functions/kegs.js');
    const stub = makeStub();
    const inventory = [
      { number: '5', contents: 'IPA', volume: '19L', abv: '6.5%', date: '01/06/2026', note: 'dry hopped' },
    ];
    const puts = [];
    const apiCall = async (method, endpoint, body) => {
      if (method === 'GET') return inventory;
      puts.push({ endpoint, body });
      return {};
    };
    kegs.register(stub, apiCall);
    const update = stub.handlers.get('update_keg');

    // Emptying clears the stale beer metadata:
    await update({ number: '5', contents: 'Dirty' });
    assert.deepStrictEqual(puts[0].body, { contents: 'Dirty', date: '', note: '', abv: '' });

    // Filling stamps today's date and keeps only what was said:
    await update({ number: '5', contents: 'NEIPA', abv: '6.2%' });
    assert.strictEqual(puts[1].body.contents, 'NEIPA');
    assert.strictEqual(puts[1].body.abv, '6.2%');
    assert.match(puts[1].body.date, /^\d{2}\/\d{2}\/\d{4}$/, 'fill date defaults to today');

    // Editing one field carries the others over unchanged:
    await update({ number: '5', note: 'gushing a bit' });
    assert.deepStrictEqual(puts[2].body, {
      contents: 'IPA',
      date: '01/06/2026',
      note: 'gushing a bit',
      abv: '6.5%',
    });

    const missing = await update({ number: '99', contents: 'Stout' });
    assert.match(missing, /no keg number 99/);
    ok('update_keg merges, clears on empty, stamps fill date');
  }

  // ── Functions: controller setpoint ───────────────────────────────────────

  {
    const stats = require('../src/functions/stats.js');
    const stub = makeStub();
    const posts = [];
    const devices = [
      {
        id: 1, name: 'Fermenter', type: 'brew_controller', online: true,
        latest: [{ metric: 'temp_c', value: 18.4 }],
      },
      { id: 2, name: 'Kegs', type: 'brew_controller', online: true, latest: [] },
      { id: 3, name: 'Fermenter', type: 'hydrometer', online: true, latest: [] },
    ];
    const apiCall = async (method, endpoint, body) => {
      if (method === 'GET') return devices;
      posts.push({ endpoint, body });
      return { pendingSetpointC: body.value };
    };
    stats.register(stub, apiCall);
    const set = stub.handlers.get('set_controller_setpoint');

    const reply = await set({ temperature: 19 });
    assert.strictEqual(posts[0].endpoint, '/api/devices/1/setpoint', 'defaults to the fermenter controller');
    assert.deepStrictEqual(posts[0].body, { value: 19 });
    assert.match(reply, /Fermenter setpoint queued to 19°C/);
    assert.match(reply, /currently 18\.4°C/);

    await set({ temperature: 3, device: 'kegs' });
    assert.strictEqual(posts[1].endpoint, '/api/devices/2/setpoint');

    const oob = await set({ temperature: 80 });
    assert.match(oob, /between minus 10 and 50/);
    assert.strictEqual(posts.length, 2, 'out-of-range never posted');
    ok('set_controller_setpoint targets the right device and validates range');
  }

  // ── Status server: real HTTP round trip ─────────────────────────────────

  {
    const { startStatusServer } = require('../src/statusServer.js');
    const spoken = [];
    const fakeBruce = {
      state: 'idle',
      connected: true,
      volume: 1,
      speak: (t) => spoken.push(t),
      setVolume(g) { this.volume = Math.max(0, Math.min(2, g)); },
    };
    const transcript = [{ type: 'assistant', content: 'hello', timestamp: 1 }];
    const server = startStatusServer({ bruce: fakeBruce, transcript, model: 'gpt-realtime-mini', port: 3556 });
    await new Promise((r) => server.on('listening', r));

    const status = await (await fetch('http://127.0.0.1:3556/status')).json();
    assert.strictEqual(status.state, 'idle');
    assert.strictEqual(status.connected, true);
    assert.strictEqual(status.model, 'gpt-realtime-mini');
    assert.strictEqual(status.volumePercent, 100);
    assert.strictEqual(status.transcript.length, 1);

    const speakRes = await fetch('http://127.0.0.1:3556/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'cheers' }),
    });
    assert.strictEqual(speakRes.status, 202);
    assert.strictEqual(spoken.length, 1);
    assert.match(spoken[0], /cheers/);
    assert.strictEqual(transcript.length, 2, 'speak request recorded in transcript');

    const volRes = await (await fetch('http://127.0.0.1:3556/volume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percent: 150 }),
    })).json();
    assert.strictEqual(volRes.volumePercent, 150);

    const bad = await fetch('http://127.0.0.1:3556/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(bad.status, 400);

    server.close();
    ok('status server serves state and forwards speak/volume');
  }

  // ── Functions: calculators ───────────────────────────────────────────────

  {
    const tools = require('../src/functions/tools.js');
    const stub = makeStub();
    tools.register(stub);
    const dilution = await stub.handlers.get('dilution_calculator')({
      volume: 20, current_gravity: 1.05, desired_gravity: 1.04,
    });
    assert.match(dilution, /add 5\.0 litres of water/);
    assert.match(dilution, /25\.0 litres/);

    const hydro = await stub.handlers.get('hydrometer_correction')({ reading: 1.05, sample_temp: 30 });
    assert.match(hydro, /corrected gravity is 1\.052/);

    const carb = await stub.handlers.get('carbonation_calculator')({ co2_volumes: 2.4, keg_temp: 4 });
    assert.match(carb, /0\.74 bar \(10\.8 PSI\)/);

    const style = await stub.handlers.get('carbonation_calculator')({ beer_style: 'hazy ipa' });
    assert.match(style, /American Ales and Lager is typically carbonated at 2\.2 – 2\.7/);
    ok('calculators produce the expected numbers');
  }

  // ── Functions: recipes and the fermenter selection ───────────────────────

  {
    const recipes = require('../src/functions/recipes.js');
    const stub = makeStub();
    const library = [
      { id: 'r1', name: 'Hazy Boi NEIPA v3', style: 'NEIPA', abv: '6.2', ibu: '45', ebc: '12', url: 'u' },
      { id: 'r2', name: 'Dark Matter Stout', style: 'Stout', abv: '7.1', ibu: '38', ebc: '80', url: '' },
    ];
    const sheet = {
      id: 'r1', name: 'Hazy Boi NEIPA v3', style: 'NEIPA', og: '1.060', fg: '1.012',
      abv: '6.2', ibu: '45', ebc: '12', batchSizeL: 55, mashTemp: '67°C', fermentationTemp: '19°C',
      fermentables: [{ amount: '10', unit: 'kg', name: 'Pilsner Malt', percent: '80' }],
      hops: [{ amount: '150', unit: 'g', name: 'Citra', use: 'Dry Hop', time: '3', timeUnit: 'days' }],
      yeast: [{ amount: '1', amountUnit: 'pack', name: 'Voss Kveik', lab: 'Lallemand', attenuation: '78' }],
      otherIngredients: [], mashGuidelines: null, waterProfile: null,
    };
    let active = { recipe: null };
    const puts = [];
    const apiCall = async (method, endpoint, body) => {
      if (method === 'GET' && endpoint === '/api/recipes') return library;
      if (method === 'GET' && endpoint.startsWith('/api/recipes/')) return sheet;
      if (method === 'GET' && endpoint === '/api/recipe') return active;
      if (method === 'GET' && endpoint === '/api/fermenter') return { state: 'dirty' };
      puts.push({ method, endpoint, body });
      if (endpoint === '/api/recipe' && method === 'PUT') active = { recipe: library[0] };
      if (endpoint === '/api/recipe' && method === 'DELETE') active = { recipe: null };
      return {};
    };
    recipes.register(stub, apiCall);

    // Shorthand finds the real recipe — nobody says "Hazy Boi NEIPA v3" out loud:
    assert.strictEqual(recipes.matchRecipe(library, 'the NEIPA').id, 'r1');
    assert.strictEqual(recipes.matchRecipe(library, 'lambic'), null);

    const empty = await stub.handlers.get('get_active_recipe')({});
    assert.match(empty, /Nothing is in the fermenter\./);
    assert.match(empty, /still needs cleaning/);

    const set = await stub.handlers.get('set_active_recipe')({ name: 'neipa' });
    assert.match(set, /Hazy Boi NEIPA v3 is now the beer in the fermenter/);
    assert.strictEqual(puts[0].body.id, 'r1');
    assert.strictEqual(puts[0].body.abv, '6.2');

    const missing = await stub.handlers.get('set_active_recipe')({ name: 'gueuze' });
    assert.match(missing, /No recipe matches "gueuze", so I have not changed anything/);
    assert.strictEqual(puts.length, 1, 'a miss never writes');

    // A summary names the beer and the shape of the sheet, not every line:
    const summary = await stub.handlers.get('get_recipe_details')({ name: 'hazy' });
    assert.match(summary, /55 litre batch/);
    assert.match(summary, /Hopped with Citra\./);
    assert.ok(!summary.includes('150 g Citra'), 'summary keeps the hop schedule back');

    const hops = await stub.handlers.get('get_recipe_details')({ name: 'hazy', section: 'hops' });
    assert.match(hops, /150 g Citra — Dry Hop at 3 days/);

    // Emptying the fermenter is not the same as washing it:
    const cleared = await stub.handlers.get('clear_active_recipe')({});
    assert.match(cleared, /no longer in it/);
    assert.strictEqual(puts[1].method, 'DELETE');
    ok('recipes match loosely, read by section, and drive the fermenter selection');
  }

  // ── Functions: the to-do list ────────────────────────────────────────────

  {
    const todos = require('../src/functions/todos.js');
    const stub = makeStub();
    let list = [
      { id: 1, text: 'Order more CO2', done: false },
      { id: 2, text: 'Order more caps', done: false },
      { id: 3, text: 'Descale the HLT', done: true },
    ];
    const calls = [];
    const apiCall = async (method, endpoint, body) => {
      if (method === 'GET') return list;
      calls.push({ method, endpoint, body });
      return { text: body && body.text };
    };
    todos.register(stub, apiCall);

    const read = await stub.handlers.get('get_todos')({});
    assert.match(read, /2 items outstanding, and 1 already done\./);
    assert.ok(!read.includes('Descale the HLT'), 'done items are counted, not read out');

    // "order more" hits both CO2 and caps — that has to be a question, not a guess:
    const ambiguous = await stub.handlers.get('complete_todo')({ text: 'order more' });
    assert.match(ambiguous, /Several to-dos match/);
    assert.strictEqual(calls.length, 0, 'an ambiguous match never writes');

    const ticked = await stub.handlers.get('complete_todo')({ text: 'CO2' });
    assert.match(ticked, /Ticked off "Order more CO2"\./);
    assert.deepStrictEqual(calls[0], { method: 'PATCH', endpoint: '/api/todos/1', body: { done: true } });

    // complete_todo only sees outstanding items, reopen_todo only completed ones:
    const alreadyDone = await stub.handlers.get('complete_todo')({ text: 'descale' });
    assert.match(alreadyDone, /Nothing on the to-do list matches "descale"/);

    const reopened = await stub.handlers.get('reopen_todo')({ text: 'descale' });
    assert.deepStrictEqual(calls[1], { method: 'PATCH', endpoint: '/api/todos/3', body: { done: false } });
    assert.match(reopened, /Put "Descale the HLT" back on the list/);

    const removed = await stub.handlers.get('delete_todo')({ text: 'caps' });
    assert.match(removed, /Removed "Order more caps"/);
    assert.strictEqual(calls[2].method, 'DELETE');

    list = list.filter((t) => !t.done);
    const nothingToClear = await stub.handlers.get('clear_completed_todos')({});
    assert.match(nothingToClear, /no completed items to clear/);
    ok('to-do list matches on text and refuses to guess between candidates');
  }

  // ── Functions: device fleet and the Inkbirds ─────────────────────────────

  {
    const devices = require('../src/functions/devices.js');
    const stub = makeStub();
    const fleet = [
      {
        id: 1, name: 'Fermenter controller', type: 'brew_controller', online: true,
        lastSeenAt: new Date(Date.now() - 90_000).toISOString(), lastIp: '192.168.0.51',
        vendorName: 'Birdy Boi', mac: 'aa:bb:cc:dd:ee:ff', reportingIntervalSec: 300, readingCount: 4210,
        pendingSetpointC: 18,
        latest: [
          { metric: 'temp_c', value: 18.94 },
          { metric: 'setpoint_c', value: 19 },
          { metric: 'hvac_state', value: -1 },
        ],
      },
      {
        id: 2, name: 'Power meter', type: 'power_meter', online: false,
        lastSeenAt: new Date(Date.now() - 7_200_000).toISOString(), lastIp: null,
        vendorName: null, mac: null, reportingIntervalSec: 30, readingCount: 12,
        latest: [],
      },
    ];
    const patches = [];
    const apiCall = async (method, endpoint, body) => {
      if (method === 'GET') return fleet;
      patches.push({ endpoint, body });
      return {};
    };
    devices.register(stub, apiCall);

    const fleetSummary = await stub.handlers.get('get_device_status')({});
    assert.match(fleetSummary, /1 of 2 devices are online\. Offline: Power meter\./);
    assert.match(fleetSummary, /last reported 2 minutes ago/);
    assert.ok(!fleetSummary.includes('192.168.0.51'), 'summary keeps the network details back');

    const full = await stub.handlers.get('get_device_status')({ detail: 'full' });
    assert.match(full, /logging every 5 minutes, at 192\.168\.0\.51/);
    assert.match(full, /known as "Birdy Boi" in its own app/);

    const inkbirds = await stub.handlers.get('get_inkbird_status')({});
    assert.match(inkbirds, /Fermenter controller — 18\.9°C, target 19\.0°C, currently cooling/);
    assert.match(inkbirds, /change to 18°C still waiting/);
    assert.ok(!inkbirds.includes('Power meter'), 'only brew controllers are Inkbirds');

    const tooFast = await stub.handlers.get('set_device_interval')({ device: 'power', seconds: 2 });
    assert.match(tooFast, /between 5 seconds and 1 hour/);
    assert.strictEqual(patches.length, 0, 'out-of-range never patched');

    const changed = await stub.handlers.get('set_device_interval')({ device: 'power', seconds: 60 });
    assert.match(changed, /Power meter will now log every 1 minute/);
    assert.deepStrictEqual(patches[0], { endpoint: '/api/devices/2', body: { reportingIntervalSec: 60 } });
    ok('device fleet reports health, Inkbirds report control state, interval validates');
  }

  // ── Functions: settings ──────────────────────────────────────────────────

  {
    const settings = require('../src/functions/settings.js');
    const stub = makeStub();
    const state = {
      '/api/notifications/settings': { kegAlertEnabled: true, kegAlertDays: 30, fermentDoneEnabled: true },
      '/api/graph-colors': {
        pressure: '#22d3ee', gravity: '#a78bfa', power: '#eab308', water: '#3b82f6',
        beerTemp: '#fb923c', fridgeTemp: '#d97706', setpoint: '#f59e0b',
      },
      '/api/device-sources': {
        fermenter_pressure: 'real', fermenter_controller: 'real', kegs_controller: 'real',
        brewery_temp: 'real', power: 'mock', water: 'mock', fermenter_gravity: 'mock',
      },
    };
    const writes = [];
    const apiCall = async (method, endpoint, body) => {
      if (method === 'GET') return state[endpoint];
      writes.push({ endpoint, body });
      return body;
    };
    settings.register(stub, apiCall);

    const alerts = await stub.handlers.get('get_settings')({ section: 'notifications' });
    assert.match(alerts, /keg age alert is on, at 30 days/);

    // One field changes; the rest are carried over rather than reset:
    await stub.handlers.get('set_notification_settings')({ keg_alert_days: 21 });
    assert.deepStrictEqual(writes[0].body, {
      kegAlertEnabled: true, kegAlertDays: 21, fermentDoneEnabled: true,
    });

    const outOfRange = await stub.handlers.get('set_notification_settings')({ keg_alert_days: 900 });
    assert.match(outOfRange, /between 1 and 365 days/);
    assert.strictEqual(writes.length, 1, 'out-of-range never wrote');

    // Colours arrive by name, and only the named line moves:
    assert.strictEqual(settings.resolveColor('amber'), '#f59e0b');
    assert.strictEqual(settings.resolveColor('#AABBCC'), '#aabbcc');
    assert.strictEqual(settings.resolveColor('puce'), null);
    const recolour = await stub.handlers.get('set_graph_color')({ line: 'electricity', color: 'red' });
    assert.match(recolour, /The power line is now #ef4444/);
    assert.strictEqual(writes[1].body.power, '#ef4444');
    assert.strictEqual(writes[1].body.water, '#3b82f6', 'other lines are carried over');

    // Switching a sensor to mock has to say what that means out loud:
    const mocked = await stub.handlers.get('set_device_source')({ sensor: 'fermenter fridge', source: 'mock' });
    assert.match(mocked, /mock demo data/);
    assert.match(mocked, /invented numbers/);
    assert.strictEqual(writes[2].body.fermenter_controller, 'mock');
    assert.strictEqual(writes[2].body.kegs_controller, 'real', 'other sensors are carried over');

    const noop = await stub.handlers.get('set_device_source')({ sensor: 'power meter', source: 'mock' });
    assert.match(noop, /already set to mock demo data/);
    assert.strictEqual(writes.length, 3, 'a no-op change never wrote');
    ok('settings merge unchanged fields, take named colours, and explain mock data');
  }

  fs.rmSync(stateDir, { recursive: true, force: true });
  console.log(`\n${passed} test groups passed.`);
  process.exit(0);
})().catch((err) => {
  console.error('\nTEST FAILURE:', err);
  process.exit(1);
});
