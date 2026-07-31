import type { FastifyBaseLogger } from 'fastify';
import { readBrewSystemState } from '../brewSystemClient.js';
import { brewDaysInProgress, hasRigSampleAt, insertRigSample } from './repo.js';

/**
 * Logs the brewing rig's pot temperatures for the duration of a brew day.
 *
 * While any brew day is still at `brewing`, this polls the rig and writes one
 * row per sweep — BK, MLT and HLT together — against that brew day. Advancing
 * the batch to `fermenting` is what stops it: the mash and boil curve is over
 * once the wort is in the tank, and from there the fermenter's own telemetry
 * takes the story on.
 *
 * Deliberately quiet about a rig that isn't there. It's powered off most of the
 * year, and a brew day logged from the phone after the fact will never see it —
 * that's a batch with no curve, not an error worth a log line every 30 seconds.
 */

/** How often the rig is read while a brew day is running. */
const SAMPLE_INTERVAL_MS = Number(process.env.BREW_DAY_SAMPLE_SECONDS ?? 30) * 1000;

/**
 * Sample the rig once and file it against every in-progress brew day. Exported
 * so a test can drive a tick without waiting on the timer.
 */
export async function sampleRigForBrewDays(log: FastifyBaseLogger): Promise<void> {
  const open = brewDaysInProgress();
  if (open.length === 0) return;
  const state = await readBrewSystemState();
  // Rig off, or no rig configured: normal, and says nothing about the brew day.
  if (!state) return;
  const { bk, mlt, hlt } = state.temperatures;
  // A sweep where all three sensors failed is not a reading of anything.
  if (bk == null && mlt == null && hlt == null) return;
  const recordedAt = new Date().toISOString();
  for (const brewDay of open) {
    try {
      // Cheap idempotence: a restart that fires the first tick straight after a
      // scheduled one shouldn't double-log the same instant.
      if (hasRigSampleAt(brewDay.id, recordedAt)) continue;
      insertRigSample(brewDay.id, { recordedAt, bk, mlt, hlt });
    } catch (err) {
      log.error(err, `Failed to log rig temperatures for brew day ${brewDay.id}`);
    }
  }
}

/**
 * Start the background sampler. Like the other schedulers, the interval is
 * unref'd so it never holds the process open on shutdown.
 */
export function startBrewDaySampler(log: FastifyBaseLogger): void {
  if (!(SAMPLE_INTERVAL_MS > 0)) {
    log.info('Brew-day rig sampling disabled (BREW_DAY_SAMPLE_SECONDS <= 0).');
    return;
  }
  const tick = (): void => {
    void sampleRigForBrewDays(log).catch((err) => {
      log.error(err, 'Brew-day rig sampling failed');
    });
  };
  setInterval(tick, SAMPLE_INTERVAL_MS).unref();
  // A brew day in progress across a restart should pick straight back up.
  setTimeout(tick, 5_000).unref();
  log.info(
    `Brew-day rig sampling enabled (logging pot temperatures every ${SAMPLE_INTERVAL_MS / 1000}s while brewing).`,
  );
}
