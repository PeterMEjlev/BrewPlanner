import { describe, expect, it } from 'vitest';
import { DEFAULT_KEG_CONTENT_COLORS, parseKegDate, parseKegs } from './index.js';

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
