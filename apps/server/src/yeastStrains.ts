import type { RecipeYeastSpec } from '@checklist/shared';

/**
 * What the producers publish about the strains this brewery can buy, so picking
 * a yeast in the recipe editor fills in the same fields Brewer's Friend does:
 * attenuation, the optimum temperature range, flocculation and alcohol
 * tolerance.
 *
 * Every figure is the producer's own spec sheet (Fermentis, Lallemand, White
 * Labs, Wyeast, Mangrove Jack's, Imperial, Kveik Yeastery), reduced to one
 * typical apparent attenuation where they state a range. They are a starting
 * point, not a measurement: every field stays editable on the line, and a
 * recipe that has already used the strain wins over this table.
 *
 * Alcohol tolerance is quoted the way each producer quotes it, which is not the
 * same way twice: Fermentis and Lallemand publish a percentage, White Labs and
 * Wyeast a category ("Medium-High"). Both are kept verbatim rather than
 * converted into each other — the picker knows how to rank either.
 *
 * The list covers Humlecentralen's yeast catalogue — what the picker actually
 * offers — plus the liquid strains a recipe imported from Brewer's Friend is
 * likely to name.
 */

/** Flocculation as the editor's dropdown spells it. */
type Flocculation = 'Low' | 'Medium-Low' | 'Medium' | 'Medium-High' | 'High' | '';

/**
 * One strain, in the order the tables below state it:
 *
 * `[match, type, attenuation %, flocculation, min °C, max °C, tolerance]`
 *
 * `match` holds the ways a listing can name the strain, separated by `|`: a
 * product code ("us05", "wlp001") or a phrase of words ("philly sour"). A
 * phrase matches when every word in it appears in the name, so the shop's
 * "Fermentis - SafAle US-05, 11,5 g. tørgær" and a Brewer's Friend recipe's
 * "Safale American Ale (US-05)" both land on the same row.
 */
type Row = [string, string, number | null, Flocculation, number | null, number | null, string];

interface LabTable {
  lab: string;
  /** Every strain a lab sells in the same form, which is how they're grouped. */
  form: 'Dry' | 'Liquid';
  rows: Row[];
}

const TABLES: LabTable[] = [
  {
    lab: 'Fermentis',
    form: 'Dry',
    rows: [
      ['us05|us56', 'Ale', 81, 'Medium', 15, 22, '9-11%'],
      ['s04', 'Ale', 75, 'High', 15, 20, '9-11%'],
      ['s33', 'Ale', 70, 'Medium', 15, 24, '9-11%'],
      ['t58', 'Ale', 70, 'Medium', 15, 24, '12%'],
      ['k97', 'Ale', 82, 'Low', 15, 20, '9-11%'],
      ['be134', 'Ale', 92, 'Low', 18, 28, '12%'],
      ['be256', 'Ale', 82, 'High', 15, 24, '12%'],
      ['wb06', 'Wheat', 86, 'Low', 15, 24, '9-11%'],
      ['w68', 'Wheat', 80, 'Medium', 18, 26, '9-11%'],
      // Bottle and cask conditioning: it refermnts what the primary strain left,
      // so the producer states no attenuation of its own.
      ['f2', 'Ale', null, 'High', 15, 25, 'High'],
      ['w3470', 'Lager', 83, 'High', 12, 15, '9-11%'],
      ['s23', 'Lager', 82, 'High', 12, 15, '9-11%'],
      ['s189', 'Lager', 84, 'High', 12, 15, '9-11%'],
      ['e30', 'Lager', 82, 'Medium', 12, 18, '9-11%'],
      ['sh45', 'Lager', 80, 'High', 12, 18, '9-11%'],
      // Yeast plus glucoamylase, which is what takes it past a normal ceiling.
      ['ha18', 'Ale', 100, 'Medium', 25, 35, '>13%'],
      ['br8', 'Brett', 85, 'Low', 15, 25, '9-11%'],
    ],
  },
  {
    lab: 'Lallemand',
    form: 'Dry',
    rows: [
      ['verdant', 'Ale', 78, 'Medium-High', 18, 23, '11%'],
      ['nottingham', 'Ale', 80, 'High', 10, 22, '14%'],
      ['windsor', 'Ale', 68, 'Low', 15, 25, '12%'],
      ['bry97', 'Ale', 80, 'Medium-High', 15, 22, '13%'],
      ['lallemand new england|lalbrew new england', 'Ale', 80, 'Medium', 18, 25, '9%'],
      ['lallemand voss|lalbrew voss', 'Ale', 82, 'High', 25, 40, '12%'],
      ['lallemand wit|lalbrew wit', 'Wheat', 80, 'Low', 17, 22, '12%'],
      ['farmhouse', 'Ale', 88, 'Low', 20, 30, '12%'],
      // Lachancea, not Saccharomyces: it sours the wort itself, making lactic
      // acid during the primary rather than needing a bacterium pitched with it.
      ['philly sour', 'Sour', 80, 'High', 20, 30, '10%'],
      ['diamond', 'Lager', 80, 'High', 10, 15, '13%'],
      ['novalager', 'Lager', 82, 'High', 10, 20, '11%'],
      ['pomona', 'Ale', 80, 'Medium', 18, 22, '11%'],
      ['belle saison', 'Ale', 85, 'Low', 15, 35, '12%'],
      ['munich classic', 'Wheat', 70, 'Low', 17, 22, '12%'],
      ['abbaye', 'Ale', 85, 'Medium', 17, 25, '12%'],
      ['koln', 'Ale', 80, 'High', 12, 20, '9%'],
      ['london esb', 'Ale', 72, 'High', 18, 22, '9%'],
    ],
  },
  {
    lab: 'White Labs',
    form: 'Liquid',
    rows: [
      ['wlp001', 'Ale', 77, 'Medium-High', 20, 23, 'Medium-High'],
      ['wlp002', 'Ale', 67, 'High', 18, 20, 'Medium-High'],
      ['wlp004', 'Ale', 72, 'Medium', 18, 20, 'Medium'],
      ['wlp007', 'Ale', 75, 'High', 18, 21, 'High'],
      ['wlp008', 'Ale', 73, 'Low', 20, 23, 'Medium'],
      ['wlp013', 'Ale', 71, 'Medium', 19, 22, 'Medium'],
      ['wlp028', 'Ale', 73, 'Medium', 18, 21, 'Medium-High'],
      ['wlp029', 'Ale', 75, 'Medium', 18, 21, 'Medium'],
      ['wlp066', 'Ale', 78, 'Low', 18, 22, 'Medium'],
      ['wlp077', 'Ale', 80, 'Low', 18, 23, 'Medium'],
      ['wlp090', 'Ale', 78, 'High', 18, 20, 'High'],
      ['wlp095', 'Ale', 78, 'Medium', 19, 22, 'Medium'],
      ['wlp300', 'Wheat', 74, 'Low', 20, 22, 'Medium'],
      ['wlp380', 'Wheat', 77, 'Low', 19, 21, 'Medium'],
      ['wlp400', 'Wheat', 76, 'Low', 19, 23, 'Medium'],
      ['wlp410', 'Wheat', 73, 'Medium', 19, 23, 'Medium'],
      ['wlp500', 'Ale', 78, 'Medium', 18, 22, 'Medium-High'],
      ['wlp521', 'Ale', 78, 'High', 22, 37, 'Medium-High'],
      ['wlp530', 'Ale', 78, 'Medium', 19, 22, 'Medium-High'],
      ['wlp540', 'Ale', 78, 'Medium', 19, 22, 'Medium-High'],
      ['wlp545', 'Ale', 82, 'Medium', 18, 23, 'High'],
      ['wlp550', 'Ale', 82, 'Medium', 20, 26, 'Medium-High'],
      ['wlp565', 'Ale', 70, 'Medium', 20, 24, 'Medium'],
      ['wlp566', 'Ale', 82, 'Medium', 20, 26, 'Medium'],
      ['wlp644', 'Ale', 85, 'Low', 21, 29, 'Medium-High'],
      ['wlp648', 'Brett', 85, 'Low', 21, 29, 'Medium-High'],
      ['wlp800', 'Lager', 75, 'High', 10, 13, 'Medium'],
      ['wlp802', 'Lager', 78, 'Medium', 10, 13, 'Medium'],
      ['wlp810', 'Lager', 68, 'High', 14, 18, 'Medium'],
      ['wlp830', 'Lager', 77, 'Medium', 10, 13, 'Medium'],
      ['wlp833', 'Lager', 73, 'Medium', 9, 13, 'Medium-High'],
      ['wlp835', 'Lager', 75, 'Medium', 10, 13, 'Medium'],
      ['wlp838', 'Lager', 72, 'High', 10, 13, 'Medium'],
      ['wlp850', 'Lager', 75, 'Medium', 10, 13, 'Medium'],
      ['wlp860', 'Lager', 70, 'Medium', 9, 11, 'Medium'],
    ],
  },
  {
    lab: 'Wyeast',
    form: 'Liquid',
    rows: [
      ['1007', 'Ale', 75, 'Low', 13, 19, 'Medium'],
      ['1010', 'Ale', 76, 'Low', 14, 23, 'Low'],
      ['1028', 'Ale', 75, 'Medium', 16, 22, 'Medium-High'],
      ['1056', 'Ale', 75, 'Medium', 16, 22, 'Medium'],
      ['1084', 'Ale', 73, 'Medium', 17, 22, 'Medium'],
      ['1098', 'Ale', 74, 'Medium', 18, 22, 'Medium'],
      ['1272', 'Ale', 74, 'High', 16, 22, 'Medium'],
      ['1275', 'Ale', 77, 'Medium', 17, 22, 'Medium'],
      ['1318', 'Ale', 73, 'High', 18, 23, 'Medium'],
      ['1332', 'Ale', 69, 'High', 18, 24, 'Medium'],
      ['1335', 'Ale', 75, 'High', 17, 24, 'Medium'],
      ['1338', 'Ale', 69, 'High', 17, 22, 'Medium'],
      ['1388', 'Ale', 76, 'Low', 18, 24, 'High'],
      ['1450', 'Ale', 75, 'Low', 16, 21, 'Medium'],
      ['1728', 'Ale', 71, 'High', 13, 24, 'High'],
      ['1762', 'Ale', 75, 'Medium', 18, 24, 'High'],
      ['1968', 'Ale', 69, 'High', 18, 22, 'Medium'],
      ['2007', 'Lager', 73, 'Medium', 9, 13, 'Medium'],
      ['2035', 'Lager', 75, 'Medium', 9, 14, 'Medium'],
      ['2042', 'Lager', 75, 'Medium', 8, 13, 'Medium'],
      ['2112', 'Lager', 69, 'High', 14, 20, 'Medium'],
      ['2124', 'Lager', 71, 'Medium', 9, 14, 'Medium'],
      ['2206', 'Lager', 75, 'Medium', 8, 14, 'Medium'],
      ['2278', 'Lager', 72, 'Medium', 10, 14, 'Medium'],
      ['2308', 'Lager', 75, 'Medium', 9, 13, 'Medium'],
      ['2565', 'Ale', 75, 'Low', 13, 18, 'Medium'],
      ['3056', 'Wheat', 75, 'Medium', 18, 23, 'Medium'],
      ['3068', 'Wheat', 75, 'Low', 18, 24, 'Medium'],
      ['3711', 'Ale', 80, 'Medium', 18, 25, 'Medium'],
      ['3724', 'Ale', 78, 'Low', 21, 35, 'High'],
      ['3787', 'Ale', 76, 'Medium', 18, 26, 'High'],
      ['3944', 'Wheat', 74, 'Medium', 17, 24, 'Medium'],
      ['5112', 'Brett', 82, 'Medium', 16, 24, 'Medium'],
    ],
  },
  {
    lab: "Mangrove Jack's",
    form: 'Dry',
    rows: [
      ['m15', 'Ale', 73, 'Medium-High', 18, 22, '8%'],
      ['m20', 'Wheat', 73, 'Medium-Low', 18, 30, '7.5%'],
      ['m21', 'Wheat', 73, 'Medium-Low', 18, 25, '8%'],
      ['m29', 'Ale', 88, 'Medium', 26, 32, '14%'],
      ['m31', 'Ale', 85, 'Medium', 18, 28, '10%'],
      ['m36', 'Ale', 76, 'Medium-High', 18, 23, '9%'],
      ['m41', 'Ale', 85, 'Medium', 18, 28, '12%'],
      ['m42', 'Ale', 80, 'High', 16, 22, '12%'],
      ['m44', 'Ale', 79, 'Medium-High', 18, 23, '11%'],
      ['m47', 'Ale', 75, 'Medium-High', 18, 25, '8%'],
      ['m54', 'Lager', 80, 'Medium-High', 18, 20, '9%'],
      ['m66', 'Ale', 80, 'Medium', 18, 23, '12%'],
      ['m76', 'Lager', 78, 'Medium', 8, 14, '8%'],
      ['m84', 'Lager', 74, 'Medium-High', 10, 15, '8%'],
      ['m12', 'Ale', 80, 'High', 25, 40, '12%'],
      // The one thing in the shop's yeast list that isn't a beer strain. Listed
      // so the picker can say so rather than leaving it the single unlabelled
      // sachet on the shelf; attenuation is left blank because a mead yeast's
      // is measured against honey, not against a grain bill.
      ['m05', 'Wine', null, 'Medium', 18, 30, '18%'],
    ],
  },
  {
    lab: 'Imperial Yeast',
    form: 'Liquid',
    rows: [
      ['a43', 'Ale', 80, 'Medium-High', 18, 38, '10%'],
      ['a07', 'Ale', 75, 'Medium', 18, 22, '11%'],
      ['a38', 'Ale', 78, 'Medium-Low', 18, 22, '10%'],
      ['a24', 'Ale', 78, 'Medium', 18, 22, '10%'],
    ],
  },
  {
    lab: 'Kveik Yeastery',
    form: 'Dry',
    rows: [
      ['k1', 'Ale', 82, 'High', 15, 40, '13%'],
      ['k9', 'Ale', 80, 'High', 15, 38, '12%'],
      ['k14', 'Ale', 78, 'Medium', 15, 38, '12%'],
      ['k22', 'Ale', 78, 'High', 8, 38, '15%'],
    ],
  },
  {
    lab: 'Omega Yeast',
    form: 'Liquid',
    rows: [
      ['oyl071|lutra kveik', 'Ale', 80, 'Medium', 20, 35, '11%'],
      ['oyl061|omega voss', 'Ale', 80, 'High', 20, 40, '12%'],
      ['oyl091|omega hornindal', 'Ale', 80, 'Medium-High', 20, 40, '12%'],
      ['oyl052|dipa ale', 'Ale', 79, 'Medium', 18, 22, '11%'],
    ],
  },
];

interface Strain {
  spec: RecipeYeastSpec;
  /** Each way the strain can be named, as the words that all have to be there. */
  phrases: string[][];
}

const STRAINS: Strain[] = TABLES.flatMap(({ lab, form, rows }) =>
  rows.map(([match, type, attenuation, flocculation, minTempC, maxTempC, alcoholTolerance]) => ({
    spec: {
      lab,
      form,
      type,
      attenuation: attenuation == null ? '' : String(attenuation),
      flocculation,
      minTempC,
      maxTempC,
      alcoholTolerance,
    },
    phrases: match.split('|').map((phrase) => words(phrase)),
  })),
);

/**
 * The words of a name, with the separators inside a product code closed up so
 * "S-04", "W-34/70" and "K.1" survive as one word each — that is what lets a
 * code identify a strain no matter how the listing punctuates it. Accents are
 * dropped rather than split on, so the shop's "Köln" is one word and not two.
 */
function words(name: string): string[] {
  return name
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[.\-/,']/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * What the producer says about the strain a listing names, or null when the
 * table doesn't know it.
 *
 * The best-matching row wins rather than the first: "Mangrove Jack's M12 Kveik
 * (Voss)" names both a code and another lab's strain name, and the code is the
 * more specific of the two.
 */
export function yeastStrainSpec(name: string): RecipeYeastSpec | null {
  const present = new Set(words(name));
  if (present.size === 0) return null;
  let best: { spec: RecipeYeastSpec; score: number } | null = null;
  for (const strain of STRAINS) {
    for (const phrase of strain.phrases) {
      if (!phrase.every((word) => present.has(word))) continue;
      // A code outranks any amount of prose: "voss" is how three labs describe a
      // kveik and "east coast ale" describes half of them, while "m12" is one
      // product. Prose only decides between rows that no code identified.
      const score = phrase.length + (phrase.length === 1 && /\d/.test(phrase[0]!) ? 10 : 0);
      if (!best || score > best.score) best = { spec: strain.spec, score };
    }
  }
  return best?.spec ?? null;
}

/**
 * What the picker should offer for one yeast: what a recipe already using the
 * strain says about it, filled out field by field from the table where that
 * recipe left something blank. Null when neither has anything to say, so the
 * editor leaves the line alone rather than blanking it.
 */
export function yeastSpecFor(
  name: string,
  saved: RecipeYeastSpec | null | undefined = null,
): RecipeYeastSpec | null {
  const table = yeastStrainSpec(name);
  if (!saved) return table;
  if (!table) return stated(saved) ? saved : null;
  return {
    lab: saved.lab || table.lab,
    type: saved.type || table.type,
    form: saved.form || table.form,
    attenuation: saved.attenuation || table.attenuation,
    flocculation: saved.flocculation || table.flocculation,
    minTempC: saved.minTempC ?? table.minTempC,
    maxTempC: saved.maxTempC ?? table.maxTempC,
    alcoholTolerance: saved.alcoholTolerance || table.alcoholTolerance,
  };
}

/** Whether a spec carries anything at all, or is a line nobody filled in. */
function stated(spec: RecipeYeastSpec): boolean {
  return Boolean(
    spec.lab ||
      spec.type ||
      spec.form ||
      spec.attenuation ||
      spec.flocculation ||
      spec.alcoholTolerance ||
      spec.minTempC != null ||
      spec.maxTempC != null,
  );
}
