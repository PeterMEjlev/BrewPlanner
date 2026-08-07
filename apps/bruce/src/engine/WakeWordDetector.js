'use strict';

const { EventEmitter } = require('events');
const path = require('path');

// Loaded on start(), not at import: onnxruntime-node is a heavyweight native
// addon whose worker threads outlive a plain `require`, and the test suite
// constructs the engine without ever starting the detector.
let ort = null;

/**
 * Wake-word detection with openWakeWord (https://github.com/dscripka/openWakeWord),
 * running locally through ONNX Runtime. Offline, free, and account-less — it
 * replaced Porcupine, which needs a Picovoice access key we no longer have.
 *
 * Three models in a chain, all in `wake-words/`:
 *
 *   16kHz PCM ──▶ melspectrogram.onnx ──▶ embedding_model.onnx ──▶ <phrase>.onnx
 *                 8 mel frames per        one 96-d embedding       score 0..1
 *                 80ms of audio           per 76 mel frames        per 16 embeddings
 *
 * The first two are shared by every wake word; only the last is phrase-specific,
 * so swapping the wake phrase is a one-file change (BRUCE_WAKE_WORD_MODEL).
 *
 * This is a direct port of openWakeWord's streaming path (`AudioFeatures.
 * _streaming_features` and `Model.predict` in the Python original), which is
 * what makes a model behave here the way it did in training: audio is consumed
 * in fixed 1280-sample steps, each mel call sees 480 samples of extra left
 * context so it yields exactly 8 new frames, the mel values get the same
 * `x/10 + 2` transform, and the feature buffer is seeded with embeddings of
 * random audio rather than silence.
 */

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 1280;                 // 80ms — openWakeWord's streaming unit
const FRAME_BYTES = FRAME_SAMPLES * 2;      // PCM16
const MEL_CONTEXT_SAMPLES = 160 * 3;        // extra left context per mel call
const MEL_INPUT_SAMPLES = FRAME_SAMPLES + MEL_CONTEXT_SAMPLES;
const MEL_BINS = 32;
const MEL_WINDOW = 76;                      // mel frames behind one embedding
const MEL_BUFFER_MAX = 10 * 97;             // ~10s of mel history
const FEATURE_DIM = 96;
const FEATURE_BUFFER_MAX = 120;             // ~10s of embedding history
const SEED_SECONDS = 4;                     // random audio used to prime the buffer

// Cap on un-processed mic audio. Inference costs ~15ms per 80ms frame on a Pi 4,
// so this should never fill — but if the Pi ever stalls, drop old audio rather
// than grow a queue that can never catch up.
const MAX_PENDING_BYTES = SAMPLE_RATE * 2 * 2;  // 2 seconds

class WakeWordDetector extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.modelPath - Wake-phrase classifier .onnx
   * @param {string} [opts.featureModelDir] - Directory holding melspectrogram.onnx
   *   and embedding_model.onnx (defaults to the classifier's own directory)
   * @param {number} [opts.threshold=0.5] - Score (0..1) that counts as a detection
   * @param {number} [opts.refractoryMs=2000] - Ignore further detections for this
   *   long after one fires, so a single "hey Bruce" triggers exactly once
   * @param {boolean} [opts.debug=false] - Log the highest score each second
   * @param {number} [opts.gain=1] - Amplify mic samples before scoring them.
   *   The models see raw PCM16 magnitudes, so speech from across the room
   *   scores lower simply for being quieter. Raising this is the lever for
   *   "I have to stand next to the mic" when the phrase is clear but faint —
   *   it does NOT improve a phrase buried in background noise, since it lifts
   *   the noise by exactly as much. Affects detection only; the audio sent to
   *   OpenAI and the silence thresholds are untouched.
   */
  constructor({ modelPath, featureModelDir, threshold = 0.5, refractoryMs = 2000, debug = false, gain = 1 }) {
    super();
    this._modelPath = path.resolve(modelPath);
    this._featureModelDir = featureModelDir
      ? path.resolve(featureModelDir)
      : path.dirname(this._modelPath);
    this._threshold = threshold;
    this._refractoryMs = refractoryMs;
    this._debug = debug;
    this._gain = gain > 0 ? gain : 1;

    this._melSession = null;
    this._embedSession = null;
    this._classifierSession = null;
    this._classifierFrames = 16;   // read from the model's input shape at start()

    this._active = false;
    this._pending = Buffer.alloc(0);
    this._draining = false;

    this._raw = new Int16Array(MEL_INPUT_SAMPLES);  // rolling tail of mic samples
    this._rawFilled = 0;
    this._mel = [];                                 // Float32Array(32) rows
    this._features = [];                            // Float32Array(96) rows
    this._seedFeatures = [];                        // pristine copy for reset()

    this._lastDetection = 0;
    this._lastScore = 0;
    this._debugPeak = 0;
    this._debugAt = 0;
    this._droppedWarnedAt = 0;
  }

  /** Samples per processing step — what a caller should feed us at a time. */
  get frameLength() {
    return FRAME_SAMPLES;
  }

  get sampleRate() {
    return SAMPLE_RATE;
  }

  /** Most recent wake-word score (0..1). Handy for tuning the threshold. */
  get lastScore() {
    return this._lastScore;
  }

  /**
   * Load the models and prime the feature buffer. Async — ONNX sessions are
   * created off-thread — so callers must await it before feeding audio.
   */
  async start() {
    if (!ort) ort = require('onnxruntime-node');

    // One thread each: three tiny models on a Pi that is also serving the
    // dashboard. Spawning per-op thread pools costs more than it saves here.
    const options = { executionProviders: ['cpu'], intraOpNumThreads: 1 };

    [this._melSession, this._embedSession, this._classifierSession] = await Promise.all([
      ort.InferenceSession.create(path.join(this._featureModelDir, 'melspectrogram.onnx'), options),
      ort.InferenceSession.create(path.join(this._featureModelDir, 'embedding_model.onnx'), options),
      ort.InferenceSession.create(this._modelPath, options),
    ]);

    // How many embeddings this phrase model looks at (16 for the official models).
    const frames = this._classifierSession.inputMetadata?.[0]?.shape?.[1];
    if (Number.isInteger(frames) && frames > 0) this._classifierFrames = frames;

    // openWakeWord seeds the feature buffer with embeddings of random audio, not
    // silence: silence embeddings are themselves a distinctive pattern and can
    // score high on some models before real audio has flushed them out.
    this._seedFeatures = await this._buildSeedFeatures();
    this.reset();

    this._active = true;
  }

  stop() {
    this._active = false;
    this._pending = Buffer.alloc(0);
    this._melSession = null;
    this._embedSession = null;
    this._classifierSession = null;
  }

  /** Drop all audio history, so the next detection starts from a clean slate. */
  reset() {
    this._raw.fill(0);
    this._rawFilled = 0;
    // The Python original resets to ones((76, 32)); matching it keeps the first
    // embedding after a reset identical to the reference implementation.
    this._mel = Array.from({ length: MEL_WINDOW }, () => new Float32Array(MEL_BINS).fill(1));
    this._features = this._seedFeatures.map((row) => row.slice());
    this._pending = Buffer.alloc(0);
  }

  /**
   * Feed raw PCM16 LE bytes from the mic. Bytes are accumulated and consumed in
   * exact 1280-sample steps; inference runs asynchronously, so this returns
   * immediately and 'detected' fires later.
   * @param {Buffer} chunk
   */
  processAudio(chunk) {
    if (!this._active) return;

    this._pending = Buffer.concat([this._pending, chunk]);

    if (this._pending.length > MAX_PENDING_BYTES) {
      this._pending = this._pending.subarray(this._pending.length - MAX_PENDING_BYTES);
      const now = Date.now();
      if (now - this._droppedWarnedAt > 30000) {
        this._droppedWarnedAt = now;
        console.log('[Bruce] Wake-word detection is falling behind the microphone — dropping audio');
      }
    }

    if (!this._draining) this._drain();
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /** @private Consume whole frames until the buffer runs dry. */
  async _drain() {
    this._draining = true;
    try {
      while (this._active && this._pending.length >= FRAME_BYTES) {
        const frame = this._pending.subarray(0, FRAME_BYTES);
        this._pending = this._pending.subarray(FRAME_BYTES);
        await this._processFrame(frame);
      }
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    } finally {
      this._draining = false;
    }
  }

  /** @private One 80ms step: mel -> embedding -> score. */
  async _processFrame(frameBytes) {
    // Slide the new samples into the rolling tail, amplified if configured.
    // Clipped to the int16 range: a gain high enough to clip is distorting the
    // phrase and will score worse, which is the signal to turn it back down.
    this._raw.copyWithin(0, FRAME_SAMPLES);
    const base = MEL_INPUT_SAMPLES - FRAME_SAMPLES;
    if (this._gain === 1) {
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        this._raw[base + i] = frameBytes.readInt16LE(i * 2);
      }
    } else {
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        const amplified = Math.round(frameBytes.readInt16LE(i * 2) * this._gain);
        this._raw[base + i] = Math.max(-32768, Math.min(32767, amplified));
      }
    }
    this._rawFilled = Math.min(this._rawFilled + FRAME_SAMPLES, MEL_INPUT_SAMPLES);

    const melRows = await this._melspectrogram(
      this._raw.subarray(MEL_INPUT_SAMPLES - this._rawFilled)
    );
    this._mel.push(...melRows);
    if (this._mel.length > MEL_BUFFER_MAX) this._mel.splice(0, this._mel.length - MEL_BUFFER_MAX);

    if (this._mel.length >= MEL_WINDOW) {
      this._features.push(await this._embed(this._mel.slice(-MEL_WINDOW)));
      if (this._features.length > FEATURE_BUFFER_MAX) {
        this._features.splice(0, this._features.length - FEATURE_BUFFER_MAX);
      }
    }

    if (this._features.length < this._classifierFrames) return;

    const score = await this._classify();
    this._lastScore = score;

    if (this._debug) {
      this._debugPeak = Math.max(this._debugPeak, score);
      const now = Date.now();
      if (now - this._debugAt >= 1000) {
        this._debugAt = now;
        console.log(`[Bruce] Wake-word peak score: ${this._debugPeak.toFixed(3)} (threshold ${this._threshold})`);
        this._debugPeak = 0;
      }
    }

    if (score >= this._threshold) {
      const now = Date.now();
      if (now - this._lastDetection < this._refractoryMs) return;
      this._lastDetection = now;
      // Clear the history so the tail of this utterance can't score again.
      this.reset();
      this.emit('detected', 0);
    }
  }

  /**
   * @private Mel spectrogram of raw PCM16 values, with openWakeWord's `x/10 + 2`
   * transform (which is what aligns the ONNX model with the TensorFlow one the
   * embedding model was trained against).
   * @param {Int16Array} samples
   * @returns {Promise<Float32Array[]>} one Float32Array(32) per mel frame
   */
  async _melspectrogram(samples) {
    const input = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) input[i] = samples[i];

    const name = this._melSession.inputNames[0];
    const out = await this._melSession.run({
      [name]: new ort.Tensor('float32', input, [1, samples.length]),
    });
    const tensor = out[this._melSession.outputNames[0]];
    const frames = tensor.dims[tensor.dims.length - 2];
    const data = tensor.data;

    const rows = [];
    for (let f = 0; f < frames; f++) {
      const row = new Float32Array(MEL_BINS);
      for (let b = 0; b < MEL_BINS; b++) row[b] = data[f * MEL_BINS + b] / 10 + 2;
      rows.push(row);
    }
    return rows;
  }

  /**
   * @private Google speech-embedding vector for a 76-frame mel window.
   * @param {Float32Array[]} melWindow
   * @returns {Promise<Float32Array>} 96-d embedding
   */
  async _embed(melWindow) {
    const input = new Float32Array(MEL_WINDOW * MEL_BINS);
    for (let f = 0; f < MEL_WINDOW; f++) input.set(melWindow[f], f * MEL_BINS);

    const name = this._embedSession.inputNames[0];
    const out = await this._embedSession.run({
      [name]: new ort.Tensor('float32', input, [1, MEL_WINDOW, MEL_BINS, 1]),
    });
    return Float32Array.from(out[this._embedSession.outputNames[0]].data);
  }

  /** @private Score the most recent embeddings against the wake phrase. */
  async _classify() {
    const n = this._classifierFrames;
    const input = new Float32Array(n * FEATURE_DIM);
    const window = this._features.slice(-n);
    for (let f = 0; f < n; f++) input.set(window[f], f * FEATURE_DIM);

    const name = this._classifierSession.inputNames[0];
    const out = await this._classifierSession.run({
      [name]: new ort.Tensor('float32', input, [1, n, FEATURE_DIM]),
    });
    return out[this._classifierSession.outputNames[0]].data[0];
  }

  /**
   * @private Embeddings of a few seconds of random audio, used to prime the
   * feature buffer at startup and after every reset.
   * @returns {Promise<Float32Array[]>}
   */
  async _buildSeedFeatures() {
    const samples = new Int16Array(SAMPLE_RATE * SEED_SECONDS);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.floor(Math.random() * 2000) - 1000;
    }

    const mel = await this._melspectrogram(samples);
    const rows = [];
    for (let i = 0; i + MEL_WINDOW <= mel.length; i += 8) {
      rows.push(await this._embed(mel.slice(i, i + MEL_WINDOW)));
    }
    return rows.slice(-FEATURE_BUFFER_MAX);
  }
}

module.exports = WakeWordDetector;
