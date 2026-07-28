import type { RecipeEditInput, RecipeHopEdit } from './index.js';

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

function hopIbu(recipe: RecipeEditInput, hop: RecipeHopEdit, boilGravity: number): number | null {
  const grams = weightGrams(hop.amount, hop.unit);
  const alpha = recipeNumber(hop.aa);
  const batchLitres = recipe.settings.boilSizePostL ?? recipe.batchSizeL;
  if (grams == null || alpha == null || batchLitres == null || batchLitres <= 0) return null;
  if (hop.stage === 'Dry Hop' || hop.stage === 'Other') return 0;

  if (hop.stage === 'Whirlpool') {
    const utilization = 5;
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
 * Mash-pH estimate from grist colour, residual alkalinity, and acidulated malt.
 * Exact malt acidity and acid additions are not present in the recipe model, so
 * this value must stay visibly labelled as an estimate in consuming UIs.
 */
function recipeMashPh(recipe: RecipeEditInput, percents: Array<number | null>): number | null {
  const coloured = recipe.fermentables
    .map((line, index) => ({ line, percent: percents[index] }))
    .filter(({ line, percent }) => line.ebc != null && percent != null && percent > 0);
  if (!coloured.length) return null;

  const weightedLovibond = coloured.reduce((sum, { line, percent }) => {
    const srm = (line.ebc ?? 0) / 1.97;
    return sum + Math.max(0, (srm + 0.76) / 1.3546) * (percent ?? 0) / 100;
  }, 0);
  const acidulatedPercent = coloured.reduce((sum, { line, percent }) =>
    /acidulated|sauer\s?malz|sour malt/i.test(line.name) ? sum + (percent ?? 0) : sum, 0);

  const water = recipe.waterProfile;
  const calcium = recipeNumber(water?.calcium) ?? 0;
  const magnesium = recipeNumber(water?.magnesium) ?? 0;
  const bicarbonate = recipeNumber(water?.bicarbonate) ?? 0;
  const alkalinityAsCaco3 = bicarbonate * 50 / 61;
  const residualAlkalinity = alkalinityAsCaco3 - calcium / 3.5 - magnesium / 7;
  const estimated = 5.7
    - 0.17 * Math.log10(Math.max(1, weightedLovibond))
    + residualAlkalinity / 500
    - acidulatedPercent * 0.1;
  return Math.min(6.5, Math.max(3.5, estimated));
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
    mashPh: recipeMashPh(recipe, fermentablePercents),
    hopIbus,
    fermentablePercents,
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
