import { ReferenceLine, usePlotArea } from 'recharts';
import type { SetpointMarker } from '../useDeviceData';
import { dateTime } from '../util';
import { BADGE_FONT, badgeBox, setpointChangeLabel } from './eventMarkers';

/**
 * The vertical "the brewer moved the target here" markers on the enlarged
 * temperature chart (see `SetpointChange` in @checklist/shared for where they
 * come from).
 *
 * A temperature curve on its own can't distinguish a fridge that drifted from a
 * fridge that was *told* to go somewhere else: both look like the line leaving
 * its old level. Marking the moment the target changed is what separates the
 * two, and it is usually the more interesting of the pair — a cold crash, a
 * diacetyl rest, a correction after a stuck ferment.
 *
 * This module owns the recharts flavour; the Overview's mini charts draw their
 * own from the same data and the same maths (see `markers` on
 * MultiLineSparkline in charts.tsx, and eventMarkers.ts).
 */

/**
 * One marker: a dashed vertical line, a small pin at the top to aim at, and —
 * while the pointer is over it — a badge naming the change and when it happened.
 *
 * Rendered through ReferenceLine's `label`, which clones it with the line's own
 * geometry as `viewBox`, so the marker never has to work out where recharts put
 * it. It has to be handed over as an *element* rather than a render function:
 * recharts turns a function label into a component type, and since that type
 * would be a fresh closure on every render, React would tear the marker down and
 * rebuild it each time — losing the pointer that was hovering it.
 */
function SetpointChangeMarker({
  viewBox,
  change,
  color,
  active,
  onHover,
}: {
  /** The reference line's box, supplied by recharts: zero-width, plot-tall. */
  viewBox?: { x: number; y: number; height: number };
  change: SetpointMarker;
  color: string;
  active: boolean;
  onHover: (change: SetpointMarker | null) => void;
}): JSX.Element | null {
  const plot = usePlotArea();
  if (!viewBox) return null;
  const { x, y, height } = viewBox;
  const lines = [setpointChangeLabel(change), dateTime(change.t)];
  const badge = badgeBox(x, y, lines, plot ?? null);

  return (
    <g>
      {/* Hit area: wider than the line, because a 1.5px target is not one. */}
      <rect
        x={x - 9}
        y={y}
        width={18}
        height={height}
        fill="transparent"
        pointerEvents="all"
        onPointerEnter={() => onHover(change)}
        onPointerLeave={() => onHover(null)}
      />
      {/* Pin at the top, so the marker is findable without hunting for the line. */}
      <path d={`M${x - 4.5},${y} L${x + 4.5},${y} L${x},${y + 7} Z`} fill={color} />
      {active && (
        // Pointer-transparent: the badge overlaps the hit area it was opened
        // from, and capturing the pointer would make it flicker itself away.
        <g pointerEvents="none">
          <rect
            x={badge.x}
            y={badge.y}
            width={badge.width}
            height={badge.height}
            rx={6}
            fill="#0f172a"
            stroke="#1e293b"
          />
          <text
            x={badge.textX}
            y={badge.lineY[0]}
            fontSize={BADGE_FONT}
            fontWeight={600}
            fill={color}
          >
            {lines[0]}
          </text>
          <text x={badge.textX} y={badge.lineY[1]} fontSize={BADGE_FONT} fill="#94a3b8">
            {lines[1]}
          </text>
        </g>
      )}
    </g>
  );
}

/**
 * The markers for a chart, as recharts elements. A plain function rather than a
 * component so the ReferenceLines land as direct children of the chart, which is
 * what recharts wants; spread the result into the chart's JSX.
 *
 * `ifOverflow="discard"` drops a marker whose moment has been zoomed or panned
 * off screen — with `hidden` the line would be clipped but its pin and hit area
 * would still sit on the plot's edge, offering a tooltip for a change that isn't
 * in view.
 */
export function setpointChangeLines({
  changes,
  color,
  hovered,
  onHover,
}: {
  changes: SetpointMarker[];
  color: string;
  /** The marker the pointer is currently over, if any. */
  hovered: SetpointMarker | null;
  onHover: (change: SetpointMarker | null) => void;
}): JSX.Element[] {
  return changes.map((change) => {
    const active = hovered?.t === change.t;
    return (
      <ReferenceLine
        key={change.t}
        x={change.t}
        stroke={color}
        strokeWidth={active ? 2 : 1.5}
        strokeOpacity={active ? 1 : 0.7}
        strokeDasharray="3 4"
        ifOverflow="discard"
        label={
          <SetpointChangeMarker
            change={change}
            color={color}
            active={active}
            onHover={onHover}
          />
        }
      />
    );
  });
}
