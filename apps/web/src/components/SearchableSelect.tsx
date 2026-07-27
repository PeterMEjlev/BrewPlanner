import type { IngredientKind, RecipeIngredientOption } from '@checklist/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../api';

export interface SearchableOption {
  value: string;
  label?: string;
  description?: string;
  ebc?: number | null;
  aa?: number | null;
}

interface SearchableSelectProps {
  label: string;
  value: string;
  options: SearchableOption[];
  onChange: (value: string, option?: SearchableOption) => void;
  onSearchChange?: (query: string) => void;
  placeholder?: string;
  required?: boolean;
  loading?: boolean;
  allowCustom?: boolean;
  className?: string;
  testId?: string;
}

const inputClass =
  'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 pr-16 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-[#f06a5c] focus:ring-1 focus:ring-[#f06a5c]/40';

/** Text input + filtered listbox. Typed values remain valid custom selections. */
export function SearchableSelect({
  label,
  value,
  options,
  onChange,
  onSearchChange,
  placeholder = 'Search or type a custom value…',
  required = false,
  loading = false,
  allowCustom = true,
  className = '',
  testId,
}: SearchableSelectProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!open) setText(value);
  }, [open, value]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  const shown = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return options.slice(0, 60);
    return options
      .filter((option) => {
        const haystack = `${option.label ?? option.value} ${option.description ?? ''}`.toLocaleLowerCase();
        return words.every((word) => haystack.includes(word));
      })
      .slice(0, 60);
  }, [options, query]);

  useEffect(() => setActiveIndex(0), [query, options]);

  function choose(option: SearchableOption): void {
    setText(option.value);
    setQuery('');
    onChange(option.value, option);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className={`relative block text-xs font-medium text-zinc-400 ${className}`}>
      <span>{label}</span>
      <div className="relative mt-1">
        <input
          data-testid={testId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={label}
          className={inputClass}
          value={text}
          required={required}
          placeholder={placeholder}
          autoComplete="off"
          onFocus={(event) => {
            setOpen(true);
            setQuery('');
            onSearchChange?.('');
            event.currentTarget.select();
          }}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            setQuery(next);
            onChange(next);
            onSearchChange?.(next);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) => Math.min(index + 1, Math.max(0, shown.length - 1)));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((index) => Math.max(0, index - 1));
            } else if (event.key === 'Enter' && open && shown[activeIndex]) {
              event.preventDefault();
              choose(shown[activeIndex]!);
            } else if (event.key === 'Escape') {
              setOpen(false);
            }
          }}
        />
        {text && (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Clear ${label}`}
            onClick={() => {
              setText('');
              setQuery('');
              onChange('');
              onSearchChange?.('');
              setOpen(true);
            }}
            className="absolute inset-y-0 right-8 flex w-8 items-center justify-center text-zinc-600 hover:text-zinc-200"
          >
            ×
          </button>
        )}
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Open ${label}`}
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next) {
              setQuery('');
              onSearchChange?.('');
            }
          }}
          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-zinc-500 hover:text-zinc-200"
        >
          {open ? '▴' : '▾'}
        </button>
      </div>

      {open && (
        <div
          id={listId}
          role="listbox"
          className="absolute z-40 mt-1 max-h-64 w-full min-w-[240px] overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950 p-1 shadow-2xl"
        >
          {loading && <div className="px-3 py-2 text-xs text-zinc-500">Searching…</div>}
          {!loading && shown.map((option, index) => (
            <button
              key={`${option.value}:${index}`}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option)}
              className={`block w-full rounded-md px-3 py-2 text-left transition ${index === activeIndex ? 'bg-zinc-800' : 'hover:bg-zinc-900'}`}
            >
              <span className="block text-sm font-medium text-zinc-100">{option.label ?? option.value}</span>
              {option.description && <span className="mt-0.5 block text-[11px] text-zinc-500">{option.description}</span>}
            </button>
          ))}
          {!loading && shown.length === 0 && (
            <div className="px-3 py-2 text-xs text-zinc-500">
              {allowCustom && text.trim() ? `Using custom value “${text.trim()}”.` : 'No matching options.'}
            </div>
          )}
          {allowCustom && text.trim() && !shown.some((option) => option.value.toLocaleLowerCase() === text.trim().toLocaleLowerCase()) && (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(text.trim());
                setText(text.trim());
                setOpen(false);
              }}
              className="mt-1 block w-full rounded-md border-t border-zinc-800 px-3 py-2 text-left text-xs text-[#f58a78] hover:bg-zinc-900"
            >
              Use custom value “{text.trim()}”
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function IngredientSearchSelect({
  kind,
  label,
  value,
  onChange,
  className,
  required = true,
}: {
  kind: IngredientKind;
  label: string;
  value: string;
  onChange: (value: string, option?: Pick<RecipeIngredientOption, 'ebc' | 'aa'>) => void;
  className?: string;
  required?: boolean;
}): JSX.Element {
  const [search, setSearch] = useState<string | null>(null);
  const [options, setOptions] = useState<SearchableOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (search == null) return;
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void api.searchRecipeIngredients(kind, search)
        .then((results) => {
          if (cancelled) return;
          setOptions(results.map((option) => {
            const maltColour = kind === 'fermentable' && option.ebc != null
              ? option.ebcMin != null && option.ebcMax != null && option.ebcMin !== option.ebcMax
                ? `${formatMetadata(option.ebcMin)}–${formatMetadata(option.ebcMax)} EBC`
                : `${formatMetadata(option.ebc)} EBC`
              : null;
            const hopAlpha = kind === 'hop' && option.aa != null
              ? `${formatMetadata(option.aa)}% AA`
              : null;
            const brewingMetadata = maltColour ?? hopAlpha;
            return {
              value: option.name,
              label: brewingMetadata ? `${option.name} · ${brewingMetadata}` : option.name,
              description: option.source === 'catalogue' ? 'Local ingredient catalogue' : 'Used in a saved recipe',
              ebc: option.ebc ?? null,
              aa: option.aa ?? null,
            };
          }));
        })
        .catch(() => {
          if (!cancelled) setOptions([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [kind, search]);

  return (
    <SearchableSelect
      label={label}
      value={value}
      options={options}
      onChange={(next, option) => onChange(next, option ? { ebc: option.ebc, aa: option.aa } : undefined)}
      onSearchChange={setSearch}
      loading={loading}
      required={required}
      className={className}
    />
  );
}

function formatMetadata(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}
