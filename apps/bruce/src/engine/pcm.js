'use strict';

/** Root-mean-square energy of signed 16-bit little-endian PCM samples. */
function pcmRms(buffer) {
  const samples = Math.floor(buffer.length / 2);
  if (samples === 0) return 0;
  let sumSquares = 0;
  for (let offset = 0; offset < buffer.length - 1; offset += 2) {
    const sample = buffer.readInt16LE(offset);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples);
}

module.exports = { pcmRms };
