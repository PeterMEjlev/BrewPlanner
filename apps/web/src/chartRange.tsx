import { createContext, useCallback, useContext, useMemo, useState } from 'react';

/**
 * Remembers the selected history window (1h / 6h / 24h / 7d / 30d) per device+metric,
 * so the enlarge-on-click chart overlay and the matching dashboard sparkline
 * preview stay in sync: changing the range in an opened graph re-windows just
 * that metric's small preview. Lives in context (rather than prop-drilling)
 * because the overlay and the previews sit far apart in the dashboard tree.
 * Persisted to localStorage so the last-picked range survives a page reload.
 *
 * Outside a provider (e.g. the full device page) every hook degrades to the
 * default window and the chart falls back to its own local range state.
 */

/** Default history window when a metric has no remembered range yet (24h). */
export const DEFAULT_RANGE_MS = 24 * 60 * 60 * 1000;

/** localStorage key for the last-picked range per device+metric (see [[rangeKey]]). */
const STORAGE_KEY = 'chartRanges';

export interface ChartRangeStore {
  /** The remembered window for a device+metric, or the default. */
  getRange: (deviceId: number | null, metric: string | null) => number;
  /** Remember a window for a device+metric. */
  setRange: (deviceId: number | null, metric: string | null, ms: number) => void;
}

const ChartRangeContext = createContext<ChartRangeStore | null>(null);

function rangeKey(deviceId: number | null, metric: string | null): string {
  return `${deviceId ?? '?'}:${metric ?? '?'}`;
}

function loadRanges(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function saveRanges(ranges: Record<string, number>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ranges));
  } catch {
    // A range that resets to the default on reload is not worth failing the page over.
  }
}

export function ChartRangeProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [ranges, setRanges] = useState<Record<string, number>>(loadRanges);

  const getRange = useCallback(
    (deviceId: number | null, metric: string | null): number =>
      ranges[rangeKey(deviceId, metric)] ?? DEFAULT_RANGE_MS,
    [ranges],
  );

  const setRange = useCallback(
    (deviceId: number | null, metric: string | null, ms: number): void =>
      setRanges((prev) => {
        const next = { ...prev, [rangeKey(deviceId, metric)]: ms };
        saveRanges(next);
        return next;
      }),
    [],
  );

  const store = useMemo<ChartRangeStore>(() => ({ getRange, setRange }), [getRange, setRange]);
  return <ChartRangeContext.Provider value={store}>{children}</ChartRangeContext.Provider>;
}

/** The range store, or null outside a provider (callers then keep local state). */
export function useChartRangeStore(): ChartRangeStore | null {
  return useContext(ChartRangeContext);
}

/** The remembered window for one device+metric (default when no provider). */
export function useChartRange(deviceId: number | null, metric: string | null): number {
  const store = useContext(ChartRangeContext);
  return store ? store.getRange(deviceId, metric) : DEFAULT_RANGE_MS;
}
