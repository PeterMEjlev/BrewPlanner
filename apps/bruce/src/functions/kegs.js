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
        const lines = [`${filled.length} of ${kegs.length} kegs are filled.`];
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

      const lines = [`You have ${beerKegs.length} kegs with beer out of ${kegs.length} total.`];

      for (const [type, typeKegs] of Object.entries(groups)) {
        const abvs = typeKegs.map((k) => k.abv).filter(Boolean);
        const abvStr = abvs.length ? ` at ${abvs[0]} ABV` : '';
        lines.push(`${typeKegs.length} kegs of ${type}${abvStr}: ${spokenList(typeKegs)}.`);
      }

      if (empty.length > 0) {
        lines.push(`${empty.length} kegs are empty or unassigned.`);
      }

      return lines.join('\n');
    }
  );
}

module.exports = { register };
