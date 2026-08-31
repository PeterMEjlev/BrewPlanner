import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mock from './devices/mock.js';

/**
 * The mock fermenter's target follows a schedule so the charts' stepped target
 * line and its change markers have something to draw against mock data.
 *
 * What has to hold is that the three views of that schedule agree: the
 * synthesized history, the live value, and the change list are read by three
 * different parts of the app, and a marker that lands beside its step instead of
 * on it would look exactly like a bug in the real feature. They agree only
 * because the schedule is a pure function of the moment, which is what these
 * tests pin.
 */

const HOUR = 60 * 60 * 1000;

const fermenter = mock.MOCK_PROFILES.find(
  (p) => p.key === 'fermenter_controller',
)!;
const brewery = mock.MOCK_PROFILES.find((p) => p.key === 'brewery_temp')!;

/** The synthesized target series over a window, oldest first. */
function targetHistory(profile: mock.MockProfile, sinceMs: number): { t: number; value: number }[] {
  return mock
    .mockHistory(profile, mock.mockDeviceId(profile), {
      metric: 'setpoint_c',
      since: new Date(sinceMs).toISOString(),
    })
    .map((r) => ({ t: Date.parse(r.recordedAt), value: r.value }))
    .reverse();
}

describe('the mock fermenter target', () => {
  it('moves across a day rather than sitting on one value', () => {
    // The whole point: a flat series left the target line with no steps and the
    // change markers with nothing to point at.
    const values = new Set(targetHistory(fermenter, Date.now() - 24 * HOUR).map((p) => p.value));
    assert.ok(values.size > 1, `expected the target to move, got ${[...values]}`);
  });

  it('reports a change for every step in its history, at the same moment', () => {
    const since = Date.now() - 24 * HOUR;
    const history = targetHistory(fermenter, since);
    const changes = mock.mockSetpointChanges(fermenter, mock.mockDeviceId(fermenter), {
      since: new Date(since).toISOString(),
    });

    // Every reported change must sit on a step the history actually took, near
    // enough that a marker lands on the corner in the line. The history is
    // sampled at ~240 points across the window, so "near" is one sample.
    const sampleMs = (Date.now() - since) / 240;
    for (const change of changes) {
      const at = Date.parse(change.at);
      const before = [...history].reverse().find((p) => p.t <= at - sampleMs);
      const after = history.find((p) => p.t >= at + sampleMs);
      assert.ok(before && after, `no history either side of ${change.at}`);
      assert.equal(before!.value, change.from, `history before ${change.at}`);
      assert.equal(after!.value, change.to, `history after ${change.at}`);
    }
    assert.ok(changes.length > 0, 'a day should contain at least one step');
  });

  it('reports its changes newest first, as the real query does', () => {
    const changes = mock.mockSetpointChanges(fermenter, mock.mockDeviceId(fermenter), {
      since: new Date(Date.now() - 24 * HOUR).toISOString(),
    });
    const times = changes.map((c) => Date.parse(c.at));
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
  });

  it('agrees with its own live value', () => {
    // The card's "Target 20.0 °C" and the right-hand end of the chart's target
    // line are read from different places; they are the same schedule.
    const status = mock.mockStatus(fermenter);
    const live = status.latest.find((r) => r.metric === 'setpoint_c')!.value;
    const history = targetHistory(fermenter, Date.now() - HOUR);
    assert.equal(history[history.length - 1]!.value, live);
  });

  it('gives the same answer twice, so a poll redraws rather than slides', () => {
    const since = Date.now() - 24 * HOUR;
    const first = mock.mockSetpointChanges(fermenter, mock.mockDeviceId(fermenter), {
      since: new Date(since).toISOString(),
    });
    const second = mock.mockSetpointChanges(fermenter, mock.mockDeviceId(fermenter), {
      since: new Date(since).toISOString(),
    });
    assert.deepEqual(first, second);
  });

  it('keeps its fridge near the target it is chasing', () => {
    // A fridge parked degrees away from its setpoint for hours is a stranger
    // thing for the demo fleet to show than a static target was.
    const id = mock.mockDeviceId(fermenter);
    const temps = mock
      .mockHistory(fermenter, id, {
        metric: 'temp_c',
        since: new Date(Date.now() - 24 * HOUR).toISOString(),
      })
      .map((r) => ({ t: Date.parse(r.recordedAt), value: r.value }));
    const targets = new Map(targetHistory(fermenter, Date.now() - 24 * HOUR).map((p) => [p.t, p.value]));
    const adrift = temps.filter((p) => {
      const target = targets.get(p.t);
      return target != null && Math.abs(p.value - target) > 2;
    });
    // Only the samples mid-step should be far off, and a 45-minute pull is a
    // small slice of a day.
    assert.ok(adrift.length < temps.length * 0.2, `${adrift.length} of ${temps.length} adrift`);
  });
});

describe('the other mock controllers', () => {
  it('leave their targets alone', () => {
    // The brewery's freeze-safety Inkbird and the keg fridge are set once and
    // left for the year; a wandering target would be a worse mock, not a
    // livelier one.
    const values = new Set(targetHistory(brewery, Date.now() - 7 * 24 * HOUR).map((p) => p.value));
    assert.deepEqual([...values], [brewery.base.setpoint_c]);
    assert.deepEqual(mock.mockSetpointChanges(brewery, mock.mockDeviceId(brewery)), []);
  });
});
