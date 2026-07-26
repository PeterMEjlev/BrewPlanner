import type {
  HopStage,
  Recipe,
  RecipeDetail,
  RecipeFermentable,
  RecipeHop,
  RecipeMashGuidelines,
  RecipeMashStep,
  RecipeOtherIngredient,
  RecipeWaterProfile,
  RecipeYeast,
} from '@checklist/shared';

/**
 * Brewer's Friend integration. The user's read-only API key is held server-side
 * (the BREWERS_FRIEND_API_KEY env var) and never exposed to the browser — the
 * API also can't be called from the browser directly (CORS), so the dashboard
 * goes through this proxy. See TODO.md "Integrate Brewer's Friend".
 *
 * Two shapes come out of here: the recipe *list* (cheap, cached, paginated) and
 * one recipe's full brew sheet (`?ingredients=true`, several times the payload),
 * fetched only when the Recipes page opens a detail view.
 */

const RECIPES_URL = 'https://api.brewersfriend.com/v1/recipes';

/** Max page size the API allows. */
const PAGE_SIZE = 100;

/** Give up on a single upstream request after this long. */
const TIMEOUT_MS = 15_000;

/** Thrown when no API key is configured, so the route can answer 503 distinctly. */
export class BrewersFriendNotConfiguredError extends Error {
  constructor() {
    super('Brewer\'s Friend is not configured (set BREWERS_FRIEND_API_KEY).');
    this.name = 'BrewersFriendNotConfiguredError';
  }
}

/** Thrown when an id isn't in the account, so the route can answer 404. */
export class RecipeNotFoundError extends Error {
  constructor(id: string) {
    super(`Recipe ${id} was not found in your Brewer's Friend account.`);
    this.name = 'RecipeNotFoundError';
  }
}

/** Whether a Brewer's Friend API key is configured. */
export function isConfigured(): boolean {
  return Boolean(process.env.BREWERS_FRIEND_API_KEY);
}

/** One recipe as returned by the Brewer's Friend API (only the fields we read). */
interface BrewersFriendRecipe {
  id: string | number;
  title?: string;
  stylename?: string;
  abv?: string | number;
  /** Tinseth is the estimate the site itself headlines. */
  ibutinseth?: string | number;
  /**
   * Colour. Which of these an account's plan actually populates varies, and
   * several come back as 0 — {@link recipeColorEbc} tries them in turn and falls
   * back to calculating from the grain bill.
   */
  srmecbmorey?: string | number;
  ebc?: string | number;
  srm?: string | number;
  srmmorey?: string | number;
  color?: string | number;
  colorunit?: string;
  url?: string;
  og?: string | number;
  fg?: string | number;
  boilgravity?: string | number;
  post_boilgravity?: string | number;
  batchsize?: string | number;
  batchsizeunit?: string;
  mashtemp?: string | number;
  primarytemp?: string | number;
  fermentationtemp?: string | number;
  mashsteps?: BrewersFriendMashStep[];
  fermentationsteps?: { steptemp?: string | number; steptempunit?: string }[];
  fermentables?: Record<string, unknown>[];
  hops?: Record<string, unknown>[];
  yeasts?: Record<string, unknown>[];
  others?: Record<string, unknown>[];
  miscs?: Record<string, unknown>[];
  mashnotes?: string;
  notes_mash?: string;
  waterprofile?: string;
  waternotes?: string;
  ph?: string | number;
  ca2?: string | number;
  mg2?: string | number;
  na?: string | number;
  cl?: string | number;
  so4?: string | number;
  hco3?: string | number;
}

interface BrewersFriendMashStep {
  name?: string;
  mashtype?: string;
  temp?: string | number;
  steptemp?: string | number;
  steptempunit?: string;
  mashtime?: string | number;
  steptime?: string | number;
  amount?: string | number;
  unit?: string;
}

interface RecipesResponse {
  recipes?: BrewersFriendRecipe[];
  /** Total across all pages, when the API reports it. */
  count?: string | number;
}

/** A trimmed string, or '' for null/undefined/numbers we can't read. */
function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/** A trimmed string, or null when empty — for "unset" fields the UI hides. */
function strOrNull(v: unknown): string | null {
  const s = str(v);
  return s === '' ? null : s;
}

/** One GET against /v1/recipes, with the key attached and a hard timeout. */
async function get(params: Record<string, string>, apiKey: string): Promise<RecipesResponse> {
  const url = `${RECIPES_URL}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, {
    headers: { 'X-API-KEY': apiKey },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Brewer's Friend API returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as RecipesResponse;
}

/** The list-view fields — everything the Recipes grid renders on a card. */
function toRecipe(r: BrewersFriendRecipe): Recipe {
  return {
    id: str(r.id),
    name: str(r.title) || 'Untitled recipe',
    style: str(r.stylename),
    // Normalize to a bare number string and drop any "%" the API includes.
    abv: str(r.abv).replace(/%/g, ''),
    ibu: str(r.ibutinseth),
    // No grain bill in the list response (ingredients aren't requested), so a
    // recipe whose colour fields are all 0 comes back blank and the card draws
    // an empty swatch — an honest "unknown" rather than the palest straw.
    ebc: recipeColorEbc(r, null).ebc,
    url: publicUrl(r),
  };
}

/**
 * Public recipe page. The API hands back a "web." host that 404s in a browser,
 * so strip it; fall back to the standard view URL built from the id.
 */
function publicUrl(r: BrewersFriendRecipe): string {
  const raw = str(r.url) || `https://brewersfriend.com/homebrew/recipe/view/${str(r.id)}`;
  return raw.replace('://web.', '://');
}

// The recipe list barely changes between visits, and Brewer's Friend rate-limits
// (429) an account that walks every page too often — so the list is cached for a
// few minutes. The Recipes page's refresh button bypasses it (`force`).
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { recipes: Recipe[]; fetchedAt: number } | null = null;
/** In-flight fetch, so N simultaneous page loads make one upstream walk. */
let inFlight: Promise<Recipe[]> | null = null;

/**
 * Fetch the account's recipes (newest first) and normalize them to
 * {@link Recipe}. Served from a short-lived cache unless `force` is set. Throws
 * {@link BrewersFriendNotConfiguredError} when no key is set, or a generic Error
 * when the upstream request fails.
 */
export async function listRecipes(force = false): Promise<Recipe[]> {
  const apiKey = process.env.BREWERS_FRIEND_API_KEY;
  if (!apiKey) throw new BrewersFriendNotConfiguredError();

  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.recipes;
  // A forced refresh still joins an in-flight walk rather than starting a second.
  if (inFlight) return inFlight;

  inFlight = fetchAllRecipes(apiKey)
    .then((recipes) => {
      cache = { recipes, fetchedAt: Date.now() };
      return recipes;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Walk every page of the account's recipes. The API caps a page at 100 and the
 * previous implementation took only the first page, so accounts past that many
 * recipes silently lost the tail. When the response reports a total, the
 * remaining pages are fetched concurrently; otherwise we page until a short one.
 */
async function fetchAllRecipes(apiKey: string): Promise<Recipe[]> {
  const page = (offset: number): Record<string, string> => ({
    sort: 'created_at:-1',
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });

  const first = await get(page(0), apiKey);
  const firstBatch = first.recipes ?? [];
  const all = firstBatch.map(toRecipe);
  if (firstBatch.length < PAGE_SIZE) return all;

  const total = Number(first.count);
  if (Number.isFinite(total) && total > PAGE_SIZE) {
    const offsets: number[] = [];
    for (let o = PAGE_SIZE; o < total; o += PAGE_SIZE) offsets.push(o);
    const pages = await Promise.all(offsets.map((o) => get(page(o), apiKey)));
    for (const p of pages) all.push(...(p.recipes ?? []).map(toRecipe));
    return all;
  }

  // Total unknown — walk serially until a page comes back short.
  for (let offset = PAGE_SIZE; ; offset += PAGE_SIZE) {
    const batch = (await get(page(offset), apiKey)).recipes ?? [];
    all.push(...batch.map(toRecipe));
    if (batch.length < PAGE_SIZE) return all;
  }
}

/**
 * Fetch one recipe with its full ingredient list. Not cached: it's opened
 * deliberately (one recipe at a time) and a brewer editing a recipe on Brewer's
 * Friend should see the change on the next open.
 */
export async function getRecipe(id: string): Promise<RecipeDetail> {
  const apiKey = process.env.BREWERS_FRIEND_API_KEY;
  if (!apiKey) throw new BrewersFriendNotConfiguredError();

  const body = await get({ id, ingredients: 'true' }, apiKey);
  const r = (body.recipes ?? [])[0];
  if (!r) throw new RecipeNotFoundError(id);

  const batchSizeL = batchSizeLiters(r);
  const color = recipeColorEbc(r, batchSizeL);

  return {
    id: str(r.id),
    name: str(r.title) || 'Untitled recipe',
    style: str(r.stylename),
    og: str(r.og),
    preBoilGravity: strOrNull(r.boilgravity),
    postBoilGravity: strOrNull(r.post_boilgravity),
    fg: str(r.fg),
    abv: str(r.abv).replace(/%/g, ''),
    ibu: str(r.ibutinseth),
    ebc: color.ebc,
    ebcEstimated: color.estimated,
    url: publicUrl(r),
    batchSizeL,
    mashTemp: mashTemp(r),
    fermentationTemp: fermentationTemp(r),
    fermentables: fermentables(r),
    hops: hops(r),
    yeast: yeasts(r),
    otherIngredients: otherIngredients(r),
    mashGuidelines: mashGuidelines(r),
    waterProfile: waterProfile(r),
  };
}

/**
 * Batch size in litres, converting from gallons when that's the recipe's unit.
 * An absent value stays null — `Number(null)` is 0, which would render as a
 * "0 L batch" instead of no batch size at all.
 */
function batchSizeLiters(r: BrewersFriendRecipe): number | null {
  const raw = str(r.batchsize);
  if (raw === '') return null;
  const size = Number(raw);
  if (!Number.isFinite(size) || size <= 0) return null;
  const unit = (r.batchsizeunit ?? 'l').toLowerCase();
  if (unit === 'gal' || unit === 'gallon' || unit === 'gallons') {
    return Math.round(size * 3.78541 * 100) / 100;
  }
  return size;
}

/**
 * The headline mash temperature: the longest rest, which is the saccharification
 * step on any normal schedule. Falls back to the recipe-level field.
 */
function mashTemp(r: BrewersFriendRecipe): string | null {
  const steps = r.mashsteps ?? [];
  if (steps.length > 0) {
    const main = steps.reduce((longest, s) =>
      (Number(s.steptime) || 0) > (Number(longest.steptime) || 0) ? s : longest,
    );
    const temp = str(main.steptemp);
    if (temp) return `${temp}°${str(main.steptempunit) || 'C'}`;
  }
  const recipeLevel = str(r.mashtemp);
  return recipeLevel ? `${recipeLevel}°C` : null;
}

/** Primary fermentation temperature — the first fermentation step. */
function fermentationTemp(r: BrewersFriendRecipe): string | null {
  const first = (r.fermentationsteps ?? [])[0];
  if (first) {
    const temp = str(first.steptemp);
    if (temp) return `${temp}°${str(first.steptempunit) || 'C'}`;
  }
  const recipeLevel = str(r.primarytemp) || str(r.fermentationtemp);
  return recipeLevel ? `${recipeLevel}°C` : null;
}

/** EBC per SRM — the standard conversion factor. */
const EBC_PER_SRM = 1.97;

/**
 * A fermentable's weight in pounds, for the colour maths (Morey's equation is
 * defined in °L·lb/gal). Returns 0 for an amount we can't read, which simply
 * leaves that grain out of the estimate.
 */
function toPounds(amount: unknown, unit: unknown): number {
  const n = Number(str(amount));
  if (!Number.isFinite(n)) return 0;
  switch (str(unit).toLowerCase()) {
    case 'kg':
      return n * 2.20462;
    case 'g':
      return n / 453.592;
    case 'oz':
      return n / 16;
    case 'lb':
    case 'lbs':
      return n;
    default:
      // Brewer's Friend defaults to metric weights for this brewery's recipes.
      return n * 2.20462;
  }
}

/**
 * Beer colour in EBC calculated from the grain bill using Morey's equation —
 * the same model Brewer's Friend itself headlines.
 *
 *   MCU = Σ(grain lb × grain °L) / batch gal
 *   SRM = 1.4922 · MCU^0.6859
 *
 * Returns null when there's no grain with a stated colour, or no batch size to
 * divide by.
 */
function ebcFromGrainBill(r: BrewersFriendRecipe, batchSizeL: number | null): number | null {
  if (batchSizeL == null || batchSizeL <= 0) return null;
  const gallons = batchSizeL / 3.78541;

  let mcu = 0;
  for (const f of r.fermentables ?? []) {
    const lovibond = Number(str(f.lovibond));
    if (!Number.isFinite(lovibond) || lovibond <= 0) continue;
    mcu += toPounds(f.amount, f.unit) * lovibond;
  }
  if (mcu <= 0) return null;

  const srm = 1.4922 * Math.pow(mcu / gallons, 0.6859);
  return Math.round(srm * EBC_PER_SRM * 10) / 10;
}

/**
 * The recipe's colour in EBC. Which colour field a Brewer's Friend account
 * populates is inconsistent — this brewery's recipes come back with
 * `srmecbmorey: 0`, which would paint every beer the palest shade on the chart —
 * so each known field is tried in turn and only a positive value is accepted.
 * Failing all of them, the colour is calculated from the grain bill, which is
 * where the number comes from anyway.
 *
 * Returns the value and whether it had to be estimated, so the UI can say so.
 */
function recipeColorEbc(
  r: BrewersFriendRecipe,
  batchSizeL: number | null,
): { ebc: string; estimated: boolean } {
  // EBC first, then SRM fields (scaled), then the generic `color` + its unit.
  const candidates: { raw: unknown; toEbc: (n: number) => number }[] = [
    { raw: r.srmecbmorey, toEbc: (n) => n },
    { raw: r.ebc, toEbc: (n) => n },
    { raw: r.srm, toEbc: (n) => n * EBC_PER_SRM },
    { raw: r.srmmorey, toEbc: (n) => n * EBC_PER_SRM },
    {
      raw: r.color,
      toEbc: (n) => (str(r.colorunit).toLowerCase() === 'srm' ? n * EBC_PER_SRM : n),
    },
  ];
  for (const { raw, toEbc } of candidates) {
    const n = Number(str(raw));
    // A colour of 0 is not a real beer colour — treat it as "not reported".
    if (Number.isFinite(n) && n > 0) {
      return { ebc: String(Math.round(toEbc(n) * 10) / 10), estimated: false };
    }
  }

  const computed = ebcFromGrainBill(r, batchSizeL);
  return computed == null ? { ebc: '', estimated: false } : { ebc: String(computed), estimated: true };
}

/**
 * Grain colour: the API reports Lovibond, the brewery works in EBC.
 * SRM = 1.3546·°L − 0.76, and EBC = 1.97·SRM.
 *
 * Returns null when the recipe doesn't state a colour — note that a missing
 * value must not fall through to 0 °L, both because "unknown" and "colourless"
 * are different things on screen, and because the conversion's offset makes
 * 0 °L come out negative. The floor also keeps very pale sugars at 0 rather
 * than a nonsensical −1.5 EBC.
 */
function lovibondToEbc(lovibond: unknown): number | null {
  const raw = str(lovibond);
  if (raw === '') return null;
  const l = Number(raw);
  if (!Number.isFinite(l)) return null;
  return Math.max(0, Math.round((l * 1.3546 - 0.76) * 1.97 * 10) / 10);
}

function fermentables(r: BrewersFriendRecipe): RecipeFermentable[] {
  return (r.fermentables ?? []).map((f) => ({
    name: str(f.name),
    amount: str(f.amount),
    unit: str(f.unit),
    percent: str(f.percent),
    ebc: lovibondToEbc(f.lovibond),
  }));
}

/**
 * Reduce the recipe's own wording for a hop addition to a brew-day stage.
 * Brewer's Friend qualifies some uses ("Dry Hop (High Krausen)", "Aroma /
 * Whirlpool"), so this matches on substrings rather than exact values.
 */
function hopStage(use: string): HopStage {
  const u = use.toLowerCase();
  if (u.includes('dry')) return 'Dry Hop';
  if (u.includes('whirlpool') || u.includes('hopstand') || u.includes('aroma')) return 'Whirlpool';
  if (u.includes('first wort') || u.includes('fwh')) return 'First Wort';
  if (u.includes('mash')) return 'Mash';
  if (u.includes('boil')) return 'Boil';
  if (u === '') return 'Other';
  return 'Other';
}

/**
 * The hopstand temperature, but only where it's real. Additions that aren't a
 * whirlpool/hopstand come back carrying the boiling point as a placeholder —
 * 212 (°F) or 100 (°C) — which would render a dry hop as "@ 212°C". Anything at
 * or above boiling is therefore dropped, as is any temperature on a stage where
 * a hopstand temperature is meaningless.
 */
function hopstandTempC(raw: unknown, stage: HopStage): string {
  if (stage !== 'Whirlpool') return '';
  const value = str(raw);
  if (value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  // A whirlpool is by definition below boiling; 100 °C / 212 °F is the API's
  // "no hopstand" placeholder rather than a real steep temperature.
  if (n >= 100) return '';
  return value;
}

function hops(r: BrewersFriendRecipe): RecipeHop[] {
  return (r.hops ?? []).map((h) => {
    const use = str(h.hopuse);
    const stage = hopStage(use);
    const time = str(h.hoptime);
    return {
      name: str(h.name),
      amount: str(h.amount),
      unit: str(h.unit),
      use,
      stage,
      time,
      // Dry hops are stored in days, everything else in minutes.
      timeUnit: time === '' ? ('' as const) : stage === 'Dry Hop' ? ('day' as const) : ('min' as const),
      aa: str(h.aa),
      ibu: str(h.ibu),
      temp: hopstandTempC(h.hopstand_temp, stage),
    };
  });
}

/**
 * A yeast temperature bound in °C. The API reports these in the recipe's own
 * unit, so a Fahrenheit figure is converted — no strain ferments at 64 °C, and
 * none at 18 °F, so the unit field (when present) decides and the value's
 * magnitude is the fallback signal.
 */
function yeastTempC(raw: unknown, unit: string): number | null {
  const n = Number(str(raw));
  if (!Number.isFinite(n) || n === 0) return null;
  const isFahrenheit = unit.startsWith('f') || (unit === '' && n > 45);
  const c = isFahrenheit ? ((n - 32) * 5) / 9 : n;
  return Math.round(c * 10) / 10;
}

function yeasts(r: BrewersFriendRecipe): RecipeYeast[] {
  return (r.yeasts ?? []).map((y) => {
    const tempUnit = (str(y.temperatureunit) || str(y.tempunit) || str(y.unittemp))
      .toLowerCase();
    return {
      name: str(y.name),
      lab: str(y.laboratory) || str(y.lab),
      attenuation: str(y.attenuation),
      amount: str(y.amount),
      amountUnit: str(y.unit),
      type: str(y.type) || str(y.yeasttype),
      form: str(y.form) || str(y.yeastform),
      flocculation: str(y.flocculation),
      minTempC: yeastTempC(y.templo ?? y.mintemp ?? y.temperaturelo, tempUnit),
      maxTempC: yeastTempC(y.temphi ?? y.maxtemp ?? y.temperaturehi, tempUnit),
      alcoholTolerance: str(y.alcoholtolerance) || str(y.attenuationtolerance),
      // The API sends this as a 0/1 flag or a boolean depending on the field.
      starter: str(y.starter) === '1' || str(y.starter).toLowerCase() === 'true',
    };
  });
}

/** Salts, finings, spices and sugars — whichever key this account's plan uses. */
function otherIngredients(r: BrewersFriendRecipe): RecipeOtherIngredient[] {
  const source = (r.others ?? []).length > 0 ? (r.others ?? []) : (r.miscs ?? []);
  return source
    .map((m) => ({
      name: str(m.name),
      amount: str(m.amount),
      unit: str(m.unit),
      use: str(m.otheruse) || str(m.miscuse) || str(m.use),
      time: str(m.othertime) || str(m.misctime) || str(m.time),
      type: str(m.othertype) || str(m.type),
    }))
    // An unnamed row is a blank line in the brewer's recipe, not an ingredient.
    .filter((m) => m.name !== '');
}

function mashGuidelines(r: BrewersFriendRecipe): RecipeMashGuidelines | null {
  const steps: RecipeMashStep[] = (r.mashsteps ?? []).map((s) => {
    const temp = str(s.temp) || str(s.steptemp);
    const amount = str(s.amount);
    const step: RecipeMashStep = {
      name: str(s.mashtype) || str(s.name),
      temp: temp ? `${temp}°C` : null,
      time: str(s.mashtime) || str(s.steptime),
    };
    if (amount) step.amount = `${amount} ${str(s.unit)}`.trim();
    return step;
  });
  const notes = strOrNull(r.mashnotes) ?? strOrNull(r.notes_mash);
  if (steps.length === 0 && !notes) return null;
  return { steps, notes };
}

/** The recipe's target water chemistry, or null when it specifies none. */
function waterProfile(r: BrewersFriendRecipe): RecipeWaterProfile | null {
  const profile: RecipeWaterProfile = {
    name: strOrNull(r.waterprofile),
    ph: strOrNull(r.ph),
    notes: strOrNull(r.waternotes),
    calcium: strOrNull(r.ca2),
    magnesium: strOrNull(r.mg2),
    sodium: strOrNull(r.na),
    chloride: strOrNull(r.cl),
    sulfate: strOrNull(r.so4),
    bicarbonate: strOrNull(r.hco3),
  };
  const hasIons =
    profile.calcium !== null ||
    profile.magnesium !== null ||
    profile.sodium !== null ||
    profile.chloride !== null ||
    profile.sulfate !== null ||
    profile.bicarbonate !== null;
  if (!profile.name && !profile.ph && !hasIons) return null;
  return profile;
}
