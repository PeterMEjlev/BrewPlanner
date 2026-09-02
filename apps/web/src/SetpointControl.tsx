import { useEffect, useState } from 'react';
import { api } from './api';
import { canControl, useAuth } from './auth';

/**
 * Stepper bounds (°C) and increment. A 1° step suits both fermenter and
 * brewery. MIN_C matches the server's `setSetpointSchema` floor so the UI
 * never rejects a value the API would accept.
 */
const MIN_C = -10;
const MAX_C = 35;
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
  /**
   * `kiosk` = large touch target, `header` = compact kiosk header, `compact` =
   * laptop sizing, `inline` = a single dense desktop row with no card chrome.
   */
  variant?: 'kiosk' | 'header' | 'compact' | 'inline';
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
  // Guests (and any non-controlling session) get a read-only view: the current
  // target is shown, but the steppers / input / Apply are dropped. The kiosk on
  // the LAN and admins keep the full control. Hooks below still run for everyone
  // so the read-only branch can reuse the same derived display values.
  const { auth } = useAuth();
  const readOnly = !canControl(auth);

  const kiosk = variant === 'kiosk';
  const header = variant === 'header';
  const inline = variant === 'inline';
  // Typing a value suits the laptop, but the touch variants have no keyboard, so
  // they stay stepper-only.
  const editable = variant === 'compact' || inline;
  // The server's current intent: a pending target if one exists, else the
  // controller's reported setpoint.
  const baseline = pendingC ?? setpointC;
  const [draft, setDraft] = useState<number | null>(null);
  // Raw text while the value field is being typed (so partial entries like "1"
  // aren't clobbered by re-render); null when not editing.
  const [text, setText] = useState<string | null>(null);
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
    setText(null);
    setDraft(clamp(round1(target + delta)));
  }

  function onType(value: string): void {
    setError(null);
    setText(value);
    const n = parseFloat(value);
    if (!Number.isNaN(n)) setDraft(clamp(round1(n)));
  }

  async function apply(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await api.setDeviceSetpoint(deviceId, target);
      setOptimistic(res?.pendingSetpointC ?? target);
      setDraft(null);
      setText(null);
      onApplied?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set setpoint');
    } finally {
      setBusy(false);
    }
  }

  const displayValue = text ?? (target % 1 === 0 ? target.toFixed(0) : target.toFixed(1));

  const stepBtn = header
    ? 'h-11 w-11 text-2xl active:scale-95'
    : kiosk
      ? 'h-14 w-14 text-3xl active:scale-95'
      : inline
        ? 'h-8 w-8 text-lg'
        : 'h-9 w-9 text-xl active:scale-95';
  const applyBtn = header
    ? 'h-11 px-4 text-base'
    : kiosk
      ? 'px-6 py-3 text-xl'
      : inline
        ? 'h-8 px-3.5 text-sm'
        : 'px-4 py-2 text-sm';
  const valueText = header
    ? 'text-3xl'
    : kiosk
      ? 'text-4xl sm:text-5xl'
      : inline
        ? 'text-2xl'
        : 'text-3xl';
  const labelText = kiosk ? 'text-base' : 'text-xs';
  const shellClass = header
    ? 'shrink-0 rounded-2xl border border-zinc-700 bg-zinc-800/60 px-3 py-2'
    : inline
      ? 'rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2'
      : `rounded-2xl border bg-zinc-800/60 ${
          kiosk ? 'border-zinc-700 p-4 sm:p-5' : 'border-zinc-800 p-4'
        }`;

  // Read-only: the label + the current/target value, no controls. Reuses the
  // same `applying`/`displayValue` derivations as the interactive view.
  if (readOnly) {
    return (
      <div className={shellClass}>
        <div
          className={`flex items-center ${
            header ? 'gap-3' : inline ? 'flex-wrap justify-between gap-x-3 gap-y-2' : 'flex-wrap justify-between gap-3'
          }`}
        >
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
          <span
            className={`flex items-baseline justify-center font-bold tabular-nums tracking-tight ${valueText}`}
          >
            <span className="min-w-[3.5ch] text-center">{displayValue}</span>
            <span
              className={`ml-0.5 font-medium text-zinc-500 ${
                kiosk ? 'text-xl' : inline ? 'text-sm' : 'text-base'
              }`}
            >
              °C
            </span>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={shellClass}>
      <div
        className={`flex items-center ${
          header ? 'gap-3' : inline ? 'flex-wrap justify-between gap-x-3 gap-y-2' : 'flex-wrap justify-between gap-3'
        }`}
      >
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

        <div className={`flex items-center ${inline ? 'gap-2' : 'gap-3'}`}>
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
            className={`flex items-baseline justify-center font-bold tabular-nums tracking-tight ${valueText}`}
          >
            {editable ? (
              <input
                type="number"
                inputMode="decimal"
                min={MIN_C}
                max={MAX_C}
                step={STEP_C}
                value={displayValue}
                disabled={busy}
                onChange={(e) => onType(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={() => setText(null)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                    if (canApply) void apply();
                  }
                }}
                aria-label="Setpoint value"
                className="w-[3ch] rounded-md bg-transparent text-center font-bold tabular-nums tracking-tight outline-none focus:ring-2 focus:ring-cyan-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
            ) : (
              <span className="min-w-[3.5ch] text-center">{displayValue}</span>
            )}
            <span
              className={`ml-0.5 font-medium text-zinc-500 ${
                kiosk ? 'text-xl' : inline ? 'text-sm' : 'text-base'
              }`}
            >
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
              canApply
                ? 'bg-gradient-to-br from-[#f87a68] to-[#e0463f] shadow active:brightness-110'
                : 'bg-zinc-700'
            }`}
          >
            {busy ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>

      {error && (
        <p className={`${header || inline ? 'mt-1' : 'mt-3'} text-red-400 ${kiosk ? 'text-sm' : 'text-xs'}`}>
          {error}
        </p>
      )}
    </div>
  );
}
