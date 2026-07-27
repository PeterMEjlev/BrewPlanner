import type { IngredientKind, IngredientPriceOverride, PriceUnit } from '@checklist/shared';
import { and, eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { ingredientPrices } from './db/schema.js';

/**
 * Storage for the brewer's own pricing decisions — which listing an ingredient is
 * priced against, and what it costs when the catalogue is wrong or silent.
 *
 * Deliberately a thin layer over the table: the rules for *applying* an override
 * live in prices.ts, which is the only reader. Kept in its own module so prices.ts
 * can stay free of database imports beyond this one, and so the costing can be
 * reasoned about as "catalogue + this table".
 */

/** One stored decision, keyed the way prices.ts looks it up. */
export interface StoredOverride extends IngredientPriceOverride {
  /** Normalized match key this row is filed under. */
  ingredient: string;
}

function toOverride(row: typeof ingredientPrices.$inferSelect): StoredOverride {
  return {
    ingredient: row.ingredient,
    kind: row.kind as IngredientKind,
    label: row.label,
    catalogueId: row.catalogueId,
    unitPriceDkk: row.unitPriceDkk,
    // Written only through the validated route, so anything else is a hand-edited
    // row; treating it as absent leaves the ingredient priced automatically
    // rather than costing a batch against a unit nothing understands.
    priceUnit: row.priceUnit === 'kg' || row.priceUnit === 'pack' ? row.priceUnit : null,
    packageSizeG: row.packageSizeG,
    updatedAt: row.updatedAt,
  };
}

/** Every stored decision. Small by nature — one row per ingredient ever edited. */
export function listOverrides(): StoredOverride[] {
  return db.select().from(ingredientPrices).all().map(toOverride);
}

/**
 * Save (or replace) the decision for one ingredient. Last write wins: the picker
 * always sends the complete decision, so a save that pins a product without a
 * price genuinely means "no manual price" rather than "leave the old one".
 */
export function saveOverride(input: {
  kind: IngredientKind;
  ingredient: string;
  label: string;
  catalogueId: string | null;
  unitPriceDkk: number | null;
  priceUnit: PriceUnit | null;
  packageSizeG: number | null;
}): StoredOverride {
  const row = {
    kind: input.kind,
    ingredient: input.ingredient,
    label: input.label,
    catalogueId: input.catalogueId,
    unitPriceDkk: input.unitPriceDkk,
    priceUnit: input.priceUnit,
    packageSizeG: input.packageSizeG,
    updatedAt: new Date().toISOString(),
  };
  db.insert(ingredientPrices)
    .values(row)
    .onConflictDoUpdate({
      target: [ingredientPrices.kind, ingredientPrices.ingredient],
      set: {
        label: row.label,
        catalogueId: row.catalogueId,
        unitPriceDkk: row.unitPriceDkk,
        priceUnit: row.priceUnit,
        packageSizeG: row.packageSizeG,
        updatedAt: row.updatedAt,
      },
    })
    .run();
  return { ...row, priceUnit: row.priceUnit };
}

/** Return an ingredient to automatic pricing. True when a row was actually removed. */
export function deleteOverride(kind: IngredientKind, ingredient: string): boolean {
  const result = db
    .delete(ingredientPrices)
    .where(and(eq(ingredientPrices.kind, kind), eq(ingredientPrices.ingredient, ingredient)))
    .run();
  return result.changes > 0;
}
