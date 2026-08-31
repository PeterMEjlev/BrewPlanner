export type MissingWeightUnitPolicy = 'assume-grams' | 'reject';

function positiveAmount(value: string | number): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/** Convert a normalized ingredient weight to grams. Callers choose how a blank unit is handled. */
export function weightToGrams(
  value: string | number,
  unit: string,
  missingUnit: MissingWeightUnitPolicy,
): number | null {
  const amount = positiveAmount(value);
  if (amount == null) return null;

  switch (unit.toLowerCase()) {
    case 'g':
    case 'gram':
    case 'grams':
      return amount;
    case 'kg':
      return amount * 1_000;
    case 'oz':
      return amount * 28.3495;
    case 'lb':
    case 'lbs':
      return amount * 453.592;
    case 'mg':
      return amount / 1_000;
    case '':
      return missingUnit === 'assume-grams' ? amount : null;
    default:
      return null;
  }
}

/** Return a positive ingredient count only for units the catalogue sells per item. */
export function countUnits(value: string | number, unit: string): number | null {
  const amount = positiveAmount(value);
  if (amount == null) return null;

  switch (unit.toLowerCase()) {
    case 'pkg':
    case 'pkgs':
    case 'each':
    case 'items':
    case 'vial':
      return amount;
    default:
      return null;
  }
}
