import type {
  IngredientKind,
  IngredientPrice,
  IngredientPriceOptions,
  PriceOption,
  PriceUnit,
} from '@checklist/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api';
import { asCleanMessage } from '../util';

/**
 * The price on an ingredient line, and everything behind it.
 *
 * A price the app worked out by matching names against a scraped catalogue is a
 * guess, and a guess the brewer can't see into or correct is worse than no price
 * at all. So each line carries three things: the figure, an ⓘ that says where it
 * came from without cluttering the row, and — for an admin — a picker that can
 * point the line at a different listing or set the price outright.
 *
 * A decision is saved against the ingredient's *name*, not this recipe, so
 * pricing a kveik once holds everywhere it's pitched. That's also why saving
 * asks the page to re-read the recipe: the change reaches lines this component
 * knows nothing about.
 */

/** Danish kroner, matching the recipe page's formatting. */
function kr(amount: number, decimals = 2): string {
  return `${amount.toLocaleString('en-GB', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} kr`;
}

/** The line as the price endpoints need to see it. */
export interface PricedLine {
  kind: IngredientKind;
  name: string;
  /** Weight the recipe calls for; null when it counts packs instead. */
  grams: number | null;
  /** Packs/vials, for a recipe that counts rather than weighs. */
  units?: number | null;
  /** The line's own colour (fermentables only), part of the automatic match. */
  ebc?: number | null;
  price: IngredientPrice | null;
}

/**
 * What a hand-typed price is quoted per. Weight-sold ingredients take the
 * catalogue's own per-kilo rate; a yeast pitch — and anything the recipe counts
 * rather than weighs — is priced per pack, because that's the unit it's bought in.
 */
function unitFor(line: PricedLine): PriceUnit {
  return line.kind === 'yeast' || line.grams == null ? 'pack' : 'kg';
}

/** How a listing reads in the dropdown: "26.00 kr/kg · 100 g at 2.60 kr". */
function optionMeta(option: PriceOption): string {
  return [
    option.pricePerKgDkk != null ? `${kr(option.pricePerKgDkk, 0)}/kg` : null,
    option.packageSizeG != null
      ? `${option.packageSizeG} g at ${kr(option.packagePriceDkk)}`
      : `${kr(option.packagePriceDkk)} per pack`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** One line of prose saying where a price came from. */
function sourceLine(price: IngredientPrice): string {
  switch (price.source) {
    case 'manual':
      return 'Your price';
    case 'chosen':
      return 'Product you picked';
    case 'rule':
      return price.note ?? 'Built-in price';
    case 'catalogue':
      return price.alternatives > 0
        ? `Cheapest of ${price.alternatives + 1} matching listings`
        : 'Matched in the price catalogue';
  }
}

/**
 * The price cell: the figure, an ⓘ explaining it, and (for an admin) a click
 * target that opens the picker. `open`/`onOpenChange` are lifted so the
 * ingredient's name can open the same panel — clicking either the thing or its
 * price is the same intent.
 */
export function PriceCell({
  line,
  editable,
  open,
  onOpenChange,
  onChanged,
}: {
  line: PricedLine;
  /** False for a read-only guest: the ⓘ still works, the picker doesn't open. */
  editable: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a save, so the page can re-read the (now re-costed) recipe. */
  onChanged: () => void;
}): JSX.Element {
  const { price } = line;
  const ref = useRef<HTMLSpanElement>(null);

  // Dismissal is handled here rather than inside the panel so that the price
  // itself counts as "inside": a click on the open trigger should close the
  // panel, not close it and have the trigger reopen it on the same click.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onOpenChange(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <span ref={ref} className="relative flex shrink-0 items-center justify-end gap-1">
      <PriceInfo price={price} />
      <button
        type="button"
        onClick={() => editable && onOpenChange(!open)}
        // A guest gets the figure without a control that does nothing on click.
        disabled={!editable}
        title={editable ? 'Change how this ingredient is priced' : undefined}
        className={`w-20 rounded text-right text-sm tabular-nums transition ${
          price ? 'text-zinc-300' : 'text-zinc-600'
        } ${
          editable
            ? 'cursor-pointer px-1 hover:bg-zinc-800 hover:text-zinc-100'
            : 'cursor-default'
        } ${open ? 'bg-zinc-800 text-zinc-100' : ''}`}
      >
        {price ? kr(price.usedDkk) : '—'}
      </button>
      {open && editable && (
        <PricePanel line={line} onClose={() => onOpenChange(false)} onChanged={onChanged} />
      )}
    </span>
  );
}

/**
 * The ⓘ beside a price: where the figure came from, on hover or focus.
 *
 * Its own hover card rather than a `title` attribute because the provenance is
 * several lines — which listing, at what rate, in what pack — and a native
 * tooltip renders that as one unreadable run. Keyboard users get it on focus.
 */
function PriceInfo({ price }: { price: IngredientPrice | null }): JSX.Element {
  const [shown, setShown] = useState(false);
  const id = useId();

  const details = price
    ? [
        price.pricePerKgDkk != null ? `${kr(price.pricePerKgDkk, 0)} per kg` : null,
        price.packageSizeG != null
          ? `Sold in ${price.packageSizeG} g packs at ${kr(price.packagePriceDkk)}`
          : `${kr(price.packagePriceDkk)} per pack`,
      ].filter((d): d is string => d != null)
    : [];

  return (
    <span className="relative flex items-center">
      <button
        type="button"
        aria-label="Where this price came from"
        aria-describedby={shown ? id : undefined}
        onMouseEnter={() => setShown(true)}
        onMouseLeave={() => setShown(false)}
        onFocus={() => setShown(true)}
        onBlur={() => setShown(false)}
        className="flex h-4 w-4 items-center justify-center rounded-full border border-zinc-700 text-[10px] leading-none text-zinc-500 transition hover:border-zinc-500 hover:text-zinc-300"
      >
        i
      </button>
      {shown && (
        <span
          id={id}
          role="tooltip"
          className="absolute bottom-full right-0 z-30 mb-1.5 w-64 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-left text-xs shadow-xl shadow-black/50"
        >
          {price ? (
            <>
              <span className="block font-semibold text-zinc-100">{price.matchedName}</span>
              <span className="mt-1 block text-zinc-400">{sourceLine(price)}</span>
              {details.map((d) => (
                <span key={d} className="mt-0.5 block text-zinc-500">
                  {d}
                </span>
              ))}
            </>
          ) : (
            <span className="block text-zinc-400">
              Not in the price catalogue — set a price to include it in the batch cost.
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * The picker itself: what the line is priced against now, a field to price it by
 * hand, the listings it could use instead, and a search across the rest of the
 * catalogue for when the name match landed on the wrong product entirely.
 */
function PricePanel({
  line,
  onClose,
  onChanged,
}: {
  line: PricedLine;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [options, setOptions] = useState<IngredientPriceOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PriceOption[] | null>(null);
  const [amount, setAmount] = useState('');
  const amountId = useId();

  const unit = unitFor(line);

  // The listings for this line, read when the panel opens.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const found = await api.getPriceOptions({
          kind: line.kind,
          name: line.name,
          grams: line.grams,
          units: line.units,
          ebc: line.ebc,
        });
        if (cancelled) return;
        setOptions(found);
        // Seed the price field with what's in effect, so an edit is a nudge
        // rather than a retype — and so the units are unambiguous by example.
        const current =
          unit === 'kg' ? found.price?.pricePerKgDkk : found.price?.packagePriceDkk;
        setAmount(current != null ? String(current) : '');
      } catch (e) {
        if (!cancelled) setError(asCleanMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [line.kind, line.name, line.grams, line.units, line.ebc, unit]);

  // Catalogue search, debounced so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === '') {
      setResults(null);
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          setResults(
            await api.searchPrices({
              kind: line.kind,
              q: trimmed,
              grams: line.grams,
              units: line.units,
            }),
          );
        } catch (e) {
          setError(asCleanMessage(e));
        }
      })();
    }, 250);
    return () => clearTimeout(timer);
  }, [query, line.kind, line.grams, line.units]);

  /** Run a save, then hand back to the page to re-read the recipe. */
  async function commit(save: () => Promise<unknown>): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await save();
      onChanged();
      onClose();
    } catch (e) {
      setError(asCleanMessage(e));
      setSaving(false);
    }
  }

  /**
   * Price this line against a particular listing. Any hand-typed price is
   * dropped: choosing a product means buying it at what the shop charges, and
   * silently carrying an old figure onto a different product would be a lie.
   */
  function choose(option: PriceOption): void {
    void commit(() =>
      api.savePriceOverride({
        kind: line.kind,
        name: line.name,
        catalogueId: option.catalogueId,
        unitPriceDkk: null,
        priceUnit: null,
        packageSizeG: null,
      }),
    );
  }

  /**
   * Save a hand-typed price. It stays attached to a listing the brewer pinned —
   * so the pack size and the shop's name for it survive — but an *automatic*
   * match isn't frozen in by a price edit: the match may well be the thing that
   * was wrong, and pinning it would preserve exactly that mistake.
   */
  function savePrice(): void {
    const value = Number.parseFloat(amount.replace(',', '.'));
    if (!Number.isFinite(value) || value < 0) {
      setError('Enter a price');
      return;
    }
    void commit(() =>
      api.savePriceOverride({
        kind: line.kind,
        name: line.name,
        catalogueId: options?.override?.catalogueId ?? null,
        unitPriceDkk: value,
        priceUnit: unit,
        packageSizeG: null,
      }),
    );
  }

  function reset(): void {
    void commit(() => api.clearPriceOverride(line.kind, line.name));
  }

  const price = options?.price ?? line.price;
  const listed = results ?? options?.matched ?? [];

  return (
    <div className="absolute right-0 top-full z-30 mt-1.5 w-80 rounded-xl border border-zinc-700 bg-zinc-900 text-left shadow-xl shadow-black/50">
      <div className="border-b border-zinc-800 px-3 py-2.5">
        <div className="truncate text-sm font-semibold text-zinc-100">{line.name}</div>
        {price ? (
          <div className="mt-0.5 text-xs text-zinc-500">
            <span className="text-zinc-400">{price.matchedName}</span> · {sourceLine(price)}
          </div>
        ) : (
          <div className="mt-0.5 text-xs text-amber-500/80">Not in the price catalogue</div>
        )}
      </div>

      {/* Set the price outright — the only route for something the shop
          doesn't stock, and the override for anything it prices wrongly. */}
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2.5">
        <label className="shrink-0 text-xs text-zinc-400" htmlFor={amountId}>
          {unit === 'kg' ? 'Price per kg' : 'Price per pack'}
        </label>
        <input
          id={amountId}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && savePrice()}
          inputMode="decimal"
          placeholder="0.00"
          className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-right text-sm tabular-nums text-zinc-100 outline-none focus:border-zinc-500"
        />
        <button
          type="button"
          onClick={savePrice}
          disabled={saving}
          className="shrink-0 rounded-lg bg-gradient-to-br from-[#f87a68] to-[#e0463f] px-2.5 py-1 text-xs font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
        >
          Save
        </button>
      </div>

      {/* Pick a different listing. Sold-out products aren't offered. */}
      <div className="max-h-60 overflow-y-auto">
        {options == null && !error && (
          <div className="px-3 py-3 text-xs text-zinc-500">Loading listings…</div>
        )}
        {options != null && listed.length === 0 && (
          <div className="px-3 py-3 text-xs text-zinc-500">
            {results != null
              ? 'Nothing in the catalogue matches that.'
              : 'No catalogue listing matches this name — search below, or set a price above.'}
          </div>
        )}
        {listed.map((option) => (
          <button
            key={option.catalogueId}
            type="button"
            onClick={() => choose(option)}
            disabled={saving}
            className={`flex w-full items-start gap-2 px-3 py-2 text-left transition hover:bg-zinc-800 disabled:opacity-50 ${
              option.isSelected ? 'bg-zinc-800/60' : ''
            }`}
          >
            <span className="mt-0.5 w-3 shrink-0 text-center text-[11px] text-zinc-500">
              {option.isSelected ? '●' : option.isDefault ? '★' : ''}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-zinc-100">{option.label}</span>
              <span className="block truncate text-[11px] text-zinc-500">
                {optionMeta(option)}
              </span>
            </span>
            {option.usedDkk != null && (
              <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                {kr(option.usedDkk)}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* The matcher works on the recipe's wording; when it lands on the wrong
          product, the right one is only reachable by the shop's own name. */}
      <div className="border-t border-zinc-800 px-3 py-2.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the whole catalogue…"
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-500"
        />
      </div>

      {error && (
        <div className="border-t border-zinc-800 px-3 py-2 text-xs text-red-300">{error}</div>
      )}

      {options?.override && (
        <div className="border-t border-zinc-800 px-3 py-2">
          <button
            type="button"
            onClick={reset}
            disabled={saving}
            className="text-xs text-zinc-400 transition hover:text-zinc-100 disabled:opacity-50"
          >
            Reset to automatic pricing
          </button>
        </div>
      )}
      {/* Said once, at the bottom, because it's the surprising part: this is a
          decision about the ingredient, not about this recipe. */}
      <div className="border-t border-zinc-800 px-3 py-2 text-[11px] leading-snug text-zinc-600">
        Applies to {line.name} in every recipe.
      </div>
    </div>
  );
}

/**
 * The ingredient's name as a click target for its own price picker. Reads as
 * plain text until hovered — the name is what the brewer is looking at, not a
 * control — but clicking the thing and clicking its price mean the same thing.
 */
export function IngredientName({
  name,
  editable,
  onClick,
  className = '',
}: {
  name: string;
  editable: boolean;
  onClick: () => void;
  className?: string;
}): JSX.Element {
  if (!editable) return <span className={className}>{name}</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      title="Change how this ingredient is priced"
      className={`truncate text-left transition hover:text-white hover:underline hover:decoration-zinc-600 hover:underline-offset-4 ${className}`}
    >
      {name}
    </button>
  );
}
