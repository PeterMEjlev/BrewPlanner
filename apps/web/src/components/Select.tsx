import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface SelectOption<Value extends string | number = string> {
  value: Value;
  /** Shown instead of the raw value. */
  label?: string;
  /** A second line under the label, for a row that needs explaining. */
  description?: string;
  /**
   * Colour dot in front of the label, as #rrggbb — the same cue a style or a
   * malt carries in the recipe pickers.
   */
  swatchColor?: string | null;
  /** Listed but not selectable, shown greyed rather than dropped. */
  disabled?: boolean;
}

interface SelectProps<Value extends string | number> {
  value: Value;
  options: readonly SelectOption<Value>[];
  onChange: (value: Value) => void;
  /** Classes for the trigger — pass the page's own field styling. */
  className?: string;
  /** Extra classes for the menu, e.g. a wider `min-w-` for short triggers. */
  menuClassName?: string;
  /** Which edge the menu lines up with when it is wider than the trigger. */
  align?: 'left' | 'right';
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  title?: string;
  /** Shown on the trigger when the value matches no option and is empty. */
  placeholder?: string;
  testId?: string;
}

/** How tall the menu is allowed to get, and how close it may sit to the edge. */
const MAX_MENU_HEIGHT = 320;
const VIEWPORT_MARGIN = 8;

/**
 * A dropdown built out of the same parts as the recipe pickers: a field-shaped
 * trigger and a rounded dark panel of rows.
 *
 * A native <select> can be styled down to its border and no further — the list
 * it opens is drawn by the OS, so every menu in the app came out as a square
 * grey Windows popup next to rounded panels. This renders the list itself so
 * one style holds everywhere, and keeps the keyboard behaviour a <select> has:
 * arrows and Home/End move, Enter picks, Escape closes, typing jumps.
 *
 * The panel is portalled and positioned against the viewport so it is never
 * clipped by a card that scrolls or hides its overflow — including the sort
 * picker that lives inside {@link SearchableSelect}'s own dropdown.
 */
export function Select<Value extends string | number>({
  value,
  options,
  onChange,
  className = '',
  menuClassName = '',
  align = 'left',
  disabled = false,
  id,
  title,
  placeholder,
  testId,
  'aria-label': ariaLabel,
}: SelectProps<Value>): JSX.Element {
  const domId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const [activeIndex, setActiveIndex] = useState(Math.max(0, selectedIndex));
  // What has been typed in the last moment, for jump-to-letter.
  const typed = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  // When a click outside last shut the menu. Several of these sit inside a
  // <label>, which forwards a click on its caption to the button — without this
  // the click that dismissed the menu would immediately reopen it.
  const closedAt = useRef(0);

  const selected = selectedIndex === -1 ? undefined : options[selectedIndex];
  const labelOf = (option: SelectOption<Value>): string => option.label ?? String(option.value);

  // A lock closing over an open menu would leave it floating above a trigger
  // that no longer answers.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const place = useCallback((): void => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const box = trigger.getBoundingClientRect();
    const below = window.innerHeight - box.bottom - VIEWPORT_MARGIN;
    const above = box.top - VIEWPORT_MARGIN;
    // Below unless the space above is both bigger and worth using — a menu
    // squeezed into 60px at the bottom of the screen reads as broken.
    const dropUp = below < Math.min(MAX_MENU_HEIGHT, above) && above > below;
    const maxHeight = Math.max(120, Math.min(MAX_MENU_HEIGHT, dropUp ? above : below));
    const width = Math.max(box.width, 160);
    const left = align === 'right' ? box.right - width : box.left;
    setRect({
      // Pinned by the edge that touches the trigger, so a short list sits
      // against it either way instead of floating at the top of its allowance.
      top: dropUp ? undefined : box.bottom + 4,
      bottom: dropUp ? window.innerHeight - box.top + 4 : undefined,
      left: Math.min(Math.max(VIEWPORT_MARGIN, left), window.innerWidth - width - VIEWPORT_MARGIN),
      width,
      maxHeight,
    });
  }, [align]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    // Follows the trigger rather than closing on it: these sit in cards and
    // panels that scroll under a menu the user is still reading.
    const reposition = (): void => place();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closedAt.current = Date.now();
      setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  // Keep the highlighted row on screen as the arrows walk a long list.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  function openMenu(): void {
    setActiveIndex(Math.max(0, selectedIndex));
    setOpen(true);
  }

  function choose(index: number): void {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  /** Next selectable row in `step` direction, wrapping at neither end. */
  function move(from: number, step: number): number {
    for (let index = from + step; index >= 0 && index < options.length; index += step) {
      if (!options[index]?.disabled) return index;
    }
    return from;
  }

  function firstEnabled(step: 1 | -1): number {
    const from = step === 1 ? -1 : options.length;
    return move(from, step);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'Escape') {
      // Claim the key while the menu is open: the shell reads Escape as "back to
      // the dashboard" unless a handler has taken it, and a native <select> used
      // to be exempt by tag name. The menu closes; the page stays put.
      if (open) {
        event.preventDefault();
        event.stopPropagation();
      }
      setOpen(false);
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (!open) {
      if ([' ', 'Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => move(index, 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => move(index, -1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(firstEnabled(1));
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(firstEnabled(-1));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      // Same as a <select>: keep typing to narrow, pause and it starts over.
      const text = (now - typed.current.at < 800 ? typed.current.text : '') + event.key.toLowerCase();
      typed.current = { text, at: now };
      const match = options.findIndex(
        (option) => !option.disabled && labelOf(option).toLowerCase().startsWith(text),
      );
      if (match !== -1) setActiveIndex(match);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${domId}-list`}
        aria-activedescendant={open ? `${domId}-option-${activeIndex}` : undefined}
        aria-label={ariaLabel}
        title={title}
        data-testid={testId}
        disabled={disabled}
        onClick={() => {
          if (open) setOpen(false);
          else if (Date.now() - closedAt.current > 250) openMenu();
        }}
        onKeyDown={onKeyDown}
        className={`inline-flex cursor-pointer items-center justify-between gap-2 text-left disabled:cursor-not-allowed ${className}`}
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected?.swatchColor != null && (
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-white/70"
              style={{ backgroundColor: selected.swatchColor }}
              aria-hidden
            />
          )}
          <span className="min-w-0">
            <span className={`block truncate ${selected ? '' : 'text-zinc-500'}`}>
              {selected ? labelOf(selected) : (String(value) || placeholder || '')}
            </span>
            {/* Holds the widest option's width open — zero-height and clipped,
                so it costs no space — the way a native select is sized by its
                longest option instead of resizing with every choice made. */}
            <span aria-hidden className="invisible block h-0 overflow-hidden">
              {options.map((option, index) => (
                <span key={`${option.value}:${index}`} className="block whitespace-pre">
                  {labelOf(option)}
                </span>
              ))}
            </span>
          </span>
        </span>
        <span aria-hidden className="shrink-0 text-zinc-500">{open ? '▴' : '▾'}</span>
      </button>

      {open && rect != null && createPortal(
        <div
          ref={menuRef}
          id={`${domId}-list`}
          role="listbox"
          aria-label={ariaLabel}
          // Marks the panel as part of a dropdown for anything that closes on a
          // click outside itself: portalled here, it is outside every one of
          // them in the DOM, and picking a sort order must not shut the popup
          // the picker is pinned inside.
          data-select-menu=""
          style={{
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            width: rect.width,
            maxHeight: rect.maxHeight,
          }}
          className={`fixed z-[60] overflow-y-auto overscroll-contain rounded-lg border border-zinc-700 bg-zinc-950 p-1 shadow-2xl shadow-black/50 ${menuClassName}`}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            return (
              <button
                key={`${option.value}:${index}`}
                id={`${domId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled}
                disabled={option.disabled}
                data-active={index === activeIndex}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                onClick={() => choose(index)}
                className={`block w-full rounded-md px-3 py-2 text-left text-sm transition ${
                  option.disabled
                    ? 'cursor-not-allowed opacity-40'
                    : index === activeIndex ? 'bg-zinc-800' : 'hover:bg-zinc-900'
                }`}
              >
                <span className="flex items-center gap-2">
                  {option.swatchColor != null && (
                    <span
                      className="h-3 w-3 shrink-0 rounded-full ring-1 ring-white/70"
                      style={{ backgroundColor: option.swatchColor }}
                      aria-hidden
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate ${isSelected ? 'font-semibold text-zinc-100' : 'text-zinc-300'}`}>
                      {labelOf(option)}
                    </span>
                    {option.description && (
                      <span className="mt-0.5 block text-[11px] text-zinc-500">{option.description}</span>
                    )}
                  </span>
                  {isSelected && <span aria-hidden className="shrink-0 text-xs text-zinc-400">✓</span>}
                </span>
              </button>
            );
          })}
          {options.length === 0 && (
            <div className="px-3 py-2 text-xs text-zinc-500">Nothing to choose from.</div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
