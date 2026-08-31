import { useEffect } from 'react';

/**
 * The enlarge-on-click chart shell: a chart floating in a card over a dimmed
 * page, closing on backdrop click or Escape.
 *
 * Shared so that every enlarged chart in the app is the same object — the
 * Overview's device metrics ([MetricModal]) and a brew session's rig curve open
 * the same way, into the same card, and close by the same two gestures.
 */
export function ChartOverlay({
  title,
  action,
  wide,
  onClose,
  children,
}: {
  title: string;
  /** Header control beside the close button — the metric overlay's "Full page" link. */
  action?: React.ReactNode;
  /** For a chart that is worth more width than height: hours of brew day, say. */
  wide?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`${title} chart`}
    >
      {/* Backdrop dims the whole page, sidebar included. */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm"
      />

      <div
        className={`relative z-10 max-h-[90vh] w-full ${
          wide ? 'max-w-6xl' : 'max-w-3xl'
        } overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/50`}
      >
        <div className="sticky top-0 flex items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/95 px-5 py-3.5 backdrop-blur">
          <h2 className="truncate text-base font-semibold tracking-tight text-zinc-50">{title}</h2>
          <div className="flex items-center gap-1">
            {action}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close chart"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-lg text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
