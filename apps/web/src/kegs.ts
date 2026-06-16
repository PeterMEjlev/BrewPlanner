import {
  KEG_SHEET_CSV_URL,
  KEG_SHEET_VIEW_URL,
  type Keg,
  parseKegDate,
  parseKegs,
} from '@checklist/shared';
import { useEffect, useState } from 'react';

/**
 * Keg inventory lives in a shared Google Sheet — the same one the brew-system
 * app reads (see brew-system-v3 KegStatusPage). The sheet URL, column layout,
 * and CSV parsing now live in @checklist/shared so the server's keg-age
 * notification reads exactly the same data; this module re-exports them and
 * keeps the web-only concerns (per-content colours, sorting, the polling hook).
 */
export type { Keg };
/** Human-facing sheet URL for "open in a new tab" links. */
export const SHEETS_VIEW_URL = KEG_SHEET_VIEW_URL;

/**
 * Per-content colours, chosen to evoke the actual appearance of each beer / keg
 * state. Mirrors the brew-system app so a keg looks the same in both UIs.
 */
const CONTENT_COLORS: Record<string, string> = {
  IPA: '#C8782A', // amber copper
  NEIPA: '#3ee849', // hazy orange-gold
  Wiessbeer: '#E8C84A', // cloudy banana-gold
  Sour: '#D64878', // tart raspberry pink
  'Brown Ale': '#7A3B1A', // rich mahogany
  Starsan: '#b8faff', // sanitiser blue
  SIPA: '#2a9826', // session IPA green
  Pilsner: '#DEC05C', // pale straw gold
  Stout: '#3A2A1A', // near-black dark roast
  Dirty: '#ff0000', // warning red
  Clean: '#ffffff', // fresh
  '???': '#707070', // neutral grey
};

/** Colour for a keg's contents, or null when the content is unrecognised. */
export function getContentColor(contents: string): string | null {
  const key = Object.keys(CONTENT_COLORS).find(
    (k) => k.toLowerCase() === contents.trim().toLowerCase(),
  );
  return key ? CONTENT_COLORS[key]! : null;
}

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
  const res = await fetch(KEG_SHEET_CSV_URL);
  if (!res.ok) throw new Error('Failed to fetch keg data');
  return parseKegs(await res.text());
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
