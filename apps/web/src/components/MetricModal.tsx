import { Suspense, lazy, useEffect } from 'react';
import { Link } from 'react-router-dom';

// recharts lives behind this lazy boundary, so opening a chart is the only thing
// that pulls it onto the Overview — the dashboard bundle itself stays lean.
const MetricChart = lazy(() => import('./MetricChart'));

/**
 * An enlarge-on-click overlay: the selected metric's chart floats in a card over
 * a dimmed dashboard, instead of navigating to the full device page. Closes on
 * backdrop click or Escape.
 */
export function MetricModal({
  deviceId,
  metric,
  title,
  onClose,
}: {
  deviceId: number;
  metric?: string;
  title: string;
  onClose: () => void;
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

  const fullPageHref = metric
    ? `/devices/${deviceId}?metric=${encodeURIComponent(metric)}`
    : `/devices/${deviceId}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`${title} chart`}
    >
      {/* Backdrop dims the whole dashboard, sidebar included. */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm"
      />

      <div className="relative z-10 max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/50">
        <div className="sticky top-0 flex items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/95 px-5 py-3.5 backdrop-blur">
          <h2 className="truncate text-base font-semibold tracking-tight text-zinc-50">{title}</h2>
          <div className="flex items-center gap-1">
            <Link
              to={fullPageHref}
              className="rounded-lg px-2.5 py-1.5 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
            >
              Full page ↗
            </Link>
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

        <div className="p-5">
          <Suspense
            fallback={<p className="py-24 text-center text-sm text-zinc-500">Loading chart…</p>}
          >
            <MetricChart deviceId={deviceId} initialMetric={metric} chartHeight={300} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
