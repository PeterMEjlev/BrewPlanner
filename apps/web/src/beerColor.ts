/**
 * Beer colour swatches from an EBC number.
 *
 * Distinct from `kegContentColors` — that maps a *style name* to a palette
 * colour the brewery picked ("Hazy IPA is orange"), which is what the keg boards
 * and the fermenter card use. This is the physical colour of the beer implied by
 * the recipe's measured EBC, so a recipe's swatch looks like what will be in the
 * glass.
 */

/**
 * The standard SRM reference chart, index 0 = SRM 1 … index 39 = SRM 40+.
 * Beyond 40 everything is effectively black.
 */
const SRM_COLORS = [
  '#FFE699', '#FFD878', '#FFCA5A', '#FFBF42', '#FBB123',
  '#F8A600', '#F39C00', '#EA8F00', '#E58500', '#DE7C00',
  '#D77200', '#CF6900', '#CB6200', '#C35900', '#BB5100',
  '#B54C00', '#A63E00', '#8D3200', '#7C2A00', '#6B2400',
  '#5E1E00', '#531A00', '#4A1700', '#421500', '#3B1200',
  '#341000', '#2E0E00', '#290C00', '#250B00', '#200A00',
  '#1C0900', '#180800', '#150700', '#120600', '#100500',
  '#0E0500', '#0C0400', '#0A0300', '#080300', '#060200',
];

/** EBC → SRM, the standard 1.97 factor. */
export function ebcToSrm(ebc: number): number {
  return ebc / 1.97;
}

/**
 * The beer colour for an EBC value as #rrggbb, or null when the value isn't a
 * number (an empty field from the API) — callers render a hollow swatch then.
 * Accepts the strings the API returns as well as numbers.
 */
export function ebcColor(ebc: string | number | null | undefined): string | null {
  const n = typeof ebc === 'number' ? ebc : Number.parseFloat(String(ebc ?? ''));
  if (!Number.isFinite(n)) return null;
  const index = Math.min(Math.max(Math.round(ebcToSrm(n)) - 1, 0), SRM_COLORS.length - 1);
  return SRM_COLORS[index] ?? null;
}
