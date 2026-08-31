import { memo } from 'react';
import type { BrewStageState } from '@checklist/shared';
import styles from './BrewStageCard.module.css';
import { clockTime } from '../../util';

/**
 * Where the brew day has got to, ported from brew-system-v3 (BrewStageCard.jsx)
 * and standing in the same place: the room under the MLT card that its missing
 * heater controls leave, rather than a row of its own that would push the pumps
 * and the timer down.
 *
 * One row — the stage that is running, flanked by the two chevrons that move
 * off it. The stage ahead is named under the current one, so the brewer never
 * has to remember the running order, and the forward chevron is the warm one
 * because going forward is the thing being done all day while going back is
 * undoing a wrong tap.
 *
 * The rig owns the stage the way it owns the timer; this card only renders what
 * the panel last polled and hands presses back to it.
 *
 * With no brew session running the card goes inert: a stage mark exists to
 * label a logged session's temperature curve, so with nothing in the logbook to
 * label there is nothing for the chevrons to do. It stays on screen, dimmed and
 * saying so, rather than disappearing — the panel is laid out to one screen on
 * both the kiosk and the phone, and a card that came and went would move the
 * pumps and the timer under the brewer's hand at the moment a brew starts.
 */

interface BrewStageCardProps {
  stage: BrewStageState;
  /**
   * Whether a brew session is being brewed right now (the hub's logbook, not the
   * rig — see BrewSystemStatus.brewSessionActive). False greys the card out.
   */
  active: boolean;
  /** +1 = the stage ahead, -1 = back out of the current one. */
  onStep: (delta: 1 | -1) => void;
}

function BrewStageCard({ stage, active, onStep }: BrewStageCardProps): JSX.Element {
  const { stages, index, markers } = stage;

  const notStarted = index < 0;
  const complete = index >= stages.length;
  const currentName = notStarted ? undefined : stages[index];
  // Markers are a prefix of the stage list, so the last one is always the stage
  // being displayed — including the one written when the brew finished.
  const enteredAt = markers.length > 0 ? markers[markers.length - 1]?.ts ?? null : null;

  const heading = notStarted ? 'Not started' : currentName ?? 'Brew complete';
  const step = notStarted
    ? `${stages.length} stages`
    : complete
      ? 'Done'
      : `${index + 1}/${stages.length}`;

  // What the forward chevron moves to. Before the brew begins that is the first
  // stage, whose timestamp every later one is read against; on the last stage it
  // is the end of the brew rather than another name.
  const ahead = complete ? null : notStarted ? stages[0] ?? null : stages[index + 1] ?? 'Finish brew';
  const since = enteredAt == null ? null : `${complete ? 'ended' : 'since'} ${clockTime(enteredAt)}`;

  // Why the chevrons are dead, in the line that would otherwise name the stage
  // ahead — the one place on the card a brewer is already looking for what
  // happens next.
  const meta = active ? ahead && `› ${ahead}` : 'No brew session';

  return (
    <div className={`${styles.stageCard} ${active ? '' : styles.inactive}`}>
      <button
        className={styles.backBtn}
        onClick={() => onStep(-1)}
        disabled={!active || notStarted}
        aria-label="Previous stage"
      >
        ‹
      </button>

      <div className={styles.body}>
        <div className={styles.eyebrow}>
          <span className={styles.label}>Brew Stage</span>
          <span className={styles.step}>{step}</span>
        </div>
        <div
          className={`${styles.heading} ${notStarted || complete || !active ? styles.headingIdle : ''}`}
        >
          {heading}
        </div>
        <div className={styles.meta}>
          <span className={styles.ahead}>{meta}</span>
          {active && since && <span className={styles.since}>{since}</span>}
        </div>
      </div>

      <button
        className={styles.forwardBtn}
        onClick={() => onStep(1)}
        disabled={!active || complete}
        aria-label={
          !active ? 'No brew session' : complete ? 'Brew complete' : `Next stage: ${ahead ?? ''}`
        }
      >
        ›
      </button>
    </div>
  );
}

export default memo(BrewStageCard);
