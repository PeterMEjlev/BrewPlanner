import type { HopStage, RecipeEditInput, RecipeHopEdit } from './index.js';
import {
  DEFAULT_GRIST_RATIO_L_PER_KG,
  alkalinityCaCO3FromBicarbonate,
  gristDistilledMashPh,
  mashBufferCapacity,
  predictedMashPh,
  residualAlkalinityCaCO3,
  type GristLine,
} from './mashPh.js';

export interface RecipeCalculationResult {
  originalGravity: number | null;
  preBoilGravity: number | null;
  postBoilGravity: number | null;
  finalGravity: number | null;
  abv: number | null;
  ibu: number | null;
  ebc: number | null;
  mashPh: number | null;
  /** Per-addition values, in the same order as `recipe.hops`. */
  hopIbus: Array<number | null>;
  /** Weight shares, in the same order as `recipe.fermentables`. */
  fermentablePercents: Array<number | null>;
}

const LITRES_PER_GALLON = 3.78541;

function recipeNumber(value: string | number | null | undefined): number | null {
  const parsed = typeof value === 'number'
    ? value
    : Number.parseFloat(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function weightPounds(amount: string, unit: string): number | null {
  const value = recipeNumber(amount);
  if (value == null || value < 0) return null;
  switch (unit.trim().toLowerCase()) {
    case 'kg': return value * 2.2046226218;
    case 'g': return value / 453.59237;
    case 'oz': return value / 16;
    case 'lb':
    case 'lbs': return value;
    default: return null;
  }
}

function weightGrams(amount: string, unit: string): number | null {
  const pounds = weightPounds(amount, unit);
  return pounds == null ? null : pounds * 453.59237;
}

/**
 * What one fermentable brings to the wort — the two things Brewer's Friend
 * keeps on every row of its fermentables table.
 *
 * `ppg` is the extract potential in points per pound per gallon at full
 * extraction, filled in from its ingredient database the moment a malt is
 * picked: it's what makes 10 kg of Pilsner and 10 kg of roasted barley land on
 * different gravities. `mashed` is the other half of that answer — brewhouse
 * efficiency only scales what the mash (or a steep) has to pull out of a grain.
 * Sugars and malt extracts arrive already converted and dissolve whole, so they
 * contribute their full potential whatever the brewhouse manages.
 */
export interface FermentableExtract {
  ppg: number;
  mashed: boolean;
  /** Whether yeast can reach these points — false for lactose and maltodextrin. */
  fermentable: boolean;
}

/**
 * `[name pattern, PPG at full extraction, does the mash have to extract it]`,
 * most specific first — the first match wins, so "honey malt" is a grain before
 * "honey" is a sugar, and "pale chocolate" is a roast before it is a base malt.
 *
 * Values follow Brewer's Friend's fermentable database. They are a stand-in for
 * a maltster's analysis sheet, not a substitute for it: a brewer with a real
 * figure can type it into the row's PPG box, which is what these fill in.
 */
const FERMENTABLE_EXTRACTS: Array<[RegExp, number, boolean]> = [
  // A filter bed, not a fermentable.
  [/rice hull|oat hull|\bhusk/, 0, true],

  // A grain, despite reading like a sugar — matched before `honey` below.
  [/honey malt/, 37, true],

  // Sugars and syrups: pre-converted, so efficiency never touches them.
  [/dextrose|corn sugar|glucose/, 42, false],
  [/table sugar|sucrose|cane sugar|beet sugar|caster sugar|white sugar/, 46, false],
  [/candi syrup|candy syrup|belgian syrup/, 32, false],
  [/candi sugar|candy sugar|rock sugar/, 38, false],
  [/brown sugar|demerara|turbinado|muscovado|jaggery|panela/, 44, false],
  [/invert sugar|golden syrup|treacle|molasses/, 36, false],
  [/lactose|milk sugar/, 35, false],
  [/maltodextrin/, 39, false],
  [/maple syrup/, 30, false],
  [/agave|rice syrup|date syrup|piloncillo/, 36, false],
  [/\bhoney\b/, 35, false],

  // Malt extracts: likewise already converted.
  [/dry malt extract|dried malt extract|dry extract|spray malt|\bdme\b/, 44, false],
  [/liquid malt extract|malt extract|malt syrup|\blme\b/, 37, false],

  // Roasted and dark grains.
  [/roast(ed)? barley/, 25, true],
  [/black malt|black patent|patent malt|carafa|midnight wheat|blackprinz|black prinz/, 25, true],
  [/chocolate/, 28, true],
  [/special\s*b\b/, 30, true],
  [/brown malt/, 32, true],

  // Crystal, caramel, and the kilned character malts.
  [/carapils|carafoam|dextrin/, 33, true],
  [/caraaroma|cararye|carawheat/, 33, true],
  [/crystal|caramel|caramunich|carahell|carared|caramalt|\bcara/, 34, true],
  [/biscuit|victory|amber malt|aromatic|abbey malt/, 35, true],
  [/melanoidin/, 37, true],
  [/acidulated|sauer\s?malz|sour malt/, 27, true],
  [/peated/, 34, true],
  [/smoked|rauch|cherrywood|beech\s?wood/, 37, true],

  // Adjuncts and unmalted grain.
  [/flaked wheat|torrified wheat/, 35, true],
  [/flaked barley/, 32, true],
  [/flaked oat|rolled oat|golden naked oat|malted oat|\boat/, 33, true],
  [/flaked maize|flaked corn|grits|\bmaize\b|\bcorn\b/, 37, true],
  [/flaked rice|\brice\b/, 38, true],
  [/flaked rye|rye malt|\brye\b/, 36, true],
  [/chit malt/, 32, true],
  [/spelt|buckwheat|millet|sorghum|quinoa/, 35, true],
  [/raw wheat|raw barley|unmalted/, 33, true],

  // Base malts.
  [/wheat malt|weizen|white wheat|red wheat|\bwheat\b/, 38, true],
  [/maris otter|golden promise|pale ale malt|\bpale ale\b|\bpearl\b/, 38, true],
  [/pilsner|pilsen|\bpils\b|lager malt|\bbohemian\b/, 37, true],
  [/munich/, 37, true],
  [/vienna/, 36, true],
  [/\b6[- ]row\b|six[- ]row/, 35, true],
  [/\b2[- ]row\b|two[- ]row|pale malt|mild malt|\bpale\b/, 37, true],
];

/**
 * What the yeast can't touch. These dissolve and lift the gravity like any
 * other sugar, but they are still there when fermentation stops: their points
 * belong to the finished beer's FG rather than to its alcohol, which is the
 * whole reason a milk stout stays sweet.
 */
const UNFERMENTABLE = /lactose|milk sugar|maltodextrin/;

/**
 * The extract potential of a named fermentable, or null when there is no name
 * to look one up for. Null is the point of this function: an amount typed into
 * a row whose malt hasn't been chosen yet contributes no sugar and no gravity,
 * exactly as it doesn't in Brewer's Friend, rather than quietly standing in for
 * an average base malt.
 */
export function fermentableExtract(name: string): FermentableExtract | null {
  const value = name.trim().toLocaleLowerCase();
  if (!value) return null;
  const fermentable = !UNFERMENTABLE.test(value);
  for (const [match, ppg, mashed] of FERMENTABLE_EXTRACTS) {
    if (match.test(value)) return { ppg, mashed, fermentable };
  }
  // A custom fermentable nothing in the table recognises. Brewer's Friend makes
  // the brewer type a PPG for one of these; the row's box is where that goes,
  // and until it's filled in a mid-range malt is the least surprising guess.
  return { ppg: 35, mashed: true, fermentable };
}

/** A fermentable's extract potential by name — null when the row names nothing. */
export function estimateFermentablePpg(name: string): number | null {
  return fermentableExtract(name)?.ppg ?? null;
}

/**
 * Whether the yeast will eat a row's points: the brewer's own flag when they
 * have set one, and the fermentable's nature otherwise. An unnamed row reads as
 * fermentable, which is the harmless answer — it contributes no points either
 * way.
 */
export function isFermentableLine(line: { name: string; fermentable: boolean | null }): boolean {
  return line.fermentable ?? fermentableExtract(line.name)?.fermentable ?? true;
}

/**
 * The extract a row actually contributes, from the brewer's own PPG and
 * fermentability flags where they have been set and the malt's otherwise. A row
 * that names nothing contributes nothing, whichever box has been filled in.
 */
function lineExtract(
  line: { name: string; ppg: number | null; fermentable: boolean | null },
): FermentableExtract | null {
  const known = fermentableExtract(line.name);
  if (known == null) return null;
  return {
    ppg: line.ppg ?? known.ppg,
    mashed: known.mashed,
    fermentable: line.fermentable ?? known.fermentable,
  };
}

function gravityFromPointGallons(pointGallons: number, litres: number | null): number | null {
  if (litres == null || litres <= 0 || pointGallons <= 0) return null;
  return 1 + pointGallons / (litres / LITRES_PER_GALLON) / 1000;
}

/**
 * A grain bill's extract at *perfect* extraction, in point-gallons, split by
 * whether the mash has to work for it: the mash's share is what brewhouse
 * efficiency is a percentage of, while sugars and malt extracts dissolve whole
 * and land in the wort whatever the brewhouse manages.
 *
 * This is {@link calculateRecipe}'s contribution sum with the efficiency factor
 * left out — the denominator, kept apart so a brew session can measure against it.
 */
export interface ExtractPotential {
  /** Point-gallons the mash would deliver if it extracted everything. */
  mashedPointGallons: number;
  /** Point-gallons that arrive in full regardless of the mash. */
  unmashedPointGallons: number;
  /**
   * The share of those that is already in the kettle at the pre-boil reading —
   * everything but the late additions, matching how {@link calculateRecipe}
   * figures its own pre-boil gravity. Kept apart so a *mash* efficiency
   * measured pre-boil doesn't credit the mash with a bag of sugar.
   */
  preBoilUnmashedPointGallons: number;
}

export function extractPotential(
  fermentables: {
    name: string;
    amount: string;
    unit: string;
    ppg: number | null;
    fermentable: boolean | null;
    lateAddition: boolean;
  }[],
): ExtractPotential {
  let mashedPointGallons = 0;
  let unmashedPointGallons = 0;
  let preBoilUnmashedPointGallons = 0;
  for (const line of fermentables) {
    const weight = weightPounds(line.amount, line.unit);
    const extract = lineExtract(line);
    // A line with no weight, or a malt the table doesn't recognise, contributes
    // nothing — the same silence calculateRecipe keeps about it.
    if (weight == null || extract == null) continue;
    const pointGallons = weight * extract.ppg;
    if (extract.mashed) {
      mashedPointGallons += pointGallons;
    } else {
      unmashedPointGallons += pointGallons;
      if (!line.lateAddition) preBoilUnmashedPointGallons += pointGallons;
    }
  }
  return { mashedPointGallons, unmashedPointGallons, preBoilUnmashedPointGallons };
}

/**
 * What the brewhouse actually managed, from a gravity the brewer measured and
 * the volume it was measured in — {@link calculateRecipe} run backwards.
 *
 * Forward, a recipe predicts its gravity by scaling the mash's potential by an
 * assumed efficiency. Given a real gravity and volume, the same relation says
 * what the efficiency was:
 *
 * ```
 *   delivered  = (gravity − 1) × 1000 × gallons
 *   efficiency = (delivered − sugars) / mash potential × 100
 * ```
 *
 * Which efficiency you get depends on where you measured. OG and the volume
 * into the fermenter give brewhouse efficiency — everything the day lost, mash
 * through kettle. Pre-boil gravity and pre-boil volume give mash efficiency,
 * which is the half that says whether a disappointing OG was the mash's fault
 * or the kettle's.
 *
 * Null unless every input is real, and deliberately *not* capped at 100: a
 * figure over 100% means a volume or a gravity is wrong, and hiding that behind
 * a tidy "100%" would be the opposite of useful.
 */
export function measuredEfficiency(input: {
  gravity: string | number | null;
  litres: number | null;
  mashedPointGallons: number | null;
  unmashedPointGallons: number | null;
}): number | null {
  const gravity = recipeNumber(input.gravity);
  const { litres, mashedPointGallons, unmashedPointGallons } = input;
  if (gravity == null || gravity <= 1) return null;
  if (litres == null || litres <= 0) return null;
  // No mash potential means nothing to be a percentage of — a bill of pure
  // sugar has no brewhouse efficiency, however well the day went.
  if (mashedPointGallons == null || mashedPointGallons <= 0) return null;
  const delivered = (gravity - 1) * 1000 * (litres / LITRES_PER_GALLON);
  const fromMash = delivered - (unmashedPointGallons ?? 0);
  if (!(fromMash > 0)) return null;
  return (fromMash / mashedPointGallons) * 100;
}

function attenuation(recipe: RecipeEditInput): number | null {
  const values = recipe.yeast
    .map((line) => recipeNumber(line.attenuation))
    .filter((value): value is number => value != null && value >= 0 && value <= 100);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function hopMinutes(recipe: RecipeEditInput, hop: RecipeHopEdit): number | null {
  if (hop.stage === 'First Wort') return recipe.settings.boilTimeMinutes ?? 60;
  if (hop.stage === 'Mash') return 5;
  if (hop.stage !== 'Boil') return null;
  return recipeNumber(hop.time);
}

function tinsethUtilization(minutes: number, gravity: number): number {
  return 1.65 * Math.pow(0.000125, gravity - 1) * (1 - Math.exp(-0.04 * minutes)) / 4.15;
}

/**
 * What a whirlpool charge is worth in bitterness when the addition says nothing
 * about how it was held — a flat 5%, the figure Brewer's Friend uses for a
 * hopstand of unstated length and temperature.
 */
const WHIRLPOOL_DEFAULT_UTILIZATION = 5;

/**
 * How many °C below boiling halves the rate at which alpha acid isomerises.
 * Follows Malowicki's rate constants closely enough for a recipe sheet: a stand
 * held at 80 °C extracts roughly a seventh of what the same time at a rolling
 * boil would, which is why a big flame-out charge smells of hops without
 * bittering like one.
 */
const WHIRLPOOL_HALVING_C = 7;

/**
 * The share of a whirlpool addition's alpha acid that isomerises, as a
 * percentage — the one number that makes a hopstand's time and temperature
 * matter.
 *
 * Three answers, in order of how much the recipe has said. A utilization typed
 * on the addition is the brewer's own measurement and wins outright. A stand
 * with both a time and a temperature is worked out: Tinseth for the contact
 * time, scaled down for the heat that isn't there. An addition that states
 * neither keeps the flat figure the app has always used, so an imported sheet's
 * IBUs don't move the day this got smarter.
 */
function whirlpoolUtilization(hop: RecipeHopEdit, boilGravity: number): number {
  const stated = recipeNumber(hop.utilization);
  if (stated != null && stated >= 0) return stated;
  // A hopstand is timed in minutes; anything measured in days is a dry hop
  // filed under the wrong stage, and reading "3" off it as 3 minutes would
  // quietly bitter the beer.
  const minutes = hop.timeUnit === 'day' ? null : recipeNumber(hop.time);
  const temp = recipeNumber(hop.temp);
  if (minutes == null || minutes <= 0 || temp == null) return WHIRLPOOL_DEFAULT_UTILIZATION;
  // Never above a boil's own rate: a whirlpool "at 105 °C" is a misread
  // thermometer, not extra bitterness.
  const heat = Math.min(1, Math.pow(2, (temp - 100) / WHIRLPOOL_HALVING_C));
  return tinsethUtilization(minutes, boilGravity) * 100 * heat;
}

function hopIbu(recipe: RecipeEditInput, hop: RecipeHopEdit, boilGravity: number): number | null {
  const grams = weightGrams(hop.amount, hop.unit);
  const alpha = recipeNumber(hop.aa);
  // Bitterness is a concentration in the finished beer, so the isomerised alpha
  // is diluted into the batch — not into the kettle. Dividing by the post-boil
  // volume instead charged the recipe for the trub the hops never leave with,
  // which read every batch a few percent less bitter than it pours. Post-boil
  // only stands in when there is no batch size to work from.
  const batchLitres = recipe.batchSizeL ?? recipe.settings.boilSizePostL;
  if (grams == null || alpha == null || batchLitres == null || batchLitres <= 0) return null;
  if (hop.stage === 'Dry Hop' || hop.stage === 'Other') return 0;

  if (hop.stage === 'Whirlpool') {
    const utilization = whirlpoolUtilization(hop, boilGravity);
    return grams * (alpha / 100) * (utilization / 100) * 1000 / batchLitres;
  }

  const minutes = hopMinutes(recipe, hop);
  if (minutes == null || minutes < 0) return null;
  const pelletFactor = hop.form.toLocaleLowerCase().includes('pellet') ? 1.1 : 1;
  return grams * (alpha / 100) * tinsethUtilization(minutes, boilGravity)
    * pelletFactor * 1000 / batchLitres;
}

function recipeColor(recipe: RecipeEditInput): number | null {
  if (recipe.batchSizeL == null || recipe.batchSizeL <= 0) return null;
  const gallons = recipe.batchSizeL / LITRES_PER_GALLON;
  let mcu = 0;
  for (const line of recipe.fermentables) {
    const pounds = weightPounds(line.amount, line.unit);
    if (pounds == null || line.ebc == null) continue;
    const srm = line.ebc / 1.97;
    const lovibond = Math.max(0, (srm + 0.76) / 1.3546);
    mcu += pounds * lovibond / gallons;
  }
  if (mcu <= 0) return null;
  const srm = 1.4922 * Math.pow(mcu, 0.6859);
  return Math.max(0, srm * 1.97);
}

/**
 * The grain bill in the terms {@link gristDistilledMashPh} works in. Lines with
 * no readable weight drop out; lines with no colour stay, since they still
 * dilute the malt's share of the bill.
 */
export function recipeGristLines(recipe: RecipeEditInput): GristLine[] {
  return recipe.fermentables
    .map((line) => ({
      name: line.name,
      weightKg: (weightGrams(line.amount, line.unit) ?? 0) / 1000,
      ebc: line.ebc,
    }))
    .filter((line) => line.weightKg > 0);
}

/**
 * Mash-pH estimate: what the grist reaches in distilled water, moved by what the
 * recipe's water profile does to it. Both halves live in {@link ./mashPh.js} so
 * the water calculator predicts the same pH for the same beer.
 *
 * Exact malt acidity and acid additions are not present in the recipe model, so
 * this value must stay visibly labelled as an estimate in consuming UIs.
 */
function recipeMashPh(recipe: RecipeEditInput): number | null {
  const distilled = gristDistilledMashPh(recipeGristLines(recipe));
  if (distilled == null) return null;

  const water = recipe.waterProfile;
  const ra = residualAlkalinityCaCO3(
    alkalinityCaCO3FromBicarbonate(recipeNumber(water?.bicarbonate) ?? 0),
    recipeNumber(water?.calcium) ?? 0,
    recipeNumber(water?.magnesium) ?? 0,
  );
  // The mash sheet already states its thickness, and buffering follows from it:
  // a thinner mash resists the same alkalinity less.
  const buffer = mashBufferCapacity(
    recipe.mashGuidelines?.startingThicknessLPerKg ?? DEFAULT_GRIST_RATIO_L_PER_KG,
  );
  return Math.min(6.5, Math.max(3.5, predictedMashPh(distilled, ra, buffer)));
}

/**
 * A volume worth storing: rounded to the nearest whole litre — the precision a
 * brewer actually reads a kettle's sight glass or a stovetop pot to — and only
 * if it's real.
 */
function boilVolume(litres: number | null): number | null {
  if (litres == null) return null;
  const rounded = Math.round(litres);
  return rounded > 0 ? rounded : null;
}

/**
 * The volumes the recipe's "calculate automatically" boxes stand for, following
 * Brewer's Friend — the source of truth for a recipe built to be brewed off one
 * of its sheets — so the same batch size lands on the same two numbers here.
 *
 * Working back from the fermenter: the batch is what ends up in it, so the
 * kettle has to hold that plus whatever drains away with the trub, and the boil
 * has to start from that plus whatever it drives off. Both losses are volumes,
 * not proportions — they come from the shape of the kettle and the heat under
 * it, so they don't scale with the batch:
 *
 * ```
 *   batch   10  15  20  25  30  35  40  45  50  55
 *   post    12  17  22  27  32  37  42  47  52  57   (batch + 2 L trub)
 *   pre     19  24  29  34  39  44  49  54  59  64   (post + 7 L/h × 1 h)
 * ```
 *
 * Pre-boil follows the post-boil box when it's ticked and the brewer's own
 * figure when it isn't, so the two agree however they are mixed. Null wherever
 * an input is missing: an automatic box with nothing to work from empties its
 * field rather than inventing a volume.
 */
export function autoBoilVolumes(recipe: RecipeEditInput): { preL: number | null; postL: number | null } {
  const { settings } = recipe;
  // Kept unrounded for the pre-boil sum below, so a fractional batch size is
  // rounded once at the end rather than once per volume.
  const rawPostL = recipe.batchSizeL == null
    ? null
    : recipe.batchSizeL + (settings.trubChillerLossL ?? 0);
  const afterBoil = settings.autoBoilSizePost ? rawPostL : settings.boilSizePostL ?? rawPostL;
  const boiledAway = (settings.boilOffLPerHour ?? 0) * (settings.boilTimeMinutes ?? 0) / 60;
  return {
    preL: afterBoil == null ? null : boilVolume(afterBoil + boiledAway),
    postL: boilVolume(rawPostL),
  };
}

/**
 * `recipe` with every automatic boil volume filled in — what the brewer sees in
 * the locked fields, and what gets calculated against and saved. A recipe with
 * both boxes unticked is returned untouched.
 */
export function withAutoBoilVolumes(recipe: RecipeEditInput): RecipeEditInput {
  const { settings } = recipe;
  if (!settings.autoBoilSizePre && !settings.autoBoilSizePost) return recipe;
  const auto = autoBoilVolumes(recipe);
  return {
    ...recipe,
    settings: {
      ...settings,
      boilSizePreL: settings.autoBoilSizePre ? auto.preL : settings.boilSizePreL,
      boilSizePostL: settings.autoBoilSizePost ? auto.postL : settings.boilSizePostL,
    },
  };
}

/** Calculate all recipe statistics from ingredient, volume, yeast, and water inputs. */
export function calculateRecipe(recipe: RecipeEditInput): RecipeCalculationResult {
  const efficiency = (recipe.settings.efficiencyPercent ?? 80) / 100;
  const pounds = recipe.fermentables.map((line) => weightPounds(line.amount, line.unit));
  const totalPounds = pounds.reduce((sum: number, value) => sum + (value ?? 0), 0);
  const fermentablePercents = pounds.map((value) =>
    value == null || totalPounds <= 0 ? null : value / totalPounds * 100);
  // Efficiency scales only what the mash has to work for; sugars and extracts
  // dissolve whole. A row with no malt chosen yet resolves to no extract and so
  // adds no points, which keeps every gravity below empty until it names one.
  const contributions = recipe.fermentables.map((line, index) => {
    const weight = pounds[index];
    const extract = lineExtract(line);
    if (weight == null || extract == null) return null;
    return {
      pointGallons: weight * extract.ppg * (extract.mashed ? efficiency : 1),
      lateAddition: line.lateAddition,
      fermentable: extract.fermentable,
    };
  });
  type Contribution = NonNullable<(typeof contributions)[number]>;
  const sumPointGallons = (include: (line: Contribution) => boolean): number =>
    contributions.reduce((sum, line) =>
      line && include(line) ? sum + line.pointGallons : sum, 0);

  const pointGallons = sumPointGallons(() => true);
  // A late addition goes in after the hops have had the wort they work in, so
  // the kettle's gravity — and the utilization the IBUs come off — is figured
  // without it. It still counts towards OG: it is in the fermenter either way.
  const boilPointGallons = sumPointGallons((line) => !line.lateAddition);
  const unfermentablePointGallons = sumPointGallons((line) => !line.fermentable);

  const originalGravity = gravityFromPointGallons(pointGallons, recipe.batchSizeL);
  const preBoilGravity = gravityFromPointGallons(
    boilPointGallons,
    recipe.settings.boilSizePreL ?? recipe.settings.boilSizePostL ?? recipe.batchSizeL,
  );
  const postBoilGravity = gravityFromPointGallons(
    boilPointGallons,
    recipe.settings.boilSizePostL ?? recipe.batchSizeL,
  );
  const yeastAttenuation = attenuation(recipe);
  // Points the yeast can't reach sit out attenuation and arrive in the glass
  // whole, so they lift FG and cost ABV rather than becoming alcohol.
  const unfermentable = gravityFromPointGallons(unfermentablePointGallons, recipe.batchSizeL);
  const unfermentablePoints = unfermentable == null ? 0 : unfermentable - 1;
  const finalGravity = originalGravity == null || yeastAttenuation == null
    ? null
    : 1 + unfermentablePoints
      + Math.max(0, originalGravity - 1 - unfermentablePoints) * (1 - yeastAttenuation / 100);
  const abv = originalGravity == null || finalGravity == null
    ? null
    : (originalGravity - finalGravity) * 131.25;
  // Never the OG: that one counts the late additions the boil never saw.
  const gravityForHops = preBoilGravity ?? postBoilGravity ?? 1;
  const hopIbus = recipe.hops.map((hop) => hopIbu(recipe, hop, gravityForHops));
  const ibuValues = hopIbus.filter((value): value is number => value != null);
  const ibu = recipe.hops.length && ibuValues.length
    ? ibuValues.reduce((sum, value) => sum + value, 0)
    : null;

  return {
    originalGravity,
    preBoilGravity,
    postBoilGravity,
    finalGravity,
    abv,
    ibu,
    ebc: recipeColor(recipe),
    mashPh: recipeMashPh(recipe),
    hopIbus,
    fermentablePercents,
  };
}

// ---------------------------------------------------------------------------
// Why a figure is still blank
// ---------------------------------------------------------------------------

/** A figure {@link missingStatInput} can account for the absence of. */
export type RecipeStatKey =
  | 'preBoilGravity'
  | 'postBoilGravity'
  | 'originalGravity'
  | 'finalGravity'
  | 'abv'
  | 'ibu'
  | 'ebc'
  | 'mashPh'
  | 'aromaRate';

/** Rows that actually put sugar in the wort: something named, and some of it. */
function contributingFermentables(recipe: RecipeEditInput): RecipeEditInput['fermentables'] {
  return recipe.fermentables.filter(
    (line) => line.name.trim() !== '' && (weightPounds(line.amount, line.unit) ?? 0) > 0,
  );
}

/** The grain bill's own gap — no malt named, or none of it weighed out. */
function grainGap(recipe: RecipeEditInput): string | null {
  if (contributingFermentables(recipe).length > 0) return null;
  return recipe.fermentables.some((line) => line.name.trim() !== '')
    ? 'Needs a malt weight'
    : 'Needs a malt';
}

/** A volume to dilute the extract into; the one figure every gravity needs. */
function volumeGap(litres: number | null | undefined): string | null {
  return litres == null || litres <= 0 ? 'Needs a batch size' : null;
}

/**
 * The kettle gravities see only what was in the kettle, so a bill made entirely
 * of late additions leaves them blank while OG reads perfectly well — which
 * looks like a bug unless the panel says so.
 */
function boiledGrainGap(recipe: RecipeEditInput): string | null {
  const contributing = contributingFermentables(recipe);
  return contributing.length > 0 && contributing.every((line) => line.lateAddition)
    ? 'All malt is a late addition'
    : null;
}

/** What FG is waiting on once there is a wort to attenuate. */
function yeastGap(recipe: RecipeEditInput): string | null {
  if (attenuation(recipe) != null) return null;
  return recipe.yeast.some((line) => line.name.trim() !== '')
    ? 'Needs yeast attenuation'
    : 'Needs a yeast';
}

/** Colour is carried by the malt rather than worked out from its name. */
function colourGap(recipe: RecipeEditInput): string | null {
  return contributingFermentables(recipe).some((line) => line.ebc != null)
    ? null
    : 'Needs a malt colour';
}

/**
 * Whether one addition would come out as a figure, mirroring {@link hopIbu}'s
 * own preconditions. Per row rather than per sheet on purpose: a weight on one
 * line and an alpha on the next add up to no bitterness at all, and a check
 * that merely found both somewhere would report the schedule as complete.
 *
 * The name is deliberately not required — an unnamed row carrying a weight, an
 * alpha and a time does bitter the beer, and hopIbu counts it.
 */
function hopYieldsIbu(recipe: RecipeEditInput, hop: RecipeHopEdit): boolean {
  if (weightGrams(hop.amount, hop.unit) == null) return false;
  if (recipeNumber(hop.aa) == null) return false;
  // These never bitter, but they do resolve — to a real zero, not to a blank.
  if (hop.stage === 'Dry Hop' || hop.stage === 'Other' || hop.stage === 'Whirlpool') return true;
  const minutes = hopMinutes(recipe, hop);
  return minutes != null && minutes >= 0;
}

/** Bitterness, in the order the schedule supplies it. */
function hopGap(recipe: RecipeEditInput): string | null {
  if (recipe.hops.length === 0) return 'Needs a hop';
  const gap = volumeGap(recipe.batchSizeL ?? recipe.settings.boilSizePostL);
  if (gap) return gap;
  if (recipe.hops.some((hop) => hopYieldsIbu(recipe, hop))) return null;

  const weighed = recipe.hops.some((hop) => weightGrams(hop.amount, hop.unit) != null);
  const alpha = recipe.hops.some((hop) => recipeNumber(hop.aa) != null);
  // An untouched template row — the editor starts every sheet with one — is not
  // a hop missing its weight, it is a hop schedule that hasn't been begun.
  if (!weighed && !alpha && !recipe.hops.some((hop) => hop.name.trim() !== '')) {
    return 'Needs a hop';
  }
  if (!weighed) return 'Needs a hop weight';
  if (!alpha) return 'Needs hop alpha acid';
  // Everything a bittering charge needs except how long it was in the kettle.
  return 'Needs a boil time';
}

/**
 * The aroma rate counts only the stages that put smell in the beer, so a sheet
 * with a full bittering charge and nothing late still has none of it — mirrors
 * the weighing {@link aromaHopRate} does.
 */
function aromaGap(recipe: RecipeEditInput): string | null {
  const grams = recipe.hops
    .filter((hop) => AROMA_HOP_STAGES.includes(hop.stage))
    .reduce((sum, hop) => sum + (weightGrams(hop.amount, hop.unit) ?? 0), 0);
  return grams > 0 ? null : 'Needs a whirlpool or dry hop';
}

/**
 * What one blank figure on the statistics panel is still waiting for, as a
 * phrase short enough to sit under it — "Needs a malt weight" rather than a
 * generic "needs more inputs" repeated down the whole column.
 *
 * Each answer names the *first* thing missing in the order the figure is built
 * up, so it stays true rather than complete: a sheet with no malt and no yeast
 * asks for the malt, and moves on to the yeast once that arrives. Null means
 * nothing is missing — the caller should have a figure to show.
 *
 * Lives beside {@link calculateRecipe} so the two are read and changed
 * together; a reason that has drifted from the arithmetic is worse than none.
 */
export function missingStatInput(recipe: RecipeEditInput, stat: RecipeStatKey): string | null {
  const { settings } = recipe;
  switch (stat) {
    case 'originalGravity':
      return grainGap(recipe) ?? volumeGap(recipe.batchSizeL);
    case 'preBoilGravity':
      return grainGap(recipe)
        ?? boiledGrainGap(recipe)
        ?? volumeGap(settings.boilSizePreL ?? settings.boilSizePostL ?? recipe.batchSizeL);
    case 'postBoilGravity':
      return grainGap(recipe)
        ?? boiledGrainGap(recipe)
        ?? volumeGap(settings.boilSizePostL ?? recipe.batchSizeL);
    // Attenuation acts on the OG, so both are prerequisites and the grain bill
    // is asked for first — there is nothing for a yeast to do without one.
    case 'finalGravity':
    case 'abv':
      return grainGap(recipe) ?? volumeGap(recipe.batchSizeL) ?? yeastGap(recipe);
    case 'ibu':
      return hopGap(recipe);
    case 'ebc':
      return grainGap(recipe) ?? volumeGap(recipe.batchSizeL) ?? colourGap(recipe);
    // No batch size in this one: pH comes off the grist's proportions, which a
    // bill has whether or not anyone has said how much beer it makes.
    case 'mashPh':
      return grainGap(recipe) ?? colourGap(recipe);
    case 'aromaRate':
      return volumeGap(recipe.batchSizeL) ?? aromaGap(recipe);
  }
}

// ---------------------------------------------------------------------------
// Aroma hopping rate
// ---------------------------------------------------------------------------

/**
 * The stages that actually put aroma in the beer. Boil (and mash/first-wort)
 * additions are left out of the hop-rate figure — that number describes aroma
 * intensity, and a big bittering charge would inflate it without making the
 * beer smell of anything.
 */
export const AROMA_HOP_STAGES: HopStage[] = ['Whirlpool', 'Dry Hop'];

/**
 * Grams of aroma hops per litre of batch — the brewery's shorthand for how
 * hoppy a beer smells, and the figure a hazy IPA is actually written to. Null
 * without a batch size to divide by, or before any aroma addition has a weight:
 * a rate of zero would read as a decision rather than as an empty sheet.
 */
export function aromaHopRate(
  hops: Array<{ amount: string; unit: string; stage: HopStage }>,
  batchSizeL: number | null,
): number | null {
  if (batchSizeL == null || batchSizeL <= 0) return null;
  const grams = hops
    .filter((hop) => AROMA_HOP_STAGES.includes(hop.stage))
    .reduce((sum, hop) => sum + (weightGrams(hop.amount, hop.unit) ?? 0), 0);
  return grams > 0 ? grams / batchSizeL : null;
}

// ---------------------------------------------------------------------------
// How long fermentation will take
// ---------------------------------------------------------------------------

/** The strain families that ferment on visibly different clocks. */
export type YeastFamily = 'ale' | 'lager' | 'kveik' | 'sour' | 'mixed';

/**
 * How each family behaves: how long it takes a 1.050 wort to reach terminal
 * gravity at the temperature it is usually held at.
 *
 * The reference temperature is not the strain's optimum — it is the temperature
 * the base figure was measured at, which is what makes the Q10 scaling below
 * mean anything. Kveik is the outlier in both columns: pitched at 30 °C it can
 * be done in two days, which is the whole reason brewers keep it.
 */
const YEAST_FAMILIES: Record<YeastFamily, { days: number; refC: number; label: string }> = {
  ale: { days: 5, refC: 20, label: 'Ale yeast' },
  lager: { days: 14, refC: 11, label: 'Lager yeast' },
  kveik: { days: 3, refC: 30, label: 'Kveik' },
  // Lachancea and the other single-strain souring yeasts. They make a sour beer
  // by themselves, on an ale's clock — souring in the first days of a primary
  // that is over in a week. Being quick is the entire reason a brewery reaches
  // for one instead of a blended culture, so they must not be timed as one.
  sour: { days: 7, refC: 22, label: 'Souring yeast' },
  // Brett, lacto and the blended cultures: primary is the quick part, and the
  // beer is not finished when it stops bubbling.
  mixed: { days: 60, refC: 20, label: 'Mixed culture' },
};

const KVEIK = /kveik|voss|hornindal|lutra|opshaug|framgarden|ebbegarden|sigmund|hothead|oslo/i;
/**
 * The single-strain souring yeasts, which have to be recognised *before*
 * {@link MIXED} gets to them.
 *
 * Every word that marks a beer as sour also marks it, wrongly, as slow: Philly
 * Sour is catalogued with the type "Sour", is sold as "WildBrew Philly Sour",
 * and so matches `sour`, `wild` and `philly` — three separate routes into a
 * sixty-day estimate for a yeast that finishes in a week.
 */
const FAST_SOUR = /philly\s*sour|lachancea|sourvisiae|thermotolerans/i;
const MIXED = /brett|sour|lacto|pedio|brux|wild|mixed|philly|funk/i;
const LAGER = /lager|pilsner yeast|w-?34\/?70|s-?23|s-?189|diamond|augustiner|urquell/i;

/** Which clock a pitch runs on, from what the recipe says about the strain. */
function yeastFamily(yeast: { name: string; type: string }): YeastFamily {
  const said = `${yeast.type} ${yeast.name}`;
  if (KVEIK.test(said)) return 'kveik';
  // Before MIXED, which would otherwise claim it on the word "sour" alone.
  if (FAST_SOUR.test(said)) return 'sour';
  if (MIXED.test(said)) return 'mixed';
  if (LAGER.test(said)) return 'lager';
  return 'ale';
}

/** What a recipe's pitch is expected to do, and how long it will take doing it. */
export interface FermentationEstimate {
  /** Days to terminal gravity — the middle of the range below. */
  days: number;
  /** The spread worth planning around; a hydrometer still has the last word. */
  minDays: number;
  maxDays: number;
  /** The temperature the estimate was made at, °C. */
  temperatureC: number;
  /** True when that temperature came from the strain rather than the recipe. */
  temperatureAssumed: boolean;
  family: YeastFamily;
  /** One line saying what drove the figure, for the readout's tooltip. */
  note: string;
}

/** The middle of a strain's stated range, when the recipe names no temperature. */
function optimumTemp(yeast: { minTempC: number | null; maxTempC: number | null }): number | null {
  if (yeast.minTempC != null && yeast.maxTempC != null) return (yeast.minTempC + yeast.maxTempC) / 2;
  return yeast.minTempC ?? yeast.maxTempC;
}

/** Gravity the base figures are quoted at. */
const REFERENCE_OG_POINTS = 50;

/**
 * Roughly how many days the primary fermentation will take: the strain, the
 * temperature it's held at, and how much sugar it has to get through.
 *
 * Three things move it, each the way brewers already talk about them:
 *
 * - **The strain.** A lager at 11 °C is a fortnight where an ale at 20 °C is
 *   under a week, and kveik at 30 °C is a long weekend.
 * - **The temperature.** Yeast follows the usual rule of thumb for reaction
 *   rates — about twice as fast for every 10 °C — so the same beer fermented
 *   cool takes proportionally longer. Clamped either side, because a strain
 *   held far outside its range stalls rather than continuing the curve.
 * - **The gravity.** More sugar is more work, and a big beer also stresses the
 *   yeast doing it, so the figure grows a little faster than linearly.
 *
 * This is a planning number for "when is the fermenter free", not a substitute
 * for two matching hydrometer readings — which is why it comes with a range and
 * a note rather than a single confident day count. Null when the sheet names no
 * yeast at all: with nothing pitched there is nothing to estimate.
 */
export function estimateFermentationDays(input: {
  /**
   * Original gravity, e.g. 1.062 — as a number, or as a recipe writes it. Null
   * (or unreadable) falls back to a 1.050 wort.
   */
  og: number | string | null;
  /**
   * The recipe's fermentation temperature — "18", "18 °C" or the number. Null
   * falls back to the strain's own range.
   */
  temperatureC: number | string | null;
  yeast: Array<{ name: string; type: string; minTempC: number | null; maxTempC: number | null }>;
}): FermentationEstimate | null {
  const pitched = input.yeast.filter((line) => line.name.trim() !== '');
  if (pitched.length === 0) return null;
  // The slowest pitch decides: a mixed-fermentation beer is not done when its
  // sacch is, and a co-pitch is finished when the last strain is.
  const families = pitched.map(yeastFamily);
  // Ordered slowest first, so a co-pitch is finished when its last strain is.
  const family = (['mixed', 'lager', 'sour', 'ale', 'kveik'] as YeastFamily[]).find((candidate) =>
    families.includes(candidate),
  ) ?? 'ale';
  const profile = YEAST_FAMILIES[family];

  const stated = recipeNumber(input.temperatureC);
  const assumed = stated == null;
  const temperatureC = stated
    ?? pitched.map(optimumTemp).find((value): value is number => value != null)
    ?? profile.refC;

  // Q10 = 2: every 10 °C below the reference roughly doubles the time, and
  // every 10 above roughly halves it. Bounded because the relationship stops
  // holding at the edges — a strain pushed far past its range doesn't finish in
  // an afternoon, and one chilled far below it stalls rather than merely
  // slowing.
  const heat = Math.min(4, Math.max(0.35, Math.pow(2, (profile.refC - temperatureC) / 10)));

  const og = recipeNumber(input.og);
  const points = og == null ? REFERENCE_OG_POINTS : Math.max(1, (og - 1) * 1000);
  const work = Math.min(3, Math.max(0.6, Math.pow(points / REFERENCE_OG_POINTS, 0.8)));

  const days = Math.max(1, Math.round(profile.days * heat * work));
  return {
    days,
    minDays: Math.max(1, Math.round(days * 0.7)),
    maxDays: Math.max(2, Math.ceil(days * 1.4)),
    temperatureC,
    temperatureAssumed: assumed,
    family,
    note: [
      `${profile.label} at ${Math.round(temperatureC)} °C`,
      assumed ? '(the strain’s own range — the recipe names no fermentation temperature)' : null,
      og == null ? 'on an assumed 1.050 wort' : `on a ${og.toFixed(3)} wort`,
      '— time to terminal gravity, before any diacetyl rest, cold crash or conditioning.',
      family === 'mixed' ? 'A mixed culture keeps working for months after that.' : null,
      'Confirm with two matching hydrometer readings.',
    ]
      .filter(Boolean)
      .join(' '),
  };
}

function calculatedText(value: number | null, decimals: number): string {
  return value == null ? '' : value.toFixed(decimals);
}

/** Store the displayed calculation outputs with a recipe snapshot. */
export function applyRecipeCalculations(input: RecipeEditInput): RecipeEditInput {
  // Resolve the automatic volumes first: they feed the gravities below, and a
  // saved recipe should hold the numbers its editor was showing.
  const recipe = withAutoBoilVolumes(input);
  const result = calculateRecipe(recipe);
  return {
    ...recipe,
    og: calculatedText(result.originalGravity, 3),
    preBoilGravity: result.preBoilGravity == null ? null : calculatedText(result.preBoilGravity, 3),
    postBoilGravity: result.postBoilGravity == null ? null : calculatedText(result.postBoilGravity, 3),
    fg: calculatedText(result.finalGravity, 3),
    abv: calculatedText(result.abv, 2),
    ibu: calculatedText(result.ibu, 2),
    ebc: calculatedText(result.ebc, 1),
    ebcEstimated: result.ebc != null,
    fermentables: recipe.fermentables.map((line, index) => ({
      ...line,
      percent: calculatedText(result.fermentablePercents[index] ?? null, 1),
    })),
    hops: recipe.hops.map((line, index) => ({
      ...line,
      ibu: calculatedText(result.hopIbus[index] ?? null, 2),
    })),
    waterProfile: recipe.waterProfile || result.mashPh != null
      ? {
          ...(recipe.waterProfile ?? {
            sourceName: null,
            name: null,
            notes: null,
            calcium: null,
            magnesium: null,
            sodium: null,
            chloride: null,
            sulfate: null,
            bicarbonate: null,
          }),
          ph: result.mashPh == null ? null : calculatedText(result.mashPh, 2),
        }
      : null,
  };
}
