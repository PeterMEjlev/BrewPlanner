/**
 * The arithmetic behind the standalone brewing calculators on the Tools page —
 * dilution, hydrometer temperature correction, and force-carbonation pressure.
 * Ported from the brewing rig's own Tools screen (BrewSystem 3.0) so both
 * machines answer a brewer with the same numbers; kept apart from the UI so the
 * formulas can be tested without a DOM.
 *
 * The water chemistry is a bigger model and lives on its own in {@link ./water}.
 *
 * These same three sums exist server-side as Bruce's calculator tools
 * (apps/server/src/bruce/tools.ts) so the assistant doesn't do them in its head.
 * The coefficients there are the same ones — deliberately, since a brewer who
 * asks Bruce and a brewer who opens this page must get the same answer — so
 * treat a change here as a change to check there.
 */

/**
 * A gravity as brewers actually type it, normalised to specific gravity.
 *
 * The same figure gets written three ways — `1.050`, `1050`, `1,050` — so
 * commas are stripped and anything at or above 2 is read as points per
 * thousand. That the comma is a thousands separator in `1,050` and a decimal
 * separator on a Danish keyboard is a happy accident here: both spellings reduce
 * to 1050, and both mean 1.050.
 *
 * Returns null for anything unparseable or non-positive, which is how a
 * half-typed field says "no answer yet" rather than showing a wrong one.
 */
export function parseGravity(input: string): number | null {
  const n = Number.parseFloat(input.replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 2 ? n / 1000 : n;
}

/**
 * A plain decimal as typed, accepting a comma for the decimal point (the
 * brewery's keyboards are Danish). Null when there is no number in the field.
 */
export function parseNumber(input: string): number | null {
  const n = Number.parseFloat(input.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * The volume `volumeL` of wort has to reach for its gravity to fall from
 * `currentSg` to `targetSg`.
 *
 * Works in gravity points, which dilute in direct proportion to volume: the
 * sugar in the pot is fixed, so points × litres is a constant and the new
 * volume is `volume × (OG − 1) / (DG − 1)`. Subtract the starting volume for
 * the water to add.
 *
 * Only meaningful for `1 < targetSg < currentSg` — the caller checks that, since
 * it's the half-filled form that needs telling, not this function.
 */
export function dilutedVolumeL(volumeL: number, currentSg: number, targetSg: number): number {
  return (volumeL * (currentSg - 1)) / (targetSg - 1);
}

/**
 * A hydrometer reading corrected for the sample being warmer (or cooler) than
 * the temperature the instrument was calibrated at — typically 20 °C, printed on
 * the paper scale inside.
 *
 * Warm wort is less dense, so a hydrometer floats lower in it and under-reads;
 * the correction is worth several points on a sample pulled straight from the
 * kettle, which is enough to misjudge an efficiency or an ABV.
 *
 * The polynomial is the Brewer's Friend one and wants °F, so both temperatures
 * are converted on the way in. It's the widely used additive approximation
 * (the correction is added as an offset rather than applied as a ratio) — good
 * to well under a point over the range a brewer will ever measure in.
 */
export function correctedGravity(reading: number, sampleC: number, calibrationC: number): number {
  const toF = (c: number): number => (c * 9) / 5 + 32;
  const offset = (tF: number): number =>
    (1.313454 - 0.132674 * tF + 0.002057793 * tF * tF - 0.000002627634 * tF * tF * tF) * 0.001;
  return reading + offset(toF(sampleC)) - offset(toF(calibrationC));
}

/**
 * The regulator pressure that holds `volumesCo2` of dissolved CO₂ in beer
 * sitting at `tempC` — i.e. what to set the bottle to when force-carbonating,
 * and what to leave it at afterwards so the keg neither gains nor loses fizz.
 *
 * A curve fit to the standard CO₂ solubility tables (again in °F internally).
 * Cold beer holds far more CO₂ than warm, which is why the answer drops sharply
 * as the fridge gets colder.
 *
 * The result goes negative for a target so low that beer at that temperature
 * already holds more than asked — a real answer ("vent it"), not an error, so
 * it's returned as-is for the caller to interpret.
 */
export function carbonationPressure(
  volumesCo2: number,
  tempC: number,
): { bar: number; psi: number } {
  const t = (tempC * 9) / 5 + 32;
  const v = volumesCo2;
  const psi =
    -16.6999 -
    0.0101059 * t +
    0.00116512 * t * t +
    0.173354 * t * v +
    4.24267 * v -
    0.0684226 * v * v;
  return { bar: psi * BAR_PER_PSI, psi };
}

/** Exact conversion — 1 psi in bar. */
export const BAR_PER_PSI = 0.0689476;

/**
 * Where the styles sit on the carbonation scale, in volumes of CO₂. The
 * customary ranges (BJCP/Palmer territory) — a starting point for the field
 * above, not a rule.
 */
export const CARBONATION_GUIDELINES: { style: string; min: number; max: number }[] = [
  { style: 'British style ales', min: 1.5, max: 2.0 },
  { style: 'Belgian ales', min: 1.9, max: 2.4 },
  { style: 'American ales and lager', min: 2.2, max: 2.7 },
  { style: 'Porter, stout', min: 1.7, max: 2.3 },
  { style: 'European lagers', min: 2.2, max: 2.7 },
  { style: 'Fruit lambic', min: 3.0, max: 4.5 },
  { style: 'Lambic', min: 2.4, max: 2.8 },
  { style: 'German wheat beer', min: 3.3, max: 4.5 },
];
