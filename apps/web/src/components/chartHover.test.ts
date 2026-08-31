import { describe, expect, it } from 'vitest';
import { coversSample, sampleTimeAt, snapToBar, snapToSample } from './chartHover';

/**
 * A crosshair one sample off still looks right and quotes the wrong number,
 * which is the whole reason this maths is worth pinning: nothing about the
 * rendered chart would give it away.
 */

describe('snapToSample', () => {
  // Five points span the plot end to end, so they sit a quarter apart.
  it('lands on the nearest point, and reports where that point is', () => {
    expect(snapToSample(0, 5)).toEqual({ index: 0, frac: 0 });
    expect(snapToSample(1, 5)).toEqual({ index: 4, frac: 1 });
    expect(snapToSample(0.5, 5)).toEqual({ index: 2, frac: 0.5 });
  });

  it('rounds to the closer of two neighbours', () => {
    expect(snapToSample(0.26, 5).index).toBe(1);
    expect(snapToSample(0.24, 5).index).toBe(1);
    expect(snapToSample(0.4, 5).index).toBe(2);
  });

  it('never reports a point that is not there', () => {
    // A pointer at the very edge of the box, or past it during a fast drag.
    for (const frac of [-0.2, 0, 0.999, 1, 1.5]) {
      const { index } = snapToSample(frac, 5);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThanOrEqual(4);
    }
  });

  it('has nowhere to land on a chart with nothing drawn', () => {
    expect(snapToSample(0.5, 0)).toEqual({ index: 0, frac: 0 });
    expect(snapToSample(0.5, 1)).toEqual({ index: 0, frac: 0 });
  });
});

describe('snapToBar', () => {
  // Four bars each own a quarter of the width, unlike points which sit on it.
  it('picks the bar the pointer is inside, and anchors on its centre', () => {
    expect(snapToBar(0.0, 4)).toEqual({ index: 0, frac: 0.125 });
    expect(snapToBar(0.3, 4)).toEqual({ index: 1, frac: 0.375 });
    expect(snapToBar(0.99, 4)).toEqual({ index: 3, frac: 0.875 });
  });

  it('keeps the last bar rather than falling off the end at the right edge', () => {
    expect(snapToBar(1, 4).index).toBe(3);
    expect(snapToBar(1.4, 4).index).toBe(3);
  });

  it('clamps a pointer dragged off the left edge', () => {
    expect(snapToBar(-0.5, 4).index).toBe(0);
  });
});

describe('sampleTimeAt', () => {
  const window = { start: 0, end: 1000 };

  it('spreads the samples across the window', () => {
    expect(sampleTimeAt(0, 5, window)).toBe(0);
    expect(sampleTimeAt(2, 5, window)).toBe(500);
    expect(sampleTimeAt(4, 5, window)).toBe(1000);
  });

  it('has no time to give without a window', () => {
    expect(sampleTimeAt(2, 5, undefined)).toBeNull();
  });

  it('has no time to give for a chart with nothing drawn', () => {
    expect(sampleTimeAt(0, 1, window)).toBeNull();
  });
});

describe('coversSample', () => {
  // Five points a quarter apart, so a sample reaches an eighth either side.
  it('claims a moment inside the sample it belongs to', () => {
    expect(coversSample(0.5, 0.5, 5)).toBe(true);
    expect(coversSample(0.6, 0.5, 5)).toBe(true);
    expect(coversSample(0.4, 0.5, 5)).toBe(true);
  });

  it('leaves a moment that belongs to the neighbour', () => {
    expect(coversSample(0.7, 0.5, 5)).toBe(false);
    expect(coversSample(0.3, 0.5, 5)).toBe(false);
  });

  it('gives every moment in the window exactly one sample', () => {
    // No gaps between samples and no overlaps: walking across the plot, each
    // moment is claimed once, so a change can never be unreachable.
    const points = 9;
    for (let i = 0; i < 200; i++) {
      const moment = i / 199;
      const owners = Array.from({ length: points }, (_, k) => k / (points - 1)).filter((hover) =>
        coversSample(moment, hover, points),
      );
      expect(owners.length).toBeGreaterThanOrEqual(1);
      expect(owners.length).toBeLessThanOrEqual(2); // exactly on a boundary
    }
  });
});
