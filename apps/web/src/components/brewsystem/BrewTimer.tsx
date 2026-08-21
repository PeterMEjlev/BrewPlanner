import { memo, useEffect, useRef, useState } from 'react';
import type { BrewTimerState } from '@checklist/shared';
import { api } from '../../api';
import styles from './BrewTimer.module.css';

/**
 * The rig's brew timer, ported from brew-system-v3 (BrewTimer.jsx). The timer
 * itself runs on the rig's backend — this card mirrors it from the polled
 * state, ticks locally between polls, and forwards taps/drags as commands
 * (fire-and-forget, like every other control on this page).
 *
 * Gestures: tap = start/pause, hold = reset, vertical drag = set the segment
 * under the finger — whichever of HH / MM / SS is drawn nearest to it, so the
 * pair you press is always the pair you change.
 */

const postTimer = (action: 'start' | 'stop' | 'reset' | 'set', seconds?: number): void => {
  void api.brewTimerAction(action, seconds).catch(() => {});
};

const DRAG_THRESHOLD = 20; // pixels of vertical drag per tick
const DRAG_START_THRESHOLD = 10; // pixels before a press is considered a drag
const LONG_PRESS_MS = 800;

const SEGMENTS = ['h', 'm', 's'] as const;
type Segment = (typeof SEGMENTS)[number];

interface Press {
  segment: Segment;
  startY: number;
  accumulated: number;
  dragging: boolean;
  longPressFired: boolean;
}

function BrewTimer({ timerState }: { timerState: BrewTimerState }): JSX.Element {
  const [displaySeconds, setDisplaySeconds] = useState(0);
  const [target, setTarget] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [isFinished, setIsFinished] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Skip the next backend sync right after a local command, so an in-flight
  // poll response can't bounce the display back to its pre-command value.
  const localActionRef = useRef(false);

  // Press state — covers tap, drag-to-adjust, and long-press-to-reset
  const pressRef = useRef<Press | null>(null);
  // The rendered digit pairs, so a press can be matched against where they
  // actually are rather than against a fixed slice of the card (see segmentAt).
  const segmentRefs = useRef<Record<Segment, HTMLDivElement | null>>({ h: null, m: null, s: null });

  const canAdjust = !isRunning && displaySeconds === target;

  // Sync from the backend poll — including whether the timer is sitting at
  // zero, i.e. the "Timer Complete" state. The rig's timer is one shared
  // object, so that flag has to be *mirrored* rather than latched: dismissing
  // on the rig's own kiosk (or a second browser) resets the timer there, and
  // this card has to stop flashing when it does. Latching it — setting it on a
  // finished poll and only ever clearing it from a local tap — left each screen
  // alarming on its own until somebody dismissed it on that screen too.
  useEffect(() => {
    if (localActionRef.current) {
      localActionRef.current = false;
      return;
    }
    setDisplaySeconds(timerState.seconds);
    setIsRunning(timerState.running);
    setTarget(timerState.target ?? 0);
    setIsFinished(timerState.target > 0 && timerState.seconds === 0 && !timerState.running);
  }, [timerState]);

  // Local tick — keeps the display moving every second between polls; the
  // backend poll corrects any drift.
  useEffect(() => {
    if (isRunning) {
      intervalRef.current = setInterval(() => {
        setDisplaySeconds((prev) => {
          if (target > 0) {
            const next = prev - 1;
            return next >= 0 ? next : 0;
          }
          return prev + 1;
        });
      }, 1000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isRunning, target]);

  /**
   * The digit pair a press belongs to: the one drawn nearest to it, which puts
   * the boundary between two zones exactly halfway between the two numbers.
   * The card is the touch target but the digits don't fill it — they sit at
   * different widths on the kiosk and on a phone — so slicing the card into
   * thirds would hand a press on a number to the wrong pair. That fallback is
   * kept only for the frame before the refs attach.
   */
  const segmentAt = (clientX: number, card: HTMLElement): Segment => {
    let closest: Segment | null = null;
    let bestDistance = Infinity;
    for (const key of SEGMENTS) {
      const el = segmentRefs.current[key];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const distance = Math.abs(clientX - (rect.left + rect.width / 2));
      if (distance < bestDistance) {
        bestDistance = distance;
        closest = key;
      }
    }
    if (closest) return closest;
    const rect = card.getBoundingClientRect();
    const third = rect.width / 3;
    const relX = clientX - rect.left;
    return relX < third ? 'h' : relX < 2 * third ? 'm' : 's';
  };

  const applySegmentDelta = (segment: Segment, delta: number): void => {
    setTarget((prev) => {
      const h = Math.floor(prev / 3600);
      const m = Math.floor((prev % 3600) / 60);
      const s = prev % 60;

      let newH = h;
      let newM = m;
      let newS = s;
      if (segment === 'h') newH = (((h + delta) % 25) + 25) % 25;
      if (segment === 'm') newM = (((m + delta) % 60) + 60) % 60;
      if (segment === 's') newS = (((s + delta) % 60) + 60) % 60;

      const newTarget = newH * 3600 + newM * 60 + newS;
      setDisplaySeconds(newTarget);

      localActionRef.current = true;
      postTimer('set', newTarget);

      return newTarget;
    });
  };

  const handleReset = (): void => {
    localActionRef.current = true;
    postTimer('reset');
    setIsRunning(false);
    setIsFinished(false);
    setTarget(0);
    setDisplaySeconds(0);
  };

  const handleToggle = (): void => {
    if (isFinished) {
      handleReset();
      return;
    }
    localActionRef.current = true;
    if (isRunning) {
      postTimer('stop');
      setIsRunning(false);
    } else {
      postTimer('start');
      setIsRunning(true);
    }
  };

  const cancelLongPress = (): void => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  // Unified card-level pointer handling.
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const segment = segmentAt(e.clientX, e.currentTarget);

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    pressRef.current = {
      segment,
      startY: e.clientY,
      accumulated: 0,
      dragging: false,
      longPressFired: false,
    };

    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      if (pressRef.current) pressRef.current.longPressFired = true;
      handleReset();
    }, LONG_PRESS_MS);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const press = pressRef.current;
    if (!press) return;

    const dy = press.startY - e.clientY; // positive = dragged up
    if (!press.dragging && Math.abs(dy) > DRAG_START_THRESHOLD) {
      press.dragging = true;
      cancelLongPress();
    }
    if (!press.dragging || !canAdjust) return;

    const ticks = Math.trunc((dy - press.accumulated) / DRAG_THRESHOLD);
    if (ticks !== 0) {
      press.accumulated += ticks * DRAG_THRESHOLD;
      applySegmentDelta(press.segment, ticks);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const press = pressRef.current;
    pressRef.current = null;
    cancelLongPress();
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (!press) return;
    if (press.dragging || press.longPressFired) return;
    handleToggle();
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>): void => {
    pressRef.current = null;
    cancelLongPress();
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const h = Math.floor(displaySeconds / 3600);
  const m = Math.floor((displaySeconds % 3600) / 60);
  const s = displaySeconds % 60;

  const mode = target > 0 ? 'Timer' : 'Stopwatch';

  const getHint = (): string => {
    if (isFinished) return 'Timer Complete! • Tap to Dismiss';
    if (canAdjust) return 'Drag to Set • Tap to Start';
    if (isRunning) return 'Tap to Pause • Hold to Reset';
    return 'Tap to Resume • Hold to Reset';
  };

  return (
    <div
      className={`${styles.brewTimer} ${isFinished ? styles.finished : isRunning ? styles.running : styles.paused} ${canAdjust ? styles.adjustable : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <div className={styles.label}>Brew {mode}</div>
      <div className={styles.timeDisplay}>
        <div
          className={styles.segment}
          ref={(el) => {
            segmentRefs.current.h = el;
          }}
        >
          {String(h).padStart(2, '0')}
        </div>
        <span className={styles.colon}>:</span>
        <div
          className={styles.segment}
          ref={(el) => {
            segmentRefs.current.m = el;
          }}
        >
          {String(m).padStart(2, '0')}
        </div>
        <span className={styles.colon}>:</span>
        <div
          className={styles.segment}
          ref={(el) => {
            segmentRefs.current.s = el;
          }}
        >
          {String(s).padStart(2, '0')}
        </div>
      </div>
      <div className={styles.statusHint}>{getHint()}</div>
    </div>
  );
}

export default memo(BrewTimer);
