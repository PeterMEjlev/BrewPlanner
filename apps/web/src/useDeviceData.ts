import type { DeviceStatus, LatestReading, Reading } from '@checklist/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';

const POLL_MS = 10000;

/** Selectable history windows, shared by the laptop and touch sensor views. */
export const RANGES = [
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '6h', ms: 6 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
] as const;

const DEFAULT_RANGE_MS = RANGES[2].ms; // 24h

export interface DeviceDataState {
  device: DeviceStatus | null;
  metric: string | null;
  setMetric: (m: string) => void;
  rangeMs: number;
  setRangeMs: (ms: number) => void;
  /** Chart points, oldest→newest with numeric timestamps for the time axis. */
  chartData: { t: number; value: number }[];
  /** Latest reading for the selected metric (falls back to the first metric). */
  latest: LatestReading | undefined;
  /** True for multi-day ranges, so axis ticks show dates instead of times. */
  longRange: boolean;
  /** Force an immediate device-status refetch (e.g. after changing a setpoint). */
  refresh: () => void;
  error: string | null;
}

/**
 * Loads a device's live status and metric history, polling both. Shared so the
 * laptop ([Device]) and touch ([KioskDevice]) views stay in sync without
 * duplicating the fetch/poll logic. Pass `lockedMetric` to pin the view to a
 * single metric (e.g. the gravity page ignores the Tilt's beer temp).
 */
export function useDeviceData(deviceId: number, lockedMetric?: string): DeviceDataState {
  const [device, setDevice] = useState<DeviceStatus | null>(null);
  const [metric, setMetric] = useState<string | null>(lockedMetric ?? null);
  const [rangeMs, setRangeMs] = useState<number>(DEFAULT_RANGE_MS);
  const [history, setHistory] = useState<Reading[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadDevice = useCallback(async () => {
    try {
      const d = await api.getDevice(deviceId);
      setDevice(d);
      setMetric((cur) => cur ?? d.latest[0]?.metric ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load device');
    }
  }, [deviceId]);

  const loadHistory = useCallback(async () => {
    if (!metric) return;
    try {
      const since = new Date(Date.now() - rangeMs).toISOString();
      setHistory(await api.getDeviceHistory(deviceId, { metric, since, limit: 5000 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load history');
    }
  }, [deviceId, metric, rangeMs]);

  useEffect(() => {
    void loadDevice();
    const t = setInterval(() => void loadDevice(), POLL_MS);
    return () => clearInterval(t);
  }, [loadDevice]);

  useEffect(() => {
    void loadHistory();
    const t = setInterval(() => void loadHistory(), POLL_MS);
    return () => clearInterval(t);
  }, [loadHistory]);

  const chartData = useMemo(
    () => [...history].reverse().map((r) => ({ t: Date.parse(r.recordedAt), value: r.value })),
    [history],
  );

  const latest = device?.latest.find((r) => r.metric === metric) ?? device?.latest[0];
  const longRange = rangeMs > 24 * 60 * 60 * 1000;

  return {
    device,
    metric,
    setMetric,
    rangeMs,
    setRangeMs,
    chartData,
    latest,
    longRange,
    refresh: loadDevice,
    error,
  };
}

/** How often the lightweight Overview sparklines refetch their short history. */
const SERIES_POLL_MS = 60_000;

/**
 * A bare metric history as a list of values (oldest→newest), for the Overview's
 * inline sparklines. Lighter than {@link useDeviceData}: no metric/range state,
 * a small point cap, and a slow poll. Pass `null` to disable (returns []) and
 * keep the last series through a transient fetch error.
 */
export function useMetricSeries(
  deviceId: number | null,
  metric: string,
  rangeMs = 24 * 60 * 60 * 1000,
): number[] {
  const [series, setSeries] = useState<number[]>([]);

  useEffect(() => {
    if (deviceId == null) {
      setSeries([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const since = new Date(Date.now() - rangeMs).toISOString();
        const history = await api.getDeviceHistory(deviceId, { metric, since, limit: 200 });
        if (!cancelled) setSeries([...history].reverse().map((r) => r.value));
      } catch {
        // Keep the last known series through a transient history failure.
      }
    };
    void load();
    const t = setInterval(() => void load(), SERIES_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [deviceId, metric, rangeMs]);

  return series;
}

/** Cumulative meter metrics whose lifetime total ("all-time consumption") we surface. */
const CUMULATIVE_METRICS = new Set(['energy_kwh', 'water_l']);

/**
 * The device's cumulative metric (energy/water), if it reports one — the metric
 * whose all-time total is worth showing on its page. Returns undefined for
 * devices without one (pressure, temperature, gravity, …).
 */
export function cumulativeMetricOf(device: DeviceStatus | null): string | undefined {
  return device?.latest.find((r) => CUMULATIVE_METRICS.has(r.metric))?.metric;
}

/** Lifetime totals barely move — refresh them far less often than live readings. */
const TOTAL_POLL_MS = 60_000;

/**
 * Fetch a device's all-time total for one cumulative metric, polled slowly. Pass
 * `undefined` (a device with no cumulative metric) to disable; returns null until
 * the first value lands and keeps the last value through a transient error.
 */
export function useDeviceTotal(deviceId: number, metric: string | undefined): number | null {
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => {
    if (!metric) {
      setTotal(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.getDeviceTotal(deviceId, metric);
        if (!cancelled) setTotal(res.total);
      } catch {
        // Keep the last known total on a transient fetch error.
      }
    };
    void load();
    const t = setInterval(() => void load(), TOTAL_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [deviceId, metric]);

  return total;
}

/** Axis tick: time-of-day for short ranges, date for multi-day ranges. */
export function formatTick(t: number, longRange: boolean): string {
  const d = new Date(t);
  return longRange
    ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
