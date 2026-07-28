export interface StyleRange {
  name: string;
  ibu: [number, number];
  abv: [number, number];
  ebc: [number, number];
}

/** 2021 BJCP vital statistics. Colour is converted from SRM with EBC = SRM × 1.97. */
const STYLE_RANGES: Record<string, StyleRange> = {
  '1A': { name: 'American Light Lager', ibu: [8, 12], abv: [2.8, 4.2], ebc: [3.9, 5.9] },
  '1B': { name: 'American Lager', ibu: [8, 18], abv: [4.2, 5.3], ebc: [3.9, 6.9] },
  '1C': { name: 'Cream Ale', ibu: [8, 20], abv: [4.2, 5.6], ebc: [3.9, 9.8] },
  '1D': { name: 'American Wheat Beer', ibu: [15, 30], abv: [4, 5.5], ebc: [5.9, 11.8] },
  '2A': { name: 'International Pale Lager', ibu: [18, 25], abv: [4.5, 6], ebc: [3.9, 11.8] },
  '2B': { name: 'International Amber Lager', ibu: [8, 25], abv: [4.5, 6], ebc: [11.8, 27.6] },
  '2C': { name: 'International Dark Lager', ibu: [8, 20], abv: [4.2, 6], ebc: [27.6, 59.1] },
  '3A': { name: 'Czech Pale Lager', ibu: [20, 35], abv: [3, 4.1], ebc: [5.9, 11.8] },
  '3B': { name: 'Czech Premium Pale Lager', ibu: [30, 45], abv: [4.2, 5.8], ebc: [6.9, 11.8] },
  '3C': { name: 'Czech Amber Lager', ibu: [20, 35], abv: [4.4, 5.8], ebc: [19.7, 31.5] },
  '3D': { name: 'Czech Dark Lager', ibu: [18, 34], abv: [4.4, 5.8], ebc: [33.5, 69] },
  '4A': { name: 'Munich Helles', ibu: [16, 22], abv: [4.7, 5.4], ebc: [5.9, 9.8] },
  '4B': { name: 'Festbier', ibu: [18, 25], abv: [5.8, 6.3], ebc: [7.9, 11.8] },
  '4C': { name: 'Helles Bock', ibu: [23, 35], abv: [6.3, 7.4], ebc: [11.8, 17.7] },
  '5A': { name: 'German Leichtbier', ibu: [15, 28], abv: [2.4, 3.6], ebc: [3, 7.9] },
  '5B': { name: 'Kölsch', ibu: [18, 30], abv: [4.4, 5.2], ebc: [6.9, 9.8] },
  '5C': { name: 'German Helles Exportbier', ibu: [20, 30], abv: [5, 6], ebc: [7.9, 11.8] },
  '5D': { name: 'German Pils', ibu: [22, 40], abv: [4.4, 5.2], ebc: [3.9, 7.9] },
  '6A': { name: 'Märzen', ibu: [18, 24], abv: [5.6, 6.3], ebc: [15.8, 33.5] },
  '6B': { name: 'Rauchbier', ibu: [20, 30], abv: [4.8, 6], ebc: [23.6, 43.3] },
  '6C': { name: 'Dunkles Bock', ibu: [20, 27], abv: [6.3, 7.2], ebc: [27.6, 43.3] },
  '7A': { name: 'Vienna Lager', ibu: [18, 30], abv: [4.7, 5.5], ebc: [17.7, 29.6] },
  '7B': { name: 'Altbier', ibu: [25, 50], abv: [4.3, 5.5], ebc: [17.7, 33.5] },
  '8A': { name: 'Munich Dunkel', ibu: [18, 28], abv: [4.5, 5.6], ebc: [33.5, 55.2] },
  '8B': { name: 'Schwarzbier', ibu: [20, 35], abv: [4.4, 5.4], ebc: [37.4, 59.1] },
  '9A': { name: 'Doppelbock', ibu: [16, 26], abv: [7, 10], ebc: [11.8, 49.2] },
  '9B': { name: 'Eisbock', ibu: [25, 35], abv: [9, 14], ebc: [33.5, 59.1] },
  '9C': { name: 'Baltic Porter', ibu: [20, 40], abv: [6.5, 9.5], ebc: [33.5, 59.1] },
  '10A': { name: 'Weissbier', ibu: [8, 15], abv: [4.3, 5.6], ebc: [3.9, 11.8] },
  '10B': { name: 'Dunkles Weissbier', ibu: [10, 18], abv: [4.3, 5.6], ebc: [27.6, 45.3] },
  '10C': { name: 'Weizenbock', ibu: [15, 30], abv: [6.5, 9], ebc: [11.8, 49.2] },
  '11A': { name: 'Ordinary Bitter', ibu: [25, 35], abv: [3.2, 3.8], ebc: [15.8, 27.6] },
  '11B': { name: 'Best Bitter', ibu: [25, 40], abv: [3.8, 4.6], ebc: [15.8, 31.5] },
  '11C': { name: 'Strong Bitter', ibu: [30, 50], abv: [4.6, 6.2], ebc: [15.8, 35.5] },
  '12A': { name: 'British Golden Ale', ibu: [20, 45], abv: [3.8, 5], ebc: [3.9, 9.8] },
  '12B': { name: 'Australian Sparkling Ale', ibu: [20, 35], abv: [4.5, 6], ebc: [7.9, 13.8] },
  '12C': { name: 'English IPA', ibu: [40, 60], abv: [5, 7.5], ebc: [11.8, 27.6] },
  '13A': { name: 'Dark Mild', ibu: [10, 25], abv: [3, 3.8], ebc: [27.6, 49.2] },
  '13B': { name: 'British Brown Ale', ibu: [20, 30], abv: [4.2, 5.9], ebc: [23.6, 43.3] },
  '13C': { name: 'English Porter', ibu: [18, 35], abv: [4, 5.4], ebc: [39.4, 59.1] },
  '14A': { name: 'Scottish Light', ibu: [10, 20], abv: [2.5, 3.3], ebc: [33.5, 49.2] },
  '14B': { name: 'Scottish Heavy', ibu: [10, 20], abv: [3.3, 3.9], ebc: [23.6, 39.4] },
  '14C': { name: 'Scottish Export', ibu: [15, 30], abv: [3.9, 6], ebc: [23.6, 39.4] },
  '15A': { name: 'Irish Red Ale', ibu: [18, 28], abv: [3.8, 5], ebc: [17.7, 27.6] },
  '15B': { name: 'Irish Stout', ibu: [25, 45], abv: [3.8, 5], ebc: [49.2, 78.8] },
  '15C': { name: 'Irish Extra Stout', ibu: [35, 50], abv: [5, 6.5], ebc: [59.1, 78.8] },
  '16A': { name: 'Sweet Stout', ibu: [20, 40], abv: [4, 6], ebc: [59.1, 78.8] },
  '16B': { name: 'Oatmeal Stout', ibu: [25, 40], abv: [4.2, 5.9], ebc: [43.3, 78.8] },
  '16C': { name: 'Tropical Stout', ibu: [30, 50], abv: [5.5, 8], ebc: [59.1, 78.8] },
  '16D': { name: 'Foreign Extra Stout', ibu: [50, 70], abv: [6.3, 8], ebc: [59.1, 78.8] },
  '17A': { name: 'British Strong Ale', ibu: [30, 60], abv: [5.5, 8], ebc: [15.8, 43.3] },
  '17B': { name: 'Old Ale', ibu: [30, 60], abv: [5.5, 9], ebc: [19.7, 43.3] },
  '17C': { name: 'Wee Heavy', ibu: [17, 35], abv: [6.5, 10], ebc: [27.6, 49.2] },
  '17D': { name: 'English Barley Wine', ibu: [35, 70], abv: [8, 12], ebc: [15.8, 43.3] },
  '18A': { name: 'Blonde Ale', ibu: [15, 28], abv: [3.8, 5.5], ebc: [5.9, 11.8] },
  '18B': { name: 'American Pale Ale', ibu: [30, 50], abv: [4.5, 6.2], ebc: [9.8, 19.7] },
  '19A': { name: 'American Amber Ale', ibu: [25, 40], abv: [4.5, 6.2], ebc: [19.7, 33.5] },
  '19B': { name: 'California Common', ibu: [30, 45], abv: [4.5, 5.5], ebc: [17.7, 27.6] },
  '19C': { name: 'American Brown Ale', ibu: [20, 30], abv: [4.3, 6.2], ebc: [35.5, 69] },
  '20A': { name: 'American Porter', ibu: [25, 50], abv: [4.8, 6.5], ebc: [43.3, 78.8] },
  '20B': { name: 'American Stout', ibu: [35, 75], abv: [5, 7], ebc: [59.1, 78.8] },
  '20C': { name: 'Imperial Stout', ibu: [50, 90], abv: [8, 12], ebc: [59.1, 78.8] },
  '21A': { name: 'American IPA', ibu: [40, 70], abv: [5.5, 7.5], ebc: [11.8, 27.6] },
  '21B': { name: 'Specialty IPA', ibu: [50, 90], abv: [5.5, 9], ebc: [49.2, 78.8] },
  '21C': { name: 'Hazy IPA', ibu: [25, 60], abv: [6, 9], ebc: [5.9, 13.8] },
  '22A': { name: 'Double IPA', ibu: [60, 100], abv: [7.5, 10], ebc: [11.8, 27.6] },
  '22B': { name: 'American Strong Ale', ibu: [50, 100], abv: [6.3, 10], ebc: [13.8, 35.5] },
  '22C': { name: 'American Barleywine', ibu: [50, 100], abv: [8, 12], ebc: [17.7, 35.5] },
  '22D': { name: 'Wheatwine', ibu: [30, 60], abv: [8, 12], ebc: [11.8, 27.6] },
  '23A': { name: 'Berliner Weisse', ibu: [3, 8], abv: [2.8, 3.8], ebc: [3.9, 5.9] },
  '23B': { name: 'Flanders Red Ale', ibu: [10, 25], abv: [4.6, 6.5], ebc: [19.7, 33.5] },
  '23C': { name: 'Oud Bruin', ibu: [20, 25], abv: [4, 8], ebc: [33.5, 43.3] },
  '23D': { name: 'Lambic', ibu: [0, 10], abv: [5, 6.5], ebc: [5.9, 11.8] },
  '23E': { name: 'Gueuze', ibu: [0, 10], abv: [5, 8], ebc: [9.8, 11.8] },
  '23F': { name: 'Fruit Lambic', ibu: [0, 10], abv: [5, 7], ebc: [5.9, 13.8] },
  '23G': { name: 'Gose', ibu: [5, 12], abv: [4.2, 4.8], ebc: [5.9, 7.9] },
  '24A': { name: 'Witbier', ibu: [8, 20], abv: [4.5, 5.5], ebc: [3.9, 7.9] },
  '24B': { name: 'Belgian Pale Ale', ibu: [20, 30], abv: [4.8, 5.5], ebc: [15.8, 27.6] },
  '24C': { name: 'Bière de Garde', ibu: [18, 28], abv: [6, 8.5], ebc: [11.8, 37.4] },
  '25A': { name: 'Belgian Blond Ale', ibu: [15, 30], abv: [6, 7.5], ebc: [7.9, 11.8] },
  '25B': { name: 'Saison', ibu: [20, 35], abv: [5, 7], ebc: [9.8, 27.6] },
  '25C': { name: 'Belgian Golden Strong Ale', ibu: [22, 35], abv: [7.5, 10.5], ebc: [5.9, 11.8] },
  '26A': { name: 'Belgian Single', ibu: [25, 45], abv: [4.8, 6], ebc: [5.9, 9.8] },
  '26B': { name: 'Belgian Dubbel', ibu: [15, 25], abv: [6, 7.6], ebc: [19.7, 33.5] },
  '26C': { name: 'Belgian Tripel', ibu: [20, 40], abv: [7.5, 9.5], ebc: [8.9, 13.8] },
  '26D': { name: 'Belgian Dark Strong Ale', ibu: [20, 35], abv: [8, 12], ebc: [23.6, 43.3] },
  '28D': { name: 'Straight Sour Beer', ibu: [3, 8], abv: [4.5, 7], ebc: [3.9, 5.9] },
  '29D': { name: 'Grape Ale', ibu: [10, 30], abv: [6, 8.5], ebc: [7.9, 15.8] },
  'X3': { name: 'Italian Grape Ale', ibu: [6, 30], abv: [4.5, 12], ebc: [27.6, 49.2] },
  'X4': { name: 'Catharina Sour', ibu: [2, 8], abv: [4, 5.5], ebc: [3.9, 11.8] },
  'X5': { name: 'New Zealand Pilsner', ibu: [25, 45], abv: [4.5, 5.8], ebc: [3.9, 11.8] },
};

/**
 * Style names that no entry above matches by name, mapped onto the code whose
 * vital statistics they are judged against. Mostly the short list the recipe
 * editor offers, plus the spellings recipes arrive with.
 *
 * A bare family name resolves to the family's mainstream member so a recipe
 * saved as "Stout" or "Brown Ale" — the short list has no substyle for either —
 * still gets a range to sit in. That is a default for an unspecified beer, not
 * a claim that the two are the same style.
 */
const STYLE_ALIASES: Record<string, string> = {
  neipa: '21C',
  'new england ipa': '21C',
  // Two names for one beer: BJCP files both under 22A.
  'imperial ipa': '22A',
  'german pilsner': '5D',
  'german pilsner (pils)': '5D',
  // A German Pils dry-hopped with noble hops; BJCP has no entry of its own.
  'italian pilsner': '5D',
  weissbeer: '10A',
  ipa: '21A',
  stout: '20B',
  sour: '28D',
  'brown ale': '19C',
  pilsner: '5D',
};

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

/** Find a style by BJCP code first and by its display name when no code is stored. */
export function rangeForStyle(style: string): StyleRange | null {
  const code = /^\s*((?:\d{1,2}[a-z])|x\d)\b/i.exec(style)?.[1]?.toUpperCase();
  if (code && STYLE_RANGES[code]) return STYLE_RANGES[code];
  const wanted = normalized(style.replace(/^\s*(?:\d{1,2}[a-z]|x\d)\.\s*/i, ''));
  if (!wanted) return null;
  const alias = STYLE_ALIASES[wanted];
  if (alias && STYLE_RANGES[alias]) return STYLE_RANGES[alias];
  return Object.values(STYLE_RANGES).find((range) => normalized(range.name) === wanted) ?? null;
}
