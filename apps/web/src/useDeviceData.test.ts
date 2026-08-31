import type { Reading } from '@checklist/shared';
import { describe, expect, it } from 'vitest';
import { canTailHistory, historyWindowQuery, mergeHistoryWindow } from './useDeviceData';

/**
 * The history poll only re-reads a whole window when it has to; the rest of the
 * time it asks for the tail since the newest reading it already holds. That
 * bargain is invisible from the UI right up until it goes wrong, and then the
 * chart draws a line through a couple of readings as if that were the window —
 * which is exactly what a hidden-then-shown metric used to do. These cover the
 * ways an anchor stops being something rows can be appended to.
 */

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const WINDOW_START = NOW - 24 * HOUR;

function reading(id: number, atMs: number, value = 20): Reading {
  return { id, deviceId: 1, metric: 'temp_c', value, recordedAt: new Date(atMs).toISOString() };
}

const KEY = '1:temp_c:86400000';

function cursor(anchorAtMs: number | null, appendable = true, key = KEY) {
  return { key, anchor: anchorAtMs == null ? null : reading(500, anchorAtMs), appendable };
}

function canTail(over: Partial<Parameters<typeof canTailHistory>[0]>): boolean {
  return canTailHistory({
    cursor: cursor(NOW - 60_000),
    key: KEY,
    heldRows: 240,
    bucketed: false,
    windowStartMs: WINDOW_START,
    ...over,
  });
}

describe('canTailHistory', () => {
  it('tails a series that is still held and still anchored inside the window', () => {
    expect(canTail({})).toBe(true);
  });

  it('reads the whole window on the first fetch of a series', () => {
    expect(canTail({ cursor: undefined, heldRows: 0 })).toBe(false);
  });

  it('reads the whole window for a metric switched off and back on', () => {
    // The regression: the cursor outlives the rows, which are rebuilt from the
    // drawn set. Tailing here returns only the readings recorded while the
    // metric was hidden — one or two of them at a minute's logging cadence.
    expect(canTail({ heldRows: 0 })).toBe(false);
  });

  it('reads the whole window once the anchor has aged off the back of it', () => {
    expect(canTail({ cursor: cursor(WINDOW_START - HOUR) })).toBe(false);
  });

  it('never tails a bucketed window — every poll re-averages all of it', () => {
    expect(canTail({ bucketed: true })).toBe(false);
    expect(historyWindowQuery(7 * 24 * HOUR).buckets).toBeGreaterThan(0);
  });

  it('never tails a series that already failed the append check', () => {
    expect(canTail({ cursor: cursor(NOW - 60_000, false) })).toBe(false);
  });

  it('ignores a cursor read for a different device, metric or range', () => {
    expect(canTail({ cursor: cursor(NOW - 60_000, true, '1:temp_c:3600000') })).toBe(false);
  });

  it('has nothing to tail from without an anchor', () => {
    expect(canTail({ cursor: cursor(null) })).toBe(false);
  });
});

describe('mergeHistoryWindow', () => {
  const held = [reading(3, NOW - HOUR), reading(2, NOW - 2 * HOUR), reading(1, NOW - 3 * HOUR)];

  it('appends a tail page ahead of the rows already held, newest first', () => {
    const page = [reading(4, NOW), reading(3, NOW - HOUR)]; // anchor echoed back
    expect(mergeHistoryWindow(held, page, true, WINDOW_START).map((r) => r.id)).toEqual([4, 3, 2, 1]);
  });

  it('replaces the held rows when the fetch was a whole window', () => {
    const page = [reading(9, NOW), reading(8, NOW - HOUR)];
    expect(mergeHistoryWindow(held, page, false, WINDOW_START).map((r) => r.id)).toEqual([9, 8]);
  });

  it('drops rows that have aged past the start of the window', () => {
    const aged = [reading(3, NOW), reading(2, WINDOW_START - 1), reading(1, WINDOW_START - HOUR)];
    expect(mergeHistoryWindow(aged, [], true, WINDOW_START).map((r) => r.id)).toEqual([3]);
  });

  it('keeps a re-read window whole even when its rows reuse held ids', () => {
    // A mock sensor synthesizes its history per request, ids and all. Those
    // pages are never appended (append is false), so the id collision can't
    // eat them.
    const page = [reading(3, NOW), reading(2, NOW - HOUR), reading(1, NOW - 2 * HOUR)];
    expect(mergeHistoryWindow(held, page, false, WINDOW_START)).toHaveLength(3);
  });
});
