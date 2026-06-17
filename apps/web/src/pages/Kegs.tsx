import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  SORT_OPTIONS,
  type Keg,
  type SortKey,
  getContentColor,
  hexToRgb,
  isUnknownContents,
  sortKegs,
  useKegs,
} from '../kegs';
import { homePath } from '../util';

/** Re-pull the sheet every minute so a fill/empty done elsewhere shows up. */
const POLL_MS = 60_000;

/** slate-800 — the base colour each content tint fades into (matches brew-system). */
const TINT_BASE = '#1e293b';

/**
 * Touch-first, read-only view of the brewery's keg inventory for the Pi kiosk.
 * Reads the same shared Google Sheet as the brew-system app and lays the kegs
 * out as colour-coded cards (a left border + a faint tint per content), with a
 * sort bar across the top. Edits still happen in the brew-system app; here the
 * inventory is purely viewed.
 */
export function KegsPage(): JSX.Element {
  const { kegs, loading, error } = useKegs(POLL_MS);
  const [sortKey, setSortKey] = useState<SortKey>('number');
  const [sortAsc, setSortAsc] = useState(true);

  const filled = kegs.filter((k) => !isUnknownContents(k.contents)).length;
  const sorted = sortKegs(kegs, sortKey, sortAsc);

  function handleSort(key: SortKey): void {
    if (key === sortKey) {
      setSortAsc((p) => !p);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  return (
    <div className="touch-none-select flex h-full flex-col bg-black text-white">
      <header className="flex shrink-0 items-center gap-3 border-b border-zinc-800 px-6 py-4">
        <Link
          to={homePath()}
          className="shrink-0 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-2xl leading-none transition active:bg-zinc-800"
          aria-label="Home"
        >
          ⌂
        </Link>
        <div className="min-w-0">
          <h1 className="text-3xl font-bold leading-tight tracking-tight">Keg Status</h1>
          <p className="truncate text-sm text-zinc-400">
            {loading ? (
              'Loading keg data…'
            ) : error ? (
              <span className="text-red-300">{error}</span>
            ) : (
              `Current inventory — ${filled} of ${kegs.length} kegs filled`
            )}
          </p>
        </div>
      </header>

      {/* Sort bar — the active key gets the coral pill, with a direction arrow. */}
      <div className="flex shrink-0 flex-wrap gap-2 border-b border-zinc-800/60 px-6 py-3">
        {SORT_OPTIONS.map(({ key, label }) => {
          const active = key === sortKey;
          return (
            <button
              key={key}
              type="button"
              onClick={() => handleSort(key)}
              disabled={loading}
              className={`flex touch-manipulation items-center gap-1.5 rounded-xl border px-4 py-2 text-sm font-semibold transition active:scale-95 disabled:opacity-50 ${
                active
                  ? 'border-transparent bg-gradient-to-br from-[#f87a68] to-[#e0463f] text-white shadow'
                  : 'border-zinc-700 bg-zinc-900 text-zinc-300 active:bg-zinc-800'
              }`}
            >
              {label}
              {active && <span aria-hidden>{sortAsc ? '▲' : '▼'}</span>}
            </button>
          );
        })}
      </div>

      <main className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}
        >
          {loading
            ? Array.from({ length: 12 }, (_, i) => <KegSkeleton key={i} />)
            : sorted.map((keg) => <KegCard key={keg.number} keg={keg} />)}
        </div>
        {!loading && !error && kegs.length === 0 && (
          <p className="mt-10 text-center text-xl text-zinc-400">No kegs found.</p>
        )}
      </main>
    </div>
  );
}

/**
 * A single keg tile: number + size, then the content (tinted by type), date,
 * note and ABV. Empty ("???") kegs dim and the colour cues fall away to grey,
 * matching the brew-system app's card.
 */
function KegCard({ keg }: { keg: Keg }): JSX.Element {
  const color = getContentColor(keg.contents);
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

  return (
    <div
      className={`flex min-h-[8rem] flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-4 ${
        unknown ? 'opacity-50' : ''
      }`}
      style={cardStyle}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-2xl font-bold leading-none">#{keg.number}</span>
        {keg.volume && (
          <span className="shrink-0 rounded-md bg-black/30 px-2 py-0.5 text-xs font-medium text-zinc-400">
            {keg.volume}
          </span>
        )}
      </div>
      <span
        className="mt-3 text-lg font-semibold leading-tight"
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
    <div className="flex min-h-[8rem] animate-pulse flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-start justify-between">
        <div className="h-6 w-10 rounded bg-zinc-800" />
        <div className="h-4 w-8 rounded bg-zinc-800" />
      </div>
      <div className="h-5 w-20 rounded bg-zinc-800" />
      <div className="h-4 w-16 rounded bg-zinc-800" />
    </div>
  );
}
