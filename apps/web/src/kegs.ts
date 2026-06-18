import {
  KEG_CONTENT_OPTIONS,
  KEG_SHEET_VIEW_URL,
  getContentColor,
  type Keg,
  matchContentOption,
  parseKegDate,
} from '@checklist/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

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

/** An empty/unassigned keg is marked "???" in the sheet. */
export function isUnknownContents(contents: string): boolean {
  return contents.trim() === '???';
}

export async function fetchKegs(): Promise<Keg[]> {
  return api.getKegs();
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

/** Fetch the keg inventory on mount, optionally re-polling every `pollMs`. */
export function useKegs(pollMs?: number): UseKegs {
  const [kegs, setKegs] = useState<Keg[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await fetchKegs();
        if (cancelled) return;
        setKegs(data);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to fetch keg data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const id = pollMs ? setInterval(() => void load(), pollMs) : undefined;
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
    };
  }, [pollMs]);

  const applyLocalUpdates = useCallback((updated: Keg[]) => {
    const byNumber = new Map(updated.map((k) => [k.number, k]));
    setKegs((prev) => prev.map((k) => byNumber.get(k.number) ?? k));
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
