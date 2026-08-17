import {
  EMPTIED_KEG_FIELDS,
  holdsBeer,
  isDirtyContents,
  type KegContent,
  type Recipe,
} from '@checklist/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { canControl, useAuth } from '../auth';
import { DashboardShell } from '../components/DashboardShell';
import { Select } from '../components/Select';
import { useKegContentColors } from '../kegContentColors';
import {
  KEG_CONTENT_OPTIONS,
  SHEETS_VIEW_URL,
  SORT_OPTIONS,
  type Keg,
  type KegAgeIndicator,
  type SortKey,
  describeKegAge,
  getContentColor,
  hexToRgb,
  isUnknownContents,
  matchContentOption,
  sortKegs,
  todayDDMMYYYY,
  useKegs,
} from '../kegs';
import { useSettings } from '../settings';
import { asMessage } from '../util';

/** Re-pull the sheet every minute so a fill/empty done elsewhere shows up. */
const POLL_MS = 60_000;

/** slate-800 — the base colour each content tint fades into (matches brew-system). */
const TINT_BASE = '#1e293b';

/**
 * Stout's palette colour is a near-black roast — right as a card tint, and all
 * but invisible as text on this background. Everywhere a content name is
 * *written* in its own colour it gets this warm brown instead.
 */
const STOUT_LABEL_COLOR = '#A68B6B';

/** Whether a content wears {@link STOUT_LABEL_COLOR} rather than its palette colour. */
function isStoutContents(contents: string): boolean {
  return contents.trim().toLowerCase() === 'stout';
}

/** The colour to write a content name in, or undefined to leave it plain. */
function contentLabelColor(
  contents: string,
  colors: Record<KegContent, string>,
  fallback?: string | null,
): string | undefined {
  if (isStoutContents(contents)) return STOUT_LABEL_COLOR;
  return getContentColor(contents, colors) ?? fallback ?? undefined;
}

/** Return a copy of `set` with `value` toggled in/out. */
function toggleInSet(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * Desktop Kegs — the mouse-and-keyboard counterpart to the kiosk's touch keg
 * screen ([Kegs.tsx]). Unlike the kiosk (which stays read-only), this desktop
 * view can edit a keg's contents: click a card to edit one keg, or multi-select
 * — Windows-Explorer style, with Ctrl/Cmd-click to toggle and Shift-click to
 * range-select — to assign the same content to several at once. Edits are
 * written back to the shared sheet through the server; the kiosk keg screen
 * deliberately keeps no edit controls.
 */
export function KegsDesktopPage(): JSX.Element {
  const { kegs, loading, error, applyLocalUpdates } = useKegs(POLL_MS);
  const colors = useKegContentColors();
  const { kegWarnDays, kegOldDays } = useSettings();
  const { auth } = useAuth();
  // Guests are read-only: they can browse and sort kegs, but can't edit content,
  // multi-select, or open the source sheet. The kiosk/LAN and admins get the
  // full editor.
  const controllable = canControl(auth);
  const [sortKey, setSortKey] = useState<SortKey>('number');
  const [sortAsc, setSortAsc] = useState(true);

  // Single-keg edit (the keg being edited, or null).
  const [editingKeg, setEditingKeg] = useState<Keg | null>(null);
  // The keg whose beer is being racked elsewhere, once the editor hands off.
  const [transferSource, setTransferSource] = useState<Keg | null>(null);
  // Multi-select: a Set of keg numbers, the range anchor (the last keg clicked
  // without Shift, like a file list), an explicit "Select" toggle, and whether
  // the bulk modal is open.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [bulkEditing, setBulkEditing] = useState(false);

  const filled = kegs.filter((k) => !isUnknownContents(k.contents)).length;
  const sorted = sortKegs(kegs, sortKey, sortAsc);
  const ageThresholds = { warnDays: kegWarnDays, oldDays: kegOldDays };
  const selectedKegs = kegs.filter((k) => selected.has(k.number));
  // We're "selecting" whenever something is selected, or the user pressed the
  // Select button to start an empty selection. Drives the checkboxes/bulk bar.
  const selecting = selectMode || selected.size > 0;

  function handleSort(key: SortKey): void {
    if (key === sortKey) {
      setSortAsc((p) => !p);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  // Warm the recipe cache as soon as the page loads (only admins ever open the
  // editor), so the first keg opened already has its linked-recipe chip ready.
  useEffect(() => {
    if (controllable) loadRecipes().catch(() => {});
  }, [controllable]);

  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
    setAnchor(null);
  }, []);

  // Escape deselects while selecting but no modal is open (modals handle their own
  // Escape). Runs in the capture phase and claims the key (preventDefault) so the
  // shell's "Escape → dashboard" shortcut steps aside while a selection is active.
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editingKeg && !bulkEditing && !transferSource) {
        e.preventDefault();
        exitSelect();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [selecting, editingKeg, bulkEditing, transferSource, exitSelect]);

  // Windows-Explorer-style selection over the keg grid:
  //   • plain click       → edit that keg (or toggle it once a selection exists)
  //   • Ctrl/Cmd + click  → toggle one keg in/out of the selection
  //   • Shift + click      → select the range, in display order, from the anchor
  //   • Ctrl/Cmd+Shift+click → add that range to the current selection
  // The anchor is the last keg clicked without Shift, so repeated Shift-clicks
  // re-extend from the same starting point. Range is computed over `sorted` so it
  // follows what the user actually sees, not the underlying keg numbers.
  function handleActivate(keg: Keg, e: React.MouseEvent | React.KeyboardEvent): void {
    if (!controllable) return; // read-only guests can't edit or select
    const additive = e.ctrlKey || e.metaKey;

    if (e.shiftKey) {
      const order = sorted.map((k) => k.number);
      const from = order.indexOf(anchor ?? keg.number);
      const to = order.indexOf(keg.number);
      setSelected((prev) => {
        const base = additive ? new Set(prev) : new Set<string>();
        if (from !== -1 && to !== -1) {
          const [lo, hi] = from <= to ? [from, to] : [to, from];
          for (let i = lo; i <= hi; i++) base.add(order[i]!);
        } else {
          base.add(keg.number);
        }
        return base;
      });
      if (anchor === null) setAnchor(keg.number);
      return;
    }

    if (additive) {
      setSelected((prev) => toggleInSet(prev, keg.number));
      setAnchor(keg.number);
      return;
    }

    // No modifier: toggle while a selection is in progress, otherwise edit.
    setAnchor(keg.number);
    if (selecting) {
      setSelected((prev) => toggleInSet(prev, keg.number));
    } else {
      setEditingKeg(keg);
    }
  }

  // After a save: fold the edited kegs into local state and clear any selection.
  const handleSaved = useCallback(
    (updated: Keg[]) => {
      applyLocalUpdates(updated);
      setEditingKeg(null);
      setBulkEditing(false);
      setTransferSource(null);
      exitSelect();
    },
    [applyLocalUpdates, exitSelect],
  );

  return (
    <DashboardShell active="kegs">
      <main className="w-full max-w-[1580px] px-3 py-4 sm:px-5 sm:py-5">
        {(loading || error || selecting) && (
          <p className="mb-3 truncate text-sm text-zinc-500">
            {loading ? (
              'Loading keg data…'
            ) : error ? (
              <span className="text-red-400">{error}</span>
            ) : (
              `${selected.size} selected — Ctrl-click to toggle, Shift-click for a range`
            )}
          </p>
        )}

        {/* Sort bar — the active key gets the coral pill, with a direction arrow.
            The page actions share the row, pushed to the right.

            On a phone that single row wrapped badly: five keys fitted, the
            sixth dropped to a line of its own, and the actions — still pushed
            right — ended up marooned beside it with a hole in between. So the
            keys become an even three-column grid there (six keys, two tidy
            rows, nothing hanging), with the actions on their own row under it.
            Both wrappers turn into `display: contents` at `sm`, which hands
            every control back to this row exactly as it sat before. */}
        <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="grid grid-cols-3 gap-2 sm:contents">
            {SORT_OPTIONS.map(({ key, label }) => {
              const active = key === sortKey;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => handleSort(key)}
                  disabled={loading}
                  className={`flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${
                    active
                      ? 'border-transparent bg-gradient-to-br from-[#f87a68] to-[#e0463f] text-white shadow'
                      : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
                  }`}
                >
                  {label}
                  {active && <span aria-hidden>{sortAsc ? '▲' : '▼'}</span>}
                </button>
              );
            })}
          </div>
          {controllable && (
            <div className="flex items-center gap-2 sm:ml-auto sm:shrink-0">
              {selecting ? (
                <button
                  type="button"
                  onClick={exitSelect}
                  className="flex-1 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 sm:flex-none"
                >
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setSelectMode(true)}
                  disabled={loading || kegs.length === 0}
                  className="flex-1 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50 sm:flex-none"
                >
                  Select
                </button>
              )}
              <a
                href={SHEETS_VIEW_URL}
                target="_blank"
                rel="noreferrer"
                className="flex-1 rounded-lg border border-zinc-800 px-3 py-1.5 text-center text-sm text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100 sm:flex-none"
              >
                Inventory sheet ↗
              </a>
            </div>
          )}
        </div>

        {/* Two columns on a phone (there's room for it); auto-fill wider tiles
            from the `sm` breakpoint up so the desktop keeps its dense grid. */}
        <div className="grid grid-cols-2 gap-3 sm:[grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">
          {loading
            ? Array.from({ length: 12 }, (_, i) => <KegSkeleton key={i} />)
            : sorted.map((keg) => (
                <KegCard
                  key={keg.number}
                  keg={keg}
                  age={describeKegAge(keg, ageThresholds)}
                  colors={colors}
                  selectMode={selecting}
                  selected={selected.has(keg.number)}
                  interactive={controllable}
                  onActivate={handleActivate}
                />
              ))}
        </div>
        {!loading && !error && kegs.length === 0 && (
          <p className="mt-10 text-center text-lg text-zinc-400">No kegs found.</p>
        )}
      </main>

      {/* Floating bulk-action bar while selecting. */}
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-zinc-700 bg-zinc-900/95 px-4 py-3 shadow-2xl shadow-black/50 backdrop-blur">
          <span className="text-sm text-zinc-300">
            {selected.size} keg{selected.size !== 1 ? 's' : ''} selected
          </span>
          <button
            type="button"
            onClick={() => setBulkEditing(true)}
            className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-sm font-semibold text-white transition hover:bg-blue-500"
          >
            Assign content to {selected.size} keg{selected.size !== 1 ? 's' : ''}
          </button>
        </div>
      )}

      {/* Single-keg editor. A keg with beer in it can hand that beer over to the
          transfer picker instead of being edited. */}
      {editingKeg && (
        <KegEditModal
          kegs={[editingKeg]}
          colors={colors}
          onClose={() => setEditingKeg(null)}
          onSaved={handleSaved}
          onTransfer={
            holdsBeer(editingKeg.contents)
              ? () => {
                  setTransferSource(editingKeg);
                  setEditingKeg(null);
                }
              : undefined
          }
        />
      )}

      {/* Transfer: rack one keg's beer into the kegs picked here. */}
      {transferSource && (
        <KegTransferModal
          source={transferSource}
          kegs={kegs}
          colors={colors}
          onClose={() => setTransferSource(null)}
          onSaved={handleSaved}
        />
      )}

      {/* Bulk "assign content" editor. */}
      {bulkEditing && selectedKegs.length > 0 && (
        <KegEditModal
          kegs={selectedKegs}
          colors={colors}
          onClose={() => setBulkEditing(false)}
          onSaved={handleSaved}
        />
      )}
    </DashboardShell>
  );
}

/**
 * A single keg tile: number + size, then the content (tinted by type), date,
 * note and ABV. Empty ("???") kegs dim and the colour cues fall away to grey.
 * On the desktop the card is interactive — it opens the editor (or toggles
 * selection while selecting) — so it carries a hover ring and button semantics.
 */
function KegCard({
  keg,
  age,
  colors,
  selectMode,
  selected,
  interactive,
  onActivate,
}: {
  keg: Keg;
  age: KegAgeIndicator;
  colors: Record<KegContent, string>;
  selectMode: boolean;
  selected: boolean;
  /** Whether the card responds to clicks (edit/select). False for read-only guests. */
  interactive: boolean;
  onActivate: (keg: Keg, e: React.MouseEvent | React.KeyboardEvent) => void;
}): JSX.Element {
  const color = getContentColor(keg.contents, colors) ?? keg.color;
  const unknown = isUnknownContents(keg.contents);
  // Stout is near-black, so it reads better as a heavier tint with a muted label.
  const isStout = isStoutContents(keg.contents);
  const rgb = color ? hexToRgb(color) : null;
  const cardStyle: React.CSSProperties = rgb
    ? {
        borderLeft: `3px solid ${color}`,
        background: `linear-gradient(135deg, rgba(${rgb}, ${isStout ? 0.55 : 0.15}), ${TINT_BASE})`,
      }
    : {};
  const labelColor = contentLabelColor(keg.contents, colors, keg.color);

  // Read-only guests get a plain card with no button semantics, hover, or focus
  // affordances; editors get the full click-to-edit / select behaviour.
  const interactiveProps = interactive
    ? {
        role: 'button',
        tabIndex: 0,
        'aria-pressed': selectMode ? selected : undefined,
        // Shift-click range-selects; suppress the browser's native text selection
        // (the card is a button, not selectable text) so a range click stays clean.
        onMouseDown: (e: React.MouseEvent) => {
          if (e.shiftKey) e.preventDefault();
        },
        onClick: (e: React.MouseEvent) => onActivate(keg, e),
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onActivate(keg, e);
          }
        },
      }
    : {};

  return (
    <div
      {...interactiveProps}
      className={`relative flex min-h-[7rem] select-none flex-col rounded-xl border bg-zinc-900 p-4 outline-none transition ${
        interactive ? 'cursor-pointer hover:border-zinc-600 focus-visible:ring-2 focus-visible:ring-blue-500' : ''
      } ${selected ? 'border-blue-500 ring-2 ring-blue-500/60' : 'border-zinc-800'} ${
        unknown && !selected ? 'opacity-50' : ''
      }`}
      style={cardStyle}
    >
      {selectMode && (
        <span
          aria-hidden
          className={`absolute right-2.5 top-2.5 flex h-5 w-5 items-center justify-center rounded-md border ${
            selected ? 'border-blue-500 bg-blue-500 text-white' : 'border-zinc-500 bg-black/30'
          }`}
        >
          {selected && (
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
          )}
        </span>
      )}
      <div className="flex items-start justify-between gap-2">
        <span className="text-xl font-bold leading-none">#{keg.number}</span>
        {keg.volume && (
          <span
            className={`shrink-0 rounded-md bg-black/30 px-2 py-0.5 text-xs font-medium text-zinc-400 ${
              selectMode ? 'mr-6' : ''
            }`}
          >
            {keg.volume}
          </span>
        )}
      </div>
      <span
        className="mt-3 text-base font-semibold leading-tight"
        style={labelColor ? { color: labelColor } : undefined}
      >
        {keg.contents}
      </span>
      {keg.date && (
        <span
          className={`mt-1 inline-flex w-fit items-center gap-1 text-sm ${age.chipClass || 'text-zinc-400'}`}
          title={age.title}
        >
          {age.icon && <span aria-hidden>{age.icon}</span>}
          {keg.date}
        </span>
      )}
      {keg.note && <span className="mt-1 text-sm italic text-zinc-400">{keg.note}</span>}
      {keg.abv && (
        <span className="mt-auto pt-2 text-sm text-zinc-400">{keg.abv.replace(/%/g, '')}% ABV</span>
      )}
    </div>
  );
}

// --- Transfer modal ---------------------------------------------------------

/** The keg fields that travel with the beer when it's racked into another keg. */
function beerOf(
  keg: Keg,
): { contents: string; date: string; note: string; abv: string; recipeId: string } {
  // The fill date goes across unchanged: racking doesn't make the beer younger,
  // and a reset date would hide an ageing keg from the keg-age alert.
  return {
    contents: keg.contents,
    date: keg.date,
    note: keg.note,
    abv: keg.abv,
    recipeId: keg.recipeId,
  };
}

/** A sheet volume as a number for arithmetic ("19 L" → 19, "" → 0). */
function volumeOf(keg: Keg): number {
  return parseFloat(keg.volume) || 0;
}

/**
 * Whatever the sheet writes after the number ("19 L" → "L", "19" → ""), so a
 * total can be spoken in the same units the board uses without this page
 * inventing one.
 */
function volumeUnit(volume: string): string {
  return volume.match(/^\s*[\d.,]+\s*(\D.*)$/)?.[1]?.trim() ?? '';
}

/**
 * Racking one keg's beer into others. The picked kegs each receive the beer as
 * it stands — same contents, fill date, ABV, note and recipe link — and the keg
 * it came out of is marked Dirty, since that's exactly what has just happened
 * to it.
 *
 * Only kegs holding no beer can be picked, so a stray click can't pour a stout
 * over somebody's pilsner. The targets are written first and the source emptied
 * only once they've all succeeded: a transfer that fails halfway should leave
 * the beer recorded where it still is, not lose track of it.
 */
function KegTransferModal({
  source,
  kegs,
  colors,
  onClose,
  onSaved,
}: {
  source: Keg;
  /** Every keg on the board — the pickable ones are filtered out of this. */
  kegs: Keg[];
  colors: Record<KegContent, string>;
  onClose: () => void;
  onSaved: (updated: Keg[]) => void;
}): JSX.Element {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const candidates = sortKegs(
    kegs.filter((k) => k.number !== source.number && !holdsBeer(k.contents)),
    'number',
    true,
  );
  const targets = candidates.filter((k) => picked.has(k.number));

  // Volumes are advisory: the sheet's numbers say what fits, but a brewer
  // splitting 19 into two 9s knows they're leaving some behind. Say so, don't
  // block it.
  const unit = volumeUnit(source.volume);
  const sourceVolume = volumeOf(source);
  const pickedVolume = targets.reduce((sum, k) => sum + volumeOf(k), 0);
  const overCapacity = sourceVolume > 0 && pickedVolume > sourceVolume;
  // The stripe wears the beer's true colour; the name is written in whatever is
  // legible as text (see contentLabelColor — stout is the awkward one).
  const sourceTint = getContentColor(source.contents, colors) ?? source.color;
  const sourceColor = contentLabelColor(source.contents, colors, source.color);

  const handleTransfer = async (): Promise<void> => {
    setSaving(true);
    setError('');
    const beer = beerOf(source);
    const beerColor = getContentColor(source.contents, colors) ?? source.color;
    const updated: Keg[] = [];

    for (const [i, keg] of targets.entries()) {
      setProgress(`Filling keg #${keg.number} (${i + 1} of ${targets.length})…`);
      try {
        await api.updateKeg(keg.number, beer);
        updated.push({ ...keg, ...beer, color: beerColor });
      } catch (e) {
        setError(
          `Failed on keg #${keg.number}: ${cleanError(e)} — keg #${source.number} was left as it is.`,
        );
        setSaving(false);
        setProgress('');
        if (updated.length > 0) onSaved(updated);
        return;
      }
    }

    // The beer is elsewhere now, so the keg it left is dirty — and carries none
    // of its details, note included (see EMPTIED_KEG_FIELDS).
    setProgress(`Emptying keg #${source.number}…`);
    const emptied = { contents: 'Dirty', ...EMPTIED_KEG_FIELDS, note: '' };
    try {
      await api.updateKeg(source.number, emptied);
      updated.push({ ...source, ...emptied, color: getContentColor('Dirty', colors) });
    } catch (e) {
      setError(
        `The beer moved, but keg #${source.number} could not be marked dirty: ${cleanError(e)}`,
      );
      setSaving(false);
      setProgress('');
      onSaved(updated);
      return;
    }

    setSaving(false);
    setProgress('');
    onSaved(updated);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm"
      />

      <div className="relative z-10 flex max-h-[90vh] w-full max-w-md flex-col rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/50">
        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-5 py-3.5">
          <h2 className="truncate text-base font-semibold tracking-tight text-zinc-50">
            Transfer keg{' '}
            <span style={sourceColor ? { color: sourceColor } : undefined}>#{source.number}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-lg text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {/* What's moving. */}
          <div
            className="rounded-lg border border-zinc-800 px-3 py-2"
            style={sourceTint ? { borderLeft: `3px solid ${sourceTint}` } : undefined}
          >
            <div className="text-sm font-semibold" style={sourceColor ? { color: sourceColor } : undefined}>
              {source.contents}
            </div>
            <div className="mt-0.5 text-xs text-zinc-500">
              {[
                source.volume,
                source.date && `filled ${source.date}`,
                source.abv && `${source.abv.replace(/%/g, '')}% ABV`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>

          {/* Where it's going. */}
          <div>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Transfer into
              </span>
              {targets.length > 0 && (
                <span className="text-xs tabular-nums text-zinc-500">
                  {targets.length} keg{targets.length !== 1 ? 's' : ''}
                  {pickedVolume > 0 && ` · ${pickedVolume}${unit && ` ${unit}`}`}
                </span>
              )}
            </div>

            {candidates.length === 0 ? (
              <p className="rounded-lg border border-zinc-800 px-3 py-4 text-center text-sm text-zinc-500">
                Every other keg holds beer. Empty or clean one first.
              </p>
            ) : (
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-zinc-800 p-1">
                {candidates.map((keg) => {
                  const on = picked.has(keg.number);
                  const stateColor = getContentColor(keg.contents, colors) ?? keg.color;
                  return (
                    <button
                      key={keg.number}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setPicked((prev) => toggleInSet(prev, keg.number))}
                      className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition ${
                        on ? 'bg-blue-500/15 ring-1 ring-inset ring-blue-500/50' : 'hover:bg-zinc-900'
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                          on ? 'border-blue-500 bg-blue-500 text-white' : 'border-zinc-600'
                        }`}
                      >
                        {on && '✓'}
                      </span>
                      <span className="text-sm font-semibold text-zinc-100">#{keg.number}</span>
                      {keg.volume && (
                        <span className="rounded bg-black/40 px-1.5 py-0.5 text-xs text-zinc-400">
                          {keg.volume}
                        </span>
                      )}
                      <span className="ml-auto flex items-center gap-1.5 text-xs text-zinc-500">
                        {stateColor && (
                          <span
                            aria-hidden
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: stateColor }}
                          />
                        )}
                        {keg.contents || '???'}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {overCapacity && (
            <p className="text-sm text-amber-400">
              ⚠ The kegs picked hold {pickedVolume}
              {unit && ` ${unit}`} — more than #{source.number}’s {sourceVolume}
              {unit && ` ${unit}`}. Fine if you know what you’re leaving behind.
            </p>
          )}

          <p className="text-xs text-zinc-500">
            Each keg picked gets {source.contents}
            {source.date && `, filled ${source.date}`}
            {source.abv && ` at ${source.abv.replace(/%/g, '')}%`}. Keg #{source.number} is then
            marked Dirty and its details cleared.
          </p>

          {error && <p className="text-sm text-red-400">{error}</p>}
          {progress && <p className="text-sm text-zinc-500">{progress}</p>}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-zinc-800 px-5 py-3.5">
          <button type="button" onClick={onClose} className={btnGhost} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleTransfer()}
            disabled={saving || targets.length === 0}
            className={btnPrimary}
          >
            {saving
              ? 'Transferring…'
              : targets.length === 0
                ? 'Transfer'
                : `Transfer to ${targets.length} keg${targets.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Pulsing placeholder shown while the sheet loads. */
function KegSkeleton(): JSX.Element {
  return (
    <div className="flex min-h-[7rem] animate-pulse flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-start justify-between">
        <div className="h-5 w-10 rounded bg-zinc-800" />
        <div className="h-4 w-8 rounded bg-zinc-800" />
      </div>
      <div className="h-5 w-20 rounded bg-zinc-800" />
      <div className="h-4 w-16 rounded bg-zinc-800" />
    </div>
  );
}

// --- Edit modal -------------------------------------------------------------

const inputClass =
  'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-blue-500';
const labelClass = 'mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-400';
const btnPrimary =
  'rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-40';
const btnGhost =
  'rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-40';

/** Strip the leading "<status>: " our api client prefixes onto error messages. */
function cleanError(err: unknown): string {
  return asMessage(err).replace(/^\d{3}:\s*/, '');
}

interface KegForm {
  contents: string;
  date: string;
  note: string;
  abv: string;
}

// BrewPlanner recipes, fetched once per page session and reused across every
// modal open. Caching here (rather than per-modal) means reopening a keg shows
// its linked-recipe chip instantly — no "Loading recipes…" flash — and avoids a
// fresh request on each edit. `recipesPromise` dedupes concurrent loads and is
// cleared on failure so the next open retries.
let recipesCache: Recipe[] | null = null;
let recipesPromise: Promise<Recipe[]> | null = null;

function loadRecipes(): Promise<Recipe[]> {
  if (recipesCache) return Promise.resolve(recipesCache);
  if (!recipesPromise) {
    recipesPromise = api
      .listRecipes()
      .then((data) => {
        recipesCache = data;
        return data;
      })
      .catch((err) => {
        recipesPromise = null; // allow a retry on the next open
        throw err;
      });
  }
  return recipesPromise;
}

/**
 * The keg editor, used for both a single keg and a bulk "assign content to N
 * kegs". In bulk mode the date/note/abv fields start blank and a blank value
 * keeps each keg's existing value (only contents is forced onto every keg); for
 * a single keg the fields are pre-filled and saved verbatim (so clearing one
 * clears that cell). Contents can be picked from the known types or pulled from
 * a linked Brewer's Friend recipe.
 */
function KegEditModal({
  kegs,
  colors,
  onClose,
  onSaved,
  onTransfer,
}: {
  kegs: Keg[];
  colors: Record<KegContent, string>;
  onClose: () => void;
  onSaved: (updated: Keg[]) => void;
  /** Hand this keg's beer to the transfer picker. Absent when there's none to move. */
  onTransfer?: () => void;
}): JSX.Element {
  const isBulk = kegs.length > 1;
  // Callers only mount this with at least one keg (a single edit or a non-empty
  // selection), so kegs[0] is always present.
  const first = kegs[0]!;

  // A keg that is already dirty opens with its beer fields blank, whatever the
  // sheet still holds: they're about to be cleared on save, so showing them
  // would only promise they'd be kept. Its note is its own — a dirty keg's note
  // is about the keg, not the beer that left — so that one is shown as written.
  const startsDirty = !isBulk && isDirtyContents(first.contents);
  const [form, setForm] = useState<KegForm>({
    contents: first.contents || '???',
    date: isBulk || startsDirty ? '' : first.date,
    note: isBulk ? '' : first.note,
    abv: isBulk || startsDirty ? '' : first.abv,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');

  // Recipe linking. The BrewPlanner list is cached across opens (see
  // loadRecipes); failures leave the picker empty/disabled. When the cache is
  // already warm we seed straight from
  // it so a linked keg's chip shows with no loading flash.
  const [recipes, setRecipes] = useState<Recipe[]>(recipesCache ?? []);
  const [recipesLoading, setRecipesLoading] = useState(recipesCache === null);
  const [showPicker, setShowPicker] = useState(false);
  const [recipeSearch, setRecipeSearch] = useState('');
  const [linkedRecipe, setLinkedRecipe] = useState<Recipe | null>(() =>
    !isBulk && !startsDirty && first.recipeId && recipesCache
      ? recipesCache.find((r) => r.id === first.recipeId) ?? null
      : null,
  );
  // The id actually written back. Seeded from the keg so a single-keg save made
  // before the recipe list loads (or while it's unreachable) preserves the link
  // instead of wiping it; `linkedRecipe` only drives the display chip. Bulk edits
  // don't use this — they key off `linkedRecipe` so they only touch the link when
  // one was explicitly chosen.
  const [recipeId, setRecipeId] = useState(isBulk || startsDirty ? '' : first.recipeId);

  // Close on Escape; lock body scroll while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not while something inside has claimed the key — the contents dropdown
      // closes its own list first, as a native select's popup used to.
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  useEffect(() => {
    // Already seeded from a warm cache — nothing to fetch.
    if (recipesCache) return;
    let cancelled = false;
    loadRecipes()
      .then((data) => {
        if (cancelled) return;
        setRecipes(data);
        // Restore the linked-recipe chip for a single keg that was saved with a
        // recipe (bulk edits don't carry one). Matched from the fetched list so
        // the name/style/url stay current.
        if (!isBulk && !startsDirty && first.recipeId) {
          const saved = data.find((r) => r.id === first.recipeId);
          if (saved) setLinkedRecipe(saved);
        }
      })
      .catch(() => {
        // Recipe library unavailable — recipe linking stays off.
      })
      .finally(() => {
        if (!cancelled) setRecipesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (field: keyof KegForm, value: string): void =>
    setForm((f) => ({ ...f, [field]: value }));

  // A keg marked dirty has been emptied, so nothing the beer left behind stays
  // with it — the server clears those cells on the way to the sheet either way
  // (see normalizeKegUpdate). Emptying the fields here as well, and locking
  // them, means the form shows what is about to be written rather than letting
  // someone type an ABV that silently vanishes on save.
  const isDirty = isDirtyContents(form.contents);

  const handleContents = (value: string): void => {
    if (!isDirtyContents(value)) {
      update('contents', value);
      return;
    }
    // Turning dirty drops the beer, its note included — "Dry-hopped" describes
    // something nobody can pour any more. The field stays open, though: what
    // gets typed from here is about the keg ("seal weeping"), and it sticks.
    setForm({ contents: value, date: '', note: '', abv: '' });
    setLinkedRecipe(null);
    setRecipeId('');
  };

  const handleLink = (recipe: Recipe): void => {
    setLinkedRecipe(recipe);
    setRecipeId(recipe.id);
    setShowPicker(false);
    setRecipeSearch('');
    const match = matchContentOption(recipe.name, recipe.style);
    // Carry the recipe's ABV across, rounded to one decimal; keep what's set if
    // the recipe has no (numeric) ABV.
    const recipeAbv = Number(recipe.abv);
    const abv = recipe.abv && Number.isFinite(recipeAbv) ? recipeAbv.toFixed(1) : '';
    setForm((f) => ({
      ...f,
      contents: match ?? recipe.name,
      abv: abv || f.abv,
    }));
  };

  const filteredRecipes = recipes.filter((r) => {
    if (!recipeSearch) return true;
    const q = recipeSearch.toLowerCase();
    return r.name.toLowerCase().includes(q) || (r.style || '').toLowerCase().includes(q);
  });

  // Keep the current contents selectable even when it isn't one of the known
  // types — a linked recipe name, or a custom value already in the sheet.
  const extraContent =
    form.contents && !(KEG_CONTENT_OPTIONS as string[]).includes(form.contents)
      ? form.contents
      : null;

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError('');
    const updated: Keg[] = [];
    const color = getContentColor(form.contents, colors) ?? null;

    for (const [i, keg] of kegs.entries()) {
      if (isBulk) setProgress(`Saving keg ${i + 1} of ${kegs.length}…`);
      // Bulk: a blank field keeps the keg's existing value. Single: saved as-is.
      const date = isBulk ? form.date.trim() || keg.date : form.date.trim();
      const note = isBulk ? form.note.trim() || keg.note : form.note.trim();
      const abv = isBulk ? form.abv.trim() || keg.abv : form.abv.trim();
      // Recipe link. Bulk only overwrites when a recipe was actually linked (so
      // bulk-assigning content doesn't wipe each keg's existing link); single
      // saves the tracked id (seeded from the keg), so unlinking clears the cell.
      const kegRecipeId = isBulk ? linkedRecipe?.id ?? keg.recipeId : recipeId;
      // Dirty wins over "blank keeps the existing value": marking a batch of
      // kegs dirty has to empty every one of them, not preserve their beers.
      // The note is whatever the field now holds — blanked when the keg turned
      // dirty, unless something was typed about the keg since.
      const fields = isDirty
        ? { contents: form.contents, ...EMPTIED_KEG_FIELDS, note: form.note.trim() }
        : { contents: form.contents, date, note, abv, recipeId: kegRecipeId };
      try {
        await api.updateKeg(keg.number, fields);
        updated.push({ ...keg, ...fields, color });
      } catch (e) {
        setError(`Failed on keg #${keg.number}: ${cleanError(e)}`);
        setSaving(false);
        setProgress('');
        // Still apply whatever saved before the failure.
        if (updated.length > 0) onSaved(updated);
        return;
      }
    }

    setSaving(false);
    setProgress('');
    onSaved(updated);
  };

  const titleColor = contentLabelColor(form.contents, colors);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm"
      />

      <div className="relative z-10 max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/50">
        <div className="sticky top-0 flex items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/95 px-5 py-3.5 backdrop-blur">
          <h2 className="truncate text-base font-semibold tracking-tight text-zinc-50">
            {isBulk ? (
              `Edit ${kegs.length} kegs`
            ) : (
              <>
                Edit keg <span style={titleColor ? { color: titleColor } : undefined}>#{first.number}</span>
              </>
            )}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-lg text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 p-5">
          {isBulk && (
            <p className="text-sm text-zinc-500">
              Kegs: {kegs.map((k) => `#${k.number}`).join(', ')}
            </p>
          )}

          {/* Recipe linking — a dirty keg holds no beer, so it links to none. */}
          <div className={isDirty ? 'hidden' : undefined}>
            {!linkedRecipe ? (
              !showPicker ? (
                <button
                  type="button"
                  onClick={() => setShowPicker(true)}
                  disabled={recipesLoading || recipes.length === 0}
                  className={`${btnGhost} w-full`}
                >
                  {recipesLoading
                    ? 'Loading recipes…'
                    : recipes.length === 0
                      ? 'No recipes to link'
                      : 'Link a Brewer’s Friend recipe'}
                </button>
              ) : (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900">
                  <div className="flex items-center gap-2 border-b border-zinc-800 p-2">
                    <input
                      type="text"
                      autoFocus
                      placeholder="Search recipes…"
                      value={recipeSearch}
                      onChange={(e) => setRecipeSearch(e.target.value)}
                      className={inputClass}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setShowPicker(false);
                        setRecipeSearch('');
                      }}
                      aria-label="Close recipe picker"
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="max-h-52 overflow-y-auto p-1">
                    {filteredRecipes.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => handleLink(r)}
                        className="flex w-full flex-col items-start rounded-md px-3 py-2 text-left transition hover:bg-zinc-800"
                      >
                        <span className="text-sm font-medium text-zinc-100">{r.name}</span>
                        <span className="text-xs text-zinc-500">{r.style || 'No style'}</span>
                      </button>
                    ))}
                    {filteredRecipes.length === 0 && (
                      <p className="px-3 py-4 text-center text-sm text-zinc-500">No matching recipes</p>
                    )}
                  </div>
                </div>
              )
            ) : (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-blue-500/40 bg-blue-500/10 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-xs uppercase tracking-wide text-blue-300/80">Linked recipe</div>
                  {linkedRecipe.url ? (
                    <a
                      href={linkedRecipe.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-sm font-medium text-blue-300 underline-offset-2 hover:underline"
                      title="Open recipe in a new tab"
                    >
                      {linkedRecipe.name}
                    </a>
                  ) : (
                    <div className="truncate text-sm font-medium text-zinc-100">{linkedRecipe.name}</div>
                  )}
                  <div className="truncate text-xs text-zinc-400">{linkedRecipe.style || 'No style'}</div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setLinkedRecipe(null);
                    setRecipeId('');
                  }}
                  aria-label="Unlink recipe"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
                >
                  ✕
                </button>
              </div>
            )}
          </div>

          {/* Contents */}
          <div>
            <label className={labelClass} htmlFor="keg-contents">
              Contents
            </label>
            <Select
              id="keg-contents"
              className={inputClass}
              value={form.contents}
              onChange={handleContents}
              options={[
                ...(extraContent ? [{ value: extraContent }] : []),
                ...KEG_CONTENT_OPTIONS.map((opt) => ({ value: opt })),
              ]}
            />
            {isDirty && (
              <p className="mt-2 text-xs text-zinc-500">
                Emptied — the fill date, ABV and recipe link are cleared. A note about the keg
                itself still sticks.
              </p>
            )}
          </div>

          {/* Date */}
          <div>
            <label className={labelClass} htmlFor="keg-date">
              Date
              {isBulk && !isDirty && (
                <span className="ml-1 normal-case text-zinc-500">(blank = keep existing)</span>
              )}
            </label>
            <div className="flex gap-2">
              <input
                id="keg-date"
                type="text"
                className={`${inputClass} disabled:text-zinc-600`}
                value={form.date}
                disabled={isDirty}
                onChange={(e) => update('date', e.target.value)}
                placeholder={isBulk && !isDirty ? 'Leave blank to keep existing' : 'DD/MM/YYYY'}
              />
              <button
                type="button"
                disabled={isDirty}
                onClick={() => update('date', todayDDMMYYYY())}
                className={btnGhost}
              >
                Today
              </button>
            </div>
          </div>

          {/* Note */}
          <div>
            <label className={labelClass} htmlFor="keg-note">
              Note
              {isBulk && !isDirty && (
                <span className="ml-1 normal-case text-zinc-500">(blank = keep existing)</span>
              )}
            </label>
            <input
              id="keg-note"
              type="text"
              className={inputClass}
              value={form.note}
              onChange={(e) => update('note', e.target.value)}
              placeholder={
                isDirty
                  ? 'e.g. Seal is weeping'
                  : isBulk
                    ? 'Leave blank to keep existing'
                    : 'e.g. Dry-hopped'
              }
            />
          </div>

          {/* ABV */}
          <div>
            <label className={labelClass} htmlFor="keg-abv">
              ABV
              {isBulk && !isDirty && (
                <span className="ml-1 normal-case text-zinc-500">(blank = keep existing)</span>
              )}
            </label>
            <input
              id="keg-abv"
              type="text"
              className={`${inputClass} disabled:text-zinc-600`}
              value={form.abv}
              disabled={isDirty}
              onChange={(e) => update('abv', e.target.value)}
              placeholder={isBulk && !isDirty ? 'Leave blank to keep existing' : 'e.g. 5.2'}
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}
          {progress && <p className="text-sm text-zinc-500">{progress}</p>}
        </div>

        <div className="sticky bottom-0 flex items-center justify-end gap-3 border-t border-zinc-800 bg-zinc-950/95 px-5 py-3.5 backdrop-blur">
          {/* Racking this beer somewhere else is a different job from editing the
              row, so it hands off to its own dialog rather than growing this
              form. Offered only while the keg still holds the beer as saved —
              once the contents field has been changed here, what would move is
              no longer what's in the keg. */}
          {onTransfer && form.contents === first.contents && (
            <button
              type="button"
              onClick={onTransfer}
              disabled={saving}
              className={`${btnGhost} mr-auto`}
            >
              ⇄ Transfer contents…
            </button>
          )}
          <button type="button" onClick={onClose} className={btnGhost} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !form.contents.trim()}
            className={btnPrimary}
          >
            {saving ? 'Saving…' : isBulk ? `Save ${kegs.length} kegs` : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
