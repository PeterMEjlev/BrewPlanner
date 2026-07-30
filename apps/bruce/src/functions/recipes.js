'use strict';

/**
 * The recipe library, and which beer is in the fermenter right now.
 *
 * Read-only over the library itself — writing a grain bill by voice is worse
 * than the recipe editor at every step, so `get_recipe_details` reads a brew
 * sheet out and nothing here creates or deletes one. What Bruce *can* change is
 * the selection: which recipe is in the fermenter, and whether the empty tank
 * has been washed. Those are two words each, said standing next to the vessel,
 * which is exactly where a voice assistant beats a keyboard.
 *
 * A brew sheet is two pages of ingredient lines, so the default answer is the
 * headline numbers and the shape of the grain bill; a section (or the whole
 * sheet) only comes out when it is asked for.
 */

// How many recipes an unfiltered "what recipes do I have?" hands the model.
// The library is 30-odd deep; read aloud that is several minutes of monologue.
const SPOKEN_LIST_MAX = 8;

// ── Name matching ───────────────────────────────────────────────────────────
//
// Mirrors the server's matchRecipe (apps/server/src/bruce/recipes.ts): nobody
// says "Hazy Boi NEIPA v3" out loud, they say "the NEIPA". Widen in steps —
// exact, then one name containing the other, then the most words in common —
// and require at least one shared word so a miss stays a miss.

function normalize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchRecipe(recipes, wanted) {
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
  let best = null;
  for (const recipe of recipes) {
    const score = normalize(recipe.name)
      .split(' ')
      .filter((word) => words.has(word)).length;
    if (score > 0 && (!best || score > best.score)) best = { recipe, score };
  }
  return best ? best.recipe : null;
}

// ── Speech helpers ──────────────────────────────────────────────────────────

/** A trimmed value, or null — keeps empty recipe fields out of the sentence. */
function value(raw) {
  const text = raw == null ? '' : String(raw).trim();
  return text ? text : null;
}

/**
 * Round a stored number for speech. The library holds values like
 * `5.64756` (imported from Brewer's Friend); spoken aloud that becomes
 * "five point six four seven five six percent", which is nobody's idea of an
 * answer.
 */
function spokenNumber(raw, decimals) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return String(Number(n.toFixed(decimals)));
}

/** "a West Coast IPA, 6.2% ABV, 55 IBU" — whichever of those the recipe states. */
function headline(recipe) {
  const abv = spokenNumber(recipe.abv, 1);
  const ibu = spokenNumber(recipe.ibu, 0);
  const ebc = spokenNumber(recipe.ebc, 0);
  const parts = [
    value(recipe.style),
    abv ? `${abv}% ABV` : null,
    ibu ? `${ibu} IBU` : null,
    ebc ? `${ebc} EBC` : null,
  ].filter(Boolean);
  return parts.join(', ');
}

/** "Citra", "Citra and Mosaic", "Citra, Mosaic, and Simcoe". */
function spokenList(names) {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function fermentableLines(recipe) {
  return recipe.fermentables.map((f) => {
    const pct = value(f.percent) ? ` (${f.percent}%)` : '';
    return `${f.amount} ${f.unit} ${f.name}${pct}`;
  });
}

function hopLines(recipe) {
  return recipe.hops.map((h) => {
    const when = [value(h.use) || value(h.stage), value(h.time) ? `${h.time} ${h.timeUnit || 'min'}` : null]
      .filter(Boolean)
      .join(' at ');
    return `${h.amount} ${h.unit} ${h.name}${when ? ` — ${when}` : ''}`;
  });
}

function yeastLines(recipe) {
  return recipe.yeast.map((y) => {
    const detail = [value(y.lab), value(y.attenuation) ? `${y.attenuation}% attenuation` : null]
      .filter(Boolean)
      .join(', ');
    return `${y.amount} ${y.amountUnit} ${y.name}${detail ? ` (${detail})` : ''}`;
  });
}

function mashLines(recipe) {
  const mash = recipe.mashGuidelines;
  if (!mash || mash.steps.length === 0) return [];
  return mash.steps.map((s) => {
    const how = [value(s.temp), value(s.time) ? `${s.time} minutes` : null].filter(Boolean).join(' for ');
    return `${s.type || s.name || 'Rest'}${how ? ` at ${how}` : ''}`;
  });
}

function waterLines(recipe) {
  const w = recipe.waterProfile;
  if (!w) return [];
  const ions = [
    w.calcium != null ? `calcium ${w.calcium}` : null,
    w.magnesium != null ? `magnesium ${w.magnesium}` : null,
    w.sodium != null ? `sodium ${w.sodium}` : null,
    w.chloride != null ? `chloride ${w.chloride}` : null,
    w.sulfate != null ? `sulfate ${w.sulfate}` : null,
    w.bicarbonate != null ? `bicarbonate ${w.bicarbonate}` : null,
  ].filter(Boolean);
  const lines = [];
  if (ions.length) lines.push(`${ions.join(', ')} — all in parts per million.`);
  if (value(w.ph)) lines.push(`Target mash pH ${w.ph}.`);
  return lines;
}

// ── Register recipe functions on Bruce ──────────────────────────────────────

function register(bruce, apiCall) {
  /** The library, or a spoken "there isn't one" for the caller to return. */
  async function library() {
    const recipes = await apiCall('GET', '/api/recipes');
    return Array.isArray(recipes) ? recipes : [];
  }

  // ── The library ────────────────────────────────────────────────────────

  bruce.registerFunction(
    'get_recipes',
    "List the brewery's own recipes with their headline numbers — name, style, ABV, IBU and colour. Use for \"what recipes do I have?\", \"which is my strongest beer?\", or to find the name of a recipe before another function needs it. Give a search term to narrow it down; call get_recipe_details for one recipe's actual ingredients.",
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional filter — only recipes whose name or style contains this text' },
      },
      required: [],
    },
    async ({ query } = {}) => {
      let recipes = await library();
      if (recipes.length === 0) return 'There are no recipes in BrewPlanner yet.';

      if (query) {
        const needle = normalize(query);
        recipes = recipes.filter(
          (r) => normalize(r.name).includes(needle) || normalize(r.style).includes(needle),
        );
        if (recipes.length === 0) return `No recipe matches "${query}".`;
      }

      const lines = [
        query
          ? `${recipes.length} recipe${recipes.length !== 1 ? 's' : ''} match "${query}".`
          : `You have ${recipes.length} recipe${recipes.length !== 1 ? 's' : ''}.`,
      ];

      // Spoken, not printed: reading 30-odd recipes aloud takes minutes and is
      // useless. Hand the model a few and tell it to ask for a narrower query
      // — it can always call again with one.
      const shown = recipes.slice(0, SPOKEN_LIST_MAX);
      for (const recipe of shown) {
        const detail = headline(recipe);
        lines.push(`${recipe.name}${detail ? ` — ${detail}` : ''}.`);
      }
      if (recipes.length > shown.length) {
        lines.push(
          `(Only the ${shown.length} most recent are listed; ${recipes.length - shown.length} older ones are not. ` +
            'Do NOT read this list out in full — say how many there are, mention a couple, ' +
            'and ask which style or name they are after.)',
        );
      }
      return lines.join('\n');
    },
  );

  bruce.registerFunction(
    'get_recipe_details',
    'Read one recipe\'s brew sheet. Match the name loosely — "the NEIPA" finds "Hazy Boi NEIPA v3". Defaults to a summary (numbers, batch size, and how many of each ingredient); ask for a section when the user wants the actual list — "what hops are in the IPA?" is section "hops".',
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The recipe name, or the shorthand the user said' },
        section: {
          type: 'string',
          enum: ['summary', 'fermentables', 'hops', 'yeast', 'mash', 'water', 'full'],
          description: 'Which part to read out — "summary" (default) is the numbers only',
        },
      },
      required: ['name'],
    },
    async ({ name, section = 'summary' }) => {
      const recipes = await library();
      const match = matchRecipe(recipes, name);
      if (!match) {
        const names = recipes.map((r) => r.name).join(', ');
        return names
          ? `No recipe matches "${name}". The recipes are: ${names}.`
          : 'There are no recipes in BrewPlanner yet.';
      }

      const recipe = await apiCall('GET', `/api/recipes/${encodeURIComponent(match.id)}`);
      const lines = [];

      // The summary always leads, so a section answer still says which beer it
      // is — the model paraphrases names, and a wrong match must be audible.
      const numbers = [
        value(recipe.style),
        recipe.batchSizeL != null ? `${recipe.batchSizeL} litre batch` : null,
        value(recipe.og) ? `OG ${recipe.og}` : null,
        value(recipe.fg) ? `FG ${recipe.fg}` : null,
        value(recipe.abv) ? `${recipe.abv}% ABV` : null,
        value(recipe.ibu) ? `${recipe.ibu} IBU` : null,
        value(recipe.ebc) ? `${recipe.ebc} EBC` : null,
      ].filter(Boolean);
      lines.push(`${recipe.name} — ${numbers.join(', ')}.`);

      const want = (part) => section === 'full' || section === part;

      if (section === 'summary') {
        const hopNames = [...new Set(recipe.hops.map((h) => h.name))];
        if (recipe.fermentables.length) {
          lines.push(`${recipe.fermentables.length} fermentable${recipe.fermentables.length !== 1 ? 's' : ''}, led by ${recipe.fermentables[0].name}.`);
        }
        if (hopNames.length) lines.push(`Hopped with ${spokenList(hopNames)}.`);
        if (recipe.yeast.length) lines.push(`Pitched with ${spokenList(recipe.yeast.map((y) => y.name))}.`);
        if (value(recipe.mashTemp)) lines.push(`Mashed at ${recipe.mashTemp}.`);
        if (value(recipe.fermentationTemp)) lines.push(`Fermented at ${recipe.fermentationTemp}.`);
        return lines.join('\n');
      }

      if (want('fermentables')) {
        const list = fermentableLines(recipe);
        lines.push(list.length ? `Fermentables: ${list.join('. ')}.` : 'No fermentables listed.');
      }
      if (want('hops')) {
        const list = hopLines(recipe);
        lines.push(list.length ? `Hops: ${list.join('. ')}.` : 'No hops listed.');
      }
      if (want('yeast')) {
        const list = yeastLines(recipe);
        lines.push(list.length ? `Yeast: ${list.join('. ')}.` : 'No yeast listed.');
      }
      if (want('mash')) {
        const list = mashLines(recipe);
        lines.push(list.length ? `Mash: ${list.join('. ')}.` : 'No mash steps listed.');
      }
      if (want('water')) {
        const list = waterLines(recipe);
        lines.push(list.length ? `Water targets: ${list.join(' ')}` : 'No water profile set.');
      }
      return lines.join('\n');
    },
  );

  // ── What is in the fermenter ───────────────────────────────────────────

  bruce.registerFunction(
    'get_active_recipe',
    'Say which beer is currently in the fermenter, and — when the fermenter is empty — whether it has been cleaned since the last batch came out. Use for "what am I fermenting?", "what\'s in the fermenter?" or "is the fermenter clean?". For live temperature and gravity, call get_fermenter_status instead.',
    { type: 'object', properties: {}, required: [] },
    async () => {
      const [active, fermenter] = await Promise.all([
        apiCall('GET', '/api/recipe'),
        apiCall('GET', '/api/fermenter').catch(() => null),
      ]);

      const state = fermenter && fermenter.state;
      const recipe = active && active.recipe;
      if (!recipe) {
        const cleanliness =
          state === 'clean'
            ? ' It is clean and ready to fill.'
            : state === 'dirty'
              ? ' It still needs cleaning.'
              : ' Nobody has said whether it is clean or dirty.';
        return `Nothing is in the fermenter.${cleanliness}`;
      }

      const detail = headline(recipe);
      return `${recipe.name} is in the fermenter${detail ? ` — ${detail}` : ''}.`;
    },
  );

  bruce.registerFunction(
    'set_active_recipe',
    'Record which recipe went into the fermenter — "I just pitched the saison", "the NEIPA is in the fermenter now". Matches the name against the recipe library, so the recipe must already exist in BrewPlanner. To say the fermenter was emptied, use clear_active_recipe instead.',
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The recipe name, or the shorthand the user said' },
      },
      required: ['name'],
    },
    async ({ name }) => {
      const recipes = await library();
      const match = matchRecipe(recipes, name);
      if (!match) {
        const names = recipes.map((r) => r.name).join(', ');
        return names
          ? `No recipe matches "${name}", so I have not changed anything. The recipes are: ${names}.`
          : 'There are no recipes in BrewPlanner to put in the fermenter.';
      }

      await apiCall('PUT', '/api/recipe', {
        id: match.id,
        name: match.name,
        style: match.style || '',
        abv: match.abv || '',
        url: match.url || '',
        ibu: match.ibu || '',
        ebc: match.ebc || '',
      });
      return `${match.name} is now the beer in the fermenter.`;
    },
  );

  bruce.registerFunction(
    'clear_active_recipe',
    'Record that the fermenter has been emptied — the beer was kegged or bottled. This does not mark the fermenter clean: taking a beer out is not washing the tank, so say set_fermenter_state separately once it has actually been cleaned.',
    { type: 'object', properties: {}, required: [] },
    async () => {
      const active = await apiCall('GET', '/api/recipe').catch(() => null);
      const was = active && active.recipe ? active.recipe.name : null;
      if (!was) return 'The fermenter was already empty.';
      await apiCall('DELETE', '/api/recipe');
      // The server deliberately leaves the clean/dirty state alone here, so
      // don't claim it changed — that is a separate thing somebody has to say.
      return `Cleared the fermenter — ${was} is no longer in it. Its clean or dirty state is unchanged.`;
    },
  );

  bruce.registerFunction(
    'set_fermenter_state',
    'Record whether the empty fermenter has been washed — "the fermenter is clean now" or "the fermenter still needs cleaning". Same clean/dirty question the keg board asks of an emptied keg.',
    {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['clean', 'dirty'], description: 'clean = washed and ready, dirty = needs cleaning' },
      },
      required: ['state'],
    },
    async ({ state }) => {
      await apiCall('PUT', '/api/fermenter', { state });
      return state === 'clean'
        ? 'Fermenter marked clean and ready to fill.'
        : 'Fermenter marked dirty — it needs cleaning.';
    },
  );
}

module.exports = { register, matchRecipe };
