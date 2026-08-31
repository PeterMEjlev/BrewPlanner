import type { CSSProperties } from 'react';
import type { PlotInset, Span } from './chartZoom';

/**
 * What a shift-dragged range on a chart says about the data underneath it: the
 * period itself, and each trace's min, max and mean across it. The gesture that
 * paints the range lives in chartZoom.ts; this is the arithmetic and the card.
 *
 * Shared by every enlarged chart — the device metric chart, the Brew System
 * panel and a brew session's rig curve — so "what did the fridge do between
 * these two moments" is answered the same way and reads the same everywhere.
 */

/** A trace to summarise: which column it lives in, and how it is drawn. */
export interface SelectionSeries {
  key: string;
  label: string;
  color: string;
}

/** One trace's numbers over the selected period. */
export interface SelectionSeriesStats extends SelectionSeries {
  min: number;
  max: number;
  avg: number;
  /** Samples inside the band — a period the sensor slept through has none. */
  count: number;
}

/**
 * Min, max and mean per trace over `range`.
 *
 * Fed the full-resolution rows rather than the thinned ones the chart plots:
 * the drawn curve is bucket-averaged at this zoom, and a summary that quoted its
 * maximum would under-report the peak the brewer is measuring.
 */
export function selectionStats<T>(
  rows: readonly T[],
  range: Span,
  at: (row: T) => number,
  series: readonly SelectionSeries[],
  valueOf: (row: T, key: string) => number | null | undefined,
): SelectionSeriesStats[] {
  const acc = series.map((s) => ({
    ...s,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
    sum: 0,
    count: 0,
  }));
  for (const row of rows) {
    const t = at(row);
    if (t < range.min || t > range.max) continue;
    for (const s of acc) {
      const value = valueOf(row, s.key);
      if (value == null || !Number.isFinite(value)) continue;
      if (value < s.min) s.min = value;
      if (value > s.max) s.max = value;
      s.sum += value;
      s.count += 1;
    }
  }
  return acc
    .filter((s) => s.count > 0)
    .map(({ sum, ...s }) => ({ ...s, avg: sum / s.count }));
}

/**
 * How the band itself is drawn. Spread onto a recharts `<ReferenceArea>`, which
 * has to be a direct child of the chart — so this is shared as props rather than
 * as a component of our own.
 *
 * Sky rather than one of the palettes in play: BK is red, MLT green, HLT blue,
 * and a selection that borrowed any trace's colour would read as a fourth
 * measurement. `hidden` keeps a band that runs past the edge of a zoomed view
 * clipped to the plot instead of vanishing entirely.
 */
export const SELECTION_AREA = {
  fill: '#38bdf8',
  fillOpacity: 0.14,
  stroke: '#38bdf8',
  strokeOpacity: 0.6,
  strokeWidth: 1,
  ifOverflow: 'hidden',
  isFront: false,
} as const;

/** A duration in the largest two units that suit it: 2d 4h, 1h 28m, 45m, 30s. */
export function formatSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest > 0 ? `${days}d ${rest}h` : `${days}d`;
}

/**
 * The readout for a painted range, floating over the plot.
 *
 * Placed in whichever top corner the band is *not* in, rather than following the
 * band around: a card that tracked the selection would jitter while it is being
 * painted and would sit over the very data being measured. Click-through except
 * for its dismiss button, so the chart underneath keeps every gesture.
 */
export function SelectionSummary({
  range,
  view,
  inset,
  stats,
  formatValue,
  formatTime,
  onClear,
}: {
  range: Span;
  /** The x window on screen, so the card can pick the free corner. */
  view: Span | null;
  inset: PlotInset;
  stats: SelectionSeriesStats[];
  /**
   * Given the trace as well as the number, so a card summarising overlaid
   * metrics can put each row in its own unit rather than all of them in one.
   */
  formatValue: (value: number, series: SelectionSeriesStats) => string;
  formatTime: (t: number) => string;
  onClear: () => void;
}): JSX.Element {
  const centre = (range.min + range.max) / 2;
  const middle = view ? (view.min + view.max) / 2 : centre;
  const onLeft = centre >= middle;
  const style: CSSProperties = onLeft
    ? { top: inset.top + 8, left: inset.left + 8 }
    : { top: inset.top + 8, right: inset.right + 8 };

  return (
    <div
      className="pointer-events-none absolute z-10 max-w-[min(22rem,80%)] rounded-lg border border-sky-500/30 bg-zinc-950/95 px-3 py-2 shadow-lg shadow-black/50 backdrop-blur"
      style={style}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium tabular-nums text-zinc-200">
            {formatTime(range.min)} → {formatTime(range.max)}
          </div>
          <div className="text-[11px] text-zinc-500">{formatSpan(range.max - range.min)}</div>
        </div>
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear selection"
          className="pointer-events-auto -mr-1 -mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
        >
          ✕
        </button>
      </div>
      {stats.length === 0 ? (
        <p className="mt-1.5 text-[11px] text-zinc-500">Nothing logged in this period.</p>
      ) : (
        <div className="mt-1.5 space-y-1">
          {stats.map((s) => (
            <div key={s.key} className="flex items-baseline gap-2 text-[11px] tabular-nums">
              <span
                className="h-2 w-2 shrink-0 self-center rounded-full"
                style={{ backgroundColor: s.color }}
                aria-hidden
              />
              <span className="shrink-0 truncate font-medium text-zinc-400">{s.label}</span>
              <span className="text-zinc-300">
                {formatValue(s.min, s)} – {formatValue(s.max, s)}
              </span>
              <span className="ml-auto shrink-0 text-zinc-400">avg {formatValue(s.avg, s)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
