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

export interface TargetPreset {
  name: string;
  note: string;
  profile: WaterProfile;
}

/**
 * A handful of starting-point target profiles — flavour-led styles plus a few
 * classic brewing cities. Approximate (water profiles vary by source and era);
 * they fill the target fields, which the brewer then tweaks.
 */
export const TARGET_PRESETS: TargetPreset[] = [
  { name: 'Balanced', note: 'All-round profile', profile: { ca: 80, mg: 5, na: 25, cl: 75, so4: 80, hco3: 0 } },
  { name: 'Hoppy / Pale Ale', note: 'Sulfate-forward, crisp bitterness', profile: { ca: 110, mg: 18, na: 17, cl: 50, so4: 275, hco3: 0 } },
  { name: 'Malty / NEIPA', note: 'Chloride-forward, soft & round', profile: { ca: 110, mg: 18, na: 17, cl: 150, so4: 75, hco3: 0 } },
  { name: 'Light Lager / Pilsner', note: 'Very soft, Pilsen-like', profile: { ca: 7, mg: 2, na: 2, cl: 5, so4: 5, hco3: 15 } },
  { name: 'Stout / Porter', note: 'Dark & alkaline, Dublin-like', profile: { ca: 118, mg: 4, na: 12, cl: 19, so4: 54, hco3: 280 } },
  { name: 'Burton (IPA)', note: 'Very sulfate-rich, Burton-on-Trent', profile: { ca: 275, mg: 40, na: 25, cl: 35, so4: 610, hco3: 270 } },
  { name: 'Munich (dark lager)', note: 'Malty & alkaline', profile: { ca: 75, mg: 18, na: 10, cl: 2, so4: 10, hco3: 200 } },
];

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
