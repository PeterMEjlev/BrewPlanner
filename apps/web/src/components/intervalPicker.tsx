import { REPORTING_INTERVAL_OPTIONS } from '@checklist/shared';
import { Select } from './Select';

/**
 * The logging-cadence picker, in the one shape every screen that offers it
 * shares. A device's `reportingIntervalSec` is how often its agent reads and
 * pushes (each sensor agent adopts whatever the hub advises on its next push —
 * under `deploy/agents`) and, in turn, how often the dashboards poll it.
 *
 * It is offered from the Devices page, from Settings → Sensors, and from an
 * opened chart, so that a brewer looking at a curve that is too coarse can make
 * it finer without first working out which page owns the setting.
 */

/** A cadence as "30s" / "5m" / "1h". */
export function intervalLabel(sec: number): string {
  if (sec < 90) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

/**
 * The selectable cadences, always including whatever the device is on now — a
 * value set before the options changed (or by the device CLI) must still show
 * as the current one rather than as an empty trigger.
 */
export function intervalOptions(seconds: number): { value: number; label: string }[] {
  return Array.from(new Set<number>([...REPORTING_INTERVAL_OPTIONS, seconds]))
    .sort((a, b) => a - b)
    .map((s) => ({ value: s, label: intervalLabel(s) }));
}

export function IntervalSelect({
  seconds,
  onChange,
  className,
  align = 'left',
  label = 'Logging interval',
}: {
  seconds: number;
  onChange: (seconds: number) => void;
  className?: string;
  align?: 'left' | 'right';
  label?: string;
}): JSX.Element {
  return (
    <Select
      value={seconds}
      aria-label={label}
      onChange={onChange}
      align={align}
      className={className}
      options={intervalOptions(seconds)}
    />
  );
}
