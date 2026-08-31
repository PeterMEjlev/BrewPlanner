import type {
  BrewSessionDetail,
  BrewSessionRigSample,
  BrewSessionStageMarker,
  BrewSessionStatus,
  BrewSessionTempStats,
  RecipeDetail,
  UpdateBrewSessionInput,
} from '@checklist/shared';
import {
  BREW_SESSION_STATUSES,
  BREW_SESSION_STATUS_LABELS,
  abvFromGravities,
  apparentAttenuation,
  measuredEfficiency,
} from '@checklist/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api';
import { canControl, useAuth } from '../auth';
import {
  STATUS_CHIP,
  brewDate,
  dateInputToIso,
  dateInputValue,
  formatDuration,
  gravityText,
  targetDelta,
} from '../brewSessions';
import { useRigTheme } from '../components/brewsystem/rigTheme';
import type { BrewTheme } from '../components/brewsystem/theme';
import { VESSELS, vesselColor } from '../components/brewsystem/vessels';
import { ChartOverlay } from '../components/ChartOverlay';
import { DashboardShell } from '../components/DashboardShell';
import { Select } from '../components/Select';
import { SheetSection } from '../components/SheetSection';
import { timeAxis, type TimeAxis } from '../components/timeAxis';
import { kr } from '../money';
import { figuresFromRecipe, figuresFromSnapshot, fmt } from '../recipeFigures';
import { loadRecipeDetail } from '../recipeStore';
import { asCleanMessage, clockTime, dateTime } from '../util';

/**
 * One brew session in full: what was brewed, what it measured, how long each stage
 * took, and the temperatures the rig and the fermenter ran at while it happened.
 *
 * The page is a form that saves itself. A brew log is filled in over days — the
 * OG at 14:00, the FG a fortnight later, the tasting note a month after that —
 * so every field commits on blur rather than behind a Save button that would be
 * left unpressed half the time.
 */

/**
 * Colour for the vertical stage marks. Deliberately not one of the rig's
 * themeable colours: the three vessel traces own the palette here, and a stage
 * line is an annotation on them rather than a fourth thing being measured.
 */
const STAGE_MARK = '#a1a1aa';

/** Font size of a stage mark's label, and the rough per-character width at it. */
const STAGE_LABEL_FONT = 11;
const STAGE_LABEL_CHAR = STAGE_LABEL_FONT * 0.55;

/** The page's cards, in the order they appear. */
type SectionKey = 'stage' | 'brewSession' | 'rig' | 'fermentation' | 'notes';

const COLLAPSE_KEY = 'brewplanner.brewSessionSections';

/** Everything open: a log entry is meant to be read top to bottom. */
const ALL_OPEN: Record<SectionKey, boolean> = {
  stage: false,
  brewSession: false,
  rig: false,
  fermentation: false,
  notes: false,
};

function loadCollapsed(): Record<SectionKey, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (!raw) return ALL_OPEN;
    return { ...ALL_OPEN, ...(JSON.parse(raw) as Partial<Record<SectionKey, boolean>>) };
  } catch {
    return ALL_OPEN;
  }
}

/**
 * One card, in the same shape a brew sheet's sections have — so a brew session reads
 * as a document of the same family rather than a different kind of page. The
 * fold state is per browser, like the recipe page's.
 */
function Section({
  section,
  title,
  icon,
  meta,
  collapsed,
  onToggle,
  children,
}: {
  section: SectionKey;
  title: string;
  icon: string;
  meta?: string;
  collapsed: Record<SectionKey, boolean>;
  onToggle: (section: SectionKey) => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <SheetSection
      title={title}
      icon={icon}
      meta={meta}
      open={!collapsed[section]}
      onToggle={() => onToggle(section)}
    >
      <div className="px-4 py-3.5">{children}</div>
    </SheetSection>
  );
}

export function BrewSessionDetailPage(): JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { auth } = useAuth();
  const controllable = canControl(auth);

  const [brewSession, setBrewSession] = useState<BrewSessionDetail | null>(null);
  const [sheet, setSheet] = useState<RecipeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>(loadCollapsed);

  function toggle(section: SectionKey): void {
    setCollapsed((prev) => {
      const next = { ...prev, [section]: !prev[section] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        // Per-browser convenience only.
      }
      return next;
    });
  }

  const load = useCallback(async (): Promise<void> => {
    try {
      setBrewSession(await api.getBrewSession(Number(id)));
      setError(null);
    } catch (e) {
      setError(asCleanMessage(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The brew sheet this batch was brewed to, read live rather than from the copy
   * frozen onto the entry.
   *
   * `recipeId` points at the exact version that was brewed, not at the beer's
   * newest one, so a revision made since sits in a version this log never
   * mentions. What that leaves is the case worth following: a correction to the
   * version that *was* brewed — a mistyped pre-boil target, a re-costed grain
   * bill — should read the same here as it does on the sheet, which is the whole
   * reason the recipe column exists. Anything bigger than a correction becomes a
   * new version, and this batch stays where it is.
   *
   * Cached by recipeStore, so arriving here from the brew sheet costs nothing.
   */
  const recipeId = brewSession?.recipeId ?? null;
  useEffect(() => {
    if (recipeId == null) {
      setSheet(null);
      return;
    }
    let current = true;
    void loadRecipeDetail(recipeId)
      .then((detail) => {
        if (current) setSheet(detail);
      })
      .catch(() => {
        // The frozen snapshot covers this. A brew log that renders every figure
        // it has is not worth an error banner over the sheet behind it.
      });
    return () => {
      current = false;
    };
  }, [recipeId]);

  /**
   * Save one edit. The response carries the row's own fields, which are merged
   * straight in; a change that moves the window the *derived* figures are read
   * over (the dates, and the status that ends the rig log) is followed by a
   * re-read, since the server works those out on the fly.
   */
  async function save(fields: UpdateBrewSessionInput): Promise<void> {
    if (!brewSession || saving) return;
    setSaving(true);
    try {
      const updated = await api.updateBrewSession(brewSession.id, fields);
      setBrewSession((prev) => (prev ? { ...prev, ...updated } : prev));
      setError(null);
      const movesWindow =
        fields.status !== undefined ||
        fields.brewedAt !== undefined ||
        fields.pitchedAt !== undefined ||
        fields.packagedAt !== undefined;
      if (movesWindow) await load();
    } catch (e) {
      setError(asCleanMessage(e));
      // The field on screen no longer matches the server; put the truth back.
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    if (!brewSession || deleting) return;
    const name = sheet?.name ?? brewSession.recipe.name;
    if (
      !window.confirm(
        `Delete the brew session for “${name}” on ${brewDate(brewSession.brewedAt)}? This cannot be undone.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      await api.deleteBrewSession(brewSession.id);
      navigate('/brew-sessions');
    } catch (e) {
      setError(asCleanMessage(e));
      setDeleting(false);
    }
  }

  if (!brewSession) {
    return (
      <DashboardShell active="brewSessions">
        <main className="w-full max-w-[1100px] px-5 py-5">
          {error ? (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          ) : (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-400">
              Loading brew session…
            </div>
          )}
          <Link to="/brew-sessions" className="mt-4 inline-block text-sm text-zinc-400 hover:text-zinc-200">
            ← Back to brew sessions
          </Link>
        </main>
      </DashboardShell>
    );
  }

  const { measured } = brewSession;
  // Every recipe figure on the page comes from one place, so the brew sheet and
  // the log beside it cannot print different numbers for the same beer. The
  // frozen snapshot is the fallback and nothing more: it is all that survives a
  // recipe that has since been deleted.
  const plan = sheet ? figuresFromRecipe(sheet) : figuresFromSnapshot(brewSession.recipe);
  // Every gravity is read through the same normalizer the fields display
  // through, so a reading typed without its decimal point is the one the brewer
  // meant everywhere it is used — the ABV, the attenuation and both
  // efficiencies, not only the delta beside the box it was typed into.
  const og = gravityText(measured.og);
  const fg = gravityText(measured.fg);
  const preBoil = gravityText(measured.preBoilGravity);
  const abv = abvFromGravities(og, fg);
  const attenuation = apparentAttenuation(og, fg);
  const targetAttenuation = apparentAttenuation(plan.og, plan.fg);
  const pour = plan.pourHex;

  // What the brewhouse managed, worked back from the gravities the brewer took
  // against the recipe's grain bill. Two figures, because they answer different
  // questions: brewhouse efficiency is everything the day lost between mash and
  // fermenter, mash efficiency only the conversion — so a disappointing OG with
  // a healthy mash figure was the kettle's doing.
  const brewhouse = measuredEfficiency({
    gravity: og,
    litres: measured.volumeL,
    mashedPointGallons: plan.mashedPointGallons,
    unmashedPointGallons: plan.unmashedPointGallons,
  });
  const mash = measuredEfficiency({
    gravity: preBoil,
    litres: measured.preBoilVolumeL,
    mashedPointGallons: plan.mashedPointGallons,
    // Only the sugars already in the kettle at that reading — a late addition
    // isn't in the wort yet, and crediting the mash with either would flatter it.
    unmashedPointGallons: plan.preBoilUnmashedPointGallons,
  });
  const pct = (value: number): string => `${value.toFixed(0)}%`;

  return (
    <DashboardShell active="brewSessions">
      <main className="w-full max-w-[1100px] px-5 py-5">
        <Link to="/brew-sessions" className="text-sm text-zinc-400 transition hover:text-zinc-200">
          ← Brew sessions
        </Link>

        <header className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {pour && (
                <span
                  className="h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-black/40"
                  style={{ backgroundColor: pour }}
                  aria-hidden
                />
              )}
              <h1 className="truncate text-xl font-semibold text-zinc-100">{plan.name}</h1>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  STATUS_CHIP[brewSession.status]
                }`}
              >
                {BREW_SESSION_STATUS_LABELS[brewSession.status]}
              </span>
            </div>
            <p className="mt-1 text-sm text-zinc-500">
              {[
                plan.style,
                brewSession.brewNumber > 1 ? `brew #${brewSession.brewNumber} of this recipe` : null,
                `brewed ${brewDate(brewSession.brewedAt)}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {brewSession.recipeId && (
              <Link
                to={`/recipes/${encodeURIComponent(brewSession.recipeId)}`}
                className="rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100"
              >
                Brew sheet
              </Link>
            )}
            {controllable && (
              <button
                type="button"
                onClick={remove}
                disabled={deleting}
                className="rounded-lg border border-red-500/30 px-3 py-2 text-sm font-medium text-red-300 transition hover:bg-red-500/10 disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            )}
          </div>
        </header>

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="mt-5 space-y-4">
          <StageCard
            brewSession={brewSession}
            editable={controllable}
            onSave={save}
            collapsed={collapsed}
            onToggle={toggle}
          />

          <Section
            section="brewSession"
            title="Recipe and brew session"
            icon="🔥"
            meta={[
              plan.style,
              brewSession.durationMinutes != null
                ? formatDuration(brewSession.durationMinutes)
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            collapsed={collapsed}
            onToggle={toggle}
          >
            {/* Plan against result, one figure per line, in the order the brew
                day actually happens. The two used to be separate cards — the
                recipe's numbers in one, the day's in another — which made the
                only question worth asking ("how far off was I?") a matter of
                scrolling between them and doing the subtraction yourself. */}
            <Comparison>
              <GroupHeader title="Mash and run-off" />
              <NumberRow
                label="Mash temperature"
                unit="°C"
                plan={plan.mashTemp}
                value={measured.mashTempC}
                editable={controllable}
                onSave={(mashTempC) => save({ measured: { mashTempC } })}
              />
              <GravityRow
                label="Pre-boil gravity"
                plan={gravity(plan.preBoilGravity)}
                value={measured.preBoilGravity}
                editable={controllable}
                onSave={(preBoilGravity) => save({ measured: { preBoilGravity } })}
              />
              <NumberRow
                label="Pre-boil volume"
                unit="L"
                plan={litres(plan.preBoilVolumeL)}
                value={measured.preBoilVolumeL}
                hint={
                  measured.preBoilGravity && measured.preBoilVolumeL == null
                    ? 'Add this and the mash efficiency follows'
                    : null
                }
                editable={controllable}
                onSave={(preBoilVolumeL) => save({ measured: { preBoilVolumeL } })}
              />

              <GroupHeader title="Boil" />
              <NumberRow
                label="Boil"
                unit="min"
                plan={plan.boilTimeMin != null ? `${plan.boilTimeMin} min` : null}
                value={measured.boilTimeMin}
                editable={controllable}
                onSave={(boilTimeMin) => save({ measured: { boilTimeMin } })}
              />
              <GravityRow
                label="Post-boil gravity"
                plan={gravity(plan.postBoilGravity)}
                value={measured.postBoilGravity}
                editable={controllable}
                onSave={(postBoilGravity) => save({ measured: { postBoilGravity } })}
              />
              <NumberRow
                label="Post-boil volume"
                unit="L"
                plan={litres(plan.postBoilVolumeL)}
                value={measured.postBoilVolumeL}
                editable={controllable}
                onSave={(postBoilVolumeL) => save({ measured: { postBoilVolumeL } })}
              />

              <GroupHeader title="Into the fermenter" />
              <GravityRow
                label="Original gravity"
                plan={gravity(plan.og)}
                value={measured.og}
                editable={controllable}
                onSave={(og) => save({ measured: { og } })}
              />
              <NumberRow
                label="Volume"
                unit="L"
                plan={litres(plan.batchSizeL)}
                value={measured.volumeL}
                editable={controllable}
                onSave={(volumeL) => save({ measured: { volumeL } })}
              />
              {/* Calculated from the OG and volume, and only typed into when
                  the brewer knows the arithmetic is wrong — an eyeballed volume
                  moves this figure several points, and they were there. */}
              <NumberRow
                label="Efficiency"
                unit="%"
                plan={plan.efficiencyPct != null ? `${plan.efficiencyPct}%` : null}
                value={measured.efficiencyPct}
                placeholder={brewhouse != null ? pct(brewhouse) : '—'}
                readOnlyValue={brewhouse != null ? pct(brewhouse) : null}
                hint={
                  brewhouse == null
                    ? 'Measure the OG and the volume into the fermenter to calculate it'
                    : measured.efficiencyPct == null
                      ? `Calculated ${pct(brewhouse)} from the OG and volume`
                      : `Overriding the calculated ${pct(brewhouse)} — clear to use it`
                }
                editable={controllable}
                onSave={(efficiencyPct) => save({ measured: { efficiencyPct } })}
              />

              <GroupHeader title="Out of the fermenter" />
              <GravityRow
                label="Final gravity"
                plan={gravity(plan.fg)}
                value={measured.fg}
                editable={controllable}
                onSave={(fg) => save({ measured: { fg } })}
              />
              {/* Neither of these is stored: both are one arithmetic step from
                  the gravities above, so recomputing them is cheaper and more
                  honest than keeping a copy a corrected reading would strand. */}
              <DerivedRow
                label="ABV"
                unit="%"
                plan={plan.abv ? `${fmt(plan.abv, 1)}%` : null}
                actual={abv != null ? `${abv.toFixed(1)}%` : null}
                hint={
                  plan.fruitAbv > 0
                    ? `Recipe: malt ${Math.max(0, Number(plan.abv) - plan.fruitAbv).toFixed(2)}% + fruit additions ${plan.fruitAbv.toFixed(2)}%`
                    : null
                }
                hintTitle={
                  plan.fruitAbv > 0
                    ? 'Fruit contribution assumes a typical unsweetened Brix for the named juice or puree and that its sugar ferments dry.'
                    : undefined
                }
              />
              <DerivedRow
                label="Apparent attenuation"
                unit="%"
                plan={targetAttenuation != null ? `${targetAttenuation.toFixed(0)}%` : null}
                actual={attenuation != null ? `${attenuation.toFixed(0)}%` : null}
              />
            </Comparison>

            <DerivedFigures brewhouse={brewhouse} mash={mash} />

            {/* No recipe column: nothing here is something a brew sheet asks
                for, only something the day spent. */}
            <Block title="What the day cost">
              <div className="grid gap-3 sm:grid-cols-3">
                <DurationField
                  minutes={brewSession.durationMinutes}
                  editable={controllable}
                  onSave={(minutes) => save({ durationMinutes: minutes })}
                />
                <NumberField
                  label="Water used"
                  unit="L"
                  value={measured.waterL}
                  editable={controllable}
                  onSave={(waterL) => save({ measured: { waterL } })}
                />
                <NumberField
                  label="Electricity"
                  unit="kWh"
                  value={measured.energyKwh}
                  editable={controllable}
                  onSave={(energyKwh) => save({ measured: { energyKwh } })}
                />
              </div>
            </Block>

            {/* The other half of the sheet — the figures a brew day never
                measures back, so they stand alone rather than as half a row. */}
            <Block title="The recipe’s own figures">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Fact label="Bitterness" value={plan.ibu ? `${fmt(plan.ibu, 1)} IBU` : '—'} />
                <Fact
                  label={plan.ebcEstimated ? 'Colour (est.)' : 'Colour'}
                  value={plan.ebc ? `${fmt(plan.ebc, 1)} EBC` : '—'}
                  swatch={pour}
                  // The figure is the malt's EBC; the swatch beside it is the
                  // pour, fruit included, so it says so on hover rather than
                  // reading as a swatch that disagrees with its own number.
                  swatchTitle={plan.pourNote}
                />
                <Fact
                  label="Grain bill"
                  value={plan.grainKg != null ? `${plan.grainKg.toFixed(2)} kg` : '—'}
                />
                <Fact
                  label="Hops"
                  value={plan.hopGrams != null ? `${plan.hopGrams.toFixed(0)} g` : '—'}
                />
                <Fact label="Yeast" value={plan.yeast || '—'} />
                <Fact label="Fermentation" value={plan.fermentationTemp ?? '—'} />
                <Fact
                  label="Ingredient cost"
                  value={plan.costDkk != null ? kr(plan.costDkk, 0) : '—'}
                />
              </div>
            </Block>

            <p className="mt-4 text-xs text-zinc-600">
              {/* Keyed off the row, not off `plan`, which still reads from the
                  snapshot for the moment before the sheet arrives — long enough
                  to accuse a perfectly live recipe of having been deleted. */}
              {brewSession.recipeId == null
                ? 'The recipe this batch came from has since been deleted, so the recipe column is the copy taken when the brew session started — all that is left of the sheet.'
                : `The recipe column is read live from the brew sheet this batch was brewed to${
                    sheet && sheet.versions.length > 1 ? ` (v${sheet.version})` : ''
                  }, so the log and the sheet can never disagree. A change big enough to matter belongs in a new version, which this batch would not be brewed to.`}
            </p>
          </Section>

          <RigTemperatures
            title={`${plan.name} · Brewing rig`}
            samples={brewSession.rigSamples}
            stats={brewSession.rigStats}
            stageMarkers={brewSession.stageMarkers}
            collapsed={collapsed}
            onToggle={toggle}
          />

          <FermentationCard brewSession={brewSession} collapsed={collapsed} onToggle={toggle} />

          <Section
            section="notes"
            title="Notes"
            icon="📝"
            meta={brewSession.rating != null ? '★'.repeat(brewSession.rating) : undefined}
            collapsed={collapsed}
            onToggle={toggle}
          >
            <NotesField
              label="Brew session"
              placeholder="How it went: what ran long, what you'd do differently…"
              value={brewSession.notes}
              editable={controllable}
              onSave={(notes) => save({ notes })}
            />
            <div className="mt-4">
              <NotesField
                label="Tasting"
                placeholder="How it turned out once it was in the glass…"
                value={brewSession.tastingNotes}
                editable={controllable}
                onSave={(tastingNotes) => save({ tastingNotes })}
              />
            </div>
            <div className="mt-4">
              <RatingField
                rating={brewSession.rating}
                editable={controllable}
                onSave={(rating) => save({ rating })}
              />
            </div>
          </Section>
        </div>

        <p className="mt-4 text-xs text-zinc-600">
          Logged {dateTime(brewSession.createdAt)} · last edited {dateTime(brewSession.updatedAt)}
        </p>
      </main>
    </DashboardShell>
  );
}

/**
 * The one measured figure with no recipe number to sit beside — mash efficiency
 * is about the conversion, which a brew sheet states nothing about — and the
 * warning for when the arithmetic has come out impossible.
 *
 * Everything else the measurements add up to (ABV, attenuation, brewhouse
 * efficiency) now has a row of its own in the comparison above, where it can be
 * read against what the recipe asked for.
 *
 * Silent until there is something to say: a half-filled brew session shows the
 * figures it has earned and no placeholders for the rest.
 */
function DerivedFigures({
  brewhouse,
  mash,
}: {
  brewhouse: number | null;
  mash: number | null;
}): JSX.Element | null {
  // An efficiency over 100 is arithmetic, not brewing: something measured is
  // wrong, and saying so beats quietly showing an impossible number.
  const impossible = (brewhouse != null && brewhouse > 100) || (mash != null && mash > 100);
  if (mash == null && !impossible) return null;
  return (
    <p className="mt-3 text-xs text-zinc-500">
      {mash != null && (
        <>
          Mash efficiency <span className="text-zinc-300">{mash.toFixed(0)}%</span> — the conversion
          alone, before whatever the kettle and the trub took after it.
        </>
      )}
      {impossible && (
        <span className="text-amber-300/90"> Over 100% means a volume or a gravity is off.</span>
      )}
    </p>
  );
}

/**
 * Where the batch is, and the dates that say when it got there. Advancing the
 * stage stamps the date that belongs to it — pitching when it starts fermenting,
 * packaging when it's packaged — because those are the same event, and asking
 * for them separately only creates a second thing to forget.
 */
function StageCard({
  brewSession,
  editable,
  onSave,
  collapsed,
  onToggle,
}: {
  brewSession: BrewSessionDetail;
  editable: boolean;
  onSave: (fields: UpdateBrewSessionInput) => Promise<void>;
  collapsed: Record<SectionKey, boolean>;
  onToggle: (section: SectionKey) => void;
}): JSX.Element {
  const next = nextStage(brewSession.status);

  async function advance(): Promise<void> {
    if (!next) return;
    const now = new Date().toISOString();
    const fields: UpdateBrewSessionInput = { status: next };
    // Only stamp a date that isn't already recorded — advancing a batch someone
    // back-filled the dates for shouldn't overwrite them with today.
    if (next === 'fermenting' && brewSession.pitchedAt == null) fields.pitchedAt = now;
    if (next === 'packaged' && brewSession.packagedAt == null) fields.packagedAt = now;
    await onSave(fields);
  }

  return (
    <Section
      section="stage"
      title="Stage"
      icon="🗓️"
      meta={BREW_SESSION_STATUS_LABELS[brewSession.status]}
      collapsed={collapsed}
      onToggle={onToggle}
    >
      <div className="flex flex-wrap items-end gap-3">
        <DateField
          label="Brewed"
          iso={brewSession.brewedAt}
          editable={editable}
          // Every entry has a brew date — emptying the field (which a date input
          // allows from the keyboard) is a no-op rather than a way to lose it.
          onSave={(brewedAt) => (brewedAt ? onSave({ brewedAt }) : Promise.resolve())}
        />
        <DateField
          label="Pitched"
          iso={brewSession.pitchedAt}
          clearable
          editable={editable}
          onSave={(pitchedAt) => onSave({ pitchedAt })}
        />
        <DateField
          label="Packaged"
          iso={brewSession.packagedAt}
          clearable
          editable={editable}
          onSave={(packagedAt) => onSave({ packagedAt })}
        />
        {editable && (
          <div className="ml-auto flex items-end gap-2">
            <div>
              <span className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
                Stage
              </span>
              <Select
                value={brewSession.status}
                options={BREW_SESSION_STATUSES.map((status) => ({
                  value: status,
                  label: BREW_SESSION_STATUS_LABELS[status],
                }))}
                onChange={(status) => void onSave({ status: status as BrewSessionStatus })}
                aria-label="Stage"
                className="mt-1.5 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-left text-sm text-zinc-100"
              />
            </div>
            {next && (
              <button
                type="button"
                onClick={() => void advance()}
                className="rounded-lg bg-gradient-to-br from-[#f87a68] to-[#e0463f] px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110"
              >
                {ADVANCE_LABELS[next]}
              </button>
            )}
          </div>
        )}
      </div>
      {brewSession.status === 'brewing' && (
        <p className="mt-3 text-xs text-zinc-500">
          While a batch is in its brew session, the hub logs the rig's pot temperatures every
          half-minute. Moving it on to fermenting stops that and starts the fermentation clock.
        </p>
      )}
    </Section>
  );
}

const ADVANCE_LABELS: Record<BrewSessionStatus, string> = {
  brewing: 'Back to brew session',
  fermenting: 'Into the fermenter',
  conditioning: 'Conditioning',
  packaged: 'Packaged',
};

function nextStage(status: BrewSessionStatus): BrewSessionStatus | null {
  const index = BREW_SESSION_STATUSES.indexOf(status);
  return index >= 0 ? BREW_SESSION_STATUSES[index + 1] ?? null : null;
}

/**
 * The rig's pot temperatures over the brew session. Silent — rather than an empty
 * chart — for a batch that was logged after the fact or brewed with the rig off:
 * there is nothing to say about it, and an axis with no line reads as a fault.
 */
function RigTemperatures({
  title,
  samples,
  stats,
  stageMarkers,
  collapsed,
  onToggle,
}: {
  /** What the enlarged view calls itself — the batch, not just "the rig". */
  title: string;
  samples: BrewSessionRigSample[];
  stats: BrewSessionDetail['rigStats'];
  stageMarkers: BrewSessionStageMarker[];
  collapsed: Record<SectionKey, boolean>;
  onToggle: (section: SectionKey) => void;
}): JSX.Element | null {
  const [enlarged, setEnlarged] = useState(false);
  // The vessels' own names and the rig's own colours, from the same source the
  // Overview card and the Brew System panel read — so MLT is the green it is
  // everywhere else, and stays that colour if the rig is re-themed.
  const theme = useRigTheme();
  const data = useMemo(
    () =>
      samples.map((sample) => ({
        t: Date.parse(sample.at),
        bk: sample.bk,
        mlt: sample.mlt,
        hlt: sample.hlt,
      })),
    [samples],
  );

  const span = useMemo(() => {
    if (data.length === 0) return null;
    return { min: data[0]!.t, max: data[data.length - 1]!.t };
  }, [data]);
  const axis = useMemo(() => timeAxis(span), [span]);

  // Only the marks that fall inside the logged curve can be drawn against it.
  // A stage entered before the rig started logging (or after the batch moved on
  // to fermenting) has no x to sit at, and recharts would pin it to an axis edge
  // where it would read as a stage that began at the very start of the brew.
  const marks = useMemo(
    () =>
      span == null
        ? []
        : stageMarkers.flatMap((marker) => {
            const t = Date.parse(marker.at);
            return t >= span.min && t <= span.max ? [{ ...marker, t }] : [];
          }),
    [stageMarkers, span],
  );

  if (samples.length === 0) return null;

  const logged = span ? Math.round((span.max - span.min) / 60_000) : 0;

  return (
    <Section
      section="rig"
      title="Brewing rig"
      icon="🌡️"
      meta={`${samples.length} samples · ${formatDuration(logged)}`}
      collapsed={collapsed}
      onToggle={onToggle}
    >
      {/* Click the curve to open it large, the way the Overview's cards do. A
          five-hour brew day in a 16rem-tall card is a summary; the stage marks
          and the minute-by-minute shape of a ramp are only readable full size. */}
      <button
        type="button"
        onClick={() => setEnlarged(true)}
        aria-label="Enlarge the brewing rig chart"
        className="group relative block w-full rounded-lg text-left transition hover:bg-zinc-800/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
      >
        {/* Hint rather than a control: the whole chart is the target, and the
            chart is what the pointer is already on. Click-through so it can sit
            over the plot without eating a hover the tooltip wanted. */}
        <span className="pointer-events-none absolute right-2 top-1 z-10 rounded-md bg-zinc-900/80 px-1.5 py-0.5 text-[11px] text-zinc-400 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
          Enlarge ⤢
        </span>
        <div className="h-64 w-full">
          <RigChart data={data} axis={axis} marks={marks} theme={theme} />
        </div>
      </button>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {VESSELS.map((vessel) => (
          <PotStats
            key={vessel.key}
            label={vessel.label}
            name={vessel.name}
            color={vesselColor(theme, vessel)}
            stats={stats[vessel.key]}
          />
        ))}
      </div>
      <p className="mt-3 text-xs text-zinc-600">
        Logged from the rig while this was in its brew session. Kept with the entry rather than with
        the fleet's telemetry, so the curve is still here years later.
        {marks.length > 0 &&
          ' The dashed marks are the brew stages the rig stepped through, at the times it stepped.'}
      </p>
      {enlarged && (
        <ChartOverlay title={title} wide onClose={() => setEnlarged(false)}>
          {/* Taller than the card's preview and as wide as the overlay allows:
              hours across the x axis is what this chart is short of. */}
          <div className="h-[60vh] min-h-[320px] w-full">
            <RigChart data={data} axis={axis} marks={marks} theme={theme} />
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {VESSELS.map((vessel) => (
              <PotStats
                key={vessel.key}
                label={vessel.label}
                name={vessel.name}
                color={vesselColor(theme, vessel)}
                stats={stats[vessel.key]}
              />
            ))}
          </div>
        </ChartOverlay>
      )}
    </Section>
  );
}

/** One plotted sample: the three pot temperatures at a moment of the brew day. */
interface RigPoint {
  t: number;
  bk: number | null;
  mlt: number | null;
  hlt: number | null;
}

/**
 * The three vessel traces and the stage marks, drawn to fill whatever box it is
 * given. The card's preview and the enlarged overlay render this same component
 * at two heights, so opening the chart makes it bigger and changes nothing else
 * about it.
 */
function RigChart({
  data,
  axis,
  marks,
  theme,
}: {
  data: RigPoint[];
  axis: TimeAxis;
  marks: (BrewSessionStageMarker & { t: number })[];
  theme: BrewTheme;
}): JSX.Element {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
        <XAxis
          dataKey="t"
          type="number"
          domain={['dataMin', 'dataMax']}
          ticks={axis.ticks}
          tickFormatter={axis.format}
          stroke="#71717a"
          fontSize={11}
        />
        <YAxis
          width={48}
          stroke="#71717a"
          fontSize={11}
          tickFormatter={(v: number) => `${Math.round(v)}°`}
        />
        <Tooltip
          contentStyle={{
            background: '#18181b',
            border: '1px solid #3f3f46',
            borderRadius: 8,
            fontSize: 12,
          }}
          labelFormatter={(t) => dateTime(t as number)}
          formatter={(value, name) => {
            const n = typeof value === 'number' ? value : Number(value);
            return [Number.isFinite(n) ? `${n.toFixed(1)} °C` : '—', name];
          }}
        />
        {VESSELS.map((vessel) => (
          <Line
            key={vessel.key}
            type="monotone"
            dataKey={vessel.key}
            name={vessel.label}
            stroke={vesselColor(theme, vessel)}
            strokeWidth={2}
            dot={false}
            // A sensor that dropped out leaves a gap rather than a straight
            // line across the minutes it wasn't reading.
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
        {/* After the traces, so a stage mark reads over the curve it
            annotates rather than under it. */}
        {marks.map((mark) => (
          <ReferenceLine
            key={`${mark.index}:${mark.at}`}
            x={mark.t}
            stroke={STAGE_MARK}
            strokeWidth={1}
            strokeDasharray="4 4"
            label={<StageMarkLabel mark={mark} />}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/**
 * A stage mark's name and the time it was entered, written up the line.
 *
 * Rotated rather than laid across the top because stages cluster — mash out and
 * sparge can be minutes apart on a five-hour chart — and horizontal labels would
 * overlap exactly where the brew day is busiest. Vertical ones can't collide
 * however close two marks fall.
 *
 * Handed to ReferenceLine as an element, not a render function: recharts treats
 * a function label as a component type, and a fresh closure each render would
 * remount the label every time.
 */
function StageMarkLabel({
  viewBox,
  mark,
}: {
  /** The reference line's box, supplied by recharts: zero-width, plot-tall. */
  viewBox?: { x: number; y: number; height: number };
  mark: BrewSessionStageMarker & { t: number };
}): JSX.Element | null {
  if (!viewBox) return null;
  const { x, y, height } = viewBox;
  // Anchored at the top of the plot and ending there: rotating -90° about the
  // anchor turns "extends left" into "extends down", so the text hangs below the
  // top edge and reads upward, whatever its length.
  const px = x + 11;
  const py = y + 4;
  // A rotated label's length is spent on the plot's *height*, and the rig's
  // stage names are the brewer's own words. Clip one that would otherwise run
  // out through the time axis.
  const label = fitStageLabel(`${mark.name} · ${clockTime(mark.at)}`, height - 8);
  return (
    <text
      x={px}
      y={py}
      transform={`rotate(-90 ${px} ${py})`}
      textAnchor="end"
      fontSize={STAGE_LABEL_FONT}
      fill={STAGE_MARK}
    >
      {label}
    </text>
  );
}

/** Trim a stage label to what the plot is tall enough to seat, ellipsis and all. */
function fitStageLabel(label: string, available: number): string {
  const max = Math.floor(available / STAGE_LABEL_CHAR);
  if (max < 2) return '';
  return label.length <= max ? label : `${label.slice(0, max - 1).trimEnd()}…`;
}

function PotStats({
  label,
  name,
  color,
  stats,
}: {
  label: string;
  /** Spelled out under the short name, since the card has room for it. */
  name: string;
  color: string;
  stats: BrewSessionTempStats | null;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} aria-hidden />
        <span className="text-xs font-medium text-zinc-300">{label}</span>
        <span className="truncate text-xs text-zinc-500">{name}</span>
      </div>
      <p className="mt-1 text-sm text-zinc-200">
        {stats
          ? `${stats.min.toFixed(1)}–${stats.max.toFixed(1)} °C · avg ${stats.avg.toFixed(1)}`
          : 'No readings'}
      </p>
    </div>
  );
}

/**
 * The fermentation half, read out of the fermenter's own telemetry. Says so
 * plainly when there's nothing to read: the readings behind an old batch are
 * pruned on the retention schedule, which is a fact about the log, not a fault.
 */
function FermentationCard({
  brewSession,
  collapsed,
  onToggle,
}: {
  brewSession: BrewSessionDetail;
  collapsed: Record<SectionKey, boolean>;
  onToggle: (section: SectionKey) => void;
}): JSX.Element {
  const { fermentation } = brewSession;
  const dayLabel =
    fermentation.days == null
      ? '—'
      : `${fermentation.days} day${fermentation.days === 1 ? '' : 's'}${
          brewSession.packagedAt ? '' : ' so far'
        }`;
  return (
    <Section
      section="fermentation"
      title="Fermentation"
      icon="🧫"
      meta={dayLabel}
      collapsed={collapsed}
      onToggle={onToggle}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact
          label="Temperature"
          value={
            fermentation.temp
              ? `${fermentation.temp.min.toFixed(1)}–${fermentation.temp.max.toFixed(1)} °C`
              : '—'
          }
        />
        <Fact
          label="Average"
          value={fermentation.temp ? `${fermentation.temp.avg.toFixed(1)} °C` : '—'}
        />
        <Fact
          label="Gravity"
          value={
            fermentation.gravity
              ? `${fermentation.gravity.start.toFixed(3)} → ${fermentation.gravity.end.toFixed(3)}`
              : '—'
          }
        />
        <Fact label="In the tank" value={dayLabel} />
      </div>
      <p className="mt-3 text-xs text-zinc-600">
        {fermentation.temp
          ? `From ${fermentation.deviceName ?? 'the fermenter'}, over ${
              brewSession.pitchedAt ? 'pitching' : 'the brew session'
            } to ${brewSession.packagedAt ? 'packaging' : 'now'}.`
          : 'No fermenter readings for this window — either nothing was logging, or the samples have since aged out of the telemetry retention.'}
      </p>
    </Section>
  );
}

/**
 * The comparison grid: four columns — the figure, what the recipe asks for, what
 * the day measured, and how far apart the two landed.
 *
 * A grid rather than a stack of self-contained cards because the point of the
 * card is reading *down* a column. A brew session's story is which numbers
 * drifted and by how much, and that is only legible when every recipe figure
 * lines up under the one above it.
 *
 * Rows are fragments of four cells rather than wrappers of their own, so the
 * grid can align across every group in the card. The columns stay narrow enough
 * for a phone; the label is the only one that can give, and it wraps.
 */
function Comparison({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_3.25rem_5.25rem_3rem] gap-x-2 sm:grid-cols-[minmax(0,1fr)_6rem_7.5rem_4.5rem] sm:gap-x-3">
      {children}
    </div>
  );
}

/** A stage of the brew day, carrying the column headings for the rows under it. */
function GroupHeader({ title }: { title: string }): JSX.Element {
  const head = 'pb-1.5 pt-4 text-[10px] font-medium uppercase tracking-wide text-zinc-600';
  return (
    <>
      <h3 className="pb-1.5 pt-4 text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
        {title}
      </h3>
      <span className={`${head} text-right`}>Recipe</span>
      <span className={head}>Actual</span>
      <span className={`${head} text-right`}>&Delta;</span>
    </>
  );
}

/** A titled block under the comparison grid, for figures that aren't a comparison. */
function Block({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="mt-5">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
        {title}
      </h3>
      {children}
    </div>
  );
}

/**
 * One figure across both columns. The delta only appears when there is one:
 * a row with nothing in that column already says the day hit the number, and
 * "±0" would be ink for nothing.
 */
function Row({
  label,
  plan,
  delta,
  hint,
  hintTitle,
  children,
}: {
  label: string;
  /** What the recipe asks for, formatted; null when it asks for nothing. */
  plan: string | null;
  /** How far the measurement landed from that; null when it hit it. */
  delta?: string | null;
  /** A note under the label — a breakdown, or what the app worked the figure out to be. */
  hint?: string | null;
  /** Tooltip for that note, when the figure behind it needs a caveat. */
  hintTitle?: string;
  children: React.ReactNode;
}): JSX.Element {
  const cell = 'border-t border-zinc-800/70 py-2';
  return (
    <>
      <div className={`${cell} min-w-0 pr-1`}>
        <span className="block text-[11px] font-medium uppercase tracking-wide text-zinc-400">
          {label}
        </span>
        {hint && (
          <span className="mt-0.5 block text-[10px] leading-snug text-zinc-600" title={hintTitle}>
            {hint}
          </span>
        )}
      </div>
      <div className={`${cell} truncate text-right text-sm tabular-nums text-zinc-400`}>
        {plan ?? '—'}
      </div>
      <div className={cell}>{children}</div>
      <div className={`${cell} text-right text-xs font-medium tabular-nums text-zinc-400`}>
        {delta}
      </div>
    </>
  );
}

/** A litre figure for the recipe column, or null when the recipe never stated one. */
function litres(value: number | null): string | null {
  return value == null ? null : `${value} L`;
}

/** A gravity as the brew sheet prints it — three places, or nothing at all. */
function gravity(value: string | null): string | null {
  return value ? fmt(value, 3) : null;
}

/**
 * A read-only figure with its label — for the figures that stand on their own,
 * outside the comparison grid: the recipe's own numbers, the day's dates, and
 * what a viewer who can't edit the log sees in place of a field.
 */
function Fact({
  label,
  value,
  swatch,
  swatchTitle,
}: {
  label: string;
  value: string;
  /** The beer's colour, for the figure that describes it. */
  swatch?: string | null;
  /** Tooltip for the swatch, when it says more than the figure does. */
  swatchTitle?: string | null;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
      <span className="block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <span className="mt-0.5 flex items-center gap-2 text-sm text-zinc-200" title={value}>
        <span className="min-w-0 truncate">{value}</span>
        {swatch && (
          <span
            className="h-3 w-3 shrink-0 rounded-full ring-1 ring-black/40"
            style={{ backgroundColor: swatch }}
            title={swatchTitle ?? undefined}
            aria-hidden
          />
        )}
      </span>
    </div>
  );
}

const FIELD_CLASS =
  'mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none';
const LABEL_CLASS = 'block text-[11px] font-medium uppercase tracking-wide text-zinc-500';

/** The input inside a comparison row's Actual cell. */
const CELL_CLASS =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm tabular-nums text-zinc-100 focus:border-zinc-500 focus:outline-none';

/**
 * A measured number, in a comparison row against what the recipe asks for.
 * Saves on blur; empty clears it back to unmeasured — the log's "we didn't take
 * this reading", which is not the same as zero.
 */
function NumberRow({
  label,
  unit,
  plan,
  value,
  hint,
  placeholder = '—',
  readOnlyValue,
  editable,
  onSave,
}: {
  label: string;
  unit: string;
  /** The recipe's figure for the same thing, as the sheet states it. */
  plan: string | null;
  value: number | null;
  /** A note under the label — what the app worked the figure out to be. */
  hint?: string | null;
  /** Greyed text in an empty field — where a figure the app calculates shows. */
  placeholder?: string;
  /** What a read-only viewer sees when nothing was typed (e.g. the calculation). */
  readOnlyValue?: string | null;
  editable: boolean;
  onSave: (value: number | null) => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  // Follow the server when it disagrees — another client's edit, or a save that
  // was rejected and rolled back — but never while the field is being typed in.
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value == null ? '' : String(value));
  }, [value]);

  const delta = targetDelta(value, plan, unit);
  const heading = `${label} (${unit})`;

  function commit(): void {
    focused.current = false;
    const trimmed = draft.trim().replace(',', '.');
    if (trimmed === '') {
      if (value != null) void onSave(null);
      return;
    }
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setDraft(value == null ? '' : String(value));
      return;
    }
    if (parsed !== value) void onSave(parsed);
  }

  if (!editable) {
    return (
      <Row label={heading} plan={plan} delta={delta} hint={hint}>
        <span className="block text-sm tabular-nums text-zinc-100">
          {value == null ? (readOnlyValue ?? '—') : String(value)}
        </span>
      </Row>
    );
  }

  return (
    <Row label={heading} plan={plan} delta={delta} hint={hint}>
      <input
        type="text"
        inputMode="decimal"
        aria-label={heading}
        value={draft}
        placeholder={placeholder}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        className={CELL_CLASS}
      />
    </Row>
  );
}

/** A measured gravity. Text, like the recipe's own, so "1.058" survives as typed. */
function GravityRow({
  label,
  plan,
  value,
  editable,
  onSave,
}: {
  label: string;
  plan: string | null;
  value: string;
  editable: boolean;
  onSave: (value: string) => Promise<void>;
}): JSX.Element {
  // The reading, not the keystrokes: a value stored before this was normalized
  // — or typed as "1037" a moment ago — shows and compares as the 1.037 it is.
  // The correction is written back the next time the field is left, so the log
  // converges on one way of writing a gravity rather than two.
  const reading = gravityText(value);
  const [draft, setDraft] = useState(reading);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(reading);
  }, [reading]);

  const delta = targetDelta(reading, plan, 'gravity');

  if (!editable) {
    return (
      <Row label={label} plan={plan} delta={delta}>
        <span className="block text-sm tabular-nums text-zinc-100">{reading || '—'}</span>
      </Row>
    );
  }

  return (
    <Row label={label} plan={plan} delta={delta}>
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        value={draft}
        placeholder="—"
        maxLength={20}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          focused.current = false;
          const next = gravityText(draft);
          if (next !== value) void onSave(next);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        className={CELL_CLASS}
      />
    </Row>
  );
}

/**
 * A row whose Actual column is worked out rather than typed — ABV, attenuation.
 * Both sides are already formatted; the delta is read back off them, so the two
 * figures and the gap between them can never describe different arithmetic.
 */
function DerivedRow({
  label,
  unit,
  plan,
  actual,
  hint,
  hintTitle,
}: {
  label: string;
  unit: string;
  plan: string | null;
  actual: string | null;
  hint?: string | null;
  hintTitle?: string;
}): JSX.Element {
  return (
    <Row
      label={`${label} (${unit})`}
      plan={plan}
      delta={targetDelta(actual, plan, unit)}
      hint={hint}
      hintTitle={hintTitle}
    >
      <span className="block text-sm tabular-nums text-zinc-100">{actual ?? '—'}</span>
    </Row>
  );
}

/**
 * A measured number with nothing to compare it against — what the day drew and
 * burned, which no brew sheet states a target for. A card of its own rather than
 * a row in the grid above, so an empty Recipe column never implies the recipe
 * forgot to say.
 */
function NumberField({
  label,
  unit,
  value,
  editable,
  onSave,
}: {
  label: string;
  unit: string;
  value: number | null;
  editable: boolean;
  onSave: (value: number | null) => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value == null ? '' : String(value));
  }, [value]);

  const heading = `${label} (${unit})`;

  function commit(): void {
    focused.current = false;
    const trimmed = draft.trim().replace(',', '.');
    if (trimmed === '') {
      if (value != null) void onSave(null);
      return;
    }
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setDraft(value == null ? '' : String(value));
      return;
    }
    if (parsed !== value) void onSave(parsed);
  }

  if (!editable) {
    return <Fact label={heading} value={value == null ? '—' : `${value} ${unit}`} />;
  }

  return (
    <label className="block rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
      <span className={LABEL_CLASS}>{heading}</span>
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        placeholder="—"
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        className={FIELD_CLASS}
      />
    </label>
  );
}

/**
 * How long the brew session took, as hours and minutes rather than one number of
 * minutes — nobody remembers a brew session as "340 minutes".
 */
function DurationField({
  minutes,
  editable,
  onSave,
}: {
  minutes: number | null;
  editable: boolean;
  onSave: (minutes: number | null) => Promise<void>;
}): JSX.Element {
  const [hours, setHours] = useState(minutes == null ? '' : String(Math.floor(minutes / 60)));
  const [mins, setMins] = useState(minutes == null ? '' : String(minutes % 60));
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current) return;
    setHours(minutes == null ? '' : String(Math.floor(minutes / 60)));
    setMins(minutes == null ? '' : String(minutes % 60));
  }, [minutes]);

  if (!editable) return <Fact label="Took" value={formatDuration(minutes)} />;

  function commit(): void {
    focused.current = false;
    const h = hours.trim() === '' ? 0 : Number.parseInt(hours, 10);
    const m = mins.trim() === '' ? 0 : Number.parseInt(mins, 10);
    if (hours.trim() === '' && mins.trim() === '') {
      if (minutes != null) void onSave(null);
      return;
    }
    if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || m < 0) return;
    const total = h * 60 + m;
    if (total !== minutes) void onSave(total);
  }

  const box = `${FIELD_CLASS} w-16 text-center`;
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
      <span className={LABEL_CLASS}>Took</span>
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          inputMode="numeric"
          aria-label="Hours"
          value={hours}
          placeholder="0"
          onFocus={() => {
            focused.current = true;
          }}
          onChange={(e) => setHours(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          className={box}
        />
        <span className="text-sm text-zinc-500">h</span>
        <input
          type="text"
          inputMode="numeric"
          aria-label="Minutes"
          value={mins}
          placeholder="0"
          onFocus={() => {
            focused.current = true;
          }}
          onChange={(e) => setMins(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          className={box}
        />
        <span className="text-sm text-zinc-500">m</span>
      </div>
    </div>
  );
}

/**
 * One of the batch's dates. Keeps the clock time it already had, so correcting
 * which day a brew happened doesn't move a 09:00 start to midnight.
 */
function DateField({
  label,
  iso,
  clearable = false,
  editable,
  onSave,
}: {
  label: string;
  iso: string | null;
  /** Whether this date can be taken off again (the optional stage stamps). */
  clearable?: boolean;
  editable: boolean;
  onSave: (iso: string | null) => Promise<void>;
}): JSX.Element {
  if (!editable) {
    return <Fact label={label} value={iso ? `${brewDate(iso)}, ${clockTime(iso)}` : '—'} />;
  }
  return (
    <div>
      <span className={LABEL_CLASS}>{label}</span>
      <div className="mt-1 flex items-center gap-1.5">
        <input
          type="date"
          value={iso ? dateInputValue(iso) : ''}
          onChange={(e) => {
            const next = e.target.value ? dateInputToIso(e.target.value, iso) : null;
            if (next !== iso) void onSave(next);
          }}
          className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 [color-scheme:dark]"
        />
        {clearable && iso && (
          <button
            type="button"
            onClick={() => void onSave(null)}
            title={`Clear ${label.toLowerCase()}`}
            className="rounded-lg border border-zinc-700 px-2 py-2 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

/** A free-text note that saves on blur. */
function NotesField({
  label,
  placeholder,
  value,
  editable,
  onSave,
}: {
  label: string;
  placeholder: string;
  value: string;
  editable: boolean;
  onSave: (value: string) => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  if (!editable) {
    return (
      <div>
        <span className={LABEL_CLASS}>{label}</span>
        <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-300">
          {value.trim() || <span className="text-zinc-600">Nothing noted.</span>}
        </p>
      </div>
    );
  }

  return (
    <label className="block">
      <span className={LABEL_CLASS}>{label}</span>
      <textarea
        rows={4}
        value={draft}
        placeholder={placeholder}
        maxLength={20_000}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          focused.current = false;
          if (draft !== value) void onSave(draft);
        }}
        className={`${FIELD_CLASS} resize-y`}
      />
    </label>
  );
}

/** Five stars; clicking the one already set takes the rating off again. */
function RatingField({
  rating,
  editable,
  onSave,
}: {
  rating: number | null;
  editable: boolean;
  onSave: (rating: number | null) => Promise<void>;
}): JSX.Element {
  const stars = [1, 2, 3, 4, 5];
  if (!editable) {
    return (
      <div>
        <span className={LABEL_CLASS}>How it turned out</span>
        <p className="mt-1 text-sm text-amber-300">
          {rating == null ? <span className="text-zinc-600">Not rated.</span> : '★'.repeat(rating)}
        </p>
      </div>
    );
  }
  return (
    <div>
      <span className={LABEL_CLASS}>How it turned out</span>
      <div className="mt-1 flex items-center gap-1">
        {stars.map((star) => (
          <button
            key={star}
            type="button"
            aria-label={`${star} of 5`}
            onClick={() => void onSave(rating === star ? null : star)}
            className={`text-2xl leading-none transition hover:scale-110 ${
              rating != null && star <= rating ? 'text-amber-300' : 'text-zinc-700'
            }`}
          >
            ★
          </button>
        ))}
        {rating != null && (
          <span className="ml-2 text-xs text-zinc-500">Click again to clear</span>
        )}
      </div>
    </div>
  );
}
