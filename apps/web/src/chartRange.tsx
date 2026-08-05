import { createContext, useCallback, useContext, useMemo, useState } from 'react';

/**
 * Remembers the selected history window (1h / 6h / 24h / 7d / 30d) per device+metric,
 * so the enlarge-on-click chart overlay and the matching dashboard sparkline
 * preview stay in sync: changing the range in an opened graph re-windows just
 * that metric's small preview. Lives in context (rather than prop-drilling)
 * because the overlay and the previews sit far apart in the dashboard tree.
 *
 * Outside a provider (e.g. the full device page) every hook degrades to the
 * default window and the chart falls back to its own local range state.
 */

/** Default history window when a metric has no remembered range yet (24h). */
export const DEFAULT_RANGE_MS = 24 * 60 * 60 * 1000;

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

export function ChartRangeProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [ranges, setRanges] = useState<Record<string, number>>({});

  const getRange = useCallback(
    (deviceId: number | null, metric: string | null): number =>
      ranges[rangeKey(deviceId, metric)] ?? DEFAULT_RANGE_MS,
    [ranges],
  );

  const setRange = useCallback(
    (deviceId: number | null, metric: string | null, ms: number): void =>
      setRanges((prev) => ({ ...prev, [rangeKey(deviceId, metric)]: ms })),
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
