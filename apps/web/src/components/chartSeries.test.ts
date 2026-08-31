import { describe, expect, it } from 'vitest';
import { axisOf, extentOf, mergeSeries, valueKey } from './chartSeries';

describe('axisOf', () => {
  it('puts metrics sharing a unit on one axis', () => {
    // The case the whole overlay exists for: a fridge and the target it is held
    // to are only comparable against the same scale.
    expect(axisOf('temp_c')).toBe(axisOf('setpoint_c'));
  });

  it('gives the HVAC state an axis of its own', () => {
    // -1/0/+1 on a °C axis is a flat line along the bottom.
    expect(axisOf('hvac_state')).toBe('state');
    expect(axisOf('hvac_state')).not.toBe(axisOf('temp_c'));
  });

  it('separates metrics that merely both lack a unit', () => {
    expect(axisOf('gravity_sg')).not.toBe(axisOf('hvac_state'));
  });

  it('separates unlike units', () => {
    expect(axisOf('pressure_bar')).not.toBe(axisOf('temp_c'));
    expect(axisOf('power_w')).not.toBe(axisOf('energy_kwh'));
  });
});

describe('mergeSeries', () => {
  const a = [
    { t: 10, value: 1 },
    { t: 20, value: 2 },
  ];

  it('passes a lone series straight through', () => {
    expect(mergeSeries([{ key: 'v_a', points: a }])).toEqual([
      { t: 10, v_a: 1 },
      { t: 20, v_a: 2 },
    ]);
  });

  it('shares a row between series logged at the same moment', () => {
    const rows = mergeSeries([
      { key: 'v_a', points: a },
      { key: 'v_b', points: [{ t: 10, value: 9 }] },
    ]);
    expect(rows).toEqual([
      { t: 10, v_a: 1, v_b: 9 },
      { t: 20, v_a: 2 },
    ]);
  });

  it('interleaves points in time order and leaves the gaps out', () => {
    // What separate thinning produces: two series whose points no longer line
    // up. Each row carries only the columns that have a reading, which is what
    // `connectNulls` on the lines then draws through.
    const rows = mergeSeries([
      { key: 'v_a', points: a },
      {
        key: 'v_b',
        points: [
          { t: 15, value: 5 },
          { t: 5, value: 4 },
        ],
      },
    ]);
    expect(rows.map((r) => r.t)).toEqual([5, 10, 15, 20]);
    expect(rows[0]).toEqual({ t: 5, v_b: 4 });
    expect(rows[2]).toEqual({ t: 15, v_b: 5 });
  });

  it('has nothing to draw for no series, or for empty ones', () => {
    expect(mergeSeries([])).toEqual([]);
    expect(mergeSeries([{ key: 'v_a', points: [] }])).toEqual([]);
  });

  it('keys columns per metric', () => {
    expect(valueKey('temp_c')).not.toBe(valueKey('setpoint_c'));
  });
});

describe('extentOf', () => {
  it('spans every series handed in', () => {
    expect(
      extentOf([
        [
          { t: 0, value: 20 },
          { t: 1, value: 22 },
        ],
        [{ t: 0, value: 4 }],
      ]),
    ).toEqual({ min: 4, max: 22 });
  });

  it('is null when there is nothing to measure', () => {
    expect(extentOf([])).toBeNull();
    expect(extentOf([[], []])).toBeNull();
  });

  it('handles a single reading', () => {
    expect(extentOf([[{ t: 0, value: 7 }]])).toEqual({ min: 7, max: 7 });
  });
});
