import { ReferenceLine, usePlotArea } from 'recharts';
import type { SetpointMarker } from '../useDeviceData';
import { dateTime } from '../util';
import { BADGE_FONT, badgeBox, setpointChangeLabel } from './eventMarkers';

/**
 * Hover regions over the moments the brewer moved the target on the enlarged
 * temperature chart (see `SetpointChange` in @checklist/shared for where those
 * come from).
 *
 * They draw no mark of their own. The target is plotted as a stepped line, so a
 * change is already visible as the corner where that line leaves one level for
 * the next — a vertical rule through it would be the same fact drawn twice.
 * What the corner can't say is what the two levels were and exactly when it
 * turned, and that is what hovering one of these gets you.
 *
 * This module owns the recharts flavour; the Overview's mini charts do the same
 * from the same data (see `markers` on MultiLineSparkline in charts.tsx).
 */

/**
 * One marker: a transparent column over the moment, and — while the pointer is
 * inside it — a badge naming the change and when it happened.
 *
 * The column rides on an invisible ReferenceLine, which is what gives it a
 * position: recharts clones the label with the line's own geometry as `viewBox`,
 * so the marker never has to work out where the chart put its x. It has to be
 * handed over as an *element* rather than a render function: recharts turns a
 * function label into a component type, and since that type would be a fresh
 * closure on every render, React would tear the marker down and rebuild it each
 * time — losing the pointer that was hovering it.
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
      {/* Wide enough to catch a pointer aimed at the step in the target line,
          which is the only thing visible here to aim at. */}
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
 * The lines themselves are drawn with no stroke — they exist to place their
 * labels, which carry the hover region. `ifOverflow="discard"` then drops a
 * marker whose moment has been zoomed or panned off screen; with `hidden` the
 * hit area would still sit on the plot's edge, offering a tooltip for a change
 * that isn't in view.
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
        stroke="none"
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
