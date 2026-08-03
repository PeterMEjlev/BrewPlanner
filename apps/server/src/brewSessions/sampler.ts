import type { FastifyBaseLogger } from 'fastify';
import { readBrewSystemState } from '../brewSystemClient.js';
import { brewSessionsInProgress, hasRigSampleAt, insertRigSample } from './repo.js';

/**
 * Logs the brewing rig's pot temperatures for the duration of a brew session.
 *
 * While any brew session is still at `brewing`, this polls the rig and writes one
 * row per sweep — BK, MLT and HLT together — against that brew session. Advancing
 * the batch to `fermenting` is what stops it: the mash and boil curve is over
 * once the wort is in the tank, and from there the fermenter's own telemetry
 * takes the story on.
 *
 * Deliberately quiet about a rig that isn't there. It's powered off most of the
 * year, and a brew session logged from the phone after the fact will never see it —
 * that's a batch with no curve, not an error worth a log line every 30 seconds.
 */

/**
 * How often the rig is read while a brew session is running. `BREW_DAY_SAMPLE_SECONDS`
 * is the name this used to go by, still honoured so a hub whose service file
 * predates the rename keeps its configured interval.
 */
const SAMPLE_INTERVAL_MS =
  Number(process.env.BREW_SESSION_SAMPLE_SECONDS ?? process.env.BREW_DAY_SAMPLE_SECONDS ?? 30) *
  1000;

/**
 * Sample the rig once and file it against every in-progress brew session. Exported
 * so a test can drive a tick without waiting on the timer.
 */
export async function sampleRigForBrewSessions(log: FastifyBaseLogger): Promise<void> {
  const open = brewSessionsInProgress();
  if (open.length === 0) return;
  const state = await readBrewSystemState();
  // Rig off, or no rig configured: normal, and says nothing about the brew session.
  if (!state) return;
  const { bk, mlt, hlt } = state.temperatures;
  // A sweep where all three sensors failed is not a reading of anything.
  if (bk == null && mlt == null && hlt == null) return;
  const recordedAt = new Date().toISOString();
  for (const brewSession of open) {
    try {
      // Cheap idempotence: a restart that fires the first tick straight after a
      // scheduled one shouldn't double-log the same instant.
      if (hasRigSampleAt(brewSession.id, recordedAt)) continue;
      insertRigSample(brewSession.id, { recordedAt, bk, mlt, hlt });
    } catch (err) {
      log.error(err, `Failed to log rig temperatures for brew session ${brewSession.id}`);
    }
  }
}

/**
 * Start the background sampler. Like the other schedulers, the interval is
 * unref'd so it never holds the process open on shutdown.
 */
export function startBrewSessionSampler(log: FastifyBaseLogger): void {
  if (!(SAMPLE_INTERVAL_MS > 0)) {
    log.info('Brew-session rig sampling disabled (BREW_SESSION_SAMPLE_SECONDS <= 0).');
    return;
  }
  const tick = (): void => {
    void sampleRigForBrewSessions(log).catch((err) => {
      log.error(err, 'Brew-session rig sampling failed');
    });
  };
  setInterval(tick, SAMPLE_INTERVAL_MS).unref();
  // A brew session in progress across a restart should pick straight back up.
  setTimeout(tick, 5_000).unref();
  log.info(
    `Brew-session rig sampling enabled (logging pot temperatures every ${SAMPLE_INTERVAL_MS / 1000}s while brewing).`,
  );
}
