import { useEffect, useState } from 'react';
import { api } from './api';

/** Stepper bounds (°C) and increment. A 1° step suits both fermenter and brewery. */
const MIN_C = 0;
const MAX_C = 40;
const STEP_C = 1;
/** Fallback target when a controller hasn't reported a setpoint yet. */
const FALLBACK_C = 18;

const clamp = (n: number): number => Math.min(MAX_C, Math.max(MIN_C, n));
/** Round to 1 decimal so repeated ±1 steps don't accumulate float drift. */
const round1 = (n: number): number => Math.round(n * 10) / 10;
/** Setpoints land on whole/half degrees, so a small epsilon settles equality. */
const near = (a: number | null, b: number | null): boolean =>
  a != null && b != null && Math.abs(a - b) < 0.05;

interface Props {
  deviceId: number;
  /** The controller's currently reported setpoint (°C), or null if none yet. */
  setpointC: number | null;
  /** A target already queued but not yet confirmed by the controller. */
  pendingC: number | null;
  /** Called after a setpoint is successfully queued (e.g. to refetch status). */
  onApplied?: () => void;
  /** `kiosk` = large touch target, `header` = compact kiosk header, `compact` = laptop sizing. */
  variant?: 'kiosk' | 'header' | 'compact';
}

/**
 * Inline control to change a brew controller's target temperature. The change
 * isn't immediate: tapping Apply queues a setpoint command the device's agent
 * pulls and writes to the hardware (see api.setDeviceSetpoint). Until the
 * controller confirms the new value we show it as "Setting to N°", driven by an
 * optimistic local target plus the server's `pendingSetpointC`, so feedback is
 * instant without waiting on the next poll.
 */
export function SetpointControl({
  deviceId,
  setpointC,
  pendingC,
  onApplied,
  variant = 'kiosk',
}: Props): JSX.Element {
  const kiosk = variant === 'kiosk';
  const header = variant === 'header';
  // The server's current intent: a pending target if one exists, else the
  // controller's reported setpoint.
  const baseline = pendingC ?? setpointC;
  const [draft, setDraft] = useState<number | null>(null);
  // The just-applied target, shown until the server's status catches up — avoids
  // a flicker back to the old value between Apply and the next status poll.
  const [optimistic, setOptimistic] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Drop the optimistic value once the server reflects it (queued or applied).
  useEffect(() => {
    if (optimistic != null && (near(pendingC, optimistic) || near(setpointC, optimistic))) {
      setOptimistic(null);
    }
  }, [optimistic, pendingC, setpointC]);

  const target = draft ?? optimistic ?? baseline ?? FALLBACK_C;
  const applying = optimistic != null || (pendingC != null && !near(pendingC, setpointC));
  const dirty = baseline == null || !near(target, baseline);
  const canApply = dirty && !busy;

  function step(delta: number): void {
    setError(null);
    setDraft(clamp(round1(target + delta)));
  }

  async function apply(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await api.setDeviceSetpoint(deviceId, target);
      setOptimistic(res?.pendingSetpointC ?? target);
      setDraft(null);
      onApplied?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set setpoint');
    } finally {
      setBusy(false);
    }
  }

  const stepBtn = header
    ? 'h-11 w-11 text-2xl active:scale-95'
    : kiosk
      ? 'h-14 w-14 text-3xl active:scale-95'
      : 'h-9 w-9 text-xl active:scale-95';
  const applyBtn = header
    ? 'h-11 px-4 text-base'
    : kiosk
      ? 'px-6 py-3 text-xl'
      : 'px-4 py-2 text-sm';
  const valueText = header ? 'text-3xl' : kiosk ? 'text-4xl sm:text-5xl' : 'text-3xl';
  const labelText = kiosk ? 'text-base' : 'text-xs';
  const shellClass = header
    ? 'shrink-0 rounded-2xl border border-zinc-700 bg-zinc-800/60 px-3 py-2'
    : `rounded-2xl border bg-zinc-800/60 ${
        kiosk ? 'border-zinc-700 p-4 sm:p-5' : 'border-zinc-800 p-4'
      }`;

  return (
    <div className={shellClass}>
      <div className={`flex items-center ${header ? 'gap-3' : 'flex-wrap justify-between gap-3'}`}>
        <div className={header ? 'min-w-[5.75rem]' : undefined}>
          <div className={`font-medium uppercase tracking-wider text-zinc-400 ${labelText}`}>
            Setpoint
          </div>
          <div className={`mt-0.5 ${kiosk ? 'text-sm' : 'text-xs'} text-zinc-500`}>
            {applying ? (
              <span className="text-amber-400">Setting to {target.toFixed(0)}°C…</span>
            ) : setpointC != null ? (
              <>Current {setpointC.toFixed(0)}°C</>
            ) : (
              'No setpoint reported yet'
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => step(-STEP_C)}
            disabled={busy || target <= MIN_C}
            aria-label="Lower setpoint"
            className={`flex shrink-0 items-center justify-center rounded-xl bg-zinc-700 font-bold text-white transition active:bg-zinc-600 disabled:opacity-40 ${stepBtn}`}
          >
            −
          </button>
          <span
            className={`min-w-[3.5ch] text-center font-bold tabular-nums tracking-tight ${valueText}`}
          >
            {target.toFixed(0)}
            <span className={`ml-0.5 font-medium text-zinc-500 ${kiosk ? 'text-xl' : 'text-base'}`}>
              °C
            </span>
          </span>
          <button
            type="button"
            onClick={() => step(STEP_C)}
            disabled={busy || target >= MAX_C}
            aria-label="Raise setpoint"
            className={`flex shrink-0 items-center justify-center rounded-xl bg-zinc-700 font-bold text-white transition active:bg-zinc-600 disabled:opacity-40 ${stepBtn}`}
          >
            +
          </button>
          <button
            type="button"
            onClick={() => void apply()}
            disabled={!canApply}
            className={`rounded-xl font-semibold text-white transition active:scale-[0.98] disabled:opacity-40 ${applyBtn} ${
              canApply ? 'bg-blue-600 active:bg-blue-500' : 'bg-zinc-700'
            }`}
          >
            {busy ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>

      {error && (
        <p className={`${header ? 'mt-1' : 'mt-3'} text-red-400 ${kiosk ? 'text-sm' : 'text-xs'}`}>
          {error}
        </p>
      )}
    </div>
  );
}
