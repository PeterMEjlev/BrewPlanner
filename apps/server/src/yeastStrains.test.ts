import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { yeastSpecFor, yeastStrainSpec } from './yeastStrains.js';

test('a strain is recognised however the listing spells it', () => {
  // The shop's own wording, complete with pack size and Danish.
  const shop = yeastStrainSpec('Fermentis SafAle US-05, 11,5 g. tørgær');
  assert.equal(shop?.lab, 'Fermentis');
  assert.equal(shop?.attenuation, '81');
  assert.equal(shop?.form, 'Dry');
  // Brewer's Friend names the same yeast for the style, code in brackets.
  assert.deepEqual(yeastStrainSpec('Safale American Ale (US-05)'), shop);
  // Codes survive their own punctuation: S-04, W-34/70, K.1.
  assert.equal(yeastStrainSpec('Fermentis SafLager W-34/70')?.attenuation, '83');
  assert.equal(yeastStrainSpec('Kveik Yeastery - K.1 Voss Kveik Gær, 7 g.')?.lab, 'Kveik Yeastery');
  assert.equal(yeastStrainSpec('A yeast nobody catalogued'), null);
});

test('a product code beats a strain name another lab also uses', () => {
  // Three labs sell a Voss kveik and two of them say so in the name; the code
  // is what says whose sachet this is.
  assert.equal(yeastStrainSpec("Mangrove Jack's M12 Kveik (Voss), 10 g.")?.lab, "Mangrove Jack's");
  assert.equal(yeastStrainSpec('Lallemand Voss Kveik Ale Gær, 11 g.')?.lab, 'Lallemand');
  // "East Coast Ale" is both White Labs' WLP008 and how Lallemand describes
  // New England, so the code has to win.
  assert.equal(yeastStrainSpec('White Labs WLP008 East Coast Ale')?.lab, 'White Labs');
});

test('what a recipe already says about a pitch wins over the table', () => {
  const saved = {
    lab: 'Fermentis',
    type: 'Ale',
    form: 'Dry',
    attenuation: '78',
    flocculation: '',
    minTempC: null,
    maxTempC: null,
    alcoholTolerance: '',
  };
  const merged = yeastSpecFor('SafAle US-05', saved);
  // The brewer's own attenuation stands; the blanks are filled from the table.
  assert.equal(merged?.attenuation, '78');
  assert.equal(merged?.flocculation, 'Medium');
  assert.equal(merged?.minTempC, 15);
  assert.equal(merged?.maxTempC, 22);
  // A line with nothing on it and a name nobody knows offers nothing to fill in.
  assert.equal(yeastSpecFor('House culture', { ...saved, lab: '', type: '', form: '', attenuation: '' }), null);
});

test('every yeast the shop stocks is described', () => {
  const catalogue = JSON.parse(
    readFileSync(new URL('../../../prices/humlecentralen_yeasts.json', import.meta.url), 'utf8'),
  ) as { products: Array<{ manufacturer?: string; name: string; category?: string }> };
  const strains = catalogue.products.filter((product) => product.category === 'yeast');
  assert.ok(strains.length > 50, 'the yeast catalogue should not have shrunk to nothing');
  // Nothing on the shelf may go undescribed: an unknown strain is the one row
  // in the picker with no badge and no figures under its name.
  const unknown = strains
    .map((product) => [product.manufacturer, product.name].filter(Boolean).join(' '))
    .filter((label) => yeastStrainSpec(label) == null);
  assert.deepEqual(unknown, []);
});

test('every described strain says what kind of fermentation it is', () => {
  // The picker colours a chip off this, so a strain typed as something it has
  // no badge for would list unlabelled next to everything else.
  const badged = new Set(['Ale', 'Lager', 'Wheat', 'Sour', 'Brett', 'Bacteria', 'Wine']);
  const catalogue = JSON.parse(
    readFileSync(new URL('../../../prices/humlecentralen_yeasts.json', import.meta.url), 'utf8'),
  ) as { products: Array<{ manufacturer?: string; name: string; category?: string }> };
  const untyped = catalogue.products
    .filter((product) => product.category === 'yeast')
    .map((product) => [product.manufacturer, product.name].filter(Boolean).join(' '))
    .filter((label) => !badged.has(yeastStrainSpec(label)?.type ?? ''));
  assert.deepEqual(untyped, []);
});
