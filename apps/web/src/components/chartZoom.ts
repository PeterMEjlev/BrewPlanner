import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

/**
 * Wheel-zoom and drag-pan for the recharts line charts. recharts has neither, so
 * we drive the axes' `domain` props ourselves from pointer events: scrolling over
 * the plot scales both axes about the cursor and dragging slides the view, while
 * doing either over a single axis affects only that axis. Kept out of the chart
 * component so the geometry maths stays readable and testable on its own.
 */

/** A value window on one axis, in data units (ms for time, °C, SG, …). */
export interface Span {
  min: number;
  max: number;
}

/** Distance from the chart wrapper's edges to the plot area, in px. */
export interface PlotInset {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Deepest zoom in, as a fraction of the full data extent (100× on either axis). */
const MAX_ZOOM_IN = 100;

/**
 * Furthest zoom out, as a multiple of the full data extent. Stopping at the data
 * itself would mean the axes could never scale *below* the default view, so a
 * chart can be pulled out to 20× — enough to squash a jittery trace flat.
 */
const MAX_ZOOM_OUT = 20;

/** How fast a wheel gesture scales the window (per normalised pixel). */
const ZOOM_PER_PX = 0.002;

/** Normalise a wheel delta to ~pixels, so line/page-mode devices zoom alike. */
function wheelPixels(e: WheelEvent): number {
  if (e.deltaMode === 1) return e.deltaY * 16; // deltaY counted in lines
  if (e.deltaMode === 2) return e.deltaY * 400; // …in pages
  return e.deltaY;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function sameSpan(a: Span, b: Span): boolean {
  return a.min === b.min && a.max === b.max;
}

/**
 * Place a window of width `span` starting at `min`, sliding it so the data stays
 * on screen: a window narrower than the data has to sit inside it, a wider one
 * only has to keep its centre over it.
 */
function clampWindow(min: number, span: number, extent: Span): Span {
  const full = extent.max - extent.min;
  if (span <= full) {
    if (min < extent.min) min = extent.min;
    if (min + span > extent.max) min = extent.max - span;
  } else {
    const centre = min + span / 2;
    if (centre < extent.min) min = extent.min - span / 2;
    else if (centre > extent.max) min = extent.max - span / 2;
  }
  return { min, max: min + span };
}

/**
 * Scale `cur` by `factor` about the value under the cursor — `frac` is the
 * cursor's position across the current window (0 = its low edge). Returns null
 * for "auto-fit the data", which the window snaps to as it crosses the full data
 * extent, so scrolling back out passes through the live default view before
 * widening past it.
 */
export function scaleSpan(
  cur: Span,
  extent: Span,
  frac: number,
  factor: number,
  minSpan: number,
): Span | null {
  const full = extent.max - extent.min;
  if (!(full > 0)) return null;
  const curSpan = cur.max - cur.min;
  const span = Math.min(Math.max(curSpan * factor, minSpan), full * MAX_ZOOM_OUT);
  if ((curSpan < full && span >= full) || (curSpan > full && span <= full)) return null;
  const anchor = cur.min + frac * curSpan;
  return clampWindow(anchor - frac * span, span, extent);
}

/** Slide `start` along its axis by `delta` data units, keeping the data in view. */
export function panSpan(start: Span, extent: Span, delta: number): Span {
  return clampWindow(start.min + delta, start.max - start.min, extent);
}

/** A pan in progress: where it began, and the windows it started from. */
interface Drag {
  pointerId: number;
  /** Grab point in client coords — deltas only, so no layout reads per move. */
  clientX: number;
  clientY: number;
  /** Start window per axis, or null for an axis this drag doesn't move. */
  x: Span | null;
  y: Span | null;
  /** Plot size in px at grab time, to convert pixels to data units. */
  width: number;
  height: number;
}

export interface ChartZoom {
  /** Attach to a wrapper that hugs the chart exactly (no padding of its own). */
  ref: RefObject<HTMLDivElement>;
  /** Current window, or null while the axis is auto-fitting the full extent. */
  xDomain: Span | null;
  yDomain: Span | null;
  zoomed: boolean;
  /** True while a pan is in progress — callers can shed work (e.g. tooltips). */
  dragging: boolean;
  reset: () => void;
}

export function useChartZoom({
  xExtent,
  yExtent,
  plotInset,
  minXSpan = 0,
  resetKey,
}: {
  xExtent: Span | null;
  yExtent: Span | null;
  plotInset: PlotInset;
  /** Floor on the X window (ms), below which zooming in stops. */
  minXSpan?: number;
  /** Zoom resets whenever this changes — a new metric or range is a new picture. */
  resetKey?: unknown;
}): ChartZoom {
  const ref = useRef<HTMLDivElement>(null);
  const [xDomain, setXDomain] = useState<Span | null>(null);
  const [yDomain, setYDomain] = useState<Span | null>(null);
  const [dragging, setDragging] = useState(false);

  const reset = useCallback((): void => {
    setXDomain(null);
    setYDomain(null);
  }, []);

  useEffect(() => {
    reset();
  }, [resetKey, reset]);

  // The listeners are attached once (see below), so they read their inputs from
  // a ref rather than closing over a stale render's values.
  const latest = useRef({ xExtent, yExtent, plotInset, minXSpan, xDomain, yDomain });
  latest.current = { xExtent, yExtent, plotInset, minXSpan, xDomain, yDomain };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const drag = { current: null as Drag | null };

    /**
     * Which axes a gesture at (px, py) acts on: inside the plot both move
     * together, over the X axis strip below it or the Y axis gutter beside it
     * only that one does. Null bounds mean the pointer is off the chart.
     */
    const regionOf = (px: number, py: number, r: DOMRect) => {
      const { plotInset: inset, xExtent: xe, yExtent: ye } = latest.current;
      const left = inset.left;
      const right = r.width - inset.right;
      const top = inset.top;
      const bottom = r.height - inset.bottom;
      if (right <= left || bottom <= top) return null;
      const overPlotX = px >= left && px <= right;
      const overPlotY = py >= top && py <= bottom;
      const bothAxes = overPlotX && overPlotY;
      return {
        left,
        top,
        width: right - left,
        height: bottom - top,
        x: (bothAxes || (overPlotX && py > bottom)) && xe != null,
        y: (bothAxes || (overPlotY && px < left)) && ye != null,
      };
    };

    const onWheel = (e: WheelEvent): void => {
      const { xExtent: xe, yExtent: ye, minXSpan: minX } = latest.current;
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const region = regionOf(px, py, r);
      if (!region || (!region.x && !region.y)) return; // off the chart — let the page scroll

      // Non-passive listener: React's onWheel can't preventDefault, and without
      // it the gesture would scroll the modal/page instead of zooming.
      e.preventDefault();
      const factor = Math.min(4, Math.max(0.25, Math.exp(wheelPixels(e) * ZOOM_PER_PX)));

      if (region.x && xe) {
        const frac = clamp01((px - region.left) / region.width);
        const floor = Math.max(minX, (xe.max - xe.min) / MAX_ZOOM_IN);
        setXDomain((cur) => scaleSpan(cur ?? xe, xe, frac, factor, floor));
      }
      if (region.y && ye) {
        // Screen Y grows downward, but values grow upward.
        const frac = 1 - clamp01((py - region.top) / region.height);
        setYDomain((cur) => scaleSpan(cur ?? ye, ye, frac, factor, (ye.max - ye.min) / MAX_ZOOM_IN));
      }
    };

    const onPointerDown = (e: PointerEvent): void => {
      // Mouse/pen only: claiming touch drags would break scrolling past the chart.
      if (e.pointerType === 'touch' || e.button !== 0) return;
      const { xExtent: xe, yExtent: ye } = latest.current;
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const region = regionOf(px, py, r);
      if (!region || (!region.x && !region.y)) return;

      e.preventDefault(); // no text selection / native drag while panning
      el.setPointerCapture(e.pointerId);
      drag.current = {
        pointerId: e.pointerId,
        clientX: e.clientX,
        clientY: e.clientY,
        // An auto-fitting axis pans from the full extent it's currently showing.
        x: region.x && xe ? (latest.current.xDomain ?? xe) : null,
        y: region.y && ye ? (latest.current.yDomain ?? ye) : null,
        width: region.width,
        height: region.height,
      };
      setDragging(true);
    };

    // Pointers report far faster than the screen repaints (a 1000 Hz mouse fires
    // ~16 moves per frame), so moves are folded into one update per frame — the
    // chart re-renders once per painted frame instead of once per event.
    let frame = 0;
    let pending: { dx: number; dy: number } | null = null;

    const applyPan = (): void => {
      frame = 0;
      const d = drag.current;
      const move = pending;
      pending = null;
      if (!d || !move) return;
      const { xExtent: xe, yExtent: ye } = latest.current;
      // Grab-and-drag: the point under the cursor follows it, so the window moves
      // the opposite way along X, and the same way along Y (screen Y is flipped).
      if (d.x && xe) {
        const next = panSpan(d.x, xe, (-move.dx * (d.x.max - d.x.min)) / d.width);
        setXDomain(sameSpan(next, xe) ? null : next);
      }
      if (d.y && ye) {
        const next = panSpan(d.y, ye, (move.dy * (d.y.max - d.y.min)) / d.height);
        setYDomain(sameSpan(next, ye) ? null : next);
      }
    };

    const onPointerMove = (e: PointerEvent): void => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      pending = { dx: e.clientX - d.clientX, dy: e.clientY - d.clientY };
      if (!frame) frame = requestAnimationFrame(applyPan);
    };

    const endDrag = (e: PointerEvent): void => {
      if (drag.current?.pointerId !== e.pointerId) return;
      // Land on the final position even if the last move hasn't painted yet.
      if (frame) {
        cancelAnimationFrame(frame);
        applyPan();
      }
      drag.current = null;
      setDragging(false);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', endDrag);
      el.removeEventListener('pointercancel', endDrag);
    };
  }, []);

  return {
    ref,
    xDomain,
    yDomain,
    zoomed: xDomain != null || yDomain != null,
    dragging,
    reset,
  };
}
