/**
 * Mash pH — the one model, shared by the recipe sheet and the water calculator.
 *
 * Both used to carry their own. The recipe estimated pH from grist colour with a
 * fixed alkalinity coefficient; the water calculator ran a Kolbach/Troester
 * buffering model off a distilled-water pH the brewer typed in. They disagreed
 * by up to ~0.15 pH on the same beer, and the recipe's residual-alkalinity term
 * mixed units (see {@link residualAlkalinityCaCO3}), so the two are collapsed
 * here instead.
 *
 * The chain runs in two halves, which is what lets both callers share it:
 *
 *   grist (colour + acid malt)  →  the pH it reaches in distilled water
 *   + what the water's residual alkalinity does to that  →  mash pH
 *
 * The first half is a property of the malt alone and needs no water; the second
 * needs no grain bill beyond its buffering. A recipe knows its grist and can run
 * both. The standalone water calculator has no grain bill, so it asks for the
 * first half's answer directly (or takes it from the recipe that linked to it)
 * and runs the second.
 *
 * All ion concentrations are mg/L (ppm); alkalinity and residual alkalinity are
 * ppm as CaCO₃.
 */

/** ppm CaCO₃ per mEq/L — the equivalent weight of calcium carbonate. */
export const CACO3_EQ_WEIGHT = 50;

/** Room-temperature mash pH to aim for. The 5.2–5.6 band's midpoint. */
export const DEFAULT_TARGET_MASH_PH = 5.4;

/**
 * Distilled-water mash pH assumed when there's no grain bill to derive it from.
 * A pale all-malt grist lands near here; roast and crystal drag it down (a dry
 * stout can reach 5.2), acid malt further still.
 */
export const DEFAULT_DISTILLED_MASH_PH = 5.7;

/** Mash thickness assumed when unknown, in litres of strike water per kg grain. */
export const DEFAULT_GRIST_RATIO_L_PER_KG = 3;

/** Alkalinity as CaCO₃ (ppm) from bicarbonate: HCO₃ · 50/61. */
export function alkalinityCaCO3FromBicarbonate(hco3: number): number {
  return hco3 * (CACO3_EQ_WEIGHT / 61);
}

/**
 * Kolbach residual alkalinity (ppm CaCO₃) — alkalinity net of the mash-acidifying
 * effect of calcium and magnesium. Lower (even negative) suits pale beers; higher
 * suits dark, roasty beers.
 *
 * The 1.4 and 1.7 divisors are the ppm-as-CaCO₃ form. Kolbach's better-known
 * 3.5 and 7 are the *milliequivalent* form and are wrong against ppm inputs:
 * calcium at 20.04 mg/mEq gives ppm ÷ 20.04 ÷ 3.5 × 50 = ppm ÷ 1.40, and
 * magnesium at 12.15 mg/mEq gives ppm ÷ 1.70. Feeding ppm to the 3.5/7 pair —
 * as the recipe model used to — under-counts calcium 2.5× and magnesium 4.1×,
 * which reads alkaline water as far more alkaline than it brews.
 */
export function residualAlkalinityCaCO3(
  alkalinityCaCO3: number,
  ca: number,
  mg: number,
): number {
  return alkalinityCaCO3 - (ca / 1.4 + mg / 1.7);
}

/**
 * Mash buffering capacity in mEq RA per pH per litre — how much residual
 * alkalinity it takes to move mash pH by one unit. Thinner mashes buffer less,
 * so the same salt addition swings pH further.
 *
 * Anchors are Troester's measurements as tabled in Palmer & Kaminski's *Water*
 * (Table 5), scaled by 0.8 from pulverized grist to a coarse crush — the factor
 * their Table 6 implies, and the one that reproduces the book's own "typical
 * modern value at 3 L/kg, coarse grind, is probably about 15 mEq/(pH·L)". It
 * also lands 4 L/kg on 12.2, matching Table 6's coarse-ground pilsner figure,
 * and 5 L/kg near Kolbach's classic 11.9. Everything stays inside the 10–30
 * envelope the book gives; ratios outside the measured 2–5 L/kg range clamp.
 */
const BUFFER_ANCHORS: [ratio: number, mEqPerPhPerL: number][] = [
  [2, 21],
  [3, 15],
  [4, 12.2],
  [5, 10.2],
];

export function mashBufferCapacity(gristRatioLPerKg: number): number {
  const r = gristRatioLPerKg;
  const first = BUFFER_ANCHORS[0]!;
  const last = BUFFER_ANCHORS[BUFFER_ANCHORS.length - 1]!;
  if (!Number.isFinite(r) || r <= first[0]) return first[1];
  if (r >= last[0]) return last[1];
  for (let i = 1; i < BUFFER_ANCHORS.length; i++) {
    const [x1, y1] = BUFFER_ANCHORS[i]!;
    const [x0, y0] = BUFFER_ANCHORS[i - 1]!;
    if (r <= x1) return y0 + ((y1 - y0) * (r - x0)) / (x1 - x0);
  }
  return last[1];
}

/** One weighed line of the grain bill, in the terms the pH model needs. */
export interface GristLine {
  name: string;
  weightKg: number;
  /** Grain colour in EBC. Null lines still count toward the total weight. */
  ebc: number | null;
}

/** Acidulated malt under the names it ships as, German and English. */
const ACIDULATED = /acidulated|sauer\s?malz|sour malt/i;

/**
 * The pH this grist reaches in distilled water — the malt's own figure, before
 * any water touches it. Null when nothing in the bill has a colour to go on.
 *
 * Colour is the proxy for acidity: `5.7 − 0.17·log₁₀(°L)` anchors pale malt near
 * 5.7 and walks darker grists down. Acidulated malt is handled by name instead,
 * at the standard 0.1 pH per percent of the bill, because it is pale and its
 * colour says nothing about the lactic acid it carries.
 *
 * Shares are taken against the *whole* bill, not just the coloured lines, so
 * sugar and extract dilute the malt's contribution rather than being silently
 * excluded from the denominator.
 */
export function gristDistilledMashPh(lines: GristLine[]): number | null {
  const totalKg = lines.reduce((sum, line) => sum + Math.max(0, line.weightKg), 0);
  if (totalKg <= 0) return null;
  if (!lines.some((line) => line.ebc != null && line.weightKg > 0)) return null;

  let weightedLovibond = 0;
  let acidulatedShare = 0;
  for (const line of lines) {
    const share = Math.max(0, line.weightKg) / totalKg;
    if (line.ebc != null) {
      const srm = line.ebc / 1.97;
      weightedLovibond += Math.max(0, (srm + 0.76) / 1.3546) * share;
    }
    if (ACIDULATED.test(line.name)) acidulatedShare += share;
  }

  return (
    DEFAULT_DISTILLED_MASH_PH
    - 0.17 * Math.log10(Math.max(1, weightedLovibond))
    - acidulatedShare * 100 * 0.1
  );
}

/** Where the mash lands, given the RA the water delivers to that grist. */
export function predictedMashPh(
  distilledMashPh: number,
  ra: number,
  bufferCapacity: number,
): number {
  if (bufferCapacity <= 0) return distilledMashPh;
  return distilledMashPh + ra / (bufferCapacity * CACO3_EQ_WEIGHT);
}

/**
 * The residual alkalinity (ppm CaCO₃) the brewing water must carry to land the
 * mash at `targetPh`, given the pH this grist reaches in distilled water.
 * Negative means the grist is already acid enough and no salt can help — the
 * water needs acid, not alkalinity, which is the case for every pale grist.
 */
export function requiredResidualAlkalinity(
  distilledMashPh: number,
  targetPh: number,
  bufferCapacity: number,
): number {
  return (targetPh - distilledMashPh) * bufferCapacity * CACO3_EQ_WEIGHT;
}

/**
 * The bicarbonate (ppm) that produces `ra` alongside the given calcium and
 * magnesium — {@link residualAlkalinityCaCO3} rearranged for HCO₃. Negative when
 * calcium and magnesium alone already acidify past the requirement.
 */
export function bicarbonateForResidualAlkalinity(ra: number, ca: number, mg: number): number {
  return (ra + ca / 1.4 + mg / 1.7) * (61 / CACO3_EQ_WEIGHT);
}

/**
 * Strike water in litres — grain bill × mash thickness.
 *
 * This, not the total brewing water, is what the pH model acts on. Salts are
 * dosed across the whole volume, so every litre carries the same ion load, but
 * only the mash meets the grist: an acid correction is metered into the strike
 * water alone, and charging it against mash + sparge would overstate the dose by
 * whatever share is sparge. `totalL` caps the answer, since a mash can't hold
 * more water than the brewer is brewing with.
 */
export function mashWaterVolumeL(
  grainKg: number,
  gristRatioLPerKg: number,
  totalL: number,
): number {
  const litres = Math.max(0, grainKg) * Math.max(0, gristRatioLPerKg);
  if (!Number.isFinite(litres)) return 0;
  return Math.min(litres, Math.max(0, totalL));
}

/** Milliequivalents of acid to pull `volumeL` litres from `from` RA down to `to`. */
export function acidMilliequivalents(from: number, to: number, volumeL: number): number {
  return ((from - to) / CACO3_EQ_WEIGHT) * Math.max(0, volumeL);
}

/**
 * mEq of acid per mL. 88 % lactic is the homebrew standard and is cleanly
 * monoprotic, so one mL is one unambiguous dose: 1.209 g/mL × 0.88 ÷ 90.08
 * g/mol. Phosphoric would need a mash-pH-dependent equivalence and is left out
 * rather than approximated.
 */
export const LACTIC_88_MEQ_PER_ML = 11.81;
