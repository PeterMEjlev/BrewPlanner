import {
  KEG_SHEET_VIEW_URL,
  getContentColor,
  type Keg,
  parseKegDate,
} from '@checklist/shared';
import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * Keg inventory lives in a shared Google Sheet — the same one the brew-system
 * app reads (see brew-system-v3 KegStatusPage). The server reads that sheet,
 * applies the shared keg-content colour settings, and returns JSON; this module
 * keeps the web-only concerns (sorting and the polling hook).
 */
export type { Keg };
export { getContentColor };
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

  return { kegs, loading, error };
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
