import { useState } from 'react';
import { DashboardShell } from '../components/DashboardShell';
import {
  SHEETS_VIEW_URL,
  SORT_OPTIONS,
  type Keg,
  type SortKey,
  getContentColor,
  hexToRgb,
  isUnknownContents,
  sortKegs,
  useKegs,
} from '../kegs';

/** Re-pull the sheet every minute so a fill/empty done elsewhere shows up. */
const POLL_MS = 60_000;

/** slate-800 — the base colour each content tint fades into (matches brew-system). */
const TINT_BASE = '#1e293b';

/**
 * Desktop Kegs — the mouse-and-keyboard counterpart to the kiosk's touch keg
 * screen ([Kegs.tsx]). Same read-only inventory from the shared Google Sheet,
 * but wrapped in the desktop [DashboardShell] with compact controls instead of
 * the kiosk's full-screen touch chrome. Edits still happen in the brew-system
 * app (or the linked sheet); here the inventory is purely viewed.
 */
export function KegsDesktopPage(): JSX.Element {
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
              ) : (
                `Current inventory — ${filled} of ${kegs.length} kegs filled`
              )}
            </p>
          </div>
          <a
            href={SHEETS_VIEW_URL}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
          >
            Inventory sheet ↗
          </a>
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
            : sorted.map((keg) => <KegCard key={keg.number} keg={keg} />)}
        </div>
        {!loading && !error && kegs.length === 0 && (
          <p className="mt-10 text-center text-lg text-zinc-400">No kegs found.</p>
        )}
      </main>
    </DashboardShell>
  );
}

/**
 * A single keg tile: number + size, then the content (tinted by type), date,
 * note and ABV. Empty ("???") kegs dim and the colour cues fall away to grey,
 * matching the brew-system app's card and the kiosk view.
 */
function KegCard({ keg }: { keg: Keg }): JSX.Element {
  const color = keg.color ?? getContentColor(keg.contents);
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
      className={`flex min-h-[7rem] flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-4 ${
        unknown ? 'opacity-50' : ''
      }`}
      style={cardStyle}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-xl font-bold leading-none">#{keg.number}</span>
        {keg.volume && (
          <span className="shrink-0 rounded-md bg-black/30 px-2 py-0.5 text-xs font-medium text-zinc-400">
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
