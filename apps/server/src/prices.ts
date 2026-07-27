import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  IngredientKind,
  IngredientPrice,
  IngredientPriceOptions,
  PriceOption,
  PriceSource,
  PurchaseLine,
  RecipeCost,
  RecipePricing,
} from '@checklist/shared';
import type { StoredOverride } from './priceOverrides.js';
import { listOverrides } from './priceOverrides.js';

/**
 * Ingredient costing from the local price catalogue (`prices/` at the repo root)
 * — Humlecentralen's malt, hop and yeast listings, scraped to JSON — layered
 * with the brewer's own decisions from the `ingredient_prices` table.
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
 *
 * What the automatic match decides, the brewer can overrule. Each price resolves
 * in a fixed order — the brewer's own decision, then a built-in rule, then the
 * cheapest catalogue match — and every price says which of those it came from
 * (see {@link PriceSource}), so a figure the brewer chose is never confused with
 * one this file guessed.
 */

const PRICES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../prices');

interface MaltEntry {
  id?: string;
  name: string;
  producer?: string;
  ebc_min?: number | null;
  ebc_max?: number | null;
  /** True when the shop lists it as out of stock. */
  soldout?: boolean | null;
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

/**
 * Anything that isn't malt, hops or yeast — in practice the fruit purées the
 * sours are built on, but salts, spices and finings price the same way.
 *
 * Read from any file in `prices/` whose name mentions what it holds (see
 * {@link OTHERS_FILE_PATTERN}), so a new scrape can be dropped in as
 * `fruit_purees.json` without touching the code. Field names follow the
 * existing catalogues; a per-kg price is derived from the pack when absent, so
 * an entry only has to state a package size and what it costs.
 */
interface OtherEntry {
  id?: string;
  name: string;
  display_name?: string;
  producer?: string;
  brand?: string;
  /** Skipped when present and not 'other' — lets one file hold several kinds. */
  category?: string;
  price_dkk?: number | null;
  price_per_kg_dkk?: number | null;
  package_size_g?: number | null;
  soldout?: boolean | null;
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
  /** Out of stock at the shop; used only to break ties, never to hide a price. */
  soldout: boolean;
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
  'type', 'premium', 'organic', 'okologisk', 'oko', 'eco', 'bio',
  // Format and packaging
  'dry', 'liquid', 'slant', 'purepitch', 'next', 'gen', 'g', 'gram', 'kg', 'stk',
  'pkg', 'pack', 'sachet',
  // Bare unit letters — 'l' shows up both as litres and as the degrees-Lovibond
  // suffix ("Crystal 80 L"), and carries no identity either way.
  'l',
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
/**
 * How the grain was prepared rather than which grain it is: flaked, torrefied,
 * dehusked. These are kept as real tokens so "Torrefied Wheat" finds the
 * unmalted product rather than the cheaper wheat malt — but they're dropped in a
 * final fallback pass, so a recipe asking for a preparation the shop doesn't
 * stock still lands on the same grain instead of going unpriced.
 */
const PREPARATION = new Set([
  'flake', 'torrefied', 'unmalted', 'umaltet', 'raw', 'naked', 'dehusked',
  'husked', 'skaller', 'med', 'uden',
  // Purée and its neighbours belong here for the same reason: a recipe's "Mango
  // Puree" should still find a catalogue "Mango" (and vice versa), while an
  // exact "Mango Puree" listing is preferred when the shop has one.
  'puree', 'pulp', 'juice', 'concentrate', 'frozen', 'aseptic',
]);

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
  rauch: 'smoked',
  rauchmalz: 'smoked',
  rav: 'amber',
  // Danish fruit names, for the purées the sours are built on. The tokeniser has
  // already folded ø/æ/å, so these are the folded spellings.
  frugt: 'fruit',
  pure: 'puree',
  hindbaer: 'raspberry',
  jordbaer: 'strawberry',
  solbaer: 'blackcurrant',
  ribs: 'redcurrant',
  // "blåbær" folds to "blabaer" (å→a); the doubled-a spelling is what people
  // type when they can't be bothered with the Danish letter, so both map.
  blabaer: 'blueberry',
  blaabaer: 'blueberry',
  brombaer: 'blackberry',
  kirsebaer: 'cherry',
  fersken: 'peach',
  abrikos: 'apricot',
  blomme: 'plum',
  ananas: 'pineapple',
  passionsfrugt: 'passionfruit',
  passion: 'passionfruit',
  aeble: 'apple',
  paere: 'pear',
  citron: 'lemon',
  appelsin: 'orange',
  hyldeblomst: 'elderflower',
  rabarber: 'rhubarb',
  grapefrugt: 'grapefruit',
  banan: 'banana',
  kokos: 'coconut',
  tangerin: 'tangerine',
  litchi: 'lychee',
  figen: 'fig',
  // Colour/taste qualifiers a Ponthier listing hangs off a fruit name ("Rabarber
  // Rød", "Sød Hindbær") — folded the same way the fruit names above are: the
  // tokeniser turns ø into o and å into a before this table is consulted.
  gron: 'green',
  rod: 'red',
  hvid: 'white',
  sod: 'sweet',
  // The shop's closed-up Danish flake names, opened up to the grain inside.
  havreflager: 'oat',
  majsflager: 'maize',
  risflager: 'rice',
  // Preparation spellings that vary in the wild.
  torrified: 'torrefied',
  torified: 'torrefied',
  flaked: 'flake',
  // Malt aliases
  acid: 'acidulated',
  aromatic: 'arome',
  crystal: 'caramel',
  pils: 'pilsner',
  pilsener: 'pilsner',
  peated: 'peat',
  beechwood: 'beech',
  // British spelling, against the shop's American "Low Color Chocolate"
  colour: 'color',
  // Roman numerals for malt grades: "Munich I" is the shop's "Munich Type 1",
  // "Carafa II" its "Carafa Type 2".
  i: '1',
  ii: '2',
  iii: '3',
  iv: '4',
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
 * Whole-product equivalences that the word-by-word rules can't express: a malt
 * the trade names two different things, or a brand name for the same product.
 * Keyed on the ingredient's tokens, sorted so word order doesn't matter, and
 * resolved to the name the shop uses.
 *
 * Applied to the *recipe* side only — these translate what a brewer wrote into
 * what the shop calls it, and rewriting catalogue names too would be actively
 * harmful: it would re-file Gyrup's "Karamel Munich" as Weyermann's Caramunich
 * and lose it from every plain caramel-malt match.
 *
 * A mapping here only prices if the target is actually stocked. The malt
 * catalogue currently has no Carapils, so dextrine malt resolves correctly but
 * still comes back unpriced until that product is in `prices/`.
 */
const PRODUCT_ALIASES: Record<string, string> = {
  // Dextrine malt is Carapils; Carafoam is Weyermann's name for the same thing.
  dextrine: 'carapils',
  dextrin: 'carapils',
  carafoam: 'carapils',
  // "Caramel Wheat" is what Weyermann sells as Carawheat, and so on — the shop
  // writes the closed-up brand name. ("Caramel Munich" deliberately has no entry:
  // it matches Gyrup's "Karamel Munich" word-for-word already.)
  'caramel wheat': 'carawheat',
  'caramel rye': 'cararye',
  'caramel red': 'carared',
  // Maltsters' names for the palest chocolate malt.
  'chocolate pale': 'low color chocolate',
  'chocolate light': 'low color chocolate',
  // Rice hulls are a mash aid, and the shop's word for them shares nothing with
  // the English name.
  'hull rice': 'risskaller',
  'husk rice': 'risskaller',
};

/**
 * Light, English-only singularisation — just enough to fold the plurals that
 * actually turn up in a grain bill or a fruit addition. "-ies" gets its own rule
 * ("Blackberries" → "blackberry", "Cherries" → "cherry"); a bare trailing 's'
 * would otherwise strip to "blackberrie", which matches nothing in the catalogue.
 */
function singularize(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/** The bare tokenising pass, without alias resolution (which re-enters it). */
function tokenizeWords(name: string): string[] {
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
    const singular = singularize(canonical);
    const token = SYNONYMS[singular] ?? singular;
    if (NOISE.has(token)) continue;
    tokens.push(token);
  }

  while (tokens.length > 1 && ORIGIN_CODES.has(tokens[tokens.length - 1]!)) tokens.pop();

  // "Cara Red" and "Carared" are the same malt — the shop writes the brand
  // prefix closed up, recipes often don't.
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === 'cara') {
      tokens.splice(i, 2, `cara${tokens[i + 1]!}`);
      i--;
    }
  }
  return tokens;
}

/**
 * Split a name into comparable tokens: lowercased, de-accented (including the
 * Danish ø/æ/å), punctuation dropped, canonicalised through {@link SYNONYMS},
 * lightly singularised so "Oats" matches "Oat", stripped of {@link NOISE}, and
 * relieved of any trailing origin code — then resolved through
 * {@link PRODUCT_ALIASES} if the whole thing names a product the shop calls
 * something else.
 *
 * Synonyms are consulted both before and after singularising, because the two
 * steps interfere: "Pils" would otherwise be trimmed to "pil" and never reach its
 * "pilsner" alias. Noise is likewise checked on both forms.
 */
function tokenize(name: string): string[] {
  const tokens = tokenizeWords(name);
  if (tokens.length === 0) return tokens;
  // Sorted key, so "Caramel Wheat" and "Wheat Caramel" resolve alike.
  const alias = PRODUCT_ALIASES[[...tokens].sort().join(' ')];
  return alias ? tokenizeWords(alias) : tokens;
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

/**
 * Which files in `prices/` hold non-malt/hop/yeast ingredients. Matched on the
 * filename rather than fixed, because these come from wherever the brewery buys
 * purée — one file per shop is normal, and a new one shouldn't need a code change.
 */
const OTHERS_FILE_PATTERN = /(other|puree|pure|fruit|adjunct|misc|spice|sugar|salt)/i;

/** Array keys accepted inside a catalogue file, tried in order. */
const OTHERS_KEYS = ['others', 'products', 'items', 'ingredients', 'purees', 'fruits'];

interface Catalogue {
  fermentables: PricedItem[];
  hops: PricedItem[];
  yeasts: PricedItem[];
  /** Fruit purées and the rest of the "other ingredients" list. */
  others: PricedItem[];
  lastChecked: string;
}

let cache: Catalogue | null = null;

/** Load and index the catalogue once; the files are static. */
function catalogue(): Catalogue {
  if (cache) return cache;

  const malts = readCatalogue<MaltEntry>('humlecentralen_malts_100g.json', ['malts', 'products']);
  const hops = readCatalogue<HopEntry>('humlecentralen_hops_100g.json', ['hops', 'products']);
  const yeasts = readCatalogue<YeastEntry>('humlecentralen_yeasts.json', ['products', 'yeasts']);
  const others = readOtherCatalogues();

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
          tokens: tokenizeWords(m.name),
          pricePerKgDkk: perKg,
          packagePriceDkk: num(m.price_per_100g_dkk) ?? (perKg * size) / 1000,
          packageSizeG: size,
          ebcMin: num(m.ebc_min),
          ebcMax: num(m.ebc_max),
          soldout: m.soldout === true,
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
          tokens: tokenizeWords(h.name),
          pricePerKgDkk: perKg,
          packagePriceDkk: num(h.price_dkk) ?? (perKg * size) / 1000,
          packageSizeG: size,
          ebcMin: null,
          ebcMax: null,
          soldout: false,
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
          tokens: tokenizeWords(y.name),
          pricePerKgDkk: size == null ? null : (price / size) * 1000,
          packagePriceDkk: price,
          packageSizeG: size,
          ebcMin: null,
          ebcMax: null,
          soldout: false,
        },
      ];
    }),
    others: others.items.flatMap((o) => {
      // One file may hold several kinds; anything explicitly filed as malt, hop
      // or yeast belongs to those catalogues and their matching rules.
      const category = (o.category ?? 'other').toLowerCase();
      if (['malt', 'fermentable', 'hop', 'yeast'].includes(category)) return [];
      const perKg = num(o.price_per_kg_dkk);
      const packPrice = num(o.price_dkk);
      const size = num(o.package_size_g);
      // Priced by the kilo with no pack stated: cost a kilo as the "package", so
      // 2.5 kg of purée is 2.5 of them rather than nothing.
      const pack =
        packPrice != null
          ? { price: packPrice, sizeG: size }
          : perKg != null
            ? { price: perKg, sizeG: 1000 }
            : null;
      if (pack == null) return [];
      return [
        {
          id: o.id ?? `other:${o.producer ?? o.brand ?? ''}:${o.name}`,
          label: [o.producer ?? o.brand, o.name].filter(Boolean).join(' '),
          tokens: tokenizeWords(o.name),
          pricePerKgDkk:
            perKg ?? (pack.sizeG == null ? null : (pack.price / pack.sizeG) * 1000),
          packagePriceDkk: pack.price,
          packageSizeG: pack.sizeG,
          ebcMin: null,
          ebcMax: null,
          soldout: o.soldout === true,
        },
      ];
    }),
    lastChecked:
      malts.lastChecked || hops.lastChecked || yeasts.lastChecked || others.lastChecked,
  };
  return cache;
}

/**
 * Read every "other ingredients" catalogue in `prices/` and merge them, so the
 * brewery can keep one file per shop. A missing directory, an unreadable file or
 * one with no recognised array is simply no prices — the same supported state as
 * having no catalogue at all.
 */
function readOtherCatalogues(): { items: OtherEntry[]; lastChecked: string } {
  let files: string[] = [];
  try {
    files = readdirSync(PRICES_DIR).filter(
      (f) => f.toLowerCase().endsWith('.json') && OTHERS_FILE_PATTERN.test(f),
    );
  } catch {
    return { items: [], lastChecked: '' };
  }

  const items: OtherEntry[] = [];
  let lastChecked = '';
  for (const file of files) {
    const read = readCatalogue<OtherEntry>(file, OTHERS_KEYS);
    // A malt/hop/yeast scrape that happens to match the filename pattern (say a
    // "sugar" file listing malts) is filtered per entry by `category` below.
    items.push(...read.items.filter((i) => typeof i?.name === 'string' && i.name !== ''));
    if (!lastChecked) lastChecked = read.lastChecked;
  }
  return { items, lastChecked };
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

  const matching = (tokens: string[]): PricedItem[] =>
    items.filter((item) => tokens.every((t) => item.tokens.includes(t)));

  const strict = matching(wanted);
  if (strict.length > 0) return strict;

  // Second pass without a trailing grade number. Maltsters number colour grades
  // ("Caramunich II", "Crystal 60", "Munich I") where the shop often stocks just
  // one of them under the bare name — so an exact match is preferred, and this is
  // the fallback rather than the rule. The colour check still applies afterwards,
  // which is what stops a pale grade being costed as a dark one.
  //
  // A degrees-Lovibond suffix counts as a grade number too — "Dark Crystal 80L"
  // tokenizes to a single trailing "80l" (no space before the unit), which a
  // bare \d+ pattern wouldn't strip.
  const noGrade = [...wanted];
  while (noGrade.length > 1 && /^\d+l?$/.test(noGrade[noGrade.length - 1]!)) noGrade.pop();
  if (noGrade.length !== wanted.length) {
    const found = matching(noGrade);
    if (found.length > 0) return found;
  }

  // Last resort: ignore how the grain was prepared. "Flaked Barley" will settle
  // for barley malt if the shop has no barley flakes.
  const noPrep = noGrade.filter((t) => !PREPARATION.has(t));
  if (noPrep.length > 0 && noPrep.length !== noGrade.length) return matching(noPrep);
  return [];
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

/** The catalogue one kind of ingredient is priced against. */
function catalogueFor(kind: IngredientKind): PricedItem[] {
  const c = catalogue();
  switch (kind) {
    case 'fermentable':
      return c.fermentables;
    case 'hop':
      return c.hops;
    case 'yeast':
      return c.yeasts;
    case 'other':
      return c.others;
  }
}

/** A catalogue entry paired with how much of it one line consumes. */
interface Match {
  item: PricedItem;
  /** Null when the line and the product can't be reconciled (see {@link packageFraction}). */
  fraction: number | null;
}

/** What buying enough of a product for this line costs, for ranking. */
function buyIn(m: Match): number {
  return m.fraction == null ? Number.POSITIVE_INFINITY : Math.ceil(m.fraction) * m.item.packagePriceDkk;
}

/**
 * Every catalogue entry that could be this ingredient, cheapest first.
 *
 * "Cheapest" is judged on what this line would actually cost to buy, not on the
 * headline rate — which matters for yeast, where a 25 g pitch is cheaper as one
 * 25 g sachet at 82 kr than as three 11.5 g sachets at 37 kr each. A listing the
 * line can't be reconciled with sorts last rather than being dropped, so the
 * picker can still offer it.
 */
function rankedMatches(
  kind: IngredientKind,
  name: string,
  qty: Quantity,
  recipeEbc: number | null,
): Match[] {
  return candidates(catalogueFor(kind), name)
    .filter((item) => colourPlausible(item, recipeEbc))
    .map((item) => ({ item, fraction: packageFraction(item, qty) }))
    .sort((a, b) => buyIn(a) - buyIn(b));
}

/**
 * The listing automatic pricing would use: the cheapest match this line can
 * actually be costed against.
 *
 * A cheaper price on something the shop has run out of is not a better price, so
 * in-stock listings win outright and sold-out ones are only a last resort — the
 * point being that an ingredient stays priced rather than going blank because the
 * shop is temporarily empty. The picker doesn't offer sold-out listings at all;
 * they aren't something the brewer can choose to buy.
 */
function cheapestMatch(matches: Match[]): Match | null {
  const usable = matches.filter((m) => m.fraction != null && m.fraction > 0);
  const inStock = usable.filter((m) => !m.item.soldout);
  return (inStock[0] ?? usable[0]) ?? null;
}

/**
 * Kveik is priced at a flat rate rather than from the catalogue. The shop stocks
 * almost none of it — it comes from a fellow brewer or a previous batch's slurry
 * — so a strain that happens to share a word with a listing would otherwise be
 * costed against something unrelated, and one that doesn't would go unpriced.
 */
const KVEIK_PITCH_DKK = 99;

/** A built-in pricing rule for this ingredient, if one applies. */
function ruleMatch(kind: IngredientKind, name: string): { item: PricedItem; note: string } | null {
  if (kind !== 'yeast' || !/kveik/i.test(name)) return null;
  return {
    item: {
      // Per strain, not per rule: two different kveiks are two pitches to buy.
      id: `rule:kveik:${ingredientKey(name)}`,
      label: name.trim(),
      tokens: [],
      // A pitch, not a weight — however many grams the recipe writes down.
      pricePerKgDkk: null,
      packagePriceDkk: KVEIK_PITCH_DKK,
      packageSizeG: null,
      ebcMin: null,
      ebcMax: null,
      soldout: false,
    },
    note: `Kveik — priced at a flat ${KVEIK_PITCH_DKK} kr a pitch rather than from the catalogue`,
  };
}

/**
 * The brewer's decisions, indexed for lookup. Cached because costing the Recipes
 * grid resolves thousands of lines against a table of a few dozen rows; every
 * write clears it (see {@link invalidatePriceOverrides}).
 */
let overrideCache: Map<string, StoredOverride> | null = null;

function overrideKey(kind: IngredientKind, ingredient: string): string {
  return `${kind} ${ingredient}`;
}

function overrides(): Map<string, StoredOverride> {
  if (!overrideCache) {
    overrideCache = new Map(listOverrides().map((o) => [overrideKey(o.kind, o.ingredient), o]));
  }
  return overrideCache;
}

/** Forget the cached decisions, so the next price reads them fresh. */
export function invalidatePriceOverrides(): void {
  overrideCache = null;
}

/**
 * The key a decision is filed under: the ingredient's name reduced to its
 * significant words, so one price covers every spelling of it that the matcher
 * already treats as the same thing. A name with nothing significant in it (all
 * noise, or punctuation) falls back to itself, which still keys consistently.
 */
export function ingredientKey(name: string): string {
  const tokens = tokenize(name);
  return tokens.length > 0 ? tokens.join(' ') : name.trim().toLowerCase();
}

function overrideFor(kind: IngredientKind, name: string): StoredOverride | undefined {
  return overrides().get(overrideKey(kind, ingredientKey(name)));
}

/**
 * A priced product built from the brewer's own figure. When they also pinned a
 * catalogue listing, the listing supplies the identity (name, pack size) and only
 * the price is theirs — so repeats of it still pool into one purchase.
 *
 * A per-kg price needs a package to book the buying cost against: the pinned
 * listing's, if there is one, else the kilo it was quoted in. A per-pack price
 * carries whatever pack it was quoted for, and null means one pitch of no stated
 * weight — the same thing a liquid yeast pack is.
 */
function manualItem(override: StoredOverride, pinned: PricedItem | null): PricedItem | null {
  if (override.unitPriceDkk == null || override.priceUnit == null) return null;
  const base = {
    id: pinned?.id ?? `manual:${override.kind}:${override.ingredient}`,
    label: pinned?.label ?? override.label,
    tokens: [],
    ebcMin: null,
    ebcMax: null,
    soldout: false,
  };
  if (override.priceUnit === 'kg') {
    const packageSizeG = override.packageSizeG ?? pinned?.packageSizeG ?? 1000;
    return {
      ...base,
      pricePerKgDkk: override.unitPriceDkk,
      packagePriceDkk: (override.unitPriceDkk * packageSizeG) / 1000,
      packageSizeG,
    };
  }
  const packageSizeG = override.packageSizeG ?? pinned?.packageSizeG ?? null;
  return {
    ...base,
    pricePerKgDkk: packageSizeG == null ? null : (override.unitPriceDkk / packageSizeG) * 1000,
    packagePriceDkk: override.unitPriceDkk,
    packageSizeG,
  };
}

/**
 * The product a saved decision resolves to. Null when it resolves to nothing
 * usable — a pinned listing the shop has since dropped — in which case pricing
 * falls through to the automatic match rather than leaving the line blank.
 */
function overrideMatch(
  kind: IngredientKind,
  override: StoredOverride,
): { item: PricedItem; source: PriceSource } | null {
  const pinned =
    override.catalogueId == null
      ? null
      : (catalogueFor(kind).find((i) => i.id === override.catalogueId) ?? null);
  const manual = manualItem(override, pinned);
  if (manual) return { item: manual, source: 'manual' };
  return pinned ? { item: pinned, source: 'chosen' } : null;
}

/** Turn a chosen product into the line's price, or null if it can't be costed. */
function toPrice(
  item: PricedItem,
  qty: Quantity,
  alternatives: number,
  source: PriceSource,
  note: string | null,
): IngredientPrice | null {
  const fraction = packageFraction(item, qty);
  if (fraction == null || fraction <= 0) return null;
  return {
    // Pro-rata on the package, which is equivalent to grams × price-per-kg for
    // anything sold by weight and still works for a unit-priced pack.
    usedDkk: money(fraction * item.packagePriceDkk),
    pricePerKgDkk: item.pricePerKgDkk == null ? null : money(item.pricePerKgDkk),
    packageSizeG: item.packageSizeG,
    packagePriceDkk: money(item.packagePriceDkk),
    packageFraction: fraction,
    matchedName: item.label,
    catalogueId: item.id,
    alternatives,
    source,
    note,
  };
}

/**
 * Cost one ingredient line, resolving in the order that puts the brewer's
 * judgement above this file's: a saved decision, then a built-in rule, then the
 * cheapest catalogue listing whose name matches.
 *
 * Each step falls through when it produces nothing usable, so a pinned product
 * that has left the catalogue degrades to an automatic price rather than to no
 * price at all.
 */
function priceLine(
  kind: IngredientKind,
  name: string,
  qty: Quantity,
  /** The recipe's own colour for this line, when it has one (malt only). */
  recipeEbc: number | null = null,
): IngredientPrice | null {
  if (qty.grams == null && qty.units == null) return null;
  const matches = rankedMatches(kind, name, qty, recipeEbc);
  // How many listings shared the name, whichever one ends up being used.
  const alternatives = Math.max(matches.filter((m) => !m.item.soldout).length - 1, 0);

  const override = overrideFor(kind, name);
  if (override) {
    const resolved = overrideMatch(kind, override);
    const price = resolved && toPrice(resolved.item, qty, alternatives, resolved.source, null);
    if (price) return price;
  }

  const rule = ruleMatch(kind, name);
  if (rule) {
    const price = toPrice(rule.item, qty, alternatives, 'rule', rule.note);
    if (price) return price;
  }

  const best = cheapestMatch(matches);
  return best ? toPrice(best.item, qty, alternatives, 'catalogue', null) : null;
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
  return priceLine('fermentable', name, { grams, units: null }, ebc);
}

export function priceHop(name: string, grams: number): IngredientPrice | null {
  return priceLine('hop', name, { grams, units: null });
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
  return priceLine('yeast', name, qty);
}

/**
 * Cost an "other ingredient" — mostly the fruit purées in the sours, which are
 * bought by weight and can outweigh the grain bill in cost. Takes a weight or a
 * pack count, since a recipe may say "3 kg" or "1 each".
 */
export function priceOther(name: string, qty: Quantity): IngredientPrice | null {
  return priceLine('other', name, qty);
}

// ---------------------------------------------------------------------------
// The price picker: what one ingredient could be priced against
// ---------------------------------------------------------------------------

/** How many search hits to hand back; more than fits a dropdown is noise. */
const SEARCH_LIMIT = 40;

/** Present one catalogue listing as something the brewer can pick. */
function toOption(m: Match, defaultId: string | null, selectedId: string | null): PriceOption {
  return {
    catalogueId: m.item.id,
    label: m.item.label,
    pricePerKgDkk: m.item.pricePerKgDkk == null ? null : money(m.item.pricePerKgDkk),
    packagePriceDkk: money(m.item.packagePriceDkk),
    packageSizeG: m.item.packageSizeG,
    usedDkk: m.fraction == null ? null : money(m.fraction * m.item.packagePriceDkk),
    isDefault: m.item.id === defaultId,
    isSelected: m.item.id === selectedId,
  };
}

/**
 * Everything the picker shows for one ingredient: the in-stock listings that
 * match its name, which of them automatic pricing would take, which is in effect,
 * and the decision already saved for it.
 *
 * Sold-out listings are filtered out here even though {@link cheapestMatch} will
 * still fall back to one — offering the brewer something they can't buy is worse
 * than the automatic pricing quietly using it as a last resort, and the price
 * itself still names whatever it was costed against.
 */
export function ingredientOptions(
  kind: IngredientKind,
  name: string,
  qty: Quantity,
  ebc: number | null = null,
): IngredientPriceOptions {
  const price = priceLine(kind, name, qty, ebc);
  const matches = rankedMatches(kind, name, qty, ebc);
  const defaultId = cheapestMatch(matches)?.item.id ?? null;
  return {
    kind,
    name,
    matched: matches
      .filter((m) => !m.item.soldout)
      .map((m) => toOption(m, defaultId, price?.catalogueId ?? null)),
    override: overrideFor(kind, name) ?? null,
    price,
  };
}

/**
 * Free-text lookup across one catalogue, for when the name match landed on the
 * wrong product entirely — the case the picker exists for. Matched on the words
 * of the shop's own listing name (producer included), so "weyermann pils" finds
 * what a token match on the recipe's wording never would.
 */
export function searchCatalogue(
  kind: IngredientKind,
  query: string,
  qty: Quantity,
  selectedId: string | null = null,
): PriceOption[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const items = catalogueFor(kind).filter((item) => !item.soldout);
  const hits = words.length === 0
    ? items
    : items.filter((item) => {
        const haystack = item.label.toLowerCase();
        return words.every((w) => haystack.includes(w));
      });
  return hits
    .map((item) => ({ item, fraction: packageFraction(item, qty) }))
    .sort((a, b) => buyIn(a) - buyIn(b))
    .slice(0, SEARCH_LIMIT)
    .map((m) => toOption(m, null, selectedId));
}

/** Whether a catalogue id exists in one kind's listings — validation on save. */
export function catalogueHasItem(kind: IngredientKind, catalogueId: string): boolean {
  return catalogueFor(kind).some((item) => item.id === catalogueId);
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
