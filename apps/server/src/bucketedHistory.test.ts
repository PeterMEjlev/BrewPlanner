import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/**
 * Summarizing a window into buckets (the form every chart wider than 24h reads).
 *
 * A quantity is averaged, which is the whole point — a fridge drawn as the
 * 4.2 °C it holds rather than as its compressor cycles. A *state* can't be:
 * `hvac_state` is -1 cooling / 0 idle / +1 heating, and the mean of a relay that
 * cooled for a third of an hour is -0.33, which the chart drew as a line
 * wandering between the Cool and Idle ticks — a reading of the hardware that
 * never happened. These pin that a bucketed state only ever reports a level the
 * device was actually in.
 *
 * DATABASE_PATH must be set before the db module loads, hence dynamic imports.
 */

let booted: Promise<typeof import('./devices/repo.js')> | null = null;

function boot(): Promise<typeof import('./devices/repo.js')> {
  if (!booted) {
    booted = (async () => {
      process.env.DATABASE_PATH = join(tmpdir(), `brewplanner-buckets-${randomUUID()}.sqlite`);
      const database = await import('./db/index.js');
      database.runMigrations();
      return import('./devices/repo.js');
    })();
  }
  return booted;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Four hours of readings for one metric, as four clusters an hour apart — one
 * per bucket when the window is asked for in four. Clustered rather than spread
 * so the assertions don't hinge on exactly where a boundary falls.
 */
async function windowOf(
  metric: string,
  clusters: number[][],
): Promise<{ deviceId: number; since: string; buckets: number }> {
  const repo = await boot();
  const { device } = repo.createDevice(`controller-${randomUUID()}`, 'brew_controller');
  const startMs = Date.now() - 4 * HOUR;
  repo.insertReadings(
    device.id,
    clusters.flatMap((values, bucket) =>
      values.map((value, i) => ({
        metric,
        value,
        recordedAt: new Date(startMs + 5 * MINUTE + bucket * HOUR + i * 1000).toISOString(),
      })),
    ),
  );
  return { deviceId: device.id, since: new Date(startMs).toISOString(), buckets: 4 };
}

/** The bucketed series, oldest first (the API answers newest first). */
async function bucketed(
  metric: string,
  clusters: number[][],
): Promise<{ value: number; min?: number; max?: number }[]> {
  const repo = await boot();
  const { deviceId, since, buckets } = await windowOf(metric, clusters);
  return repo.getHistory(deviceId, { metric, since, buckets }).reverse();
}

test('a quantity is averaged into its buckets, carrying the true spread', async () => {
  const points = await bucketed('temp_c', [
    [4, 6],
    [10, 10],
    [1, 3],
    [20, 21, 22],
  ]);
  assert.deepEqual(
    points.map((p) => p.value),
    [5, 10, 2, 21],
  );
  assert.deepEqual(points[0], { ...points[0], min: 4, max: 6 });
});

test('a bucketed state only ever reports a level the device was actually in', async () => {
  // The reported bug: every one of these buckets mixes two levels, and averaging
  // them lands between the Cool/Idle/Heat ticks.
  const points = await bucketed('hvac_state', [
    [-1, -1, 0],
    [0, 0, -1],
    [1, 0, 0],
    [-1, -1, -1],
  ]);
  for (const p of points) assert.ok([-1, 0, 1].includes(p.value), `invented state ${p.value}`);
});

test('each bucket reports the level it spent most of its readings at', async () => {
  const points = await bucketed('hvac_state', [
    [-1, -1, -1, 0], // mostly cooling
    [0, 0, 0, -1], // mostly idle
    [1, 1, 0], // mostly heating
    [0, 0, 0, 0], // idle throughout
  ]);
  assert.deepEqual(
    points.map((p) => p.value),
    [-1, 0, 1, 0],
  );
});

test('a bucket split evenly is drawn as working, and drawn the same way twice', async () => {
  const repo = await boot();
  const { deviceId, since, buckets } = await windowOf('hvac_state', [
    [-1, 0], // half cooling, half idle → cooling
    [1, 1, -1, -1], // half heating, half cooling → heating
    [0, 0],
    [0, 0],
  ]);
  const read = (): number[] =>
    repo
      .getHistory(deviceId, { metric: 'hvac_state', since, buckets })
      .reverse()
      .map((p) => p.value);
  assert.deepEqual(read().slice(0, 2), [-1, 1]);
  // Ordering has to be total, or a poll a minute later redraws the same hour
  // differently and the line twitches on its own.
  assert.deepEqual(read(), read());
});

test('a state bucket still carries the extremes it covered', async () => {
  const points = await bucketed('hvac_state', [
    [-1, -1, 1],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]);
  assert.equal(points[0]!.min, -1);
  assert.equal(points[0]!.max, 1);
});
