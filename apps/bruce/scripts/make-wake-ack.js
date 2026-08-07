#!/usr/bin/env node
'use strict';
/**
 * Render Bruce's wake-word acknowledgement to assets/wake-ack.wav.
 *
 *   npm run make-wake-ack --workspace @checklist/bruce
 *   npm run make-wake-ack --workspace @checklist/bruce -- "At your service?"
 *
 * Why a pre-rendered clip instead of letting the Realtime model say it: the
 * acknowledgement plays *while* the OpenAI session is still connecting (see
 * _onWakeWordDetected). Asking the model would mean waiting for the connect,
 * a response and the audio stream — a second or more of silence at exactly
 * the moment the user needs to know Bruce heard them — and it would re-word
 * itself every time. A cached clip starts instantly and is always the same.
 *
 * Run this once per install, and again after changing BRUCE_VOICE. It needs
 * OPENAI_API_KEY (already in /etc/brewplanner.env on the Pi). The cost is a
 * few characters of TTS — effectively nothing.
 */
// Optional: this script is also useful copied somewhere standalone, where the
// key comes from the environment and there is no node_modules to load.
try { require('dotenv').config(); } catch { /* key must then already be in env */ }
const fs = require('fs');
const path = require('path');

// Must match AudioManager's playback format — it does not resample.
const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BIT_DEPTH = 16;

const TEXT = process.argv[2] || 'Yes?';
const VOICE = process.env.BRUCE_VOICE || 'alloy';
const MODEL = process.env.BRUCE_TTS_MODEL || 'gpt-4o-mini-tts';
const OUT = path.join(__dirname, '..', 'assets', 'wake-ack.wav');

// The acknowledgement plays before Bruce starts listening, so every
// millisecond of it is latency the user waits through. TTS returns the word
// wrapped in a lot of padding — "Yes?" comes back as 1.9s of which 0.5s is
// speech — so trim it to the audible part.
const SILENCE_FLOOR = 0.01 * 32767;  // below this counts as silence
const KEEP_MARGIN_MS = 30;           // breathing room kept either side
// TTS output sits well below full scale, which would make the acknowledgement
// noticeably quieter than Bruce's Realtime speech. Lift the peak to a
// consistent level, but cap the gain so a near-silent render isn't amplified
// into pure noise.
const TARGET_PEAK = 0.7 * 32767;
const MAX_NORMALIZE_GAIN = 4.0;

/** Trim leading/trailing silence and normalize the peak. @returns {Buffer} */
function tidy(pcm) {
  const sampleCount = Math.floor(pcm.length / 2);
  let first = -1;
  let last = -1;
  let peak = 0;
  for (let i = 0; i < sampleCount; i++) {
    const amp = Math.abs(pcm.readInt16LE(i * 2));
    if (amp > peak) peak = amp;
    if (amp > SILENCE_FLOOR) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) return pcm; // all silence — leave it alone, caller warns

  const margin = Math.round((KEEP_MARGIN_MS / 1000) * SAMPLE_RATE);
  const start = Math.max(0, first - margin);
  const end = Math.min(sampleCount, last + margin + 1);
  const trimmed = pcm.slice(start * 2, end * 2);

  const gain = peak > 0 ? Math.min(TARGET_PEAK / peak, MAX_NORMALIZE_GAIN) : 1;
  if (gain <= 1) return trimmed;

  const out = Buffer.alloc(trimmed.length);
  for (let i = 0; i < trimmed.length - 1; i += 2) {
    const s = Math.max(-32768, Math.min(32767, Math.round(trimmed.readInt16LE(i) * gain)));
    out.writeInt16LE(s, i);
  }
  return out;
}

/** Minimal 44-byte canonical WAV header for raw PCM. */
function wavHeader(dataLength) {
  const blockAlign = (CHANNELS * BIT_DEPTH) / 8;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataLength, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);                    // fmt chunk size (PCM)
  h.writeUInt16LE(1, 20);                     // audio format: 1 = PCM
  h.writeUInt16LE(CHANNELS, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * blockAlign, 28); // byte rate
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(BIT_DEPTH, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataLength, 40);
  return h;
}

(async () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY is not set.');
    process.exit(1);
  }

  console.log(`Rendering "${TEXT}" with ${MODEL} / voice "${VOICE}"...`);

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      voice: VOICE,
      input: TEXT,
      // 'pcm' is raw 24kHz 16-bit mono little-endian — exactly the playback
      // format, so no resampling or channel juggling is needed.
      response_format: 'pcm',
    }),
  });

  if (!res.ok) {
    console.error(`OpenAI TTS failed (${res.status}): ${await res.text()}`);
    process.exit(1);
  }

  const raw = Buffer.from(await res.arrayBuffer());
  if (raw.length === 0) {
    console.error('OpenAI returned no audio.');
    process.exit(1);
  }

  const pcm = tidy(raw);
  const bytesPerSecond = SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8);
  const seconds = pcm.length / bytesPerSecond;
  if (seconds > 2) {
    console.warn(`Warning: ${seconds.toFixed(2)}s is long for an acknowledgement — the user waits through it before Bruce starts listening.`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.concat([wavHeader(pcm.length), pcm]));

  console.log(
    `Wrote ${OUT} (${seconds.toFixed(2)}s, trimmed from ${(raw.length / bytesPerSecond).toFixed(2)}s)`
  );
  console.log('Restart Bruce to pick it up: sudo systemctl restart bruce.service');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
