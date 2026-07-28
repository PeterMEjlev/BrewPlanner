export interface StyleChoice {
  category: string;
  value: string;
}

/** BJCP-style categories used by Brewer's Friend's two-level style picker. */
const STYLE_GROUPS: Array<[string, string[]]> = [
  ['1. Standard American Beer', ['1A. American Light Lager', '1B. American Lager', '1C. Cream Ale', '1D. American Wheat Beer']],
  ['2. International Lager', ['2A. International Pale Lager', '2B. International Amber Lager', '2C. International Dark Lager']],
  ['3. Czech Lager', ['3A. Czech Pale Lager', '3B. Czech Premium Pale Lager', '3C. Czech Amber Lager', '3D. Czech Dark Lager']],
  ['4. Pale Malty European Lager', ['4A. Munich Helles', '4B. Festbier', '4C. Helles Bock']],
  ['5. Pale Bitter European Beer', ['5A. German Leichtbier', '5B. Kölsch', '5C. German Helles Exportbier', '5D. German Pils']],
  ['6. Amber Malty European Lager', ['6A. Märzen', '6B. Rauchbier', '6C. Dunkles Bock']],
  ['7. Amber Bitter European Beer', ['7A. Vienna Lager', '7B. Altbier', '7C. Kellerbier']],
  ['8. Dark European Lager', ['8A. Munich Dunkel', '8B. Schwarzbier']],
  ['9. Strong European Beer', ['9A. Doppelbock', '9B. Eisbock', '9C. Baltic Porter']],
  ['10. German Wheat Beer', ['10A. Weissbier', '10B. Dunkles Weissbier', '10C. Weizenbock']],
  ['11. British Bitter', ['11A. Ordinary Bitter', '11B. Best Bitter', '11C. Strong Bitter']],
  ['12. Pale Commonwealth Beer', ['12A. British Golden Ale', '12B. Australian Sparkling Ale', '12C. English IPA']],
  ['13. Brown British Beer', ['13A. Dark Mild', '13B. British Brown Ale', '13C. English Porter']],
  ['14. Scottish Ale', ['14A. Scottish Light', '14B. Scottish Heavy', '14C. Scottish Export']],
  ['15. Irish Beer', ['15A. Irish Red Ale', '15B. Irish Stout', '15C. Irish Extra Stout']],
  ['16. Dark British Beer', ['16A. Sweet Stout', '16B. Oatmeal Stout', '16C. Tropical Stout', '16D. Foreign Extra Stout']],
  ['17. Strong British Ale', ['17A. British Strong Ale', '17B. Old Ale', '17C. Wee Heavy', '17D. English Barley Wine']],
  ['18. Pale American Ale', ['18A. Blonde Ale', '18B. American Pale Ale']],
  ['19. Amber and Brown American Beer', ['19A. American Amber Ale', '19B. California Common', '19C. American Brown Ale']],
  ['20. American Porter and Stout', ['20A. American Porter', '20B. American Stout', '20C. Imperial Stout']],
  ['21. IPA', ['21A. American IPA', '21B. Specialty IPA: Belgian IPA', '21B. Specialty IPA: Black IPA', '21B. Specialty IPA: Brown IPA', '21B. Specialty IPA: Red IPA', '21B. Specialty IPA: Rye IPA', '21B. Specialty IPA: White IPA', '21C. Hazy IPA']],
  ['22. Strong American Ale', ['22A. Double IPA', '22B. American Strong Ale', '22C. American Barleywine', '22D. Wheatwine']],
  ['23. European Sour Ale', ['23A. Berliner Weisse', '23B. Flanders Red Ale', '23C. Oud Bruin', '23D. Lambic', '23E. Gueuze', '23F. Fruit Lambic', '23G. Gose']],
  ['24. Belgian Ale', ['24A. Witbier', '24B. Belgian Pale Ale', '24C. Bière de Garde']],
  ['25. Strong Belgian Ale', ['25A. Belgian Blond Ale', '25B. Saison', '25C. Belgian Golden Strong Ale']],
  ['26. Monastic Ale', ['26A. Belgian Single', '26B. Belgian Dubbel', '26C. Belgian Tripel', '26D. Belgian Dark Strong Ale']],
  ['27. Historical Beer', ['27A. Historical Beer: Gruit', '27A. Historical Beer: Kentucky Common', '27A. Historical Beer: Lichtenhainer', '27A. Historical Beer: London Brown Ale', '27A. Historical Beer: Piwo Grodziskie', '27A. Historical Beer: Pre-Prohibition Lager', '27A. Historical Beer: Roggenbier', '27A. Historical Beer: Sahti']],
  ['28. American Wild Ale', ['28A. Brett Beer', '28B. Mixed-Fermentation Sour Beer', '28C. Wild Specialty Beer', '28D. Straight Sour Beer']],
  ['29. Fruit Beer', ['29A. Fruit Beer', '29B. Fruit and Spice Beer', '29C. Specialty Fruit Beer', '29D. Grape Ale']],
  ['30. Spiced Beer', ['30A. Spice, Herb, or Vegetable Beer', '30B. Autumn Seasonal Beer', '30C. Winter Seasonal Beer', '30D. Specialty Spice Beer']],
  ['31. Alternative Fermentables Beer', ['31A. Alternative Grain Beer', '31B. Alternative Sugar Beer']],
  ['32. Smoked Beer', ['32A. Classic Style Smoked Beer', '32B. Specialty Smoked Beer']],
  ['33. Wood Beer', ['33A. Wood-Aged Beer', '33B. Specialty Wood-Aged Beer']],
  ['34. Specialty Beer', ['34A. Commercial Specialty Beer', '34B. Mixed-Style Beer', '34C. Experimental Beer']],
  ['X. Local and Modern Styles', ['Catharina Sour', 'Italian Grape Ale', 'New Zealand Pilsner', 'West Coast IPA', 'New England IPA', 'Pastry Sour', 'Smoothie Sour', 'Cold IPA', 'Brut IPA']],
];

/**
 * The families this brewery actually brews, each with the substyles worth
 * telling apart — what the editor's "Style category" dropdown holds out of the
 * box, so picking a style isn't 34 BJCP groups deep on the first click. The
 * brewer can add any of those groups to the dropdown and drop families they
 * never use; see `recipeStyleCategories` in settings.ts.
 *
 * Unlike a BJCP group heading, a family here is a usable style in its own right
 * — a Brown Ale or a Weissbeer is saved under the family alone, which is why
 * two of them carry no substyles. Values are stored on the recipe verbatim, so
 * they read as style names rather than codes; styleRanges.ts knows where each
 * one's vital statistics live.
 */
const BREWERY_STYLE_GROUPS: Array<[string, string[]]> = [
  ['IPA', ['New England IPA', 'Imperial IPA', 'Double IPA']],
  ['Stout', ['Imperial Stout', 'Oatmeal Stout']],
  ['Brown Ale', []],
  ['Weissbeer', []],
  ['Sour', ['Berliner Weisse', 'Gose']],
  ['Pilsner', ['Italian Pilsner', 'German Pilsner (Pils)']],
];

/** What the dropdown starts with, and what "Reset" puts back. */
export const DEFAULT_STYLE_CATEGORIES = BREWERY_STYLE_GROUPS.map(([category]) => category);

const FAMILIES = new Set(DEFAULT_STYLE_CATEGORIES);
const SUBSTYLES = new Map<string, string[]>([...BREWERY_STYLE_GROUPS, ...STYLE_GROUPS]);

/**
 * Every category the brewer can put in the dropdown: the families first, then
 * the full BJCP taxonomy for the batch that falls outside them.
 */
export const ALL_STYLE_CATEGORIES = [...SUBSTYLES.keys()];

/** A category's substyles — empty both for one that has none and one we don't know. */
export function substylesFor(category: string): string[] {
  return SUBSTYLES.get(category) ?? [];
}

/**
 * Every substyle the app knows, once each, with the categories it sits under —
 * a New England IPA is both a member of the brewery's IPA family and a BJCP
 * local style. Keyed by name because that is what a recipe stores: hiding
 * "New England IPA" hides the beer, not one taxonomy's copy of it.
 */
export const ALL_SUBSTYLES: Array<{ value: string; categories: string[] }> = (() => {
  const owners = new Map<string, string[]>();
  for (const [category, styles] of SUBSTYLES) {
    for (const value of styles) {
      const existing = owners.get(value);
      if (existing) existing.push(category);
      else owners.set(value, [category]);
    }
  }
  return [...owners].map(([value, categories]) => ({ value, categories }));
})();

/** Whether we know the category, so an empty substyle list means "has none". */
export function isKnownStyleCategory(category: string): boolean {
  return SUBSTYLES.has(category);
}

/**
 * Whether the category names a beer on its own. A family does — "Brown Ale" is
 * a style — so a recipe can be saved under it directly. A BJCP group heading
 * only collects styles ("13. Brown British Beer" is not something you brew) and
 * leaves the recipe's style to the substyle field.
 */
export function categoryIsStyle(category: string): boolean {
  return FAMILIES.has(category);
}

export const BATCH_TARGETS = ['Fermenter', 'Kettle', 'Packaging'];
export const WEIGHT_UNITS = ['kg', 'g', 'lb', 'oz'];
export const VOLUME_UNITS = ['L', 'ml', 'gal', 'fl oz'];
export const COUNT_UNITS = ['pkg', 'each', 'vial'];
export const HOP_FORMS = ['Pellet', 'Leaf / Whole', 'Plug', 'Extract'];
export const OTHER_TYPES = ['Flavor', 'Spice', 'Fining', 'Water Agent', 'Herb', 'Other'];
export const OTHER_USES = ['Mash', 'Boil', 'Flameout', 'Primary', 'Secondary', 'Packaging'];
export const YEAST_TYPES = ['Ale', 'Lager', 'Wheat', 'Sour', 'Brett', 'Bacteria', 'Wine', 'Other'];
export const YEAST_FORMS = ['Dry', 'Liquid', 'Slant', 'Culture', 'Other'];
export const FLOCCULATION_OPTIONS = ['Low', 'Medium-Low', 'Medium', 'Medium-High', 'High'];
export const MASH_TYPES = ['Strike', 'Infusion', 'Temperature', 'Decoction', 'Mash Out', 'Sparge', 'Other'];
export const PITCH_RATES = ['Manufacturer recommended', '0.35 million cells/ml/°P (Ale)', '0.75 million cells/ml/°P (Ale)', '1.0 million cells/ml/°P (Hybrid)', '1.5 million cells/ml/°P (Lager)', 'Custom'];
export const WATER_SOURCES = ['Tap water', 'Reverse osmosis', 'Distilled water', 'Bottled water'];
