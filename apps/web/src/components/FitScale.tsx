import { useLayoutEffect, useRef, useState } from 'react';

/** Below this width the layout flows and scrolls normally — no scaling. */
const FIT_QUERY = '(min-width: 1280px)';

/**
 * Uniformly scales the Overview so it fills the monitor as one piece, keeping its
 * "one screen" promise without distorting anything. Above the `xl` breakpoint it
 * measures the content's natural size at a fixed design width (`maxWidth`) and
 * applies a single `transform: scale()`:
 *
 *  - On a roomy/large monitor it *enlarges* the whole dashboard to fill the space
 *    (capped at `maxScale`, default 2×). Because the scale is uniform, text,
 *    cards and graphs all grow together — graphs are never stretched in just one
 *    direction. Once the cap is hit, any remaining space is left empty rather
 *    than over-stretching the layout.
 *  - On a short monitor it *shrinks* evenly down to `minScale`, falling back to
 *    scrolling rather than clipping if even that overflows.
 *
 * The scaled content is centred in the viewport, so leftover space splits evenly
 * around it — unless `fill` is set, which hands that slack to the content to
 * distribute itself. Below `xl` it's a transparent pass-through (capped at
 * `maxWidth`).
 *
 * `zoom` is the user's manual size preference (1 = the auto-fit above). It
 * multiplies the computed fit, so values below 1 shrink everything and values
 * above 1 enlarge it past one screen — at which point the content scrolls.
 */
export function FitScale({
  minScale = 0.7,
  maxScale = 2,
  maxWidth = 1580,
  zoom = 1,
  fill = false,
  children,
}: {
  minScale?: number;
  /** Cap on auto-enlargement for big monitors (1 = never enlarge). */
  maxScale?: number;
  /** The design width the dashboard is laid out at before scaling. */
  maxWidth?: number;
  zoom?: number;
  /**
   * Stretch the content to the full available height when the scaled layout
   * would leave vertical slack, instead of centring it with empty space above
   * and below. For content that knows what to do with the extra room — a
   * column with a `flex-grow` row that should absorb it.
   */
  fill?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  const outerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(() => window.matchMedia(FIT_QUERY).matches);
  const [scale, setScale] = useState(1);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [scroll, setScroll] = useState(false);

  // Scaling only applies to the locked one-screen layout at `xl` and up.
  useLayoutEffect(() => {
    const mq = window.matchMedia(FIT_QUERY);
    const onChange = (): void => setEnabled(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const content = contentRef.current;
    if (!enabled || !outer || !content) return;

    let raf = 0;
    const measure = (): void => {
      const availH = outer.clientHeight;
      const availW = outer.clientWidth;
      if (availH <= 0 || availW <= 0) return;
      // Lay the content out at its fixed design width (never wider than the
      // viewport) with no transform, so `scrollHeight` reports the true natural
      // height. Transforms don't affect `scrollHeight`, but width does, so we pin
      // the width while measuring; this read stays accurate while scaled. The
      // fill floor (below) is cleared first, or we'd just read back whatever we
      // handed the content last time. Both stay imperative: React skips style
      // properties whose value didn't change, which would leave these reset.
      const baseW = Math.min(availW, maxWidth);
      content.style.width = `${baseW}px`;
      content.style.minHeight = '';
      const naturalH = content.scrollHeight;
      if (naturalH <= 0) return;
      // Uniform "contain" fit: the largest scale that fits both axes, clamped to
      // [minScale, maxScale]. ≥1 enlarges to fill a big monitor (capped, so any
      // slack is left as empty space); <1 shrinks to keep one screen. The user's
      // zoom multiplies on top — pushing past one screen then scrolls.
      // Quantized down, not to nearest: rounding *up* lands the scaled layout a
      // fraction of a pixel past the locked viewport, which `overflow-hidden`
      // then shaves off the bottom edge. A thousandth of a scale step the other
      // way is invisible and always fits.
      const contain = Math.min(availW / baseW, availH / naturalH);
      const auto = Math.min(maxScale, Math.max(minScale, contain));
      const next = Math.floor(auto * zoom * 1000) / 1000;
      const visualW = baseW * next;
      // `fill`: give the leftover height back to the content rather than
      // centring it as empty margin. The content is laid out before the
      // transform, so it's handed the slack divided by the scale.
      //
      // `min-height`, not `height`: a floor the content can still grow past,
      // rather than a lid it overflows out of. Pinning the height froze this
      // element's box, which is the one the ResizeObserver below is watching —
      // so content that grew after the first measure (the brew panel's REG
      // toggle adds a target row and a slider to a pot card, ~150px) never
      // reached the scaler and spilled below the fold instead.
      const visualH = fill ? Math.max(naturalH * next, availH) : naturalH * next;
      if (fill && visualH > naturalH * next) content.style.minHeight = `${visualH / next}px`;
      setScale((prev) => (Math.abs(prev - next) < 0.002 ? prev : next));
      setBox((prev) =>
        prev && Math.abs(prev.w - visualW) < 0.5 && Math.abs(prev.h - visualH) < 0.5
          ? prev
          : { w: visualW, h: visualH },
      );
      setScroll(visualH > availH + 0.5);
    };

    const schedule = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(outer);
    ro.observe(content);
    // The floor `fill` puts under the content's height (above) is one-way for
    // the observer: it sees the box grow past the floor, never shrink back
    // below it, so a layout that stopped needing the room it was scaled down
    // for would stay small until the next window resize. Added and removed
    // nodes — how that room appears and disappears — read the same either way.
    const mo = fill ? new MutationObserver(schedule) : null;
    mo?.observe(content, { childList: true, subtree: true });
    measure();
    return () => {
      ro.disconnect();
      mo?.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [enabled, minScale, maxScale, maxWidth, zoom, fill]);

  if (!enabled) {
    return (
      <div className="w-full" style={{ maxWidth }}>
        {children}
      </div>
    );
  }

  // The pre-transform width that, scaled, lands back at the measured visual box.
  const baseW = box ? box.w / scale : undefined;
  const scaled = Math.abs(scale - 1) > 0.001;

  return (
    // overflow-x is always clipped: the centred sizer can never exceed the
    // viewport width by construction, but guards against sub-pixel rounding.
    <div
      ref={outerRef}
      className={`flex h-full justify-center overflow-x-hidden ${
        scroll ? 'items-start overflow-y-auto' : 'items-center overflow-y-hidden'
      }`}
    >
      {/* Reserves the scaled footprint so flexbox can centre it; the transformed
          content fills it exactly (baseW·scale × naturalH·scale). */}
      <div style={box ? { width: box.w, height: box.h } : undefined}>
        <div
          ref={contentRef}
          className="flex min-h-0 flex-col"
          style={{
            width: baseW,
            transform: scaled ? `scale(${scale})` : undefined,
            transformOrigin: 'top left',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

