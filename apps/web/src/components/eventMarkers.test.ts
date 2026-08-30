import { describe, expect, it } from 'vitest';
import { badgeBox, cardShift, markerFraction, setpointChangeLabel } from './eventMarkers';

describe('setpointChangeLabel', () => {
  it('reads as the move it describes', () => {
    expect(setpointChangeLabel({ from: 18, to: 20 })).toBe('18.0° → 20.0°');
  });

  it('keeps a tenth, since that is the finest a controller is set to', () => {
    expect(setpointChangeLabel({ from: 18.5, to: 3.5 })).toBe('18.5° → 3.5°');
  });
});

describe('markerFraction', () => {
  const window = { start: 0, end: 100 };

  it('places a marker where it falls across the window', () => {
    expect(markerFraction(25, window)).toBe(0.25);
    expect(markerFraction(0, window)).toBe(0);
    expect(markerFraction(100, window)).toBe(1);
  });

  it('drops a marker outside the window', () => {
    // Changes are fetched for the same range as the series, but the two land in
    // separate responses — a marker just outside must not be pinned to an edge.
    expect(markerFraction(-1, window)).toBeNull();
    expect(markerFraction(101, window)).toBeNull();
  });

  it('drops everything when the window has no span', () => {
    expect(markerFraction(5, { start: 5, end: 5 })).toBeNull();
  });
});

describe('cardShift', () => {
  it('centres a card out in the middle and pins it near the edges', () => {
    expect(cardShift(0.5)).toBe('translateX(-50%)');
    expect(cardShift(0.02)).toBe('translateX(0)');
    expect(cardShift(0.98)).toBe('translateX(-100%)');
  });
});

describe('badgeBox', () => {
  const plot = { x: 50, width: 400 }; // plot spans 50 → 450

  it('sits just right of the marker when there is room', () => {
    const box = badgeBox(100, 10, ['18.0° → 20.0°'], plot);
    expect(box.x).toBeGreaterThan(100);
    expect(box.x + box.width).toBeLessThanOrEqual(450);
  });

  it('flips to the left of a marker near the right edge', () => {
    const box = badgeBox(440, 10, ['18.0° → 20.0°', '1 Mar 2026, 09:00'], plot);
    expect(box.x + box.width).toBeLessThan(440);
  });

  it('never starts outside the plot, however narrow', () => {
    const narrow = { x: 50, width: 60 };
    const box = badgeBox(105, 10, ['18.0° → 20.0°', '1 Mar 2026, 09:00'], narrow);
    expect(box.x).toBeGreaterThanOrEqual(narrow.x);
  });

  it('sizes to the longest line and stacks the baselines', () => {
    const short = badgeBox(100, 0, ['a'], plot);
    const long = badgeBox(100, 0, ['a', 'a much longer second line'], plot);
    expect(long.width).toBeGreaterThan(short.width);
    expect(long.height).toBeGreaterThan(short.height);
    expect(long.lineY[1]! - long.lineY[0]!).toBeGreaterThan(0);
    // Both lines start at the same left edge, inside the padding.
    expect(long.textX).toBeGreaterThan(long.x);
  });

  it('falls back to the right side before the plot has been measured', () => {
    expect(badgeBox(100, 0, ['x'], null).x).toBeGreaterThan(100);
  });
});
