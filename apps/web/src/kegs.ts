import {
  KEG_CONTENT_OPTIONS,
  KEG_SHEET_VIEW_URL,
  getContentColor,
  type Keg,
  matchContentOption,
  parseKegDate,
} from '@checklist/shared';
import { useCallback, useState } from 'react';
import { api } from './api';
import { usePoll } from './usePoll';

/**
 * Keg inventory lives in a shared Google Sheet — the same one the brew-system
 * app reads (see brew-system-v3 KegStatusPage). The server reads that sheet,
 * applies the shared keg-content colour settings, and returns JSON; this module
 * keeps the web-only concerns (sorting, the polling hook, and the desktop
 * editor's helpers).
 */
export type { Keg };
export { getContentColor, KEG_CONTENT_OPTIONS, matchContentOption };

/** Today as DD/MM/YYYY — the sheet's date format, for the editor's "Today" button. */
export function todayDDMMYYYY(): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}
/** Human-facing sheet URL for "open in a new tab" links. */
export const SHEETS_VIEW_URL = KEG_SHEET_VIEW_URL;

/** "#3ee849" → "62, 232, 73" so it can drop into an rgba() tint. */
export function hexToRgb(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/**
 * An empty/unassigned keg is marked "???" in the sheet — but a blank cell means
 * the same thing, so treat an empty (or whitespace-only) value as unknown too.
 */
export function isUnknownContents(contents: string): boolean {
  const c = contents.trim();
  return c === '' || c === '???';
}

export async function fetchKegs(): Promise<Keg[]> {
  return api.getKegs();
}

// --- Freshness indicator ----------------------------------------------------

/**
 * How long a keg has been filled, bucketed for the card's date indicator:
 * 'fresh' (no flag), 'warning' (amber) once past the warn threshold, 'old' (red)
 * once past the older one. Mirrors the brew sheet's yellow/red date-cell shading.
 */
export type KegAgeStatus = 'fresh' | 'warning' | 'old';

/** Day thresholds for {@link describeKegAge}, sourced from local Settings. */
export interface KegAgeThresholds {
  warnDays: number;
  oldDays: number;
}

/** Whole days since a keg's fill date, or null when undated/unparseable. */
export function kegAgeDays(date: string): number | null {
  const filled = parseKegDate(date);
  if (!filled) return null;
  return Math.floor((Date.now() - filled) / 86_400_000);
}

/** Presentation bundle for a keg's date, given the freshness thresholds. */
export interface KegAgeIndicator {
  status: KegAgeStatus;
  /** Tailwind classes for the date chip when flagged; '' when fresh (plain text). */
  chipClass: string;
  /** Leading glyph for the chip; '' when fresh. */
  icon: string;
  /** Tooltip explaining the flag; undefined when fresh. */
  title: string | undefined;
}

const FRESH_INDICATOR: KegAgeIndicator = { status: 'fresh', chipClass: '', icon: '', title: undefined };

/**
 * Classify a keg's age and bundle the date chip's styling + tooltip. Only filled
 * kegs (known contents) with a parseable fill date are flagged; empty/undated
 * kegs stay 'fresh'. The 'old' bucket wins over 'warning' even if the thresholds
 * are mis-ordered, so the more urgent red always takes precedence.
 */
export function describeKegAge(keg: Keg, { warnDays, oldDays }: KegAgeThresholds): KegAgeIndicator {
  if (isUnknownContents(keg.contents)) return FRESH_INDICATOR;
  const ageDays = kegAgeDays(keg.date);
  if (ageDays === null) return FRESH_INDICATOR;

  if (ageDays >= oldDays) {
    return {
      status: 'old',
      chipClass:
        'rounded-md bg-red-500/20 px-1.5 py-0.5 text-red-300 ring-1 ring-inset ring-red-500/50',
      icon: '⚠',
      title: `Filled ${ageDays} days ago — over ${oldDays}, likely past its best`,
    };
  }
  if (ageDays >= warnDays) {
    return {
      status: 'warning',
      chipClass:
        'rounded-md bg-amber-500/15 px-1.5 py-0.5 text-amber-300 ring-1 ring-inset ring-amber-500/40',
      icon: '⏳',
      title: `Filled ${ageDays} days ago — over ${warnDays}, keep an eye on it`,
    };
  }
  return FRESH_INDICATOR;
}

export interface UseKegs {
  kegs: Keg[];
  loading: boolean;
  error: string | null;
  /**
   * Merge just-edited kegs (matched by number) into local state, so a save shows
   * immediately without waiting for the next poll. The published CSV can lag a
   * fresh write by a minute or two, so this optimistic update — not a refetch —
   * is what keeps the grid in sync right after an edit.
   */
  applyLocalUpdates: (updated: Keg[]) => void;
}

/**
 * Module-level cache of the last successful keg fetch, kept alive across hook
 * unmounts so leaving and returning to the dashboard renders the inventory
 * instantly instead of flashing the loading state and refetching from scratch.
 * The hook still refreshes in the background to pick up changes.
 */
let cachedKegs: Keg[] | null = null;

/** Fetch the keg inventory on mount, optionally re-polling every `pollMs`. */
export function useKegs(pollMs?: number): UseKegs {
  const [kegs, setKegs] = useState<Keg[]>(() => cachedKegs ?? []);
  // Only show the loading state on the very first fetch (no cache yet); a
  // background refresh on a remount shouldn't blank out the existing data.
  const [loading, setLoading] = useState(cachedKegs === null);
  const [error, setError] = useState<string | null>(null);

  usePoll(async (isStale) => {
    try {
      const data = await fetchKegs();
      if (isStale()) return;
      cachedKegs = data;
      setKegs(data);
      setError(null);
    } catch (e) {
      if (!isStale()) setError(e instanceof Error ? e.message : 'Failed to fetch keg data');
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, pollMs || null);

  const applyLocalUpdates = useCallback((updated: Keg[]) => {
    const byNumber = new Map(updated.map((k) => [k.number, k]));
    setKegs((prev) => {
      const merged = prev.map((k) => byNumber.get(k.number) ?? k);
      cachedKegs = merged;
      return merged;
    });
  }, []);

  return { kegs, loading, error, applyLocalUpdates };
}

// --- Sorting ----------------------------------------------------------------

export type SortKey = 'number' | 'volume' | 'contents' | 'date' | 'note' | 'abv';

export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'number', label: 'Keg #' },
  { key: 'volume', label: 'Size' },
  { key: 'contents', label: 'Contents' },
  { key: 'date', label: 'Date' },
  { key: 'note', label: 'Note' },
  { key: 'abv', label: 'ABV' },
];

function parseVolume(v: string): number {
  return parseFloat(v) || 0;
}

export function sortKegs(kegs: Keg[], sortKey: SortKey, sortAsc: boolean): Keg[] {
  const dir = sortAsc ? 1 : -1;
  return [...kegs].sort((a, b) => {
    switch (sortKey) {
      case 'number':
        return (parseInt(a.number) - parseInt(b.number)) * dir;
      case 'volume':
        return (parseVolume(a.volume) - parseVolume(b.volume)) * dir;
      case 'contents':
        return a.contents.localeCompare(b.contents) * dir;
      case 'date': {
        const da = parseKegDate(a.date);
        const db = parseKegDate(b.date);
        // Undated kegs always sort to the bottom, regardless of direction.
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return (da - db) * dir;
      }
      case 'note':
        return a.note.localeCompare(b.note) * dir;
      case 'abv': {
        const aa = parseFloat(a.abv) || 0;
        const ab = parseFloat(b.abv) || 0;
        if (!aa && !ab) return 0;
        if (!aa) return 1;
        if (!ab) return -1;
        return (aa - ab) * dir;
      }
      default:
        return 0;
    }
  });
}
