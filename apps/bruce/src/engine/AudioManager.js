'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const recorder = require('node-record-lpcm16');
const Speaker = require('speaker');

const MIC_SAMPLE_RATE = 16000;    // Porcupine wake word requires 16kHz
const PLAYBACK_SAMPLE_RATE = 24000; // OpenAI Realtime API outputs 24kHz
const CHANNELS = 1;
const BIT_DEPTH = 16;

// Backoff schedule for restarting a dead microphone stream. The last entry
// repeats forever — a missing/unplugged mic keeps retrying (and logging)
// every 30s until it comes back.
const MIC_RESTART_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

class AudioManager extends EventEmitter {
  constructor() {
    super();
    this._recording = null;
    this._speaker = null;
    this._isSpeaking = false;
    this._speakerQueue = [];
    this._speakerDraining = false;
    this._gain = 1.0; // 0.0–1.0 speech volume

    // Mic auto-restart state (see _handleMicFailure)
    this._micOpts = {};
    this._micStopped = true;
    this._micRetries = 0;
    this._micRestartPending = false;
  }

  /**
   * Set playback volume gain (0.0 = silent, 1.0 = native volume; up to 2.0
   * digital boost for quiet speakers — boosted samples are hard-clipped).
   * @param {number} gain
   */
  setVolume(gain) {
    this._gain = Math.max(0, Math.min(2, gain));
  }

  /** Current playback gain (0.0–2.0). */
  get volume() {
    return this._gain;
  }

  /**
   * Start microphone capture. Emits 'data' with raw PCM16 Buffer chunks.
   * If the underlying recorder process dies (USB hiccup, sox crash), it is
   * restarted automatically with backoff — a dead mic must never mean a
   * permanently deaf assistant.
   * @param {object} [opts]
   * @param {string} [opts.device] - Audio device (e.g. 'plughw:1' on Linux)
   * @param {string} [opts.recorder] - Recorder backend ('sox' or 'arecord')
   */
  startMic(opts = {}) {
    if (this._recording) return;
    this._micOpts = opts;
    this._micStopped = false;
    this._micRetries = 0;
    this._micRestartPending = false;
    this._spawnMic();
  }

  stopMic() {
    this._micStopped = true;
    if (this._recording) {
      this._recording.stop();
      this._recording = null;
    }
  }

  /** @private Spawn the platform-appropriate recorder process. */
  _spawnMic() {
    this._micRestartPending = false;
    const opts = this._micOpts;

    // A chunk arriving proves the recorder works — reset the backoff so the
    // next failure (hours later) starts from a quick 1s retry again.
    const onData = (chunk) => {
      this._micRetries = 0;
      this.emit('data', chunk);
    };

    if (process.platform === 'win32') {
      // node-record-lpcm16 uses --default-device which fails on Windows.
      // Spawn sox directly with the waveaudio driver instead.
      const child = spawn('sox', [
        '-t', 'waveaudio', opts.device || 'default',
        '--rate', String(MIC_SAMPLE_RATE),
        '--channels', String(CHANNELS),
        '--encoding', 'signed-integer',
        '--bits', String(BIT_DEPTH),
        '--type', 'raw',
        '-',
      ]);

      child.stdout.on('data', onData);
      child.stderr.on('data', () => {}); // suppress sox progress output
      child.on('error', (err) => this._handleMicFailure(err));
      child.on('exit', (code) => {
        if (code !== null && code !== 0) {
          this._handleMicFailure(new Error(`sox exited with code ${code}`));
        }
      });

      this._recording = { stop: () => child.kill() };
      return;
    }

    this._recording = recorder.record({
      sampleRate: MIC_SAMPLE_RATE,
      channels: CHANNELS,
      audioType: 'raw',         // Raw PCM — no WAV header, required for Porcupine
      encoding: 'signed-integer',
      endian: 'little',
      bitwidth: BIT_DEPTH,
      device: opts.device || null,
      recorder: opts.recorder || 'sox',
    });

    this._recording
      .stream()
      .on('data', onData)
      .on('error', (err) => this._handleMicFailure(err))
      // The recorder process exiting without an error still means silence.
      .on('end', () => this._handleMicFailure(new Error('microphone stream ended unexpectedly')));
  }

  /**
   * @private The mic stream died. Unless we stopped it on purpose, report it
   * once and schedule a restart. Error + exit can both fire for one death, so
   * a pending flag keeps the restarts from stacking.
   */
  _handleMicFailure(err) {
    if (this._micStopped || this._micRestartPending) return;
    this._micRestartPending = true;
    this._recording = null;

    this.emit('error', err instanceof Error ? err : new Error(String(err)));
    const delay =
      MIC_RESTART_DELAYS_MS[Math.min(this._micRetries, MIC_RESTART_DELAYS_MS.length - 1)];
    this._micRetries++;
    console.log(`[Bruce] Microphone stream died — restarting in ${delay / 1000}s (attempt ${this._micRetries})`);
    setTimeout(() => {
      if (!this._micStopped) this._spawnMic();
    }, delay);
  }

  /**
   * Queue a PCM16 audio chunk for playback.
   * @param {Buffer} chunk - Raw PCM16 LE audio at 16kHz mono
   */
  playChunk(chunk) {
    this._speakerQueue.push(chunk);
    if (!this._speakerDraining) {
      this._drainQueue();
    }
  }

  /**
   * Signal end of TTS stream. Speaker will close after all queued audio plays.
   */
  endPlayback() {
    this._speakerQueue.push(null); // sentinel
    if (!this._speakerDraining) {
      this._drainQueue();
    }
  }

  /**
   * Immediately stop playback (e.g. for barge-in interruption).
   */
  stopPlayback() {
    this._speakerQueue = [];
    this._speakerDraining = false;
    if (this._speaker) {
      this._speaker.destroy();
      this._speaker = null;
    }
    this._isSpeaking = false;
    this.emit('playbackStopped');
  }

  /**
   * Load a .wav file and cache its raw PCM data for instant playback.
   * Call once at startup; playNotification() will use the cached buffer.
   * @param {string} filePath - Path to a PCM16 LE mono .wav file
   */
  loadNotificationSound(filePath) {
    const fs = require('fs');
    const buf = fs.readFileSync(require('path').resolve(filePath));

    // Parse WAV header to find the 'data' chunk
    let offset = 12; // skip RIFF header
    while (offset < buf.length - 8) {
      const chunkId = buf.toString('ascii', offset, offset + 4);
      const chunkSize = buf.readUInt32LE(offset + 4);
      if (chunkId === 'data') {
        const raw = buf.slice(offset + 8, offset + 8 + chunkSize);
        // Amplify notification sound (1.0 = original, 2.0 = 2× louder, etc.)
        const gain = 3.0;
        const amplified = Buffer.alloc(raw.length);
        for (let i = 0; i < raw.length - 1; i += 2) {
          const sample = Math.max(-32768, Math.min(32767, Math.round(raw.readInt16LE(i) * gain)));
          amplified.writeInt16LE(sample, i);
        }
        this._notificationPCM = amplified;
        return;
      }
      offset += 8 + chunkSize;
    }
    throw new Error('Could not find data chunk in WAV file');
  }

  /**
   * Play the pre-loaded notification sound through Speaker.
   * Includes a silent preroll to avoid warmup clipping.
   * @returns {Promise<void>}
   */
  playNotification() {
    if (!this._notificationPCM) return Promise.resolve();

    return new Promise((resolve) => {
      const prerollMs = 150;
      const prerollBytes = Math.floor(PLAYBACK_SAMPLE_RATE * (prerollMs / 1000)) * (BIT_DEPTH / 8) * CHANNELS;

      const spk = new Speaker({
        channels: CHANNELS,
        bitDepth: BIT_DEPTH,
        sampleRate: PLAYBACK_SAMPLE_RATE,
        signed: true,
      });

      spk.on('flush', () => {
        if (!spk.destroyed) {
          spk.removeAllListeners();
          spk.destroy();
        }
        resolve();
      });
      spk.on('error', () => {
        if (!spk.destroyed) {
          spk.removeAllListeners();
          spk.destroy();
        }
        resolve();
      });

      spk.write(Buffer.alloc(prerollBytes)); // silent preroll
      spk.write(this._notificationPCM);
      const postrollMs = 150;
      const postrollBytes2 = Math.floor(PLAYBACK_SAMPLE_RATE * (postrollMs / 1000)) * (BIT_DEPTH / 8) * CHANNELS;
      spk.end(Buffer.alloc(postrollBytes2)); // silent postroll
    });
  }

  get isSpeaking() {
    return this._isSpeaking;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _ensureSpeaker() {
    if (this._speaker) return;

    this._speaker = new Speaker({
      channels: CHANNELS,
      bitDepth: BIT_DEPTH,
      sampleRate: PLAYBACK_SAMPLE_RATE,
      signed: true,
    });

    // Write a short silent preroll so the speaker warmup doesn't clip the first word
    const prerollMs = 250;
    const bytesPerSample = BIT_DEPTH / 8;
    const prerollBytes = Math.floor(PLAYBACK_SAMPLE_RATE * (prerollMs / 1000)) * bytesPerSample * CHANNELS;
    this._speaker.write(Buffer.alloc(prerollBytes));

    this._speaker.on('open', () => {
      this._isSpeaking = true;
      this.emit('speakingStart');
    });

    this._speaker.on('flush', () => {
      this._isSpeaking = false;
      const spk = this._speaker;
      this._speaker = null;
      this._speakerDraining = false;
      // Force-release native audio resources immediately instead of waiting
      // for GC — lingering native handles cause crackling on Windows.
      if (spk && !spk.destroyed) {
        spk.removeAllListeners();
        spk.destroy();
      }
      // If more audio chunks arrived while the previous speaker was draining
      // (e.g. a new response phase started before the old one finished playing),
      // create a new speaker and keep playing instead of emitting speakingEnd.
      if (this._speakerQueue.length > 0) {
        this._drainQueue();
      } else {
        this.emit('speakingEnd');
      }
    });

    this._speaker.on('error', (err) => {
      this._speaker = null;
      this._speakerDraining = false;
      this.emit('error', err);
    });
  }

  _drainQueue() {
    if (this._speakerQueue.length === 0) return;

    this._speakerDraining = true;
    this._ensureSpeaker();

    const writeNext = () => {
      if (this._speakerQueue.length === 0) {
        this._speakerDraining = false;
        return;
      }

      const chunk = this._speakerQueue.shift();

      if (chunk === null) {
        // Write a silent postroll before closing to avoid pop/crackle
        const postrollMs = 250;
        const bytesPerSample = BIT_DEPTH / 8;
        const postrollBytes = Math.floor(PLAYBACK_SAMPLE_RATE * (postrollMs / 1000)) * bytesPerSample * CHANNELS;
        this._speaker.end(Buffer.alloc(postrollBytes));
        return;
      }

      // Apply volume gain to PCM16 samples (attenuate or boost; boost clips)
      let output = chunk;
      if (this._gain !== 1.0) {
        output = Buffer.alloc(chunk.length);
        for (let i = 0; i < chunk.length - 1; i += 2) {
          const sample = Math.max(-32768, Math.min(32767, Math.round(chunk.readInt16LE(i) * this._gain)));
          output.writeInt16LE(sample, i);
        }
      }

      // Respect back-pressure: if write() returns false, wait for 'drain'
      const canContinue = this._speaker.write(output);
      if (canContinue) {
        setImmediate(writeNext);
      } else {
        this._speaker.once('drain', writeNext);
      }
    };

    writeNext();
  }
}

module.exports = AudioManager;
