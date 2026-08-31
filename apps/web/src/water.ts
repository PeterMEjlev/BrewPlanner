/**
 * Brewing-water chemistry for the Water Calculator — the same job as
 * Brewersfriend's "Mash Chemistry and Brewing Water Calculator": work out how
 * much of each brewing salt to add to a volume of water to move it from a source
 * profile toward a target profile.
 *
 * Pure functions + constants, kept out of the page so the ion maths is easy to
 * follow, test, and reuse. All ion concentrations are mg/L (ppm); salt amounts
 * are grams; volume is litres.
 *
 * Key real-world constraint baked into the model: brewing salts only ever *add*
 * ions — they can't remove them. So a target with *less* of an ion than the
 * (optionally diluted) source can't be reached by additions alone; the
 * comparison just shows how close you get. Lowering an over-high ion needs
 * dilution with RO/distilled water (the dilution input) or acid (out of scope).
 *
 * The mash-pH half of the job is not here — it lives in `@checklist/shared`,
 * shared with the recipe sheet, and is re-exported below.
 */

import {
  alkalinityCaCO3FromBicarbonate,
  residualAlkalinityCaCO3,
} from '@checklist/shared';

export type Ion = 'ca' | 'mg' | 'na' | 'cl' | 'so4' | 'hco3';

export const IONS: Ion[] = ['ca', 'mg', 'na', 'cl', 'so4', 'hco3'];

export interface WaterProfile {
  /** Calcium (Ca²⁺), ppm. */
  ca: number;
  /** Magnesium (Mg²⁺), ppm. */
  mg: number;
  /** Sodium (Na⁺), ppm. */
  na: number;
  /** Chloride (Cl⁻), ppm. */
  cl: number;
  /** Sulfate (SO₄²⁻), ppm. */
  so4: number;
  /** Bicarbonate (HCO₃⁻), ppm. */
  hco3: number;
}

export const EMPTY_PROFILE: WaterProfile = { ca: 0, mg: 0, na: 0, cl: 0, so4: 0, hco3: 0 };

/** Display metadata per ion: full name and chemical symbol. */
export const ION_META: Record<Ion, { label: string; symbol: string }> = {
  ca: { label: 'Calcium', symbol: 'Ca²⁺' },
  mg: { label: 'Magnesium', symbol: 'Mg²⁺' },
  na: { label: 'Sodium', symbol: 'Na⁺' },
  cl: { label: 'Chloride', symbol: 'Cl⁻' },
  so4: { label: 'Sulfate', symbol: 'SO₄²⁻' },
  hco3: { label: 'Bicarbonate', symbol: 'HCO₃⁻' },
};

export type SaltId = 'gypsum' | 'epsom' | 'cacl2' | 'nacl' | 'nahco3';

export interface Salt {
  id: SaltId;
  name: string;
  formula: string;
  /**
   * ppm added per gram of this salt dissolved in one litre (mg/L per g/L).
   * Derived from each ion's mass fraction in the salt, e.g. gypsum
   * (CaSO₄·2H₂O, 172.17 g/mol) is 40.08/172.17 = 23.3 % Ca → 232.8 ppm Ca per
   * g/L. These match the classic Palmer/Brewersfriend per-gallon figures (÷3.785).
   */
  ppmPerGramPerL: Partial<Record<Ion, number>>;
}

/**
 * The five common brewing salts. Gypsum, Epsom, Calcium Chloride and Table Salt
 * are the four the brewer asked for; Baking Soda is included because it's the
 * only one here that can *raise* bicarbonate/alkalinity (the others can't), so
 * without it many darker-beer targets would be unreachable. Calcium Chloride is
 * the dihydrate (the usual home-brew form).
 */
export const SALTS: Salt[] = [
  { id: 'gypsum', name: 'Gypsum', formula: 'CaSO₄·2H₂O', ppmPerGramPerL: { ca: 232.8, so4: 557.7 } },
  { id: 'epsom', name: 'Epsom Salt', formula: 'MgSO₄·7H₂O', ppmPerGramPerL: { mg: 98.6, so4: 389.6 } },
  { id: 'cacl2', name: 'Calcium Chloride', formula: 'CaCl₂·2H₂O', ppmPerGramPerL: { ca: 272.6, cl: 482.3 } },
  { id: 'nacl', name: 'Table Salt', formula: 'NaCl', ppmPerGramPerL: { na: 393.4, cl: 606.5 } },
  { id: 'nahco3', name: 'Baking Soda', formula: 'NaHCO₃', ppmPerGramPerL: { na: 273.7, hco3: 726.4 } },
];

export type SaltGrams = Record<SaltId, number>;
export const EMPTY_SALTS: SaltGrams = { gypsum: 0, epsom: 0, cacl2: 0, nacl: 0, nahco3: 0 };

/** The brewery's local tap water (editable in the UI). */
export const DEFAULT_SOURCE: WaterProfile = {
  ca: 110,
  mg: 23,
  na: 37,
  cl: 100,
  so4: 75,
  hco3: 340,
};
export const DEFAULT_SOURCE_PH = 7.4;

/**
 * Upper bounds per ion, for the ones the source table states as a band to stay
 * under rather than a level to hit. Mg and Na are the cases: "0–10 ppm" means
 * anything up to 10 is fine, so grading a result against a point target of 0
 * would flag perfectly good water as 8 ppm too high. Ions absent from the record
 * are ordinary point targets.
 */
export type IonLimits = Partial<Record<Ion, number>>;

export interface TargetPreset {
  name: string;
  note: string;
  profile: WaterProfile;
  /** The table's upper bounds for the "keep it under this" ions. */
  limits: IonLimits;
}

/**
 * The starting-point target profiles, all six taken from one table of practical
 * style-led targets. Historical city waters (Burton, Dublin, Munich…) are
 * deliberately absent: they're measurements of a supply a brewery adapted to
 * — usually by treating it — not targets worth dosing towards.
 *
 * The table states *ranges*, so each number here is a chosen point inside its
 * range, picked so the profile is electrically balanced (cation meq/L ≈ anion
 * meq/L, within ~1 %) and so buildable from the salts above. Blind range
 * midpoints come out 20–30 % out of balance — they describe water that can't
 * exist from salt additions alone. Where a range starts at zero (Mg throughout,
 * Na everywhere but Porter / stout) the target is zero: salts only add, so those
 * bands are tolerances rather than something to dose up to.
 *
 * No profile carries a bicarbonate target. Alkalinity is a mash-pH lever, not a
 * flavour ion, so it's derived from the mash-pH inputs below rather than picked
 * per style — see {@link bicarbonateForResidualAlkalinity}. Each preset's note
 * keeps the table's alkalinity column as the brewer-facing summary.
 */
export const TARGET_PRESETS: TargetPreset[] = [
  { name: 'Balanced', note: 'Even SO₄:Cl — alkalinity to suit mash pH', profile: { ca: 75, mg: 0, na: 0, cl: 75, so4: 80, hco3: 0 }, limits: { mg: 10, na: 30 } },
  { name: 'West Coast IPA', note: 'Sulfate-forward, crisp bitterness — low alkalinity', profile: { ca: 120, mg: 0, na: 0, cl: 55, so4: 215, hco3: 0 }, limits: { mg: 10, na: 30 } },
  { name: 'NEIPA / juicy IPA', note: 'Chloride-forward, soft & round — low alkalinity', profile: { ca: 115, mg: 0, na: 0, cl: 150, so4: 75, hco3: 0 }, limits: { mg: 10, na: 40 } },
  { name: 'Light lager / Pilsner', note: 'Soft and low-mineral — low alkalinity', profile: { ca: 45, mg: 0, na: 0, cl: 50, so4: 40, hco3: 0 }, limits: { mg: 5, na: 20 } },
  { name: 'Porter / stout', note: 'Malt-leaning — alkalinity only to correct mash pH', profile: { ca: 60, mg: 0, na: 20, cl: 90, so4: 65, hco3: 0 }, limits: { mg: 10, na: 60 } },
  { name: 'Dark lager', note: 'Malt-leaning and restrained — alkalinity only to correct mash pH', profile: { ca: 60, mg: 0, na: 0, cl: 70, so4: 50, hco3: 0 }, limits: { mg: 10, na: 30 } },
];

/** Bands for a hand-edited target, so the grading stays sane off-preset. */
export const DEFAULT_LIMITS: IonLimits = { mg: 10, na: 30 };

// --- Profile maths ----------------------------------------------------------

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function mapProfile(p: WaterProfile, fn: (value: number, ion: Ion) => number): WaterProfile {
  const out = { ...EMPTY_PROFILE };
  for (const ion of IONS) out[ion] = fn(p[ion], ion);
  return out;
}

/** Mix in `fraction` (0–1) of zero-ion (RO/distilled) water, scaling every ion. */
export function dilute(p: WaterProfile, fraction: number): WaterProfile {
  const keep = 1 - clamp01(fraction);
  return mapProfile(p, (v) => v * keep);
}

/** ppm each salt adds to `volumeL` litres, summed across all salts, per ion. */
export function additions(salts: SaltGrams, volumeL: number): WaterProfile {
  const out = { ...EMPTY_PROFILE };
  if (volumeL <= 0) return out;
  for (const salt of SALTS) {
    const grams = salts[salt.id] || 0;
    if (grams <= 0) continue;
    for (const ion of IONS) {
      const factor = salt.ppmPerGramPerL[ion];
      if (factor) out[ion] += (factor * grams) / volumeL;
    }
  }
  return out;
}

/** Final profile = diluted source + the ions contributed by the salts. */
export function resultingProfile(
  source: WaterProfile,
  salts: SaltGrams,
  volumeL: number,
  dilution = 0,
): WaterProfile {
  const base = dilute(source, dilution);
  const add = additions(salts, volumeL);
  return mapProfile(base, (v, ion) => v + add[ion]);
}

// --- Derived water metrics --------------------------------------------------

/** Total hardness as CaCO₃ (ppm): 2.5·Ca + 4.1·Mg. */
export function hardnessCaCO3(p: WaterProfile): number {
  return 2.5 * p.ca + 4.1 * p.mg;
}

/** ppm CaCO₃ → German degrees of hardness (°dH), 1 °dH = 17.85 ppm CaCO₃. */
export function caco3ToDH(caco3: number): number {
  return caco3 / 17.85;
}

/**
 * Alkalinity as CaCO₃ (ppm) from a whole profile. Thin wrapper so callers here
 * can pass a {@link WaterProfile} rather than pulling the ion out themselves.
 */
export function alkalinityCaCO3(p: WaterProfile): number {
  return alkalinityCaCO3FromBicarbonate(p.hco3);
}

/** Kolbach residual alkalinity (ppm CaCO₃) for a whole profile. */
export function residualAlkalinity(p: WaterProfile): number {
  return residualAlkalinityCaCO3(alkalinityCaCO3(p), p.ca, p.mg);
}

// --- Mash pH, and the alkalinity it asks for --------------------------------

/**
 * The mash-pH model itself lives in `@checklist/shared` so the recipe sheet and
 * this calculator can't drift apart — they used to run separate models that
 * disagreed by up to ~0.15 pH on the same beer. Re-exported here so the page
 * keeps importing its chemistry from one module.
 *
 * Alkalinity is a mash-pH lever rather than a flavour ion, so the bicarbonate
 * target is *derived* rather than picked per style. The chain is:
 *
 *   grist's distilled-water mash pH  →  how far it must move to hit target pH
 *   →  the residual alkalinity that moves it  →  the HCO₃ that produces that RA
 *
 * Anchoring on distilled water (RA = 0) keeps this loop-free: the pH a grist
 * gives in distilled water is a property of the malt alone, so it doesn't shift
 * when the salt additions change underneath it.
 */
export {
  DEFAULT_DISTILLED_MASH_PH,
  DEFAULT_GRIST_RATIO_L_PER_KG,
  DEFAULT_TARGET_MASH_PH,
  LACTIC_88_MEQ_PER_ML,
  acidMilliequivalents,
  bicarbonateForResidualAlkalinity,
  mashBufferCapacity,
  mashWaterVolumeL,
  predictedMashPh,
  requiredResidualAlkalinity,
} from '@checklist/shared';

/**
 * Grain bill assumed when unknown, in kg. Sized to the 30 L default volume: at
 * 3 L/kg it puts 18 L in the mash and the rest in the sparge, about the split a
 * 30 L all-grain batch actually runs. A page-level seed, not chemistry, so it
 * stays here rather than in the shared model.
 */
export const DEFAULT_GRAIN_KG = 6;

/** Sulfate-to-chloride ratio. null when both are zero; Infinity when only SO₄. */
export function sulfateChlorideRatio(p: WaterProfile): number | null {
  if (p.cl <= 0) return p.so4 > 0 ? Infinity : null;
  return p.so4 / p.cl;
}

/** A flavour descriptor for an SO₄:Cl ratio (malty ↔ bitter balance). */
export function ratioDescriptor(ratio: number | null): string {
  if (ratio == null) return '—';
  if (!isFinite(ratio)) return 'Very bitter (no chloride)';
  if (ratio < 0.4) return 'Very malty';
  if (ratio < 0.8) return 'Malty';
  if (ratio < 1.5) return 'Balanced';
  if (ratio < 4) return 'Hoppy / bitter';
  return 'Very hoppy / bitter';
}

// --- Auto-suggest (best-fit salt additions) ---------------------------------

/**
 * Suggest non-negative salt grams that best match `target` from the
 * already-diluted `source` in `volumeL` litres. It's a weighted non-negative
 * least-squares fit solved by coordinate descent: for each salt in turn, set the
 * amount that best explains the remaining per-ion deficit while holding the
 * others fixed, clamped at zero. Because salts can't remove ions, the fit just
 * minimises the total squared ppm error across all six ions — it won't (and
 * can't) bring an already-too-high ion back down. Grams are rounded to 0.1 g.
 */
export function suggestSalts(
  source: WaterProfile,
  target: WaterProfile,
  volumeL: number,
): SaltGrams {
  const result = { ...EMPTY_SALTS };
  if (volumeL <= 0) return result;

  // Per-ion shortfall to make up, and each salt's ppm-per-gram column.
  const deficit = mapProfile(target, (t, ion) => t - source[ion]);
  const cols = SALTS.map((salt) =>
    mapProfile(EMPTY_PROFILE, (_v, ion) => (salt.ppmPerGramPerL[ion] ?? 0) / volumeL),
  );
  const grams = SALTS.map(() => 0);

  // Convex problem, so a fixed iteration count converges comfortably for 5 salts.
  for (let iter = 0; iter < 200; iter++) {
    for (let j = 0; j < SALTS.length; j++) {
      let num = 0;
      let den = 0;
      for (const ion of IONS) {
        const a = cols[j]![ion];
        if (a === 0) continue;
        // Residual this salt should explain: deficit minus what the others cover.
        let r = deficit[ion];
        for (let k = 0; k < SALTS.length; k++) if (k !== j) r -= cols[k]![ion] * grams[k]!;
        num += a * r;
        den += a * a;
      }
      grams[j] = den > 0 ? Math.max(0, num / den) : 0;
    }
  }

  SALTS.forEach((salt, j) => {
    result[salt.id] = Math.round(grams[j]! * 10) / 10;
  });
  return result;
}
