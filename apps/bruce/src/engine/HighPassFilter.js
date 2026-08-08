'use strict';

/**
 * Second-order Butterworth high-pass (RBJ cookbook biquad, Q = 1/√2).
 *
 * Sits in front of the wake-word scorer to take the brewery out of the signal.
 * A room with a glycol chiller, a fridge, pumps and a fan has most of its noise
 * energy below ~150 Hz, and that rumble lands in the bottom mel bins — the same
 * bins the wake phrase has to be recognised in. Speech that carries the phrase
 * lives in the formants from ~300 Hz up, so cutting below ~120 Hz costs the
 * detector nothing and stops the low end from swamping it. It also removes the
 * DC offset some USB capsules carry, which otherwise eats headroom before the
 * gain stage.
 *
 * Direct Form I, float64 state: at 16 kHz a 120 Hz corner puts the poles close
 * to the unit circle, where float32 accumulators visibly ring.
 */
class HighPassFilter {
  /**
   * @param {number} cutoffHz - −3 dB corner. 0 (or anything ≥ Nyquist) makes
   *   the filter a pass-through, so "off" needs no branch at the call site.
   * @param {number} sampleRate
   */
  constructor(cutoffHz, sampleRate) {
    this._enabled = cutoffHz > 0 && cutoffHz < sampleRate / 2;
    this.reset();
    if (!this._enabled) return;

    const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / Math.SQRT2; // Q = 1/√2 → maximally flat passband
    const a0 = 1 + alpha;

    this._b0 = ((1 + cos) / 2) / a0;
    this._b1 = (-(1 + cos)) / a0;
    this._b2 = this._b0;
    this._a1 = (-2 * cos) / a0;
    this._a2 = (1 - alpha) / a0;
  }

  /** True when the filter actually does something (a 0 Hz corner does not). */
  get enabled() {
    return this._enabled;
  }

  /** Forget the filter's memory — call when the audio stream is discontinuous. */
  reset() {
    this._x1 = 0;
    this._x2 = 0;
    this._y1 = 0;
    this._y2 = 0;
  }

  /**
   * Filter one sample.
   * @param {number} x
   * @returns {number}
   */
  process(x) {
    if (!this._enabled) return x;
    const y =
      this._b0 * x + this._b1 * this._x1 + this._b2 * this._x2 -
      this._a1 * this._y1 - this._a2 * this._y2;
    this._x2 = this._x1;
    this._x1 = x;
    this._y2 = this._y1;
    this._y1 = y;
    return y;
  }
}

module.exports = HighPassFilter;
