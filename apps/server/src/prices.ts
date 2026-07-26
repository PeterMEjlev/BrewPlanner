import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IngredientPrice, PurchaseLine, RecipeCost, RecipePricing } from '@checklist/shared';

/**
 * Ingredient costing from the local price catalogue (`prices/` at the repo root)
 * — Humlecentralen's malt, hop and yeast listings, scraped to JSON.
 *
 * Two figures come out of a recipe, because they answer different questions.
 * Per line, `usedDkk` is what the recipe consumes (grams × price per kg): the
 * real cost of the beer in the fermenter, with the rest of the bag carried into
 * the next batch. Per recipe, {@link recipeCost} also works out what the shop
 * charges — a 40 g Magnum addition is 20.80 kr of hops but a 52.00 kr bag.
 *
 * Buying cost is deliberately a recipe-level figure, not a per-line one: the same
 * hop turns up in the whirlpool and twice more as a dry hop, and three 30 g
 * additions of Citra are one 100 g bag rather than three. Rounding per line would
 * triple the bill.
 *
 * Coverage is good but not total — every malt and hop is priced, and 84 of the
 * yeast listings are brewing strains (the rest being nutrients and wine/spirit
 * yeast, which a beer recipe must never be costed against). What's left over is
 * ingredients the shop simply doesn't stock. An unmatched or unpriced ingredient
 * returns null rather than a guess, and the counts travel with the totals so a
 * short total says so.
 */

const PRICES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../prices');

interface MaltEntry {
  id?: string;
  name: string;
  producer?: string;
  ebc_min?: number | null;
  ebc_max?: number | null;
  price_per_kg_dkk?: number | null;
  price_per_100g_dkk?: number | null;
  package_size_g?: number | null;
}

interface HopEntry {
  id?: string;
  name: string;
  price_dkk?: number | null;
  price_per_kg_dkk?: number | null;
  package_size_g?: number | null;
}

interface YeastEntry {
  id?: string;
  name: string;
  display_name?: string;
  manufacturer?: string;
  /**
   * What the shop files it as: 'yeast' for brewing strains, but the same listing
   * also carries 'yeast_nutrient', 'fermentation_adjunct', 'wine_yeast' and
   * 'distilling_yeast'. Only brewing yeast may match a recipe's pitch — FANMax
   * nutrient is not a substitute for a Verdant sachet.
   */
  category?: string;
  /** 'dry' or 'liquid'; liquid packs state no weight. */
  format?: string;
  price_dkk?: number | null;
  package_size_g?: number | null;
}

interface CatalogueFile<T> {
  currency?: string;
  last_checked?: string;
  [key: string]: unknown | T[];
}

/** A catalogue entry reduced to what costing needs. */
interface PricedItem {
  /** Stable catalogue id, used to pool repeats of one product for buying. */
  id: string;
  /** Name shown in the UI so the brewer can see what a line was priced against. */
  label: string;
  /** Match key: the significant words of the name. */
  tokens: string[];
  pricePerKgDkk: number | null;
  /** Price of one package. */
  packagePriceDkk: number;
  /** Null for a pitchable unit sold without a stated weight (liquid yeast). */
  packageSizeG: number | null;
  /** Colour range the shop states, EBC. Null for hops and yeast. */
  ebcMin: number | null;
  ebcMax: number | null;
}

/**
 * Words that carry no identity: product-category nouns, marketing adjectives,
 * pack sizes, the Danish shop's own wording, and the preparation a grain arrived
 * in. Dropping the last group is what lets a recipe's "Flaked Oats" reach the
 * catalogue's "Havre Malt" — different preparations of the same grain, and the
 * only oat the shop stocks. The tooltip names the product that was matched, so
 * an approximation like that stays visible.
 */
const NOISE = new Set([
  // Category nouns
  'malt', 'malted', 'malting', 'hop', 'humle', 'gaer', 'yeast', 'torgaer', 'pellet',
  'pellets', 'leaf', 'whole', 'cone', 'cones',
  // Marketing / qualifiers that don't identify the ingredient
  'type', 'premium', 'organic', 'okologisk', 'oko', 'eco', 'bio', 'special',
  // Preparation, not identity
  'flaked', 'flakes', 'torrefied', 'unmalted', 'raw', 'naked', 'dehusked', 'husked',
  // Format and packaging
  'dry', 'liquid', 'slant', 'purepitch', 'next', 'gen', 'g', 'gram', 'kg', 'stk',
  'pkg', 'pack', 'sachet',
  // Danish shop boilerplate on order-only lines
  'bestillingsvare', 'dages', 'leveringstid', 'til', 'lav', 'alkohol', 'ol',
]);

/**
 * Origin and region suffixes, as the catalogue appends them: "Magnum DE",
 * "Mosaic US", "Idaho 7 US", "Celeia CZ", "Admiral ES Økologisk".
 *
 * Only stripped from the *end* of a name, which is the only place the shop puts
 * them. Dropping them anywhere would maul strain codes — "US-05" would lose its
 * "us" and match on a bare "05".
 */
const ORIGIN_CODES = new Set([
  'us', 'usa', 'uk', 'de', 'ger', 'nz', 'cz', 'sl', 'si', 'es', 'au', 'pl', 'fr',
  'be', 'dk', 'at',
]);

/**
 * Words that mean the same ingredient, mapped to one spelling. Mostly the Danish
 * and German the catalogue and recipes disagree on ("Havre Malt" vs "Flaked
 * Oats", "Karamel" vs "Caramel"), plus a few hop and malt aliases that are
 * genuinely the same product under two names.
 *
 * Applied to both the catalogue and the recipe, so matching stays symmetric.
 */
const SYNONYMS: Record<string, string> = {
  // Danish → English (the shop is Danish, the recipes are in English)
  havre: 'oat',
  hvede: 'wheat',
  byg: 'barley',
  rug: 'rye',
  karamel: 'caramel',
  lys: 'light',
  mork: 'dark',
  rist: 'roasted',
  ristet: 'roasted',
  rog: 'smoked',
  roget: 'smoked',
  syre: 'acidulated',
  // German → English
  hafer: 'oat',
  weizen: 'wheat',
  roggen: 'rye',
  gerste: 'barley',
  muenchner: 'munich',
  munchner: 'munich',
  wiener: 'vienna',
  schokolade: 'chocolate',
  sauer: 'acidulated',
  sauermalz: 'acidulated',
  saurermalz: 'acidulated',
  // Malt aliases
  acid: 'acidulated',
  crystal: 'caramel',
  pils: 'pilsner',
  pilsener: 'pilsner',
  peated: 'peat',
  beechwood: 'beech',
  // Hop aliases
  hallertauer: 'hallertau',
  mittelfrueh: 'mittelfruh',
  mittelfrueeh: 'mittelfruh',
  tomahawk: 'ctz',
  zeus: 'ctz',
  columbu: 'ctz',
  savinjski: 'styrian',
  fuggle: 'fuggle',
  golding: 'golding',
  // Yeast aliases
  lalbrew: 'lallemand',
  wyeast: 'wyeast',
};

/**
 * Split a name into comparable tokens: lowercased, de-accented (including the
 * Danish ø/æ/å), punctuation dropped, canonicalised through {@link SYNONYMS},
 * lightly singularised so "Oats" matches "Oat", stripped of {@link NOISE}, and
 * finally relieved of any trailing origin code.
 *
 * Synonyms are consulted both before and after singularising, because the two
 * steps interfere: "Pils" would otherwise be trimmed to "pil" and never reach its
 * "pilsner" alias. Noise is likewise checked on both forms.
 */
function tokenize(name: string): string[] {
  const words = name
    .toLowerCase()
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/å/g, 'a')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/);

  const tokens: string[] = [];
  for (const word of words) {
    // Crop years ("2025 pellets") say nothing about which hop this is.
    if (word === '' || NOISE.has(word) || /^\d{4}$/.test(word)) continue;
    const canonical = SYNONYMS[word] ?? word;
    const singular =
      canonical.length > 3 && canonical.endsWith('s') ? canonical.slice(0, -1) : canonical;
    const token = SYNONYMS[singular] ?? singular;
    if (NOISE.has(token)) continue;
    tokens.push(token);
  }

  while (tokens.length > 1 && ORIGIN_CODES.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens;
}

/**
 * Read one catalogue file, tolerating a missing or malformed file.
 *
 * Several key names are accepted per file because the scrapes get regenerated and
 * have renamed their array once already ('yeasts' became 'products'). Trying each
 * in turn means a refreshed catalogue keeps working instead of silently costing
 * nothing.
 */
function readCatalogue<T>(file: string, keys: string[]): { items: T[]; lastChecked: string } {
  try {
    const raw = readFileSync(resolve(PRICES_DIR, file), 'utf8');
    const parsed = JSON.parse(raw) as CatalogueFile<T>;
    const found = keys.map((k) => parsed[k]).find((v) => Array.isArray(v));
    return {
      items: (found as T[] | undefined) ?? [],
      lastChecked: typeof parsed.last_checked === 'string' ? parsed.last_checked : '',
    };
  } catch {
    // No catalogue is a supported state: recipes simply show no prices.
    return { items: [], lastChecked: '' };
  }
}

interface Catalogue {
  fermentables: PricedItem[];
  hops: PricedItem[];
  yeasts: PricedItem[];
  lastChecked: string;
}

let cache: Catalogue | null = null;

/** Load and index the catalogue once; the files are static. */
function catalogue(): Catalogue {
  if (cache) return cache;

  const malts = readCatalogue<MaltEntry>('humlecentralen_malts_100g.json', ['malts', 'products']);
  const hops = readCatalogue<HopEntry>('humlecentralen_hops_100g.json', ['hops', 'products']);
  const yeasts = readCatalogue<YeastEntry>('humlecentralen_yeasts.json', ['products', 'yeasts']);

  cache = {
    fermentables: malts.items.flatMap((m) => {
      const perKg = num(m.price_per_kg_dkk);
      if (perKg == null) return [];
      const size = num(m.package_size_g) ?? 100;
      return [
        {
          id: m.id ?? `malt:${m.producer ?? ''}:${m.name}`,
          // Producer included so "Pilsner Malt" is identifiable when three
          // different maltsters sell one.
          label: [m.producer, m.name].filter(Boolean).join(' '),
          tokens: tokenize(m.name),
          pricePerKgDkk: perKg,
          packagePriceDkk: num(m.price_per_100g_dkk) ?? (perKg * size) / 1000,
          packageSizeG: size,
          ebcMin: num(m.ebc_min),
          ebcMax: num(m.ebc_max),
        },
      ];
    }),
    hops: hops.items.flatMap((h) => {
      const perKg = num(h.price_per_kg_dkk);
      const size = num(h.package_size_g) ?? 100;
      if (perKg == null) return [];
      return [
        {
          id: h.id ?? `hop:${h.name}`,
          label: h.name,
          tokens: tokenize(h.name),
          pricePerKgDkk: perKg,
          packagePriceDkk: num(h.price_dkk) ?? (perKg * size) / 1000,
          packageSizeG: size,
          ebcMin: null,
          ebcMax: null,
        },
      ];
    }),
    yeasts: yeasts.items.flatMap((y) => {
      const price = num(y.price_dkk);
      if (price == null) return [];
      // Nutrients, adjuncts and wine/distilling strains share the listing but are
      // not something a beer recipe's pitch can be costed against.
      const category = (y.category ?? 'yeast').toLowerCase();
      if (category !== 'yeast') return [];
      // Dry yeast states a sachet weight; a liquid pack is simply one pitch, and
      // is priced per unit rather than per gram.
      const size = num(y.package_size_g);
      return [
        {
          id: y.id ?? `yeast:${y.manufacturer ?? ''}:${y.name}`,
          label: [y.manufacturer, y.name].filter(Boolean).join(' '),
          tokens: tokenize(y.name),
          pricePerKgDkk: size == null ? null : (price / size) * 1000,
          packagePriceDkk: price,
          packageSizeG: size,
          ebcMin: null,
          ebcMax: null,
        },
      ];
    }),
    lastChecked: malts.lastChecked || hops.lastChecked || yeasts.lastChecked,
  };
  return cache;
}

/** A finite positive number, or null. */
function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Round money to øre. */
function money(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Every catalogue entry that could be this ingredient: one whose name contains
 * all of the recipe's significant words. "Pale Ale" matches "Pale Ale Malt" and
 * "Maris Otter Pale Ale Malt" but not "Extra Pale Premium Pilsner", which has no
 * "ale". Strict containment keeps false matches out; an ingredient the catalogue
 * doesn't stock stays unpriced rather than being priced as something else.
 */
function candidates(items: PricedItem[], name: string): PricedItem[] {
  const wanted = tokenize(name);
  if (wanted.length === 0) return [];
  return items.filter((item) => wanted.every((t) => item.tokens.includes(t)));
}

/**
 * Whether a malt's colour is in the same league as the recipe's, used to throw
 * out matches that share a grain but not a purpose. The catalogue stocks no plain
 * rye, so a recipe's pale "Rye" would otherwise be costed as Chocolate Rye — a
 * 650 EBC roasted malt — purely because it was the cheapest thing with "rye" in
 * the name. Better to leave it unpriced and say so.
 *
 * Deliberately loose: a factor of four either way, and never rejecting on a
 * difference under 20 EBC, so pale malts that differ by 2 EBC against 6 EBC still
 * match each other. Skipped when either colour is unknown.
 */
function colourPlausible(item: PricedItem, recipeEbc: number | null): boolean {
  if (recipeEbc == null || recipeEbc <= 0) return true;
  if (item.ebcMin == null || item.ebcMax == null) return true;
  const mid = (item.ebcMin + item.ebcMax) / 2;
  if (mid <= 0) return true;
  if (Math.abs(mid - recipeEbc) <= 20) return true;
  return (mid > recipeEbc ? mid / recipeEbc : recipeEbc / mid) <= 4;
}

/** How much a recipe line asks for: a weight, a count of packs, or neither. */
interface Quantity {
  grams: number | null;
  /** Packs/vials, for a recipe that counts rather than weighs (liquid yeast). */
  units: number | null;
}

/**
 * How many of a product's packages one line consumes, fractionally — 3.8 kg of
 * malt in 100 g bags is 38, and 40 g of hops from a 100 g bag is 0.4.
 *
 * Everything downstream is expressed in these, because it's the one measure that
 * works for a product sold by weight *and* for a liquid yeast pack that states no
 * weight at all. Null when the line and the product can't be reconciled.
 */
function packageFraction(item: PricedItem, qty: Quantity): number | null {
  if (qty.grams != null && item.packageSizeG != null) return qty.grams / item.packageSizeG;
  // A recipe that counts packs maps straight onto packs.
  if (qty.units != null) return qty.units;
  // A pitchable unit with no stated weight: one product is one pitch, whatever
  // the recipe's gram figure says.
  if (item.packageSizeG == null && qty.grams != null) return 1;
  return null;
}

/**
 * Cost one ingredient line against the cheapest catalogue entry that matches,
 * per the brewery's rule that two listings of the same malt are the same malt.
 *
 * "Cheapest" is judged on what this line would actually cost to buy, not on the
 * headline rate — which matters for yeast, where a 25 g pitch is cheaper as one
 * 25 g sachet at 82 kr than as three 11.5 g sachets at 37 kr each.
 */
function priceLine(
  items: PricedItem[],
  name: string,
  qty: Quantity,
  /** The recipe's own colour for this line, when it has one (malt only). */
  recipeEbc: number | null = null,
): IngredientPrice | null {
  if (qty.grams == null && qty.units == null) return null;
  const matches = candidates(items, name)
    .filter((item) => colourPlausible(item, recipeEbc))
    .map((item) => ({ item, fraction: packageFraction(item, qty) }))
    .filter((m): m is { item: PricedItem; fraction: number } => m.fraction != null && m.fraction > 0);
  if (matches.length === 0) return null;

  const buyIn = (m: { item: PricedItem; fraction: number }): number =>
    Math.ceil(m.fraction) * m.item.packagePriceDkk;

  const best = matches.reduce((cheapest, m) => (buyIn(m) < buyIn(cheapest) ? m : cheapest));

  return {
    // Pro-rata on the package, which is equivalent to grams × price-per-kg for
    // anything sold by weight and still works for a unit-priced pack.
    usedDkk: money(best.fraction * best.item.packagePriceDkk),
    pricePerKgDkk: best.item.pricePerKgDkk == null ? null : money(best.item.pricePerKgDkk),
    packageSizeG: best.item.packageSizeG,
    packagePriceDkk: money(best.item.packagePriceDkk),
    packageFraction: best.fraction,
    matchedName: best.item.label,
    catalogueId: best.item.id,
    // How many listings shared the name; the cheapest was taken.
    alternatives: matches.length - 1,
  };
}

/**
 * Cost a malt or sugar. `ebc` is the recipe's own colour for the line, used to
 * reject same-grain-wrong-roast matches (see {@link colourPlausible}); pass null
 * when the recipe doesn't state one.
 */
export function priceFermentable(
  name: string,
  grams: number,
  ebc: number | null = null,
): IngredientPrice | null {
  return priceLine(catalogue().fermentables, name, { grams, units: null }, ebc);
}

export function priceHop(name: string, grams: number): IngredientPrice | null {
  return priceLine(catalogue().hops, name, { grams, units: null });
}

/**
 * Yeast, matched on the strain name. The catalogue's own names embed the pack
 * size and Danish words ("SafLager SH-45, 11,5 g. tørgær"), which tokenizing
 * strips, so a recipe's "SafLager SH-45" still lines up.
 *
 * Takes a weight or a pack count, because recipes state both: dry yeast in grams
 * against a sachet weight, liquid yeast as "1 pkg" against a pack the shop sells
 * without a stated weight.
 */
export function priceYeast(name: string, qty: Quantity): IngredientPrice | null {
  return priceLine(catalogue().yeasts, name, qty);
}

/** An ingredient line as the costing sees it. */
interface CostableLine {
  grams: number | null;
  price: IngredientPrice | null;
}

/**
 * Total a recipe's ingredients: what it consumes, and what it costs to buy.
 *
 * The buying figure pools every line of the same catalogue product before
 * rounding to whole packages, which is why it can't be derived from the per-line
 * prices. Pooling is done in package fractions rather than grams, so a liquid
 * yeast pack with no stated weight pools the same way a hop does. The resulting
 * shopping list comes back with it, so the number is explainable rather than
 * asserted.
 */
export function recipeCost(lines: CostableLine[]): RecipeCost {
  const pooled = new Map<
    string,
    { price: IngredientPrice; fraction: number; grams: number | null }
  >();
  let usedDkk = 0;
  let priced = 0;
  let unpriced = 0;

  for (const line of lines) {
    // Anything that can't be costed — no catalogue match, or an amount we
    // couldn't read — is counted, so the total never quietly omits an ingredient.
    if (!line.price) {
      unpriced++;
      continue;
    }
    usedDkk += line.price.usedDkk;
    priced++;
    const existing = pooled.get(line.price.catalogueId);
    if (existing) {
      existing.fraction += line.price.packageFraction;
      // Only meaningful while every line of this product states a weight.
      existing.grams =
        existing.grams == null || line.grams == null ? null : existing.grams + line.grams;
    } else {
      pooled.set(line.price.catalogueId, {
        price: line.price,
        fraction: line.price.packageFraction,
        grams: line.grams,
      });
    }
  }

  const purchase: PurchaseLine[] = [...pooled.values()]
    .map(({ price, fraction, grams }) => {
      const packages = Math.ceil(fraction);
      return {
        catalogueId: price.catalogueId,
        name: price.matchedName,
        grams: grams == null ? null : Math.round(grams * 10) / 10,
        packages,
        packageSizeG: price.packageSizeG,
        totalDkk: money(packages * price.packagePriceDkk),
      };
    })
    .sort((a, b) => b.totalDkk - a.totalDkk);

  return {
    usedDkk: money(usedDkk),
    buyDkk: money(purchase.reduce((sum, p) => sum + p.totalDkk, 0)),
    priced,
    unpriced,
    purchase,
  };
}

/** Catalogue provenance, for the note under a recipe's cost. */
export function pricingInfo(): RecipePricing {
  const c = catalogue();
  const available = c.fermentables.length + c.hops.length + c.yeasts.length > 0;
  return {
    currency: 'DKK',
    lastChecked: c.lastChecked,
    source: 'Humlecentralen',
    available,
  };
}
