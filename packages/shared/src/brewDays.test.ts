import { describe, expect, it } from 'vitest';
import { abvFromGravities, apparentAttenuation } from './index.js';

/**
 * What a brew day's measured gravities add up to. Both take the figures as the
 * brewer typed them, which is why the string cases matter as much as the maths.
 */

describe('apparentAttenuation', () => {
  it('is the share of the extract the yeast took', () => {
    // 1.060 → 1.012: 48 of the 60 points gone.
    expect(apparentAttenuation('1.060', '1.012')).toBeCloseTo(80, 5);
    expect(apparentAttenuation(1.05, 1.01)).toBeCloseTo(80, 5);
  });

  it('has no answer without both gravities', () => {
    expect(apparentAttenuation('', '1.012')).toBeNull();
    expect(apparentAttenuation('1.060', '')).toBeNull();
    expect(apparentAttenuation('not a gravity', '1.012')).toBeNull();
  });

  it('refuses a wort that never had any extract in it', () => {
    // OG at or below water is either a typo or a reading of the tap — either
    // way, dividing by it would report a confident nonsense.
    expect(apparentAttenuation('1.000', '0.998')).toBeNull();
    expect(apparentAttenuation('0.999', '0.998')).toBeNull();
  });
});

describe('abvFromGravities', () => {
  it('follows the same formula the recipe calculations use', () => {
    expect(abvFromGravities('1.060', '1.012')).toBeCloseTo(6.3, 1);
    expect(abvFromGravities(1.048, 1.01)).toBeCloseTo(4.99, 2);
  });

  it('is null until both have been measured', () => {
    expect(abvFromGravities('1.060', '')).toBeNull();
    expect(abvFromGravities('', '')).toBeNull();
  });

  it('reports a stalled ferment rather than hiding it', () => {
    // A finished beer that read higher than it started is a measurement worth
    // seeing, not one to clamp to zero.
    expect(abvFromGravities('1.010', '1.020')).toBeLessThan(0);
  });
});
