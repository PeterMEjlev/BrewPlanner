import { useLayoutEffect, useRef, useState } from 'react';

/** Below this width the layout flows and scrolls normally — no scaling. */
const FIT_QUERY = '(min-width: 1280px)';

/**
 * Uniformly scales its content down so the Overview keeps its "one screen"
 * promise on shorter monitors. Above the `xl` breakpoint (where the dashboard
 * locks to a single viewport height) it measures the content's natural height
 * against the space it's been given: when the content is too tall it applies a
 * `transform: scale()`, shrinking everything evenly down to `minScale`. The
 * content is stretched to fill the height first, so on roomy screens nothing
 * changes (scale stays 1 and flex children grow exactly as before). If even
 * `minScale` still overflows, it falls back to scrolling rather than clipping.
 * Below `xl` it's a transparent pass-through.
 *
 * `className` styles the (unscaled) visual box — put width/centering caps there;
 * the child is expected to be a flex item that fills the column (`xl:flex-1`).
 */
export function FitScale({
  minScale = 0.7,
  className,
  children,
}: {
  minScale?: number;
  className?: string;
  children: React.ReactNode;
}): JSX.Element {
  const outerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(() => window.matchMedia(FIT_QUERY).matches);
  const [scale, setScale] = useState(1);
  const [sizerHeight, setSizerHeight] = useState<number | null>(null);
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
      const avail = outer.clientHeight;
      if (avail <= 0) return;
      // Stretch to fill the available height before measuring, so flex children
      // grow to fill roomy screens; `scrollHeight` then reports the true natural
      // height when (and only when) the content is genuinely taller than `avail`.
      // Transforms don't affect `scrollHeight`, so this read stays accurate while
      // scaled.
      content.style.minHeight = `${avail}px`;
      const natural = content.scrollHeight;
      const next = Math.round(Math.min(1, Math.max(minScale, avail / natural)) * 1000) / 1000;
      const visual = natural * next;
      setScale((prev) => (Math.abs(prev - next) < 0.002 ? prev : next));
      setSizerHeight((prev) => (prev != null && Math.abs(prev - visual) < 0.5 ? prev : visual));
      setScroll(visual > avail + 0.5);
    };

    const schedule = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(outer);
    ro.observe(content);
    measure();
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [enabled, minScale]);

  if (!enabled) {
    return <div className={className}>{children}</div>;
  }

  return (
    // overflow-x is always clipped: when scaled, the content's pre-transform box
    // is wider than the viewport (it's drawn at 100/scale% then shrunk back), and
    // that invisible excess must not spawn a horizontal scrollbar.
    <div
      ref={outerRef}
      className={`h-full overflow-x-hidden ${scroll ? 'overflow-y-auto' : 'overflow-y-hidden'}`}
    >
      <div className={className} style={{ height: sizerHeight ?? undefined }}>
        <div
          ref={contentRef}
          className="flex min-h-0 flex-col"
          style={
            scale < 1
              ? { transform: `scale(${scale})`, transformOrigin: 'top left', width: `${100 / scale}%` }
              : undefined
          }
        >
          {children}
        </div>
      </div>
    </div>
  );
}
