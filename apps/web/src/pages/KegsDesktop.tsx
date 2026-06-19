import type { KegContent, Recipe } from '@checklist/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { canControl, useAuth } from '../auth';
import { DashboardShell } from '../components/DashboardShell';
import { useKegContentColors } from '../kegContentColors';
import {
  KEG_CONTENT_OPTIONS,
  SHEETS_VIEW_URL,
  SORT_OPTIONS,
  type Keg,
  type SortKey,
  getContentColor,
  hexToRgb,
  isUnknownContents,
  matchContentOption,
  sortKegs,
  todayDDMMYYYY,
  useKegs,
} from '../kegs';
import { asMessage } from '../util';

/** Re-pull the sheet every minute so a fill/empty done elsewhere shows up. */
const POLL_MS = 60_000;

/** slate-800 — the base colour each content tint fades into (matches brew-system). */
const TINT_BASE = '#1e293b';

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
  const { auth } = useAuth();
  // Guests are read-only: they can browse and sort kegs, but can't edit content,
  // multi-select, or open the source sheet. The kiosk/LAN and admins get the
  // full editor.
  const controllable = canControl(auth);
  const [sortKey, setSortKey] = useState<SortKey>('number');
  const [sortAsc, setSortAsc] = useState(true);

  // Single-keg edit (the keg being edited, or null).
  const [editingKeg, setEditingKeg] = useState<Keg | null>(null);
  // Multi-select: a Set of keg numbers, the range anchor (the last keg clicked
  // without Shift, like a file list), an explicit "Select" toggle, and whether
  // the bulk modal is open.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [bulkEditing, setBulkEditing] = useState(false);

  const filled = kegs.filter((k) => !isUnknownContents(k.contents)).length;
  const sorted = sortKegs(kegs, sortKey, sortAsc);
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

  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
    setAnchor(null);
  }, []);

  // Escape deselects while selecting but no modal is open (modals handle their own Escape).
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editingKeg && !bulkEditing) exitSelect();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting, editingKeg, bulkEditing, exitSelect]);

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
      exitSelect();
    },
    [applyLocalUpdates, exitSelect],
  );

  return (
    <DashboardShell active="kegs">
      <main className="w-full max-w-[1580px] px-5 py-5">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-50">Kegs</h1>
            <p className="mt-0.5 truncate text-sm text-zinc-500">
              {loading ? (
                'Loading keg data…'
              ) : error ? (
                <span className="text-red-400">{error}</span>
              ) : selecting ? (
                `${selected.size} selected — Ctrl-click to toggle, Shift-click for a range`
              ) : (
                `Current inventory — ${filled} of ${kegs.length} kegs filled${
                  controllable ? ' · click to edit, Ctrl/Shift-click to select' : ''
                }`
              )}
            </p>
          </div>
          {controllable && (
            <div className="flex shrink-0 items-center gap-2">
              {selecting ? (
                <button
                  type="button"
                  onClick={exitSelect}
                  className="rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800"
                >
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setSelectMode(true)}
                  disabled={loading || kegs.length === 0}
                  className="rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
                >
                  Select
                </button>
              )}
              <a
                href={SHEETS_VIEW_URL}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
              >
                Inventory sheet ↗
              </a>
            </div>
          )}
        </div>

        {/* Sort bar — the active key gets the coral pill, with a direction arrow. */}
        <div className="mb-5 flex flex-wrap gap-2">
          {SORT_OPTIONS.map(({ key, label }) => {
            const active = key === sortKey;
            return (
              <button
                key={key}
                type="button"
                onClick={() => handleSort(key)}
                disabled={loading}
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${
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

        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}
        >
          {loading
            ? Array.from({ length: 12 }, (_, i) => <KegSkeleton key={i} />)
            : sorted.map((keg) => (
                <KegCard
                  key={keg.number}
                  keg={keg}
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

      {/* Single-keg editor. */}
      {editingKeg && (
        <KegEditModal
          kegs={[editingKeg]}
          colors={colors}
          onClose={() => setEditingKeg(null)}
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
  colors,
  selectMode,
  selected,
  interactive,
  onActivate,
}: {
  keg: Keg;
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
  const isStout = keg.contents.trim().toLowerCase() === 'stout';
  const rgb = color ? hexToRgb(color) : null;
  const cardStyle: React.CSSProperties = rgb
    ? {
        borderLeft: `3px solid ${color}`,
        background: `linear-gradient(135deg, rgba(${rgb}, ${isStout ? 0.55 : 0.15}), ${TINT_BASE})`,
      }
    : {};
  const labelColor = isStout ? '#A68B6B' : (color ?? undefined);

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
      {keg.date && <span className="mt-1 text-sm text-zinc-400">{keg.date}</span>}
      {keg.note && <span className="mt-1 text-sm italic text-zinc-400">{keg.note}</span>}
      {keg.abv && <span className="mt-auto pt-2 text-sm text-zinc-400">{keg.abv} ABV</span>}
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
}: {
  kegs: Keg[];
  colors: Record<KegContent, string>;
  onClose: () => void;
  onSaved: (updated: Keg[]) => void;
}): JSX.Element {
  const isBulk = kegs.length > 1;
  // Callers only mount this with at least one keg (a single edit or a non-empty
  // selection), so kegs[0] is always present.
  const first = kegs[0]!;

  const [form, setForm] = useState<KegForm>({
    contents: first.contents || '???',
    date: isBulk ? '' : first.date,
    note: isBulk ? '' : first.note,
    abv: isBulk ? '' : first.abv,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');

  // Recipe linking (Brewer's Friend). The list is fetched once; failures (no key
  // configured, upstream down) just leave the picker empty/disabled.
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [recipesLoading, setRecipesLoading] = useState(true);
  const [showPicker, setShowPicker] = useState(false);
  const [recipeSearch, setRecipeSearch] = useState('');
  const [linkedRecipe, setLinkedRecipe] = useState<Recipe | null>(null);

  // Close on Escape; lock body scroll while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
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
    let cancelled = false;
    api
      .listRecipes()
      .then((data) => {
        if (!cancelled) setRecipes(data);
      })
      .catch(() => {
        // No Brewer's Friend key / upstream error — recipe linking stays off.
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

  const handleLink = (recipe: Recipe): void => {
    setLinkedRecipe(recipe);
    setShowPicker(false);
    setRecipeSearch('');
    const match = matchContentOption(recipe.name, recipe.style);
    setForm((f) => ({ ...f, contents: match ?? recipe.name }));
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
      const fields = { contents: form.contents, date, note, abv };
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

  const titleColor = getContentColor(form.contents, colors);

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

          {/* Recipe linking */}
          <div>
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
                  <div className="truncate text-sm font-medium text-zinc-100">{linkedRecipe.name}</div>
                  <div className="truncate text-xs text-zinc-400">{linkedRecipe.style || 'No style'}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setLinkedRecipe(null)}
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
            <select
              id="keg-contents"
              className={inputClass}
              value={form.contents}
              onChange={(e) => update('contents', e.target.value)}
            >
              {extraContent && <option value={extraContent}>{extraContent}</option>}
              {KEG_CONTENT_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>

          {/* Date */}
          <div>
            <label className={labelClass} htmlFor="keg-date">
              Date{isBulk && <span className="ml-1 normal-case text-zinc-500">(blank = keep existing)</span>}
            </label>
            <div className="flex gap-2">
              <input
                id="keg-date"
                type="text"
                className={inputClass}
                value={form.date}
                onChange={(e) => update('date', e.target.value)}
                placeholder={isBulk ? 'Leave blank to keep existing' : 'DD/MM/YYYY'}
              />
              <button type="button" onClick={() => update('date', todayDDMMYYYY())} className={btnGhost}>
                Today
              </button>
            </div>
          </div>

          {/* Note */}
          <div>
            <label className={labelClass} htmlFor="keg-note">
              Note{isBulk && <span className="ml-1 normal-case text-zinc-500">(blank = keep existing)</span>}
            </label>
            <input
              id="keg-note"
              type="text"
              className={inputClass}
              value={form.note}
              onChange={(e) => update('note', e.target.value)}
              placeholder={isBulk ? 'Leave blank to keep existing' : 'e.g. Dry-hopped'}
            />
          </div>

          {/* ABV */}
          <div>
            <label className={labelClass} htmlFor="keg-abv">
              ABV{isBulk && <span className="ml-1 normal-case text-zinc-500">(blank = keep existing)</span>}
            </label>
            <input
              id="keg-abv"
              type="text"
              className={inputClass}
              value={form.abv}
              onChange={(e) => update('abv', e.target.value)}
              placeholder={isBulk ? 'Leave blank to keep existing' : 'e.g. 5.2%'}
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}
          {progress && <p className="text-sm text-zinc-500">{progress}</p>}
        </div>

        <div className="sticky bottom-0 flex items-center justify-end gap-3 border-t border-zinc-800 bg-zinc-950/95 px-5 py-3.5 backdrop-blur">
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
