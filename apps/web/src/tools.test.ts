import { describe, expect, it } from 'vitest';
import {
  carbonationPressure,
  correctedGravity,
  dilutedVolumeL,
  parseGravity,
  parseNumber,
} from './tools';

describe('parseGravity', () => {
  it('accepts the three ways a gravity gets written', () => {
    expect(parseGravity('1.050')).toBeCloseTo(1.05, 5);
    expect(parseGravity('1050')).toBeCloseTo(1.05, 5);
    expect(parseGravity('1,050')).toBeCloseTo(1.05, 5);
  });

  it('rejects a field with no usable number in it', () => {
    expect(parseGravity('')).toBeNull();
    expect(parseGravity('.')).toBeNull();
    expect(parseGravity('0')).toBeNull();
  });
});

describe('parseNumber', () => {
  it('takes a comma for the decimal point', () => {
    expect(parseNumber('2,5')).toBeCloseTo(2.5, 5);
    expect(parseNumber('2.5')).toBeCloseTo(2.5, 5);
  });

  it('keeps negative temperatures', () => {
    expect(parseNumber('-1.5')).toBeCloseTo(-1.5, 5);
  });

  it('returns null for an empty field', () => {
    expect(parseNumber('')).toBeNull();
  });
});

describe('dilutedVolumeL', () => {
  it('scales volume by the ratio of gravity points', () => {
    // 20 L at 75 points carries 1500 points·L; at 50 points that is 30 L.
    expect(dilutedVolumeL(20, 1.075, 1.05)).toBeCloseTo(30, 6);
  });

  it('leaves the volume alone when the target is the current gravity', () => {
    expect(dilutedVolumeL(23, 1.048, 1.048)).toBeCloseTo(23, 6);
  });
});

describe('correctedGravity', () => {
  it('is a no-op at the calibration temperature', () => {
    expect(correctedGravity(1.02, 20, 20)).toBeCloseTo(1.02, 6);
  });

  it('corrects a warm sample upward', () => {
    // 27 °C against a 20 °C hydrometer: warm wort is thinner, so the reading
    // is low — by about 1.6 points here.
    expect(correctedGravity(1.02, 27, 20)).toBeCloseTo(1.0216, 4);
  });

  it('corrects a cold sample downward', () => {
    expect(correctedGravity(1.02, 10, 20)).toBeLessThan(1.02);
  });
});

describe('carbonationPressure', () => {
  it('matches the published solubility chart', () => {
    // 2.4 volumes at 3 °C (37.4 °F) — the chart puts an American ale on a cold
    // keg at a touch under 10 psi.
    const { psi, bar } = carbonationPressure(2.4, 3);
    expect(psi).toBeCloseTo(9.9, 1);
    expect(bar).toBeCloseTo(0.68, 2);
    // A second point away from the first, so a broken fit can't slip through:
    // 2.5 volumes at 40 °F is ~12.4 psi on the same chart.
    expect(carbonationPressure(2.5, (40 - 32) * 5 / 9).psi).toBeCloseTo(12.3, 1);
  });

  it('needs more pressure as the keg warms', () => {
    const cold = carbonationPressure(2.4, 3).psi;
    const warm = carbonationPressure(2.4, 12).psi;
    expect(warm).toBeGreaterThan(cold);
  });

  it('goes negative when the beer already holds more than the target', () => {
    expect(carbonationPressure(0.8, 2).psi).toBeLessThan(0);
  });
});
