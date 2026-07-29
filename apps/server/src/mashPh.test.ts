import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  alkalinityCaCO3FromBicarbonate,
  gristDistilledMashPh,
  mashBufferCapacity,
  mashWaterVolumeL,
  predictedMashPh,
  requiredResidualAlkalinity,
  residualAlkalinityCaCO3,
} from '@checklist/shared';
import type { GristLine } from '@checklist/shared';

/**
 * The mash-pH model is shared by the recipe sheet and the water calculator, and
 * it feeds a number brewers dose acid against. These pin the parts that are easy
 * to break silently: the unit convention on residual alkalinity, the two levers
 * that actually move mash pH (malt colour and acidulated malt), and the split
 * between mash and sparge water that sets the acid volume.
 */

/** The brewery's own tap water, the profile most likely to expose a unit slip. */
const TAP = { hco3: 340, ca: 110, mg: 23 };

const PALE: GristLine[] = [{ name: 'Pale Ale Malt', weightKg: 5, ebc: 6 }];

test('residual alkalinity uses the ppm-as-CaCO3 divisors, not the mEq ones', () => {
  const ra = residualAlkalinityCaCO3(alkalinityCaCO3FromBicarbonate(TAP.hco3), TAP.ca, TAP.mg);
  // 340 ppm HCO3 is 278.7 ppm as CaCO3; calcium and magnesium take off 92.1.
  assert.ok(Math.abs(ra - 186.6) < 0.1, `expected ~186.6, got ${ra}`);

  // Kolbach's 3.5/7 pair belongs to milliequivalents. Applied to ppm it
  // under-counts both ions and reads this water 57 ppm more alkaline than it is,
  // which is roughly 0.08 pH of error in the wrong direction.
  const mEqCoefficients = alkalinityCaCO3FromBicarbonate(TAP.hco3) - TAP.ca / 3.5 - TAP.mg / 7;
  assert.ok(mEqCoefficients - ra > 50, 'the two conventions should be far apart');
});

test('a grist with no colour anywhere has no pH to estimate', () => {
  assert.equal(gristDistilledMashPh([{ name: 'Table Sugar', weightKg: 1, ebc: null }]), null);
  assert.equal(gristDistilledMashPh([]), null);
});

test('darker grists reach a lower pH in distilled water', () => {
  const stout: GristLine[] = [
    { name: 'Pale Ale Malt', weightKg: 4, ebc: 6 },
    { name: 'Roasted Barley', weightKg: 0.5, ebc: 1200 },
    { name: 'Flaked Barley', weightKg: 0.5, ebc: 4 },
  ];
  const pale = gristDistilledMashPh(PALE)!;
  assert.ok(pale > gristDistilledMashPh(stout)!, 'roast should acidify the mash');
  assert.ok(pale > 5.5 && pale < 5.75, `pale malt should land near 5.7, got ${pale}`);
});

test('acidulated malt drops pH by 0.1 per percent of the bill', () => {
  const plain = gristDistilledMashPh([{ name: 'Pilsner', weightKg: 5, ebc: 3.5 }])!;
  const withAcid = gristDistilledMashPh([
    { name: 'Pilsner', weightKg: 4.9, ebc: 3.5 },
    { name: 'Acidulated Malt', weightKg: 0.1, ebc: 3.5 },
  ])!;
  // 2 % of the bill, so 0.2 pH — colour is near-identical, so the drop is the
  // acid malt alone rather than anything the colour curve did.
  assert.ok(Math.abs(plain - withAcid - 0.2) < 0.01, `expected ~0.2, got ${plain - withAcid}`);
});

test('German and English spellings of acid malt both count', () => {
  const bill = (name: string): number => gristDistilledMashPh([
    { name: 'Pilsner', weightKg: 4.9, ebc: 3.5 },
    { name, weightKg: 0.1, ebc: 3.5 },
  ])!;
  const plain = bill('Carapils');
  for (const name of ['Acidulated Malt', 'Sauermalz', 'Sauer Malz', 'Sour Malt']) {
    assert.ok(plain - bill(name) > 0.15, `${name} should register as acid malt`);
  }
});

test('sugar dilutes the malt rather than dropping out of the bill', () => {
  const withSugar = gristDistilledMashPh([
    { name: 'Pale Ale Malt', weightKg: 5, ebc: 6 },
    { name: 'Table Sugar', weightKg: 5, ebc: null },
  ])!;
  // Half the bill now has no colour, so the weighted figure falls and the
  // predicted pH rises back toward the 5.7 anchor.
  assert.ok(withSugar > gristDistilledMashPh(PALE)!, 'uncoloured weight should count');
});

test('a thinner mash buffers less, so the same water swings it further', () => {
  const thick = mashBufferCapacity(2);
  const thin = mashBufferCapacity(5);
  assert.ok(thick > thin, 'thicker mash should resist more');
  assert.ok(Math.abs(mashBufferCapacity(3) - 15) < 0.01, 'the book\'s typical value');
  // Outside the measured 2–5 L/kg range the anchors clamp rather than extrapolate.
  assert.equal(mashBufferCapacity(0.5), thick);
  assert.equal(mashBufferCapacity(12), thin);
});

test('alkaline water raises mash pH, calcium pulls it back', () => {
  const distilled = gristDistilledMashPh(PALE)!;
  const buffer = mashBufferCapacity(3);
  const onTap = predictedMashPh(
    distilled,
    residualAlkalinityCaCO3(alkalinityCaCO3FromBicarbonate(TAP.hco3), TAP.ca, TAP.mg),
    buffer,
  );
  const onRO = predictedMashPh(distilled, residualAlkalinityCaCO3(0, 75, 0), buffer);
  assert.ok(onTap > distilled, 'bicarbonate should push pH up');
  assert.ok(onRO < distilled, 'calcium alone should push pH down');
});

test('a pale grist always needs acid, never bicarbonate', () => {
  // The reason no style preset carries a bicarbonate target: starting above the
  // target pH puts the required residual alkalinity below zero, and no plausible
  // calcium level lifts it back.
  const distilled = gristDistilledMashPh(PALE)!;
  const required = requiredResidualAlkalinity(distilled, 5.4, mashBufferCapacity(3));
  assert.ok(required < 0, `expected a negative requirement, got ${required}`);
});

test('strike water is the grain bill times thickness, capped at what is being brewed', () => {
  assert.equal(mashWaterVolumeL(6, 3, 30), 18);
  // A mash cannot hold more water than the whole brew.
  assert.equal(mashWaterVolumeL(20, 3, 30), 30);
  assert.equal(mashWaterVolumeL(0, 3, 30), 0);
});
