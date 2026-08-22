import { describe, expect, it } from 'vitest';
import { gravityText, targetDelta } from './brewSessions';

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

/**
 * A gravity typed without its decimal point is the mistake this exists for: read
 * literally, "1037" against a 1.041 target reported a miss of 1,035,959 points.
 */
describe('gravityText', () => {
  it('reads a gravity typed without its point as the one that was meant', () => {
    expect(gravityText('1037')).toBe('1.037');
    expect(gravityText('1034')).toBe('1.034');
    expect(gravityText('998')).toBe('0.998');
    expect(gravityText(' 1043 ')).toBe('1.043');
    // Which makes the delta the four points it always was.
    expect(targetDelta(gravityText('1037'), '1.041', 'gravity')).toBe('−4 pts');
    expect(targetDelta(gravityText('1034'), '1.037', 'gravity')).toBe('−3 pts');
  });

  it('leaves a gravity that is already one alone, comma decimals included', () => {
    expect(gravityText('1.037')).toBe('1.037');
    expect(gravityText('1,037')).toBe('1.037');
    expect(gravityText('')).toBe('');
  });

  it('rewrites nothing it would have to guess at', () => {
    // Two digits could be points shorthand or a Plato reading; a number outside
    // the band gravities live in is not a gravity with its point left out.
    expect(gravityText('48')).toBe('48');
    expect(gravityText('100')).toBe('100');
    expect(gravityText('9999')).toBe('9999');
    // Text the field is deliberately allowed to hold survives as typed.
    expect(gravityText('1.0435')).toBe('1.0435');
    expect(gravityText('n/a')).toBe('n/a');
  });
});
