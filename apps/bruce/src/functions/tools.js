'use strict';

// ── Register tool/utility functions on Bruce ────────────────────────────────

function register(bruce) {
  // ── Reminders ──────────────────────────────────────────────────────────

  const reminders = new Map();
  let reminderId = 0;

  bruce.registerFunction(
    'set_reminder',
    'Set a timed reminder. Bruce will speak the reminder after the specified delay. For example "remind me to add hops in 10 minutes" or "remind me to check the mash in 1 hour and 30 minutes".',
    {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What to remind the user about' },
        hours: { type: 'number', description: 'Hours from now (default 0)' },
        minutes: { type: 'number', description: 'Minutes from now (default 0)' },
        seconds: { type: 'number', description: 'Seconds from now (default 0)' },
      },
      required: ['message'],
    },
    async ({ message, hours = 0, minutes = 0, seconds = 0 }) => {
      const totalMs = Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
      if (totalMs <= 0) return 'Please specify a time in the future for the reminder.';

      const id = ++reminderId;
      const timer = setTimeout(() => {
        reminders.delete(id);
        console.log(`[Bruce] Reminder fired: ${message}`);
        bruce.speak(`[SYSTEM] A scheduled reminder has fired. You MUST say the following reminder out loud to the user, word for word. Do not say anything else, no greetings, no follow-ups. Just deliver the reminder: "${message}"`);
      }, totalMs);
      reminders.set(id, { message, timer });

      const parts = [];
      if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
      if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`);
      if (seconds > 0) parts.push(`${seconds} second${seconds !== 1 ? 's' : ''}`);
      return `Reminder set: "${message}" in ${parts.join(' and ')}.`;
    }
  );

  // ── Dilution calculator ────────────────────────────────────────────────

  bruce.registerFunction(
    'dilution_calculator',
    'Calculate how much water to add to wort to reach a target gravity. Requires the current wort volume in litres, the current gravity (OG), and the desired gravity (DG). Gravity can be given as e.g. 1.050 or just 1050. The desired gravity must be lower than the current gravity.',
    {
      type: 'object',
      properties: {
        volume: { type: 'number', description: 'Current wort volume in litres' },
        current_gravity: { type: 'number', description: 'Current/original gravity, e.g. 1.050 or 1050' },
        desired_gravity: { type: 'number', description: 'Target gravity after dilution, e.g. 1.040 or 1040' },
      },
      required: ['volume', 'current_gravity', 'desired_gravity'],
    },
    async ({ volume, current_gravity, desired_gravity }) => {
      let og = current_gravity > 1.2 ? current_gravity / 1000 : current_gravity;
      let dg = desired_gravity > 1.2 ? desired_gravity / 1000 : desired_gravity;

      if (volume <= 0) return 'Volume must be greater than zero.';
      if (og <= 1) return 'Current gravity must be greater than 1.000.';
      if (dg <= 1) return 'Desired gravity must be greater than 1.000.';
      if (dg >= og) return 'Desired gravity must be lower than the current gravity.';

      const newVolume = (volume * (og - 1)) / (dg - 1);
      const waterToAdd = newVolume - volume;

      return `You need to add ${waterToAdd.toFixed(1)} litres of water. That brings the total volume to ${newVolume.toFixed(1)} litres and the gravity from ${og.toFixed(3)} down to ${dg.toFixed(3)}.`;
    }
  );

  // ── Hydrometer temperature adjustment ──────────────────────────────────

  bruce.registerFunction(
    'hydrometer_correction',
    'Correct a hydrometer specific-gravity reading for the difference between the sample temperature and the hydrometer\'s calibration temperature. Gravity can be given as e.g. 1.050 or 1050. Calibration temperature defaults to 20°C if not provided.',
    {
      type: 'object',
      properties: {
        reading: { type: 'number', description: 'Hydrometer reading (specific gravity), e.g. 1.050 or 1050' },
        sample_temp: { type: 'number', description: 'Temperature of the sample in °C' },
        calibration_temp: { type: 'number', description: 'Calibration temperature of the hydrometer in °C (default 20)' },
      },
      required: ['reading', 'sample_temp'],
    },
    async ({ reading, sample_temp, calibration_temp = 20 }) => {
      const sg = reading > 1.2 ? reading / 1000 : reading;
      if (sg <= 0) return 'Hydrometer reading must be greater than zero.';

      const toF = (c) => c * 9 / 5 + 32;
      const adj = (tF) =>
        (1.313454 - 0.132674 * tF + 0.002057793 * tF * tF - 0.000002627634 * tF * tF * tF) * 0.001;

      const corrected = sg + adj(toF(sample_temp)) - adj(toF(calibration_temp));

      return `The corrected gravity is ${corrected.toFixed(3)} (read ${sg.toFixed(3)} at ${sample_temp}°C, calibrated for ${calibration_temp}°C).`;
    }
  );

  // ── Carbonation calculator ─────────────────────────────────────────────

  const CARBONATION_STYLES = {
    'British Style Ales':      '1.5 – 2.0',
    'Belgian Ales':            '1.9 – 2.4',
    'American Ales and Lager': '2.2 – 2.7',
    'Porter, Stout':           '1.7 – 2.3',
    'European Lagers':         '2.2 – 2.7',
    'Fruit Lambic':            '3.0 – 4.5',
    'Lambic':                  '2.4 – 2.8',
    'German Wheat Beer':       '3.3 – 4.5',
  };

  // Map common beer style names/abbreviations to CARBONATION_STYLES keys
  const STYLE_ALIASES = {
    'ipa':            'American Ales and Lager',
    'pale ale':       'American Ales and Lager',
    'american pale ale': 'American Ales and Lager',
    'apa':            'American Ales and Lager',
    'american ipa':   'American Ales and Lager',
    'neipa':          'American Ales and Lager',
    'hazy ipa':       'American Ales and Lager',
    'west coast ipa': 'American Ales and Lager',
    'amber ale':      'American Ales and Lager',
    'american lager': 'American Ales and Lager',
    'cream ale':      'American Ales and Lager',
    'blonde ale':     'American Ales and Lager',
    'bitter':         'British Style Ales',
    'esb':            'British Style Ales',
    'english ale':    'British Style Ales',
    'mild':           'British Style Ales',
    'brown ale':      'British Style Ales',
    'english ipa':    'British Style Ales',
    'scottish ale':   'British Style Ales',
    'tripel':         'Belgian Ales',
    'dubbel':         'Belgian Ales',
    'saison':         'Belgian Ales',
    'witbier':        'Belgian Ales',
    'belgian strong': 'Belgian Ales',
    'trappist':       'Belgian Ales',
    'porter':         'Porter, Stout',
    'stout':          'Porter, Stout',
    'imperial stout': 'Porter, Stout',
    'dry stout':      'Porter, Stout',
    'milk stout':     'Porter, Stout',
    'oatmeal stout':  'Porter, Stout',
    'pilsner':        'European Lagers',
    'pilsener':       'European Lagers',
    'pils':           'European Lagers',
    'helles':         'European Lagers',
    'marzen':         'European Lagers',
    'märzen':         'European Lagers',
    'oktoberfest':    'European Lagers',
    'bock':           'European Lagers',
    'doppelbock':     'European Lagers',
    'dunkel':         'European Lagers',
    'vienna lager':   'European Lagers',
    'schwarzbier':    'European Lagers',
    'kolsch':         'European Lagers',
    'kölsch':         'European Lagers',
    'hefeweizen':     'German Wheat Beer',
    'weizen':         'German Wheat Beer',
    'wheat beer':     'German Wheat Beer',
    'weissbier':      'German Wheat Beer',
    'dunkelweizen':   'German Wheat Beer',
    'kristallweizen': 'German Wheat Beer',
    'fruit lambic':   'Fruit Lambic',
    'kriek':          'Fruit Lambic',
    'framboise':      'Fruit Lambic',
    'gueuze':         'Lambic',
    'geuze':          'Lambic',
  };

  bruce.registerFunction(
    'carbonation_calculator',
    'Calculate the CO2 regulator pressure needed to force-carbonate a keg at a given temperature. Provide the desired volumes of CO2 and the keg temperature in °C. If the user mentions a beer style instead of an exact CO2 volume, call this function with ONLY the beer_style parameter (and optionally keg_temp) — do NOT guess a CO2 volume. The function will return the recommended range so you can ask the user to pick a value. IMPORTANT: Once the user picks a CO2 volume, you MUST call this function again with co2_volumes and keg_temp to get the exact pressure — do NOT calculate the pressure yourself.',
    {
      type: 'object',
      properties: {
        co2_volumes: { type: 'number', description: 'Desired volumes of CO2 (e.g. 2.4)' },
        keg_temp: { type: 'number', description: 'Keg temperature in °C' },
        beer_style: { type: 'string', description: 'Beer style name if the user specified a style instead of an exact CO2 volume (e.g. "IPA", "stout", "Belgian", "wheat beer", "lager")' },
      },
      required: [],
    },
    async ({ co2_volumes, keg_temp, beer_style } = {}) => {
      // If a beer style was given, look up the range and ask for clarification
      if (beer_style && co2_volumes == null) {
        const styleLower = beer_style.toLowerCase().trim();

        // Check alias map first, then try direct substring matching
        const aliasKey = STYLE_ALIASES[styleLower];
        const match = aliasKey
          ? [aliasKey, CARBONATION_STYLES[aliasKey]]
          : Object.entries(CARBONATION_STYLES).find(([key]) =>
              key.toLowerCase().includes(styleLower) || styleLower.includes(key.toLowerCase())
            ) || null;

        if (match) {
          const [name, range] = match;
          return `${name} is typically carbonated at ${range} volumes of CO2. Ask the user what CO2 volume they'd like within that range, then call this function again with co2_volumes and keg_temp to get the exact pressure.`;
        }

        // No match — list all styles
        const list = Object.entries(CARBONATION_STYLES)
          .map(([name, range]) => `${name}: ${range} vol`)
          .join('. ');
        return `I'm not sure which style "${beer_style}" matches. Here are the common guidelines: ${list}. Ask the user what CO2 volume they'd like, then call this function again with co2_volumes and keg_temp to get the exact pressure.`;
      }

      if (co2_volumes == null || keg_temp == null) {
        return 'I need both the desired volumes of CO2 and the keg temperature to calculate the pressure.';
      }

      if (co2_volumes <= 0) return 'Volumes of CO2 must be greater than zero.';

      // Formula uses °F internally
      const T = keg_temp * 9 / 5 + 32;
      const V = co2_volumes;
      const psi =
        -16.6999
        - 0.0101059 * T
        + 0.00116512 * T * T
        + 0.173354 * T * V
        + 4.24267 * V
        - 0.0684226 * V * V;

      const bar = psi * 0.0689476;

      return `[SYSTEM] You MUST speak the following result to the user: To carbonate at ${co2_volumes} volumes of CO2 with a keg at ${keg_temp}°C, set your regulator to ${bar.toFixed(2)} bar (${psi.toFixed(1)} PSI).`;
    }
  );
}

module.exports = { register };
