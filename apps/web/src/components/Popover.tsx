import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/** The field-shaped trigger most callers want. */
const DEFAULT_TRIGGER =
  'flex max-w-[13rem] items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100';

/**
 * A small anchored popover: a trigger button and a panel that closes on
 * Escape, on a click outside, or when the caller says so.
 *
 * Written rather than pulled in because the two menus on the Bruce page (chat
 * threads, model picker) are the only ones in the app that need more than a
 * native <select> — each row carries a description or its own buttons.
 */
export function Popover({
  label,
  title,
  align = 'left',
  width = 'w-72',
  chevron = true,
  triggerClassName = DEFAULT_TRIGGER,
  children,
}: {
  /** Trigger contents. */
  label: ReactNode;
  /** Tooltip / accessible name for the trigger. */
  title: string;
  align?: 'left' | 'right';
  width?: string;
  /**
   * Whether the trigger carries the little "opens a menu" arrow. An icon-only
   * trigger (the To-Do page's ⋮ button) reads as a menu already, and the arrow
   * only crowds it.
   */
  chevron?: boolean;
  /** Trigger styling, for a menu that isn't shaped like a field. */
  triggerClassName?: string;
  /** Panel contents. Receives `close` so a row can dismiss the menu. */
  children: (close: () => void) => ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={triggerClassName}
      >
        {label}
        {chevron && <span className="text-zinc-600">▾</span>}
      </button>
      {open && (
        <div
          className={`absolute z-20 mt-1.5 ${width} ${align === 'right' ? 'right-0' : 'left-0'} max-h-[70vh] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-1.5 shadow-xl shadow-black/50`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
