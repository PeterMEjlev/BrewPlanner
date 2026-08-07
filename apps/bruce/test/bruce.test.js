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
    openaiKey: 'fake',
    // Never loaded: these tests drive the state machine directly and never
    // call start(), which is what opens the ONNX sessions.
    wakeWordPath: path.join(__dirname, '..', 'wake-words', 'hey_bruce.onnx'),
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

  // ── Engine: wake acknowledgement ─────────────────────────────────────────

  {
    const bruce = makeBruce();
    assert.strictEqual(bruce.wakeAck, 'speak', 'defaults to speaking');
    assert.throws(() => bruce.setWakeAck('trumpet'), /Unknown wake acknowledgement/);
    assert.strictEqual(bruce.wakeAck, 'speak', 'a rejected mode changes nothing');

    const played = [];
    bruce._audio.playSound = (name) => { played.push(name); return Promise.resolve(); };
    bruce._ensureConnected = () => Promise.resolve();
    bruce._realtime.startStreaming = () => {};

    // 'none' must go straight to listening without playing anything.
    bruce.setWakeAck('none');
    await bruce._onWakeWordDetected();
    assert.deepStrictEqual(played, [], 'silent mode played nothing');
    assert.strictEqual(bruce.state, 'listening');

    // The mode doubles as the cached sound's key.
    bruce._setState('idle');
    bruce.setWakeAck('plop');
    await bruce._onWakeWordDetected();
    assert.deepStrictEqual(played, ['plop']);

    bruce._cancelTimers();
    bruce._setState('idle');
    ok('wake acknowledgement validates; "none" plays nothing');
  }

  // ── Status server: real HTTP round trip ─────────────────────────────────

  {
    const { startStatusServer } = require('../src/statusServer.js');
    const spoken = [];
    const fakeBruce = {
      state: 'idle',
      connected: true,
      volume: 1,
      wakeAck: 'speak',
      speak: (t) => spoken.push(t),
      setVolume(g) { this.volume = Math.max(0, Math.min(2, g)); },
      setWakeAck(m) { this.wakeAck = m; },
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

    assert.strictEqual(status.wakeAck, 'speak', 'status reports the wake acknowledgement');
    const ackRes = await (await fetch('http://127.0.0.1:3556/wake-ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'none' }),
    })).json();
    assert.strictEqual(ackRes.wakeAck, 'none');
    assert.strictEqual(fakeBruce.wakeAck, 'none');

    // An unknown mode is rejected rather than leaving Bruce with a sound key
    // that resolves to nothing (which would be a silent, confusing wake).
    const badAck = await fetch('http://127.0.0.1:3556/wake-ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'trumpet' }),
    });
    assert.strictEqual(badAck.status, 400);
    assert.strictEqual(fakeBruce.wakeAck, 'none', 'rejected mode left the setting alone');

    const bad = await fetch('http://127.0.0.1:3556/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(bad.status, 400);

    server.close();
    ok('status server serves state and forwards speak/volume/wake-ack');
  }


  // ── Functions: the hub tool proxy ────────────────────────────────────────
  //
  // Bruce's BrewPlanner tools are no longer written here: the definitions come
  // from the server and each one is registered as a proxy back to it (see
  // src/functions/hub.js). What is worth pinning is that the proxying is
  // faithful — the model sees what the hub advertises, the call reaches the hub
  // unchanged, and the answer comes back as the model reads it.

  {
    const hub = require('../src/functions/hub.js');
    const stub = makeStub();
    const calls = [];
    const apiCall = async (method, endpoint, body) => {
      calls.push({ method, endpoint, body });
      if (method === 'GET') {
        return {
          tools: [
            {
              type: 'function',
              name: 'get_kegs',
              description: 'Read the keg board.',
              parameters: { type: 'object', properties: {}, required: [] },
            },
            {
              type: 'function',
              name: 'manage_todo',
              description: 'Change the to-do list.',
              parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
            },
            // Read-only on the server; this process has the full rig set, so it
            // must not register a second, weaker tool for the same question.
            { type: 'function', name: 'get_rig_status', description: 'Read the rig.', parameters: {} },
          ],
        };
      }
      return { output: 'Two kegs hold beer.' };
    };

    const registered = await hub.registerOnce(stub, apiCall);
    assert.strictEqual(registered, 2, 'get_rig_status is left to brewSystem.js');
    assert.ok(stub.handlers.has('get_kegs'));
    assert.ok(stub.handlers.has('manage_todo'));
    assert.ok(!stub.handlers.has('get_rig_status'));
    assert.strictEqual(calls[0].endpoint, '/api/bruce/voice/tools');

    const answer = await stub.handlers.get('manage_todo')({ action: 'add', text: 'Order caps' });
    assert.strictEqual(answer, 'Two kegs hold beer.');
    const posted = calls[calls.length - 1];
    assert.strictEqual(posted.method, 'POST');
    assert.strictEqual(posted.endpoint, '/api/bruce/voice/tool');
    assert.strictEqual(posted.body.name, 'manage_todo');
    assert.deepStrictEqual(posted.body.args, { action: 'add', text: 'Order caps' });
    ok('hub tools are fetched, proxied, and the rig is left local');
  }

  // A server that is still booting must not take Bruce down with it — the wake
  // word has to work on a Pi where both services started a second ago.
  {
    const hub = require('../src/functions/hub.js');
    const stub = makeStub();
    let threw = false;
    try {
      await hub.registerOnce(stub, async () => {
        throw new Error('The BrewPlanner server is not responding.');
      });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, true, 'the caller decides whether to retry');
    assert.strictEqual(stub.handlers.size, 0, 'nothing half-registered');

    // register() swallows it instead, so main.js keeps starting.
    hub.register(stub, async () => {
      throw new Error('The BrewPlanner server is not responding.');
    });
    await sleep(20);
    assert.strictEqual(stub.handlers.size, 0);
    ok('a hub that is not up yet does not stop Bruce starting');
  }

  fs.rmSync(stateDir, { recursive: true, force: true });
  console.log(`\n${passed} test groups passed.`);
  process.exit(0);
})().catch((err) => {
  console.error('\nTEST FAILURE:', err);
  process.exit(1);
});
