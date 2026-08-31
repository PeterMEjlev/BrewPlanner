import type {
  DeviceStatus,
  HostStatus,
  LatestReading,
  Reading,
  SetpointChange,
} from '@checklist/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { SHARED, type SharedState, useShared } from './sharedPoll';
import { usePoll } from './usePoll';

/** Poll cadence before a device's own logging interval is known (first fetch). */
const DEFAULT_POLL_MS = 10000;

/**
 * Poll cadence (ms) for a batched device list (Overview / Devices): the fastest
 * device's configured logging interval, so the chattiest sensor stays fresh
 * without over-polling the rest. Falls back to the default before any device
 * (which carries its interval) has loaded.
 */
export function listPollMs(
  devices: { reportingIntervalSec: number }[] | null | undefined,
): number {
  const secs = (devices ?? []).map((d) => d.reportingIntervalSec).filter((n) => n > 0);
  return secs.length ? Math.min(...secs) * 1000 : DEFAULT_POLL_MS;
}

/**
 * The device fleet, from the channel every fleet view shares (Overview, Devices,
 * the kiosk home, and the sidebar's device badge — see sharedPoll.ts). One
 * request feeds all of them instead of one per mounted component.
 *
 * The cadence is the fleet's own: {@link listPollMs} over the devices we last
 * saw, fed back as the subscription rate. It settles after the first load — the
 * default rate fetches once, and the fleet's real fastest interval takes over
 * from there.
 */
export function useFleet(): SharedState<DeviceStatus[]> & { refresh: () => Promise<void> } {
  const [pollMs, setPollMs] = useState(DEFAULT_POLL_MS);
  const fleet = useShared(SHARED.devices, api.listDevices, pollMs);
  useEffect(() => {
    setPollMs(listPollMs(fleet.data));
  }, [fleet.data]);
  return fleet;
}

/**
 * Cadence for the host vitals (the two Pis). Matches the server's own cache
 * window: asking faster only re-serves the same snapshot, and the reading it
 * carries — temperature, uptime, disk — moves far more slowly than a sensor's.
 */
const HOSTS_POLL_MS = 20_000;

/**
 * The Raspberry Pis the brewery runs on, for the Devices page. A shared channel
 * like {@link useFleet}, so a second view of it costs no extra requests.
 */
export function useHosts(): SharedState<HostStatus[]> & { refresh: () => Promise<void> } {
  return useShared(SHARED.hosts, api.listHosts, HOSTS_POLL_MS);
}

/** Selectable history windows, shared by the laptop and touch sensor views. */
export const RANGES = [
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '6h', ms: 6 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  // A month, which is about a whole ferment-and-condition cycle. Comfortably
  // inside the server's 90-day retention (READINGS_RETENTION_DAYS), so the
  // window is real data rather than a stub that runs out partway back.
  { label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
] as const;

const DEFAULT_RANGE_MS = RANGES[2].ms; // 24h

/** Row cap on a raw history fetch — the ceiling `historyQuerySchema` allows. */
const HISTORY_LIMIT = 5000;

/**
 * Widest window a full-size chart reads as raw rows.
 *
 * A raw fetch is capped at {@link HISTORY_LIMIT} and the API answers newest
 * first, so a window holding more readings than that quietly comes back as only
 * its most recent slice — a 7-day request at the default 30s cadence is the
 * newest day and a half, drawn as if it were the week. Past this the window is
 * averaged server-side instead, which covers all of it at a resolution we pick
 * (see `buckets` on historyQuerySchema).
 *
 * 24h is the widest window that stays raw at every selectable cadence: 2880
 * readings at the fastest 30s, well inside the cap.
 */
const RAW_HISTORY_MS = 24 * 60 * 60 * 1000;

/**
 * Points a bucketed window is averaged into — ~13 minutes each across 7 days,
 * ~54 across 30. Chosen against what the chart can draw rather than what the
 * axis could hold: it thins to MAX_PLOT_POINTS (see MetricChart) before plotting
 * anyway, and a month of fermentation has no feature that a sub-hour bucket
 * would resolve and an hour-wide one would miss.
 */
const HISTORY_BUCKETS = 800;

/**
 * The history query for a window: raw rows when they all fit, a server-side
 * average when they don't. Exported so every full-size chart windows alike.
 */
export function historyWindowQuery(rangeMs: number): { limit: number; buckets?: number } {
  return rangeMs > RAW_HISTORY_MS
    ? { limit: HISTORY_LIMIT, buckets: HISTORY_BUCKETS }
    : { limit: HISTORY_LIMIT };
}

/** A chart point: epoch milliseconds and the reading at it. */
export interface TimePoint {
  t: number;
  value: number;
}

export interface DeviceDataState {
  device: DeviceStatus | null;
  /**
   * The primary metric — the head of {@link metrics}. It owns the big value, the
   * left axis and the zoom; the rest are overlaid on it.
   */
  metric: string | null;
  /** Collapse the selection to this metric alone. */
  setMetric: (m: string) => void;
  /** Every metric currently loaded, primary first. */
  metrics: string[];
  /**
   * Draw one more metric alongside the others, or stop drawing it. The last
   * remaining metric can't be removed — a chart has to plot something.
   */
  toggleMetric: (m: string) => void;
  /** Chart points per loaded metric, oldest→newest. */
  series: Record<string, TimePoint[]>;
  rangeMs: number;
  setRangeMs: (ms: number) => void;
  /** Chart points for the primary metric — `series[metric]`, for the many
   * callers that only ever draw one. */
  chartData: TimePoint[];
  /** Latest reading for the selected metric (falls back to the first metric). */
  latest: LatestReading | undefined;
  /** Force an immediate device-status refetch (e.g. after changing a setpoint). */
  refresh: () => void;
  error: string | null;
}

/**
 * Lets a caller drive the range from outside the hook (keyed by the hook's
 * active metric), so an opened chart and the matching dashboard preview share
 * one remembered window. Omit it to keep the range as local hook state.
 */
export interface RangeControl {
  get: (metric: string | null) => number;
  set: (metric: string | null, ms: number) => void;
}

/**
 * Loads a device's live status and metric history, polling both. Shared so the
 * laptop ([Device]) and touch ([KioskDevice]) views stay in sync without
 * duplicating the fetch/poll logic. Pass `lockedMetric` to pin the view to a
 * single metric (e.g. the gravity page ignores the Tilt's beer temp), and
 * `rangeControl` to hoist the selected window into shared state.
 */
export function useDeviceData(
  deviceId: number,
  lockedMetric?: string,
  rangeControl?: RangeControl,
): DeviceDataState {
  const [device, setDevice] = useState<DeviceStatus | null>(null);
  // The drawn set, primary first. One entry is the ordinary case; a second joins
  // it when the brewer overlays another metric on the same chart.
  const [selected, setSelected] = useState<string[]>(lockedMetric ? [lockedMetric] : []);
  const [internalRangeMs, setInternalRangeMs] = useState<number>(DEFAULT_RANGE_MS);
  const [history, setHistory] = useState<Record<string, Reading[]>>({});
  const [error, setError] = useState<string | null>(null);
  // Where the last successful history fetch got to, per metric, so the next one
  // can ask for the tail instead of the whole window. `key` pins each entry to
  // the series it was read for — a different device/metric/range invalidates it;
  // `anchor` is the newest reading held; `appendable` goes false for a series
  // that turned out not to support tailing at all. See loadHistory.
  const cursors = useRef<Map<string, { key: string; anchor: Reading | null; appendable: boolean }>>(
    new Map(),
  );

  const metric = selected[0] ?? null;

  const setMetric = useCallback((m: string): void => {
    setSelected([m]);
  }, []);

  const toggleMetric = useCallback((m: string): void => {
    setSelected((cur) =>
      cur.includes(m) ? (cur.length > 1 ? cur.filter((x) => x !== m) : cur) : [...cur, m],
    );
  }, []);

  const rangeMs = rangeControl ? rangeControl.get(metric) : internalRangeMs;
  const setRangeMs = useCallback(
    (ms: number): void => {
      if (rangeControl) rangeControl.set(metric, ms);
      else setInternalRangeMs(ms);
    },
    [rangeControl, metric],
  );

  const loadDevice = useCallback(async () => {
    try {
      const d = await api.getDevice(deviceId);
      setDevice(d);
      setSelected((cur) => {
        if (cur.length > 0) return cur;
        const first = d.latest[0]?.metric;
        return first ? [first] : cur;
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load device');
    }
  }, [deviceId]);

  /**
   * Refresh the chart series. Only the first fetch of a series pulls the whole
   * window (up to 5000 rows, ~500 KB); after that it asks for `since` = the
   * newest point already held, which on a 5 s tick is a handful of rows —
   * hundreds of bytes over the tunnel instead of hundreds of kilobytes. The
   * window still slides: points that have aged past its start are dropped
   * locally, so nothing grows without bound.
   *
   * Tailing is verified, not assumed. `since` is inclusive server-side, so a
   * real series always hands the anchor reading straight back; when it doesn't,
   * the response isn't something we can append to — the synthesized history a
   * mock sensor serves is regenerated per request, ids and all — and we fall
   * back to reading the whole window, for this fetch and every later one on the
   * same series. Any failure drops the anchor, so the next tick re-reads the
   * window rather than building on a series with a hole in it.
   */
  const loadHistory = useCallback(async (isStale: () => boolean) => {
    if (selected.length === 0) return;
    const windowStartMs = Date.now() - rangeMs;
    // A window too wide to fetch raw comes back averaged (see
    // historyWindowQuery), and an average has nothing to append to: every poll
    // re-buckets the whole window, so its trailing point moves rather than a new
    // one arriving after it. Those windows always re-read in full.
    const windowQuery = historyWindowQuery(rangeMs);
    const bucketed = windowQuery.buckets != null;

    // One metric's slice of the poll. Each keeps its own cursor, so adding a
    // second metric to a chart re-reads only the newcomer's window — the one
    // already drawn keeps tailing.
    const loadOne = async (m: string): Promise<{ metric: string; page: Reading[]; append: boolean }> => {
      const key = `${deviceId}:${m}:${rangeMs}`;
      const held = cursors.current.get(m);
      const { anchor, appendable } =
        held && held.key === key ? held : { anchor: null, appendable: true };
      // An anchor that has aged out of the window has nothing left to append to.
      const tailing =
        !bucketed && appendable && anchor != null && Date.parse(anchor.recordedAt) >= windowStartMs;

      const fetchSince = (sinceMs: number): Promise<Reading[]> =>
        api.getDeviceHistory(deviceId, {
          metric: m,
          since: new Date(sinceMs).toISOString(),
          ...windowQuery,
        });

      let page = await fetchSince(tailing ? Date.parse(anchor!.recordedAt) : windowStartMs);
      let append = false;
      let stillAppendable = appendable;
      if (tailing) {
        append = page.some((r) => r.id === anchor!.id && r.recordedAt === anchor!.recordedAt);
        if (!append) {
          stillAppendable = false;
          page = await fetchSince(windowStartMs);
        }
      }
      // The API answers newest-first, so page[0] is the new high-water mark —
      // except on a bucketed window, where it's an average that will be
      // recomputed next poll and so is no anchor at all.
      cursors.current.set(m, {
        key,
        anchor: bucketed ? null : page[0] ?? null,
        appendable: stillAppendable,
      });
      return { metric: m, page, append };
    };

    try {
      const loaded = await Promise.all(selected.map(loadOne));
      if (isStale()) return;
      setHistory((prev) => {
        // Rebuilt from the drawn set rather than merged into it, so a metric the
        // brewer switched off stops being held in memory.
        const next: Record<string, Reading[]> = {};
        for (const { metric: m, page, append } of loaded) {
          const kept = append ? prev[m] ?? [] : [];
          const seen = new Set(kept.map((r) => r.id));
          const fresh = page.filter((r) => !seen.has(r.id));
          const merged = fresh.length ? [...fresh, ...kept] : kept;
          next[m] = merged.filter((r) => Date.parse(r.recordedAt) >= windowStartMs);
        }
        return next;
      });
    } catch (e) {
      // Drop every anchor: one failed leg leaves the whole poll unapplied, and
      // building on a series with a hole in it is worse than re-reading it.
      for (const m of selected) {
        const held = cursors.current.get(m);
        cursors.current.set(m, {
          key: `${deviceId}:${m}:${rangeMs}`,
          anchor: null,
          appendable: held?.appendable ?? true,
        });
      }
      setError(e instanceof Error ? e.message : 'Failed to load history');
    }
  }, [deviceId, selected, rangeMs]);

  // Poll this device at its own configured logging cadence — no point refetching
  // faster than the agent logs. Falls back to a default until the first status
  // (which carries the interval) lands.
  const pollMs = (device?.reportingIntervalSec ?? 0) > 0
    ? device!.reportingIntervalSec * 1000
    : DEFAULT_POLL_MS;

  // A bucketed window is re-read whole every time and its points are tens of
  // minutes wide, so the device's own cadence would re-download the month every
  // 30s to redraw the same curve. Slow it to the rate the previews poll at —
  // still faster than a bucket can visibly move.
  const historyPollMs =
    historyWindowQuery(rangeMs).buckets != null ? Math.max(pollMs, SERIES_POLL_MS) : pollMs;

  usePoll(loadDevice, pollMs, [loadDevice]);
  usePoll(loadHistory, historyPollMs, [loadHistory]);

  const series = useMemo(() => {
    const out: Record<string, TimePoint[]> = {};
    for (const [m, rows] of Object.entries(history)) {
      out[m] = [...rows].reverse().map((r) => ({ t: Date.parse(r.recordedAt), value: r.value }));
    }
    return out;
  }, [history]);

  const chartData = useMemo(() => (metric ? series[metric] ?? NO_POINTS : NO_POINTS), [
    series,
    metric,
  ]);

  const latest = device?.latest.find((r) => r.metric === metric) ?? device?.latest[0];

  return {
    device,
    metric,
    setMetric,
    metrics: selected,
    toggleMetric,
    series,
    rangeMs,
    setRangeMs,
    chartData,
    latest,
    refresh: loadDevice,
    error,
  };
}

/** Shared empty series, so a metric with no rows yet keeps a stable identity. */
const NO_POINTS: TimePoint[] = [];

/** How often the lightweight Overview sparklines refetch their short history. */
const SERIES_POLL_MS = 60_000;

/**
 * Points a preview sparkline asks the server to average its window down to.
 *
 * The number that matters here isn't the point count, it's the bucket width it
 * implies — 100 buckets is ~14 minutes at the 24h range. A fridge held by a
 * hysteresis controller cycles ±0.5 °C as its compressor kicks in and out, and
 * averaging only cancels that when a bucket spans a couple of full cycles;
 * buckets around the cycle length alias instead and leave a beat that looks just
 * as unsettled as the raw trace. Measured over a simulated day of 30s readings
 * with a 1.2 °C cycle: ~14-minute buckets leave 0.07 °C of it, ~7-minute buckets
 * leave anywhere from 0.17 °C to the whole 1.2 °C depending on how the period
 * happens to line up. A genuine drift is far slower than any of this and comes
 * through untouched.
 *
 * 100 points across a preview a few hundred px wide is still ~3px apart, which
 * is more resolution than a sparkline can show anyway. And it scales the right
 * way on its own: at the 1h range the same count buys 36s buckets, about the
 * logging cadence, so a short window is essentially the raw trace — zooming in
 * to watch the controller work is exactly when you want to see it cycling.
 */
const SERIES_BUCKETS = 100;

/**
 * Buckets for {@link useMetricSeriesT}. Many more than {@link SERIES_BUCKETS}
 * because it covers a fortnight rather than a day — 600 lands in the same
 * half-hour neighbourhood per bucket — and because this series is fitted, not
 * just drawn: the gravity decay curve reads the shape of the whole window, and
 * averaging is only ever a help to a fit.
 */
const SERIES_T_BUCKETS = 600;

/**
 * Module-level caches of the last successful series fetch, keyed by
 * device+metric+range and kept alive across hook unmounts. Like the keg and
 * dashboard caches, this lets the Overview's sparklines repaint instantly with
 * their last data when you navigate back, instead of flashing empty and
 * refetching from scratch — the hooks still refresh in the background. Cleared
 * on a full browser reload.
 */
const seriesCache = new Map<string, MetricSeries>();
const seriesTCache = new Map<string, { t: number; value: number }[]>();
const totalCache = new Map<string, number>();

function seriesKey(deviceId: number, metric: string, rangeMs: number): string {
  return `${deviceId}:${metric}:${rangeMs}`;
}

export interface MetricSeries {
  /** The plotted values, oldest→newest. Bucket averages, not raw readings. */
  values: number[];
  /**
   * The true extremes across the window — the lowest and highest readings the
   * server averaged away, not the extremes of {@link values}. Null when the
   * window holds too little to draw. Captions quoting a Min/Max want this;
   * anything sizing an axis to the drawn line wants `values`.
   */
  extremes: { min: number; max: number } | null;
  /**
   * When the first and last plotted points were recorded.
   *
   * Not the same thing as the requested window: a sensor that started reporting
   * an hour into a 24h range still has its points stretched across the whole
   * width of a preview, because a sparkline spaces them by index. Anything
   * placing something on the chart *by time* — the event markers — has to line
   * up against what was actually drawn, not against what was asked for. Null
   * when there is too little to draw.
   */
  window: { start: number; end: number } | null;
}

const EMPTY_SERIES: MetricSeries = { values: [], extremes: null, window: null };

/** Widest span across a bucketed response, falling back to a raw row's value. */
function extremesOf(history: Reading[]): { min: number; max: number } | null {
  if (history.length < 2) return null;
  return {
    min: Math.min(...history.map((r) => r.min ?? r.value)),
    max: Math.max(...history.map((r) => r.max ?? r.value)),
  };
}

/** Time span covered by a newest-first history response. */
function windowOf(history: Reading[]): { start: number; end: number } | null {
  if (history.length < 2) return null;
  return {
    start: Date.parse(history[history.length - 1]!.recordedAt),
    end: Date.parse(history[0]!.recordedAt),
  };
}

/**
 * A metric's history for the Overview's inline sparklines, as plotted values
 * plus the window's true extremes. Lighter than {@link useDeviceData}: no
 * metric/range state, a small point cap, and a slow poll. Pass `null` to disable
 * and keep the last series through a transient fetch error.
 *
 * Most callers only draw the line and should use {@link useMetricSeries};
 * reach for this one where the real spread is spelled out in words, since the
 * line itself is smoothed (see {@link SERIES_BUCKETS}).
 */
export function useMetricSeriesFull(
  deviceId: number | null,
  metric: string,
  rangeMs = 24 * 60 * 60 * 1000,
): MetricSeries {
  const [series, setSeries] = useState<MetricSeries>(() =>
    deviceId == null ? EMPTY_SERIES : seriesCache.get(seriesKey(deviceId, metric, rangeMs)) ?? EMPTY_SERIES,
  );

  // Re-seed from cache when the key changes mid-mount (e.g. range switch), so
  // the preview shows the last data for the new window without a blank frame.
  useEffect(() => {
    if (deviceId == null) {
      setSeries(EMPTY_SERIES);
      return;
    }
    const cached = seriesCache.get(seriesKey(deviceId, metric, rangeMs));
    if (cached) setSeries(cached);
  }, [deviceId, metric, rangeMs]);

  usePoll(
    async (isStale) => {
      if (deviceId == null) return;
      try {
        const since = new Date(Date.now() - rangeMs).toISOString();
        const history = await api.getDeviceHistory(deviceId, {
          metric,
          since,
          buckets: SERIES_BUCKETS,
        });
        if (!isStale()) {
          const next: MetricSeries = {
            values: [...history].reverse().map((r) => r.value),
            extremes: extremesOf(history),
            window: windowOf(history),
          };
          seriesCache.set(seriesKey(deviceId, metric, rangeMs), next);
          setSeries(next);
        }
      } catch {
        // Keep the last known series through a transient history failure.
      }
    },
    SERIES_POLL_MS,
    [deviceId, metric, rangeMs],
  );

  return series;
}

/**
 * Like {@link useMetricSeries} but keeps timestamps — `{ t, value }` points,
 * oldest→newest — for views that need a real time axis (e.g. the gravity
 * forecast fit). Pass `null` to disable; keeps the last series through a
 * transient fetch error.
 */
export function useMetricSeriesT(
  deviceId: number | null,
  metric: string,
  rangeMs = 24 * 60 * 60 * 1000,
): { t: number; value: number }[] {
  const [series, setSeries] = useState<{ t: number; value: number }[]>(() =>
    deviceId == null ? [] : seriesTCache.get(seriesKey(deviceId, metric, rangeMs)) ?? [],
  );

  useEffect(() => {
    if (deviceId == null) {
      setSeries([]);
      return;
    }
    const cached = seriesTCache.get(seriesKey(deviceId, metric, rangeMs));
    if (cached) setSeries(cached);
  }, [deviceId, metric, rangeMs]);

  usePoll(
    async (isStale) => {
      if (deviceId == null) return;
      try {
        const since = new Date(Date.now() - rangeMs).toISOString();
        // Bucketed for the same reason as the plain series above, and at a
        // higher resolution because this feeds the gravity decay fit as well as
        // a preview. The old `limit` here truncated to the newest 2000 rows,
        // which at a 30s cadence is well under the day the forecast fits over.
        const history = await api.getDeviceHistory(deviceId, {
          metric,
          since,
          buckets: SERIES_T_BUCKETS,
        });
        if (!isStale()) {
          const points = [...history].reverse().map((r) => ({ t: Date.parse(r.recordedAt), value: r.value }));
          seriesTCache.set(seriesKey(deviceId, metric, rangeMs), points);
          setSeries(points);
        }
      } catch {
        // Keep the last known series through a transient history failure.
      }
    },
    SERIES_POLL_MS,
    [deviceId, metric, rangeMs],
  );

  return series;
}

/**
 * A target-temperature change placed on a chart's time axis — {@link
 * SetpointChange} with its timestamp already parsed, since every consumer needs
 * it as a number to position a marker.
 */
export interface SetpointMarker {
  /** Epoch milliseconds. */
  t: number;
  from: number;
  to: number;
}

/**
 * Module-level cache of the last successful change fetch, keyed like the series
 * caches above so navigating back repaints the markers immediately.
 */
const setpointChangeCache = new Map<string, SetpointMarker[]>();

/**
 * The controller's target changes across a window, oldest first — the vertical
 * markers the temperature charts draw (see {@link SetpointChange}).
 *
 * Polled at the preview cadence rather than the device's own: a change is an
 * event a brewer makes a handful of times per batch, not a sample, and it can't
 * surface any faster than the controller's next push anyway. Pass `null` (a
 * chart with no controller behind it) to disable; the last set is kept through a
 * transient fetch error, like the series hooks.
 */
export function useSetpointChanges(deviceId: number | null, rangeMs: number): SetpointMarker[] {
  const key = deviceId == null ? '' : `${deviceId}:${rangeMs}`;
  const [changes, setChanges] = useState<SetpointMarker[]>(
    () => setpointChangeCache.get(key) ?? [],
  );

  useEffect(() => {
    if (deviceId == null) {
      setChanges([]);
      return;
    }
    const cached = setpointChangeCache.get(key);
    if (cached) setChanges(cached);
  }, [deviceId, key]);

  usePoll(
    async (isStale) => {
      if (deviceId == null) return;
      try {
        const since = new Date(Date.now() - rangeMs).toISOString();
        const rows = await api.getSetpointChanges(deviceId, { since });
        if (isStale()) return;
        // The API answers newest first; charts read left to right.
        const next = rows
          .map((c) => ({ t: Date.parse(c.at), from: c.from, to: c.to }))
          .sort((a, b) => a.t - b.t);
        setpointChangeCache.set(key, next);
        setChanges(next);
      } catch {
        // Keep the last known changes through a transient failure.
      }
    },
    SERIES_POLL_MS,
    [deviceId, key, rangeMs],
  );

  return changes;
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
  const [total, setTotal] = useState<number | null>(() =>
    metric ? totalCache.get(`${deviceId}:${metric}`) ?? null : null,
  );

  useEffect(() => {
    if (!metric) {
      setTotal(null);
      return;
    }
    const cached = totalCache.get(`${deviceId}:${metric}`);
    if (cached != null) setTotal(cached);
  }, [deviceId, metric]);

  usePoll(
    async (isStale) => {
      if (!metric) return;
      try {
        const res = await api.getDeviceTotal(deviceId, metric);
        if (!isStale()) {
          totalCache.set(`${deviceId}:${metric}`, res.total);
          setTotal(res.total);
        }
      } catch {
        // Keep the last known total on a transient fetch error.
      }
    },
    TOTAL_POLL_MS,
    [deviceId, metric],
  );

  return total;
}
