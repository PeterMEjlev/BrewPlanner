import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recipeEditSchema, withLeadingZero } from '@checklist/shared';

/**
 * A figure written without its leading zero is a normal way to write a
 * fraction, not a typo — the arithmetic has always read ".8" as eight tenths.
 * The rule here is only about how the sheet then reads back.
 */

test('a bare decimal gets its zero, with the separator that was typed', () => {
  assert.equal(withLeadingZero('.8'), '0.8');
  assert.equal(withLeadingZero('.85'), '0.85');
  assert.equal(withLeadingZero('.05'), '0.05');
  // "," is a decimal point throughout this codebase; writing Danish decimals
  // is not a mistake to correct, so only the zero is supplied.
  assert.equal(withLeadingZero(',8'), '0,8');
  assert.equal(withLeadingZero('-.25'), '-0.25');
  assert.equal(withLeadingZero('+.5'), '+0.5');
  assert.equal(withLeadingZero('-,25'), '-0,25');
});

test('anything that is not a bare decimal is left exactly as written', () => {
  for (const untouched of [
    '0.8', '8', '1.5', '', '   ', '.', '..8', '.8.8', '8.', '.8kg', 'a.8',
    // A half-typed range and a note both contain a leading-dot number without
    // being one; the anchors are what keep them out of it.
    '18 – .8', 'Mash out .8 bar', 'Medium-High',
  ]) {
    assert.equal(withLeadingZero(untouched), untouched, `should not touch ${JSON.stringify(untouched)}`);
  }
});

test('it is idempotent', () => {
  for (const value of ['.8', '0.8', ',8', '-.25', 'anything']) {
    assert.equal(withLeadingZero(withLeadingZero(value)), withLeadingZero(value));
  }
});

/** The smallest sheet the edit schema will accept, for exercising one field. */
function sheet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Test',
    style: '',
    settings: {},
    og: '',
    preBoilGravity: null,
    postBoilGravity: null,
    fg: '',
    abv: '',
    ibu: '',
    ebc: '',
    ebcEstimated: false,
    batchSizeL: 55,
    mashTemp: null,
    fermentationTemp: null,
    fermentables: [],
    hops: [],
    yeast: [],
    otherIngredients: [],
    mashGuidelines: null,
    waterProfile: null,
    ...overrides,
  };
}

test('saving a recipe writes the zero in, whichever field it was typed into', () => {
  const parsed = recipeEditSchema.parse(sheet({
    og: '.8',
    fermentables: [{ name: 'Pilsner', amount: '.8', unit: 'kg', percent: '.5', ebc: 3 }],
    hops: [{
      name: 'Citra', amount: '.5', unit: 'g', use: 'Boil', stage: 'Boil',
      time: '.5', timeUnit: 'min', aa: '.8', ibu: '', temp: '',
    }],
    yeast: [{
      name: 'US-05', lab: '', attenuation: '.81', amount: '.5', amountUnit: 'each',
      type: 'Ale', form: 'Dry', flocculation: '', minTempC: null, maxTempC: null,
      // Free text, and deliberately not an amount field: "Medium-High" is a
      // perfectly good answer here, so nothing may reformat it.
      alcoholTolerance: '.8', starter: false,
    }],
    waterProfile: {
      name: null, ph: null, notes: null,
      calcium: '.4', magnesium: null, sodium: null, chloride: null, sulfate: null, bicarbonate: null,
    },
  }));

  assert.equal(parsed.og, '0.8');
  assert.equal(parsed.fermentables[0]?.amount, '0.8');
  assert.equal(parsed.fermentables[0]?.percent, '0.5');
  assert.equal(parsed.hops[0]?.amount, '0.5');
  assert.equal(parsed.hops[0]?.aa, '0.8');
  assert.equal(parsed.hops[0]?.time, '0.5');
  assert.equal(parsed.yeast[0]?.attenuation, '0.81');
  assert.equal(parsed.yeast[0]?.amount, '0.5');
  assert.equal(parsed.waterProfile?.calcium, '0.4');
  assert.equal(parsed.yeast[0]?.alcoholTolerance, '.8');
});

test('the mash section is figures too, temperatures and strike volume included', () => {
  const parsed = recipeEditSchema.parse(sheet({
    mashTemp: '.66',
    fermentationTemp: '.18',
    mashGuidelines: {
      steps: [{
        name: 'Sacch', temp: '.66', time: '.60', amount: '.20',
        amountUnit: 'L', startTemp: '.72', type: 'Infusion', description: '',
      }],
      startingThicknessLPerKg: null, grainTempC: null, autoStrikeVolume: false, notes: null,
    },
  }));

  assert.equal(parsed.mashTemp, '0.66');
  assert.equal(parsed.fermentationTemp, '0.18');
  const step = parsed.mashGuidelines?.steps[0];
  assert.equal(step?.temp, '0.66');
  assert.equal(step?.time, '0.60');
  assert.equal(step?.amount, '0.20');
  assert.equal(step?.startTemp, '0.72');
});

test('a strike volume longer than 30 characters still loads', () => {
  // The mash step's amount has always allowed 100 characters; tightening it to
  // match the other figures would stop an already-saved recipe being read back.
  const long = 'x'.repeat(90);
  const parsed = recipeEditSchema.parse(sheet({
    mashGuidelines: {
      steps: [{ name: 'S', temp: null, time: '', amount: long, amountUnit: '', startTemp: null, type: '', description: '' }],
      startingThicknessLPerKg: null, grainTempC: null, autoStrikeVolume: false, notes: null,
    },
  }));
  assert.equal(parsed.mashGuidelines?.steps[0]?.amount, long);
});

test('a figure typed with a stray space still lands as a number', () => {
  const parsed = recipeEditSchema.parse(sheet({ og: '  .8  ' }));
  assert.equal(parsed.og, '0.8');
});

test('the zero does not change what a figure is worth', () => {
  for (const written of ['.8', ',8', '-.25']) {
    const before = Number(written.replace(',', '.'));
    const after = Number(withLeadingZero(written).replace(',', '.'));
    assert.equal(after, before, `${written} changed value`);
  }
});
