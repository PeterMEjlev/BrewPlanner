import { z } from 'zod';

export * from './recipeCalculations.js';
export * from './mashPh.js';

/**
 * Shared types and validation schemas used by both the server and the web app.
 * Keeping these in one place guarantees the API contract stays in sync.
 */

// ---------------------------------------------------------------------------
// Domain models (shapes returned by the API)
// ---------------------------------------------------------------------------

export interface Checklist {
  id: number;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Step {
  id: number;
  checklistId: number;
  position: number;
  text: string;
  /** Optional longer explanation shown behind an info icon on the display. */
  description: string | null;
  required: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A checklist together with its ordered steps (admin detail view). */
export interface ChecklistWithSteps extends Checklist {
  steps: Step[];
}

/** A checklist row in the admin list, with a precomputed step count. */
export interface ChecklistSummary extends Checklist {
  stepCount: number;
}

/** A step enriched with the current run's check state (display view). */
export interface DisplayStep extends Step {
  checked: boolean;
  checkedAt: string | null;
}

/** Payload for the /display page and GET /api/active. */
export interface ActiveState {
  checklist: Checklist | null;
  runId: number | null;
  steps: DisplayStep[];
  progress: { completed: number; total: number };
}

/**
 * A brewery to-do item. This is a standalone, ongoing list — intentionally
 * separate from procedure checklists (no steps, no runs, no progress reset).
 */
export interface Todo {
  id: number;
  text: string;
  /** Optional longer explanation shown behind an info icon on the display. */
  description: string | null;
  done: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
}

/**
 * Account privilege. `admin` can do everything (control devices, edit kegs,
 * manage settings and other accounts); `guest` is read-only — it can view the
 * dashboard and graphs but cannot change anything, and cannot open the Brew
 * System page. Trusted-local requests (the Pi kiosk on the LAN) are treated as
 * admin-equivalent regardless of role; see `AuthState.isLocal`.
 */
export type UserRole = 'admin' | 'guest';

/**
 * An authenticated user. The password hash never leaves the server, so the
 * shape exposed to the client is intentionally just the public fields.
 */
export interface User {
  id: number;
  username: string;
  role: UserRole;
  createdAt: string;
}

/**
 * Result of GET /api/auth/me. `isLocal` is true when the request reached the
 * server directly on the LAN/loopback (e.g. the Pi's own kiosk) rather than
 * through the public Cloudflare tunnel — those requests are trusted without a
 * login so operators are never locked out of the physical touchscreen.
 */
export interface AuthState {
  user: User | null;
  isLocal: boolean;
}

// ---------------------------------------------------------------------------
// BrewPlanner recipe library (with optional Brewer's Friend provenance)
// ---------------------------------------------------------------------------

/**
 * A recipe from the user's Brewer's Friend account, normalized down to the
 * fields the list views need. The server reads the BrewPlanner recipe library
 * held server-side) and maps each recipe to this shape. The full brew sheet —
 * ingredients, mash, water — is a separate, heavier fetch: {@link RecipeDetail}.
 */
export interface Recipe {
  id: string;
  /** Where this app-owned recipe originally came from. */
  origin?: RecipeOrigin;
  name: string;
  /** Beer style (e.g. "West Coast IPA"); may be empty if the recipe has none. */
  style: string;
  /** Target ABV as a bare number string (e.g. "5.2"); empty if unknown. */
  abv: string;
  /** Public Brewer's Friend recipe page URL; empty if unknown. */
  url: string;
  /**
   * Bitterness (Tinseth IBU) as a bare number string; empty if unknown.
   * Optional because the stored "active recipe" predates these two fields —
   * a selection saved by an older build won't have them.
   */
  ibu?: string;
  /** Colour in EBC as a bare number string; empty if unknown. */
  ebc?: string;
  /**
   * When the recipe was created on Brewer's Friend, as the API states it
   * (ISO-ish, "2026-03-14 09:12:00"). Empty when the account's response
   * doesn't carry a date; optional for the same reason as `ibu`/`ebc` — an
   * active-recipe selection saved by an older build won't have it.
   */
  createdAt?: string;
  /** Last save in BrewPlanner. Missing on active-recipe snapshots from old builds. */
  updatedAt?: string;
}

export type RecipeOrigin = 'local' | 'brewersfriend';

/** Brewing-system and calculation choices that belong to one recipe. */
export interface RecipeSettings {
  styleCategory: string;
  styleSubcategory: string;
  batchTarget: string;
  boilSizePreL: number | null;
  boilSizePostL: number | null;
  autoBoilSizePre: boolean;
  autoBoilSizePost: boolean;
  boilTimeMinutes: number | null;
  /**
   * The equipment side of the boil volumes — properties of the kettle and
   * burner rather than of the beer, but stored per recipe because that is where
   * Brewer's Friend keeps them and a recipe imported from there carries its own.
   * See {@link autoBoilVolumes} for how the three combine.
   */
  /** Litres the kettle drives off per hour of boil. */
  boilOffLPerHour: number | null;
  /** Wort left behind with the trub when the kettle is drained. */
  trubChillerLossL: number | null;
  efficiencyPercent: number | null;
  pitchRate: string;
}

export const DEFAULT_RECIPE_SETTINGS: RecipeSettings = {
  styleCategory: '',
  styleSubcategory: '',
  batchTarget: 'Fermenter',
  boilSizePreL: null,
  boilSizePostL: null,
  autoBoilSizePre: true,
  autoBoilSizePost: true,
  boilTimeMinutes: 60,
  // Read off this brewery's Brewer's Friend equipment profile, so a recipe built
  // here lands on the volumes it would have there — see {@link autoBoilVolumes}.
  boilOffLPerHour: 7,
  trubChillerLossL: 2,
  efficiencyPercent: 80,
  pitchRate: 'Manufacturer recommended',
};

/**
 * The figures a blank brew sheet opens on (GET/PUT /api/recipe-defaults).
 *
 * Server-shared rather than per-browser: these describe the brewhouse, not the
 * screen looking at it. The kettle boils off what it boils off whether the
 * recipe is being written on the kiosk, a laptop or the phone, so all three
 * should start a new recipe on the same numbers.
 *
 * Only what a *new* recipe starts from. Changing them never touches a recipe
 * already saved — a sheet keeps the volumes and efficiency it was brewed to.
 */
export interface RecipeDefaults {
  /** Litres into the fermenter — this brewery's usual batch. */
  batchSizeL: number;
  /** Whether the batch size means the fermenter or the kettle. */
  batchTarget: string;
  boilTimeMinutes: number;
  /** Brewhouse efficiency %, what the mash is expected to actually extract. */
  efficiencyPercent: number;
  /** Litres the kettle drives off per hour — see {@link autoBoilVolumes}. */
  boilOffLPerHour: number;
  /** Litres left behind with the trub and in the chiller. */
  trubChillerLossL: number;
  pitchRate: string;
  /** Strike water per kilo of grain, which sets the first mash step's volume. */
  mashThicknessLPerKg: number;
  /** Temperature the strike water goes in at… */
  mashStrikeTempC: number;
  /** …and the temperature the mash settles to. */
  mashTargetTempC: number;
  /** How long that first rest holds. */
  mashStepMinutes: number;
}

/**
 * This brewery's own numbers, which is where these started life — hardcoded in
 * the new-recipe page and the mash section until they became editable.
 */
export const DEFAULT_RECIPE_DEFAULTS: RecipeDefaults = {
  batchSizeL: 55,
  batchTarget: 'Fermenter',
  boilTimeMinutes: 60,
  efficiencyPercent: 80,
  boilOffLPerHour: 7,
  trubChillerLossL: 2,
  pitchRate: 'Manufacturer recommended',
  mashThicknessLPerKg: 3,
  mashStrikeTempC: 71,
  mashTargetTempC: 69,
  mashStepMinutes: 60,
};

/**
 * A recipe-library backup file, as written to the Pi and uploaded to Drive.
 *
 * Deliberately the editable sheet of each recipe and nothing derived: prices,
 * gram weights and costs are worked out from the shop catalogue on every read,
 * so storing them would be backing up the shop rather than the recipe. Restoring
 * is a replay of `POST /api/recipes` over `recipes[].recipe`.
 */
export interface RecipeBackupFile {
  app: 'BrewPlanner';
  kind: 'recipe-library';
  /** Bumped if the shape ever changes, so a restore knows what it is reading. */
  version: 1;
  exportedAt: string;
  recipeCount: number;
  /** Ids whose stored sheet could not be parsed, so a short file says why. */
  unreadableIds: string[];
  recipes: Array<{
    id: string;
    origin: RecipeOrigin;
    url: string;
    createdAt: string;
    updatedAt: string;
    recipe: RecipeEditInput;
  }>;
}

/** What one backup run did (POST /api/recipes/backup). */
export interface RecipeBackupResult {
  at: string;
  /** True when a scheduled run found nothing had changed since the last one. */
  skipped: boolean;
  filename: string | null;
  recipeCount: number;
  unreadableIds: string[];
  localPath: string | null;
  driveFileId: string | null;
  /** Why the Drive half didn't happen; the local copy is written regardless. */
  driveError: string | null;
}

/** Backup state without taking one (GET /api/recipes/backup). */
export interface RecipeBackupStatus {
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  lastFilename: string | null;
  lastRecipeCount: number | null;
  lastDriveFileId: string | null;
  driveConfigured: boolean;
  /** Which credential the server is set up with, or null for none. */
  driveAuthMethod: 'oauth' | 'service-account' | null;
  driveFolderId: string;
  localDir: string;
  keepLocal: number;
}

/**
 * The single "currently in the fermenter" recipe selection (GET/PUT /api/recipe).
 * `recipe` is null when nothing has been chosen yet.
 */
export interface ActiveRecipe {
  recipe: Recipe | null;
}

/**
 * Whether the vessel has been washed since the last beer came out of it — the
 * same distinction the keg board draws between an emptied keg and a ready one.
 * Only meaningful while nothing is in the fermenter.
 */
export type FermenterState = 'clean' | 'dirty';

/**
 * The fermenter's cleanliness (GET/PUT /api/fermenter), kept apart from the
 * recipe selection so emptying the tank doesn't silently claim it's been washed.
 * `state` is null until someone says which it is.
 */
export interface FermenterStatus {
  state: FermenterState | null;
}

// ---------------------------------------------------------------------------
// Brew sessions — the brewery's logbook
// ---------------------------------------------------------------------------

/**
 * Where a batch is in its life. A brew session starts at `brewing` (which is also
 * what makes the hub log the rig's pot temperatures — see the sampler), moves to
 * `fermenting` when the wort is pitched, `conditioning` once fermentation is
 * done and it's cold-crashing or carbonating, and ends at `packaged`.
 */
export type BrewSessionStatus = 'brewing' | 'fermenting' | 'conditioning' | 'packaged';

export const BREW_SESSION_STATUSES: BrewSessionStatus[] = [
  'brewing',
  'fermenting',
  'conditioning',
  'packaged',
];

export const BREW_SESSION_STATUS_LABELS: Record<BrewSessionStatus, string> = {
  brewing: 'Brew session',
  fermenting: 'Fermenting',
  conditioning: 'Conditioning',
  packaged: 'Packaged',
};

/**
 * The recipe as it read on the day it was brewed, copied onto the brew session when
 * it starts. A log has to stay truthful about what was actually brewed, and the
 * recipe it came from is a living document — it gets re-costed as the shop's
 * prices move, edited between batches, and can be deleted outright. Hence a
 * snapshot rather than a join: `recipeId` is only the link back to the library.
 */
export interface BrewSessionRecipeSnapshot {
  name: string;
  style: string;
  /** Targets, as bare number strings in the shape the brew sheet holds them. */
  og: string;
  fg: string;
  abv: string;
  ibu: string;
  ebc: string;
  /** Litres into the fermenter the recipe was written for; null if unstated. */
  batchSizeL: number | null;
  /** Pre-formatted mash and fermentation temperatures (e.g. "67°C"); null if unstated. */
  mashTemp: string | null;
  fermentationTemp: string | null;
  /** What the ingredients cost that day, DKK. Null when nothing could be priced. */
  costDkk: number | null;
  /** Grain bill in kg and total hops in grams, as the sheet stood. */
  grainKg: number | null;
  hopGrams: number | null;
  /** The strain(s) the recipe pitches, comma-joined; empty when it names none. */
  yeast: string;
  /**
   * The grain bill's extract at perfect extraction, in point-gallons (see
   * {@link extractPotential}) — what the day's measured efficiency is a
   * percentage of. Snapshotted with the rest because it's a property of the
   * bill that was actually mashed, not of whatever the recipe says today.
   *
   * Null on an entry logged before this was recorded, or a bill of ingredients
   * the fermentable table doesn't recognise; efficiency then stays whatever the
   * brewer typed, rather than being calculated from a wrong denominator.
   */
  mashedPointGallons: number | null;
  unmashedPointGallons: number | null;
  /** The unmashed share already in the kettle pre-boil, for mash efficiency. */
  preBoilUnmashedPointGallons: number | null;
}

/**
 * What actually happened, as opposed to what the recipe targeted. Every field is
 * the brewer's own measurement and starts empty — an unmeasured figure stays
 * blank rather than inheriting the recipe's hope for it.
 *
 * Gravities are strings for the same reason recipe gravities are: a value that
 * can't be parsed still displays rather than becoming NaN.
 */
export interface BrewSessionMeasurements {
  preBoilGravity: string;
  /** Litres in the kettle when that pre-boil gravity was taken. */
  preBoilVolumeL: number | null;
  og: string;
  fg: string;
  /** Litres that actually made it into the fermenter. */
  volumeL: number | null;
  /** The mash temperature as held, °C. */
  mashTempC: number | null;
  boilTimeMin: number | null;
  /**
   * Brewhouse efficiency, %. Normally left empty — it's calculated from the
   * measured OG and volume against the snapshotted grain bill (see
   * {@link measuredEfficiency}) — and set only to overrule that, when the
   * brewer knows a volume was eyeballed and the arithmetic off.
   */
  efficiencyPct: number | null;
  /** Brewing liquor drawn for the batch, litres. */
  waterL: number | null;
  /** Electricity the brew session used, kWh. */
  energyKwh: number | null;
}

export const EMPTY_BREW_SESSION_MEASUREMENTS: BrewSessionMeasurements = {
  preBoilGravity: '',
  preBoilVolumeL: null,
  og: '',
  fg: '',
  volumeL: null,
  mashTempC: null,
  boilTimeMin: null,
  efficiencyPct: null,
  waterL: null,
  energyKwh: null,
};

/** One brew session in the log — what the Brew Sessions list shows per row. */
export interface BrewSession {
  id: number;
  /** The library recipe this came from; null once that recipe has been deleted. */
  recipeId: string | null;
  recipe: BrewSessionRecipeSnapshot;
  status: BrewSessionStatus;
  /** The brew session itself. Editable, so a batch can be logged after the fact. */
  brewedAt: string;
  /** How long the brew session took, in minutes. Null until the brewer says. */
  durationMinutes: number | null;
  /** Which brew of this recipe this was: 1 for the first, 2 for the second… */
  brewNumber: number;
  /** When the yeast went in, and when the batch was packaged. Null until they happen. */
  pitchedAt: string | null;
  packagedAt: string | null;
  measured: BrewSessionMeasurements;
  /** How the beer turned out, 1–5. Null until it's been tasted. */
  rating: number | null;
  /** Free-form brew-session notes, and how it tasted once packaged. */
  notes: string;
  tastingNotes: string;
  createdAt: string;
  updatedAt: string;
}

/** One logged reading of the rig's three pots, °C. Null where a sensor didn't answer. */
export interface BrewSessionRigSample {
  at: string;
  bk: number | null;
  mlt: number | null;
  hlt: number | null;
}

/** Min/mean/max over a logged series. Null series are reported as null, not zeroes. */
export interface BrewSessionTempStats {
  min: number;
  avg: number;
  max: number;
  /** How many samples the figures are drawn from. */
  count: number;
}

/** The rig's three pots summarised over the brew session. */
export interface BrewSessionRigStats {
  bk: BrewSessionTempStats | null;
  mlt: BrewSessionTempStats | null;
  hlt: BrewSessionTempStats | null;
}

/**
 * The fermentation half, derived on read from the telemetry the hub already
 * stores rather than copied onto the brew session — the readings are the record, and
 * the window (pitched → packaged, or → now while it's still going) can move as
 * the brewer corrects the dates.
 */
export interface BrewSessionFermentation {
  /** Fermenter temperature over the window; null when nothing was logged. */
  temp: BrewSessionTempStats | null;
  /** Gravity from a Tilt, when one was in the tank for this batch. */
  gravity: {
    start: number;
    end: number;
    min: number;
    max: number;
    count: number;
  } | null;
  /** Days from pitching to packaging, or to now while it's still fermenting. */
  days: number | null;
  /** Which device the figures came from, for the caption under them. */
  deviceName: string | null;
}

/** One brew session in full (GET /api/brew-sessions/:id) — the detail page. */
export interface BrewSessionDetail extends BrewSession {
  /** The rig's pot temperatures, logged while the brew session was in progress. */
  rigSamples: BrewSessionRigSample[];
  rigStats: BrewSessionRigStats;
  fermentation: BrewSessionFermentation;
}

/** How often one recipe has been brewed, for the badge on the recipe grid. */
export interface RecipeBrewCount {
  recipeId: string;
  count: number;
  /** The most recent brew session for this recipe. */
  lastBrewedAt: string;
}

/**
 * Apparent attenuation, %, from a measured OG and FG — how much of the extract
 * the yeast actually took. Null unless both gravities parse and OG is above 1.
 */
export function apparentAttenuation(og: string | number, fg: string | number): number | null {
  const o = typeof og === 'number' ? og : Number.parseFloat(og);
  const f = typeof fg === 'number' ? fg : Number.parseFloat(fg);
  if (!Number.isFinite(o) || !Number.isFinite(f) || o <= 1) return null;
  return ((o - f) / (o - 1)) * 100;
}

/**
 * ABV from a measured OG and FG, by the same formula the recipe calculations
 * use. Null unless both parse.
 */
export function abvFromGravities(og: string | number, fg: string | number): number | null {
  const o = typeof og === 'number' ? og : Number.parseFloat(og);
  const f = typeof fg === 'number' ? fg : Number.parseFloat(fg);
  if (!Number.isFinite(o) || !Number.isFinite(f)) return null;
  return (o - f) * 131.25;
}

/** Body for `POST /api/brew-sessions` — start (or back-date) a brew session for a recipe. */
export const startBrewSessionSchema = z.object({
  recipeId: z.string().trim().min(1).max(200),
  /** Defaults to now on the server; sent when logging a brew that already happened. */
  brewedAt: z.string().datetime({ offset: true }).optional(),
});
export type StartBrewSessionInput = z.infer<typeof startBrewSessionSchema>;

/** A measured gravity, kept as text like the recipe's own figures. */
const measuredGravity = z.string().trim().max(20);
/** A measured quantity: a number, or null to clear it back to unmeasured. */
const measuredNumber = (max: number) => z.number().min(0).max(max).nullable();
const optionalTimestamp = z.string().datetime({ offset: true }).nullable();

export const brewSessionMeasurementsSchema = z
  .object({
    preBoilGravity: measuredGravity,
    preBoilVolumeL: measuredNumber(10_000),
    og: measuredGravity,
    fg: measuredGravity,
    volumeL: measuredNumber(10_000),
    mashTempC: measuredNumber(120),
    boilTimeMin: measuredNumber(1_440),
    // Room above 100: this is only ever set to overrule the calculated figure,
    // and a brewer correcting one that came out at 104% must be able to say so.
    efficiencyPct: measuredNumber(200),
    waterL: measuredNumber(10_000),
    energyKwh: measuredNumber(10_000),
  })
  .partial();

/**
 * Body for `PATCH /api/brew-sessions/:id`. Every field is optional — the detail page
 * saves the one thing that changed — and the nullable ones accept null to clear
 * a figure back to unmeasured rather than to zero.
 */
export const updateBrewSessionSchema = z.object({
  status: z.enum(['brewing', 'fermenting', 'conditioning', 'packaged']).optional(),
  brewedAt: z.string().datetime({ offset: true }).optional(),
  // Three days is a generous ceiling for a brew session and still catches a
  // mistyped figure that would otherwise read as a fortnight in the kettle.
  durationMinutes: z.number().int().min(0).max(3 * 24 * 60).nullable().optional(),
  pitchedAt: optionalTimestamp.optional(),
  packagedAt: optionalTimestamp.optional(),
  measured: brewSessionMeasurementsSchema.optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  notes: z.string().max(20_000).optional(),
  tastingNotes: z.string().max(20_000).optional(),
});
export type UpdateBrewSessionInput = z.infer<typeof updateBrewSessionSchema>;

/**
 * What one ingredient line costs, priced against the local catalogue in
 * `prices/`. Null on an ingredient the catalogue doesn't stock or hasn't priced —
 * never a guess.
 */
export interface IngredientPrice {
  /**
   * Cost of the amount the recipe actually uses (grams × price per kg). The true
   * cost of this line in the finished beer, and the only figure that can be
   * summed across lines — see {@link RecipeCost.buyDkk} for why buying can't.
   */
  usedDkk: number;
  /** Catalogue price per kg; null for anything not sold by weight. */
  pricePerKgDkk: number | null;
  /**
   * The package the shop sells it in. Null for a pitchable unit with no stated
   * weight — a liquid yeast pack is one pitch, not a number of grams.
   */
  packageSizeG: number | null;
  packagePriceDkk: number;
  /**
   * How many packages this line consumes, fractionally (3.8 kg of malt in 100 g
   * bags is 38; 40 g of hops from a 100 g bag is 0.4). Repeats of one product sum
   * these before rounding up, which is how the buying figure stays honest.
   */
  packageFraction: number;
  /** The catalogue entry this was priced against, so a match can be checked. */
  matchedName: string;
  /**
   * Catalogue id. Repeats of one product across several additions (Citra in the
   * whirlpool and twice as a dry hop) pool under this before being rounded up to
   * whole packages.
   */
  catalogueId: string;
  /** How many other listings matched the name; the cheapest was used. */
  alternatives: number;
  /** Whether this price was matched automatically or decided by the brewer. */
  source: PriceSource;
  /**
   * Why the price is what it is, when that isn't obvious from `source` alone —
   * the wording of a built-in rule. Null for an ordinary catalogue match.
   */
  note: string | null;
}

/**
 * Which catalogue an ingredient is priced against. The four lists are matched by
 * different rules (a malt's colour is checked, a yeast's isn't), so a price
 * override has to say which one it belongs to — two ingredients may share a name
 * across kinds without being the same product.
 */
export type IngredientKind = 'fermentable' | 'hop' | 'yeast' | 'other';

export const INGREDIENT_KINDS: IngredientKind[] = ['fermentable', 'hop', 'yeast', 'other'];

/**
 * Where a line's price came from, so an automatic guess is never mistaken for a
 * decision the brewer made.
 *
 * - `catalogue` — the cheapest listing whose name matched.
 * - `chosen` — a listing the brewer pinned for this ingredient.
 * - `manual` — a price the brewer typed.
 * - `rule` — a built-in rule, explained by {@link IngredientPrice.note}.
 */
export type PriceSource = 'catalogue' | 'chosen' | 'manual' | 'rule';

/**
 * What a manual price is quoted per. Weight-sold ingredients (malt, hops, purée)
 * are priced per kilo the way the catalogue quotes them; a yeast pitch — and
 * anything else the shop sells without a stated weight — is priced per pack.
 */
export type PriceUnit = 'kg' | 'pack';

/**
 * One catalogue listing offered as an alternative for an ingredient. Sold-out
 * listings are left out: they aren't something the brewer can choose to buy.
 */
export interface PriceOption {
  catalogueId: string;
  /** Product name as the shop lists it, producer included. */
  label: string;
  /** The same listing without the producer — what the ingredient itself is called. */
  ingredientName: string;
  pricePerKgDkk: number | null;
  packagePriceDkk: number;
  /** Null for a pitchable unit the shop sells without a stated weight. */
  packageSizeG: number | null;
  /** What this line would cost against this listing; null if they can't be reconciled. */
  usedDkk: number | null;
  /** True for the listing the automatic rule picks — the cheapest for this line. */
  isDefault: boolean;
  /** True for the listing currently in effect. */
  isSelected: boolean;
  /**
   * Who makes it, on its own rather than only as the opening words of
   * {@link label} — so a picker can group by maltster without having to guess
   * where the brand ends and the malt begins. Null where the shop states none.
   */
  producer?: string | null;
  /** Malt colour range carried by the catalogue listing. */
  ebcMin?: number | null;
  ebcMax?: number | null;
  /** Hop alpha acid percentage carried by the catalogue listing. */
  aa?: number | null;
}

/**
 * A price decision the brewer has made for one ingredient, stored against the
 * ingredient's name rather than a recipe: pricing "Voss Kveik" once should hold
 * everywhere it's pitched. Either half may stand alone — pinning a product
 * without touching its price, or typing a price for something the shop doesn't
 * stock at all.
 */
export interface IngredientPriceOverride {
  kind: IngredientKind;
  /** The ingredient name as the brewer last saw it, for display. */
  label: string;
  /** Catalogue listing to use; null when the price is entirely manual. */
  catalogueId: string | null;
  /** The typed price; null when only the product was pinned. */
  unitPriceDkk: number | null;
  /** What `unitPriceDkk` is quoted per. Null when there's no manual price. */
  priceUnit: PriceUnit | null;
  /** The package that price refers to; null means one pack/pitch of no stated weight. */
  packageSizeG: number | null;
  updatedAt: string;
}

/**
 * Everything the price picker needs for one ingredient line (GET
 * /api/prices/options): the listings that match its name, and whatever decision
 * is already saved for it.
 */
export interface IngredientPriceOptions {
  kind: IngredientKind;
  /** The name as asked for. */
  name: string;
  /** In-stock catalogue listings whose name matches this ingredient. */
  matched: PriceOption[];
  /** The saved decision for this ingredient, or null while it's automatic. */
  override: IngredientPriceOverride | null;
  /** What the line is priced at now, so the picker can show its provenance. */
  price: IngredientPrice | null;
}

/** One product to buy, pooling every addition of it in the recipe. */
export interface PurchaseLine {
  catalogueId: string;
  name: string;
  /** Total the recipe needs across all its additions; null if not sold by weight. */
  grams: number | null;
  /** Whole packages that covers. */
  packages: number;
  packageSizeG: number | null;
  /** `packages` × package price. */
  totalDkk: number;
}

/**
 * A recipe's ingredient cost. Computed server-side because `buyDkk` is not a sum
 * of the per-line figures: 3 × 30 g of Citra is one 100 g bag, not three, so the
 * grams have to be pooled per product before rounding up.
 */
export interface RecipeCost {
  /** Cost of the amounts used, over every priced line. */
  usedDkk: number;
  /** Cost of the packages to buy, pooled per product. */
  buyDkk: number;
  /** Ingredient lines that were priced. */
  priced: number;
  /** Lines with an amount but no catalogue price. */
  unpriced: number;
  /** The shopping list behind `buyDkk`. */
  purchase: PurchaseLine[];
}

/**
 * The figures the Recipes list can't get from the list response, because they
 * need the ingredients (GET /api/recipes/stats): what a recipe costs and how
 * heavily it's hopped. One heavy pass covers both, so the grid can sort by
 * either. Every field is null when it can't be worked out — an unknown, which
 * the grid sorts last, rather than a zero.
 */
export interface RecipeStats {
  id: string;
  /** Ingredient cost of the amounts the recipe uses, DKK. */
  usedDkk: number | null;
  /** Lines with an amount but no catalogue price — why a total may be short. */
  unpriced: number;
  /** Total hops, grams. */
  hopGrams: number | null;
  /** Batch size in litres, as the cost/hop rates are per-batch figures. */
  batchSizeL: number | null;
  /** `hopGrams / batchSizeL` — the brewery's shorthand for how hoppy a beer is. */
  hopsPerL: number | null;
  /**
   * The colour the beer is expected to pour once its fruit is in, #rrggbb.
   * Null when nothing fruity was found, when the malt colour is unknown, or
   * when there's no batch size to dose against — the grid falls back to the
   * plain EBC colour then. See {@link predictBeerColor}.
   */
  fruitColor: string | null;
  /** Why that colour, for the swatch's tooltip. Null whenever `fruitColor` is. */
  fruitNote: string | null;
}

/** GET /api/recipes/stats — one entry per recipe in the account. */
export interface RecipeStatsResponse {
  stats: RecipeStats[];
  pricing: RecipePricing;
}

/** Where a recipe's prices came from, shown as a note under the cost. */
export interface RecipePricing {
  /** ISO 4217 code; the catalogue is Danish, so DKK. */
  currency: string;
  /** Date the catalogue was scraped, e.g. "2026-07-26". */
  lastChecked: string;
  /** Shop the catalogue came from. */
  source: string;
  /** False when no catalogue could be read at all. */
  available: boolean;
}

/** One malt/sugar in a recipe's grain bill. */
export interface RecipeFermentable {
  name: string;
  /** Amount as written in the recipe, with `unit` (kg, g, lb, oz). */
  amount: string;
  unit: string;
  /** Share of the total grain bill, as a bare number string; may be empty. */
  percent: string;
  /** Grain colour in EBC, converted from the API's Lovibond; null if unknown. */
  ebc: number | null;
  /** Extract potential in points per pound per gallon; estimated by name when absent. */
  ppg: number | null;
  /**
   * Whether yeast can reach these points. Null defers to what the fermentable
   * is — lactose and maltodextrin don't ferment — and an explicit value is the
   * brewer overriding that.
   */
  fermentable: boolean | null;
  /**
   * Added late enough that the boil never sees it, so it stays out of the boil
   * gravity the hops are utilized against while still counting towards OG.
   */
  lateAddition: boolean;
  /** Weight in grams, normalized from `amount`/`unit`; null if unreadable. */
  grams: number | null;
  price: IngredientPrice | null;
}

/**
 * How a hop addition gets used, normalized into the stages a brewer works in.
 * Brewer's Friend's own `hopuse` strings carry qualifiers ("Dry Hop (High
 * Krausen)"), so they're grouped down to these to drive the hop schedule's
 * sub-sections; the original string stays on the addition as `use`.
 */
export type HopStage = 'Mash' | 'First Wort' | 'Boil' | 'Whirlpool' | 'Dry Hop' | 'Other';

/** Hop stages in the order they happen on brew session, for grouped display. */
export const HOP_STAGE_ORDER: HopStage[] = [
  'Mash',
  'First Wort',
  'Boil',
  'Whirlpool',
  'Dry Hop',
  'Other',
];

/** One hop addition. */
export interface RecipeHop {
  name: string;
  amount: string;
  unit: string;
  /** The recipe's own wording, e.g. "Dry Hop (High Krausen)". */
  use: string;
  /** `use` reduced to a brew-session stage, for grouping. */
  stage: HopStage;
  /** Contact time as a bare number string; the unit is `timeUnit`. */
  time: string;
  /**
   * What `time` is measured in. Boil and whirlpool additions are minutes; dry
   * hops are days (Brewer's Friend stores them that way, so rendering them as
   * minutes turns a 5-day dry hop into "5 min"). Empty when there's no time.
   */
  timeUnit: 'min' | 'day' | '';
  /** Alpha acid %, as a bare number string. */
  aa: string;
  /** This addition's own IBU contribution. */
  ibu: string;
  /** Pellet, leaf/whole, plug, extract, or another custom form. */
  form: string;
  /** Hopstand utilisation percentage when explicitly overridden. */
  utilization: string;
  /**
   * Whirlpool/hopstand temperature in °C — only set where it means something
   * (a whirlpool/hopstand). Empty elsewhere, including for the boiling-point
   * placeholder the API returns on additions that have no hopstand.
   */
  temp: string;
  /** Weight in grams, normalized from `amount`/`unit`; null if unreadable. */
  grams: number | null;
  price: IngredientPrice | null;
}

/** A yeast (or bacteria/brett) pitch. */
export interface RecipeYeast {
  name: string;
  /** Producer, e.g. "Fermentis". */
  lab: string;
  /** Expected apparent attenuation %, as a bare number string. */
  attenuation: string;
  amount: string;
  amountUnit: string;
  /** "Ale", "Lager", "Brett"…; empty when the recipe doesn't say. */
  type: string;
  /** "Dry", "Liquid", "Slant"…; empty when unknown. */
  form: string;
  /** "Low", "Medium", "High"…; empty when unknown. */
  flocculation: string;
  /** Bottom of the producer's recommended range, °C; null when unknown. */
  minTempC: number | null;
  /** Top of the producer's recommended range, °C; null when unknown. */
  maxTempC: number | null;
  /** Alcohol tolerance as the producer states it (often "%" or "high"). */
  alcoholTolerance: string;
  /** Whether the recipe calls for a starter. */
  starter: boolean;
  /** Weight in grams, normalized from `amount`/`amountUnit`; null if unreadable. */
  grams: number | null;
  /**
   * Packs/vials, for a pitch the recipe counts rather than weighs ("1 pkg" of
   * liquid yeast). Null when it states a weight. One of this and `grams` is what
   * the pricing costs against, so both travel to the client — the price picker
   * has to ask about the same amount the recipe was costed at.
   */
  units: number | null;
  price: IngredientPrice | null;
}

/**
 * Anything that isn't malt, hops or yeast: fruit purées, salts, finings, spices,
 * sugar. Priced like any other line where the catalogue covers it — a 3 kg tub of
 * mango purée is a real part of what a sour costs, and often the largest.
 */
export interface RecipeOtherIngredient {
  name: string;
  amount: string;
  unit: string;
  /** "Mash", "Boil", "Primary"… */
  use: string;
  /** Contact time as a bare number string. */
  time: string;
  /** Unit for `time`; other ingredients commonly use minutes or days. */
  timeUnit: 'min' | 'day' | '';
  /** "Water Agt", "Fining", "Spice"… */
  type: string;
  /** Weight in grams, normalized from `amount`/`unit`; null if unreadable. */
  grams: number | null;
  /** Packs, for a line the recipe counts rather than weighs ("1 each"). */
  units: number | null;
  price: IngredientPrice | null;
}

/** One rest in the mash schedule. */
export interface RecipeMashStep {
  /** Step name or type ("Infusion", "Sacc rest"); may be empty. */
  name: string;
  /** Temperature with unit, pre-formatted (e.g. "67°C"); null if unset. */
  temp: string | null;
  /** Rest length in minutes, as a bare number string; may be empty. */
  time: string;
  /** Infusion/strike amount with unit, when the step lists one. */
  amount?: string;
  /** Unit for the separately editable infusion/strike amount. */
  amountUnit: string;
  /** Starting liquor/grain temperature in °C, when specified. */
  startTemp: string | null;
  /** Strike, infusion, temperature, decoction, sparge, or a custom type. */
  type: string;
  /** Optional step description. */
  description: string;
}

export interface RecipeMashGuidelines {
  startingThicknessLPerKg: number | null;
  grainTempC: number | null;
  /**
   * Whether the first step's amount is the mash thickness applied to the grain
   * bill, recomputed as either changes, rather than a number the brewer typed.
   * Only ever governs `steps[0]` — a later infusion or sparge addition has no
   * formula to switch back to.
   */
  autoStrikeVolume: boolean;
  steps: RecipeMashStep[];
  notes: string | null;
}

/**
 * A recipe's *target* brewing-water profile: ion concentrations in ppm (mg/L),
 * as entered on Brewer's Friend. Deliberately just the targets — turning them
 * into salt additions is the water calculator's job (see `apps/web/src/water.ts`),
 * which solves for actual salt masses rather than pretending ppm × litres is a
 * weight of gypsum.
 */
export interface RecipeWaterProfile {
  /** Source-water preset/profile name. */
  sourceName: string | null;
  /** Profile name ("Balanced", "Burton"…); null when unnamed. */
  name: string | null;
  /** Target mash pH; null when unset. */
  ph: string | null;
  notes: string | null;
  /** Ca²⁺, ppm. Null when the recipe leaves it blank. */
  calcium: string | null;
  /** Mg²⁺, ppm. */
  magnesium: string | null;
  /** Na⁺, ppm. */
  sodium: string | null;
  /** Cl⁻, ppm. */
  chloride: string | null;
  /** SO₄²⁻, ppm. */
  sulfate: string | null;
  /** HCO₃⁻, ppm. */
  bicarbonate: string | null;
}

/**
 * The full brew sheet for one recipe (GET /api/recipes/:id) — everything the
 * Recipes detail page shows. Numbers stay strings in the shape Brewer's Friend
 * returns them; the UI formats them, so a value we can't parse still displays
 * rather than becoming NaN.
 */
export interface RecipeDetail {
  id: string;
  origin: RecipeOrigin;
  name: string;
  style: string;
  /** Original gravity, e.g. "1.062". */
  og: string;
  /** Pre-boil gravity; null when the recipe doesn't state one. */
  preBoilGravity: string | null;
  /** Post-boil gravity; null when the recipe doesn't state one. */
  postBoilGravity: string | null;
  /** Final gravity. */
  fg: string;
  abv: string;
  /** Tinseth IBU. */
  ibu: string;
  /** Colour in EBC. */
  ebc: string;
  /**
   * True when `ebc` was calculated here from the grain bill because the recipe
   * carried no usable colour figure — surfaced in the UI so an estimate isn't
   * mistaken for the recipe's own number.
   */
  ebcEstimated: boolean;
  /** Public Brewer's Friend recipe page URL. */
  url: string;
  /** Recipe creation time (upstream for imports, local clock for new recipes). */
  createdAt: string;
  /** Last save in BrewPlanner. */
  updatedAt: string;
  /** Batch size in litres (converted from gallons if needed); null if unknown. */
  batchSizeL: number | null;
  settings: RecipeSettings;
  /** Headline mash temperature, pre-formatted (e.g. "67°C"); null if unknown. */
  mashTemp: string | null;
  /** Primary fermentation temperature, pre-formatted; null if unknown. */
  fermentationTemp: string | null;
  fermentables: RecipeFermentable[];
  hops: RecipeHop[];
  yeast: RecipeYeast[];
  otherIngredients: RecipeOtherIngredient[];
  /** Null when the recipe has neither mash steps nor mash notes. */
  mashGuidelines: RecipeMashGuidelines | null;
  /** Null when the recipe specifies no water targets at all. */
  waterProfile: RecipeWaterProfile | null;
  /** Where the ingredient prices came from. */
  pricing: RecipePricing;
  /** What the batch costs in ingredients. */
  cost: RecipeCost;
}

// Recipe fields accepted by PUT /api/recipes/:id. Server-derived weights,
// catalogue matches and totals deliberately do not travel back from the form.
export type RecipeFermentableEdit = Omit<RecipeFermentable, 'grams' | 'price'>;
export type RecipeHopEdit = Omit<RecipeHop, 'grams' | 'price'>;
export type RecipeYeastEdit = Omit<RecipeYeast, 'grams' | 'units' | 'price'>;
export type RecipeOtherIngredientEdit = Omit<RecipeOtherIngredient, 'grams' | 'units' | 'price'>;

/** Full editable snapshot stored for a recipe. */
export interface RecipeEditInput {
  name: string;
  style: string;
  settings: RecipeSettings;
  og: string;
  preBoilGravity: string | null;
  postBoilGravity: string | null;
  fg: string;
  abv: string;
  ibu: string;
  ebc: string;
  /** Preserves the caveat when the displayed colour came from the grain bill. */
  ebcEstimated: boolean;
  batchSizeL: number | null;
  mashTemp: string | null;
  fermentationTemp: string | null;
  fermentables: RecipeFermentableEdit[];
  hops: RecipeHopEdit[];
  yeast: RecipeYeastEdit[];
  otherIngredients: RecipeOtherIngredientEdit[];
  mashGuidelines: RecipeMashGuidelines | null;
  waterProfile: RecipeWaterProfile | null;
}

/**
 * Today's daytime average outdoor temperature where the brewery is, used as the
 * grain temperature a new recipe starts from. Null `temperatureC` is never
 * sent — the endpoint answers with nothing at all when the lookup failed.
 */
export interface OutdoorTemperature {
  temperatureC: number;
  /** The date the average is for, as the weather service's local calendar day. */
  observedAt: string;
  /** Where it was taken, for the hint under the field. */
  location: string;
}

/** Result of a one-way import from the configured Brewer's Friend account. */
export interface RecipeImportResult {
  imported: number;
  skipped: number;
}

export interface RecipeIngredientOption {
  name: string;
  source: 'catalogue' | 'recipe';
  /**
   * The maltster or lab behind a catalogue listing. Null for a name a past
   * recipe supplied, which records what was brewed with rather than what was
   * bought and so says nothing about who made it.
   */
  producer?: string | null;
  /** Malt colour selected with the ingredient, in EBC. */
  ebc?: number | null;
  /** Catalogue range shown in the picker when the malt spans several colours. */
  ebcMin?: number | null;
  ebcMax?: number | null;
  /** Hop alpha acid percentage selected with the ingredient. */
  aa?: number | null;
  /** What the producer states about a yeast strain, for the editor to fill in. */
  yeast?: RecipeYeastSpec | null;
}

/**
 * A yeast strain's published characteristics, as the recipe editor writes them
 * onto a pitch when the brewer picks the strain — the same fields Brewer's
 * Friend fills in. Everything is optional in practice: a field is empty (or
 * null, for the temperatures) where the producer states nothing.
 */
export interface RecipeYeastSpec {
  lab: string;
  /** "Ale", "Lager", "Wheat", "Brett"… */
  type: string;
  /** "Dry" or "Liquid". */
  form: string;
  /** Typical apparent attenuation %, as a bare number string. */
  attenuation: string;
  flocculation: string;
  /** Bottom and top of the producer's recommended range, °C. */
  minTempC: number | null;
  maxTempC: number | null;
  alcoholTolerance: string;
}

/** A costed group of ingredient lines — one section of a recipe, or one stage. */
export interface CostTotal {
  /** Cost of the amounts used, summed over the lines that could be priced. */
  usedDkk: number;
  /** Lines that were priced. */
  priced: number;
  /** Lines with an amount but no catalogue price — why a total may be short. */
  unpriced: number;
}

/**
 * Sum what a group of ingredient lines consumes. Kept here so the recipe page,
 * its section headers and its hop stages all total the same way — and so
 * `unpriced` travels with the figure, since a total over partial coverage has to
 * say so rather than read as complete.
 *
 * Only ever sums `usedDkk`: buying cost isn't additive per line (see
 * {@link RecipeCost}), so it's computed once, server-side, for the whole recipe.
 */
export function sumCost(lines: { price: IngredientPrice | null }[]): CostTotal {
  let usedDkk = 0;
  let priced = 0;
  let unpriced = 0;
  for (const line of lines) {
    if (line.price) {
      usedDkk += line.price.usedDkk;
      priced++;
    } else {
      unpriced++;
    }
  }
  return { usedDkk: Math.round(usedDkk * 100) / 100, priced, unpriced };
}

/**
 * What an unsaved recipe costs (POST /api/recipes/price) — the editor's live
 * readout while a brew sheet is being filled in.
 *
 * Costed server-side for the same reason a saved recipe is: the catalogue and
 * the brewer's price overrides only exist there, and `cost.buyDkk` pools repeats
 * of one product before rounding up to whole packages. The per-section totals
 * come back with it so each section header can carry its own figure without the
 * client re-deriving what the server already worked out.
 */
export interface RecipeCostBreakdown {
  fermentables: CostTotal;
  hops: CostTotal;
  yeast: CostTotal;
  other: CostTotal;
  /** The whole sheet, including the buying figure and its shopping list. */
  cost: RecipeCost;
  pricing: RecipePricing;
  /** What the total is missing, so the editor can offer to fill it in. */
  unpricedLines: UnpricedIngredient[];
}

/**
 * One ingredient a recipe's cost is missing — everything needed both to show it
 * and to price it. The shop doesn't stock everything (and doesn't always name
 * what it does stock the way a recipe does), so a total drawn over part of a
 * grain bill has to be able to say which part, and let the brewer fix it.
 *
 * One entry per ingredient, not per addition: a price is stored against the
 * ingredient's name, so three dry-hop charges of the same Citra are a single
 * decision. `grams`/`units` are pooled across those additions, which is also
 * what makes the picker's "cheapest package" answer the right question.
 */
export interface UnpricedIngredient {
  kind: IngredientKind;
  name: string;
  /** Total weight the recipe calls for; null when it counts packs instead. */
  grams: number | null;
  /** Packs/vials, for an ingredient the recipe counts rather than weighs. */
  units: number | null;
  /** Malt colour, part of the automatic match (fermentables only). */
  ebc: number | null;
  /** How many additions of it there are, so one row can stand for all of them. */
  additions: number;
}

/**
 * The ingredients a recipe couldn't be costed on: every line the pricing pass
 * left without a figure, pooled per ingredient. Used by the server to report a
 * draft's gaps and by the recipe page to list a saved one's.
 *
 * A line with an amount nobody can read (a blank, or "some") lands here too,
 * with no weight and no count — it is genuinely uncosted, and saying so is more
 * use than leaving it out of both the total and the explanation.
 */
export function unpricedIngredients(recipe: {
  fermentables: RecipeFermentable[];
  hops: RecipeHop[];
  yeast: RecipeYeast[];
  otherIngredients: RecipeOtherIngredient[];
}): UnpricedIngredient[] {
  const pooled = new Map<string, UnpricedIngredient>();
  const add = (
    kind: IngredientKind,
    line: { name: string; price: IngredientPrice | null; grams: number | null },
    extra: { units?: number | null; ebc?: number | null } = {},
  ): void => {
    if (line.price || line.name.trim() === '') return;
    const key = `${kind}:${line.name.trim().toLocaleLowerCase()}`;
    const seen = pooled.get(key);
    if (!seen) {
      pooled.set(key, {
        kind,
        name: line.name.trim(),
        grams: line.grams,
        units: extra.units ?? null,
        ebc: extra.ebc ?? null,
        additions: 1,
      });
      return;
    }
    // A total only means something while every addition states one; mixing "40
    // g" with an amount nobody could read has to leave the weight unknown.
    seen.grams = seen.grams == null || line.grams == null ? null : seen.grams + line.grams;
    const units = extra.units ?? null;
    seen.units = seen.units == null || units == null ? null : seen.units + units;
    seen.additions += 1;
  };

  for (const line of recipe.fermentables) add('fermentable', line, { ebc: line.ebc });
  for (const line of recipe.hops) add('hop', line);
  for (const line of recipe.yeast) add('yeast', line, { units: line.units });
  for (const line of recipe.otherIngredients) add('other', line, { units: line.units });
  return [...pooled.values()];
}

// ---------------------------------------------------------------------------
// Telemetry: satellite devices and their sensor readings
// ---------------------------------------------------------------------------

/**
 * Known device kinds. Kept as a string union (not an enum) so a new satellite
 * can be added without a schema migration — the dashboard renders an unknown
 * type with a generic tile. Each kind only picks a tile icon; the actual metrics
 * a device reports are free-form (see `Reading.metric`), so adding a metric to
 * an existing kind needs no change here.
 *
 * - `pressure_sensor` — fermentation pressure (`pressure_bar`).
 * - `brew_controller` — Inkbird ITC-308 fridge/heater, also reused for the
 *   brewery ambient thermometer (`temp_c`, `setpoint_c`, `hvac_state`).
 * - `power_meter`     — mains electricity (`power_w`, `energy_kwh`).
 * - `water_meter`     — water flow/usage (`flow_lpm`, `water_l`).
 * - `hydrometer`      — Tilt floating gravity sensor (`gravity_sg`, `temp_c`).
 */
export type DeviceType =
  | 'pressure_sensor'
  | 'brew_controller'
  | 'power_meter'
  | 'water_meter'
  | 'hydrometer'
  | 'other';

/**
 * A satellite that pushes data to the hub (e.g. the fermentation-pressure Pi).
 * The API key never leaves the server — only its hash is stored — so the shape
 * exposed to the client deliberately omits it.
 */
export interface Device {
  id: number;
  name: string;
  type: DeviceType;
  /** ISO timestamp of the last accepted push, or null if never seen. */
  lastSeenAt: string | null;
  /**
   * The client IP that sent the device's most recent push, or null if never
   * seen. Satellites push to the hub directly over the LAN, so this is the
   * device's local address (e.g. `192.168.0.42`) — useful for SSHing in or
   * spotting a sensor that moved networks. Captured server-side on each push.
   */
  lastIp: string | null;
  /**
   * The device's own network MAC address (lowercase, colon-separated), reported
   * by its agent on push. Unlike `lastIp` — which a DHCP lease can change — this
   * is a stable hardware id for the satellite. The link-layer address never
   * survives the trip to the hub, so the agent has to send it; agents that can't
   * determine a real MAC (and mock/placeholder devices) leave it null. The
   * dashboard only shows it when present.
   */
  mac: string | null;
  /**
   * The name the device carries in its own manufacturer app — e.g. what an
   * Inkbird controller is called in the Inkbird/Tuya app ("Birdy Boi"). Reported
   * by the agent, because the name is an account-side attribute the device never
   * exposes on the LAN (the Tuya local protocol returns only data points).
   *
   * Deliberately separate from {@link Device.name}, the name the device was
   * registered under here: that one is load-bearing on the Overview page, which
   * picks out the brewery and keg-fridge controllers by name and groups a
   * fermenter station from the devices sharing one. This is the physical label,
   * shown so an operator can tell which box on the shelf a card refers to. Null
   * until an agent reports one (and for mock/placeholder devices).
   */
  vendorName: string | null;
  /**
   * How often (seconds) this device should log a reading — the single cadence
   * the operator tunes per device from the dashboard. The hub returns it to the
   * agent on every push so the agent matches its sample/push rate to it, and the
   * dashboards poll this device at the same rate. Defaults to 30.
   */
  reportingIntervalSec: number;
  createdAt: string;
}

/** A single time-series sample pushed by a device. */
export interface Reading {
  id: number;
  deviceId: number;
  /** Stable key for the quantity, e.g. `pressure_bar`, `temp_c`. */
  metric: string;
  value: number;
  recordedAt: string;
  /**
   * The extremes averaged into this point — set only on a bucketed response
   * (see `buckets` on {@link historyQuerySchema}), where `value` is a mean and
   * these are the real readings behind it. Absent on raw rows, where `value`
   * *is* the reading.
   *
   * Smoothing a line shouldn't cost the operator the true spread: a fridge drawn
   * as the steady 34.5 °C it averages is the honest picture of what it holds,
   * but "swung between 33.9 and 35.1" is the part that says whether the
   * compressor is behaving, and it has to come from somewhere.
   */
  min?: number;
  max?: number;
}

/** The most recent value for one metric on a device. */
export interface LatestReading {
  metric: string;
  value: number;
  recordedAt: string;
}

/**
 * All-time consumption for a cumulative metric (e.g. total energy or water).
 * It's the sum of positive step-to-step deltas across the metric's whole
 * history, so a meter that resets to zero — as the daily `energy_kwh`/`water_l`
 * counters do at midnight — still totals correctly over its lifetime.
 */
export interface MetricTotal {
  metric: string;
  total: number;
}

/**
 * A device enriched for the dashboard: whether it is currently considered online
 * and its latest value per metric. `online` is derived server-side from the
 * freshness of the device's most recent *reading* — it flips offline only after
 * several of the device's own reporting cycles pass with no new reading, so a
 * sensor whose local read fails intermittently rides through the odd miss but a
 * genuinely silent one is flagged.
 */
export interface DeviceStatus extends Device {
  online: boolean;
  latest: LatestReading[];
  /**
   * How many readings this device has logged over its whole lifetime (all
   * metrics). A coarse "is data actually flowing / how much have we stored"
   * signal for the Devices page; absent when not computed.
   */
  readingCount?: number;
  /**
   * A target setpoint the operator has requested but the controller hasn't yet
   * confirmed — i.e. there's a pending `set_setpoint` command waiting for the
   * agent to write it to the device. Null when nothing is pending; cleared once
   * the agent applies it (after which the device's own `setpoint_c` reading
   * reflects the new value). Lets the UI show "Setting to N°…".
   */
  pendingSetpointC?: number | null;
}

/**
 * A command queued for a satellite device to apply on its hardware. The hub
 * stores these; the device pulls its pending commands (device-key auth), acts,
 * then acks them. Today the only command is `set_setpoint` (target °C for a
 * brew controller), but the shape is generic so future controls fit without a
 * schema change.
 */
export interface DeviceCommand {
  id: number;
  deviceId: number;
  /** Command kind, e.g. `set_setpoint`. */
  command: string;
  /** The command's numeric argument (for `set_setpoint`, the target in °C). */
  value: number;
  createdAt: string;
}

/** The only command kind today: set a brew controller's target temperature. */
export const SET_SETPOINT_COMMAND = 'set_setpoint';

// ---------------------------------------------------------------------------
// Device data sources (mock vs. real sensor data)
// ---------------------------------------------------------------------------

/**
 * For each planned sensor, whether the dashboard shows synthesized **mock**
 * telemetry — the demo data the app ships with, so every tile looks alive before
 * any hardware exists — or the **real** readings pushed by that sensor's agent.
 * A sensor set to `real` that isn't reporting renders as "not connected" (greyed
 * out) instead of silently falling back to mock. The choice is stored on the hub
 * and shared across every screen (see {@link DeviceDataSources}).
 */
export type DeviceDataSource = 'mock' | 'real';

/**
 * One planned sensor the operator can flip between mock and real. `key` is the
 * stable id used as the map key in {@link DeviceDataSources}; `type` lets the UI
 * pick an icon. The catalog mirrors the server's mock-profile fleet (one entry
 * per planned sensor); the three Inkbird controllers are split by role — the
 * fermenter's fridge controller, the filled-keg fridge controller, and the
 * brewery's ambient thermometer.
 */
export interface SensorCatalogEntry {
  key: string;
  label: string;
  /** A short note shown under the label in Settings. */
  hint: string;
  type: DeviceType;
}

export const SENSOR_CATALOG: readonly SensorCatalogEntry[] = [
  {
    key: 'fermenter_pressure',
    label: 'Fermenter pressure',
    hint: 'Fermentation pressure sensor',
    type: 'pressure_sensor',
  },
  {
    key: 'fermenter_controller',
    label: 'Fermenter controller',
    hint: 'Inkbird fridge/heater — temperature, setpoint, cooling/heating',
    type: 'brew_controller',
  },
  {
    key: 'kegs_controller',
    label: 'Kegs controller',
    hint: 'Inkbird fridge/heater for the filled-keg fridge — temperature, setpoint, cooling/heating',
    type: 'brew_controller',
  },
  {
    key: 'brewery_temp',
    label: 'Brewery temperature',
    hint: 'Ambient Inkbird thermometer',
    type: 'brew_controller',
  },
  { key: 'power', label: 'Power meter', hint: 'Mains electricity — power and energy', type: 'power_meter' },
  { key: 'water', label: 'Water meter', hint: 'Water flow and usage', type: 'water_meter' },
  {
    key: 'fermenter_gravity',
    label: 'Fermenter gravity',
    hint: 'Tilt hydrometer — gravity and beer temperature',
    type: 'hydrometer',
  },
];

/** Per-sensor source choice, keyed by {@link SensorCatalogEntry.key}. */
export type DeviceDataSources = Record<string, DeviceDataSource>;

/** Every planned sensor defaults to mock, preserving the ships-with demo data. */
export const DEFAULT_DEVICE_DATA_SOURCES: DeviceDataSources = Object.fromEntries(
  SENSOR_CATALOG.map((s) => [s.key, 'mock' as DeviceDataSource]),
);

// ---------------------------------------------------------------------------
// Alerts (server-recorded history)
// ---------------------------------------------------------------------------

/** Severity of an alert, most urgent first. Drives the badge/row colour. */
export type AlertSeverity = 'critical' | 'warning' | 'info';

/**
 * What produced an alert.
 *
 * Two kinds live here. **Episode** sources describe a condition that starts and
 * later ends — `device_offline` and every `CRITICAL_ALERT_SOURCES` entry — and
 * are raised once when the condition begins and resolved when the readings come
 * back to normal, so a fridge that stays broken buzzes the phone once rather
 * than every tick. **Event** sources (`keg_age`, `ferment_done`) are one-shot
 * facts with nothing to resolve.
 */
export type AlertSource =
  | 'device_offline'
  | 'keg_age'
  | 'ferment_done'
  | 'fermenter_pressure_lost'
  | 'fermenter_pressure_high'
  | 'fermenter_hot'
  | 'fermenter_stalled'
  | 'kegs_warm'
  | 'brewery_cold';

/**
 * The telemetry conditions that mean something in the brewery is going wrong
 * right now — a lost seal, a fridge that has stopped cooling, beer warming up.
 * These are the ones the hub interrupts a phone for; the rest are recorded to
 * the Alerts page and left there.
 */
export const CRITICAL_ALERT_SOURCES = [
  'fermenter_pressure_lost',
  'fermenter_pressure_high',
  'fermenter_hot',
  'fermenter_stalled',
  'kegs_warm',
  'brewery_cold',
] as const satisfies readonly AlertSource[];

export type CriticalAlertSource = (typeof CRITICAL_ALERT_SOURCES)[number];

/**
 * A recorded alert event, kept as history on the server — unlike the
 * dashboard's live-derived "active alerts" feed. `resolvedAt` is set when a
 * self-clearing condition ends (an episode source: the device came back, the
 * pressure recovered, the fridge caught up); event alerts (keg age,
 * fermentation done) never resolve. `dismissedAt` is set when a user clicks the
 * alert away on the dashboard, which removes it from every feed (the server
 * omits dismissed alerts from listings).
 */
export interface Alert {
  id: number;
  /** The device this concerns, or null for alerts not tied to one. */
  deviceId: number | null;
  source: AlertSource;
  severity: AlertSeverity;
  title: string;
  detail: string;
  createdAt: string;
  resolvedAt: string | null;
  dismissedAt: string | null;
}

/** Query for `GET /api/alerts`: how many of the most recent alerts to return. */
export const alertsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
});
export type AlertsQuery = z.infer<typeof alertsQuerySchema>;

// ---------------------------------------------------------------------------
// Change history (server-recorded audit log)
// ---------------------------------------------------------------------------

/**
 * One recorded change to server state — every successful admin mutation is
 * logged by the audit hook and surfaced on the History page, newest first.
 * `username` is a snapshot taken when the change happened, so the entry still
 * reads sensibly after the account is renamed or deleted (`userId` then becomes
 * null but the name stays). Trusted-local kiosk/LAN changes, which have no
 * logged-in user, are attributed to "Local kiosk". `action` is the
 * human-readable summary; `entity` is a coarse category (e.g. "Checklist",
 * "Keg", "Account") for the row's chip; `method`/`path` are kept for reference.
 */
export interface AuditEntry {
  id: number;
  userId: number | null;
  username: string;
  action: string;
  entity: string | null;
  method: string;
  path: string;
  createdAt: string;
}

/**
 * Query for `GET /api/history`: how many of the most recent entries to return,
 * and which of them.
 *
 * Filtering is the server's job rather than the browser's because the log is
 * read newest-first under a cap — filtering a page of 200 in the browser would
 * search only the newest 200 changes, so "everything Peter did to the kegs" would
 * silently stop at whatever the last fortnight happened to contain.
 */
export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).optional(),
  /** Only changes at or after this instant (ISO 8601). */
  since: z.string().datetime().optional(),
  /** Only changes made by this account, matched exactly. */
  username: z.string().trim().min(1).max(100).optional(),
  /** Only changes in this category — the entity the audit rules tag rows with. */
  entity: z.string().trim().min(1).max(50).optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

/**
 * The values actually present in the change log, for the History page's filter
 * dropdowns. Drawn from the log itself rather than from a fixed list so the
 * options are always ones that would return something — an account that never
 * made a change, or a category nothing has been logged under, isn't offered.
 */
export interface AuditFilters {
  usernames: string[];
  entities: string[];
}

// ---------------------------------------------------------------------------
// Keg inventory (shared Google Sheet)
// ---------------------------------------------------------------------------

/**
 * Keg inventory lives in a published Google Sheet — the same one the brew-system
 * app reads. The sheet is CORS-enabled, so the web app pulls the CSV straight
 * from the browser; the server fetches the same URL for the keg-age notification.
 * Keeping the URL, column layout, parsing, and default per-content colours here
 * gives both sides the same starting point. The server can override the colours
 * from its saved Settings palette.
 */
const KEG_SHEET_ID = '1c5CWo_-7lS9C0HSklylLVgFAT4OwADm2Svqfr9x28Do';
export const KEG_SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${KEG_SHEET_ID}/export?format=csv&gid=0`;
/** Human-facing sheet URL for "open in a new tab" links. */
export const KEG_SHEET_VIEW_URL = `https://docs.google.com/spreadsheets/d/${KEG_SHEET_ID}/edit`;

/**
 * Per-content colours, chosen to evoke the actual appearance of each beer / keg
 * state. Mirrors the brew-system app so a keg looks the same everywhere.
 */
export const DEFAULT_KEG_CONTENT_COLORS = {
  IPA: '#C8782A', // amber copper
  NEIPA: '#3ee849', // hazy orange-gold
  Wiessbeer: '#E8C84A', // cloudy banana-gold
  Sour: '#D64878', // tart raspberry pink
  'Brown Ale': '#7A3B1A', // rich mahogany
  Starsan: '#b8faff', // sanitiser blue
  SIPA: '#2a9826', // session IPA green
  Pilsner: '#DEC05C', // pale straw gold
  Stout: '#3A2A1A', // near-black dark roast
  Dirty: '#ff0000', // warning red
  Clean: '#ffffff', // fresh
  '???': '#707070', // neutral grey
};
export type KegContent = keyof typeof DEFAULT_KEG_CONTENT_COLORS;
export type KegContentColors = Record<KegContent, string>;
export const KEG_CONTENT_COLORS: KegContentColors = DEFAULT_KEG_CONTENT_COLORS;

/**
 * The selectable keg-content values, in display order, for the desktop editor's
 * dropdown. Derived from the colour palette so the two never drift — every
 * option has a colour and vice versa.
 */
export const KEG_CONTENT_OPTIONS = Object.keys(DEFAULT_KEG_CONTENT_COLORS) as KegContent[];

/**
 * Terms that map a recipe onto one of the palette's beer types, in match order —
 * the first hit wins, so the more specific rule has to come first.
 *
 * Sour leads, as it does in {@link STYLE_CATEGORY_RULES} and for the same
 * reason: a Berliner Weisse is a wheat beer and a sour IPA is an IPA, but what
 * either one pours as — and what the keg board is saying — is sour. NEIPA and
 * SIPA are subsets of IPA, so both precede the bare IPA rule.
 *
 * Word boundaries matter: bare "ipa" would otherwise match "Ipanema", and "wit"
 * would match "Wit(h) Honey". Styles the palette has no colour for
 * (Saison, Helles Bock, Schwarzbier) are deliberately left unmatched rather than
 * forced into the nearest slot — a missing colour is honest, a wrong one isn't.
 */
const CONTENT_MATCH_RULES: [KegContent, RegExp][] = [
  ['Sour', /\b(sour|gose|berliner|lambic|gueuze|geuze|kriek|flanders|oud bruin|wild ale|brett\w*)\b/],
  ['Stout', /\b(stout|porter)\b/],
  ['NEIPA', /\b(neipa|ne ipa|new england|hazy)\b/],
  ['SIPA', /\b(sipa|session ipa)\b/],
  ['IPA', /\b(ipa|iipa|india pale ale)\b/],
  // "wiess" as well as "weiss": that's the spelling the palette itself uses.
  ['Wiessbeer', /\b(wheat|weizen|w(ei|ie)ss\w*|wit|witbier|hefe\w*)\b/],
  ['Pilsner', /\b(pilsner|pils|lager|helles)\b/],
  ['Brown Ale', /\b(brown ale|nut brown)\b/],
];

/**
 * Best-effort map of a recipe's name/style onto one of the known content
 * options, so linking a Brewer's Friend recipe can pre-fill the contents field
 * (e.g. "Galaxy NEIPA" → "NEIPA", "My Tropical Gose" → "Sour"). Returns null
 * when nothing matches, leaving the caller to fall back to the recipe name.
 *
 * Name and style are tested together, one rule at a time, so priority is decided
 * by the rules rather than by which field happened to mention a beer first —
 * "Peach Fuzz" / "Berliner Weisse" is a sour, whichever half says so. They're
 * joined by a separator no pattern can span, so no rule matches a phrase that
 * only exists across the seam.
 */
export function matchContentOption(recipeName: string, recipeStyle = ''): KegContent | null {
  const text = `${recipeName} | ${recipeStyle}`.toLowerCase();
  for (const [content, pattern] of CONTENT_MATCH_RULES) {
    if (pattern.test(text)) return content;
  }
  return null;
}

/**
 * Broad style families, in the order the Recipes page sorts them: pale and hoppy
 * first, then malty, dark, and the odd ones out. Wider than the keg palette's
 * content types on purpose — a "Berliner Weisse" and a "Gose" wear different keg
 * colours but belong in one group when sorting a recipe list by type.
 */
export const RECIPE_STYLE_CATEGORIES = [
  'IPA',
  'Pale Ale',
  'Lager',
  'Wheat',
  'Belgian & Strong',
  'Sour',
  'Amber & Brown',
  'Stout & Porter',
  'Other',
] as const;
export type RecipeStyleCategory = (typeof RECIPE_STYLE_CATEGORIES)[number];

/**
 * Terms that place a style in a family, checked in this order — the first hit
 * wins, so the more specific rule has to come first. Sour leads because "Sour
 * IPA" and "Berliner Weisse" name a second family too; wheat beats lager so a
 * Weizenbock isn't filed under \bbock\b.
 *
 * Word boundaries matter: bare "alt" would otherwise match "Altbier" *and*
 * "Salted Caramel Stout".
 */
const STYLE_CATEGORY_RULES: [RecipeStyleCategory, RegExp][] = [
  ['Sour', /\b(sour|gose|berliner|lambic|gueuze|geuze|kriek|flanders|oud bruin|wild ale|brett\w*|funk)\b/],
  ['Stout & Porter', /\b(stout|porter)\b/],
  ['IPA', /\b(ipa|neipa|sipa|iipa|india pale ale|hazy)\b/],
  ['Wheat', /\b(wheat|weizen|w(ei|ie)ss\w*|wit|witbier|hefe\w*|dunkelweizen|weizenbock)\b/],
  ['Pale Ale', /\b(pale ale|apa|xpa|blonde|golden ale|k(ö|o)lsch|cream ale|summer ale)\b/],
  // German compounds glue the style onto a modifier — \w*bock catches Doppel-,
  // Eis- and Maibock, while Weizenbock is already claimed by the wheat rule above.
  ['Lager', /\b(lager|pilsner|pils|helles|m(ä|a)rzen|marzen|oktoberfest|festbier|\w*bock|schwarzbier|vienna|dunkel\w*|rauchbier|steam beer)\b/],
  ['Belgian & Strong', /\b(belgian|saison|farmhouse|tripel|dubbel|quad\w*|abbey|abbaye|trappist|barley ?wine|strong ale|old ale|wee heavy|imperial)\b/],
  ['Amber & Brown', /\b(amber|brown|red ale|irish red|alt|altbier|mild|scottish|bitter|esb)\b/],
];

/**
 * The style family a recipe belongs to, read from its style first and its name
 * second (a recipe with no style set often says "Galaxy NEIPA" in the title).
 * Never null — anything unrecognised sorts under "Other".
 */
export function styleCategory(recipe: { name: string; style: string }): RecipeStyleCategory {
  for (const text of [recipe.style, recipe.name]) {
    if (!text) continue;
    const t = text.toLowerCase();
    for (const [category, pattern] of STYLE_CATEGORY_RULES) {
      if (pattern.test(t)) return category;
    }
  }
  return 'Other';
}

// ---------------------------------------------------------------------------
// Beer colour — what a recipe pours, from its EBC and any fruit in it
// ---------------------------------------------------------------------------

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

/** A bare number string (or number) as a finite number, else null. */
function asNumber(value: string | number | null | undefined): number | null {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * The malt colour for an EBC value as #rrggbb, or null when the value isn't a
 * number (an empty field from the API) — callers render a hollow swatch then.
 *
 * This is the grain bill's colour only. What the beer actually pours once fruit
 * goes in is {@link predictBeerColor}.
 */
export function ebcColor(ebc: string | number | null | undefined): string | null {
  const n = asNumber(ebc);
  if (n == null) return null;
  const index = Math.min(Math.max(Math.round(ebcToSrm(n)) - 1, 0), SRM_COLORS.length - 1);
  return SRM_COLORS[index] ?? null;
}

/**
 * How a fruit stains beer.
 *
 * `pigment` is read as a *transmittance* rather than as a paint colour: it's
 * what a heavily fruited beer lets through per channel, so raspberry's near-zero
 * green is what makes a pale gose go red rather than orange. `strength` is
 * staining power relative to raspberry, which is what separates blackcurrant
 * (stains at a splash) from peach (barely shifts a pale ale at 20%).
 */
interface FruitTint {
  pigment: string;
  strength: number;
  /** Words that name this fruit, English and Danish, matched whole. */
  terms: string[];
}

/**
 * The fruits worth predicting, in match order — a name is tested against each in
 * turn and the first hit wins, so compounds come before the bare fruit they
 * contain ("blood orange" before "orange", "green apple" before "apple").
 *
 * Danish spellings are folded (ø→o, æ→ae, å→a) before matching, so the terms
 * here are the folded forms: "hindbaer", not "hindbær".
 */
const FRUIT_TINTS: FruitTint[] = [
  // Compounds first — these contain a bare fruit name as a substring.
  { pigment: '#FA4A1E', strength: 0.45, terms: ['blood orange', 'blodappelsin'] },
  { pigment: '#F0E6A0', strength: 0.08, terms: ['green apple', 'gron aeble'] },
  { pigment: '#FF7A0A', strength: 0.5, terms: ['sea buckthorn', 'buckthorn', 'havtorn'] },
  { pigment: '#FF8C64', strength: 0.12, terms: ['pink grapefruit', 'grapefruit', 'grapefrugt'] },
  { pigment: '#E62A96', strength: 0.6, terms: ['dragon fruit', 'dragonfruit', 'pitaya', 'pitahaya', 'kaktusblomst'] },

  // Deep red / purple — the ones that actually recolour a beer.
  { pigment: '#A01A64', strength: 1.0, terms: ['blackcurrant', 'black currant', 'cassis', 'solbaer'] },
  { pigment: '#8A1A5A', strength: 1.0, terms: ['elderberry', 'hyldebaer'] },
  { pigment: '#6A2A8C', strength: 0.95, terms: ['acai'] },
  { pigment: '#A81F7A', strength: 0.95, terms: ['blackberry', 'blackberries', 'brombaer'] },
  { pigment: '#FA1A47', strength: 0.9, terms: ['raspberry', 'raspberries', 'hindbaer'] },
  // "blåbær" folds to "blabaer" (å→a); "blaabaer" is the ASCII spelling people
  // also write, so both are listed.
  { pigment: '#7A2AB4', strength: 0.8, terms: ['blueberry', 'blueberries', 'blabaer', 'blaabaer'] },
  { pigment: '#E01432', strength: 0.8, terms: ['cherry', 'cherries', 'morello', 'kirsebaer', 'kriek'] },
  { pigment: '#D01438', strength: 0.7, terms: ['pomegranate', 'granataeble'] },
  { pigment: '#E01438', strength: 0.7, terms: ['cranberry', 'cranberries', 'tranebaer'] },
  { pigment: '#F02040', strength: 0.7, terms: ['redcurrant', 'red currant', 'ribs'] },
  { pigment: '#B02A6E', strength: 0.6, terms: ['plum', 'blomme', 'mirabelle'] },
  { pigment: '#FA3C64', strength: 0.5, terms: ['strawberry', 'strawberries', 'jordbaer'] },
  { pigment: '#F5647D', strength: 0.35, terms: ['rhubarb', 'rabarber'] },
  { pigment: '#A05A78', strength: 0.3, terms: ['fig', 'figen', 'figne'] },

  // Orange / gold — a visible warm shift, but they never make a beer red.
  { pigment: '#FF9632', strength: 0.3, terms: ['papaya'] },
  { pigment: '#FF8C6E', strength: 0.3, terms: ['guava'] },
  { pigment: '#FFA83C', strength: 0.3, terms: ['apricot', 'abrikos'] },
  { pigment: '#FFB41E', strength: 0.3, terms: ['mango'] },
  { pigment: '#FFB428', strength: 0.3, terms: ['passionfruit', 'passion fruit', 'passionsfrugt', 'passion', 'maracuja'] },
  { pigment: '#FFBE6E', strength: 0.25, terms: ['peach', 'fersken', 'nectarine'] },
  { pigment: '#FFD24A', strength: 0.2, terms: ['pineapple', 'ananas'] },
  { pigment: '#FFA032', strength: 0.15, terms: ['tangerine', 'tangerin', 'mandarin', 'clementine'] },
  { pigment: '#FF7A8C', strength: 0.15, terms: ['watermelon', 'vandmelon'] },
  { pigment: '#FFD27A', strength: 0.12, terms: ['melon', 'cantaloupe'] },
  { pigment: '#FFA83C', strength: 0.12, terms: ['orange', 'appelsin', 'valencia'] },

  // Pale to colourless — listed so they're recognised as fruit and reported as
  // "no visible shift" rather than silently ignored.
  { pigment: '#FFF08C', strength: 0.1, terms: ['lemon', 'citron', 'lime', 'calamansi', 'bergamot'] },
  { pigment: '#FFF08C', strength: 0.08, terms: ['yuzu'] },
  { pigment: '#FFE6A0', strength: 0.08, terms: ['banana', 'banan'] },
  { pigment: '#F0E6A0', strength: 0.08, terms: ['apple', 'aeble', 'pear', 'paere', 'williams'] },
  { pigment: '#FFF0DC', strength: 0.05, terms: ['lychee', 'litchi', 'soursop', 'guanabana'] },
  { pigment: '#FFFFFF', strength: 0.03, terms: ['coconut', 'kokos'] },
  { pigment: '#FFFFF0', strength: 0.02, terms: ['elderflower', 'hyldeblomst'] },
];

/**
 * Fold a name the way the fruit terms are written: lowercased, Danish letters
 * opened up, accents dropped, punctuation flattened to single spaces.
 */
function foldName(name: string): string {
  return name
    .toLowerCase()
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/å/g, 'a')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Endings Danish glues straight onto a fruit name — "Solbærpuré",
 * "Havtornpuré", "Blodappelsinpuré" are each one word, and the fruit inside is
 * only reachable by peeling the ending off. Longest first, so "frugtpure" is
 * taken whole rather than leaving a stray "frugt".
 */
const GLUED_ENDINGS = ['frugtpure', 'koncentrat', 'concentrate', 'puree', 'pure', 'juice', 'saft', 'pulp'];

/**
 * The fruit an ingredient line names, or null when it isn't a fruit.
 *
 * Matching is on whole words, so "lime" can't match "slimed" and "passion
 * fruit" matches as a phrase. Compound words are additionally offered stemmed,
 * which is what lets a recipe written as "Solbærpuré" reach blackcurrant.
 */
function matchFruit(name: string): FruitTint | null {
  const words = foldName(name).split(' ').filter(Boolean);
  // Every ending that fits, not just the first: "passionsfrugtpure" stems to
  // both "passions" (peeling "frugtpure") and "passionsfrugt" (peeling "pure"),
  // and only the second is the fruit.
  const stems = words.flatMap((word) =>
    GLUED_ENDINGS.filter((e) => word.length > e.length && word.endsWith(e)).map((e) =>
      word.slice(0, -e.length),
    ),
  );
  const text = ` ${[...words, ...stems].join(' ')} `;
  for (const tint of FRUIT_TINTS) {
    if (tint.terms.some((term) => text.includes(` ${term} `))) return tint;
  }
  return null;
}

/** One thing added to the batch that might colour it. */
export interface ColorAddition {
  name: string;
  /** Weight in grams; null when the recipe states a count rather than a weight. */
  grams: number | null;
}

/** What the fruit in a recipe does to its colour. */
export interface FruitTintSummary {
  /** The fruits found, heaviest dose first. */
  names: string[];
  /** Total fruit added, litres (purée is taken as 1 kg per litre). */
  litres: number;
  /** Share of the batch that is fruit, 0–1. */
  fraction: number;
  /** 0–1: how far the colour was pulled from the malt colour toward the fruit. */
  intensity: number;
  /** One line explaining the swatch, for its tooltip. */
  note: string;
}

export interface PredictedColor {
  /** What the beer is expected to pour, #rrggbb. */
  hex: string;
  /** Null when no fruit was found — `hex` is then just the malt colour. */
  fruit: FruitTintSummary | null;
}

/**
 * How hard fruit stains, per unit of (strength × batch fraction). Tuned against
 * the house reference: 5 L of raspberry purée in a 55 L pale Berliner Weisse
 * comes out emphatically red, which is what that beer actually looks like.
 */
const FRUIT_TINT_SCALE = 8;

/**
 * The colour a recipe is expected to pour, malt plus fruit.
 *
 * Fruit is mixed in transmittance space rather than blended as paint, because
 * that is what the liquid actually does: each channel of the base colour is
 * multiplied by the fruit's own transmittance raised to the dose. Two things
 * fall out of that for free, both of which alpha-blending gets wrong. A pale
 * beer goes properly *red* rather than muddy orange, because raspberry passes
 * almost no green whatever the base was passing. And a stout stays black with
 * only a ruby edge, because you cannot make a dark beer lighter by adding
 * pigment to it — no separate "dark beers mask fruit" rule is needed.
 *
 * Returns null when the malt colour is unknown, since there's then no base to
 * stain — the caller draws a hollow swatch, as it always has.
 */
export function predictBeerColor(input: {
  ebc: string | number | null | undefined;
  /** Batch size in litres; without it there's no dose, only a weight. */
  batchSizeL: number | null;
  additions: ColorAddition[];
}): PredictedColor | null {
  const base = ebcColor(input.ebc);
  if (base == null) return null;

  const doses = input.additions
    .map((addition) => {
      const tint = matchFruit(addition.name);
      if (tint == null || addition.grams == null || addition.grams <= 0) return null;
      return { tint, name: addition.name.trim(), litres: addition.grams / 1000 };
    })
    .filter((d): d is { tint: FruitTint; name: string; litres: number } => d != null)
    .sort((a, b) => b.litres - a.litres);

  const batchSizeL = input.batchSizeL;
  if (doses.length === 0 || batchSizeL == null || batchSizeL <= 0) {
    return { hex: base, fruit: null };
  }

  // Beer–Lambert: stack each fruit's transmittance, raised to its own dose.
  const rgb = hexToRgb(base);
  const stained: [number, number, number] = [rgb[0], rgb[1], rgb[2]];
  for (const dose of doses) {
    const exponent = (dose.tint.strength * dose.litres * FRUIT_TINT_SCALE) / batchSizeL;
    const pigment = hexToRgb(dose.tint.pigment);
    for (let i = 0; i < 3; i++) {
      stained[i] = stained[i]! * Math.pow(pigment[i]! / 255, exponent);
    }
  }

  const litres = doses.reduce((sum, d) => sum + d.litres, 0);
  const fraction = litres / batchSizeL;
  // How far the colour actually moved, as a share of the distance it could have
  // moved — this is what "a strong red" versus "a hint of gold" means.
  const intensity = Math.min(
    1,
    Math.hypot(stained[0] - rgb[0], stained[1] - rgb[1], stained[2] - rgb[2]) / 255,
  );
  const names = dedupe(doses.map((d) => d.tint.terms[0] ?? d.name));

  return {
    hex: rgbToHex(stained),
    fruit: {
      names,
      litres: Math.round(litres * 10) / 10,
      fraction,
      intensity,
      note: fruitNote(names, litres, batchSizeL, fraction, intensity),
    },
  };
}

/** "5 L raspberry in a 55 L batch (9%) — expect a strong red". */
function fruitNote(
  names: string[],
  litres: number,
  batchSizeL: number,
  fraction: number,
  intensity: number,
): string {
  const strength =
    intensity >= 0.55
      ? 'a deep, saturated colour'
      : intensity >= 0.3
        ? 'a strong tint'
        : intensity >= 0.12
          ? 'a noticeable tint'
          : 'barely a shift';
  const round = (n: number): string => (n < 10 ? n.toFixed(1) : n.toFixed(0));
  return (
    `Predicted from the malt colour plus ${round(litres)} L ${names.join(' + ')} ` +
    `in a ${round(batchSizeL)} L batch (${Math.round(fraction * 100)}%) — expect ${strength}. ` +
    'An estimate: real fruit colour varies with variety, dose timing and how much drops out.'
  );
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase();
}

/** Colour for a keg's contents, or null when the content is unrecognised. */
export function getContentColor(
  contents: string,
  colors: KegContentColors = DEFAULT_KEG_CONTENT_COLORS,
): string | null {
  const key = (Object.keys(DEFAULT_KEG_CONTENT_COLORS) as KegContent[]).find(
    (k) => k.toLowerCase() === contents.trim().toLowerCase(),
  );
  return key ? colors[key] : null;
}

/**
 * Colour for a recipe's beer style, borrowed from the keg palette so a beer
 * wears the same colour everywhere it shows up — keg card, recipe list, and the
 * fermenter's title dot. Null when the style doesn't match a known content type.
 */
export function getRecipeColor(
  recipe: { name: string; style: string },
  colors: KegContentColors = DEFAULT_KEG_CONTENT_COLORS,
): string | null {
  const match = matchContentOption(recipe.name, recipe.style);
  return match ? colors[match] : null;
}

export interface Keg {
  number: string;
  contents: string;
  /** Resolved display colour for `contents`, as #rrggbb, or null if unknown. */
  color: string | null;
  /** Fill date as written in the sheet, DD/MM/YYYY. */
  date: string;
  note: string;
  volume: string;
  abv: string;
  /** Linked Brewer's Friend recipe id (sheet column H); empty if none. */
  recipeId: string;
}

/** Minimal CSV parser that respects quoted fields (no embedded newlines). */
function parseCSV(text: string): string[][] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const cols: string[] = [];
      let cur = '';
      let inQuotes = false;
      for (const ch of line) {
        if (ch === '"') {
          inQuotes = !inQuotes;
          continue;
        }
        if (ch === ',' && !inQuotes) {
          cols.push(cur.trim());
          cur = '';
          continue;
        }
        cur += ch;
      }
      cols.push(cur.trim());
      return cols;
    });
}

/** Parse the keg sheet CSV into rows. Row 0 is a banner, row 1 the headers. */
export function parseKegs(
  text: string,
  colors: KegContentColors = DEFAULT_KEG_CONTENT_COLORS,
): Keg[] {
  return parseCSV(text)
    .slice(2)
    .map((cols) => {
      const contents = cols[2] || '';
      return {
        number: cols[1] || '',
        contents,
        color: getContentColor(contents, colors),
        date: cols[3] || '',
        note: cols[4] || '',
        volume: cols[5] || '',
        abv: cols[6] || '',
        recipeId: cols[7] || '',
      };
    })
    .filter((k) => k.number);
}

/**
 * "Dirty" is the board's word for a keg that has just been emptied and is
 * waiting for a wash. The beer is gone, so everything it left behind goes with
 * it — see {@link EMPTIED_KEG_FIELDS}.
 */
export function isDirtyContents(contents: string): boolean {
  return contents.trim().toLowerCase() === 'dirty';
}

/**
 * What the beer takes with it when a keg is emptied. A dirty keg still carrying
 * the last beer's fill date, ABV and recipe link reads at a glance on the board
 * as though it were still full of that beer, and its stale fill date keeps
 * tripping the keg-age alert long after the beer was drunk.
 *
 * The note is deliberately not in here. It's the only field that can be about
 * the *keg* rather than the beer — "seal is weeping", "lid needs a new o-ring" —
 * and that's worth writing on a keg heading for the wash. The beer's old note
 * still goes: the editor blanks it as the keg turns dirty, and whatever is typed
 * after that sticks.
 *
 * Blank strings rather than omitted fields: the sheet writer leaves absent
 * columns untouched, so only an empty value actually clears the cell.
 */
export const EMPTIED_KEG_FIELDS = { date: '', abv: '', recipeId: '' } as const;

/**
 * Contents that are a keg *state* rather than a beer — what the board writes in
 * a keg nobody can pour from. A keg in one of these is free to be filled, which
 * is what makes it a candidate to receive a transfer.
 */
export const KEG_STATE_CONTENTS = ['???', 'Clean', 'Dirty', 'Starsan'];

/** Whether a keg holds something pourable, as opposed to a state or nothing. */
export function holdsBeer(contents: string): boolean {
  const c = contents.trim();
  return c !== '' && !KEG_STATE_CONTENTS.some((state) => state.toLowerCase() === c.toLowerCase());
}

/** Sheet dates are DD/MM/YYYY; returns an epoch-ms timestamp, or 0 if unparseable. */
export function parseKegDate(d: string): number {
  if (!d) return 0;
  const parts = d.split('/');
  if (parts.length === 3) {
    return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`).getTime() || 0;
  }
  return new Date(d).getTime() || 0;
}

// ---------------------------------------------------------------------------
// Notification settings (server-side, editable from the Settings page)
// ---------------------------------------------------------------------------

/**
 * Operator-tunable notification preferences. Persisted server-side (the
 * key-value `settings` table) — unlike the kiosk's localStorage prefs — because
 * the background scheduler that actually sends the alerts runs on the server and
 * must see one shared, authoritative value regardless of which browser changed
 * it. The Firebase credentials that carry the notifications are env vars, never
 * stored here.
 *
 * Thresholds are in the units the hub stores readings in — bar for pressure,
 * °C for temperature — not in whatever unit the browser happens to display.
 * The Settings page converts on the way in and out.
 */
export interface NotificationSettings {
  // --- Routine (one-shot events) -------------------------------------------
  /** Alert when a beer keg has been filled for at least `kegAlertDays`. */
  kegAlertEnabled: boolean;
  /** Age (days) at which a keg triggers the "drink it" alert. */
  kegAlertDays: number;
  /** Alert when the Tilt's gravity has held flat (fermentation complete). */
  fermentDoneEnabled: boolean;

  // --- Critical (episode conditions, pushed to the phones) -----------------
  /**
   * Alert when a fermenter that *was* pressurised falls to nothing — a blown
   * seal, an open PRV, a lost spunding valve. Self-arming, so an empty
   * fermenter sitting at zero never triggers it (see the server's critical.ts).
   */
  pressureLostEnabled: boolean;
  /** Bar at or below which pressure counts as lost. */
  pressureLostBar: number;
  /** Alert when fermenter pressure climbs past a safe ceiling. */
  pressureHighEnabled: boolean;
  /** Bar at or above which pressure counts as dangerous. */
  pressureHighBar: number;
  /** Alert when the fermenter chamber runs hot (a heater stuck on). */
  fermenterHotEnabled: boolean;
  /** °C at or above which the fermenter chamber counts as overheating. */
  fermenterHotC: number;
  /**
   * Alert when the fermenter controller is calling for heat or cooling but the
   * chamber just sits at brewery-ambient temperature — the fridge or heater
   * isn't actually doing anything (unplugged, tripped, or failed).
   */
  fermenterStalledEnabled: boolean;
  /** Alert when the filled-keg fridge warms up. */
  kegsWarmEnabled: boolean;
  /** °C at or above which the keg fridge counts as too warm. */
  kegsWarmC: number;
  /** Alert when the brewery drops toward freezing. */
  breweryColdEnabled: boolean;
  /** °C at or below which the brewery counts as dangerously cold. */
  breweryColdC: number;
  /**
   * Push the existing device-offline alert to the phones when the sensor that
   * went quiet is one the brewery depends on (the fermenter's pressure sensor,
   * controller or Tilt, and the keg fridge's controller). Offline alerts for
   * every device are recorded on the Alerts page regardless.
   */
  sensorOfflineEnabled: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  kegAlertEnabled: true,
  kegAlertDays: 30,
  fermentDoneEnabled: true,
  pressureLostEnabled: true,
  // ~0.7 psi: low enough that a fermenter still holding a token of pressure
  // isn't called empty, high enough to catch a sensor reading a hair above zero.
  pressureLostBar: 0.05,
  pressureHighEnabled: true,
  // ~29 psi. Well past any spunding setpoint, short of what a stainless
  // fermenter is rated for.
  pressureHighBar: 2,
  fermenterHotEnabled: true,
  fermenterHotC: 40,
  fermenterStalledEnabled: true,
  kegsWarmEnabled: true,
  kegsWarmC: 12,
  breweryColdEnabled: true,
  breweryColdC: 2,
  sensorOfflineEnabled: true,
};

// ---------------------------------------------------------------------------
// Graph colours (server-side, editable from the desktop Settings page)
// ---------------------------------------------------------------------------

/**
 * Per-metric line colours for every chart in the app. Persisted server-side (the
 * key-value `settings` table) so the palette is shared across screens — editing
 * it on the desktop Settings page also recolours the Pi kiosk's graphs. Beer and
 * fridge temperatures get their own keys because they're drawn together (both are
 * `temp_c`) and must stay distinguishable. Values are `#rrggbb` hex strings.
 */
export interface GraphColors {
  pressure: string;
  gravity: string;
  power: string;
  water: string;
  /** Beer/wort temperature (the fermenter's main temp line). */
  beerTemp: string;
  /** Fridge / brewery-ambient temperature (the muted "other" temp line). */
  fridgeTemp: string;
  /** The target-temperature reference line. */
  setpoint: string;
}

/** Defaults match the palette the dashboard shipped with (see Dashboard.tsx). */
export const DEFAULT_GRAPH_COLORS: GraphColors = {
  pressure: '#22d3ee', // cyan
  gravity: '#a78bfa', // purple
  power: '#eab308', // yellow
  water: '#3b82f6', // blue
  beerTemp: '#fb923c', // amber / orange
  fridgeTemp: '#d97706', // muted amber / orange
  setpoint: '#f59e0b', // amber reference line
};

// ---------------------------------------------------------------------------
// Request validation schemas (Zod)
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username is required').max(200),
  password: z.string().min(1, 'Password is required').max(500),
});
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Optional free-text description for a step or to-do. An empty/blank value is
 * accepted and normalized to "no description" (null) by the repository layer.
 */
const descriptionField = z.string().trim().max(2000).nullable();

export const createChecklistSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
});
export type CreateChecklistInput = z.infer<typeof createChecklistSchema>;

export const updateChecklistSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
});
export type UpdateChecklistInput = z.infer<typeof updateChecklistSchema>;

export const createStepSchema = z.object({
  text: z.string().trim().min(1, 'Step text is required').max(500),
  required: z.boolean().default(true),
});
export type CreateStepInput = z.infer<typeof createStepSchema>;

export const updateStepSchema = z
  .object({
    text: z.string().trim().min(1, 'Step text is required').max(500).optional(),
    required: z.boolean().optional(),
    description: descriptionField.optional(),
  })
  .refine(
    (v) => v.text !== undefined || v.required !== undefined || v.description !== undefined,
    { message: 'Provide at least one field to update' },
  );
export type UpdateStepInput = z.infer<typeof updateStepSchema>;

export const reorderStepsSchema = z.object({
  stepIds: z.array(z.number().int().positive()).min(1),
});
export type ReorderStepsInput = z.infer<typeof reorderStepsSchema>;

export const createTodoSchema = z.object({
  text: z.string().trim().min(1, 'To-do text is required').max(500),
});
export type CreateTodoInput = z.infer<typeof createTodoSchema>;

export const updateTodoSchema = z
  .object({
    text: z.string().trim().min(1, 'To-do text is required').max(500).optional(),
    done: z.boolean().optional(),
    description: descriptionField.optional(),
  })
  .refine(
    (v) => v.text !== undefined || v.done !== undefined || v.description !== undefined,
    { message: 'Provide at least one field to update' },
  );
export type UpdateTodoInput = z.infer<typeof updateTodoSchema>;

export const reorderTodosSchema = z.object({
  todoIds: z.array(z.number().int().positive()).min(1),
});
export type ReorderTodosInput = z.infer<typeof reorderTodosSchema>;

// --- Telemetry --------------------------------------------------------------

export const deviceTypeSchema = z.enum([
  'pressure_sensor',
  'brew_controller',
  'power_meter',
  'water_meter',
  'hydrometer',
  'other',
]);

export const createDeviceSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  type: deviceTypeSchema.default('other'),
});
export type CreateDeviceInput = z.infer<typeof createDeviceSchema>;

/**
 * Body for `POST /api/ingest`. A device pushes one or more readings; the
 * request itself doubles as a heartbeat, so an empty `readings` array is a
 * valid "I'm still alive" ping. `recordedAt` defaults to the server's receive
 * time when a sample omits it (satellites needn't have an accurate clock).
 */
export const ingestSchema = z.object({
  readings: z
    .array(
      z.object({
        metric: z.string().trim().min(1).max(64),
        value: z.number().finite(),
        // Accept any RFC3339 timestamp (a trailing `Z` or a `±hh:mm` offset),
        // since satellites may format their clock either way.
        recordedAt: z.string().datetime({ offset: true }).optional(),
      }),
    )
    .max(500)
    .default([]),
  /**
   * The device's own MAC address — heartbeat metadata, not a reading. Optional,
   * since older agents omit it. Accepts the usual colon- or hyphen-separated hex
   * and is normalized to canonical lowercase colon form so the stored value is
   * stable regardless of how the agent formatted it.
   */
  mac: z
    .string()
    .trim()
    .regex(/^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/, 'Must be a MAC address')
    .transform((m) => m.toLowerCase().replace(/-/g, ':'))
    .optional(),
  /**
   * The device's own LAN IP — heartbeat metadata, optional. Normally the hub just
   * uses the push's source IP (`req.ip`), which is correct when the agent runs on
   * the device itself. But an agent that polls a *separate* networked device (the
   * Inkbird controller is a Tuya box elsewhere on the LAN) knows the device's real
   * address and sends it here so the Devices page shows the controller's IP, not
   * the shared satellite host's. When present it overrides the source IP.
   *
   * A malformed value is dropped (treated as absent) rather than rejecting the
   * whole push — cosmetic metadata must never drop telemetry; the hub then just
   * uses the source IP for that push.
   */
  ip: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v && z.string().ip().safeParse(v).success ? v : undefined)),
  /**
   * The name the device carries in its manufacturer's app (see
   * {@link DeviceStatus.vendorName}) — heartbeat metadata, optional. An agent
   * that knows it (the Inkbird agent reads it from the tinytuya wizard's
   * `devices.json`) sends it so the Devices page can show which physical box a
   * card is. Never touches the device's registered `name`.
   *
   * An empty or over-long value is dropped rather than rejecting the push:
   * cosmetic metadata must never cost telemetry.
   */
  vendorName: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v && v.length <= 64 ? v : undefined)),
});
export type IngestInput = z.infer<typeof ingestSchema>;

/** Query for `GET /api/devices/:id/history`. */
export const historyQuerySchema = z.object({
  metric: z.string().trim().min(1).max(64).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().positive().max(5000).default(1000),
  /**
   * Average the window into this many equal-width time buckets instead of
   * returning raw rows — one point per bucket that has readings.
   *
   * `limit` alone can't summarize a window: it takes the *newest* N rows, so a
   * "last 24h" request for 200 points silently answers with the last couple of
   * hours at full resolution. Bucketing covers the whole window at a resolution
   * the caller picks, and averaging within a bucket is also what makes a
   * fridge's compressor cycling readable — a ±0.5 °C hysteresis swing collapses
   * to the line the brewer actually cares about, while a real drift survives.
   *
   * Requires `metric` and `since` (there's nothing sensible to average across
   * mixed metrics, or over an unbounded window); ignored without them.
   */
  buckets: z.coerce.number().int().positive().max(2000).optional(),
});
export type HistoryQuery = z.infer<typeof historyQuerySchema>;

/** Query for `GET /api/devices/:id/total` — the metric to total over all time. */
export const metricTotalQuerySchema = z.object({
  metric: z.string().trim().min(1).max(64),
});
export type MetricTotalQuery = z.infer<typeof metricTotalQuerySchema>;

/**
 * Body for `POST /api/devices/:id/setpoint` — the new target temperature (°C)
 * the operator wants the controller to hold. Bounded well inside the ITC-308's
 * physical range as a guard against a fat-fingered value reaching the hardware
 * (cold-crash to fridge-cold through hot-liquor warm covers every brewing need).
 */
export const setSetpointSchema = z.object({
  value: z.number().finite().min(-10).max(50),
});
export type SetSetpointInput = z.infer<typeof setSetpointSchema>;

/**
 * Allowed range for a device's logging cadence: from 5s (the fastest the agents
 * sample) up to an hour. Shared so the server validation and the dashboard's
 * picker agree on the bounds.
 */
export const REPORTING_INTERVAL_SEC = { min: 5, max: 3600 } as const;

/**
 * Cadences offered in the dashboard's per-device interval picker, in seconds.
 * Starts at 30s: sub-minute logging buries the history table in readings a
 * fridge or fermenter never moves fast enough to justify. The 5s/10s floor stays
 * legal in {@link REPORTING_INTERVAL_SEC} so devices already set that way keep
 * working — the picker just lists their current value alongside these.
 */
export const REPORTING_INTERVAL_OPTIONS = [30, 60, 300, 600] as const;

/** Body for `PATCH /api/devices/:id` — the device's new logging cadence (seconds). */
export const setReportingIntervalSchema = z.object({
  reportingIntervalSec: z
    .number()
    .int()
    .min(REPORTING_INTERVAL_SEC.min)
    .max(REPORTING_INTERVAL_SEC.max),
});
export type SetReportingIntervalInput = z.infer<typeof setReportingIntervalSchema>;

/**
 * Body for `POST /api/commands/ack` — the ids of the commands a device has
 * applied and wants cleared from its pending queue.
 */
export const ackCommandsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
});
export type AckCommandsInput = z.infer<typeof ackCommandsSchema>;

/**
 * Bounds for how long (seconds) the hub may hold a `GET /api/commands` request
 * open when the device has nothing queued. The cap stays under the 60s idle
 * timeout common to proxies and keep-alive handling, so a parked poll is never
 * killed mid-flight by something in between.
 */
export const COMMAND_POLL_WAIT_SEC = { min: 0, max: 50 } as const;

/**
 * Query for `GET /api/commands`. `wait` turns the poll into a long-poll: the hub
 * answers the moment a command is queued for this device rather than making the
 * agent wait for its next read cycle (up to a full logging interval — five
 * minutes on the brewery controllers). Omitting it means "answer now", which is
 * both the old behaviour and what an agent that predates this sends.
 */
export const commandPollQuerySchema = z.object({
  wait: z.coerce
    .number()
    .int()
    .min(COMMAND_POLL_WAIT_SEC.min)
    .max(COMMAND_POLL_WAIT_SEC.max)
    .default(0),
});
export type CommandPollQuery = z.infer<typeof commandPollQuerySchema>;

// --- Device data sources (mock vs. real) ------------------------------------

/**
 * Body for `PUT /api/device-sources`. Like the colour palettes, the whole map is
 * sent each save (last-write-wins) with every known sensor key present; the
 * server merges any older/partial stored blob over the defaults on read.
 */
export const deviceDataSourcesSchema = z.object(
  Object.fromEntries(SENSOR_CATALOG.map((s) => [s.key, z.enum(['mock', 'real'])])),
) as unknown as z.ZodType<DeviceDataSources>;
export type DeviceDataSourcesInput = z.infer<typeof deviceDataSourcesSchema>;

// --- Brewer's Friend recipe selection --------------------------------------

/**
 * Body for `PUT /api/recipe` — the recipe the operator picked from their
 * Brewer's Friend account. The client sends the already-fetched recipe so the
 * server needn't re-query Brewer's Friend just to persist the choice.
 */
export const setActiveRecipeSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1, 'Recipe name is required').max(300),
  style: z.string().trim().max(300).default(''),
  abv: z.string().trim().max(20).default(''),
  url: z.string().trim().max(500).default(''),
  // Carried through so the stored selection is a complete Recipe. Optional
  // rather than defaulted: a client that doesn't send them (or a selection
  // saved by an older build) leaves them absent instead of storing ''.
  ibu: z.string().trim().max(20).optional(),
  ebc: z.string().trim().max(20).optional(),
});
export type SetActiveRecipeInput = z.infer<typeof setActiveRecipeSchema>;

// --- Local recipe editing -------------------------------------------------

const shortRecipeText = z.string().trim().max(100);
const ingredientName = z.string().trim().min(1, 'Ingredient name is required').max(300);

/**
 * A number typed without its leading zero, given one back — ".8" becomes "0.8",
 * "-,25" becomes "-0,25". Every figure on a brew sheet is written by hand into a
 * text box, and dropping the zero is how people actually write a fraction; the
 * arithmetic has always read it correctly, but the sheet then *shows* ".8",
 * which reads as a typo rather than as eight tenths.
 *
 * Anchored to the whole value on purpose, so it can be pointed at any field
 * without inspecting what the field is for: only a value that is nothing but a
 * bare decimal is touched, and a note or a name is left exactly as written.
 *
 * The separator that was typed is the one that comes back. This codebase reads
 * "," as a decimal point throughout (see the recipe parsers), and a brewer
 * writing Danish decimals has not made a mistake to be corrected — the missing
 * zero is the only thing being supplied.
 */
export function withLeadingZero(text: string): string {
  return text.replace(/^([+-]?)([.,])(\d+)$/, '$10$2$3');
}

/**
 * A hand-written figure: trimmed first, so " .8" is recognised as the bare
 * decimal it is, then given its leading zero back.
 *
 * Applied on the way in *and* on the way out — {@link recipeEditSchema} is what
 * a stored sheet is read back through — so a recipe written before this rule
 * existed reads correctly everywhere it is shown, with no migration to run.
 *
 * `max` is per field rather than fixed: a strike volume is allowed to be longer
 * than an alpha acid, and tightening one to match the other would make an
 * already-saved recipe fail to load.
 */
const figureText = (max = 30) => z.string().trim().max(max).transform(withLeadingZero);

const amountText = figureText();
const optionalRecipeText = z.string().trim().max(2_000).nullable();

const recipeFermentableEditSchema = z.object({
  name: ingredientName,
  amount: amountText,
  unit: shortRecipeText,
  percent: amountText,
  ebc: z.number().nonnegative().max(2_000).nullable(),
  ppg: z.number().nonnegative().max(100).nullable().default(null),
  fermentable: z.boolean().nullable().default(null),
  lateAddition: z.boolean().default(false),
});

const recipeHopEditSchema = z.object({
  name: ingredientName,
  amount: amountText,
  unit: shortRecipeText,
  use: z.string().trim().max(200),
  stage: z.enum(['Mash', 'First Wort', 'Boil', 'Whirlpool', 'Dry Hop', 'Other']),
  time: amountText,
  timeUnit: z.enum(['min', 'day', '']),
  aa: amountText,
  ibu: amountText,
  form: shortRecipeText.default('Pellet'),
  utilization: amountText.default(''),
  temp: amountText,
});

const recipeYeastEditSchema = z.object({
  name: ingredientName,
  lab: z.string().trim().max(200),
  attenuation: amountText,
  amount: amountText,
  amountUnit: shortRecipeText,
  type: shortRecipeText,
  form: shortRecipeText,
  flocculation: shortRecipeText,
  minTempC: z.number().min(-20).max(100).nullable(),
  maxTempC: z.number().min(-20).max(100).nullable(),
  alcoholTolerance: shortRecipeText,
  starter: z.boolean(),
});

const recipeOtherIngredientEditSchema = z.object({
  name: ingredientName,
  amount: amountText,
  unit: shortRecipeText,
  use: z.string().trim().max(200),
  time: amountText,
  timeUnit: z.enum(['min', 'day', '']).default(''),
  type: shortRecipeText,
});

const recipeMashGuidelinesSchema = z.object({
  steps: z
    .array(
      z.object({
        name: z.string().trim().max(200),
        temp: figureText().nullable(),
        time: amountText,
        amount: figureText(100).optional(),
        amountUnit: shortRecipeText.default(''),
        startTemp: figureText().nullable().default(null),
        type: shortRecipeText.default(''),
        description: z.string().trim().max(500).default(''),
      }),
    )
    .max(100),
  startingThicknessLPerKg: z.number().positive().max(100).nullable().default(null),
  grainTempC: z.number().min(-20).max(100).nullable().default(null),
  autoStrikeVolume: z.boolean().default(false),
  notes: optionalRecipeText,
});

const recipeWaterProfileSchema = z.object({
  sourceName: z.string().trim().max(200).nullable().default(null),
  name: z.string().trim().max(200).nullable(),
  ph: z.string().trim().max(30).nullable(),
  notes: optionalRecipeText,
  calcium: amountText.nullable(),
  magnesium: amountText.nullable(),
  sodium: amountText.nullable(),
  chloride: amountText.nullable(),
  sulfate: amountText.nullable(),
  bicarbonate: amountText.nullable(),
});

const recipeSettingsSchema = z
  .object({
    styleCategory: z.string().trim().max(300).default(''),
    styleSubcategory: z.string().trim().max(300).default(''),
    batchTarget: shortRecipeText.default('Fermenter'),
    boilSizePreL: z.number().positive().max(1_000_000).nullable().default(null),
    boilSizePostL: z.number().positive().max(1_000_000).nullable().default(null),
    autoBoilSizePre: z.boolean().default(true),
    autoBoilSizePost: z.boolean().default(true),
    boilTimeMinutes: z.number().positive().max(10_000).nullable().default(60),
    boilOffLPerHour: z.number().min(0).max(1_000_000).nullable().default(7),
    trubChillerLossL: z.number().min(0).max(1_000_000).nullable().default(2),
    efficiencyPercent: z.number().min(0).max(100).nullable().default(80),
    pitchRate: z.string().trim().max(200).default('Manufacturer recommended'),
  })
  .default({});

/**
 * The fields a recipe form sends. Kept as a plain shape so the draft-pricing
 * body below can be built from the same fields with one of them relaxed.
 */
const recipeEditFields = {
  name: z.string().trim().min(1, 'Recipe name is required').max(300),
  style: z.string().trim().max(300),
  settings: recipeSettingsSchema,
  og: amountText,
  preBoilGravity: amountText.nullable(),
  postBoilGravity: amountText.nullable(),
  fg: amountText,
  abv: amountText,
  ibu: amountText,
  ebc: amountText,
  ebcEstimated: z.boolean(),
  batchSizeL: z.number().positive().max(1_000_000).nullable(),
  mashTemp: figureText().nullable(),
  fermentationTemp: figureText().nullable(),
  fermentables: z.array(recipeFermentableEditSchema).max(500),
  hops: z.array(recipeHopEditSchema).max(500),
  yeast: z.array(recipeYeastEditSchema).max(100),
  otherIngredients: z.array(recipeOtherIngredientEditSchema).max(500),
  mashGuidelines: recipeMashGuidelinesSchema.nullable(),
  waterProfile: recipeWaterProfileSchema.nullable(),
};

/** Full recipe form body. Arrays replace their corresponding ingredient lists. */
export const recipeEditSchema = z.object(recipeEditFields).transform((value): RecipeEditInput => ({
  ...value,
  settings: { ...DEFAULT_RECIPE_SETTINGS, ...value.settings },
}));

/**
 * Body for `POST /api/recipes/price` — a recipe as it currently stands in the
 * editor, costed without being saved. The same sheet an edit sends, except it
 * needn't be named yet: a brew sheet is priced while it is being filled in, and
 * the name is often the last thing typed.
 */
export const recipeDraftSchema = z
  .object({ ...recipeEditFields, name: z.string().trim().max(300) })
  .transform((value): RecipeEditInput => ({
    ...value,
    settings: { ...DEFAULT_RECIPE_SETTINGS, ...value.settings },
  }));

/**
 * Body for `PUT /api/recipe-defaults` — the figures a blank brew sheet opens on.
 * Bounds are deliberately generous: a 1 L test batch and a 1,000 L commercial
 * one are both somebody's brewhouse. They exist to keep a typo from writing a
 * recipe nobody can brew, not to have an opinion about the kettle.
 */
export const recipeDefaultsSchema = z.object({
  batchSizeL: z.number().positive().max(100_000),
  batchTarget: z.string().trim().min(1).max(100),
  boilTimeMinutes: z.number().min(0).max(1_000),
  efficiencyPercent: z.number().min(1).max(100),
  boilOffLPerHour: z.number().min(0).max(1_000),
  trubChillerLossL: z.number().min(0).max(10_000),
  pitchRate: z.string().trim().min(1).max(200),
  mashThicknessLPerKg: z.number().positive().max(100),
  mashStrikeTempC: z.number().min(0).max(120),
  mashTargetTempC: z.number().min(0).max(120),
  mashStepMinutes: z.number().min(0).max(1_000),
}) satisfies z.ZodType<RecipeDefaults>;

/**
 * Body for `PUT /api/fermenter` — whether the empty fermenter has been washed.
 * There's no "unknown" to send: that's only the state of never having been told.
 */
export const fermenterStateSchema = z.object({
  state: z.enum(['clean', 'dirty']),
});
export type FermenterStateInput = z.infer<typeof fermenterStateSchema>;

// --- Ingredient price overrides --------------------------------------------

const ingredientKindSchema = z.enum(['fermentable', 'hop', 'yeast', 'other']);

/**
 * Search both the local shop catalogue and ingredients used in saved recipes.
 *
 * `catalogueOnly` drops the second half: a recipe being written from scratch
 * should offer what the shop actually sells, not whatever a past recipe
 * happened to name — an old sheet's freehand "Citra (leftovers)" is a spelling,
 * not a product, and it can't be priced or reordered.
 */
export const recipeIngredientCatalogQuerySchema = z.object({
  kind: ingredientKindSchema,
  q: z.string().trim().max(200).optional(),
  catalogueOnly: z.enum(['true', 'false']).optional(),
});

/**
 * Query for `GET /api/prices/options` — which ingredient the picker is open on.
 * The amount travels with it because "cheapest" is a per-line judgement: a 25 g
 * pitch is cheaper as one 25 g sachet than as three 11.5 g ones, so the default
 * can't be worked out from the listings alone.
 */
export const priceOptionsQuerySchema = z.object({
  kind: ingredientKindSchema,
  name: z.string().trim().min(1).max(300),
  grams: z.coerce.number().positive().max(1_000_000).optional(),
  units: z.coerce.number().positive().max(1000).optional(),
  /**
   * The line's own colour (malt only). Sent so the picker's "cheapest" marker
   * agrees with what the recipe is actually costed at — colour is part of the
   * automatic match, and without it a pale malt's default would look wrong.
   */
  ebc: z.coerce.number().positive().max(2000).optional(),
});

/** Query for `GET /api/prices/search` — free-text lookup across one catalogue. */
export const priceSearchQuerySchema = z.object({
  kind: ingredientKindSchema,
  /** Absent or blank lists the catalogue from the top rather than matching nothing. */
  q: z.string().trim().max(200).optional(),
  grams: z.coerce.number().positive().max(1_000_000).optional(),
  units: z.coerce.number().positive().max(1000).optional(),
});

/**
 * Body for `PUT /api/prices/override`. Both halves are optional on their own but
 * one must be present — a row that neither pins a product nor sets a price is
 * just the automatic behaviour, which is what DELETE is for.
 *
 * A price is refused without a unit: 26 kr means nothing until it says whether
 * that's per kilo or per pack, and guessing would silently misprice a batch.
 *
 * Every field is sent explicitly — nulls included, rather than omitted — because
 * a save replaces the whole decision: leaving `unitPriceDkk` out would otherwise
 * be indistinguishable from "clear the manual price and use the listing's own".
 */
export const priceOverrideSchema = z
  .object({
    kind: ingredientKindSchema,
    name: z.string().trim().min(1).max(300),
    catalogueId: z.string().trim().max(300).nullable(),
    unitPriceDkk: z.number().nonnegative().max(1_000_000).nullable(),
    priceUnit: z.enum(['kg', 'pack']).nullable(),
    packageSizeG: z.number().positive().max(1_000_000).nullable(),
  })
  .refine((v) => v.catalogueId != null || v.unitPriceDkk != null, {
    message: 'Pin a product, set a price, or both',
  })
  .refine((v) => v.unitPriceDkk == null || v.priceUnit != null, {
    message: 'A manual price needs a unit (per kg or per pack)',
  });
export type PriceOverrideInput = z.infer<typeof priceOverrideSchema>;

/** Query for `DELETE /api/prices/override` — the ingredient to return to automatic. */
export const priceOverrideQuerySchema = z.object({
  kind: ingredientKindSchema,
  name: z.string().trim().min(1).max(300),
});

// --- Notification settings -------------------------------------------------

/**
 * Body for `PUT /api/notifications/settings`. The Settings page sends the whole
 * object each save (last-write-wins). `kegAlertDays` is bounded to a sane range
 * so a fat-fingered value can't disable the alert (0) or push it years out.
 */
/**
 * Body for `PUT /api/notifications/settings`. The critical-alert fields are
 * optional and the server merges what it is given over what is stored, so a
 * phone running an older build of the app — which fetches the settings, edits
 * one, and puts the whole object back — keeps working instead of being rejected
 * for omitting fields it has never heard of. It simply leaves them alone.
 */
export const notificationSettingsSchema = z.object({
  kegAlertEnabled: z.boolean(),
  kegAlertDays: z.number().int().min(1).max(365),
  fermentDoneEnabled: z.boolean(),
  pressureLostEnabled: z.boolean().optional(),
  pressureLostBar: z.number().min(0).max(1).optional(),
  pressureHighEnabled: z.boolean().optional(),
  pressureHighBar: z.number().min(0.1).max(10).optional(),
  fermenterHotEnabled: z.boolean().optional(),
  fermenterHotC: z.number().min(20).max(80).optional(),
  fermenterStalledEnabled: z.boolean().optional(),
  kegsWarmEnabled: z.boolean().optional(),
  kegsWarmC: z.number().min(0).max(40).optional(),
  breweryColdEnabled: z.boolean().optional(),
  breweryColdC: z.number().min(-20).max(15).optional(),
  sensorOfflineEnabled: z.boolean().optional(),
});
export type NotificationSettingsInput = z.infer<typeof notificationSettingsSchema>;

/**
 * Body for `POST /api/push/register` and `/api/push/unregister` — the Android
 * app handing over (or giving back) its FCM registration token. The token is an
 * opaque string from Firebase; it is only ever length-checked, since its format
 * is Google's to change.
 */
export const pushTokenSchema = z.object({
  token: z.string().trim().min(20).max(4096),
});
export type PushTokenInput = z.infer<typeof pushTokenSchema>;

// --- Graph colours ----------------------------------------------------------

/** A `#rrggbb` hex colour (the format `<input type="color">` produces). */
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a #rrggbb hex colour');

// --- Keg content colours ----------------------------------------------------

const kegContentColorShape = Object.fromEntries(
  (Object.keys(DEFAULT_KEG_CONTENT_COLORS) as KegContent[]).map((key) => [key, hexColor]),
) as Record<KegContent, typeof hexColor>;

/** Body for `PUT /api/keg-content-colors`. The whole palette is sent each save. */
export const kegContentColorsSchema = z.object(kegContentColorShape);
export type KegContentColorsInput = z.infer<typeof kegContentColorsSchema>;

// --- Keg inventory edits (write-back to the shared sheet) -------------------

/** Path param for `PUT /api/kegs/:number` — the keg number whose row to update. */
export const kegNumberParamSchema = z.object({
  number: z.string().trim().min(1).max(20),
});

/**
 * Body for `PUT /api/kegs/:number` — the editable keg fields written back to the
 * shared sheet. Volume is intentionally omitted: it's a fixed physical property
 * of the keg, so the writer leaves that cell untouched. A blank date/note/abv
 * clears that cell; the desktop editor pre-fills existing values so a bulk
 * "assign content" can keep them. Contents is the one always-required field.
 * `recipeId` is the linked Brewer's Friend recipe (sheet column H); blank
 * unlinks. It's optional in the body so older clients that omit it leave the
 * cell untouched.
 */
export const updateKegSchema = z.object({
  contents: z.string().trim().min(1, 'Contents is required').max(100),
  date: z.string().trim().max(40),
  note: z.string().trim().max(200),
  abv: z.string().trim().max(20),
  recipeId: z.string().trim().max(200).optional(),
});
export type UpdateKegInput = z.infer<typeof updateKegSchema>;

/**
 * Apply the board's content rules to an edit before it's written: marking a keg
 * dirty clears the beer's details ({@link EMPTIED_KEG_FIELDS}). Enforced on the
 * way into the sheet rather than in each editor, so the rule holds whichever
 * client made the change — the desktop keg editor, Bruce, or a bare API call.
 *
 * The note passes through untouched: a dirty keg may carry a note about itself,
 * so what the caller sent is what it gets. Dropping the *previous* beer's note
 * is the editor's job, at the moment the keg turns dirty.
 */
export function normalizeKegUpdate(fields: UpdateKegInput): UpdateKegInput {
  return isDirtyContents(fields.contents) ? { ...fields, ...EMPTIED_KEG_FIELDS } : fields;
}

/** Body for `PUT /api/graph-colors`. The whole palette is sent each save. */
export const graphColorsSchema = z.object({
  pressure: hexColor,
  gravity: hexColor,
  power: hexColor,
  water: hexColor,
  beerTemp: hexColor,
  fridgeTemp: hexColor,
  setpoint: hexColor,
});
export type GraphColorsInput = z.infer<typeof graphColorsSchema>;

// --- Account (username / password changes) ---------------------------------

/**
 * Body for `POST /api/auth/change-password`. The current password is required so
 * a hijacked session can't silently lock the owner out. The 8-char floor is a
 * gentle minimum, not a policy — this is a single-brewery appliance.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(500),
  newPassword: z.string().min(8, 'New password must be at least 8 characters').max(500),
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/** Body for `POST /api/auth/change-username` — current password re-confirms identity. */
export const changeUsernameSchema = z.object({
  username: z.string().trim().min(1, 'Username is required').max(200),
  currentPassword: z.string().min(1, 'Current password is required').max(500),
});
export type ChangeUsernameInput = z.infer<typeof changeUsernameSchema>;

// --- Account administration (admin-only: manage other accounts) -------------

export const userRoleSchema = z.enum(['admin', 'guest']);

/**
 * Body for `POST /api/accounts` — an admin creates a new login account. The
 * password floor mirrors the self-service change-password rule (8 chars); this
 * is a single-brewery appliance, not a policy engine.
 */
export const createUserSchema = z.object({
  username: z.string().trim().min(1, 'Username is required').max(200),
  password: z.string().min(8, 'Password must be at least 8 characters').max(500),
  role: userRoleSchema,
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

/** Body for `PATCH /api/accounts/:id/role` — change an account's privilege. */
export const setUserRoleSchema = z.object({
  role: userRoleSchema,
});
export type SetUserRoleInput = z.infer<typeof setUserRoleSchema>;

/** Body for `POST /api/accounts/:id/password` — an admin resets an account's password. */
export const adminSetPasswordSchema = z.object({
  newPassword: z.string().min(8, 'New password must be at least 8 characters').max(500),
});
export type AdminSetPasswordInput = z.infer<typeof adminSetPasswordSchema>;

// ---------------------------------------------------------------------------
// Path param helpers
// ---------------------------------------------------------------------------

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const stepIdParamSchema = z.object({
  stepId: z.coerce.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Music: Sonos / IKEA SYMFONISK now-playing + transport control
// ---------------------------------------------------------------------------

/**
 * Snapshot of what the brewery speaker is doing (GET /api/music/now-playing).
 * The IKEA SYMFONISK runs Sonos firmware, so the server controls it over the
 * LAN (no Spotify account/OAuth) via the `sonos` library. `state` is `no_media`
 * when nothing is queued; durations/positions are seconds and may be null for a
 * live stream that doesn't report them. `albumArtUrl` points straight at the
 * speaker (an `http://<sonos-ip>:1400/...` URL the kiosk loads on the LAN).
 */
export interface NowPlaying {
  state: 'playing' | 'paused' | 'stopped' | 'transitioning' | 'no_media';
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtUrl: string | null;
  durationSec: number | null;
  positionSec: number | null;
  /** Speaker volume, 0–100. */
  volume: number;
  /** The zone/room name of the controlled speaker, when known. */
  room: string | null;
  /** 1-based slot of this track in the Sonos queue; null when not playing the queue. */
  queuePosition: number | null;
  /** Play mode, split out of the speaker's single PlayMode string. */
  shuffle: boolean;
  repeat: MusicRepeat;
}

/** How the speaker repeats: nothing, the whole queue, or the current track. */
export type MusicRepeat = 'off' | 'all' | 'one';

/**
 * One entry in the speaker's queue (GET /api/music/queue). `position` is the
 * 1-based slot Sonos itself uses, and is what the reorder/play/remove endpoints
 * take. Queue entries carry no duration — Sonos only reports that for the track
 * that's actually loaded.
 */
export interface QueueTrack {
  position: number;
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtUrl: string | null;
  /** The track's Sonos URI — stable across a reorder, so it makes a good key. */
  uri: string | null;
}

/**
 * The speaker's queue. Empty when the speaker is playing a line-in, a radio
 * stream, or a Spotify Connect session (those bypass the Sonos queue entirely).
 */
export interface MusicQueue {
  tracks: QueueTrack[];
  /** 1-based position of the track currently playing, when it comes from the queue. */
  currentPosition: number | null;
}

/** Body for POST /api/music/volume — an absolute level, 0–100. */
export const setVolumeSchema = z.object({
  volume: z.coerce.number().int().min(0).max(100),
});

/** Body for POST /api/music/seek — an absolute position within the track, in seconds. */
export const seekSchema = z.object({
  positionSec: z.coerce.number().int().min(0),
});

/** Body for POST /api/music/play-mode — shuffle and repeat are set together. */
export const setPlayModeSchema = z.object({
  shuffle: z.boolean(),
  repeat: z.enum(['off', 'all', 'one']),
});

/**
 * Body for POST /api/music/queue/reorder — move the track at `from` so it ends
 * up at `to`. Both are 1-based queue positions, as shown in the UI.
 */
export const reorderQueueSchema = z.object({
  from: z.coerce.number().int().min(1),
  to: z.coerce.number().int().min(1),
});

/** Body for POST /api/music/queue/play and /api/music/queue/remove. */
export const queuePositionSchema = z.object({
  position: z.coerce.number().int().min(1),
});

// ---------------------------------------------------------------------------
// Brew system (the brewing rig — a separate Raspberry Pi running brew-system-v3)
// ---------------------------------------------------------------------------
// The BrewPlanner server proxies /api/brew-system/* to the rig's unauthenticated
// FastAPI over the LAN (BREW_SYSTEM_URL), so BrewPlanner's session auth is the
// only way to reach it remotely. These shapes mirror the rig's API responses.

/** BK and HLT have heaters; MLT is a read-only temperature (no control state). */
export type BrewPot = 'BK' | 'HLT';
export type BrewPump = 'P1' | 'P2';

export interface BrewPotControl {
  heaterOn: boolean;
  /** Target temperature (set value), °C. */
  sv: number;
  /** Heating element duty cycle, 0–100 %. */
  efficiency: number;
  regulationEnabled: boolean;
}

export interface BrewPumpControl {
  on: boolean;
  /** Pump PWM duty cycle, 0–100 %. */
  speed: number;
}

export interface BrewTimerState {
  running: boolean;
  /** Counts up as a stopwatch when target is 0, down toward 0 otherwise. */
  seconds: number;
  /** Countdown target in seconds; 0 = stopwatch mode. */
  target: number;
}

/** The rig's GET /api/hardware/state response. Temperatures are null when a sensor fails. */
export interface BrewSystemState {
  temperatures: { bk: number | null; mlt: number | null; hlt: number | null };
  controlState: {
    pots: Record<BrewPot, BrewPotControl>;
    pumps: Record<BrewPump, BrewPumpControl>;
  };
  timer: BrewTimerState;
}

export interface BrewAutoEfficiencyStep {
  /** Degrees below setpoint at which this power step kicks in. */
  threshold: number;
  /** Duty cycle applied for this step, 0–100 %. */
  power: number;
}

export interface BrewPotAutoEfficiency {
  enabled: boolean;
  steps: BrewAutoEfficiencyStep[];
}

/** The `app` block of the rig's /api/settings — only what the dashboard needs. */
export interface BrewSystemAppSettings {
  max_watts?: number;
  bk_element_watts?: number;
  hlt_element_watts?: number;
  auto_efficiency?: { bk?: BrewPotAutoEfficiency; hlt?: BrewPotAutoEfficiency };
}

/**
 * Envelope for GET /api/brew-system/state. `configured` is false when the
 * server has no BREW_SYSTEM_URL; `online` is false when the rig didn't answer
 * (it's normally powered off between brew sessions). `state` only when online.
 */
export interface BrewSystemStatus {
  configured: boolean;
  online: boolean;
  state?: BrewSystemState;
}

/**
 * One row of the rig's session temperature log. `ts` is epoch ms and is the
 * rig's own clock, so rows stay ordered even if this server's clock differs.
 * A vessel reads null when its DS18B20 didn't answer for that sample.
 */
export interface BrewTemperatureRow {
  ts: number;
  bk: number | null;
  mlt: number | null;
  hlt: number | null;
}

/**
 * Envelope for GET /api/brew-system/temperature/history. `rows` covers the rig's
 * *current session* — it starts empty and is wiped when a new brew starts, so an
 * online rig with no rows means "logging hasn't begun", not an error.
 */
export interface BrewTemperatureHistory {
  configured: boolean;
  online: boolean;
  rows?: BrewTemperatureRow[];
}

/** Envelope for GET /api/brew-system/config — the rig's app settings + theme colours. */
export interface BrewSystemConfig {
  configured: boolean;
  online: boolean;
  app?: BrewSystemAppSettings;
  /** The rig's custom theme colours (keys like `accentBlue`), if the user changed any. */
  theme?: Record<string, string>;
}

/** Body for POST /api/brew-system/pot/:pot/power and /pump/:pump/power. */
export const brewOnSchema = z.object({ on: z.boolean() });
/** Body for efficiency / speed / sv — the rig treats all three as 0–100. */
export const brewValueSchema = z.object({ value: z.coerce.number().min(0).max(100) });
/** Body for POST /api/brew-system/pot/:pot/regulation. */
export const brewEnabledSchema = z.object({ enabled: z.boolean() });
/** Body for POST /api/brew-system/timer — mirrors the rig's timer actions. */
export const brewTimerActionSchema = z.object({
  action: z.enum(['start', 'stop', 'reset', 'set']),
  seconds: z.coerce.number().int().min(0).optional(),
});
export type BrewTimerActionInput = z.infer<typeof brewTimerActionSchema>;

// ---------------------------------------------------------------------------
// Hosts (the two Raspberry Pis the brewery runs on)
// ---------------------------------------------------------------------------
// Every sensor on the Devices page reports in by itself; the Pis underneath them
// report nothing, so the server reads their vitals on their behalf — from the
// kernel for the machine it runs on, over SSH for the rig — and serves both from
// GET /api/system/hosts. Every field past `online` is null when it couldn't be
// read, since a host that's powered off still gets a card.

export type HostId = 'brewplanner' | 'brewsystem';

/** One machine's vitals. Sizes are bytes, temperatures °C, durations seconds. */
export interface HostStatus {
  id: HostId;
  /** What this box is called here, e.g. "BrewPlanner Pi". */
  name: string;
  /** One line on what it does, for the card subtitle. */
  role: string;
  /** The host answered at all — pingable/SSH-able, not necessarily healthy. */
  online: boolean;
  /** Its own hostname, which needn't match {@link name} (the rig calls itself `raspberrypi`). */
  hostname: string | null;
  /** Board model from the device tree, e.g. "Raspberry Pi 4 Model B Rev 1.5". */
  model: string | null;
  /** Distro PRETTY_NAME, e.g. "Debian GNU/Linux 13 (trixie)". */
  os: string | null;
  kernel: string | null;
  /** LAN address the brewery reaches it on. */
  ip: string | null;
  uptimeSec: number | null;
  /** SoC temperature — the number that says whether a Pi is about to throttle. */
  cpuTempC: number | null;
  /** 1-minute load average, to be read against {@link cpuCount}. */
  loadAvg1: number | null;
  cpuCount: number | null;
  memTotalBytes: number | null;
  /** Total minus *available* (not free) — page cache isn't pressure. */
  memUsedBytes: number | null;
  /** Root filesystem, which on both Pis is the whole SD card. */
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
  /** The systemd unit its app runs under, e.g. `checklist-server.service`. */
  serviceName: string | null;
  /** Whether that unit is currently active; null when we couldn't ask. */
  serviceActive: boolean | null;
  /** Short hash of the app checkout running there. */
  commit: string | null;
  commitSubject: string | null;
  /** Why the vitals are missing, when they are — shown on the card. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Bruce, the voice assistant (apps/bruce). Bruce exposes a loopback status API
// on his Pi; the server proxies it as /api/bruce/* behind session auth, and
// the dashboard's Bruce page renders these shapes.

export type BruceState = 'idle' | 'listening' | 'thinking' | 'speaking';

/** One line of Bruce's rolling conversation transcript. */
export interface BruceTranscriptEntry {
  /** `system` = injected events (dashboard speak requests, reminders). */
  type: 'user' | 'assistant' | 'function_call' | 'system';
  content: string;
  /** Epoch milliseconds. */
  timestamp: number;
}

/** Bruce's live status (GET /status on his loopback API). */
export interface BruceStatus {
  state: BruceState;
  /** True while the OpenAI session is open (it idles out between conversations — that's normal, not an error). */
  connected: boolean;
  /** Realtime model in use, e.g. `gpt-realtime-mini`. */
  model: string;
  /** Speech volume, 0–200 (100 = native). */
  volumePercent: number;
  /**
   * What the wake phrase triggers. Optional because a Bruce service older than
   * the setting simply omits it — treat a missing value as `speak`.
   */
  wakeAck?: BruceWakeAck;
  /**
   * How the mic amplification used for wake-phrase scoring is chosen: a fixed
   * multiplier, or `auto` for the gain control. Same caveat as `wakeAck`: an
   * older Bruce service omits it.
   */
  wakeWordGain?: BruceWakeWordGain;
  /**
   * The amplification actually in force — under `auto`, where the control has
   * settled for the room right now. Omitted by an older Bruce service.
   */
  wakeWordGainApplied?: number;
  /** ISO timestamp of when the Bruce service started. */
  startedAt: string;
  transcript: BruceTranscriptEntry[];
}

/** Envelope for GET /api/bruce/status — `online: false` when the Bruce service is down/unreachable. */
export type BruceServiceStatus = { online: false } | ({ online: true } & BruceStatus);

/** Body for POST /api/bruce/speak. */
export const bruceSpeakSchema = z.object({ message: z.string().trim().min(1).max(500) });
export type BruceSpeakInput = z.infer<typeof bruceSpeakSchema>;

/** Body for POST /api/bruce/volume — 0–200 %, 100 = native. */
export const bruceVolumeSchema = z.object({ percent: z.coerce.number().min(0).max(200) });
export type BruceVolumeInput = z.infer<typeof bruceVolumeSchema>;

/**
 * What Bruce does the moment the wake phrase fires, before he starts listening:
 * `speak` says "Yes?", `plop` is the short beep, `none` is silence.
 */
export const BRUCE_WAKE_ACK_MODES = ['speak', 'plop', 'none'] as const;
export type BruceWakeAck = (typeof BRUCE_WAKE_ACK_MODES)[number];

/** Body for POST /api/bruce/wake-ack. */
export const bruceWakeAckSchema = z.object({ mode: z.enum(BRUCE_WAKE_ACK_MODES) });
export type BruceWakeAckInput = z.infer<typeof bruceWakeAckSchema>;

/**
 * How much the microphone is amplified before the wake phrase is scored —
 * the "sensitivity" control. 1 is the raw mic; above that the same words carry
 * further, below it Bruce needs them louder. Bounded here so the settings UI
 * and the API agree on the range.
 */
export const BRUCE_WAKE_WORD_GAIN = { min: 0.5, max: 16, step: 0.5 } as const;

/**
 * The sensitivity setting itself: `auto` hands the gain to Bruce's gain
 * control, which tracks the room and is the setting that works at both one
 * metre and five. A number pins it, which is really only useful for
 * reproducing a measurement — no single number is right at both distances.
 */
export type BruceWakeWordGain = number | 'auto';

/** Body for POST /api/bruce/wake-word-gain. */
export const bruceWakeWordGainSchema = z.object({
  // `auto` first: z.coerce.number() would turn the string into NaN and fail
  // the bounds, but only after having eaten the literal branch's turn.
  gain: z.union([
    z.literal('auto'),
    z.coerce.number().min(BRUCE_WAKE_WORD_GAIN.min).max(BRUCE_WAKE_WORD_GAIN.max),
  ]),
});
export type BruceWakeWordGainInput = z.infer<typeof bruceWakeWordGainSchema>;

/**
 * One bucket of Bruce's microphone trace — `bucketMs` of audio, on the PCM16
 * scale (0–32768).
 */
export interface BruceMicSample {
  /** RMS level of the raw microphone over the bucket. */
  rms: number;
  /** Loudest single sample in it — 32767 means the capture gain is clipping. */
  peak: number;
  /**
   * Highest wake-word score in the bucket, or null when there is none to show:
   * the detector only runs while Bruce is idle, so a conversation leaves a gap.
   */
  score: number | null;
}

/**
 * A few seconds of what Bruce's microphone is hearing (GET /levels on his
 * loopback API), for the mic meter on the Bruce page. Levels are the raw mic;
 * `filteredRms` and `noiseFloor` are what the wake detector sees after its
 * high-pass filter.
 */
export interface BruceMicLevels {
  /** Epoch milliseconds the newest bucket ends at. */
  now: number;
  bucketMs: number;
  windowMs: number;
  /** Oldest → newest; shorter than `windowMs / bucketMs` just after a restart. */
  samples: BruceMicSample[];
  /** Latest high-passed frame RMS from the wake detector, null before its first frame. */
  filteredRms: number | null;
  /** The room level the gain control tracks — the phrase has to beat this. */
  noiseFloor: number | null;
  /** Amplification the detector is applying right now. */
  gain: number | null;
  /** How that gain is chosen. */
  gainMode: BruceWakeWordGain | null;
  /** Score that counts as a detection, so the meter can draw the line. */
  threshold: number | null;
}

/** Envelope for GET /api/bruce/levels — mirrors the status route's. */
export type BruceMicLevelsResponse = { online: false } | ({ online: true } & BruceMicLevels);

// ---------------------------------------------------------------------------
// Bruce chat (text). Unlike the voice assistant above, this runs *in the
// server* — it needs no microphone, so it works whether or not bruce.service
// is up. Answers are grounded in the brewing books under knowledge/ (see
// apps/server/src/knowledge): the question is embedded, the closest passages
// are retrieved, and the model answers from them and cites where it read it.

/**
 * Where one piece of an answer came from — rendered as a citation chip.
 *
 * Two kinds, told apart by `url`: a passage retrieved from a book on the shelf
 * (title + section + page, no url), or a web page Bruce searched up when web
 * search is on (title + url, no page).
 */
export interface BruceChatSource {
  /** Document title, e.g. "Water: A Comprehensive Guide for Brewers". */
  title: string;
  /** Heading trail inside the document, e.g. "4. Residual Alkalinity › Water Alkalinity". */
  section?: string;
  /** Page or page range in the source book, e.g. "142" or "142–143". */
  page?: string;
  /** Set only on a web result: the page Bruce read. Its presence marks it as one. */
  url?: string;
  /**
   * Book passages only: whether the answer actually cited this one.
   *
   * Every passage retrieved for a question is attached to the answer, because
   * that is what Bruce was handed to read. But retrieval always returns its
   * best few matches, so a question the library doesn't cover still comes back
   * with passages — and an answer written entirely from the web would list six
   * book citations underneath it, which is a claim about where the answer came
   * from that simply isn't true.
   *
   * So the answer's own inline citations decide this (see markCited in the
   * server's bruce/chat.ts), and the page shows the uncited ones as what they
   * are: passages read, not sources used.
   *
   * Absent on turns stored before this existed, and on web results — treat a
   * missing value as cited, which is how those older answers already read.
   */
  cited?: boolean;
}

/** One stored turn of the text conversation. */
/**
 * One tool Bruce reached for while answering, kept beside the answer it fed.
 *
 * Recorded rather than merely reported, because "he looked at the fermenter
 * before saying that" is part of the answer's provenance in the same way a book
 * citation is — and the transient progress line that used to say so vanished
 * the moment the answer arrived, taking with it the only evidence of *which*
 * of the brewery's numbers he actually read.
 */
export interface BruceToolCall {
  /** The function the model called, e.g. `get_kegs`. */
  name: string;
  /** Which progress line it belongs to, for the icon and colour. */
  phase?: BrucePhaseName;
  /** The qualifier that phase carried, e.g. "keg board". */
  detail?: string;
  /** What the model asked for, as it sent it. */
  args?: Record<string, unknown>;
  /**
   * What the tool answered, truncated to {@link MAX_TOOL_RESULT_CHARS}.
   *
   * Truncated on purpose: a keg board or a device table runs to kilobytes, and
   * the answer above it is the point — this is here so a one-line confirmation
   * ("Added 'order more CO2'") can be checked at a glance, not to keep a second
   * copy of the data in the thread.
   */
  result?: string;
}

/** How much of a tool's answer is kept beside it. See {@link BruceToolCall}. */
export const MAX_TOOL_RESULT_CHARS = 400;

export interface BruceChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  /** Passages the answer was grounded in. Assistant turns only, may be empty. */
  sources?: BruceChatSource[];
  /** Tools called while writing it, in the order they ran. Assistant turns only. */
  toolCalls?: BruceToolCall[];
  /** ISO timestamp. */
  createdAt: string;
}

/** State of the knowledge index the chat answers from. */
export interface BruceKnowledgeStatus {
  /** True when an index exists and matches the files currently in knowledge/. */
  ready: boolean;
  /** Why it isn't ready (missing, stale, unreadable) — shown as-is in the UI. */
  problem?: string;
  /** One entry per indexed document, in title order. `file` is its name in knowledge/. */
  documents: { file: string; title: string; passages: number }[];
  /** Total indexed passages. */
  passages: number;
  /** ISO timestamp of the last index build. */
  builtAt?: string;
}

/** One chat thread. Threads are shared across accounts, not per-user. */
export interface BruceConversation {
  id: number;
  /** Seeded from the opening question; renameable. */
  title: string;
  /** How many turns it holds, for the thread list. */
  messages: number;
  createdAt: string;
  /** Last activity — the thread list is ordered by this. */
  updatedAt: string;
  /**
   * Roughly what this thread has cost in US dollars: the sum of the priced
   * answers in it, from the token counts OpenAI reported. An estimate, not the
   * invoice — see the server's bruce/cost.ts. Absent when nothing in the
   * thread could be priced (older turns, or an unknown model), so the UI can
   * say nothing rather than claim it was free.
   */
  costUsd?: number;
}

/** A model the picker offers, with plain-language guidance on when to use it. */
export interface BruceChatModel {
  /** OpenAI model id, e.g. `gpt-5-mini`. */
  id: string;
  /** Short role, e.g. "Fastest" or "Most capable". */
  label: string;
  /** One or two sentences on what it is better and worse at. */
  blurb: string;
}

/** GET /api/bruce/chat — one thread plus everything the page needs to explain itself. */
export interface BruceChatState {
  /** The thread being shown. */
  conversation: BruceConversation;
  /** Every thread, most recently used first, for the switcher. */
  conversations: BruceConversation[];
  /** Messages of `conversation`, oldest first. */
  messages: BruceChatMessage[];
  knowledge: BruceKnowledgeStatus;
  /** False when the server has no OPENAI_API_KEY — the composer is disabled. */
  configured: boolean;
  /** Chat model in use, e.g. `gpt-5-mini`. */
  model: string;
  /**
   * Models offered by the picker: a shortlist chosen for this page, matched
   * against what the API key can actually see. Empty when the lookup failed —
   * the picker then shows only the current model.
   */
  models: BruceChatModel[];
  /**
   * Whether Bruce may search the web when the books don't cover a question.
   * On by default — the books still come first, the model only reaches for the
   * web when they are silent. Toggled on the Bruce page, stored server-side.
   */
  webSearch: boolean;
}

/** POST /api/bruce/chat — answer to one question, plus the turn that asked it. */
export interface BruceChatReply {
  question: BruceChatMessage;
  answer: BruceChatMessage;
  /** The thread it landed in — its title may have just been set from the question. */
  conversation: BruceConversation;
}

/**
 * What Bruce is doing *right now*, streamed to the page while it waits.
 *
 * These are observed, not guessed: `library`, `recipes` and `brewery` are work
 * the server does itself, and `web` arrives because OpenAI told us the model
 * started a search. So "searching the web" on screen means he really is on the
 * web, which is the whole point of naming them separately.
 *
 * `brewery` covers every tool that reads or changes the hub itself — sensors,
 * kegs, the to-do list, settings — and says which in its `detail`. One name
 * rather than six because they are the same kind of work from the reader's
 * side: he has stopped reading books and gone to look at the brewery.
 */
export type BrucePhaseName =
  | 'library'
  | 'thinking'
  | 'web'
  | 'recipes'
  | 'brewery'
  | 'music'
  | 'writing';

/** One progress event on the chat stream. */
export interface BrucePhase {
  phase: BrucePhaseName;
  /** What it is working on — a search query, a recipe name, a passage count. */
  detail?: string;
}

/**
 * An event on the `POST /api/bruce/chat` stream (server-sent events).
 *
 * The answer is not streamed token by token: only progress is, followed by the
 * finished reply in one `done` event. The page shows what he is doing while he
 * does it, then swaps in the complete answer.
 */
export type BruceChatEvent =
  | ({ type: 'phase' } & BrucePhase)
  // Sent as each tool finishes, so the calls appear in the conversation as they
  // happen rather than all at once with the answer. The same records come back
  // on the stored message, so a reload shows exactly what the live view did.
  | ({ type: 'tool' } & BruceToolCall)
  | { type: 'done'; reply: BruceChatReply }
  | { type: 'error'; message: string };

/** Body for POST /api/bruce/chat. Omit `conversationId` to use the newest thread. */
export const bruceChatSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  conversationId: z.coerce.number().int().positive().optional(),
});
export type BruceChatInput = z.infer<typeof bruceChatSchema>;

/** Body for POST/PATCH of a chat thread. */
export const bruceConversationSchema = z.object({
  title: z.string().trim().min(1).max(80),
});
export type BruceConversationInput = z.infer<typeof bruceConversationSchema>;

/**
 * Body for POST /api/bruce/chat/model. Validated by shape, not against the
 * live list: OpenAI ships models faster than the cached list refreshes, and
 * refusing a valid new name would be worse than passing it through and letting
 * the API report an unknown model.
 */
export const bruceChatModelSchema = z.object({
  model: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Not a valid model id'),
});
export type BruceChatModelInput = z.infer<typeof bruceChatModelSchema>;

/** Body for POST /api/bruce/chat/web-search — let Bruce search the web, or not. */
export const bruceWebSearchSchema = z.object({ enabled: z.boolean() });
export type BruceWebSearchInput = z.infer<typeof bruceWebSearchSchema>;

// ---------------------------------------------------------------------------
// Bruce by voice, in a browser. A third front door, after the brewery speaker
// (apps/bruce, wake word, Pi hardware) and the written chat above.
//
// The phone or laptop holds the conversation itself: it opens a WebRTC session
// straight to OpenAI's Realtime API, so the audio never crosses the Pi, which
// has neither the bandwidth nor the CPU to relay it. The server's part is the
// three things a browser must not be trusted with — minting a short-lived
// credential (the real key stays on the Pi), running the tools against the
// hub's database, and writing the finished turns into the chat thread.

/**
 * What a browser needs to open a Realtime session, from POST
 * /api/bruce/voice/session.
 *
 * `clientSecret` is an ephemeral key: it is scoped to one session, expires
 * within a minute or two, and is the only credential that ever reaches the
 * browser. The session's instructions, tools and voice are baked into it
 * server-side, so a tampered client cannot widen what Bruce is allowed to do.
 */
export interface BruceVoiceSession {
  clientSecret: string;
  /** Unix seconds. The secret only has to survive the SDP exchange. */
  expiresAt: number;
  model: string;
  voice: string;
}

/**
 * Body for POST /api/bruce/voice/tool — one function call, relayed from the
 * browser's data channel to the same tools the written chat uses.
 *
 * The arguments are whatever the model produced, so they are passed through as
 * an opaque object and narrowed by the tool itself (see bruce/tools.ts).
 */
export const bruceVoiceToolSchema = z.object({
  name: z.string().trim().min(1).max(64),
  args: z.record(z.unknown()).default({}),
});
export type BruceVoiceToolInput = z.infer<typeof bruceVoiceToolSchema>;

/** What the model reads back from a tool. Failures are text, never an error. */
export interface BruceVoiceToolResult {
  output: string;
  /** What to show on the page while this ran, when the tool has a phase. */
  phase?: BrucePhase;
}

/**
 * Body for POST /api/bruce/voice/turn — one finished spoken exchange, saved
 * into a chat thread.
 *
 * Sent by the browser after each reply rather than at the end of the call: a
 * call that ends by the phone locking or the tab closing would otherwise lose
 * everything that was said.
 */
export const bruceVoiceTurnSchema = z.object({
  conversationId: z.coerce.number().int().positive().optional(),
  question: z.string().trim().min(1).max(4000),
  answer: z.string().trim().min(1).max(8000),
  /**
   * Tools the model called during the exchange, so a spoken turn records them
   * the same way a typed one does. Sent by the browser because that is where
   * the call was made — the server only ran what it was asked to.
   */
  toolCalls: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(64),
        phase: z.string().trim().max(32).optional(),
        detail: z.string().trim().max(200).optional(),
        args: z.record(z.unknown()).optional(),
        result: z.string().max(MAX_TOOL_RESULT_CHARS).optional(),
      }),
    )
    .max(32)
    .optional(),
});
export type BruceVoiceTurnInput = z.infer<typeof bruceVoiceTurnSchema>;

// ---------------------------------------------------------------------------
// Tending the library from the dashboard: adding a book, rebuilding the index,
// and rewriting Bruce's instructions. All of it used to need an SSH session and
// `npm run knowledge` on the Pi.
// ---------------------------------------------------------------------------

/**
 * A rebuild of the knowledge index, as the Bruce page follows it.
 *
 * Embedding a book takes a minute or two, which is far too long to hold a
 * request open, so the server runs it in the background and the page polls
 * this. `embedded`/`total` count passages in *this* run, not the whole shelf —
 * unchanged books keep their vectors and are never re-embedded.
 */
export interface BruceIndexJob {
  state: 'running' | 'ok' | 'failed';
  startedAt: string;
  /** Absent while running. */
  finishedAt?: string;
  embedded: number;
  total: number;
  /** What kicked it off, e.g. `water.md` — shown next to the progress bar. */
  note?: string;
  /** Set when `state` is `failed`; safe to show as-is. */
  error?: string;
}

/** GET /api/bruce/knowledge — what's on the shelf, plus any rebuild in flight. */
export interface BruceKnowledgeState {
  knowledge: BruceKnowledgeStatus;
  /** The most recent rebuild, running or finished; null if none since boot. */
  job: BruceIndexJob | null;
  /** False when the server has no OPENAI_API_KEY — nothing can be embedded. */
  configured: boolean;
}

/**
 * Upload cap for one book. The two books this was built against are ~600 KB of
 * markdown each; 8 MB is roughly a shelf of them and still small enough that
 * holding one in memory on a Pi is nothing to worry about.
 */
export const MAX_KNOWLEDGE_FILE_CHARS = 8_000_000;

/**
 * Body for POST /api/bruce/knowledge/files — a markdown book, uploaded whole.
 *
 * The name is checked hard: it lands on disk in knowledge/, so anything with a
 * folder in it, or not ending in `.md`, is refused here rather than sanitised
 * into something the uploader didn't ask for.
 */
export const bruceKnowledgeFileSchema = z.object({
  file: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*\.md$/i, 'Needs to be a .md file name, with no folders'),
  content: z.string().min(1).max(MAX_KNOWLEDGE_FILE_CHARS),
});
export type BruceKnowledgeFileInput = z.infer<typeof bruceKnowledgeFileSchema>;

/** Body for POST /api/bruce/knowledge/reindex — `force` re-embeds everything. */
export const bruceReindexSchema = z.object({ force: z.boolean().optional() });
export type BruceReindexInput = z.infer<typeof bruceReindexSchema>;

/**
 * One chapter of a book, as the reader lists it.
 *
 * `id` is the chapter's position in the file, not a slug: two chapters in a
 * transcribed book can genuinely carry the same heading, and an index can't
 * collide with itself.
 */
export interface BruceBookChapter {
  id: number;
  title: string;
  /** Characters of markdown in it, so the reader can say how long it is. */
  chars: number;
  /** The headings inside it, in order — the reader's second level of contents. */
  sections: BruceBookSection[];
}

/** One heading below chapter level, and where to jump to it. */
export interface BruceBookSection {
  title: string;
  /**
   * This heading's position among *all* headings in the chapter, counting the
   * chapter's own as 0. The reader renders the chapter with matching ids, so
   * the two agree without either side having to slugify a title — which would
   * have to be done identically in two languages to stay in step.
   */
  anchor: number;
}

/**
 * GET /api/bruce/knowledge/files/:file — a book opened for reading.
 *
 * Served a chapter at a time. The two books this was built against are ~600 KB
 * of markdown each; sending one whole would be a slow request over the tunnel
 * and a slower render on the kiosk, for a page nobody reads end to end.
 */
export interface BruceBook {
  file: string;
  title: string;
  chapters: BruceBookChapter[];
  /** The chapter asked for (the first one when `?chapter=` was omitted). */
  chapter: BruceBookChapter & { content: string };
}

/** GET /api/bruce/instructions — the persona the chat runs with. */
export interface BruceInstructions {
  /** What is actually sent to the model: the custom text, or the built-in one. */
  text: string;
  /** True when knowledge/PROMPT.md exists and is being used. */
  custom: boolean;
  /** The built-in persona, so the page can show it and offer to revert. */
  builtIn: string;
}

/**
 * Body for PUT /api/bruce/instructions. Empty text deletes knowledge/PROMPT.md
 * and goes back to the built-in persona — that is the "revert" button.
 */
export const bruceInstructionsSchema = z.object({ text: z.string().max(20000) });
export type BruceInstructionsInput = z.infer<typeof bruceInstructionsSchema>;
