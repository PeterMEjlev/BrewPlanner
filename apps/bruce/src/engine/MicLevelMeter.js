'use strict';

/**
 * A few seconds of "what is the microphone actually hearing", kept so the
 * dashboard's Bruce page can draw it.
 *
 * This exists because "Bruce doesn't hear me from over there" has several very
 * different causes that look identical from the brewery floor: the mic may not
 * be picking the phrase up at all (nothing to score), it may be picking it up
 * fine while the wake model scores it low (a model problem), or the room may
 * simply be as loud as the speech (nothing downstream can fix that). Guessing
 * between them is how a week disappears. So: walk to the far corner, say "hey
 * Bruce", and read which one it is.
 *
 * Levels are the *raw* mic — before the wake detector's high-pass filter and
 * before its gain — because the question this answers is what arrived, not
 * what the detector made of it. What the detector made of it comes in beside
 * it, from {@link WakeWordDetector}: its own filtered level, its noise floor,
 * the gain it chose, and the score.
 *
 * Buckets are closed on sample count rather than wall clock, so the trace has
 * no gaps or double-counted slots when the recorder hands over chunks that
 * don't divide evenly into the bucket width.
 */

const SAMPLE_RATE = 16000;

/** One bar of the trace. 100ms is a syllable — fine enough to see a phrase. */
const BUCKET_MS = 100;
const BUCKET_SAMPLES = (SAMPLE_RATE * BUCKET_MS) / 1000;

/** How much history to keep. Long enough to walk a few steps and try again. */
const WINDOW_MS = 6000;
const BUCKETS = WINDOW_MS / BUCKET_MS;

/**
 * A wake-word score older than this is stale — the detector only runs while
 * Bruce is idle, so during a conversation there is genuinely no score to show
 * and the trace should say so rather than hold the last value flat.
 */
const SCORE_STALE_MS = 1000;

class MicLevelMeter {
  constructor() {
    /** @type {{ rms: number, peak: number, score: number|null }[]} oldest → newest */
    this._buckets = [];
    this._samples = 0;
    this._sumSquares = 0;
    this._peak = 0;

    this._score = null;
    this._scoreAt = 0;
    this._bucketScore = null;
  }

  /** Bucket width in milliseconds — the resolution of {@link snapshot}. */
  get bucketMs() {
    return BUCKET_MS;
  }

  /** How much history {@link snapshot} returns, in milliseconds. */
  get windowMs() {
    return WINDOW_MS;
  }

  /**
   * Fold a chunk of raw microphone audio into the trace.
   * @param {Buffer} chunk - PCM16 LE, mono, 16kHz
   */
  push(chunk) {
    const total = Math.floor(chunk.length / 2);
    for (let i = 0; i < total; i++) {
      const sample = chunk.readInt16LE(i * 2);
      this._sumSquares += sample * sample;
      const magnitude = Math.abs(sample);
      if (magnitude > this._peak) this._peak = magnitude;
      if (++this._samples >= BUCKET_SAMPLES) this._closeBucket();
    }
  }

  /**
   * Record a wake-word score as it is produced (~12.5 a second, against ~10
   * buckets a second, so a bucket takes the highest score it saw).
   * @param {number} score - 0..1
   */
  noteScore(score) {
    this._score = score;
    this._scoreAt = Date.now();
    if (this._bucketScore == null || score > this._bucketScore) this._bucketScore = score;
  }

  /**
   * The trace, plus whatever the detector wants to say about itself.
   * @param {object} [detector] - From `WakeWordDetector.level` and friends
   * @param {number} [detector.filteredRms] - Frame RMS after the high-pass
   * @param {number} [detector.noiseFloor] - The room level the gain control tracks
   * @param {number} [detector.gain] - Amplification currently applied
   * @param {number|'auto'} [detector.gainMode] - How that gain is being chosen
   * @param {number} [detector.threshold] - Score that counts as a detection
   */
  snapshot(detector = {}) {
    return {
      now: Date.now(),
      bucketMs: BUCKET_MS,
      windowMs: WINDOW_MS,
      // Oldest → newest, and shorter than BUCKETS until the first six seconds
      // have gone by. The page draws whatever it is given.
      samples: this._buckets.slice(),
      filteredRms: detector.filteredRms ?? null,
      noiseFloor: detector.noiseFloor ?? null,
      gain: detector.gain ?? null,
      gainMode: detector.gainMode ?? null,
      threshold: detector.threshold ?? null,
    };
  }

  /** @private Finish the bucket in progress and start the next. */
  _closeBucket() {
    // The best score that arrived during this bucket, else the last one seen —
    // but only while it is fresh, so the trace goes blank during a conversation
    // rather than flatlining at whatever the last idle frame happened to score.
    const fresh = Date.now() - this._scoreAt < SCORE_STALE_MS;

    this._buckets.push({
      rms: Math.round(Math.sqrt(this._sumSquares / this._samples)),
      peak: this._peak,
      score: fresh ? this._bucketScore ?? this._score : null,
    });
    if (this._buckets.length > BUCKETS) {
      this._buckets.splice(0, this._buckets.length - BUCKETS);
    }

    this._samples = 0;
    this._sumSquares = 0;
    this._peak = 0;
    this._bucketScore = null;
  }
}

module.exports = MicLevelMeter;
