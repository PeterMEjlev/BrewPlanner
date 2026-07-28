/**
 * Danish kroner. Small amounts keep øre (a 20.80 kr hop addition), totals round
 * to whole kroner — nobody cares about øre on a 1,247 kr batch, and the grouping
 * makes the figure readable at a glance.
 *
 * Shared by the recipe page and the editor so a section costs the same on the
 * sheet as it did while it was being written.
 */
export function kr(amount: number, decimals = 2): string {
  return `${amount.toLocaleString('en-GB', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} kr`;
}
