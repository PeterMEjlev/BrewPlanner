'use strict';

/**
 * How loud the microphone gets made before the wake phrase is scored.
 *
 * The models see raw PCM16 magnitudes, so the same words score lower from
 * across the room purely for arriving quieter — which is why "I have to stand
 * next to the microphone" is a gain problem before it is a model problem. One
 * fixed number cannot answer it: big enough to carry six metres, and speech at
 * one metre clips into distortion; small enough not to clip, and the far corner
 * is inaudible. So the gain moves.
 *
 * It is the lower of two limits:
 *
 *   - **Put speech at `targetPeak`.** Measured against a peak envelope that
 *     decays with a half-life of a couple of seconds, so it sits just above the
 *     room's own noise while nobody is talking — full gain, ready for a phrase
 *     from anywhere — and rises to hold the gain down while someone talks close
 *     to the mic.
 *   - **Keep the amplified noise floor under `maxNoise`.** Gain lifts the room
 *     by exactly as much as it lifts the phrase, so it can never improve the
 *     ratio between them. Past this point louder noise is the only thing it
 *     buys, and the model has to look at it.
 *
 * The move towards that target is asymmetric, and that asymmetry is the whole
 * trick. Turning the gain *down* is slow (`attackSeconds`), because that is
 * what a phrase arriving does to the target, and a gain that chased it within
 * an utterance would flatten the loudness contour the phrase is recognised by.
 * Turning it back *up* is quicker (`releaseSeconds`), because that only ever
 * happens in silence — and the instant anyone speaks the target drops and the
 * slow direction takes over again. Symmetric timing has to pick one or the
 * other: slow enough for the phrase means half a minute of quiet before full
 * gain comes back, which is longer than it takes to walk across the brewery.
 *
 * Levels in, levels out, no audio: this is the arithmetic, and
 * {@link WakeWordDetector} is what applies it to samples.
 */

/**
 * How fast the tracked noise floor follows the frame level, per 80ms frame.
 * Down quickly — a quieter room is a fact the moment it happens. Up *very*
 * slowly, because the floor's whole job is to sit under speech and it is
 * measured from audio that contains speech.
 *
 * The rise was 0.005 (a ~16 s time constant) and that was far too eager: in
 * the brewery, someone standing there repeating "hey Bruce" for fifteen
 * seconds walked the floor from its true 117 up to 325, the noise cap below
 * read the room as four times louder than it was, and the gain was throttled
 * to ×1.8 — less than the fixed ×6 this replaced — at the exact moment the
 * phrase needed lifting. At 0.0004 (~3 min) a burst of talking moves it by
 * well under a percent, and a room that genuinely gets louder still registers.
 */
const FLOOR_FALL = 0.3;
const FLOOR_RISE = 0.0004;

/**
 * Hard ceiling on the amplified peak, just under full scale.
 *
 * The gain moves over seconds, so the first loud words after a quiet spell
 * arrive while it is still up where the quiet room left it. Without this they
 * would be clipped flat — a square wave, broadband distortion, and a worse
 * score than the quiet audio it came from. Clamping the frame's gain to what
 * fits instead costs the same loudness contour that clipping would have
 * destroyed anyway, and keeps the waveform intact.
 */
const PEAK_CEILING = 32000;

const DEFAULTS = {
  /** Peak level (0–32768) to aim speech at: ~−12 dBFS, clear of the mic's own noise with headroom left. */
  targetPeak: 8000,
  /**
   * Ceiling on the amplified noise floor, RMS — a backstop against winding a
   * dead-quiet room's hiss up into something the model has to look at.
   *
   * Deliberately generous. It was 600, which sounds cautious until you measure:
   * the brewery's floor is ~117, so it capped the gain at ×5 — below the fixed
   * ×6 it replaced — and the fear it was guarding against turned out not to
   * exist. At ×16 in that room, with the noise amplified to ~1900, the idle
   * wake score sits at 0.001 against a threshold of 0.5. There is no
   * false-fire pressure to trade recall against, so don't trade any.
   */
  maxNoise: 3000,
  /** Below 1 so loud, close speech is turned down rather than clipped. */
  minGain: 0.5,
  maxGain: 16,
  /** Seconds to cover ~63% of a gain *reduction* — long against a 0.8 s phrase. */
  attackSeconds: 4,
  /** Same, for a gain *increase*. Only ever happens while the room is quiet. */
  releaseSeconds: 1.5,
  /** Half-life of the peak envelope — how fast full gain returns after someone stops talking. */
  peakHalfLifeSeconds: 1.5,
  /** Seconds of audio per update() call. */
  frameSeconds: 0.08,
};

class GainControl {
  /**
   * @param {object} [opts] - See DEFAULTS; plus `gain`, the initial setting
   *   (a positive number to pin it, or 'auto').
   */
  constructor({ gain = 'auto', ...opts } = {}) {
    this._opts = { ...DEFAULTS, ...opts };
    this._noiseFloor = 0;
    this._floorSeeded = false;
    this._peakEnvelope = 0;
    this.setGain(gain);

    // Precomputed: update() runs 12.5 times a second, forever.
    this._peakDecay = Math.pow(0.5, this._opts.frameSeconds / this._opts.peakHalfLifeSeconds);
    this._attack = 1 - Math.exp(-this._opts.frameSeconds / this._opts.attackSeconds);
    this._release = 1 - Math.exp(-this._opts.frameSeconds / this._opts.releaseSeconds);
  }

  /** How the gain is chosen: a fixed number, or 'auto'. */
  get setting() {
    return this._setting;
  }

  /**
   * The gain in force right now — under 'auto', where it has settled. This is
   * the operating point, not necessarily what a given frame got: a frame loud
   * enough to clip is handed less (see PEAK_CEILING). Reported to the settings
   * page and the mic meter, which want the steady number rather than one that
   * twitches on every loud syllable.
   */
  get gain() {
    return this._gain;
  }

  /**
   * The room level being tracked (RMS, 0–32768). Tracked whether or not the
   * gain is automatic: the mic meter shows it either way, and it is the number
   * that says whether a phrase has any chance of being heard.
   */
  get noiseFloor() {
    return this._noiseFloor;
  }

  /**
   * @param {number|'auto'} gain - A number greater than 0, or 'auto'
   * @throws if the number is zero, negative, or not finite — that would mute
   *   the detector rather than desensitise it.
   */
  setGain(gain) {
    if (gain === 'auto') {
      this._setting = 'auto';
      // Start at the ceiling rather than at 1: a quiet room is where the
      // control settles anyway, and starting low would leave the first wake
      // phrase after a restart under-amplified for several seconds.
      this._gain = this._opts.maxGain;
      return;
    }
    if (!Number.isFinite(gain) || gain <= 0) {
      throw new Error(`Wake-word gain must be a positive number or "auto", got ${gain}`);
    }
    this._setting = gain;
    this._gain = gain;
  }

  /**
   * Fold one frame's levels in and return the gain to apply to *this* frame —
   * which is {@link gain}, except on a frame loud enough to need the ceiling.
   * @param {number} rms - Frame RMS, high-passed, before gain
   * @param {number} peak - Frame peak magnitude, same
   * @returns {number} gain for this frame
   */
  update(rms, peak) {
    // Seeded from the first frame rather than crept up to from zero: with the
    // rise as slow as it now is, starting at 0 would leave the floor wrong —
    // and the meter reading wrong — for minutes after every restart.
    if (!this._floorSeeded) {
      this._floorSeeded = true;
      this._noiseFloor = rms;
    }
    const towardsFloor = rms < this._noiseFloor ? FLOOR_FALL : FLOOR_RISE;
    this._noiseFloor += (rms - this._noiseFloor) * towardsFloor;
    this._peakEnvelope = Math.max(peak, this._peakEnvelope * this._peakDecay);

    // A pinned gain gets no ceiling: its whole purpose is reproducing a
    // measurement exactly, and clipping is the honest signal that the number
    // being reproduced is too high for the room.
    if (this._setting !== 'auto') return this._gain;

    const { targetPeak, maxNoise, minGain, maxGain } = this._opts;
    // The 1s are floors, not fudge: a digitally silent mic (a muted capture
    // device, or the seconds before the first USB packet arrives) would
    // otherwise ask for infinite gain.
    const target = Math.max(
      Math.min(
        targetPeak / Math.max(this._peakEnvelope, 1),
        maxNoise / Math.max(this._noiseFloor, 1),
        maxGain,
      ),
      minGain,
    );
    this._gain += (target - this._gain) * (target < this._gain ? this._attack : this._release);
    return Math.min(this._gain, PEAK_CEILING / Math.max(peak, 1));
  }
}

module.exports = GainControl;
module.exports.DEFAULTS = DEFAULTS;
