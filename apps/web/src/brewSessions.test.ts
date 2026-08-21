import { describe, expect, it } from 'vitest';
import { targetDelta } from './brewSessions';

/**
 * The one line the brew log is really for: how far the day landed from what the
 * recipe asked for. What matters is that it is silent whenever it has nothing
 * true to say — a target the recipe never stated, a reading never taken, or a
 * figure that simply hit the number — because a wrong or noisy comparison is
 * worse than no comparison on a page whose whole job is plan against result.
 */
describe('targetDelta', () => {
  it('says a gravity miss in points, the unit brewers use', () => {
    expect(targetDelta('1.052', '1.048', 'gravity')).toBe('+4 pts');
    expect(targetDelta('1.044', '1.048', 'gravity')).toBe('−4 pts');
    // One point is one point, not one points.
    expect(targetDelta('1.049', '1.048', 'gravity')).toBe('+1 pt');
  });

  it('says everything else in its own unit, to a tenth', () => {
    expect(targetDelta(29.5, '31 L', 'L')).toBe('−1.5 L');
    expect(targetDelta(68, '67°C', '°C')).toBe('+1 °C');
    expect(targetDelta(75, '60 min', 'min')).toBe('+15 min');
  });

  it('stays silent when the day hit the number', () => {
    expect(targetDelta('1.048', '1.048', 'gravity')).toBeNull();
    expect(targetDelta(31, '31 L', 'L')).toBeNull();
    // Under a tenth of a unit the two figures are the same reading twice, and
    // rounding them would print a signed zero.
    expect(targetDelta(31.02, '31 L', 'L')).toBeNull();
    expect(targetDelta('1.0482', '1.048', 'gravity')).toBeNull();
  });

  it('stays silent when either side is missing or unreadable', () => {
    expect(targetDelta('', '1.048', 'gravity')).toBeNull();
    expect(targetDelta('1.048', null, 'gravity')).toBeNull();
    expect(targetDelta(null, 31, 'L')).toBeNull();
    expect(targetDelta('n/a', '1.048', 'gravity')).toBeNull();
  });

  it('reads a comma decimal, which a Danish keyboard types', () => {
    expect(targetDelta('1,052', '1.048', 'gravity')).toBe('+4 pts');
  });
});
