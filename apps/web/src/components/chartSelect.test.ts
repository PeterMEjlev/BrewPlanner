import { describe, expect, it } from 'vitest';
import { type SelectionSeries, formatSpan, selectionStats } from './chartSelect';

interface Row {
  t: number;
  bk: number | null;
  mlt: number | null;
}

const SERIES: SelectionSeries[] = [
  { key: 'bk', label: 'BK', color: '#ef4444' },
  { key: 'mlt', label: 'MLT', color: '#10b981' },
];

const rows: Row[] = [
  { t: 0, bk: 20, mlt: 60 },
  { t: 10, bk: 40, mlt: 66 },
  { t: 20, bk: 60, mlt: null },
  { t: 30, bk: 100, mlt: 64 },
];

const stats = (range: { min: number; max: number }) =>
  selectionStats(
    rows,
    range,
    (row) => row.t,
    SERIES,
    (row, key) => row[key as 'bk' | 'mlt'],
  );

describe('selectionStats', () => {
  it('describes only the rows inside the painted range', () => {
    const [bk] = stats({ min: 0, max: 20 });
    expect(bk).toMatchObject({ label: 'BK', min: 20, max: 60, count: 3 });
    expect(bk?.avg).toBe(40);
  });

  it('takes both ends of the range as inside it', () => {
    expect(stats({ min: 10, max: 10 })[0]).toMatchObject({ min: 40, max: 40, count: 1 });
  });

  it('averages a sensor over the samples it answered, not the ones it missed', () => {
    const mlt = stats({ min: 0, max: 30 }).find((s) => s.key === 'mlt');
    // The null at t=20 is skipped rather than counted as a zero.
    expect(mlt).toMatchObject({ min: 60, max: 66, count: 3 });
    expect(mlt?.avg).toBeCloseTo(63.333, 3);
  });

  it('drops a trace that logged nothing over the period', () => {
    expect(stats({ min: 20, max: 20 }).map((s) => s.key)).toEqual(['bk']);
  });

  it('says nothing at all about a period with no samples in it', () => {
    expect(stats({ min: 100, max: 200 })).toEqual([]);
  });

  it('dates each extreme, so a falling trace can be quoted newest-last', () => {
    // BK climbs across the window and MLT peaks in the middle then falls back:
    // one reads min-first, the other max-first.
    const [bk, mlt] = stats({ min: 0, max: 30 });
    expect(bk).toMatchObject({ min: 20, minAt: 0, max: 100, maxAt: 30 });
    expect(mlt).toMatchObject({ min: 60, minAt: 0, max: 66, maxAt: 10 });
  });

  it('dates a held level from the first row that reached it, not the last', () => {
    const flat = [
      { t: 0, bk: 5, mlt: null },
      { t: 10, bk: 5, mlt: null },
      { t: 20, bk: 5, mlt: null },
    ];
    const [bk] = selectionStats(
      flat,
      { min: 0, max: 20 },
      (row) => row.t,
      SERIES,
      (row, key) => row[key as 'bk' | 'mlt'],
    );
    expect(bk).toMatchObject({ min: 5, max: 5, minAt: 0, maxAt: 0, count: 3 });
  });
});

describe('formatSpan', () => {
  it('counts seconds up to a minute and a half', () => {
    expect(formatSpan(30_000)).toBe('30s');
    expect(formatSpan(89_000)).toBe('89s');
  });

  it('counts whole minutes below an hour', () => {
    expect(formatSpan(15 * 60_000)).toBe('15m');
  });

  it('spells an hour out with its minutes, and drops them when there are none', () => {
    expect(formatSpan(88 * 60_000)).toBe('1h 28m');
    expect(formatSpan(2 * 3_600_000)).toBe('2h');
  });

  it('moves up to days once an hour count would stop being readable', () => {
    expect(formatSpan(30 * 3_600_000)).toBe('1d 6h');
    expect(formatSpan(48 * 3_600_000)).toBe('2d');
  });
});
