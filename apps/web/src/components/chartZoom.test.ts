import { describe, expect, it } from 'vitest';
import { MIN_TEMP_ZOOM_SPAN_C, type Span, scaleSpan } from './chartZoom';

const spanOf = (s: Span): number => s.max - s.min;

/** Scroll in from `start` until the window stops shrinking, or 100 notches. */
function zoomInFully(start: Span, extent: Span, minSpan: number): Span {
  let cur = start;
  for (let i = 0; i < 100; i++) {
    const next = scaleSpan(cur, extent, 0.5, 0.8, minSpan);
    if (!next || spanOf(next) >= spanOf(cur)) break;
    cur = next;
  }
  return cur;
}

describe('scaleSpan', () => {
  it('stops zooming in at the floor', () => {
    // A fridge holding within a couple of degrees over a 20 °C extent: without a
    // floor the axis would keep scaling down into sensor noise.
    const extent = { min: 0, max: 20 };
    const deepest = zoomInFully({ min: 18, max: 20 }, extent, MIN_TEMP_ZOOM_SPAN_C);
    expect(spanOf(deepest)).toBeCloseTo(MIN_TEMP_ZOOM_SPAN_C, 10);
  });

  it('keeps the floored window inside the data', () => {
    const extent = { min: 10, max: 30 };
    const deepest = zoomInFully(extent, extent, MIN_TEMP_ZOOM_SPAN_C);
    expect(deepest.min).toBeGreaterThanOrEqual(extent.min);
    expect(deepest.max).toBeLessThanOrEqual(extent.max);
  });

  it('auto-fits rather than zooming an extent already at the floor', () => {
    // Nothing to magnify: the whole logged window is narrower than the floor, so
    // the axis snaps back to fitting the data instead of going deeper.
    const extent = { min: 20, max: 20.3 };
    expect(scaleSpan(extent, extent, 0.5, 0.8, MIN_TEMP_ZOOM_SPAN_C)).toBeNull();
  });

  it('holds a window already on the floor instead of resetting it', () => {
    // Keeping the scroll going at the deepest zoom shouldn't spring the axis
    // back out to the whole range.
    const extent = { min: 0, max: 20 };
    const cur = { min: 18, max: 18 + MIN_TEMP_ZOOM_SPAN_C };
    const next = scaleSpan(cur, extent, 0.5, 0.8, MIN_TEMP_ZOOM_SPAN_C);
    expect(spanOf(next!)).toBeCloseTo(MIN_TEMP_ZOOM_SPAN_C, 10);
  });

  it('still zooms in freely below the floor of a wide metric', () => {
    // The floor is in data units, so a power chart spanning kilowatts is nowhere
    // near it and scales normally.
    const extent = { min: 0, max: 3000 };
    const next = scaleSpan({ min: 1000, max: 2000 }, extent, 0.5, 0.5, 0.05);
    expect(spanOf(next!)).toBeCloseTo(500, 10);
  });
});
