import type { IngredientKind, RecipeIngredientOption, RecipeYeastSpec } from '@checklist/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../api';

export interface SearchableOption {
  value: string;
  label?: string;
  description?: string;
  ebc?: number | null;
  aa?: number | null;
  /** Producer figures for a yeast strain, for the editor to fill the line in with. */
  yeast?: RecipeYeastSpec | null;
  /**
   * A word about what kind of thing this is, shown as a chip in front of the
   * name — an ale or a lager yeast, which is the first thing a brewer sorts a
   * strain list by. The caller owns the colour so this component stays free of
   * any one dropdown's vocabulary.
   */
  badge?: { text: string; className: string } | null;
  /**
   * Colour to show as a dot beside the option, as #rrggbb — the same keg-board
   * palette a style pours as everywhere else in the app. Set for beer styles, so
   * a category dropdown reads as the spread of beers it is rather than a list
   * of names. Null for a style the palette doesn't recognise.
   */
  swatchColor?: string | null;
  /**
   * Listed but not selectable. Shown greyed rather than dropped so the option's
   * absence reads as a precondition the caller can explain, not as a gap.
   */
  disabled?: boolean;
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
  disabled?: boolean;
  /**
   * Controls pinned above the list — the yeast picker's sort order. Stays put
   * while the list scrolls under it, and lives inside the dropdown so using it
   * doesn't count as clicking away.
   */
  header?: React.ReactNode;
  /**
   * How many matches to list. The default suits a dropdown being read top-down;
   * a list the caller has sorted deliberately wants all of it, or the sort only
   * reaches whichever slice happened to survive.
   */
  maxShown?: number;
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
  disabled = false,
  header,
  maxShown = 60,
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

  // A lock closing over an open dropdown would leave it floating over a field
  // that no longer accepts the click.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  const shown = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return options.slice(0, maxShown);
    return options
      .filter((option) => {
        const haystack = `${option.label ?? option.value} ${option.description ?? ''}`.toLocaleLowerCase();
        return words.every((word) => haystack.includes(word));
      })
      .slice(0, maxShown);
  }, [options, query, maxShown]);

  useEffect(() => setActiveIndex(0), [query, options]);

  function choose(option: SearchableOption): void {
    // Covers the Enter key too, which reaches this without passing the button.
    if (option.disabled) return;
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
          className={`${inputClass} disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-400`}
          value={text}
          required={required}
          placeholder={placeholder}
          autoComplete="off"
          disabled={disabled}
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
        {!disabled && text && (
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
          disabled={disabled}
          aria-label={`Open ${label}`}
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next) {
              setQuery('');
              onSearchChange?.('');
            }
          }}
          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-zinc-500 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:text-zinc-700"
        >
          {open ? '▴' : '▾'}
        </button>
      </div>

      {open && (
        <div
          id={listId}
          role="listbox"
          className="absolute z-40 mt-1 flex max-h-[26rem] w-full min-w-[240px] flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950 shadow-2xl"
        >
          {/* Outside the scrolling area rather than stuck to the top of it: a
              sticky bar still has the list sliding through the padding strip
              above it, which reads as rows disappearing behind the controls. */}
          {header && (
            <div className="shrink-0 border-b border-zinc-800 px-2 py-1.5">{header}</div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {loading && <div className="px-3 py-2 text-xs text-zinc-500">Searching…</div>}
            {!loading && shown.map((option, index) => (
              <button
                key={`${option.value}:${index}`}
                type="button"
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled}
                disabled={option.disabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
                className={`block w-full rounded-md px-3 py-2 text-left transition ${
                  option.disabled
                    ? 'cursor-not-allowed opacity-40'
                    : index === activeIndex ? 'bg-zinc-800' : 'hover:bg-zinc-900'
                }`}
              >
                <span className="flex items-start gap-2">
                  {option.swatchColor != null && (
                    <span
                      className="mt-1 h-3 w-3 shrink-0 rounded-full ring-1 ring-white/70"
                      style={{ backgroundColor: option.swatchColor }}
                      aria-hidden
                    />
                  )}
                  {option.badge && (
                    <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${option.badge.className}`}>
                      {option.badge.text}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-zinc-100">{option.label ?? option.value}</span>
                    {option.description && <span className="mt-0.5 block text-[11px] text-zinc-500">{option.description}</span>}
                  </span>
                </span>
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
  disabled = false,
}: {
  kind: IngredientKind;
  label: string;
  value: string;
  onChange: (value: string, option?: Pick<RecipeIngredientOption, 'ebc' | 'aa' | 'yeast'>) => void;
  className?: string;
  required?: boolean;
  disabled?: boolean;
}): JSX.Element {
  const [search, setSearch] = useState<string | null>(null);
  const [options, setOptions] = useState<SearchableOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<YeastSortKey>('attenuation');

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
            const usedBefore = option.source === 'recipe';
            return {
              value: option.name,
              label: brewingMetadata ? `${option.name} · ${brewingMetadata}` : option.name,
              // A strain is chosen on its numbers, so a yeast lists them where
              // the other kinds list where the name came from.
              description: kind === 'yeast'
                ? yeastSummary(option.yeast, usedBefore)
                : usedBefore ? 'Used in a saved recipe' : 'Local ingredient catalogue',
              badge: kind === 'yeast' ? yeastBadge(option.yeast) : null,
              ebc: option.ebc ?? null,
              aa: option.aa ?? null,
              yeast: option.yeast ?? null,
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

  const sorted = useMemo(
    () => (kind === 'yeast' ? sortYeastOptions(options, sort) : options),
    [kind, options, sort],
  );

  return (
    <SearchableSelect
      label={label}
      value={value}
      options={sorted}
      onChange={(next, option) =>
        onChange(next, option ? { ebc: option.ebc, aa: option.aa, yeast: option.yeast } : undefined)
      }
      onSearchChange={setSearch}
      loading={loading}
      required={required}
      className={className}
      disabled={disabled}
      header={kind === 'yeast' ? <YeastSortPicker value={sort} onChange={setSort} /> : undefined}
      // The whole shelf, because it is sorted rather than merely listed: cutting
      // it at 60 would mean "sort by tolerance" reordering a fixed 60 strains.
      maxShown={kind === 'yeast' ? 250 : undefined}
    />
  );
}

function formatMetadata(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

// ---------------------------------------------------------------------------
// The yeast picker: what a strain looks like in the list, and in what order
// ---------------------------------------------------------------------------

/** What the list can be ordered by, in the order the picker offers them. */
const YEAST_SORTS = [
  ['attenuation', 'Attenuation'],
  ['type', 'Type'],
  ['temp', 'Optimum temp'],
  ['flocculation', 'Flocculation'],
  ['form', 'Form'],
  ['lab', 'Lab'],
  ['name', 'Name'],
  ['tolerance', 'Alcohol tolerance'],
] as const;

type YeastSortKey = (typeof YEAST_SORTS)[number][0];

function YeastSortPicker({ value, onChange }: { value: YeastSortKey; onChange: (value: YeastSortKey) => void }): JSX.Element {
  return (
    <label className="flex items-center gap-2 text-[11px] text-zinc-500">
      Sort by
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as YeastSortKey)}
        className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 outline-none focus:border-[#f06a5c]"
      >
        {YEAST_SORTS.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
      </select>
    </label>
  );
}

/**
 * How the strain ferments, coloured the way it works: ales warm, lagers cool,
 * a souring strain by the acidity it makes, brett by being neither. A wheat or
 * wit strain is an ale yeast and is chipped as one — the badge answers "what
 * will this do to my wort", which is why nothing in the list goes unlabelled.
 */
function yeastBadge(spec: RecipeYeastSpec | null | undefined): SearchableOption['badge'] {
  switch (spec?.type?.trim().toLowerCase()) {
    case 'ale':
    case 'wheat':
      return { text: 'Ale', className: 'bg-amber-500/15 text-amber-300 ring-amber-500/30' };
    case 'lager':
      return { text: 'Lager', className: 'bg-sky-500/15 text-sky-300 ring-sky-500/30' };
    // Souring strains ferment and acidify in the same pitch, so they are their
    // own thing rather than an ale that happens to be used in a sour.
    case 'sour':
      return { text: 'Sour', className: 'bg-rose-500/15 text-rose-300 ring-rose-500/30' };
    case 'brett':
      return { text: 'Brett', className: 'bg-violet-500/15 text-violet-300 ring-violet-500/30' };
    case 'bacteria':
      return { text: 'Bacteria', className: 'bg-lime-500/15 text-lime-300 ring-lime-500/30' };
    // Not a beer strain at all, which is the useful thing to say about it.
    case 'wine':
      return { text: 'Wine', className: 'bg-zinc-500/15 text-zinc-300 ring-zinc-500/30' };
    default:
      return null;
  }
}

/** The figures a strain is picked on, on one line under its name. */
function yeastSummary(spec: RecipeYeastSpec | null | undefined, usedBefore: boolean): string {
  const parts = [
    spec?.attenuation ? `${spec.attenuation}% att` : null,
    spec?.minTempC != null && spec.maxTempC != null
      ? `${spec.minTempC}–${spec.maxTempC} °C`
      : spec?.minTempC != null ? `from ${spec.minTempC} °C` : null,
    spec?.flocculation || null,
    spec?.form || null,
    // Named rather than just stated, because the producers quote it two ways:
    // "12%" from one and "Medium-High" from the next, and an unlabelled
    // "Medium-High" would read as a second flocculation.
    spec?.alcoholTolerance ? `${spec.alcoholTolerance} tol.` : null,
    usedBefore ? 'used before' : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

/** The lowest number in a stated attenuation — "9-11%" reads as 9. */
function leadingNumber(text: string | undefined): number | null {
  const parsed = Number.parseFloat((text ?? '').replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Roughly where each word sits on the percentage scale it stands in for. */
const TOLERANCE_WORDS: Record<string, number> = {
  low: 5,
  medium: 8,
  'medium-high': 12,
  high: 15,
  'very high': 18,
};

/**
 * One scale for a figure two producers state differently: Fermentis says
 * "9-11%" and White Labs says "Medium-High" about strains that stand up to
 * much the same beer, so the words are placed on the percentage scale rather
 * than sorted as text after every number.
 */
function toleranceRank(text: string | undefined): number | null {
  const stated = (text ?? '').trim().toLowerCase();
  if (!stated) return null;
  return TOLERANCE_WORDS[stated] ?? leadingNumber(stated);
}

/** Low to high, the way flocculation is described rather than alphabetically. */
const FLOCCULATION_ORDER = ['low', 'medium-low', 'medium', 'medium-high', 'high'];

/**
 * Order the strain list by one of its columns. Ascending throughout — least
 * attenuative, coolest, least flocculent first — and anything the producer
 * leaves unstated sinks to the bottom rather than sorting as a zero. Ties fall
 * back to the name so the list never reshuffles between renders.
 */
function sortYeastOptions(options: SearchableOption[], sort: YeastSortKey): SearchableOption[] {
  const rank = (option: SearchableOption): number | string | null => {
    const spec = option.yeast;
    switch (sort) {
      case 'attenuation': return leadingNumber(spec?.attenuation);
      // Grouped as the badges are, so the chips come out in unbroken runs: the
      // two the sort is named for lead (wheat being an ale), then the souring
      // strains and the bretts.
      case 'type': {
        const type = spec?.type?.trim().toLowerCase();
        if (!type) return null;
        const group = ['ale', 'wheat'].includes(type)
          ? '0'
          : type === 'lager' ? '1' : type === 'sour' ? '2' : type === 'brett' ? '3' : '4';
        return `${group}${type}`;
      }
      case 'temp': return spec?.minTempC ?? spec?.maxTempC ?? null;
      case 'flocculation': {
        const index = FLOCCULATION_ORDER.indexOf((spec?.flocculation ?? '').trim().toLowerCase());
        return index === -1 ? null : index;
      }
      case 'form': return spec?.form?.trim().toLowerCase() || null;
      case 'lab': return spec?.lab?.trim().toLowerCase() || null;
      case 'tolerance': return toleranceRank(spec?.alcoholTolerance);
      case 'name': return null;
    }
  };
  const byName = (a: SearchableOption, b: SearchableOption) =>
    a.value.localeCompare(b.value, undefined, { sensitivity: 'base' });
  return [...options].sort((a, b) => {
    const aRank = rank(a);
    const bRank = rank(b);
    if (aRank == null && bRank == null) return byName(a, b);
    if (aRank == null) return 1;
    if (bRank == null) return -1;
    if (typeof aRank === 'number' && typeof bRank === 'number') {
      return aRank === bRank ? byName(a, b) : aRank - bRank;
    }
    const compared = String(aRank).localeCompare(String(bRank), undefined, { sensitivity: 'base' });
    return compared === 0 ? byName(a, b) : compared;
  });
}
