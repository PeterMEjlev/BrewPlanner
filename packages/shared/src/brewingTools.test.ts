import { describe, expect, it } from 'vitest';
import { carbonationPressure, correctedGravity, dilutedVolumeL } from './brewingTools';

describe('shared brewing calculators', () => {
  it('dilutes by preserving gravity points times volume', () => {
    expect(dilutedVolumeL(20, 1.075, 1.05)).toBeCloseTo(30, 6);
    expect(dilutedVolumeL(23, 1.048, 1.048)).toBeCloseTo(23, 6);
  });

  it('corrects hydrometer readings around their calibration temperature', () => {
    expect(correctedGravity(1.02, 20, 20)).toBeCloseTo(1.02, 6);
    expect(correctedGravity(1.02, 27, 20)).toBeCloseTo(1.0216, 4);
    expect(correctedGravity(1.02, 10, 20)).toBeLessThan(1.02);
  });

  it('matches the carbonation solubility curve', () => {
    const { psi, bar } = carbonationPressure(2.4, 3);
    expect(psi).toBeCloseTo(9.9, 1);
    expect(bar).toBeCloseTo(0.68, 2);
    expect(carbonationPressure(2.4, 12).psi).toBeGreaterThan(psi);
    expect(carbonationPressure(0.8, 2).psi).toBeLessThan(0);
  });
});
