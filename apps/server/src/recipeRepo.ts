import { randomUUID } from 'node:crypto';
import type {
  Recipe,
  RecipeDetail,
  RecipeEditInput,
  IngredientKind,
  RecipeOrigin,
  RecipeIngredientOption,
  RecipeStats,
} from '@checklist/shared';
import { applyRecipeCalculations, recipeEditSchema } from '@checklist/shared';
import { desc, eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { recipes } from './db/schema.js';
import { editableRecipe, hydrateRecipe, recipeStats } from './recipeData.js';
import { getSetting } from './repo.js';

type RecipeRow = typeof recipes.$inferSelect;

function rowToDetail(row: RecipeRow): RecipeDetail {
  const input = rowInput(row);
  const origin: RecipeOrigin = row.origin === 'brewersfriend' ? 'brewersfriend' : 'local';
  return hydrateRecipe(
    {
      id: row.id,
      origin,
      url: row.brewersFriendUrl,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    input,
  );
}

function rowInput(row: RecipeRow): RecipeEditInput {
  return recipeEditSchema.parse(JSON.parse(row.recipe));
}

function rowToSummary(row: RecipeRow): Recipe {
  const input = rowInput(row);
  return {
    id: row.id,
    origin: row.origin === 'brewersfriend' ? 'brewersfriend' : 'local',
    name: input.name,
    style: input.style,
    abv: input.abv,
    url: row.brewersFriendUrl,
    ibu: input.ibu,
    ebc: input.ebc,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listRecipes(): Recipe[] {
  return db
    .select()
    .from(recipes)
    .orderBy(desc(recipes.createdAt))
    .all()
    .map(rowToSummary);
}

export function listRecipeDetails(): RecipeDetail[] {
  return db.select().from(recipes).orderBy(desc(recipes.createdAt)).all().map(rowToDetail);
}

export function listRecipeStats(): RecipeStats[] {
  return listRecipeDetails().map(recipeStats);
}

/** Ingredients already used in this library, including brewing metadata for the comboboxes. */
export function listRecipeIngredientOptions(
  kind: IngredientKind,
  query = '',
  limit = 60,
): RecipeIngredientOption[] {
  const wanted = query.trim().toLocaleLowerCase();
  const options = new Map<string, RecipeIngredientOption>();
  const add = (name: string, metadata: Pick<RecipeIngredientOption, 'ebc' | 'aa' | 'yeast'> = {}) => {
    const trimmed = name.trim();
    if (!trimmed || (wanted && !trimmed.toLocaleLowerCase().includes(wanted))) return;
    const key = trimmed.toLocaleLowerCase();
    const existing = options.get(key);
    options.set(key, {
      name: existing?.name ?? trimmed,
      source: 'recipe',
      ebc: existing?.ebc ?? metadata.ebc ?? null,
      aa: existing?.aa ?? metadata.aa ?? null,
      yeast: existing?.yeast ?? metadata.yeast ?? null,
    });
  };
  for (const row of db.select().from(recipes).all()) {
    const input = rowInput(row);
    if (kind === 'fermentable') {
      for (const line of input.fermentables) add(line.name, { ebc: line.ebc });
    } else if (kind === 'hop') {
      for (const line of input.hops) {
        const aa = Number.parseFloat(line.aa.replace(',', '.'));
        add(line.name, { aa: Number.isFinite(aa) ? aa : null });
      }
    } else if (kind === 'yeast') {
      // A strain this brewery has pitched before is described by how the recipe
      // it came from describes it, which beats the built-in table: the numbers
      // travelled with the recipe from Brewer's Friend, and where the brewer
      // has since corrected one, the correction is what should come back.
      for (const line of input.yeast) {
        add(line.name, {
          yeast: {
            lab: line.lab,
            type: line.type,
            form: line.form,
            attenuation: line.attenuation,
            flocculation: line.flocculation,
            minTempC: line.minTempC,
            maxTempC: line.maxTempC,
            alcoholTolerance: line.alcoholTolerance,
          },
        });
      }
    } else {
      for (const line of input.otherIngredients) add(line.name);
    }
  }
  return [...options.values()]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .slice(0, limit);
}

export function listIngredientNames(kind: IngredientKind, query = '', limit = 60): string[] {
  return listRecipeIngredientOptions(kind, query, limit).map((option) => option.name);
}

export function getRecipe(id: string): RecipeDetail | null {
  const row = db.select().from(recipes).where(eq(recipes.id, id)).get();
  return row ? rowToDetail(row) : null;
}

export function createRecipe(input: RecipeEditInput): RecipeDetail {
  const now = new Date().toISOString();
  const id = randomUUID();
  const calculated = applyRecipeCalculations(input);
  db.insert(recipes)
    .values({
      id,
      origin: 'local',
      recipe: JSON.stringify(calculated),
      brewersFriendUrl: '',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getRecipe(id)!;
}

export function updateRecipe(id: string, input: RecipeEditInput): RecipeDetail | null {
  const calculated = applyRecipeCalculations(input);
  const result = db
    .update(recipes)
    .set({ recipe: JSON.stringify(calculated), updatedAt: new Date().toISOString() })
    .where(eq(recipes.id, id))
    .run();
  return result.changes > 0 ? getRecipe(id) : null;
}

export function deleteRecipe(id: string): boolean {
  return db.delete(recipes).where(eq(recipes.id, id)).run().changes > 0;
}

/**
 * Insert one legacy recipe without overwriting an app-owned edit. Re-running an
 * import is therefore safe: existing ids are skipped and only new BF recipes
 * join the library.
 */
export function importBrewersFriendRecipe(recipe: RecipeDetail): boolean {
  const input = legacyEditedInput(recipe.id) ?? editableRecipe(recipe);
  const result = db
    .insert(recipes)
    .values({
      id: recipe.id,
      origin: 'brewersfriend',
      brewersFriendId: recipe.id,
      brewersFriendUrl: recipe.url,
      recipe: JSON.stringify(input),
      createdAt: recipe.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();
  return result.changes > 0;
}

/** Number of durable app recipes, used to decide whether initial import is due. */
export function recipeCount(): number {
  return db.select({ id: recipes.id }).from(recipes).all().length;
}

/**
 * Compatibility with the short-lived local-override format from older builds.
 * If an imported recipe had already been edited, its edited sheet wins during
 * migration so upgrading cannot silently put the upstream values back.
 */
function legacyEditedInput(id: string): RecipeEditInput | null {
  const raw = getSetting('recipe_edits');
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as Record<string, { recipe?: unknown }>;
    const parsed = recipeEditSchema.safeParse(record[id]?.recipe);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
