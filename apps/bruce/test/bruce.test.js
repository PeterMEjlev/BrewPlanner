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

  // ── RealtimeClient: a turn that called nothing reports nothing ───────────
  //
  // Every spoken turn runs announce → execute → results. The results phase
  // hands the model the function output and orders it to read all of it out
  // loud, which is right when functions ran and catastrophic when none did:
  // told to speak data that does not exist, the model makes some up. In the
  // brewery that surfaced as a second, unprompted reply after a plain "hey
  // Bruce" — "Understood. The current temperature readings are: the BK is at
  // 98 degrees Celsius…" — invented, with no sensor ever read.

  {
    const client = new RealtimeClient({ apiKey: 'x', registry: { getToolDefinitions: () => [] } });
    client._sessionReady = true;
    let sends = [];
    client._send = (e) => sends.push(e);

    /** One turn: commit, then N response.done events with no function calls. */
    const turn = async (dones) => {
      sends = [];
      const finished = [];
      client.on('responseDone', () => finished.push(true));
      client.commitAndRespond();
      for (let i = 0; i < dones; i++) await client._handleServerEvent({ type: 'response.done' });
      client.removeAllListeners('responseDone');
      return { sends, finished };
    };

    // Announce, then the execute phase finds nothing to call — and that is the
    // whole turn. Nothing further is asked of the model.
    const conversational = await turn(2);
    assert.strictEqual(conversational.finished.length, 1, 'the turn ends');
    assert.strictEqual(client.responsePhase, null, 'and leaves no phase behind');
    const injected = conversational.sends.filter(
      (e) => e.type === 'conversation.item.create' &&
        String(e.item?.content?.[0]?.text).includes('you MUST speak ALL of this data'),
    );
    assert.strictEqual(injected.length, 0, 'the model is never told to read absent data aloud');

    // A turn that *did* call something still reports it — the phase exists for
    // a reason, and this is that reason.
    sends = [];
    client._registry.execute = async () => 'HLT is 72 °C';
    client.commitAndRespond();
    await client._handleServerEvent({ type: 'response.done' });      // announce
    client._completedCalls.push({ call_id: 'c1', fnName: 'get_temps', args: {} });
    await client._handleServerEvent({ type: 'response.done' });      // execute, with a call
    await client._handleServerEvent({ type: 'response.done' });      // execute, nothing more
    const spoken = sends.find(
      (e) => e.type === 'conversation.item.create' &&
        String(e.item?.content?.[0]?.text).includes('you MUST speak ALL of this data'),
    );
    assert.ok(spoken, 'results are handed to the model');
    assert.match(spoken.item.content[0].text, /HLT is 72 °C/, 'and they are the real ones');
    ok('a turn with no function calls ends instead of inventing results to read');
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

  // ── Engine: wake-word sensitivity ────────────────────────────────────────

  {
    const bruce = makeBruce();
    assert.strictEqual(bruce.wakeWordGain, 'auto', 'defaults to the gain control');
    assert.ok(bruce.wakeWordGainApplied > 1, 'auto starts amplifying, not at the raw mic');

    bruce.setWakeWordGain(3);
    assert.strictEqual(bruce.wakeWordGain, 3);
    assert.strictEqual(bruce.wakeWordGainApplied, 3, 'a pinned gain is applied as given');
    // A zero or negative gain would mute the detector rather than make it less
    // sensitive, so it is refused instead of silently deafening Bruce.
    for (const bad of [0, -1, Number.NaN]) {
      assert.throws(() => bruce.setWakeWordGain(bad), /positive number/);
    }
    assert.strictEqual(bruce.wakeWordGain, 3, 'a rejected gain changes nothing');

    bruce.setWakeWordGain('auto');
    assert.strictEqual(bruce.wakeWordGain, 'auto', 'and back to automatic');
    ok('wake-word gain is settable live and refuses to mute the detector');
  }

  // ── Wake word: the high-pass filter ──────────────────────────────────────
  //
  // The filter in front of the scorer. Its whole job is to stop the brewery's
  // low-frequency machinery from filling the mel bins the phrase lives in, so
  // what matters is that it kills DC and rumble while leaving speech alone.

  {
    const HighPassFilter = require('../src/engine/HighPassFilter.js');

    /** Steady-state amplitude of a sine at `hz` after the filter. */
    const responseAt = (hz, cutoff = 120) => {
      const filter = new HighPassFilter(cutoff, 16000);
      let peak = 0;
      // Half a second in: long past the transient, so this is the real gain.
      for (let i = 0; i < 8000; i++) {
        const y = filter.process(1000 * Math.sin((2 * Math.PI * hz * i) / 16000));
        if (i > 4000) peak = Math.max(peak, Math.abs(y));
      }
      return peak / 1000;
    };

    assert.ok(responseAt(1000) > 0.98, 'speech passes untouched');
    assert.ok(responseAt(300) > 0.9, 'the bottom of the speech range survives');
    assert.ok(responseAt(50) < 0.2, 'a 50 Hz hum is largely gone');

    // A constant offset — which some USB capsules carry — is pure DC and must
    // decay to nothing, otherwise it eats headroom before the gain stage.
    const dc = new HighPassFilter(120, 16000);
    let last = 0;
    for (let i = 0; i < 8000; i++) last = dc.process(5000);
    assert.ok(Math.abs(last) < 1, `DC is removed (left ${last})`);

    // 0 Hz means "off", and off has to be exactly a pass-through: it is the
    // escape hatch if the filter ever turns out to hurt a wake model.
    const off = new HighPassFilter(0, 16000);
    assert.strictEqual(off.enabled, false);
    assert.strictEqual(off.process(1234), 1234);
    ok('high-pass filter removes DC and rumble, passes speech, and disables cleanly');
  }

  // ── Wake word: the gain control ──────────────────────────────────────────
  //
  // The reason one sensitivity setting can cover both "next to the mic" and
  // "across the brewery". These drive it in 80ms frames, as the detector does.

  {
    const GainControl = require('../src/engine/GainControl.js');

    /** Run `seconds` of frames at a fixed level, returning the final gain. */
    const run = (control, { rms, peak }, seconds) => {
      let gain = control.gain;
      for (let i = 0; i < Math.round(seconds / 0.08); i++) gain = control.update(rms, peak);
      return gain;
    };

    // A quiet room: nothing to turn down, so the gain sits at the ceiling and
    // a phrase from the far corner arrives amplified as far as it can be.
    const quiet = new GainControl();
    assert.ok(run(quiet, { rms: 20, peak: 60 }, 30) > 15, 'a quiet room gets full gain');

    // Someone talking right at the mic: held down so the phrase is presented
    // near the target rather than clipped into distortion.
    const close = new GainControl();
    const closeGain = run(close, { rms: 3000, peak: 12000 }, 30);
    assert.ok(closeGain < 1.5, `close speech is turned down (got ×${closeGain.toFixed(2)})`);
    assert.ok(closeGain * 12000 < 32767, 'and stays inside the int16 range');

    // ...and full gain comes back once they stop, which is what makes the next
    // phrase from across the room audible. Ten seconds is a few half-lives.
    assert.ok(run(close, { rms: 20, peak: 60 }, 10) > 10, 'gain recovers after they stop');

    // The move is slow on purpose: across one 0.8s wake phrase the gain must
    // barely shift, or it flattens the loudness contour the model reads.
    const during = new GainControl();
    run(during, { rms: 20, peak: 60 }, 30);
    const before = during.gain;
    run(during, { rms: 3000, peak: 12000 }, 0.8);
    assert.ok(during.gain / before > 0.75, 'a phrase is scored at essentially one gain');

    // A genuinely noisy room caps the gain: amplification lifts the room as
    // much as the phrase, so past this point it only feeds the model noise.
    const noisy = new GainControl({ maxNoise: 600 });
    const noisyGain = run(noisy, { rms: 300, peak: 900 }, 600);
    assert.ok(noisyGain <= 2.1, `noise caps the gain (got ×${noisyGain.toFixed(2)})`);
    assert.ok(noisy.noiseFloor > 200, 'and the room level is tracked for the meter');

    // ...but somebody standing there saying "hey Bruce" over and over must not
    // *become* the noise floor. This is what shipped broken: in the brewery a
    // fifteen-second run of attempts walked the floor from its true 117 to 325,
    // the cap read the room as four times louder than it was, and the gain was
    // throttled to ×1.8 — worse than the fixed gain it replaced — precisely
    // while someone was trying to be heard from across the room.
    const talking = new GainControl();
    run(talking, { rms: 117, peak: 350 }, 30);       // the room, settling
    const quietFloor = talking.noiseFloor;
    assert.ok(Math.abs(quietFloor - 117) < 2, `the floor finds the room (${quietFloor.toFixed(0)})`);
    for (let attempt = 0; attempt < 6; attempt++) {  // six goes at the phrase
      run(talking, { rms: 900, peak: 2600 }, 1);
      run(talking, { rms: 117, peak: 350 }, 1.5);
    }
    assert.ok(
      talking.noiseFloor < quietFloor * 1.25,
      `speech does not become the floor (${quietFloor.toFixed(0)} → ${talking.noiseFloor.toFixed(0)})`,
    );
    // What that buys, stated as the thing that actually matters: the phrase is
    // still handed to the models at the level they want it. The shipped cap
    // was leaving it at ×1.8 — about 4700, well under target — by the sixth go.
    const presented = talking.gain * 2600;
    assert.ok(
      presented >= 8000,
      `the phrase still reaches the models at full level (×${talking.gain.toFixed(1)} → ${Math.round(presented)})`,
    );

    // The floor is seeded from the first frame instead of crawling up from
    // zero, or it — and the mic meter reading it — would be wrong for minutes
    // after every restart.
    const fresh = new GainControl();
    fresh.update(140, 400);
    assert.strictEqual(fresh.noiseFloor, 140, 'the floor starts where the room is');

    // The gain moves over seconds, so the first loud words after a quiet spell
    // arrive while it is still up where the quiet room left it. That frame has
    // to come back limited, not clipped: clipping is a square wave, and a
    // square wave scores worse than the quiet audio it was made from.
    const onset = new GainControl();
    run(onset, { rms: 20, peak: 60 }, 30);
    const firstLoud = onset.update(3000, 12000);
    assert.ok(firstLoud * 12000 <= 32767, `the first loud frame is not clipped (×${firstLoud.toFixed(2)})`);
    assert.ok(firstLoud * 12000 > 20000, 'but is still presented loudly, not squashed');
    assert.ok(onset.gain > firstLoud, 'the ceiling is per-frame; the operating point is unmoved');

    // A digitally silent mic must not ask for infinite gain.
    const silent = new GainControl();
    assert.ok(Number.isFinite(run(silent, { rms: 0, peak: 0 }, 10)), 'silence stays finite');

    // Pinned means pinned — the control still tracks the room for the meter,
    // but never touches the gain.
    const pinned = new GainControl({ gain: 4 });
    assert.strictEqual(run(pinned, { rms: 20, peak: 60 }, 30), 4, 'a pinned gain never moves');
    assert.ok(pinned.noiseFloor > 0, 'though the room is still tracked');
    ok('gain control lifts a quiet room, ducks close speech, and respects the noise cap');
  }

  // ── The mic meter ────────────────────────────────────────────────────────

  {
    const MicLevelMeter = require('../src/engine/MicLevelMeter.js');

    /** `samples` PCM16 samples at a constant magnitude. */
    const tone = (samples, magnitude) => {
      const buf = Buffer.alloc(samples * 2);
      for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? magnitude : -magnitude, i * 2);
      return buf;
    };

    const meter = new MicLevelMeter();
    // Chunks that don't divide evenly into the 100ms bucket: the recorder
    // hands over whatever size it likes, and the trace must come out even
    // anyway — buckets close on sample count, not on wall clock.
    for (let i = 0; i < 10; i++) meter.push(tone(700, 1000));
    const { samples, bucketMs } = meter.snapshot();
    assert.strictEqual(bucketMs, 100);
    assert.strictEqual(samples.length, 4, '7000 samples is four full 1600-sample buckets');
    for (const bucket of samples) {
      assert.strictEqual(bucket.rms, 1000, 'a constant tone reads as its own amplitude');
      assert.strictEqual(bucket.peak, 1000);
      assert.strictEqual(bucket.score, null, 'no wake score offered, none reported');
    }

    // Scores ride along with the audio, and a bucket keeps the highest it saw.
    meter.noteScore(0.02);
    meter.noteScore(0.61);
    meter.push(tone(1600, 500));
    const scored = meter.snapshot().samples.at(-1);
    assert.strictEqual(scored.score, 0.61, 'the bucket keeps its best score');

    // The window is bounded — this is a live trace, not a log.
    for (let i = 0; i < 200; i++) meter.push(tone(1600, 100));
    const full = meter.snapshot();
    assert.strictEqual(full.samples.length, full.windowMs / full.bucketMs);

    // Whatever the detector says about itself rides along, so the page can
    // draw the noise floor and threshold lines against the same trace.
    const described = meter.snapshot({ noiseFloor: 42, gain: 6.5, gainMode: 'auto', threshold: 0.5 });
    assert.strictEqual(described.noiseFloor, 42);
    assert.strictEqual(described.gainMode, 'auto');
    assert.strictEqual(described.threshold, 0.5);
    assert.strictEqual(meter.snapshot().threshold, null, 'and is null when not offered');
    ok('mic meter buckets audio evenly, keeps peak scores, and bounds its window');
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
      wakeWordGain: 1,
      wakeWordGainApplied: 1,
      micLevels: { now: 1, bucketMs: 100, windowMs: 6000, samples: [{ rms: 12, peak: 40, score: 0.01 }] },
      speak: (t) => spoken.push(t),
      setVolume(g) { this.volume = Math.max(0, Math.min(2, g)); },
      setWakeAck(m) { this.wakeAck = m; },
      setWakeWordGain(g) {
        this.wakeWordGain = g;
        this.wakeWordGainApplied = g === 'auto' ? 16 : g;
      },
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

    assert.strictEqual(status.wakeWordGain, 1, 'status reports the wake-word gain');
    const gainRes = await (await fetch('http://127.0.0.1:3556/wake-word-gain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gain: 2.5 }),
    })).json();
    assert.strictEqual(gainRes.wakeWordGain, 2.5);

    // Zero would silence the detector outright rather than desensitise it.
    const badGain = await fetch('http://127.0.0.1:3556/wake-word-gain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gain: 0 }),
    });
    assert.strictEqual(badGain.status, 400);
    assert.strictEqual(fakeBruce.wakeWordGain, 2.5, 'rejected gain left the setting alone');

    // "auto" is a setting, not a number — it has to survive Number() coercion
    // (which would make it NaN and fail the positive-number check).
    const autoRes = await (await fetch('http://127.0.0.1:3556/wake-word-gain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gain: 'auto' }),
    })).json();
    assert.strictEqual(autoRes.wakeWordGain, 'auto');
    assert.strictEqual(autoRes.wakeWordGainApplied, 16, 'and reports where it landed');

    const levels = await (await fetch('http://127.0.0.1:3556/levels')).json();
    assert.strictEqual(levels.bucketMs, 100);
    assert.strictEqual(levels.samples.length, 1, 'the mic trace is served as-is');

    const bad = await fetch('http://127.0.0.1:3556/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(bad.status, 400);

    server.close();
    ok('status server serves state, levels, and forwards speak/volume/wake-ack');
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
