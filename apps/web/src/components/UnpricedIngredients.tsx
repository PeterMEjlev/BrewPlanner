import type { PriceOption, PriceUnit, UnpricedIngredient } from '@checklist/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api';
import { kr } from '../money';
import { asCleanMessage } from '../util';

/**
 * The ingredients a recipe's cost is missing, and a place to fix all of them at
 * once.
 *
 * Both the recipe page and the editor already say how short a total is — "6 of
 * 13 ingredients not in the catalogue", "6 unpriced" — and until now that was
 * where it ended: the brewer had to find those six rows themselves and open six
 * price pickers. The count is the natural place to ask "which six?", so it
 * opens this.
 *
 * Two ways to answer, per ingredient, matching the per-line picker: type what it
 * costs, or point it at a listing the automatic match missed. Either is saved
 * against the ingredient's *name*, not this recipe, so pricing a kveik here
 * prices it everywhere it's pitched — which is also why the panel re-costs the
 * page behind it as it goes rather than only when it closes.
 */

/** What a hand-typed price is quoted per — the same rule the per-line picker uses. */
function unitFor(line: UnpricedIngredient): PriceUnit {
  return line.kind === 'yeast' || line.grams == null ? 'pack' : 'kg';
}

/** The kind as a word for the row's chip, in the brewer's vocabulary. */
const KIND_LABEL: Record<UnpricedIngredient['kind'], string> = {
  fermentable: 'Malt',
  hop: 'Hop',
  yeast: 'Yeast',
  other: 'Other',
};

/**
 * How much of it the recipe calls for — a weight where there is one, a count
 * where the recipe counts, and nothing at all when the amount couldn't be read
 * (which is itself why the line has no price).
 */
function amountText(line: UnpricedIngredient): string | null {
  const across = line.additions > 1 ? ` across ${line.additions} additions` : '';
  if (line.grams != null) {
    const weight = line.grams >= 1_000
      ? `${Math.round(line.grams / 10) / 100} kg`
      : `${Math.round(line.grams * 10) / 10} g`;
    return `${weight}${across}`;
  }
  if (line.units != null) {
    return `${line.units} pack${line.units === 1 ? '' : 's'}${across}`;
  }
  return null;
}

export function UnpricedIngredientsDialog({
  lines,
  onClose,
  onChanged,
}: {
  lines: UnpricedIngredient[];
  onClose: () => void;
  /** Called after each save, so the page behind can re-read its (re-costed) recipe. */
  onChanged: () => void;
}): JSX.Element {
  // Which ingredients have been dealt with while the panel has been open. Kept
  // here rather than read back from the recipe: the rows stay put and tick over
  // in place, so the list can't reshuffle under a brewer working down it.
  const [priced, setPriced] = useState<Record<string, string>>({});
  const titleId = useId();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const remaining = lines.filter((line) => priced[key(line)] == null).length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:p-8"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl shadow-black/50">
        <div className="flex items-start justify-between gap-4 border-b border-zinc-800 px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-zinc-50">
              Ingredients without a price
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-zinc-400">
              {remaining === 0
                ? 'Every one of them is priced now. The recipe cost below has been updated.'
                : 'The shop catalogue doesn’t price these, so the batch cost is short by whatever they come to. Type what one costs, or point it at the right product — either is saved against the ingredient and applies to every recipe that uses it.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg px-2 py-1 text-lg leading-none text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
          >
            ×
          </button>
        </div>

        <ul className="max-h-[60vh] divide-y divide-zinc-800 overflow-y-auto">
          {lines.map((line) => (
            <UnpricedRow
              key={key(line)}
              line={line}
              saved={priced[key(line)] ?? null}
              onSaved={(what) => {
                setPriced((current) => ({ ...current, [key(line)]: what }));
                onChanged();
              }}
            />
          ))}
          {lines.length === 0 && (
            <li className="px-5 py-6 text-sm text-zinc-500">
              Nothing is missing a price.
            </li>
          )}
        </ul>

        <div className="flex items-center justify-between gap-3 border-t border-zinc-800 px-5 py-3">
          <span className="text-xs text-zinc-500">
            {remaining === 0
              ? 'All priced'
              : `${remaining} of ${lines.length} still without a price`}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-200 transition hover:bg-zinc-800"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/** Ingredients are priced per kind and name, which is what identifies a row. */
function key(line: UnpricedIngredient): string {
  return `${line.kind}:${line.name.toLocaleLowerCase()}`;
}

/**
 * One ingredient to price: what it is, how much of it the recipe uses, and a
 * price box. The catalogue search stays folded away — an ingredient in this list
 * is one the automatic match already failed to find, so typing a price is the
 * common answer and searching is the fallback for when the shop does stock it
 * under a name the recipe doesn't use.
 */
function UnpricedRow({
  line,
  saved,
  onSaved,
}: {
  line: UnpricedIngredient;
  /** What this ingredient was priced at in this session, or null while it isn't. */
  saved: string | null;
  onSaved: (what: string) => void;
}): JSX.Element {
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const unit = unitFor(line);
  const priceId = useId();
  const measured = amountText(line);

  /** Run a save, then let the page behind re-cost itself. */
  async function commit(save: () => Promise<unknown>, what: string): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await save();
      onSaved(what);
      setSearching(false);
    } catch (e) {
      setError(asCleanMessage(e));
    } finally {
      setSaving(false);
    }
  }

  function savePrice(): void {
    const value = Number.parseFloat(amount.replace(',', '.'));
    if (!Number.isFinite(value) || value < 0) {
      setError('Enter a price');
      return;
    }
    void commit(
      () =>
        api.savePriceOverride({
          kind: line.kind,
          name: line.name,
          catalogueId: null,
          unitPriceDkk: value,
          priceUnit: unit,
          packageSizeG: null,
        }),
      `${kr(value, 2)} per ${unit === 'kg' ? 'kg' : 'pack'}`,
    );
  }

  /**
   * Price it against a listing instead. Any typed price is dropped: choosing a
   * product means buying it at what the shop charges — the same rule the
   * per-line picker follows.
   */
  function choose(option: PriceOption): void {
    void commit(
      () =>
        api.savePriceOverride({
          kind: line.kind,
          name: line.name,
          catalogueId: option.catalogueId,
          unitPriceDkk: null,
          priceUnit: null,
          packageSizeG: null,
        }),
      option.label,
    );
  }

  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 ring-1 ring-inset ring-zinc-700">
          {KIND_LABEL[line.kind]}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-zinc-100">{line.name}</span>
          <span className="block text-[11px] text-zinc-500">
            {measured ?? 'Amount couldn’t be read — a price here still applies elsewhere'}
          </span>
        </span>

        {saved != null ? (
          <span className="shrink-0 text-xs font-medium text-emerald-300">✓ {saved}</span>
        ) : (
          <span className="flex shrink-0 items-center gap-2">
            <label className="sr-only" htmlFor={priceId}>
              {`Price for ${line.name}, per ${unit === 'kg' ? 'kilo' : 'pack'}`}
            </label>
            <input
              id={priceId}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && savePrice()}
              inputMode="decimal"
              placeholder="0.00"
              className="w-24 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-right text-sm tabular-nums text-zinc-100 outline-none focus:border-zinc-500"
            />
            <span className="w-12 text-[11px] text-zinc-500">
              {unit === 'kg' ? 'kr/kg' : 'kr/pack'}
            </span>
            <button
              type="button"
              onClick={savePrice}
              disabled={saving}
              className="rounded-lg bg-gradient-to-br from-[#f87a68] to-[#e0463f] px-2.5 py-1 text-xs font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setSearching((open) => !open)}
              title="Find this ingredient in the shop catalogue"
              aria-expanded={searching}
              className={`rounded-lg border border-zinc-700 px-2 py-1 text-xs transition hover:bg-zinc-800 ${
                searching ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'
              }`}
            >
              Find…
            </button>
          </span>
        )}
      </div>

      {error && <div className="mt-1.5 text-[11px] text-red-300">{error}</div>}
      {searching && saved == null && (
        <CatalogueSearch line={line} disabled={saving} onChoose={choose} />
      )}
    </li>
  );
}

/**
 * A search across the shop's own listings for one ingredient. Seeded with the
 * ingredient's name — the automatic match works on the recipe's wording, so the
 * first thing worth trying is the same words against the whole catalogue rather
 * than only the slice the matcher considered.
 */
function CatalogueSearch({
  line,
  disabled,
  onChoose,
}: {
  line: UnpricedIngredient;
  disabled: boolean;
  onChoose: (option: PriceOption) => void;
}): JSX.Element {
  const [query, setQuery] = useState(line.name);
  const [results, setResults] = useState<PriceOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  // Opened deliberately, so the caret belongs in the box.
  useEffect(() => field.current?.select(), []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === '') {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      void api
        .searchPrices({ kind: line.kind, q: trimmed, grams: line.grams, units: line.units })
        .then(setResults)
        .catch((e) => setError(asCleanMessage(e)));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, line.kind, line.grams, line.units]);

  return (
    <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
      <input
        ref={field}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search the whole catalogue…"
        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-500"
      />
      <div className="mt-1 max-h-44 overflow-y-auto">
        {results == null && <div className="px-2 py-2 text-[11px] text-zinc-500">Searching…</div>}
        {results != null && results.length === 0 && (
          <div className="px-2 py-2 text-[11px] text-zinc-500">
            Nothing in the catalogue matches that — type a price above instead.
          </div>
        )}
        {(results ?? []).map((option) => (
          <button
            key={option.catalogueId}
            type="button"
            disabled={disabled}
            onClick={() => onChoose(option)}
            className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-zinc-800 disabled:opacity-50"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-zinc-100">{option.label}</span>
              <span className="block truncate text-[11px] text-zinc-500">
                {option.packageSizeG != null
                  ? `${option.packageSizeG} g at ${kr(option.packagePriceDkk, 2)}`
                  : `${kr(option.packagePriceDkk, 2)} per pack`}
              </span>
            </span>
            {option.usedDkk != null && (
              <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                {kr(option.usedDkk, 2)}
              </span>
            )}
          </button>
        ))}
      </div>
      {error && <div className="mt-1 px-2 text-[11px] text-red-300">{error}</div>}
    </div>
  );
}
