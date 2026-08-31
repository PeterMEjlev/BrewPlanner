import { Suspense, lazy } from 'react';
import { Link } from 'react-router-dom';
import { ChartOverlay } from './ChartOverlay';

// recharts lives behind this lazy boundary, so opening a chart is the only thing
// that pulls it onto the Overview — the dashboard bundle itself stays lean.
const MetricChart = lazy(() => import('./MetricChart'));

/**
 * An enlarge-on-click overlay: the selected metric's chart floats in a card over
 * a dimmed dashboard, instead of navigating to the full device page. The card,
 * the backdrop and the two ways out are [ChartOverlay]'s.
 */
export function MetricModal({
  deviceId,
  metric,
  title,
  targetC,
  targetDeviceId,
  onClose,
}: {
  deviceId: number;
  metric?: string;
  title: string;
  /** Target temp for a chart whose device has no setpoint of its own. */
  targetC?: number;
  /** The controller that target belongs to, for its change markers. */
  targetDeviceId?: number;
  onClose: () => void;
}): JSX.Element {
  const fullPageHref = metric
    ? `/devices/${deviceId}?metric=${encodeURIComponent(metric)}`
    : `/devices/${deviceId}`;

  return (
    <ChartOverlay
      title={title}
      onClose={onClose}
      action={
        <Link
          to={fullPageHref}
          className="rounded-lg px-2.5 py-1.5 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
        >
          Full page ↗
        </Link>
      }
    >
      <Suspense fallback={<p className="py-24 text-center text-sm text-zinc-500">Loading chart…</p>}>
        <MetricChart
          deviceId={deviceId}
          initialMetric={metric}
          chartHeight={300}
          targetC={targetC}
          targetDeviceId={targetDeviceId}
        />
      </Suspense>
    </ChartOverlay>
  );
}
