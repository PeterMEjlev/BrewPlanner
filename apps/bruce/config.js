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

/**
 * One-of tunable with a BRUCE_<name> env override. An unrecognised value falls
 * back and says so — a typo in /etc/brewplanner.env should be visible in the
 * journal, not silently change behaviour.
 */
function oneOf(name, allowed, fallback) {
  const v = process.env[`BRUCE_${name}`];
  if (v == null || v === '') return fallback;
  const value = v.trim().toLowerCase();
  if (allowed.includes(value)) return value;
  console.warn(`[Bruce] Ignoring BRUCE_${name}="${v}" — expected one of: ${allowed.join(', ')}`);
  return fallback;
}

/** Accepted values for WAKE_ACK, shared with the engine and the status API. */
const WAKE_ACK_MODES = ['speak', 'plop', 'none'];

module.exports = {

  // ── Wake acknowledgement ─────────────────────────────────────────────────

  // What Bruce does the instant the wake phrase fires, before he starts
  // listening:
  //   'speak' — says "Yes?" (assets/wake-ack.wav; `npm run make-wake-ack`)
  //   'plop'  — the short beep
  //   'none'  — nothing at all; he goes straight to listening
  //
  // This is the boot default; the dashboard's Bruce page toggles it live (the
  // toggle does not survive a restart — set this to make a choice stick).
  //
  // Note that the acknowledgement also masks the OpenAI connect time, which
  // happens in parallel with it. On 'none' there is nothing to hide behind, so
  // the first reply of a conversation can feel a beat slower.
  WAKE_ACK: oneOf('WAKE_ACK', WAKE_ACK_MODES, 'speak'),
  WAKE_ACK_MODES,

  // ── OpenAI models ────────────────────────────────────────────────────────

  // Realtime (speech) model — gpt-realtime-mini (default) or gpt-realtime for
  // the bigger/pricier one. Must be a GA realtime model: OpenAI retired the
  // old beta API and the *-realtime-preview models Bruce originally used.
  REALTIME_MODEL: process.env.BRUCE_REALTIME_MODEL || 'gpt-realtime-mini',

  // Input transcription model (default gpt-4o-mini-transcribe).
  TRANSCRIPTION_MODEL: process.env.BRUCE_TRANSCRIPTION_MODEL || '',


  // ── Wake word (openWakeWord) ─────────────────────────────────────────────

  // Score (0..1) from the wake-phrase model that counts as a detection.
  // Lower = triggers more easily but also on near-misses and noise; higher =
  // you have to say it more clearly. Tune with WAKE_WORD_DEBUG below.
  WAKE_WORD_THRESHOLD: num('WAKE_WORD_THRESHOLD', 0.5),

  // After a detection, ignore further ones for this long, so a single wake
  // phrase can't fire twice as the tail of the utterance passes through.
  WAKE_WORD_REFRACTORY_MS: num('WAKE_WORD_REFRACTORY_MS', 2000),

  // Log the highest wake-word score seen each second. The way to pick a
  // threshold: watch the journal while the room is noisy, then while you say
  // the phrase, and put the threshold between the two.
  WAKE_WORD_DEBUG: bool('WAKE_WORD_DEBUG', false),

  // Amplify the mic before scoring it, for when the phrase has to be said
  // right next to the microphone. The models see raw PCM16 magnitudes, so the
  // same words from across the room score lower purely for being quieter, and
  // 2–4 here can be worth more than dropping the threshold — which is capped
  // in practice by "hey brew" scoring 0.480.
  //
  // It lifts background noise by the same factor, so it helps a faint phrase
  // in a quiet room and does nothing for one competing with the fridge. Turn
  // WAKE_WORD_DEBUG on and watch whether the spoken peak actually separates
  // from the idle peak. Detection only — the audio OpenAI hears and the
  // silence thresholds are unaffected.
  WAKE_WORD_GAIN: num('WAKE_WORD_GAIN', 1),


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
