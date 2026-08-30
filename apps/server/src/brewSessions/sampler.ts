import type { BrewSessionStageMarker, BrewStageState } from '@checklist/shared';
import type { FastifyBaseLogger } from 'fastify';
import { readBrewSystemState } from '../brewSystemClient.js';
import {
  brewSessionsInProgress,
  hasRigSampleAt,
  insertRigSample,
  recordStageMarkers,
} from './repo.js';

/**
 * Logs the brewing rig's pot temperatures — and the brew stages it passes
 * through — for the duration of a brew session.
 *
 * While any brew session is still at `brewing`, this polls the rig and writes one
 * row per sweep — BK, MLT and HLT together — against that brew session. Advancing
 * the batch to `fermenting` is what stops it: the mash and boil curve is over
 * once the wort is in the tank, and from there the fermenter's own telemetry
 * takes the story on.
 *
 * The stages ride along on the same sweep. The rig keeps them only for its
 * *current* session and wipes them when the next brew starts, so if they aren't
 * copied here on the day they are gone — which is why they're captured on every
 * poll rather than read back once when the session closes.
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

  const stageMarkers = stageMarkersOf(state.brewStage);
  const { bk, mlt, hlt } = state.temperatures;
  // A sweep where all three sensors failed is not a reading of anything — but
  // it can still carry a stage change, which is why this only skips the sample.
  const readings = bk == null && mlt == null && hlt == null ? null : { bk, mlt, hlt };
  const recordedAt = new Date().toISOString();

  for (const brewSession of open) {
    try {
      if (stageMarkers.length > 0) recordStageMarkers(brewSession.id, stageMarkers);
      // Cheap idempotence: a restart that fires the first tick straight after a
      // scheduled one shouldn't double-log the same instant.
      if (readings && !hasRigSampleAt(brewSession.id, recordedAt)) {
        insertRigSample(brewSession.id, { recordedAt, ...readings });
      }
    } catch (err) {
      log.error(err, `Failed to log rig temperatures for brew session ${brewSession.id}`);
    }
  }
}

/**
 * The rig's stage marks as rows to keep: its index into the stage list, the
 * name that index stood for at the time, and the moment it was entered.
 *
 * The name is resolved here rather than stored as an index alone so a brewer
 * renaming a stage on the rig — or reordering the list between brews — can't
 * relabel a brew day that has already happened. The rig writes one last mark
 * when the brew finishes, whose index is past the end of the list and so has no
 * name of its own.
 *
 * A rig too old to track stages sends no `brewStage` at all, which is simply
 * nothing to record.
 *
 * Exported for its own test: the naming rules are the part that decides what a
 * brew day's chart is labelled with years later.
 */
export function stageMarkersOf(stage: BrewStageState | undefined): BrewSessionStageMarker[] {
  if (!stage) return [];
  return stage.markers.flatMap((marker) => {
    if (!Number.isFinite(marker.ts)) return [];
    return [
      {
        index: marker.index,
        name: stage.stages[marker.index] ?? 'Brew complete',
        at: new Date(marker.ts).toISOString(),
      },
    ];
  });
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
