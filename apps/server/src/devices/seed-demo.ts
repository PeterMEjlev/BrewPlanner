import type { DeviceType } from '@checklist/shared';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '../db/index.js';
import { readings } from '../db/schema.js';
import { createDevice, listDevices, touchLastSeen } from './repo.js';

/**
 * Seed synthetic "demo" telemetry so the dashboard can be previewed before the
 * real sensors are wired in. Registers a placeholder device per piece of
 * equipment, backfills a 24h history with the same curves the agents' simulate
 * mode produces, and stamps each one online.
 *
 *   npm run seed:demo            (from apps/server, or via the workspace)
 *
 * Idempotent: re-running wipes each demo device's readings and backfills a
 * fresh window, then re-stamps it online. It targets the same SQLite DB the
 * server uses (DATABASE_PATH, else apps/server/data/checklist.sqlite), so run
 * it on whichever machine hosts the hub.
 *
 * Online state decays after the staleness window (~90s), so the cards go
 * Offline shortly after seeding — re-run to refresh, or run the agents in
 * BP_SIMULATE=1 mode for a continuously-live preview. Remove a placeholder once
 * the real device is registered with:  npm run device -- delete "<name>"
 */

const HOURS = 24;
const STEP_S = 300; // one sample every 5 minutes → 288 points / metric / day

const round = (n: number, p = 2): number => Math.round(n * 10 ** p) / 10 ** p;

interface DemoSpec {
  name: string;
  type: DeviceType;
  /** metric name → value as a function of wall-clock seconds. */
  metrics: Record<string, (tSec: number) => number>;
}

// Mirrors the agent's simulate curve, but phase-anchored to now so the most
// recent sample lands mid-cooling: the dashboard shows the cooling relay active
// (blue) on load, with both relays cycling through the 24h history.
const NOW_S = Date.now() / 1000;
const DAY_START_S = NOW_S - HOURS * 3600; // start of the backfilled window
const inkbirdTemp = (t: number): number => 18 + 0.6 * Math.sin((t - NOW_S) / 1200 + Math.PI / 2);
// The brewery ambient thermometer is "another Inkbird 308" (reused
// brew_controller), kept a touch warmer and slower than the fermenter fridge.
const ambientTemp = (t: number): number => 20 + 1.2 * Math.sin((t - NOW_S) / 1500);

const SPECS: DemoSpec[] = [
  {
    name: 'Demo Fermenter',
    type: 'pressure_sensor',
    metrics: {
      pressure_bar: (t) => round(1.3 + 0.3 * Math.sin(t / 600), 3),
    },
  },
  {
    name: 'Demo Inkbird Controller',
    type: 'brew_controller',
    metrics: {
      temp_c: (t) => round(inkbirdTemp(t)),
      setpoint_c: () => 18,
      // -1 cooling, 0 idle, +1 heating — one relay at a time.
      hvac_state: (t) => {
        const temp = inkbirdTemp(t);
        if (temp > 18 + 0.3) return -1;
        if (temp < 18 - 0.3) return 1;
        return 0;
      },
    },
  },
  {
    // Reused brew_controller; the name matters — the dashboard's "Brewery
    // Temperature" placeholder hides once an ambient/brewery controller exists.
    name: 'Demo Brewery Ambient',
    type: 'brew_controller',
    metrics: {
      temp_c: (t) => round(ambientTemp(t)),
      setpoint_c: () => 20,
      hvac_state: (t) => {
        const temp = ambientTemp(t);
        if (temp > 20 + 0.4) return -1;
        if (temp < 20 - 0.4) return 1;
        return 0;
      },
    },
  },
  {
    name: 'Demo Power Meter',
    type: 'power_meter',
    metrics: {
      power_w: (t) => round(200 + 180 * Math.sin(t / 450), 1),
      // Meter-style running total over the backfilled window (~0.2 kW average).
      energy_kwh: (t) => round((0.2 * (t - DAY_START_S)) / 3600, 3),
    },
  },
  {
    name: 'Demo Water Meter',
    type: 'water_meter',
    metrics: {
      // Intermittent draw: the sine's negative half is clamped to 0 (tap off).
      flow_lpm: (t) => round(Math.max(0, 6 * Math.sin(t / 240)), 2),
      water_l: (t) => round((25 * (t - DAY_START_S)) / 3600, 1),
    },
  },
  {
    name: 'Demo Tilt',
    type: 'hydrometer',
    metrics: {
      gravity_sg: (t) => round(1.03 + 0.02 * Math.sin(t / 3600), 3),
      temp_c: (t) => round(20 + 1.5 * Math.sin(t / 1800)),
    },
  },
];

function findOrCreate(name: string, type: DeviceType): number {
  const existing = listDevices().find((d) => d.name === name);
  if (existing) return existing.id;
  const { device } = createDevice(name, type);
  console.log(`Created placeholder device "${name}" (id ${device.id}, ${type}).`);
  return device.id;
}

function seed(spec: DemoSpec): void {
  const id = findOrCreate(spec.name, spec.type);

  // Idempotent: clear this demo device's existing readings before backfilling.
  db.delete(readings).where(eq(readings.deviceId, id)).run();

  const now = Date.now();
  const start = now - HOURS * 3600 * 1000;
  const rows: { deviceId: number; metric: string; value: number; recordedAt: string }[] = [];
  for (let ts = start; ts <= now; ts += STEP_S * 1000) {
    const tSec = ts / 1000;
    const recordedAt = new Date(ts).toISOString();
    for (const [metric, fn] of Object.entries(spec.metrics)) {
      rows.push({ deviceId: id, metric, value: fn(tSec), recordedAt });
    }
  }

  for (let i = 0; i < rows.length; i += 500) {
    db.insert(readings).values(rows.slice(i, i + 500)).run();
  }
  touchLastSeen(id); // mark online as of now

  const metricCount = Object.keys(spec.metrics).length;
  console.log(`Seeded "${spec.name}": ${rows.length} readings across ${metricCount} metric(s).`);
}

runMigrations();
for (const spec of SPECS) seed(spec);
console.log(`\nDone. All ${SPECS.length} cards will show Online for ~90s; re-run to refresh.`);
