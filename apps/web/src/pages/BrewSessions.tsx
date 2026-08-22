import type { BrewSession, Recipe } from '@checklist/shared';
import { BREW_SESSION_STATUS_LABELS, abvFromGravities, ebcColor } from '@checklist/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { canControl, useAuth } from '../auth';
import {
  STATUS_CHIP,
  brewDate,
  brewYear,
  dateInputToIso,
  dateInputValue,
  formatDuration,
  gravityText,
  isInProgress,
} from '../brewSessions';
import { DashboardShell } from '../components/DashboardShell';
import { Select } from '../components/Select';
import { fmt } from '../recipeFigures';
import { loadRecipes } from '../recipeStore';
import { asCleanMessage, relativeTime } from '../util';

/**
 * The brewery's logbook: every batch that has been brewed, newest first.
 *
 * Batches still on their way to the keg are pinned above the log — that's the
 * one thing this page is asked in the middle of a brew session ("what's in the
 * tank, and how long has it been in there?"), and burying it in date order
 * would mean scrolling past last winter's stout to find it.
 */
export function BrewSessionsPage(): JSX.Element {
  const { auth } = useAuth();
  const controllable = canControl(auth);
  const navigate = useNavigate();

  const [brewSessions, setBrewSessions] = useState<BrewSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logging, setLogging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.listBrewSessions();
        if (!cancelled) {
          setBrewSessions(list);
          setError(null);
        }
      } catch (e) {
        if (cancelled) return;
        // The log is the page, so a failure leaves the empty state with the reason.
        setBrewSessions((prev) => prev ?? []);
        setError(asCleanMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const list = brewSessions ?? [];
  const inProgress = useMemo(() => list.filter(isInProgress), [list]);
  const finished = useMemo(() => list.filter((day) => !isInProgress(day)), [list]);

  /** Start (or back-date) a brew session, then open it so the figures can be typed in. */
  async function start(recipeId: string, brewedAt: string | null): Promise<void> {
    const created = await api.startBrewSession(recipeId, brewedAt ?? undefined);
    setLogging(false);
    navigate(`/brew-sessions/${created.id}`);
  }

  return (
    <DashboardShell active="brewSessions">
      <main className="w-full max-w-[1100px] px-5 py-5">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-zinc-500">
              {list.length > 0
                ? `${list.length} brew${list.length === 1 ? '' : 's'} logged${
                    inProgress.length > 0 ? ` · ${inProgress.length} in progress` : ''
                  }`
                : 'Every batch this brewery has made.'}
            </p>
          </div>
          {controllable && (
            <button
              type="button"
              onClick={() => setLogging(true)}
              className="rounded-lg bg-gradient-to-br from-[#f87a68] to-[#e0463f] px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110"
            >
              New brew session
            </button>
          )}
        </div>

        {error && (
          <div className="mb-5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {brewSessions === null ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-400">
            Loading brew sessions…
          </div>
        ) : list.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-900/40 p-8 text-center">
            <p className="font-semibold text-zinc-200">Nothing brewed yet</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-zinc-500">
              Press “Brew” on a recipe — or “New brew session” up there — and this becomes the log:
              what was brewed, how long it took, how it turned out, and the temperatures the rig
              and the fermenter ran at while it happened.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {inProgress.length > 0 && (
              <section>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  In progress
                </h2>
                <ul className="space-y-2.5">
                  {inProgress.map((day) => (
                    <li key={day.id}>
                      <BrewSessionRow brewSession={day} />
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {finished.length > 0 && <FinishedLog brewSessions={finished} />}
          </div>
        )}
      </main>

      {logging && (
        <NewBrewSessionDialog onClose={() => setLogging(false)} onStart={start} />
      )}
    </DashboardShell>
  );
}

/** The packaged batches, in date order with a heading per year. */
function FinishedLog({ brewSessions }: { brewSessions: BrewSession[] }): JSX.Element {
  const years = useMemo(() => {
    const groups = new Map<number | null, BrewSession[]>();
    for (const session of brewSessions) {
      const year = brewYear(session.brewedAt);
      const group = groups.get(year);
      if (group) group.push(session);
      else groups.set(year, [session]);
    }
    return [...groups.entries()];
  }, [brewSessions]);

  return (
    <>
      {years.map(([year, sessions]) => (
        <section key={year ?? 'unknown'}>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            {year ?? 'Undated'}
          </h2>
          <ul className="space-y-2.5">
            {sessions.map((session) => (
              <li key={session.id}>
                <BrewSessionRow brewSession={session} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/**
 * One brew in the log. Reads as a sentence about a batch: what it was, when it
 * was brewed, and the handful of figures worth seeing without opening it —
 * measured where the brewer has measured, the recipe's target where they
 * haven't yet.
 */
function BrewSessionRow({ brewSession }: { brewSession: BrewSession }): JSX.Element {
  // The recipe as it reads now, so a row describes the same beer the library
  // does — renamed, re-costed, ABV corrected. The copy frozen onto the entry is
  // the fallback for a batch whose recipe has since been deleted, and only then.
  const live = brewSession.recipeNow;
  const recipe = live ?? brewSession.recipe;
  // What the beer actually pours, fruit staining and all — the same reading the
  // recipe library's dot shows. `ebc` alone is the *malt* colour, which paints a
  // raspberry Berliner Weisse the straw its grain bill implies. Only a batch
  // whose recipe was deleted has to fall back to that.
  const pour = live?.pourHex ?? ebcColor(recipe.ebc);
  const og = gravityText(brewSession.measured.og || recipe.og);
  const fg = gravityText(brewSession.measured.fg || recipe.fg);
  const abv = abvFromGravities(
    gravityText(brewSession.measured.og),
    gravityText(brewSession.measured.fg),
  );
  const facts: string[] = [];
  if (brewSession.durationMinutes != null) facts.push(formatDuration(brewSession.durationMinutes));
  if (og) facts.push(fg ? `${fmt(og, 3)} → ${fmt(fg, 3)}` : `OG ${fmt(og, 3)}`);
  // The measured ABV when both gravities are in, so the log shows what the beer
  // actually came out at rather than what the recipe hoped for.
  if (abv != null) facts.push(`${abv.toFixed(1)}%`);
  else if (recipe.abv) facts.push(`${fmt(recipe.abv, 1)}% target`);
  if (brewSession.measured.volumeL != null) facts.push(`${brewSession.measured.volumeL} L`);
  else if (recipe.batchSizeL != null) facts.push(`${recipe.batchSizeL} L`);

  return (
    <Link
      to={`/brew-sessions/${brewSession.id}`}
      style={pour ? { borderLeftColor: pour, borderLeftWidth: 3 } : undefined}
      className="block rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 transition hover:border-zinc-700 hover:bg-zinc-800/60"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* The pale ring is what makes a stout legible: near-black on a
            near-black card is otherwise a hole rather than a swatch. */}
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            pour ? 'ring-1 ring-white/20' : 'border border-zinc-600'
          }`}
          style={pour ? { backgroundColor: pour } : undefined}
          title={live?.pourNote ?? (recipe.ebc ? `${recipe.ebc} EBC` : 'Colour unknown')}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate font-medium text-zinc-100">{recipe.name}</span>
        {brewSession.brewNumber > 1 && (
          <span
            className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-400"
            title={`The ${brewSession.brewNumber}${ordinal(brewSession.brewNumber)} time this recipe has been brewed`}
          >
            #{brewSession.brewNumber}
          </span>
        )}
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            STATUS_CHIP[brewSession.status]
          }`}
        >
          {BREW_SESSION_STATUS_LABELS[brewSession.status]}
        </span>
        {brewSession.rating != null && (
          <span className="shrink-0 text-xs text-amber-300" title={`Rated ${brewSession.rating} of 5`}>
            {'★'.repeat(brewSession.rating)}
            <span className="text-zinc-700">{'★'.repeat(5 - brewSession.rating)}</span>
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
        <span title={brewSession.brewedAt}>{brewDate(brewSession.brewedAt)}</span>
        {isInProgress(brewSession) && (
          <span className="text-zinc-400">started {relativeTime(brewSession.brewedAt)}</span>
        )}
        {facts.map((fact) => (
          <span key={fact}>{fact}</span>
        ))}
      </div>
      {brewSession.notes.trim() && (
        <p className="mt-1.5 truncate text-xs text-zinc-600">{brewSession.notes.trim()}</p>
      )}
    </Link>
  );
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
}

/**
 * Pick a recipe and start its brew session. The date defaults to today and is
 * editable in the same breath, so logging a brew from last Saturday is the same
 * two clicks as saying you're brewing now.
 */
function NewBrewSessionDialog({
  onClose,
  onStart,
}: {
  onClose: () => void;
  onStart: (recipeId: string, brewedAt: string | null) => Promise<void>;
}): JSX.Element {
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [recipeId, setRecipeId] = useState('');
  const [date, setDate] = useState(() => dateInputValue(null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = dateInputValue(null);

  useEffect(() => {
    let cancelled = false;
    void loadRecipes()
      .then((list) => {
        if (cancelled) return;
        setRecipes(list);
        setRecipeId((current) => current || (list[0]?.id ?? ''));
      })
      .catch((e) => {
        if (!cancelled) setError(asCleanMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const options = useMemo(
    () =>
      (recipes ?? []).map((recipe) => ({
        value: recipe.id,
        label: recipe.name,
        description: [recipe.style, recipe.abv && `${recipe.abv}%`].filter(Boolean).join(' · '),
        swatchColor: ebcColor(recipe.ebc),
      })),
    [recipes],
  );

  async function submit(): Promise<void> {
    if (!recipeId || saving) return;
    setSaving(true);
    setError(null);
    try {
      // Today needs no timestamp — the server stamps "now", which keeps the
      // clock time a brew session actually started at.
      await onStart(recipeId, date === today ? null : dateInputToIso(date, null));
    } catch (e) {
      setError(asCleanMessage(e));
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New brew session"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-xl">
        <h2 className="text-base font-semibold text-zinc-100">New brew session</h2>
        <p className="mt-1 text-sm text-zinc-500">
          The recipe is copied onto the entry as it reads today, so the log stays right even
          after the recipe is edited.
        </p>

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          Recipe
        </label>
        <Select
          value={recipeId}
          options={options}
          onChange={setRecipeId}
          disabled={recipes == null || options.length === 0}
          placeholder={recipes == null ? 'Loading recipes…' : 'No recipes yet'}
          aria-label="Recipe"
          className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-left text-sm text-zinc-100"
        />

        <label
          htmlFor="brew-session-date"
          className="mt-4 block text-xs font-medium uppercase tracking-wide text-zinc-500"
        >
          Brew date
        </label>
        <input
          id="brew-session-date"
          type="date"
          value={date}
          max={today}
          onChange={(e) => setDate(e.target.value)}
          className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 [color-scheme:dark]"
        />

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!recipeId || saving}
            className="rounded-lg bg-gradient-to-br from-[#f87a68] to-[#e0463f] px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
          >
            {saving ? 'Starting…' : 'Start brew session'}
          </button>
        </div>
      </div>
    </div>
  );
}
