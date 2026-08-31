// env first: this is a CLI, so a dev machine's DATABASE_PATH must be read
// before the database module resolves its file (see env.ts).
import '../env.js';
import { DEFAULT_RECIPE_SETTINGS } from '@checklist/shared';
import type { RecipeEditInput } from '@checklist/shared';
import { databasePath, runMigrations } from '../db/index.js';
import { createRecipe, listRecipeDetails } from '../recipeRepo.js';
import {
  deleteBrewSession,
  insertRigSample,
  listRecipeBrewSessions,
  recordStageMarkers,
  startBrewSession,
  updateBrewSession,
} from './repo.js';

/**
 * Seed one synthetic brew session so the logbook — and above all the rig's
 * temperature curve on the detail page — can be looked at on a dev machine with
 * no rig attached. The rig is powered off most of the year and is never
 * reachable from a laptop, so without this the one part of a brew session that
 * can't be typed in by hand is also the one part nobody can see while working
 * on it.
 *
 *   npm run seed:brew-session          (from apps/server, or via the workspace)
 *
 * Writes a demo recipe, a batch brewed from it three days ago, ~4h40m of pot
 * temperatures at the sampler's own 30-second cadence, and the stage marks the
 * rig would have stamped along the way. Idempotent: re-running replaces the
 * batch under the same demo recipe rather than adding a second one.
 *
 * Targets the same SQLite file the server uses (DATABASE_PATH, else
 * apps/server/data/checklist.sqlite). Everything it makes is named "Demo", and
 * deleting the brew session from the UI takes its samples and marks with it.
 */

const RECIPE_NAME = 'Demo Brew Day Pale Ale';

/** The sampler's own interval, so the mock has a real brew day's point count. */
const SAMPLE_INTERVAL_MS = 30_000;

/** How long ago the batch was brewed — recent enough to still be fermenting. */
const DAYS_AGO = 3;

/** Wall-clock hour the brew day starts, local time. */
const START_HOUR = 8;

function recipeInput(): RecipeEditInput {
  return {
    name: RECIPE_NAME,
    style: 'American Pale Ale',
    settings: {
      ...DEFAULT_RECIPE_SETTINGS,
      boilTimeMinutes: 60,
      efficiencyPercent: 72,
    },
    og: '1.052',
    preBoilGravity: '1.044',
    postBoilGravity: '1.052',
    fg: '1.011',
    abv: '5.4',
    ibu: '38',
    ebc: '14',
    ebcEstimated: false,
    batchSizeL: 20,
    mashTemp: '67°C',
    fermentationTemp: '19°C',
    fermentables: [
      {
        name: 'Pilsner Malt',
        amount: '4.2',
        unit: 'kg',
        percent: '84',
        ebc: 4,
        ppg: 37,
        fermentable: null,
        lateAddition: false,
      },
      {
        name: 'Munich Malt',
        amount: '0.5',
        unit: 'kg',
        percent: '10',
        ebc: 20,
        ppg: 36,
        fermentable: null,
        lateAddition: false,
      },
      {
        name: 'Carapils',
        amount: '0.3',
        unit: 'kg',
        percent: '6',
        ebc: 8,
        ppg: 33,
        fermentable: null,
        lateAddition: false,
      },
    ],
    hops: [
      {
        name: 'Magnum',
        amount: '20',
        unit: 'g',
        use: 'Boil',
        stage: 'Boil',
        time: '60',
        timeUnit: 'min',
        aa: '12',
        ibu: '',
        form: 'Pellet',
        utilization: '',
        temp: '',
      },
      {
        name: 'Citra',
        amount: '40',
        unit: 'g',
        use: 'Boil',
        stage: 'Boil',
        time: '10',
        timeUnit: 'min',
        aa: '12',
        ibu: '',
        form: 'Pellet',
        utilization: '',
        temp: '',
      },
      {
        name: 'Citra',
        amount: '60',
        unit: 'g',
        use: 'Whirlpool',
        stage: 'Whirlpool',
        time: '15',
        timeUnit: 'min',
        aa: '12',
        ibu: '',
        form: 'Pellet',
        utilization: '',
        temp: '80',
      },
    ],
    yeast: [
      {
        name: 'US-05',
        lab: 'Fermentis',
        attenuation: '81',
        amount: '1',
        amountUnit: 'pkg',
        type: 'Ale',
        form: 'Dry',
        flocculation: 'Medium',
        minTempC: 18,
        maxTempC: 22,
        alcoholTolerance: '9%',
        starter: false,
        addAfterDays: '',
        heldAtC: '',
      },
    ],
    otherIngredients: [],
    notes: 'Seeded by npm run seed:brew-session — not a real brew.',
    mashGuidelines: null,
    waterProfile: null,
  };
}

/**
 * The brew day as the rig walks it, in minutes from the start. The indices are
 * the rig's own (BREW_STAGES in brew-system-v3), so a mark lands on the same
 * name the rig would have sent, and the last one is the "brew finished" mark
 * that sits one past the end of its list.
 */
const STAGES: { index: number; name: string; at: number }[] = [
  { index: 0, name: 'Heat water (for mash)', at: 0 },
  { index: 1, name: 'Mash in', at: 45 },
  { index: 2, name: 'Mash', at: 50 },
  { index: 3, name: 'Sparge', at: 115 },
  { index: 4, name: 'Heat water (for boil)', at: 140 },
  { index: 5, name: 'Boil', at: 170 },
  { index: 6, name: 'Hop whirlpool', at: 230 },
  { index: 7, name: 'Cooling', at: 245 },
  { index: 8, name: 'Brew complete', at: 275 },
];

/** Minutes of logging — a few past the last mark, as a real session would be. */
const BREW_MINUTES = 280;

const AMBIENT_C = 15;

/** Linear ramp from `a` to `b` across [t0, t1], flat outside it. */
function ramp(t: number, t0: number, a: number, t1: number, b: number): number {
  if (t <= t0) return a;
  if (t >= t1) return b;
  return a + ((b - a) * (t - t0)) / (t1 - t0);
}

/** Newton cooling towards `to`, `tau` minutes from `t0` at `from`. */
function cool(t: number, t0: number, from: number, to: number, tau: number): number {
  return to + (from - to) * Math.exp(-(t - t0) / tau);
}

/**
 * The hot liquor tank: strike water heated for the mash, emptied into the tun at
 * mash in, refilled cold and taken back up for the sparge, then left to go cold.
 */
function hlt(t: number): number {
  if (t < 45) return ramp(t, 0, 14, 42, 74);
  if (t < 47) return ramp(t, 45, 74, 47, 17); // drained into the tun, refilled cold
  if (t < 115) return ramp(t, 47, 17, 105, 78);
  if (t < 140) return ramp(t, 115, 78, 140, 45); // sparging draws it down
  return cool(t, 140, 45, AMBIENT_C + 4, 90);
}

/**
 * The mash tun: cold until dough-in, a slow decline through the rest of the mash
 * (it has no heater of its own), lifted by the sparge water, then emptied.
 */
function mlt(t: number): number {
  if (t < 45) return AMBIENT_C + 1;
  if (t < 50) return ramp(t, 45, AMBIENT_C + 1, 50, 67.2); // dough-in
  if (t < 115) return ramp(t, 50, 67.2, 115, 64.4); // the mash, losing heat
  if (t < 140) return ramp(t, 115, 64.4, 140, 71); // 78° sparge water over the bed
  return cool(t, 140, 71, AMBIENT_C + 2, 70);
}

/** The kettle: fills over the sparge, heats, boils, whirlpools, then chills. */
function bk(t: number): number {
  if (t < 115) return AMBIENT_C + 1;
  if (t < 140) return ramp(t, 115, AMBIENT_C + 1, 140, 64); // wort running off
  if (t < 170) return ramp(t, 140, 64, 170, 99.8); // burner on
  if (t < 230) return 100 + 0.25 * Math.sin(t / 3); // rolling boil
  if (t < 245) return ramp(t, 230, 99.8, 245, 95); // whirlpool, element off
  return cool(t, 245, 95, 19, 9); // plate chiller
}

/** A few tenths of jitter, so the traces read as sensors rather than formulae. */
function noise(): number {
  return (Math.random() - 0.5) * 0.3;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * A believable sensor dropout: the mash tun's probe loses its connection for two
 * minutes mid-mash. Seeded deliberately rather than left clean — the chart draws
 * a gap there instead of a straight line across it, and that is a behaviour
 * worth being able to look at.
 */
const DROPOUT = { from: 96, to: 98 };

function seed(): void {
  const existing = listRecipeDetails().find((r) => r.name === RECIPE_NAME);
  const recipe = existing ?? createRecipe(recipeInput(), 'Seeded demo recipe');
  console.log(
    existing
      ? `Reusing demo recipe "${RECIPE_NAME}" (${recipe.id}).`
      : `Created demo recipe "${RECIPE_NAME}" (${recipe.id}).`,
  );

  // Idempotent: the demo recipe carries exactly one demo batch. Deleting the
  // brew session cascades to its samples and stage marks.
  for (const old of listRecipeBrewSessions(recipe.id)) {
    deleteBrewSession(old.id);
    console.log(`Replaced existing demo brew session ${old.id}.`);
  }

  const start = new Date();
  start.setDate(start.getDate() - DAYS_AGO);
  start.setHours(START_HOUR, 0, 0, 0);
  const startMs = start.getTime();
  const at = (minutes: number): string => new Date(startMs + minutes * 60_000).toISOString();

  const brewSession = startBrewSession(recipe.id, recipe, start.toISOString());

  recordStageMarkers(
    brewSession.id,
    STAGES.map((stage) => ({ index: stage.index, name: stage.name, at: at(stage.at) })),
  );

  let samples = 0;
  for (let ms = 0; ms <= BREW_MINUTES * 60_000; ms += SAMPLE_INTERVAL_MS) {
    const t = ms / 60_000;
    const dropped = t >= DROPOUT.from && t <= DROPOUT.to;
    insertRigSample(brewSession.id, {
      recordedAt: at(t),
      bk: round1(bk(t) + noise()),
      mlt: dropped ? null : round1(mlt(t) + noise()),
      hlt: round1(hlt(t) + noise()),
    });
    samples += 1;
  }

  // The figures a brewer would have typed in on the day, so the plan-against-
  // result columns have something to compare.
  updateBrewSession(brewSession.id, {
    status: 'fermenting',
    durationMinutes: BREW_MINUTES,
    pitchedAt: at(BREW_MINUTES + 25),
    measured: {
      preBoilGravity: '1.043',
      preBoilVolumeL: 27.5,
      postBoilGravity: '1.053',
      postBoilVolumeL: 22,
      og: '1.053',
      volumeL: 20.5,
      mashTempC: 66.5,
      boilTimeMin: 60,
      waterL: 41,
      energyKwh: 9.2,
    },
    notes:
      'Seeded brew day. Strike came in a couple of degrees high and the mash ' +
      'settled at 66.5°C; the sparge ran clear. Not a real batch.',
  });

  console.log(
    `Seeded brew session ${brewSession.id}: ${samples} rig samples over ${BREW_MINUTES} minutes, ` +
      `${STAGES.length} stage marks, brewed ${start.toLocaleString()}.`,
  );
  console.log(`Database: ${databasePath}`);
  console.log(`\nOpen it at  http://localhost:5173/brew-sessions/${brewSession.id}  (dev server)`);
  console.log(`or          http://localhost:3000/brew-sessions/${brewSession.id}  (built server).`);
}

runMigrations();
seed();
