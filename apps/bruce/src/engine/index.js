'use strict';

require('dotenv').config();
const path = require('path');
const { EventEmitter } = require('events');
const WakeWordDetector = require('./WakeWordDetector');
const AudioManager = require('./AudioManager');
const AudioEchoCanceller = require('./AudioEchoCanceller');
const RealtimeClient = require('./RealtimeClient');
const FunctionRegistry = require('./FunctionRegistry');
const cfg = require('../../config');


const MAX_UTTERANCE_MS         = cfg.MAX_UTTERANCE_MS;
const SILENCE_THRESHOLD_MS     = cfg.SILENCE_THRESHOLD_MS;
const SILENCE_ENERGY_THRESHOLD = cfg.SILENCE_ENERGY_THRESHOLD;
const FOLLOW_UP_TIMEOUT_MS     = cfg.FOLLOW_UP_TIMEOUT_MS;
const MIN_SPEECH_ENERGY        = cfg.MIN_SPEECH_ENERGY;
const DEBUG_ENERGY             = cfg.DEBUG_ENERGY || 'off';
const SESSION_IDLE_TIMEOUT_MS  = cfg.SESSION_IDLE_TIMEOUT_MS;
const THINKING_TIMEOUT_MS      = cfg.THINKING_TIMEOUT_MS;
const SPEAKING_TIMEOUT_MS      = cfg.SPEAKING_TIMEOUT_MS;
const LISTENING_GRACE_MS       = cfg.LISTENING_GRACE_MS;
const BARGE_IN_ENABLED         = cfg.BARGE_IN_ENABLED;
const BARGE_IN_ENERGY_THRESHOLD = cfg.BARGE_IN_ENERGY_THRESHOLD;

// How many times speak() retries connecting before dropping the message —
// a reminder must survive a transient network blip, not just a warm session.
const SPEAK_CONNECT_ATTEMPTS = 3;
const SPEAK_RETRY_DELAY_MS = 5000;

/**
 * BruceAssistant
 *
 * Standalone voice assistant class. Orchestrates:
 *  - Offline wake word detection (openWakeWord via ONNX Runtime)
 *  - Audio capture (microphone via SoX)
 *  - OpenAI Realtime API (STT + LLM + TTS over WebSocket)
 *  - Audio playback (speaker)
 *  - Function/tool calling
 *
 * State machine: idle → listening → thinking → speaking → idle
 *
 * Events: ready | wake | listening | thinking | speaking | idle | functionCall | error
 */
class BruceAssistant extends EventEmitter {
  /**
   * @param {object} config
   * @param {string} config.openaiKey - OpenAI API key
   * @param {string} config.wakeWordPath - Path to the wake-phrase .onnx model
   * @param {number} [config.wakeWordThreshold] - Detection score 0.0–1.0
   * @param {string} [config.systemPrompt] - System instructions for Bruce
   * @param {string} [config.voice='alloy'] - TTS voice
   * @param {number} [config.sensitivity=0.5] - Wake word sensitivity (0.0–1.0)
   * @param {string} [config.micDevice] - Optional mic device (e.g. 'plughw:1' on Linux)
   */
  constructor(config) {
    super();
    this._config = config;
    this._state = 'idle';

    this._registry = new FunctionRegistry();

    this._wakeWord = new WakeWordDetector({
      modelPath: config.wakeWordPath,
      threshold: config.wakeWordThreshold ?? cfg.WAKE_WORD_THRESHOLD,
      refractoryMs: cfg.WAKE_WORD_REFRACTORY_MS,
      debug: cfg.WAKE_WORD_DEBUG,
    });

    this._audio = new AudioManager();

    // Barge-in echo gate (only consulted when BARGE_IN_ENABLED).
    this._aec = new AudioEchoCanceller({
      speechThreshold: BARGE_IN_ENERGY_THRESHOLD,
      debug: DEBUG_ENERGY === 'all',
    });

    this._realtime = new RealtimeClient({
      apiKey: config.openaiKey,
      voice: config.voice || 'alloy',
      model: config.model || cfg.REALTIME_MODEL,
      transcriptionModel: config.transcriptionModel || cfg.TRANSCRIPTION_MODEL || undefined,
      systemPrompt:
        config.systemPrompt ||
        'You are Bruce, a helpful AI assistant for a home brewing setup. Keep responses concise and conversational — you are speaking, not writing.',
      registry: this._registry,
    });

    this._silenceTimer = null;
    this._utteranceTimer = null;
    this._followUpTimer = null;
    this._hasHeardVoice = false;
    this._skipFollowUp = false;
    this._peakEnergy = 0;
    this._audioPlayedThisTurn = false;
    // What the wake phrase triggers ('speak' | 'plop' | 'none'). Starts from
    // the configured default and is toggled live from the dashboard.
    this._wakeAck = cfg.WAKE_ACK;

    // Session lifecycle: the OpenAI connection is opened on demand and closed
    // after idling, so a dropped WS never leaves Bruce permanently deaf.
    this._connectPromise = null;
    this._idleTimer = null;
    // Watchdog: force-reset out of any non-idle state that overstays (a dead
    // session otherwise wedges the state machine until a service restart).
    this._watchdogTimer = null;

    this._bindEvents();
  }

  /**
   * Connect to OpenAI, start wake word detector and microphone.
   */
  async start() {
    // Built-in function: Bruce calls this when the user wants to end the conversation
    this._registry.register(
      'end_conversation',
      'End the current conversation and go back to sleep. You MUST call this whenever the user says goodbye, stop, that\'s it, thank you, no more questions, never mind, or any phrase indicating they are finished.',
      { type: 'object', properties: {}, required: [] },
      async () => {
        this._cancelTimers();
        this._audio.stopPlayback();
        this._realtime.clearAudioBuffer();
        this._setState('idle');
        this.emit('idle');
        return 'Conversation ended.';
      }
    );

    const assets = path.join(__dirname, '..', '..', 'assets');

    // Sounds are keyed by the WAKE_ACK mode that selects them, so playing the
    // acknowledgement is just playSound(mode). The plop is quiet and needs a
    // boost; the spoken ack is already at speech level, so it plays at unity.
    this._audio.loadSound('plop', path.join(assets, 'plop.wav'), 3.0);
    try {
      this._audio.loadSound('speak', path.join(assets, 'wake-ack.wav'));
    } catch (err) {
      // Not generated yet (see `npm run make-wake-ack`), or the wrong format.
      // Falling back to the plop keeps Bruce usable instead of crash-looping
      // the service over a missing sound effect.
      console.log(`[Bruce] No spoken wake acknowledgement (${err.message}) — using the plop`);
      this._audio.loadSound('speak', path.join(assets, 'plop.wav'), 3.0);
    }
    // Loads three ONNX models and primes the feature buffer — must finish
    // before the mic starts feeding it audio.
    await this._wakeWord.start();
    this._audio.startMic({ device: this._config.micDevice });
    this._setState('idle');
    this.emit('ready');

    // Warm up the OpenAI session so the first question after boot is snappy
    // (and a bad API key shows up in the journal immediately). Failure is not
    // fatal — the session is (re)opened on demand at every wake word.
    try {
      await this._ensureConnected();
    } catch (err) {
      console.log('[Bruce] Initial OpenAI connect failed (will retry on wake word):', err.message);
    }
  }

  /**
   * Gracefully shut down all components.
   */
  async stop() {
    this._cancelTimers();
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    if (this._watchdogTimer) { clearTimeout(this._watchdogTimer); this._watchdogTimer = null; }
    this._audio.stopMic();
    this._audio.stopPlayback();
    this._wakeWord.stop();
    this._realtime.disconnect();
    this._setState('idle');
  }

  /**
   * Resolve once the OpenAI session is ready, connecting (or reconnecting)
   * if needed. Concurrent callers share one in-flight connect.
   * @private
   */
  _ensureConnected() {
    if (this._realtime.isReady) return Promise.resolve();
    if (!this._connectPromise) {
      this._connectPromise = this._realtime
        .connect()
        .then(() => console.log('[Bruce] OpenAI session ready'))
        .finally(() => {
          this._connectPromise = null;
        });
    }
    return this._connectPromise;
  }

  /**
   * Abandon the current turn and return to idle — the escape hatch for a dead
   * or wedged session. Closes the session so the next wake word starts fresh.
   * @private
   */
  _forceIdle(reason) {
    console.log(`[Bruce] Resetting to idle (${reason})`);
    this._cancelTimers();
    this._skipFollowUp = false;
    this._audio.stopPlayback();
    try {
      this._realtime.clearAudioBuffer();
    } catch { /* session may already be gone */ }
    this._realtime.disconnect();
    this._setState('idle');
    this.emit('idle');
  }

  /**
   * Register a tool Bruce can call during conversation.
   * Can be called before or after start() — if the session is already live,
   * the configuration is re-sent so the model actually sees the new tool.
   * @param {string} name - snake_case function name
   * @param {string} description - Description for the LLM
   * @param {object} parameters - JSON Schema object
   * @param {Function} handler - async (args) => string
   */
  registerFunction(name, description, parameters, handler) {
    this._registry.register(name, description, parameters, handler);
    this._realtime.refreshTools();
  }

  get state() {
    return this._state;
  }

  /**
   * Set Bruce's speech volume (0.0 = silent, 1.0 = native, up to 2.0 boost).
   * @param {number} gain
   */
  setVolume(gain) {
    this._audio.setVolume(gain);
  }

  /** Current speech volume gain (0.0–2.0). */
  get volume() {
    return this._audio.volume;
  }

  /** What the wake phrase triggers: 'speak' | 'plop' | 'none'. */
  get wakeAck() {
    return this._wakeAck;
  }

  /**
   * Choose what Bruce does when the wake phrase fires. Takes effect on the
   * next wake word; it is not persisted, so a restart returns to BRUCE_WAKE_ACK.
   * @param {string} mode - One of cfg.WAKE_ACK_MODES
   */
  setWakeAck(mode) {
    if (!cfg.WAKE_ACK_MODES.includes(mode)) {
      throw new Error(`Unknown wake acknowledgement "${mode}"`);
    }
    this._wakeAck = mode;
  }

  /** True while the OpenAI session is connected and configured. */
  get connected() {
    return this._realtime.isReady;
  }

  /**
   * Make Bruce speak unprompted by injecting a text message into the conversation.
   * Bruce will respond with TTS audio as if the user had spoken to him.
   *
   * Reconnects the OpenAI session if needed (with retries) — a fired reminder
   * must survive a dropped connection, not be silently swallowed.
   * @param {string} text - The text prompt for Bruce to respond to
   */
  async speak(text) {
    for (let attempt = 1; attempt <= SPEAK_CONNECT_ATTEMPTS; attempt++) {
      try {
        await this._ensureConnected();
        break;
      } catch (err) {
        if (attempt === SPEAK_CONNECT_ATTEMPTS) {
          console.error(`[Bruce] Could not connect after ${attempt} attempts — dropping message: "${text}"`);
          this.emit('error', new Error(`Dropped speak message (no connection): ${err.message}`));
          return;
        }
        await new Promise((r) => setTimeout(r, SPEAK_RETRY_DELAY_MS));
      }
    }
    // If Bruce is busy (listening/thinking/speaking), wait for idle
    if (this._state !== 'idle') {
      const onIdle = () => {
        this.removeListener('idle', onIdle);
        this._doSpeak(text);
      };
      this.on('idle', onIdle);
      return;
    }
    this._doSpeak(text);
  }

  /** @private */
  async _doSpeak(text) {
    try {
      // The session may have idled out while we waited for the idle event.
      await this._ensureConnected();
    } catch (err) {
      console.error('[Bruce] Could not reconnect to speak:', err.message);
      this.emit('error', err);
      return;
    }
    this._skipFollowUp = true;
    this._realtime.sendText(text);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _bindEvents() {
    // Mic audio is routed based on current state
    this._audio.on('data', (chunk) => {
      if (this._state === 'idle') {
        this._wakeWord.processAudio(chunk);
      } else if (this._state === 'listening') {
        this._realtime.sendAudioChunk(chunk);
        this._checkSilence(chunk);
      } else if (this._state === 'speaking' && BARGE_IN_ENABLED) {
        // Echo gate: interrupt Bruce when the mic is louder than his own
        // speech bleeding back in — i.e. the user talking over him.
        if (this._aec.detectBargeIn(chunk)) {
          this._onBargeIn();
        }
      }
    });

    this._wakeWord.on('detected', () => {
      if (this._state === 'idle') {
        this._onWakeWordDetected();
      }
    });

    // TTS audio chunks stream in as Base64-decoded PCM16 buffers
    this._realtime.on('audioChunk', (buffer) => {
      if (this._state === 'idle') return;  // conversation already ended
      if (this._state !== 'speaking') {
        this._setState('speaking');
        this._aec.resetForUtterance();
      }
      if (BARGE_IN_ENABLED) this._aec.feedFarEnd(buffer);
      this._audioPlayedThisTurn = true;
      this._audio.playChunk(buffer);
    });

    this._realtime.on('audioDone', () => {
      // Only while actually speaking: after a barge-in (state: listening) the
      // cancelled response's audioDone must not open a phantom speaker whose
      // flush would trigger a second, overlapping follow-up window.
      if (this._state !== 'speaking') return;
      this._audio.endPlayback();
    });

    // Session dropped unexpectedly (network blip, server-side session expiry).
    // Mid-conversation: bail out to idle — the next wake word reconnects.
    // While idle: nothing to do; _ensureConnected reconnects on demand.
    this._realtime.on('disconnected', ({ code, deliberate }) => {
      if (deliberate) return;
      console.log(`[Bruce] OpenAI session dropped (code ${code})`);
      if (this._state !== 'idle') {
        this._forceIdle('session dropped mid-conversation');
      }
    });

    // Speaker finished — listen for follow-up instead of going idle
    this._audio.on('speakingEnd', () => {
      if (this._state !== 'speaking') return;  // conversation ended or barge-in took over
      if (this._skipFollowUp) {
        this._skipFollowUp = false;
        this._setState('idle');
        this.emit('idle');
        return;
      }
      // If more response phases are coming (functions to execute, results to share),
      // go back to thinking and wait instead of starting follow-up
      if (this._realtime.responsePhase) {
        this._setState('thinking');
        return;
      }
      this._startFollowUp();
    });

    this._realtime.on('thinking', () => {
      this._setState('thinking');
    });

    // When all response phases are complete:
    // - If audio was played this turn, start follow-up listening
    // - Otherwise (safety net), go idle
    this._realtime.on('responseDone', () => {
      if (this._state === 'thinking') {
        this._cancelTimers();
        if (this._audioPlayedThisTurn) {
          this._startFollowUp();
        } else {
          this._setState('idle');
          this.emit('idle');
        }
      }
    });

    this._realtime.on('transcript', (text) => {
      this.emit('transcript', text);
    });

    this._realtime.on('functionCall', (name, args) => {
      this.emit('functionCall', name, args);
    });

    this._realtime.on('reply', (text) => {
      this.emit('reply', text);
    });

    this._audio.on('error', (err) => this.emit('error', err));
    this._realtime.on('error', (err) => this.emit('error', err));
    this._wakeWord.on('error', (err) => this.emit('error', err));
  }

  async _onWakeWordDetected() {
    this.emit('wake');

    // (Re)connect the OpenAI session while the acknowledgement plays — the
    // session is opened on demand, and the acknowledgement masks the connect
    // time. The spoken one is a pre-rendered clip, not a model response, so it
    // starts instantly and costs nothing; routing it through the Realtime API
    // would put a second of dead air exactly where the user needs feedback.
    const connecting = this._ensureConnected();
    connecting.catch(() => { /* handled below — avoid an unhandled rejection */ });

    // Acknowledge first, and only then start streaming — this way the mic
    // doesn't send Bruce's own acknowledgement to OpenAI. On 'none' there is
    // nothing to play and listening starts immediately.
    if (this._wakeAck !== 'none') {
      await this._audio.playSound(this._wakeAck);
    }

    try {
      await connecting;
    } catch (err) {
      console.error('[Bruce] Could not reach OpenAI:', err.message);
      this.emit('error', new Error(`Wake word ignored — OpenAI unreachable: ${err.message}`));
      this._setState('idle');
      this.emit('idle');
      return;
    }

    this._aec.reset();
    this._setState('listening');
    this.emit('listening');

    this._hasHeardVoice = false;
    this._peakEnergy = 0;
    this._listeningStartedAt = Date.now();
    this._audioPlayedThisTurn = false;
    this._realtime.startStreaming();

    // Safety valve: auto-commit after MAX_UTTERANCE_MS even without silence
    this._utteranceTimer = setTimeout(() => this._commitAudio(), MAX_UTTERANCE_MS);
  }

  /**
   * The user talked over Bruce: kill playback, cancel the in-flight response,
   * and flip straight to listening — no beep, they're already speaking. The
   * words that triggered the gate are lost (detection latency); in practice
   * you interrupt with a filler ("Bruce—", "no wait") and then the request.
   * @private
   */
  _onBargeIn() {
    console.log('[Bruce] Barge-in — interrupting playback');
    this._cancelTimers();
    this._audio.stopPlayback();
    this._realtime.cancelResponse();
    this._skipFollowUp = false;

    this._setState('listening');
    this.emit('listening');

    this._hasHeardVoice = true; // they interrupted by speaking
    this._peakEnergy = 0;
    this._listeningStartedAt = Date.now();
    this._audioPlayedThisTurn = false;
    this._realtime.startStreaming();
    this._utteranceTimer = setTimeout(() => this._commitAudio(), MAX_UTTERANCE_MS);
  }

  _checkSilence(chunk) {
    const rms = this._computeRMS(chunk);
    if (DEBUG_ENERGY === 'listening' || DEBUG_ENERGY === 'all') {
      process.stdout.write(`\r[Energy] listening: ${Math.round(rms).toString().padStart(5)} (threshold: ${SILENCE_ENERGY_THRESHOLD})`);
    }
    if (rms < SILENCE_ENERGY_THRESHOLD) {
      if (!this._silenceTimer) {
        this._silenceTimer = setTimeout(() => this._commitAudio(), SILENCE_THRESHOLD_MS);
      }
    } else {
      // Voice energy detected — reset silence timer
      this._hasHeardVoice = true;
      // Ignore energy for 300ms after listening starts, so the tail of Bruce's
      // own acknowledgement bleeding back in can't be mistaken for the user
      if (rms > this._peakEnergy && Date.now() - this._listeningStartedAt > 300) {
        this._peakEnergy = rms;
      }
      if (this._followUpTimer) {
        clearTimeout(this._followUpTimer);
        this._followUpTimer = null;
      }
      if (!this._utteranceTimer) {
        this._utteranceTimer = setTimeout(() => this._commitAudio(), MAX_UTTERANCE_MS);
      }
      if (this._silenceTimer) {
        clearTimeout(this._silenceTimer);
        this._silenceTimer = null;
      }
    }
  }

  _commitAudio() {
    this._cancelTimers();
    if (this._state !== 'listening') return;
    if (!this._realtime.isReady) {
      // Session died while we were listening — committing would be silently
      // swallowed and the watchdog would have to clean up. Bail out now.
      this._forceIdle('session died while listening');
      return;
    }
    console.log(`[Bruce] Peak energy: ${Math.round(this._peakEnergy)} (min: ${MIN_SPEECH_ENERGY})`);
    if (!this._hasHeardVoice || this._peakEnergy < MIN_SPEECH_ENERGY) {
      // No meaningful speech detected — go idle
      this._realtime.clearAudioBuffer();
      this._setState('idle');
      this.emit('idle');
      return;
    }
    this._realtime.commitAndRespond();
  }

  _computeRMS(buffer) {
    // PCM16 LE: 2 bytes per sample, signed
    let sum = 0;
    const samples = Math.floor(buffer.length / 2);
    for (let i = 0; i < buffer.length - 1; i += 2) {
      const sample = buffer.readInt16LE(i);
      sum += sample * sample;
    }
    return samples > 0 ? Math.sqrt(sum / samples) : 0;
  }

  async _startFollowUp() {
    // Always the plop, whatever WAKE_ACK says: the follow-up window opens the
    // moment Bruce stops talking, where speaking again would tread on the tail
    // of his own reply.
    await this._audio.playSound('plop');

    this._setState('listening');
    this.emit('listening');
    this._realtime.startStreaming();
    this._hasHeardVoice = false;
    this._peakEnergy = 0;
    this._listeningStartedAt = Date.now();

    this._followUpTimer = setTimeout(() => {
      if (this._state === 'listening' && !this._hasHeardVoice) {
        this._realtime.clearAudioBuffer();
        this._setState('idle');
        this.emit('idle');
      }
    }, FOLLOW_UP_TIMEOUT_MS);
  }

  _cancelTimers() {
    if (this._silenceTimer) { clearTimeout(this._silenceTimer); this._silenceTimer = null; }
    if (this._utteranceTimer) { clearTimeout(this._utteranceTimer); this._utteranceTimer = null; }
    if (this._followUpTimer) { clearTimeout(this._followUpTimer); this._followUpTimer = null; }
  }

  _setState(state) {
    this._state = state;
    this._armWatchdog(state);
    this._manageIdleTimer(state);
    if (state === 'thinking') this.emit('thinking');
    if (state === 'speaking') this.emit('speaking');
  }

  /**
   * Per-state watchdog. Every non-idle state has a hard upper bound; if the
   * expected server event never arrives (dropped WS, lost event), the watchdog
   * is the only way back to idle short of restarting the service.
   * @private
   */
  _armWatchdog(state) {
    if (this._watchdogTimer) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    const limits = {
      thinking: THINKING_TIMEOUT_MS,
      speaking: SPEAKING_TIMEOUT_MS,
      // listening normally exits via the utterance/silence timers; this only
      // catches a commit that a dead session swallowed.
      listening: MAX_UTTERANCE_MS + LISTENING_GRACE_MS,
    };
    const limit = limits[state];
    if (limit > 0) {
      this._watchdogTimer = setTimeout(() => {
        this._watchdogTimer = null;
        this._forceIdle(`watchdog: stuck in "${state}" for ${Math.round(limit / 1000)}s`);
      }, limit);
    }
  }

  /**
   * Close the OpenAI session after sitting idle for a while. Within the window
   * Bruce keeps conversation context; afterwards the next wake word (or
   * reminder) reconnects fresh — which also bounds context/token growth.
   * @private
   */
  _manageIdleTimer(state) {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    if (state === 'idle' && SESSION_IDLE_TIMEOUT_MS > 0) {
      this._idleTimer = setTimeout(() => {
        this._idleTimer = null;
        if (this._state === 'idle' && this._realtime.isReady) {
          console.log('[Bruce] Closing OpenAI session after idle timeout (reconnects on next wake)');
          this._realtime.disconnect();
        }
      }, SESSION_IDLE_TIMEOUT_MS);
    }
  }
}

module.exports = BruceAssistant;
module.exports.BruceAssistant = BruceAssistant;
