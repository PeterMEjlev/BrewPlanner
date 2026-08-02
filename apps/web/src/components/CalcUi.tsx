import { useEffect, useState } from 'react';

/**
 * The small presentational kit the Tools page's calculators are built from —
 * card, labelled field, number input, result metric. Extracted from the water
 * calculator when the rig's dilution/hydrometer/carbonation tools moved in
 * beside it, so the four read as one page rather than four ports.
 */

/** A titled panel with an optional one-line explanation under the title. */
export function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">{title}</h2>
      {hint && <p className="mt-1 text-xs leading-snug text-zinc-500">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export const fieldClass =
  'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-right text-sm tabular-nums text-zinc-100 outline-none transition focus:border-[#f87a68]';

/** A label/hint stacked over a control (control passed as children). */
export function Field({
  label,
  hint,
  children,
}: {
  label?: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="block">
      {label && <span className="block text-sm font-medium text-zinc-200">{label}</span>}
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
      <span className="flex items-center">{children}</span>
    </label>
  );
}

export function UnitSuffix({ children }: { children: React.ReactNode }): JSX.Element {
  return <span className="ml-2 shrink-0 text-sm text-zinc-500">{children}</span>;
}

/** A compact inline row of derived metrics under an input card. */
export function MetricsLine({ items }: { items: { label: string; value: string }[] }): JSX.Element {
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-zinc-800/60 pt-3 text-xs text-zinc-500">
      {items.map((it, i) => (
        <span key={i}>
          {it.label && <span className="text-zinc-600">{it.label}: </span>}
          <span className="font-medium tabular-nums text-zinc-300">{it.value}</span>
        </span>
      ))}
    </div>
  );
}

/** A boxed result metric: big value + unit/descriptor beneath a label. */
export function Metric({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit: string;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-zinc-100">{value}</div>
      <div className="text-xs text-zinc-500">{unit}</div>
    </div>
  );
}

/**
 * A controlled number input that keeps a local text buffer so partial entries
 * ("0.", "1.2") survive re-renders, syncing to the numeric prop only on a real
 * external change (preset applied, Auto-suggest, etc.). Emits a parsed number.
 *
 * For a field that should stay *empty* until the brewer types — where zero is a
 * different statement from blank — use {@link RawNumField} instead.
 */
export function NumField({
  value,
  onChange,
  step = 1,
  min = 0,
  max,
  ariaLabel,
  id,
}: {
  value: number;
  onChange?: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  ariaLabel?: string;
  id?: string;
}): JSX.Element {
  const [text, setText] = useState(() => trimNum(value));
  useEffect(() => {
    const parsed = parseFloat(text);
    const current = Number.isFinite(parsed) ? parsed : 0;
    if (current !== value) setText(trimNum(value));
    // Only resync when the external numeric value changes, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      step={step}
      min={min}
      max={max}
      value={text}
      aria-label={ariaLabel}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const n = parseFloat(raw);
        onChange?.(Number.isFinite(n) ? Math.max(min, n) : 0);
      }}
      className={fieldClass}
    />
  );
}

/**
 * A number input that hands back the raw text rather than a number.
 *
 * The calculators that recompute as you type need a blank field to mean "no
 * answer yet" — coercing it to 0 the way {@link NumField} does would print a
 * confident, wrong result over an empty form. Parsing is the caller's (see
 * `parseGravity`/`parseNumber` in ../tools), which also lets a field accept the
 * several spellings of a gravity.
 *
 * Kept as `type="text"` with a decimal keypad: a number input silently reports
 * an empty string for entries its own parser rejects, which would take "1,050"
 * away mid-keystroke.
 */
export function RawNumField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
}): JSX.Element {
  return (
    <input
      id={id}
      type="text"
      inputMode="decimal"
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      className={`${fieldClass} placeholder:text-zinc-600`}
    />
  );
}

/** Trim a number to a short, human string (no trailing zeros), '' for non-finite. */
export function trimNum(v: number): string {
  if (!Number.isFinite(v)) return '';
  return String(Math.round(v * 1000) / 1000);
}
