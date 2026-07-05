'use strict';

/**
 * Bruce Assistant — Tunable Parameters
 *
 * Every value here can be overridden with an environment variable of the same
 * name prefixed with BRUCE_ (e.g. BRUCE_SILENCE_ENERGY_THRESHOLD=350 in
 * /etc/brewplanner.env), so per-room tuning on the Pi survives deploys without
 * editing this tracked file. The values below are the defaults.
 */

/** Numeric tunable with a BRUCE_<name> env override. */
function num(name, fallback) {
  const v = Number(process.env[`BRUCE_${name}`]);
  return Number.isFinite(v) ? v : fallback;
}

/** Boolean tunable with a BRUCE_<name> env override ("1"/"true" = on). */
function bool(name, fallback) {
  const v = process.env[`BRUCE_${name}`];
  if (v == null || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

module.exports = {

  // ── OpenAI models ────────────────────────────────────────────────────────

  // Realtime (speech) model — gpt-realtime-mini (default) or gpt-realtime for
  // the bigger/pricier one. Must be a GA realtime model: OpenAI retired the
  // old beta API and the *-realtime-preview models Bruce originally used.
  REALTIME_MODEL: process.env.BRUCE_REALTIME_MODEL || 'gpt-realtime-mini',

  // Input transcription model (default gpt-4o-mini-transcribe).
  TRANSCRIPTION_MODEL: process.env.BRUCE_TRANSCRIPTION_MODEL || '',


  // ── Voice Activity Detection ─────────────────────────────────────────────

  // RMS energy below this level is treated as silence (scale: 0–32768)
  // Increase if background noise causes false "speech detected" triggers
  SILENCE_ENERGY_THRESHOLD: num('SILENCE_ENERGY_THRESHOLD', 200),

  // Minimum peak RMS energy required to send audio to the model (scale: 0–32768)
  // Prevents quiet noise / silence from being transcribed as garbage text
  // Should be higher than SILENCE_ENERGY_THRESHOLD
  MIN_SPEECH_ENERGY: num('MIN_SPEECH_ENERGY', 400),

  // How long (ms) of continuous silence before committing audio to OpenAI
  // Shorter = Bruce responds faster; longer = more natural pauses allowed
  SILENCE_THRESHOLD_MS: num('SILENCE_THRESHOLD_MS', 1500),

  // Maximum time (ms) Bruce will listen before force-committing audio
  // Safety valve to prevent endless listening if silence detection fails
  MAX_UTTERANCE_MS: num('MAX_UTTERANCE_MS', 10000),


  // ── Conversation Flow ────────────────────────────────────────────────────

  // How long (ms) to wait for a follow-up question after Bruce finishes speaking
  // If no voice is detected in this window, Bruce goes back to idle
  FOLLOW_UP_TIMEOUT_MS: num('FOLLOW_UP_TIMEOUT_MS', 5000),


  // ── Session lifecycle & watchdog ─────────────────────────────────────────

  // The OpenAI session is opened on demand (wake word / reminder) and closed
  // after this much idle time. Within the window Bruce keeps conversation
  // context ("what did I just ask?"); after it, the next wake word starts a
  // fresh session — which also caps how much history is re-billed per turn.
  // 0 keeps the session open forever (not recommended: it eventually dies
  // server-side anyway).
  SESSION_IDLE_TIMEOUT_MS: num('SESSION_IDLE_TIMEOUT_MS', 120000),

  // Watchdog: how long Bruce may sit in "thinking" before assuming the OpenAI
  // session is wedged (dropped WS, lost event) and force-resetting to idle.
  THINKING_TIMEOUT_MS: num('THINKING_TIMEOUT_MS', 30000),

  // Watchdog: upper bound for one spoken reply. Longer than the longest
  // realistic answer (full keg rundown), shorter than "stuck forever".
  SPEAKING_TIMEOUT_MS: num('SPEAKING_TIMEOUT_MS', 180000),

  // Watchdog: grace period past MAX_UTTERANCE_MS for the listening state
  // (covers a dead session silently eating the audio commit).
  LISTENING_GRACE_MS: num('LISTENING_GRACE_MS', 20000),


  // ── Barge-in (interrupt Bruce mid-speech) ────────────────────────────────

  // Off by default: the echo gate must be tuned to the room/speaker before it
  // is trustworthy — a miscalibrated gate makes Bruce interrupt himself.
  // Enable with BRUCE_BARGE_IN_ENABLED=1 once tuned (see deploy/README-bruce.md).
  BARGE_IN_ENABLED: bool('BARGE_IN_ENABLED', false),

  // Minimum mic RMS *above the expected speaker echo* to count as user speech.
  // Lower = easier to interrupt; higher = more resistant to false triggers.
  BARGE_IN_ENERGY_THRESHOLD: num('BARGE_IN_ENERGY_THRESHOLD', 400),


  // ── Debug ────────────────────────────────────────────────────────────────

  // Print microphone energy levels to the console
  // Useful for tuning SILENCE_ENERGY_THRESHOLD and BARGE_IN_ENERGY_THRESHOLD
  // 'off'      — no energy logging
  // 'listening' — log energy while Bruce is listening for your speech
  DEBUG_ENERGY: process.env.BRUCE_DEBUG_ENERGY || 'off',

};
