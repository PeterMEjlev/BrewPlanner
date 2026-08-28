import type { BrewStageState } from '@checklist/shared';
import { describe, expect, it } from 'vitest';
import { STAGE_NOT_STARTED, stepStage } from './brewStage';

const STAGES = ['Heat water (for mash)', 'Mash in', 'Mash'];

/** A brew sitting on `index`, with the marks a brew that got there would have. */
function at(index: number): BrewStageState {
  return {
    stages: STAGES,
    index,
    markers: Array.from({ length: index + 1 }, (_, i) => ({ index: i, ts: 1_000 + i })),
  };
}

describe('stepStage', () => {
  it('marks each stage as the brew enters it', () => {
    const started = stepStage(at(STAGE_NOT_STARTED), 1);
    expect(started.index).toBe(0);
    expect(started.markers.map((m) => m.index)).toEqual([0]);

    const next = stepStage(started, 1);
    expect(next.index).toBe(1);
    expect(next.markers.map((m) => m.index)).toEqual([0, 1]);
  });

  it('leaves the markers a prefix of the stage list when stepping back', () => {
    const back = stepStage(at(2), -1);
    expect(back.index).toBe(1);
    expect(back.markers.map((m) => m.index)).toEqual([0, 1]);
  });

  it('keeps the marks of the stages already entered', () => {
    const before = at(1);
    const after = stepStage(before, 1);
    expect(after.markers.slice(0, 2)).toEqual(before.markers);
  });

  it('clamps at both ends instead of refusing', () => {
    const notStarted = at(STAGE_NOT_STARTED);
    expect(stepStage(notStarted, -1)).toBe(notStarted);

    // One past the last stage is "brew complete" — a real position, and the end.
    const complete = stepStage(at(STAGES.length - 1), 1);
    expect(complete.index).toBe(STAGES.length);
    expect(stepStage(complete, 1)).toBe(complete);
  });

  it('records when the brew finished, so the card can date it', () => {
    const complete = stepStage(at(STAGES.length - 1), 1);
    expect(complete.markers.at(-1)?.index).toBe(STAGES.length);
  });
});
