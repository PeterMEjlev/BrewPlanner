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

  return { device, metric, setMetric, rangeMs, setRangeMs, chartData, latest, longRange, error };
}

/** Axis tick: time-of-day for short ranges, date for multi-day ranges. */
export function formatTick(t: number, longRange: boolean): string {
  const d = new Date(t);
  return longRange
    ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
