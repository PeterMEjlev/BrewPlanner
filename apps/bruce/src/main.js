'use strict';

/**
 * Bruce voice assistant — BrewPlanner entry point.
 *
 * Runs as its own Node process (deploy/bruce.service on the Pi; `npm run dev
 * --workspace @checklist/bruce` on a dev machine). Talks to the BrewPlanner
 * server over loopback (see src/api.js) for brew-rig control, kegs, and
 * sensor data; audio (mic + speaker) is local to this machine.
 *
 * Requires OPENAI_API_KEY and PICOVOICE_ACCESS_KEY in the environment
 * (systemd loads /etc/brewplanner.env; local dev can use apps/bruce/.env).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const BruceAssistant = require('./engine');
const cfg = require('../config');

const { apiCall } = require('./api');
const { startStatusServer } = require('./statusServer');
const brewSystemFunctions = require('./functions/brewSystem');
const kegFunctions = require('./functions/kegs');
const statsFunctions = require('./functions/stats');
const deviceFunctions = require('./functions/devices');
const recipeFunctions = require('./functions/recipes');
const todoFunctions = require('./functions/todos');
const settingsFunctions = require('./functions/settings');
const toolFunctions = require('./functions/tools');

// Rolling transcript of recent turns, served by the status API for the
// dashboard's Bruce page. Entries: { type: 'user'|'assistant'|'function_call'|'system', content, timestamp }.
const TRANSCRIPT_MAX = 100;
const transcript = [];
function record(type, content) {
  transcript.push({ type, content, timestamp: Date.now() });
  if (transcript.length > TRANSCRIPT_MAX) transcript.splice(0, transcript.length - TRANSCRIPT_MAX);
}

// Porcupine wake-word models are platform-specific; pick the right one for
// where we're running (RPi in production, Windows for development).
function defaultWakeWordPath() {
  const file = process.platform === 'win32' ? 'Bruce_en_windows_v3_0_0.ppn' : 'Bruce_en_RPi_v3_0_0.ppn';
  return path.join(__dirname, '..', 'wake-words', file);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[Bruce] Missing required environment variable ${name} — see deploy/README-bruce.md`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const bruce = new BruceAssistant({
    picovoiceKey: requireEnv('PICOVOICE_ACCESS_KEY'),
    openaiKey: requireEnv('OPENAI_API_KEY'),
    wakeWordPath: process.env.BRUCE_WAKE_WORD_PATH || defaultWakeWordPath(),
    voice: process.env.BRUCE_VOICE || 'alloy',
    // ALSA capture device, e.g. 'plughw:1' — find yours with `arecord -l`.
    micDevice: process.env.BRUCE_MIC_DEVICE || undefined,
    systemPrompt:
      process.env.BRUCE_SYSTEM_PROMPT ||
      fs.readFileSync(path.join(__dirname, '..', 'system-prompt.txt'), 'utf-8').trim(),
  });

  // Default speech volume: 100 = native, up to 200 (digital boost, clips).
  const volumePct = Number(process.env.BRUCE_VOLUME_PERCENT);
  if (Number.isFinite(volumePct)) bruce.setVolume(volumePct / 100);

  brewSystemFunctions.register(bruce, apiCall);
  kegFunctions.register(bruce, apiCall);
  statsFunctions.register(bruce, apiCall);
  deviceFunctions.register(bruce, apiCall);
  recipeFunctions.register(bruce, apiCall);
  todoFunctions.register(bruce, apiCall);
  settingsFunctions.register(bruce, apiCall);
  toolFunctions.register(bruce);

  // ── Logging ─────────────────────────────────────────────────────────────
  //
  // Plain console logs; systemd forwards them to journald
  // (journalctl -u bruce.service -f). The Realtime API can deliver the final
  // user transcript AFTER Bruce has already started responding, so replies and
  // function calls are queued until the "[You]" line has printed — that keeps
  // each turn readable in the journal.

  let pendingTranscript = null;
  let waitingForTranscript = false;
  let transcriptFlushed = false; // true once [You] has been printed for this turn
  let outputQueue = [];

  const flushTranscript = () => {
    if (pendingTranscript) {
      console.log(`[You] ${pendingTranscript}`);
      record('user', pendingTranscript);
      pendingTranscript = null;
      transcriptFlushed = true;
    }
  };

  const drainQueue = () => {
    waitingForTranscript = false;
    const queued = outputQueue;
    outputQueue = [];
    for (const fn of queued) fn();
  };

  const bruceOutput = (fn) => {
    if (waitingForTranscript) {
      outputQueue.push(fn);
    } else {
      fn();
    }
  };

  bruce.on('ready', () => console.log('[Bruce] Ready — listening for wake word'));
  bruce.on('wake', () => console.log('[Bruce] Wake word detected'));

  bruce.on('listening', () => {
    // Drain any remaining output from the previous turn before resetting
    flushTranscript();
    drainQueue();
    pendingTranscript = null;
    transcriptFlushed = false;
    console.log('[Bruce] Listening...');
  });

  bruce.on('thinking', () => {
    if (!pendingTranscript && !waitingForTranscript && !transcriptFlushed) {
      // First thinking of this turn, transcript hasn't arrived — buffer
      waitingForTranscript = true;
    } else {
      flushTranscript();
    }
    console.log('[Bruce] Thinking...');
  });

  bruce.on('speaking', () => {
    bruceOutput(() => console.log('[Bruce] Speaking...'));
  });

  bruce.on('idle', () => {
    // End of turn — flush anything still pending
    flushTranscript();
    drainQueue();
    console.log('[Bruce] Idle');
  });

  bruce.on('transcript', (text) => {
    pendingTranscript = text;
    if (waitingForTranscript) {
      flushTranscript();
      drainQueue();
    }
  });

  bruce.on('functionCall', (name, args) => {
    bruceOutput(() => {
      console.log(`[Bruce] Function call: ${name}`, args);
      const argStr = args && Object.keys(args).length ? ` ${JSON.stringify(args)}` : '';
      record('function_call', `${name}${argStr}`);
    });
  });

  bruce.on('reply', (text) => {
    bruceOutput(() => {
      console.log(`[Bruce] ${text}`);
      record('assistant', text);
    });
  });

  bruce.on('error', (err) => console.error('[Bruce] Error:', err));

  // Loopback status API for the dashboard's Bruce page (proxied by the
  // BrewPlanner server as /api/bruce/* behind its auth).
  startStatusServer({
    bruce,
    transcript,
    model: cfg.REALTIME_MODEL,
    port: Number(process.env.BRUCE_STATUS_PORT) || 3555,
  });

  // Graceful shutdown so systemd stop/restart releases the mic and speaker.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log(`[Bruce] ${signal} — shutting down`);
      Promise.resolve(bruce.stop()).finally(() => process.exit(0));
    });
  }

  await bruce.start();
}

main().catch((err) => {
  console.error('[Bruce] Fatal error:', err);
  process.exit(1);
});
