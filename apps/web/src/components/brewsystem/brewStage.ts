import type { BrewStageState } from '@checklist/shared';

/**
 * Moving the brew day's stage, mirrored from the rig.
 *
 * The rig owns the stage; the panel polls it. But a press has to show up under
 * the finger, and the answer is a round trip through the tunnel plus the poll
 * suppression window behind it — so the panel applies the step locally, exactly
 * as `_step_brew_stage` in brew-system-v3's backend/main.py does, and the next
 * poll replaces the guess with the rig's own record.
 *
 * Keep the two in step: the arithmetic below is the contract between them.
 */

/** Before the first stage. The position after the last is `stages.length`. */
export const STAGE_NOT_STARTED = -1;

/**
 * The stage state one step forward (`delta` > 0) or back, unchanged when the
 * step would fall off either end — the rig clamps rather than refusing, so
 * pressing "back" on a brew that hasn't started is a no-op, not an error.
 *
 * Stepping back also drops the mark for the stage being left. That is the point
 * of having a back button: without it a mis-tap during the mash would leave a
 * "Sparge" line on the rig's chart for the rest of the brew. It keeps `markers`
 * a prefix of the stage list, which is what lets the card read the current
 * stage's start time off the end of it.
 */
export function stepStage(stage: BrewStageState, delta: number): BrewStageState {
  const target = Math.max(STAGE_NOT_STARTED, Math.min(stage.stages.length, stage.index + delta));
  if (target === stage.index) return stage;
  return {
    ...stage,
    index: target,
    markers:
      target > stage.index
        ? // The rig stamps the real timestamp; this one only has to hold until
          // the next poll brings back the rig's.
          [...stage.markers, { index: target, ts: Date.now() }]
        : stage.markers.filter((marker) => marker.index <= target),
  };
}
