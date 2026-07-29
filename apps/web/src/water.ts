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
 */

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

/** Alkalinity as CaCO₃ (ppm) from bicarbonate: HCO₃ · 50/61. */
export function alkalinityCaCO3(p: WaterProfile): number {
  return p.hco3 * (50 / 61);
}

/**
 * Kolbach residual alkalinity as CaCO₃ (ppm): alkalinity offset by the
 * mash-acidifying effect of calcium and magnesium. Lower (even negative) suits
 * pale beers; higher suits dark, roasty beers.
 */
export function residualAlkalinity(p: WaterProfile): number {
  return alkalinityCaCO3(p) - (p.ca / 1.4 + p.mg / 1.7);
}

// --- Mash pH, and the alkalinity it asks for --------------------------------

/**
 * Alkalinity is a mash-pH lever rather than a flavour ion, so the bicarbonate
 * target is *derived* here instead of being picked per style. The chain is:
 *
 *   grist's distilled-water mash pH  →  how far it must move to hit target pH
 *   →  the residual alkalinity that moves it  →  the HCO₃ that produces that RA
 *
 * Anchoring on distilled water (RA = 0) keeps this loop-free: the pH a grist
 * gives in distilled water is a property of the malt alone, so it doesn't shift
 * when the salt additions change underneath it.
 */

/** Room-temperature mash pH to aim for. The 5.2–5.6 band's midpoint. */
export const DEFAULT_TARGET_MASH_PH = 5.4;

/**
 * Distilled-water mash pH assumed when the brewer hasn't measured one. A pale
 * all-malt grist lands near here; roast and crystal drag it down (a dry stout
 * can reach 5.2), acid malt further still.
 */
export const DEFAULT_DISTILLED_MASH_PH = 5.7;

/** Mash thickness assumed when unknown, in litres of strike water per kg grain. */
export const DEFAULT_GRIST_RATIO_L_PER_KG = 3;

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

/** ppm CaCO₃ per mEq/L — the equivalent weight of calcium carbonate. */
const CACO3_EQ_WEIGHT = 50;

/**
 * The residual alkalinity (ppm CaCO₃) the brewing water must carry to land the
 * mash at `targetPh`, given the pH this grist reaches in distilled water.
 * Negative means the grist is already acid enough and the water must take pH
 * *up*'s opposite — i.e. acid is needed, not bicarbonate.
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
 * magnesium — {@link residualAlkalinity} rearranged for HCO₃. Negative when
 * calcium and magnesium alone already acidify past the requirement, which is
 * the signal that no salt can help and acid is the only route.
 */
export function bicarbonateForResidualAlkalinity(ra: number, ca: number, mg: number): number {
  return (ra + ca / 1.4 + mg / 1.7) * (61 / 50);
}

/** Where the mash actually lands, given the RA the water ends up delivering. */
export function predictedMashPh(
  distilledMashPh: number,
  ra: number,
  bufferCapacity: number,
): number {
  if (bufferCapacity <= 0) return distilledMashPh;
  return distilledMashPh + ra / (bufferCapacity * CACO3_EQ_WEIGHT);
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
