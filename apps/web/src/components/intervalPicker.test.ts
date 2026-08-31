import { REPORTING_INTERVAL_OPTIONS } from '@checklist/shared';
import { describe, expect, it } from 'vitest';
import { intervalLabel, intervalOptions } from './intervalPicker';

describe('intervalLabel', () => {
  it('reads seconds under a minute and a half', () => {
    expect(intervalLabel(30)).toBe('30s');
    expect(intervalLabel(60)).toBe('60s');
  });

  it('reads minutes up to an hour', () => {
    expect(intervalLabel(300)).toBe('5m');
    expect(intervalLabel(600)).toBe('10m');
  });

  it('reads hours past that', () => {
    expect(intervalLabel(3600)).toBe('1h');
    expect(intervalLabel(7200)).toBe('2h');
  });
});

describe('intervalOptions', () => {
  it('offers the standard cadences in order', () => {
    expect(intervalOptions(30).map((o) => o.value)).toEqual([...REPORTING_INTERVAL_OPTIONS]);
  });

  it('includes a cadence set outside the picker, so it still shows as current', () => {
    // e.g. one set by the device CLI, or left over from an older option list.
    const values = intervalOptions(45).map((o) => o.value);
    expect(values).toContain(45);
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });

  it('does not list the current cadence twice', () => {
    const values = intervalOptions(300).map((o) => o.value);
    expect(values.filter((v) => v === 300)).toHaveLength(1);
  });
});
