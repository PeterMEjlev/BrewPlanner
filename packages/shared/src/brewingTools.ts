/** Exact conversion: one pound per square inch in bar. */
export const BAR_PER_PSI = 0.0689476;

/** Canonical carbonation ranges; callers own display names, aliases, and order. */
export const CARBONATION_GUIDELINE_RANGES = {
  britishAles: { min: 1.5, max: 2.0 },
  belgianAles: { min: 1.9, max: 2.4 },
  americanAlesAndLager: { min: 2.2, max: 2.7 },
  porterAndStout: { min: 1.7, max: 2.3 },
  europeanLagers: { min: 2.2, max: 2.7 },
  fruitLambic: { min: 3.0, max: 4.5 },
  lambic: { min: 2.4, max: 2.8 },
  germanWheatBeer: { min: 3.3, max: 4.5 },
} as const;

/**
 * Final wort volume after diluting from `currentSg` to `targetSg`.
 * Callers own validation because the web form and Bruce intentionally report
 * invalid input in different ways.
 */
export function dilutedVolumeL(volumeL: number, currentSg: number, targetSg: number): number {
  return (volumeL * (currentSg - 1)) / (targetSg - 1);
}

/** Correct a hydrometer reading for sample temperature. */
export function correctedGravity(reading: number, sampleC: number, calibrationC: number): number {
  const toF = (c: number): number => (c * 9) / 5 + 32;
  const offset = (tF: number): number =>
    (1.313454 - 0.132674 * tF + 0.002057793 * tF * tF - 0.000002627634 * tF * tF * tF) * 0.001;
  return reading + offset(toF(sampleC)) - offset(toF(calibrationC));
}

/** Regulator pressure required for a target volume of dissolved CO2. */
export function carbonationPressure(
  volumesCo2: number,
  tempC: number,
): { bar: number; psi: number } {
  const tempF = (tempC * 9) / 5 + 32;
  const psi =
    -16.6999 -
    0.0101059 * tempF +
    0.00116512 * tempF * tempF +
    0.173354 * tempF * volumesCo2 +
    4.24267 * volumesCo2 -
    0.0684226 * volumesCo2 * volumesCo2;
  return { bar: psi * BAR_PER_PSI, psi };
}
