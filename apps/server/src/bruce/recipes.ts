/**
 * Bruce's view of the brewery's own recipes.
 *
 * The books tell him what a hop stand does in general; this tells him what *you*
 * did last Tuesday. Without it a question like "is my IPA under-hopped?" gets a
 * textbook answer about IBU ranges, because he has never seen the recipe.
 *
 * Two halves, and the split matters:
 *
 *   - `recipeShelf()` puts the *titles* in his instructions every turn — name,
 *     style, ABV, IBU, when it was written. Small (a line each), and it is what
 *     lets him answer "which recipes do I have?" and know that "the saison"
 *     refers to something real.
 *   - `get_recipe` is a tool he calls when he needs the actual brew sheet. A
 *     full sheet is ~2k tokens of grain bill, hop schedule and water targets;
 *     sending all of them every turn would cost more than the answer is worth,
 *     and bury the retrieved book passages in a wall of ingredient lines.
 *
 * Both read BrewPlanner's local recipe library, so advice works without an
 * external service or API key after the legacy import.
 */

import type { Recipe, RecipeDetail } from '@checklist/shared';
import * as recipeRepo from '../recipeRepo.js';

/** The tool the model calls to pull one recipe's full brew sheet. */
export const RECIPE_TOOL = {
  type: 'function',
  name: 'get_recipe',
  description:
    "Read one of the brewery's own recipes in full: grain bill, hop schedule, yeast, mash steps, water targets and batch size. Call this before giving advice about a specific recipe — the list in your instructions has only the headline numbers. Match the name loosely; the brewer will use their own shorthand.",
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: "The recipe's name as it appears in the recipe list in your instructions.",
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
  strict: true,
} as const;

/** Lower-case, punctuation-free, single-spaced — for comparing names by hand. */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find the recipe the model meant.
 *
 * The model is asked to quote the name from the list, but it paraphrases — "the
 * NEIPA" for "Hazy Boi NEIPA v3" — so the match widens in steps: exact, then
 * one name containing the other, then the most words in common. The last stage
 * needs at least one shared word, so a miss stays a miss rather than returning
 * whichever recipe happened to sort first.
 */
export function matchRecipe(recipes: Recipe[], wanted: string): Recipe | null {
  const target = normalize(wanted);
  if (!target) return null;

  const exact = recipes.find((r) => normalize(r.name) === target);
  if (exact) return exact;

  const contains = recipes.find((r) => {
    const name = normalize(r.name);
    return name.includes(target) || target.includes(name);
  });
  if (contains) return contains;

  const words = new Set(target.split(' '));
  let best: { recipe: Recipe; score: number } | null = null;
  for (const recipe of recipes) {
    const score = normalize(recipe.name)
      .split(' ')
      .filter((word) => words.has(word)).length;
    if (score > 0 && (!best || score > best.score)) best = { recipe, score };
  }
  return best?.recipe ?? null;
}

/** `"4.5"` → `"4.5"`, `""`/null → null. Keeps empty fields out of the text. */
function value(raw: string | null | undefined): string | null {
  const text = raw?.trim();
  return text ? text : null;
}

/** `label: value` lines, skipping everything the recipe left blank. */
function facts(pairs: [string, string | number | null | undefined][]): string {
  return pairs
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([label, v]) => `- ${label}: ${String(v).trim()}`)
    .join('\n');
}

/**
 * A recipe as markdown for the model to read.
 *
 * Written the way the books it is reading alongside are written — headings and
 * short lines — rather than as JSON. The same numbers either way, but prose
 * keeps the model comparing it against Palmer instead of describing a schema.
 */
export function renderRecipe(recipe: RecipeDetail): string {
  const parts: string[] = [`# ${recipe.name}`];

  parts.push(
    facts([
      ['Style', recipe.style],
      ['Batch size', recipe.batchSizeL != null ? `${recipe.batchSizeL} L` : null],
      ['OG', recipe.og],
      ['FG', recipe.fg],
      ['ABV', value(recipe.abv) ? `${recipe.abv} %` : null],
      ['IBU (Tinseth)', recipe.ibu],
      ['Colour', value(recipe.ebc) ? `${recipe.ebc} EBC${recipe.ebcEstimated ? ' (estimated from the grain bill)' : ''}` : null],
      ['Pre-boil gravity', recipe.preBoilGravity],
      ['Mash temperature', recipe.mashTemp],
      ['Fermentation temperature', recipe.fermentationTemp],
    ]),
  );

  if (recipe.fermentables.length > 0) {
    parts.push(
      '## Fermentables\n' +
        recipe.fermentables
          .map((f) => {
            const extras = [
              value(f.percent) ? `${f.percent} %` : null,
              f.ebc != null ? `${Math.round(f.ebc)} EBC` : null,
              f.ppg != null ? `${Math.round(f.ppg)} PPG` : null,
            ].filter(Boolean);
            return `- ${f.amount} ${f.unit} ${f.name}${extras.length ? ` (${extras.join(', ')})` : ''}`;
          })
          .join('\n'),
    );
  }

  if (recipe.hops.length > 0) {
    parts.push(
      '## Hops\n' +
        recipe.hops
          .map((h) => {
            const when = [
              h.use || h.stage,
              value(h.time) ? `${h.time} ${h.timeUnit || 'min'}` : null,
              value(h.temp) ? `${h.temp} °C` : null,
            ]
              .filter(Boolean)
              .join(', ');
            const detail = [
              value(h.aa) ? `${h.aa} % AA` : null,
              value(h.ibu) ? `${h.ibu} IBU` : null,
              value(h.form),
              value(h.utilization) ? `${h.utilization} % utilisation` : null,
            ].filter(Boolean);
            return `- ${h.amount} ${h.unit} ${h.name} — ${when}${detail.length ? ` (${detail.join(', ')})` : ''}`;
          })
          .join('\n'),
    );
  }

  if (recipe.yeast.length > 0) {
    parts.push(
      '## Yeast\n' +
        recipe.yeast
          .map((y) => {
            const detail = [
              [y.lab, y.form, y.type].filter(Boolean).join(' ') || null,
              value(y.attenuation) ? `${y.attenuation} % attenuation` : null,
              y.minTempC != null && y.maxTempC != null ? `${y.minTempC}–${y.maxTempC} °C` : null,
              value(y.flocculation) ? `${y.flocculation} flocculation` : null,
              y.starter ? 'starter' : null,
            ].filter(Boolean);
            return `- ${y.amount} ${y.amountUnit} ${y.name}${detail.length ? ` (${detail.join(', ')})` : ''}`;
          })
          .join('\n'),
    );
  }

  if (recipe.otherIngredients.length > 0) {
    parts.push(
      '## Other ingredients\n' +
        recipe.otherIngredients
          .map((o) => {
            const when = [o.use, value(o.time) ? `${o.time} ${o.timeUnit || 'min'}` : null].filter(Boolean).join(', ');
            return `- ${o.amount} ${o.unit} ${o.name}${when ? ` — ${when}` : ''}`;
          })
          .join('\n'),
    );
  }

  const mash = recipe.mashGuidelines;
  if (mash && (mash.steps.length > 0 || mash.notes)) {
    const steps = mash.steps
      .map((s) =>
        `- ${[s.type || s.name || 'Rest', s.startTemp ? `start ${s.startTemp} °C` : null, s.temp, value(s.time) ? `${s.time} min` : null, s.amount ? `${s.amount}${s.amountUnit ? ` ${s.amountUnit}` : ''}` : null, s.description]
          .filter(Boolean)
          .join(' — ')}`,
      )
      .join('\n');
    parts.push(`## Mash\n${steps}${mash.notes ? `\n\nNotes: ${mash.notes}` : ''}`);
  }

  const water = recipe.waterProfile;
  if (water) {
    parts.push(
      `## Target water profile${water.name ? ` — ${water.name}` : ''}\n` +
        facts([
          ['Source water', water.sourceName],
          ['Ca²⁺', water.calcium != null ? `${water.calcium} ppm` : null],
          ['Mg²⁺', water.magnesium != null ? `${water.magnesium} ppm` : null],
          ['Na⁺', water.sodium != null ? `${water.sodium} ppm` : null],
          ['Cl⁻', water.chloride != null ? `${water.chloride} ppm` : null],
          ['SO₄²⁻', water.sulfate != null ? `${water.sulfate} ppm` : null],
          ['HCO₃⁻', water.bicarbonate != null ? `${water.bicarbonate} ppm` : null],
          ['Target mash pH', water.ph],
          ['Notes', water.notes],
        ]),
    );
  }

  return parts.filter((part) => part.trim().length > 0).join('\n\n');
}

/**
 * The recipe list for the instructions: one line each, newest first.
 *
 * Null rather than an empty string when there is nothing to say (no Brewer's
 * Friend key, or the account has no recipes) so the caller can leave the whole
 * section out — an empty heading reads as "your recipes are gone".
 *
 * Never throws. Brewer's Friend being down is not a reason for Bruce to stop
 * answering questions about beer; he simply doesn't have the shelf that turn.
 */
export async function recipeShelf(): Promise<string | null> {
  const recipes = recipeRepo.listRecipes();
  if (recipes.length === 0) return null;

  return recipes
    .map((r) => {
      const detail = [
        r.style || null,
        value(r.abv) ? `${r.abv} % ABV` : null,
        value(r.ibu) ? `${r.ibu} IBU` : null,
        value(r.ebc) ? `${r.ebc} EBC` : null,
        r.createdAt ? r.createdAt.slice(0, 10) : null,
      ].filter(Boolean);
      return `- ${r.name}${detail.length ? ` — ${detail.join(', ')}` : ''}`;
    })
    .join('\n');
}

/**
 * Run one `get_recipe` call and return what the model should read.
 *
 * Every failure comes back as text, not an exception: a tool that throws takes
 * the whole answer down, where a tool that says "there is no recipe called that,
 * here are the ones there are" lets the model correct itself and carry on. The
 * name it matched is stated so a wrong match is visible in the answer rather
 * than silently attributed to the recipe the brewer asked about.
 */
export async function runRecipeTool(wanted: string): Promise<{ text: string; matched: string | null }> {
  const recipes = recipeRepo.listRecipes();

  const match = matchRecipe(recipes, wanted);
  if (!match) {
    const names = recipes.map((r) => r.name).join(', ');
    return {
      text: `No recipe matches "${wanted}". The recipes in BrewPlanner are: ${names || 'none'}.`,
      matched: null,
    };
  }

  const detail: RecipeDetail | null = recipeRepo.getRecipe(match.id);
  if (!detail) {
    return { text: `"${match.name}" is in the list but its brew sheet could not be found.`, matched: null };
  }

  const link = detail.url ? `\n\nRecipe page: ${detail.url}` : '';
  return {
    text: `This is the brewery's recipe "${detail.name}" (matched from "${wanted}").\n\n${renderRecipe(detail)}${link}`,
    matched: detail.name,
  };
}
