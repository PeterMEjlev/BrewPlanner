'use strict';

/**
 * Keg inventory, read from the BrewPlanner server (GET /api/kegs). The server
 * parses the shared Google Sheet CSV and caches it, so Bruce no longer fetches
 * or parses the sheet himself — every reader (web app, watch, Bruce) sees the
 * same data through the same code path.
 */

/** Contents values that mean "no beer in this keg". */
const EMPTY_CONTENTS = ['???', 'Clean', 'Dirty'];
const NON_BEER_CONTENTS = [...EMPTY_CONTENTS, 'Starsan'];

// Format keg numbers as a spoken list ("keg 1, keg 2, and keg 3")
function spokenList(kegs) {
  const nums = kegs.map((k) => `keg ${k.number}`);
  if (nums.length === 1) return nums[0];
  return nums.slice(0, -1).join(', ') + ', and ' + nums[nums.length - 1];
}

/** "keg"/"kegs" — TTS reads "1 kegs" out loud verbatim, so grammar matters. */
function kegNoun(n) {
  return n === 1 ? 'keg' : 'kegs';
}

function register(bruce, apiCall) {
  bruce.registerFunction(
    'get_keg_status',
    'Get the current status of all kegs — their contents, volume, date filled, notes, and ABV. Useful for checking what beer is on tap or how many kegs are filled. Set detail to "full" only if the user explicitly asks for every individual keg listed out.',
    {
      type: 'object',
      properties: {
        detail: { type: 'string', enum: ['summary', 'full'], description: 'Level of detail — "summary" groups kegs by type (default), "full" lists every keg individually' },
      },
      required: [],
    },
    async (args) => {
      const detail = (args && args.detail) || 'summary';
      const kegs = await apiCall('GET', '/api/kegs');

      const empty = kegs.filter((k) => EMPTY_CONTENTS.includes(k.contents.trim()));
      const beerKegs = kegs.filter((k) => !NON_BEER_CONTENTS.includes(k.contents.trim()));

      if (detail === 'full') {
        const filled = kegs.filter((k) => k.contents.trim() !== '???');
        const lines = [
          `${filled.length} of ${kegs.length} kegs ${filled.length === 1 ? 'is' : 'are'} filled.`,
        ];
        for (const keg of kegs) {
          let desc = `Keg ${keg.number} contains ${keg.contents}`;
          if (keg.volume) desc += `, volume ${keg.volume}`;
          if (keg.abv) desc += `, ${keg.abv} ABV`;
          if (keg.date) desc += `, filled on ${keg.date}`;
          if (keg.note) desc += `. Note: ${keg.note}`;
          lines.push(desc + '.');
        }
        return lines.join('\n');
      }

      const groups = {};
      for (const keg of beerKegs) {
        const key = keg.contents.trim();
        if (!groups[key]) groups[key] = [];
        groups[key].push(keg);
      }

      const lines = [
        `You have ${beerKegs.length} ${kegNoun(beerKegs.length)} with beer out of ${kegs.length} total.`,
      ];

      for (const [type, typeKegs] of Object.entries(groups)) {
        const abvs = typeKegs.map((k) => k.abv).filter(Boolean);
        const abvStr = abvs.length ? ` at ${abvs[0]} ABV` : '';
        lines.push(`${typeKegs.length} ${kegNoun(typeKegs.length)} of ${type}${abvStr}: ${spokenList(typeKegs)}.`);
      }

      if (empty.length > 0) {
        lines.push(`${empty.length} ${kegNoun(empty.length)} ${empty.length === 1 ? 'is' : 'are'} empty or unassigned.`);
      }

      return lines.join('\n');
    }
  );

  // ── Keg updates ─────────────────────────────────────────────────────────
  //
  // The server's PUT /api/kegs/:number (Google Apps Script behind it) requires
  // contents/date/note/abv together, so unspecified fields are carried over
  // from the keg's current row — a voice edit of one field must not blank the
  // rest.

  bruce.registerFunction(
    'update_keg',
    'Update a keg in the inventory: what it contains, its ABV, a note, or the fill date. Contents conventions: a beer name/style when filled (e.g. "NEIPA", "Stout"); "Dirty" = just emptied, needs cleaning; "Clean" = cleaned and ready to fill; "???" = unknown. Examples: "keg 5 is empty" → contents Dirty; "keg 3 is clean now" → contents Clean; "keg 7 has the new NEIPA at 6.2%" → contents NEIPA, abv 6.2%. Only call this when the user clearly stated which keg and what changed.',
    {
      type: 'object',
      properties: {
        number: { type: 'string', description: 'The keg number, e.g. "5"' },
        contents: { type: 'string', description: 'New contents (beer name/style, or Dirty / Clean / ???)' },
        abv: { type: 'string', description: 'ABV text, e.g. "6.2%" (optional)' },
        note: { type: 'string', description: 'A short note (optional)' },
        date: { type: 'string', description: 'Fill date DD/MM/YYYY (optional — defaults to today when filling with beer)' },
      },
      required: ['number'],
    },
    async ({ number, contents, abv, note, date }) => {
      const kegs = await apiCall('GET', '/api/kegs');
      const keg = kegs.find((k) => k.number === String(number).trim());
      if (!keg) return `There is no keg number ${number} in the inventory.`;

      const newContents = contents?.trim() || keg.contents;
      const emptying = ['Dirty', 'Clean', '???'].some(
        (v) => v.toLowerCase() === newContents.toLowerCase()
      );
      const filling = contents && !emptying && !NON_BEER_CONTENTS.includes(newContents);

      // Emptying a keg clears the stale beer metadata (unless explicitly
      // provided); filling one stamps today's date unless a date was given.
      const today = new Date();
      const todayStr = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;
      const fields = {
        contents: newContents,
        date: date?.trim() ?? (emptying && contents ? '' : filling ? todayStr : keg.date),
        note: note?.trim() ?? (emptying && contents ? '' : keg.note),
        abv: abv?.trim() ?? (emptying && contents ? '' : keg.abv),
      };

      await apiCall('PUT', `/api/kegs/${encodeURIComponent(keg.number)}`, fields);

      const changes = [];
      if (contents) changes.push(`contents to ${fields.contents}`);
      if (abv) changes.push(`ABV to ${fields.abv}`);
      if (note) changes.push(`note to "${fields.note}"`);
      if (date) changes.push(`date to ${fields.date}`);
      if (filling && !date) changes.push(`fill date to today (${todayStr})`);
      return `Keg ${keg.number} updated: ${changes.length ? changes.join(', ') : 'no changes'}.`;
    }
  );
}

module.exports = { register };
