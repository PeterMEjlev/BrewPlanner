import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

/**
 * Wheel-zoom, drag-pan and shift-drag range selection for the recharts line
 * charts. recharts has none of the three, so we drive the axes' `domain` props
 * ourselves from pointer events: scrolling over the plot scales both axes about
 * the cursor and dragging slides the view, while doing either over a single axis
 * affects only that axis. Kept out of the chart component so the geometry maths
 * stays readable and testable on its own.
 *
 * Shift-drag paints a time range instead of panning, which the chart draws as a
 * band and summarises (see chartSelect.tsx). The modifier rather than a plain
 * drag because panning was here first and is the gesture in the fingers already;
 * the hint line under each chart is where both are advertised.
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

/**
 * The value under a client X, given the plot's left edge and width in px and the
 * window it is currently showing. Clamped to the plot, so a paint that wanders
 * off the side of the chart ends at its edge rather than off the data.
 */
export function valueAt(clientX: number, originClientX: number, width: number, view: Span): number {
  const frac = clamp01((clientX - originClientX) / width);
  return view.min + frac * (view.max - view.min);
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

/**
 * A range being painted with shift-drag: where it was anchored, and enough plot
 * geometry to turn later pointer positions into values without measuring the
 * element again mid-gesture.
 */
interface Paint {
  pointerId: number;
  /** Data value under the grab point — one end of the range, fixed. */
  anchor: number;
  /** Client X of the plot's left edge, so a move is a subtraction. */
  originClientX: number;
  /** Plot width in px, to convert pixels to data units. */
  width: number;
  /** The x window on screen when the paint began; a paint can't zoom or pan. */
  view: Span;
}

/** Below this many pixels a shift-drag is a click, and clears the selection. */
const MIN_SELECTION_PX = 4;

export interface ChartZoom {
  /** Attach to a wrapper that hugs the chart exactly (no padding of its own). */
  ref: RefObject<HTMLDivElement>;
  /** Current window, or null while the axis is auto-fitting the full extent. */
  xDomain: Span | null;
  yDomain: Span | null;
  zoomed: boolean;
  /** True while a pan is in progress — callers can shed work (e.g. tooltips). */
  dragging: boolean;
  /**
   * The range the user has shift-dragged across, in x data units, or null when
   * nothing is selected. Held in data units rather than pixels, so it stays over
   * the same period as the view is zoomed and panned around it.
   */
  selection: Span | null;
  /** True while the band is being painted — same reason as `dragging`. */
  selecting: boolean;
  clearSelection: () => void;
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
  const [selection, setSelection] = useState<Span | null>(null);
  const [selecting, setSelecting] = useState(false);

  const clearSelection = useCallback((): void => {
    setSelection(null);
  }, []);

  // One "put the chart back" gesture: a double-click that reset the zoom but
  // left a band painted across it would leave the picture half-cleared.
  const reset = useCallback((): void => {
    setXDomain(null);
    setYDomain(null);
    setSelection(null);
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
    const paint = { current: null as Paint | null };

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

      // Shift paints a range along X instead of panning. Needs the X axis to
      // mean something, so a chart with no x extent falls through to the pan.
      if (e.shiftKey && region.x && xe) {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        const view = latest.current.xDomain ?? xe;
        const originClientX = r.left + region.left;
        const anchor = valueAt(e.clientX, originClientX, region.width, view);
        paint.current = {
          pointerId: e.pointerId,
          anchor,
          originClientX,
          width: region.width,
          view,
        };
        setSelection({ min: anchor, max: anchor });
        setSelecting(true);
        return;
      }

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
    let pendingPaintX: number | null = null;

    const applyFrame = (): void => {
      frame = 0;
      applyPaint();
      applyPan();
    };

    const applyPaint = (): void => {
      const p = paint.current;
      const clientX = pendingPaintX;
      pendingPaintX = null;
      if (!p || clientX == null) return;
      const value = valueAt(clientX, p.originClientX, p.width, p.view);
      setSelection({ min: Math.min(p.anchor, value), max: Math.max(p.anchor, value) });
    };

    const applyPan = (): void => {
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
      const p = paint.current;
      if (p && e.pointerId === p.pointerId) {
        pendingPaintX = e.clientX;
        if (!frame) frame = requestAnimationFrame(applyFrame);
        return;
      }
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      pending = { dx: e.clientX - d.clientX, dy: e.clientY - d.clientY };
      if (!frame) frame = requestAnimationFrame(applyFrame);
    };

    const endDrag = (e: PointerEvent): void => {
      const p = paint.current;
      if (p && p.pointerId === e.pointerId) {
        if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
          applyPaint();
        }
        paint.current = null;
        setSelecting(false);
        // A shift-click, or a band too narrow to have been meant, dismisses the
        // one on screen instead of leaving a sliver behind.
        const value = valueAt(e.clientX, p.originClientX, p.width, p.view);
        const px = (Math.abs(value - p.anchor) / (p.view.max - p.view.min)) * p.width;
        if (!(px >= MIN_SELECTION_PX)) setSelection(null);
        return;
      }
      if (drag.current?.pointerId !== e.pointerId) return;
      // Land on the final position even if the last move hasn't painted yet.
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
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
    selection,
    selecting,
    clearSelection,
    reset,
  };
}
