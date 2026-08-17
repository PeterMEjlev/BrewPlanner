import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEG_CONTENT_COLORS,
  holdsBeer,
  isDirtyContents,
  normalizeKegUpdate,
  parseKegDate,
  parseKegs,
} from './index.js';

/**
 * The keg sheet is a Google Sheet published as CSV, so this parser is fed
 * whatever a human typed into a spreadsheet — quoted commas in a tasting note,
 * blank trailing columns, an empty row left behind by a delete. None of that
 * throws; it just produces wrong kegs, which is exactly the kind of failure
 * worth pinning down.
 */

/** The two rows every export starts with: a banner, then the headers. */
const PREAMBLE = 'Keg inventory,,,,,,,\nid,Keg #,Contents,Date,Note,Volume,ABV,Recipe\n';

describe('parseKegs', () => {
  it('reads a row into a keg', () => {
    const kegs = parseKegs(`${PREAMBLE}1,3,Hazy IPA,04/07/2026,Dry hopped,19,6.2,rec-1\n`);
    expect(kegs).toHaveLength(1);
    expect(kegs[0]).toMatchObject({
      number: '3',
      contents: 'Hazy IPA',
      date: '04/07/2026',
      note: 'Dry hopped',
      volume: '19',
      abv: '6.2',
      recipeId: 'rec-1',
    });
  });

  it('skips the banner and header rows', () => {
    expect(parseKegs(PREAMBLE)).toEqual([]);
  });

  it('drops rows with no keg number', () => {
    const kegs = parseKegs(`${PREAMBLE}1,,Orphaned,04/07/2026,,19,5.0,\n2,7,Pils,,,19,4.8,\n`);
    expect(kegs.map((k) => k.number)).toEqual(['7']);
  });

  it('keeps commas inside quoted fields', () => {
    const kegs = parseKegs(`${PREAMBLE}1,4,Saison,04/07/2026,"Peppery, dry",19,5.5,\n`);
    expect(kegs[0]!.note).toBe('Peppery, dry');
    expect(kegs[0]!.volume).toBe('19');
  });

  it('fills missing trailing columns with empty strings', () => {
    const kegs = parseKegs(`${PREAMBLE}1,9,Stout\n`);
    expect(kegs[0]).toMatchObject({ number: '9', contents: 'Stout', date: '', abv: '', recipeId: '' });
  });

  it('trims surrounding whitespace', () => {
    const kegs = parseKegs(`${PREAMBLE}1, 5 , Lager , 04/07/2026 ,,19,4.6,\n`);
    expect(kegs[0]!.number).toBe('5');
    expect(kegs[0]!.contents).toBe('Lager');
  });

  it('assigns a colour from the shared palette', () => {
    const kegs = parseKegs(`${PREAMBLE}1,2,???,,,19,,\n`, DEFAULT_KEG_CONTENT_COLORS);
    expect(kegs[0]!.color).toBeTruthy();
  });

  it('survives an empty export', () => {
    expect(parseKegs('')).toEqual([]);
  });
});

describe('normalizeKegUpdate', () => {
  const full = {
    contents: 'Hazy IPA',
    date: '04/07/2026',
    note: 'Dry hopped',
    abv: '6.2',
    recipeId: 'rec-1',
  };

  it('clears the beer behind a keg marked dirty', () => {
    // The whole point: an emptied keg keeps nothing of what was in it, or the
    // board reads as though it were still full — and the fill date keeps
    // tripping the keg-age alert.
    expect(normalizeKegUpdate({ ...full, contents: 'Dirty', note: '' })).toEqual({
      contents: 'Dirty',
      date: '',
      note: '',
      abv: '',
      recipeId: '',
    });
  });

  it('keeps a note written on a dirty keg', () => {
    // A dirty keg's note is about the keg — "seal is weeping" is worth reading
    // at the wash. Only the *previous* beer's note goes, and dropping that is
    // the editor's job at the moment the keg turns dirty, not this one's.
    expect(normalizeKegUpdate({ ...full, contents: 'Dirty', note: 'Seal is weeping' })).toMatchObject(
      { contents: 'Dirty', note: 'Seal is weeping', date: '', abv: '', recipeId: '' },
    );
  });

  it('clears the recipe link even when the caller omitted it', () => {
    // Omitted means "leave the cell alone" to the sheet writer, so the blank has
    // to be sent explicitly or the dirty keg stays linked to its last recipe.
    const { recipeId: _omitted, ...withoutRecipe } = full;
    expect(normalizeKegUpdate({ ...withoutRecipe, contents: 'dirty' })).toHaveProperty(
      'recipeId',
      '',
    );
  });

  it('leaves any other content untouched', () => {
    expect(normalizeKegUpdate(full)).toEqual(full);
    expect(normalizeKegUpdate({ ...full, contents: 'Clean' })).toEqual({ ...full, contents: 'Clean' });
  });
});

describe('holdsBeer', () => {
  it('says no to every keg state, however it is cased', () => {
    // What the transfer picker offers as a target: a keg nobody can pour from.
    for (const state of ['???', 'Clean', 'Dirty', 'Starsan', 'clean', ' DIRTY ', '']) {
      expect(holdsBeer(state)).toBe(false);
    }
  });

  it('says yes to a beer, including one named after a state', () => {
    expect(holdsBeer('NEIPA')).toBe(true);
    expect(holdsBeer('Dirty Blonde')).toBe(true);
  });
});

describe('isDirtyContents', () => {
  it('matches however the sheet spells it', () => {
    expect(isDirtyContents('Dirty')).toBe(true);
    expect(isDirtyContents(' dirty ')).toBe(true);
  });

  it('does not match a beer that merely mentions it', () => {
    expect(isDirtyContents('Dirty Blonde')).toBe(false);
    expect(isDirtyContents('')).toBe(false);
  });
});

describe('parseKegDate', () => {
  it('reads the sheetDD/MM/YYYY format', () => {
    // 4 July, not 7 April — the sheet is day-first, and getting this backwards
    // would silently mis-age every keg by up to a year.
    const t = parseKegDate('04/07/2026');
    expect(new Date(t).getUTCMonth()).toBe(6);
    expect(new Date(t).getUTCDate()).toBe(4);
  });

  it('returns 0 for blank or unparseable input', () => {
    expect(parseKegDate('')).toBe(0);
    expect(parseKegDate('not a date')).toBe(0);
  });
});
