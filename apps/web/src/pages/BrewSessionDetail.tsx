import type {
  BrewSessionDetail,
  BrewSessionRigSample,
  BrewSessionStatus,
  BrewSessionTempStats,
  UpdateBrewSessionInput,
} from '@checklist/shared';
import {
  BREW_SESSION_STATUSES,
  BREW_SESSION_STATUS_LABELS,
  abvFromGravities,
  apparentAttenuation,
  ebcColor,
  measuredEfficiency,
} from '@checklist/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  CartesianGrid,
  Line,
  LineChart,
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
} from '../brewSessions';
import { DashboardShell } from '../components/DashboardShell';
import { Select } from '../components/Select';
import { SheetSection } from '../components/SheetSection';
import { timeAxis } from '../components/timeAxis';
import { kr } from '../money';
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
 * The rig's three pots, coloured as the rig's own touchscreen colours them (see
 * components/brewsystem/theme.ts) so a curve here reads as the same vessel the
 * Brew System page shows.
 */
const POT_LINES = [
  { key: 'bk' as const, label: 'Boil kettle', color: '#ef4444' },
  { key: 'mlt' as const, label: 'Mash tun', color: '#f97316' },
  { key: 'hlt' as const, label: 'Hot liquor', color: '#3b82f6' },
];

/** The page's cards, in the order they appear. */
type SectionKey = 'stage' | 'brewSession' | 'rig' | 'fermentation' | 'recipe' | 'notes';

const COLLAPSE_KEY = 'brewplanner.brewSessionSections';

/** Everything open: a log entry is meant to be read top to bottom. */
const ALL_OPEN: Record<SectionKey, boolean> = {
  stage: false,
  brewSession: false,
  rig: false,
  fermentation: false,
  recipe: false,
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
    if (
      !window.confirm(
        `Delete the brew session for “${brewSession.recipe.name}” on ${brewDate(brewSession.brewedAt)}? This cannot be undone.`,
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

  const { recipe, measured } = brewSession;
  const abv = abvFromGravities(measured.og, measured.fg);
  const attenuation = apparentAttenuation(measured.og, measured.fg);
  const pour = ebcColor(recipe.ebc);

  // What the brewhouse managed, worked back from the gravities the brewer took
  // against the grain bill snapshotted on the day. Two figures, because they
  // answer different questions: brewhouse efficiency is everything the day lost
  // between mash and fermenter, mash efficiency only the conversion — so a
  // disappointing OG with a healthy mash figure was the kettle's doing.
  const brewhouse = measuredEfficiency({
    gravity: measured.og,
    litres: measured.volumeL,
    mashedPointGallons: recipe.mashedPointGallons,
    unmashedPointGallons: recipe.unmashedPointGallons,
  });
  const mash = measuredEfficiency({
    gravity: measured.preBoilGravity,
    litres: measured.preBoilVolumeL,
    mashedPointGallons: recipe.mashedPointGallons,
    // Only the sugars already in the kettle at that reading — a late addition
    // isn't in the wort yet, and crediting the mash with either would flatter it.
    unmashedPointGallons: recipe.preBoilUnmashedPointGallons,
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
              <h1 className="truncate text-xl font-semibold text-zinc-100">{recipe.name}</h1>
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
                recipe.style,
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
            title="The brew session"
            icon="🔥"
            meta={formatDuration(brewSession.durationMinutes)}
            collapsed={collapsed}
            onToggle={toggle}
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <DurationField
                minutes={brewSession.durationMinutes}
                editable={controllable}
                onSave={(minutes) => save({ durationMinutes: minutes })}
              />
              <GravityField
                label="Pre-boil gravity"
                value={measured.preBoilGravity}
                editable={controllable}
                onSave={(preBoilGravity) => save({ measured: { preBoilGravity } })}
              />
              <NumberField
                label="Pre-boil volume"
                unit="L"
                value={measured.preBoilVolumeL}
                hint={
                  measured.preBoilGravity && measured.preBoilVolumeL == null
                    ? 'Add this and the mash efficiency follows'
                    : null
                }
                editable={controllable}
                onSave={(preBoilVolumeL) => save({ measured: { preBoilVolumeL } })}
              />
              <GravityField
                label="Original gravity"
                value={measured.og}
                target={recipe.og}
                editable={controllable}
                onSave={(og) => save({ measured: { og } })}
              />
              <GravityField
                label="Final gravity"
                value={measured.fg}
                target={recipe.fg}
                editable={controllable}
                onSave={(fg) => save({ measured: { fg } })}
              />
              <NumberField
                label="Into the fermenter"
                unit="L"
                value={measured.volumeL}
                target={recipe.batchSizeL != null ? `${recipe.batchSizeL} L` : null}
                editable={controllable}
                onSave={(volumeL) => save({ measured: { volumeL } })}
              />
              <NumberField
                label="Mash temperature"
                unit="°C"
                value={measured.mashTempC}
                target={recipe.mashTemp}
                editable={controllable}
                onSave={(mashTempC) => save({ measured: { mashTempC } })}
              />
              <NumberField
                label="Boil"
                unit="min"
                value={measured.boilTimeMin}
                editable={controllable}
                onSave={(boilTimeMin) => save({ measured: { boilTimeMin } })}
              />
              {/* Calculated from the OG and volume, and only typed into when
                  the brewer knows the arithmetic is wrong — an eyeballed volume
                  moves this figure several points, and they were there. */}
              <NumberField
                label="Efficiency"
                unit="%"
                value={measured.efficiencyPct}
                placeholder={brewhouse != null ? pct(brewhouse) : '—'}
                readOnlyValue={brewhouse != null ? `${pct(brewhouse)} (calculated)` : null}
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
            <DerivedFigures
              abv={abv}
              attenuation={attenuation}
              brewhouse={brewhouse}
              mash={mash}
              targetAbv={recipe.abv}
            />
          </Section>

          <RigTemperatures
            samples={brewSession.rigSamples}
            stats={brewSession.rigStats}
            collapsed={collapsed}
            onToggle={toggle}
          />

          <FermentationCard brewSession={brewSession} collapsed={collapsed} onToggle={toggle} />

          <Section
            section="recipe"
            title="The recipe, as it read that day"
            icon="📖"
            meta={recipe.style || undefined}
            collapsed={collapsed}
            onToggle={toggle}
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Fact label="Target OG → FG" value={recipe.og && recipe.fg ? `${recipe.og} → ${recipe.fg}` : recipe.og || '—'} />
              <Fact label="Target ABV" value={recipe.abv ? `${recipe.abv}%` : '—'} />
              <Fact label="Bitterness" value={recipe.ibu ? `${recipe.ibu} IBU` : '—'} />
              <Fact label="Colour" value={recipe.ebc ? `${recipe.ebc} EBC` : '—'} />
              <Fact label="Batch size" value={recipe.batchSizeL != null ? `${recipe.batchSizeL} L` : '—'} />
              <Fact label="Grain bill" value={recipe.grainKg != null ? `${recipe.grainKg} kg` : '—'} />
              <Fact label="Hops" value={recipe.hopGrams != null ? `${recipe.hopGrams} g` : '—'} />
              <Fact label="Ingredient cost" value={recipe.costDkk != null ? kr(recipe.costDkk, 0) : '—'} />
              <Fact label="Yeast" value={recipe.yeast || '—'} />
              <Fact label="Mash" value={recipe.mashTemp ?? '—'} />
              <Fact label="Fermentation" value={recipe.fermentationTemp ?? '—'} />
            </div>
            <p className="mt-3 text-xs text-zinc-600">
              Copied onto this entry when the brew session started, so it still says what was
              actually brewed after the recipe is edited or re-costed.
              {!brewSession.recipeId && ' The recipe it came from has since been deleted.'}
            </p>
          </Section>

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
 * Everything the measured figures add up to, under the fields they came from.
 * Nothing here is stored: they are all one arithmetic step from what the brewer
 * typed, so recomputing them is both cheaper and more honest than keeping a copy
 * that a corrected gravity would leave stale.
 *
 * Silent until there is something to say — a half-filled brew session shows the
 * figures it has earned and no placeholders for the rest.
 */
function DerivedFigures({
  abv,
  attenuation,
  brewhouse,
  mash,
  targetAbv,
}: {
  abv: number | null;
  attenuation: number | null;
  brewhouse: number | null;
  mash: number | null;
  targetAbv: string;
}): JSX.Element | null {
  const parts: string[] = [];
  if (abv != null) parts.push(`${abv.toFixed(1)}% ABV`);
  if (attenuation != null) parts.push(`${attenuation.toFixed(0)}% apparent attenuation`);
  if (brewhouse != null) parts.push(`${brewhouse.toFixed(0)}% brewhouse efficiency`);
  if (mash != null) parts.push(`${mash.toFixed(0)}% mash efficiency`);
  if (parts.length === 0) return null;
  return (
    <p className="mt-3 text-xs text-zinc-500">
      Worked out from what you measured:{' '}
      {parts.map((part, index) => (
        <span key={part}>
          {index > 0 && ' · '}
          <span className="text-zinc-300">{part}</span>
        </span>
      ))}
      {abv != null && targetAbv && ` (the recipe targets ${targetAbv}%)`}
      {/* An efficiency over 100 is arithmetic, not brewing: something measured
          is wrong, and saying so beats quietly showing an impossible number. */}
      {((brewhouse != null && brewhouse > 100) || (mash != null && mash > 100)) && (
        <span className="text-amber-300/90">
          {' '}
          — over 100% means a volume or a gravity is off.
        </span>
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
  samples,
  stats,
  collapsed,
  onToggle,
}: {
  samples: BrewSessionRigSample[];
  stats: BrewSessionDetail['rigStats'];
  collapsed: Record<SectionKey, boolean>;
  onToggle: (section: SectionKey) => void;
}): JSX.Element | null {
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
      <div className="h-64 w-full">
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
            {POT_LINES.map((pot) => (
              <Line
                key={pot.key}
                type="monotone"
                dataKey={pot.key}
                name={pot.label}
                stroke={pot.color}
                strokeWidth={2}
                dot={false}
                // A sensor that dropped out leaves a gap rather than a straight
                // line across the minutes it wasn't reading.
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {POT_LINES.map((pot) => (
          <PotStats key={pot.key} label={pot.label} color={pot.color} stats={stats[pot.key]} />
        ))}
      </div>
      <p className="mt-3 text-xs text-zinc-600">
        Logged from the rig while this was in its brew session. Kept with the entry rather than with
        the fleet's telemetry, so the curve is still here years later.
      </p>
    </Section>
  );
}

function PotStats({
  label,
  color,
  stats,
}: {
  label: string;
  color: string;
  stats: BrewSessionTempStats | null;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} aria-hidden />
        <span className="text-xs font-medium text-zinc-400">{label}</span>
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

/** A read-only figure with its label. */
function Fact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
      <span className="block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <span className="mt-0.5 block truncate text-sm text-zinc-200" title={value}>
        {value}
      </span>
    </div>
  );
}

const FIELD_CLASS =
  'mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none';
const LABEL_CLASS = 'block text-[11px] font-medium uppercase tracking-wide text-zinc-500';

/** The wrapper every editable figure shares: label, control, and a note under it. */
function Field({
  label,
  target,
  hint,
  children,
}: {
  label: string;
  /** What the recipe aimed for, for a figure that has a target to miss. */
  target?: string | null;
  /** A note in place of the target — what the app worked the figure out to be. */
  hint?: string | null;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="block rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
      <span className={LABEL_CLASS}>{label}</span>
      {children}
      {hint
        ? <span className="mt-1 block text-[11px] text-zinc-500">{hint}</span>
        : target && <span className="mt-1 block text-[11px] text-zinc-600">Recipe: {target}</span>}
    </label>
  );
}

/**
 * A measured number that saves on blur. Empty clears it back to unmeasured —
 * the log's "we didn't take this reading", which is not the same as zero.
 */
function NumberField({
  label,
  unit,
  value,
  target,
  hint,
  placeholder = '—',
  readOnlyValue,
  editable,
  onSave,
}: {
  label: string;
  unit: string;
  value: number | null;
  target?: string | null;
  /** A note under the field, in place of the recipe's target. */
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

  if (!editable) {
    return (
      <Fact
        label={`${label} (${unit})`}
        value={value == null ? (readOnlyValue ?? '—') : `${value} ${unit}`}
      />
    );
  }

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

  return (
    <Field label={`${label} (${unit})`} target={target} hint={hint}>
      <input
        type="text"
        inputMode="decimal"
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
        className={FIELD_CLASS}
      />
    </Field>
  );
}

/** A measured gravity. Text, like the recipe's own, so "1.058" survives as typed. */
function GravityField({
  label,
  value,
  target,
  editable,
  onSave,
}: {
  label: string;
  value: string;
  target?: string | null;
  editable: boolean;
  onSave: (value: string) => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  if (!editable) return <Fact label={label} value={value || '—'} />;

  return (
    <Field label={label} target={target || null}>
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        placeholder="—"
        maxLength={20}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          focused.current = false;
          const trimmed = draft.trim();
          if (trimmed !== value) void onSave(trimmed);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        className={FIELD_CLASS}
      />
    </Field>
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
