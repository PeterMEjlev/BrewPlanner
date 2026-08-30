import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BrewStageState } from '@checklist/shared';
import { stageMarkersOf } from './brewSessions/sampler.js';

/**
 * Turning the rig's stage marks into rows a brew session keeps.
 *
 * The naming rules are what this is really about. A mark is an index into a list
 * the rig owns and can reorder or rename between brews, so the name has to be
 * resolved on the day and stored — the alternative is a chart that quietly
 * relabels a brew from two years ago the next time the brewer edits their stage
 * list.
 */

function stage(partial: Partial<BrewStageState>): BrewStageState {
  return { stages: ['Heating', 'Mash', 'Boil'], index: 0, markers: [], ...partial };
}

describe('stageMarkersOf', () => {
  it('names each mark from the stage list it points into', () => {
    const markers = stageMarkersOf(
      stage({ markers: [{ index: 0, ts: 1_770_000_000_000 }, { index: 2, ts: 1_770_000_600_000 }] }),
    );
    assert.deepEqual(markers, [
      { index: 0, name: 'Heating', at: new Date(1_770_000_000_000).toISOString() },
      { index: 2, name: 'Boil', at: new Date(1_770_000_600_000).toISOString() },
    ]);
  });

  it('names the end-of-brew mark, which points past the last stage', () => {
    // The rig writes one final mark whose index is the list's length; without a
    // name of its own it would land on the chart as an empty label.
    const markers = stageMarkersOf(stage({ markers: [{ index: 3, ts: 1_770_000_000_000 }] }));
    assert.equal(markers[0]!.name, 'Brew complete');
  });

  it('has nothing to record for a rig too old to track stages', () => {
    assert.deepEqual(stageMarkersOf(undefined), []);
  });

  it('has nothing to record before the first stage is entered', () => {
    assert.deepEqual(stageMarkersOf(stage({ index: -1, markers: [] })), []);
  });

  it('drops a mark with an unusable timestamp rather than storing an invalid date', () => {
    const markers = stageMarkersOf(
      stage({
        markers: [
          { index: 0, ts: Number.NaN },
          { index: 1, ts: 1_770_000_000_000 },
        ],
      }),
    );
    assert.deepEqual(markers.map((m) => m.index), [1]);
  });
});
