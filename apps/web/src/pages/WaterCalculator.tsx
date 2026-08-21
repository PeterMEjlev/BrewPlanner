import type { SavedWaterProfile } from '@checklist/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { canControl, useAuth } from '../auth';
import {
  Card,
  Field,
  Metric,
  MetricsLine,
  NumField,
  UnitSuffix,
  trimNum,
} from '../components/CalcUi';
import {
  DEFAULT_DISTILLED_MASH_PH,
  DEFAULT_GRAIN_KG,
  DEFAULT_GRIST_RATIO_L_PER_KG,
  DEFAULT_LIMITS,
  DEFAULT_SOURCE,
  DEFAULT_SOURCE_PH,
  DEFAULT_TARGET_MASH_PH,
  EMPTY_PROFILE,
  EMPTY_SALTS,
  IONS,
  ION_META,
  LACTIC_88_MEQ_PER_ML,
  SALTS,
  TARGET_PRESETS,
  acidMilliequivalents,
  additions,
  alkalinityCaCO3,
  bicarbonateForResidualAlkalinity,
  caco3ToDH,
  hardnessCaCO3,
  mashBufferCapacity,
  mashWaterVolumeL,
  predictedMashPh,
  ratioDescriptor,
  requiredResidualAlkalinity,
  residualAlkalinity,
  resultingProfile,
  suggestSalts,
  sulfateChlorideRatio,
  type Ion,
  type IonLimits,
  type SaltGrams,
  type SaltId,
  type WaterProfile,
} from '../water';

/**
 * Brewing-water calculator — the BrewPlanner take on Brewersfriend's "Mash
 * Chemistry and Brewing Water Calculator". The brewer enters their total brewing
 * water, source profile and a target, then either dials in salt amounts by hand
 * (watching the resulting profile track the target live) or hits Auto-suggest
 * for a best-fit starting point. Everything is client-side and persisted per
 * browser; the chemistry lives in {@link ../water}.
 *
 * It's the largest of the calculators on the Tools page ([Tools.tsx]), which
 * owns the shell and the tool picker — this file is just the water one.
 */

const STORAGE_KEY = 'brewplanner.watercalc';

/** Where the brewing water starts: pure RO/distilled, or the brewery's tap water. */
type SourceMode = 'ro' | 'tap';

/**
 * What the grist needs of the water, pH-wise. The first three solve the
 * bicarbonate target the target grid starts from: alkalinity is what corrects
 * mash pH, so it's an answer before it's a style preference — which is why the
 * grid's HCO₃ field tracks this model until a brewer types over it.
 *
 * Most brews never touch these — a pale all-malt grist is what the defaults
 * describe, and the pH to aim for barely moves — so they're edited from a
 * disclosure on the predicted-pH result rather than from an input card of their
 * own. The one most brewers genuinely can't supply is `distilledPh`: it wants a
 * measurement, and ±0.1 on it moves the prediction by about as much, so the
 * figure downstream is a starting dose, not a verdict.
 *
 * Worth knowing when reading the bicarbonate target they produce: it is zero for
 * any grist whose `distilledPh` sits above `targetPh`. Pale malt lands near 5.7
 * against a 5.4 target, so the required residual alkalinity is about −225 ppm
 * and no plausible calcium level (it would take over ~315 ppm) lifts it back
 * above zero. Alkalinity is genuinely a dark-beer lever; everything else wants
 * acid, which is why the acid dose, not the HCO₃ figure, is what the UI leads
 * with.
 */
interface MashState {
  /** The pH this grist reaches in distilled water — a property of the malt alone. */
  distilledPh: number;
  /** Where the mash should land, measured at room temperature. */
  targetPh: number;
  /** Strike water per kg of grain: sets how hard the mash resists a pH change. */
  gristRatioLPerKg: number;
  /** Total grain bill. With the ratio above, this is what fixes the strike volume. */
  grainKg: number;
}

interface CalcState {
  /** Total brewing water (mash + sparge), litres. */
  volumeL: number;
  /** RO (all ions 0) by default; switch to 'tap' to start from the local supply. */
  sourceMode: SourceMode;
  /** The editable tap-water profile, used when sourceMode is 'tap'. */
  source: WaterProfile;
  /**
   * Flavour ions. `target.hco3` is ignored: bicarbonate comes from
   * {@link mash} unless {@link hco3Override} states otherwise.
   */
  target: WaterProfile;
  /**
   * A hand-typed bicarbonate target, ppm, or null to follow the mash-pH model.
   * The derived figure is the right answer for a grist whose pH you trust, but
   * it isn't the only reason to want alkalinity in the water — matching a
   * published profile, or brewing a grist whose distilled-water pH you haven't
   * measured — so the field is editable and this remembers the choice.
   */
  hco3Override: number | null;
  /** Upper bounds for the "keep it under this" ions, from the chosen preset. */
  limits: IonLimits;
  mash: MashState;
  salts: SaltGrams;
  /**
   * The recipe hand-off this state was seeded from — the query string, verbatim
   * — or null for a state nobody seeded. It exists because the hand-off params
   * outlive the seeding: the Tools rail carries the search across a tool switch
   * so flicking away and back doesn't lose the recipe, which also means this
   * component remounts with the same params still on the URL. Re-seeding then
   * would throw away every edit made since. Recorded here rather than in
   * component state so it survives to the next visit, which is the case the
   * brewer actually notices.
   */
  seededFrom: string | null;
}

const DEFAULT_MASH: MashState = {
  distilledPh: DEFAULT_DISTILLED_MASH_PH,
  targetPh: DEFAULT_TARGET_MASH_PH,
  gristRatioLPerKg: DEFAULT_GRIST_RATIO_L_PER_KG,
  grainKg: DEFAULT_GRAIN_KG,
};

const DEFAULT_STATE: CalcState = {
  volumeL: 30,
  sourceMode: 'ro',
  source: { ...DEFAULT_SOURCE },
  target: { ...TARGET_PRESETS[0]!.profile },
  hco3Override: null,
  limits: { ...TARGET_PRESETS[0]!.limits },
  mash: { ...DEFAULT_MASH },
  salts: { ...EMPTY_SALTS },
  seededFrom: null,
};

/**
 * The flavour ions, which are all a preset speaks to. Bicarbonate is excluded
 * because it has its own field below — one that starts from the mash-pH model
 * rather than from the preset.
 */
const TARGET_IONS: Ion[] = IONS.filter((ion) => ion !== 'hco3');

/** Everything the mash-pH model yields for a given state. */
function mashChemistry(target: WaterProfile, mash: MashState) {
  const buffer = mashBufferCapacity(mash.gristRatioLPerKg);
  const requiredRA = requiredResidualAlkalinity(mash.distilledPh, mash.targetPh, buffer);
  // Salts can't make water acidic, so a negative requirement floors at zero
  // bicarbonate and becomes an acid dose instead.
  const hco3 = Math.max(0, bicarbonateForResidualAlkalinity(requiredRA, target.ca, target.mg));
  return { buffer, requiredRA, hco3 };
}

function loadState(): CalcState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // First visit: open with a worked example — the best-fit salts for the
      // default target from RO water — so the headline answer (grams) is on
      // screen immediately rather than a page full of zeros.
      const { hco3 } = mashChemistry(DEFAULT_STATE.target, DEFAULT_STATE.mash);
      return {
        ...DEFAULT_STATE,
        salts: suggestSalts(EMPTY_PROFILE, { ...DEFAULT_STATE.target, hco3 }, DEFAULT_STATE.volumeL),
      };
    }
    const p = JSON.parse(raw) as Partial<CalcState>;
    // Merge over defaults so a partial/older blob still yields every field —
    // including states saved before mash pH drove the bicarbonate target.
    return {
      ...DEFAULT_STATE,
      ...p,
      source: { ...DEFAULT_STATE.source, ...p.source },
      target: { ...DEFAULT_STATE.target, ...p.target },
      hco3Override: p.hco3Override ?? null,
      seededFrom: p.seededFrom ?? null,
      limits: { ...DEFAULT_STATE.limits, ...p.limits },
      mash: { ...DEFAULT_STATE.mash, ...p.mash },
      salts: { ...DEFAULT_STATE.salts, ...p.salts },
    };
  } catch {
    return DEFAULT_STATE;
  }
}

/**
 * A recipe's target profile, handed over from its brew sheet as query params
 * (`/tools/water?ca=80&…&volume=30&recipe=Hazy%20IPA`). Overlaid on the saved state so
 * the calculator opens on that recipe's numbers, with best-fit salts already
 * solved — the same "answer on screen immediately" treatment as a first visit.
 *
 * Only the ions actually present are applied; anything the recipe leaves blank
 * keeps its saved value rather than silently becoming zero. A recipe's stored
 * bicarbonate becomes the override — the recipe states it deliberately, so it
 * wins over the model, and the HCO₃ field's Auto button hands the page back to
 * the mash-pH answer. The recipe's mash thickness and grain bill *are* taken: the
 * first sets how hard the mash resists the pH change, and the two together fix
 * the strike volume an acid correction is metered into.
 *
 * `distilledph` is the valuable one. It's the malt term, worked out from the
 * recipe's actual grain bill by the same shared model the recipe sheet uses, and
 * it replaces the pale-all-malt assumption this page falls back to when nobody
 * has told it what's in the mash tun.
 *
 * Seeding happens once per hand-off, tracked by {@link CalcState.seededFrom}:
 * the params stay on the URL for as long as the brewer is on the page, so
 * without that check every remount would overwrite their edits with the
 * recipe's opening numbers. The banner's Reset offers the re-seed back
 * deliberately.
 */
function applyQueryParams(base: CalcState, params: URLSearchParams): CalcState {
  const signature = params.toString();
  if (!signature || base.seededFrom === signature) return base;
  const target = { ...base.target };
  let sawIon = false;
  for (const ion of TARGET_IONS) {
    const raw = params.get(ion);
    if (raw === null) continue;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n) || n < 0) continue;
    target[ion] = n;
    sawIon = true;
  }
  if (!sawIon) return base;

  const volume = Number.parseFloat(params.get('volume') ?? '');
  const volumeL = Number.isFinite(volume) && volume > 0 ? volume : base.volumeL;
  const grist = Number.parseFloat(params.get('grist') ?? '');
  const grain = Number.parseFloat(params.get('grain') ?? '');
  const distilled = Number.parseFloat(params.get('distilledph') ?? '');
  const mash = {
    ...base.mash,
    ...(Number.isFinite(grist) && grist > 0 ? { gristRatioLPerKg: grist } : {}),
    ...(Number.isFinite(grain) && grain > 0 ? { grainKg: grain } : {}),
    ...(Number.isFinite(distilled) && distilled >= 4 && distilled <= 7
      ? { distilledPh: distilled }
      : {}),
  };
  const source = base.sourceMode === 'ro' ? EMPTY_PROFILE : base.source;
  const rawHco3 = Number.parseFloat(params.get('hco3') ?? '');
  const hco3Override = Number.isFinite(rawHco3) && rawHco3 >= 0 ? rawHco3 : null;
  const hco3 = hco3Override ?? mashChemistry(target, mash).hco3;
  return {
    ...base,
    target,
    hco3Override,
    mash,
    volumeL,
    seededFrom: signature,
    // A recipe arrives with no idea which preset it came from, so grade its ions
    // as point targets rather than borrowing bands that may not apply.
    limits: {},
    salts: suggestSalts(source, { ...target, hco3 }, volumeL),
  };
}

export function WaterCalculator(): JSX.Element {
  const [params] = useSearchParams();
  // Read once on mount: the recipe hand-off seeds the page, then it behaves like
  // any other visit (edits persist to localStorage as usual).
  const [state, setState] = useState<CalcState>(() => applyQueryParams(loadState(), params));
  // The grist inputs start folded away under the predicted-pH result: the
  // defaults answer for a pale all-malt grist, and the pH they produce is on
  // screen either way.
  const [mashOpen, setMashOpen] = useState(false);
  // The brewery's own target profiles, alongside the built-in style presets.
  // They live on the server so they follow the brewer between screens, which
  // means the picker has to cope with not having them yet — an empty list is a
  // fine state to render, so there's no spinner here.
  const [saved, setSaved] = useState<SavedWaterProfile[]>([]);
  const [savingName, setSavingName] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { auth } = useAuth();
  const mayEditProfiles = canControl(auth);
  useEffect(() => {
    let live = true;
    void api
      .listWaterProfiles()
      .then((list) => {
        if (live) setSaved(list);
      })
      // A calculator that can't reach the saved list is still a working
      // calculator, so this stays quiet rather than failing the page.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const fromRecipe = params.get('recipe');
  const fromRecipeId = params.get('recipeId');
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Per-browser convenience only — fine to lose if storage is unavailable.
    }
  }, [state]);

  const { volumeL, sourceMode, source, target, hco3Override, limits, mash, salts } = state;

  // RO/distilled starts from pure water (zero ions); tap uses the editable profile.
  const effectiveSource = sourceMode === 'ro' ? EMPTY_PROFILE : source;

  // Bicarbonate is solved rather than styled: the mash-pH model says how much
  // alkalinity this grist needs, and that's what the sixth target defaults to.
  // A typed override wins — the model only knows the grist it was told about.
  const { buffer, requiredRA, hco3: solvedHco3 } = useMemo(
    () => mashChemistry(target, mash),
    [target, mash],
  );
  const targetHco3 = hco3Override ?? solvedHco3;
  const fullTarget = useMemo(() => ({ ...target, hco3: targetHco3 }), [target, targetHco3]);

  const added = useMemo(() => additions(salts, volumeL), [salts, volumeL]);
  const result = useMemo(
    () => resultingProfile(effectiveSource, salts, volumeL),
    [effectiveSource, salts, volumeL],
  );

  // Where the mash actually lands with the water as dosed, and what it would
  // take to bring it down if the salts (or the tap water) overshoot. The acid
  // goes into the strike water only — the sparge carries the same ions but
  // never meets the grist, so dosing against the total would overshoot.
  const achievedRA = residualAlkalinity(result);
  const mashPh = predictedMashPh(mash.distilledPh, achievedRA, buffer);
  const mashWaterL = mashWaterVolumeL(mash.grainKg, mash.gristRatioLPerKg, volumeL);
  const acidMEq = achievedRA > requiredRA
    ? acidMilliequivalents(achievedRA, requiredRA, mashWaterL)
    : 0;

  const setSourceIon = (ion: Ion, v: number): void =>
    setState((s) => ({ ...s, source: { ...s.source, [ion]: v } }));
  // Hand-editing an ion drops its preset band: the brewer is stating a figure of
  // their own, and grading it against a range they've moved away from would be
  // worse than grading it as the point target they just typed.
  const setTargetIon = (ion: Ion, v: number): void =>
    setState((s) => {
      const next = { ...s.limits };
      delete next[ion];
      return { ...s, target: { ...s.target, [ion]: v }, limits: next };
    });
  const setTargetHco3 = (v: number): void => setState((s) => ({ ...s, hco3Override: v }));
  const clearTargetHco3 = (): void => setState((s) => ({ ...s, hco3Override: null }));
  const setMash = (patch: Partial<MashState>): void =>
    setState((s) => ({ ...s, mash: { ...s.mash, ...patch } }));
  const setSalt = (id: SaltId, v: number): void =>
    setState((s) => ({ ...s, salts: { ...s.salts, [id]: v } }));

  const autoSuggest = (): void =>
    setState((s) => {
      const src = s.sourceMode === 'ro' ? EMPTY_PROFILE : s.source;
      const hco3 = s.hco3Override ?? mashChemistry(s.target, s.mash).hco3;
      return { ...s, salts: suggestSalts(src, { ...s.target, hco3 }, s.volumeL) };
    });
  const clearSalts = (): void => setState((s) => ({ ...s, salts: { ...EMPTY_SALTS } }));
  // The way back to the recipe's opening numbers. Seeding is once-only so that
  // edits survive a remount, which leaves this as the only route to a re-seed —
  // and it should be a button press, not a side effect of navigation.
  const reseedFromRecipe = (): void =>
    setState((s) => applyQueryParams({ ...s, seededFrom: null }, params));

  // Applying a saved profile drops the preset bands, the same way hand-editing
  // an ion does: these are point targets the brewery typed, and grading them
  // against a style table's ranges would be grading them against the wrong
  // thing. Bicarbonate rides along as an override, or as null for the profiles
  // that chose to leave alkalinity to the grist.
  const applySaved = (profile: SavedWaterProfile): void =>
    setState((s) => ({
      ...s,
      target: {
        ...s.target,
        ca: profile.ca,
        mg: profile.mg,
        na: profile.na,
        cl: profile.cl,
        so4: profile.so4,
      },
      hco3Override: profile.hco3,
      limits: {},
    }));

  const saveProfile = async (name: string): Promise<void> => {
    setSaveError(null);
    try {
      // The five flavour ions as typed, plus whatever the HCO₃ field is
      // actually doing — a typed override is saved as a number, and following
      // the mash-pH model is saved as null so the profile keeps deferring to
      // whatever grist it's later used with.
      setSaved(
        await api.saveWaterProfile({
          name,
          ca: target.ca,
          mg: target.mg,
          na: target.na,
          cl: target.cl,
          so4: target.so4,
          hco3: hco3Override,
        }),
      );
      setSavingName(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save the profile.');
    }
  };

  const deleteProfile = async (id: string): Promise<void> => {
    setSaveError(null);
    try {
      setSaved(await api.deleteWaterProfile(id));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not delete the profile.');
    }
  };

  const ratio = sulfateChlorideRatio(result);

  return (
    <>
      {/* Arrived from a recipe's brew sheet. The volume warning matters: a
          recipe's batch size is what goes into the fermenter, while the salts
          have to be dosed into the whole mash + sparge volume, which is
          larger — so the pre-filled figure is a starting point, not the answer. */}
      {fromRecipe && (
        <div className="mb-5 rounded-xl border border-[#f87a68]/40 bg-[#f87a68]/10 px-4 py-3 text-sm text-zinc-200">
          <span className="font-semibold">Target profile from {fromRecipe}.</span>{' '}
          {params.get('volume')
            ? `Water volume is set to the recipe's ${params.get('volume')} L batch size — raise it to your actual total mash + sparge water.`
            : 'Check the water volume below before dosing.'}
          {' '}
          <button
            type="button"
            onClick={reseedFromRecipe}
            className="font-semibold text-[#f87a68] underline-offset-2 hover:underline"
          >
            Reset to its targets
          </button>
          {fromRecipeId && (
            <>
              {' · '}
              <Link
                to={`/recipes/${encodeURIComponent(fromRecipeId)}`}
                className="font-semibold text-[#f87a68] underline-offset-2 hover:underline"
              >
                Back to recipe
              </Link>
            </>
          )}
        </div>
      )}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_30rem]">
        {/* Inputs ----------------------------------------------------------- */}
        <div className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <Card title="Total brewing water">
              <div className="grid gap-4">
                <Field>
                  <NumField
                    value={volumeL}
                    min={0}
                    step={0.5}
                    ariaLabel="Total water (litres)"
                    onChange={(v) => setState((s) => ({ ...s, volumeL: v }))}
                  />
                  <UnitSuffix>L</UnitSuffix>
                </Field>
              </div>
            </Card>

            <Card title="Source water">
              <div className="mb-4 inline-flex rounded-lg border border-zinc-700 p-0.5">
                {(['ro', 'tap'] as SourceMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={sourceMode === mode}
                    onClick={() => setState((s) => ({ ...s, sourceMode: mode }))}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                      sourceMode === mode
                        ? 'bg-gradient-to-br from-[#f87a68] to-[#e0463f] text-white shadow'
                        : 'text-zinc-300 hover:bg-zinc-800'
                    }`}
                  >
                    {mode === 'ro' ? 'RO / distilled' : 'Tap water'}
                  </button>
                ))}
              </div>

              {sourceMode === 'ro' ? null : (
                <>
                  <p className="mb-4 text-xs leading-snug text-zinc-500">
                    Pre-filled estimate for the brewery's area — your utility report only lists
                    hardness (≈20 °dH) and trace metals, so replace these with a full ion analysis
                    when you have one.
                  </p>
                  <IonGrid profile={source} onChange={setSourceIon} idPrefix="src" />
                  <MetricsLine
                    items={[
                      { label: 'Hardness', value: `${Math.round(hardnessCaCO3(source))} ppm` },
                      { label: '', value: `${caco3ToDH(hardnessCaCO3(source)).toFixed(1)} °dH` },
                      { label: 'Alkalinity', value: `${Math.round(alkalinityCaCO3(source))} ppm CaCO₃` },
                      { label: 'pH', value: DEFAULT_SOURCE_PH.toFixed(1) },
                    ]}
                  />
                </>
              )}
            </Card>
          </div>

          <Card title="Target profile" hint="The flavour ions you want to brew with. Pick a preset to start, then tweak.">
            <div className="mb-4 flex flex-wrap gap-1.5">
              {TARGET_PRESETS.map((preset) => {
                const active = TARGET_IONS.every((ion) => target[ion] === preset.profile[ion]);
                return (
                  <button
                    key={preset.name}
                    type="button"
                    title={preset.note}
                    aria-pressed={active}
                    onClick={() =>
                      setState((s) => ({
                        ...s,
                        target: { ...preset.profile },
                        // A preset states flavour ions and leaves alkalinity to
                        // the mash, so picking one drops a typed HCO₃.
                        hco3Override: null,
                        limits: { ...preset.limits },
                      }))
                    }
                    className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                      active
                        ? 'border-transparent bg-gradient-to-br from-[#f87a68] to-[#e0463f] text-white shadow'
                        : 'border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800'
                    }`}
                  >
                    {preset.name}
                  </button>
                );
              })}
            </div>
            {/* The brewery's own profiles, kept in a row of their own below the
                style presets rather than mixed in with them. They're a
                different kind of thing — someone here typed these, and only
                these can be deleted — and a shared row would have made the ×
                on half the buttons look like an oversight on the other half. */}
            {(saved.length > 0 || mayEditProfiles) && (
              <div className="mb-4 border-t border-zinc-800/60 pt-3">
                <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  Saved profiles
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {saved.map((profile) => {
                    const active =
                      TARGET_IONS.every((ion) => ion !== 'hco3' && target[ion] === profile[ion]) &&
                      hco3Override === profile.hco3;
                    return (
                      <span
                        key={profile.id}
                        className={`inline-flex items-center rounded-lg border text-xs font-medium transition ${
                          active
                            ? 'border-transparent bg-gradient-to-br from-[#f87a68] to-[#e0463f] text-white shadow'
                            : 'border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800'
                        }`}
                      >
                        <button
                          type="button"
                          aria-pressed={active}
                          onClick={() => applySaved(profile)}
                          className="px-2.5 py-1"
                        >
                          {profile.name}
                        </button>
                        {mayEditProfiles && (
                          <button
                            type="button"
                            aria-label={`Delete ${profile.name}`}
                            onClick={() => void deleteProfile(profile.id)}
                            className={`px-1.5 py-1 text-sm leading-none transition ${
                              active ? 'text-white/70 hover:text-white' : 'text-zinc-500 hover:text-zinc-200'
                            }`}
                          >
                            ×
                          </button>
                        )}
                      </span>
                    );
                  })}
                  {/* Naming happens inline rather than in a dialog: the numbers
                      being saved are on screen right behind it, and a modal
                      would cover the thing the brewer is naming. */}
                  {mayEditProfiles &&
                    (savingName === null ? (
                      <button
                        type="button"
                        onClick={() => setSavingName('')}
                        className="rounded-lg border border-dashed border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200"
                      >
                        + Save current
                      </button>
                    ) : (
                      <form
                        className="flex items-center gap-1.5"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const name = savingName.trim();
                          if (name) void saveProfile(name);
                        }}
                      >
                        <input
                          autoFocus
                          value={savingName}
                          maxLength={60}
                          placeholder="Profile name"
                          aria-label="Profile name"
                          onChange={(e) => setSavingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setSavingName(null);
                          }}
                          className="w-36 rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-xs text-zinc-100 outline-none transition focus:border-[#f87a68]"
                        />
                        <button
                          type="submit"
                          disabled={savingName.trim() === ''}
                          className="rounded-lg bg-gradient-to-br from-[#f87a68] to-[#e0463f] px-2.5 py-1 text-xs font-semibold text-white shadow transition hover:brightness-110 disabled:opacity-40"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setSavingName(null)}
                          className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-300 transition hover:border-zinc-500 hover:bg-zinc-800"
                        >
                          Cancel
                        </button>
                      </form>
                    ))}
                </div>
                {/* Saving over a name replaces that profile, so say so before
                    the brewer discovers it by losing one. */}
                {savingName !== null && (
                  <p className="mt-2 text-xs leading-snug text-zinc-500">
                    Saves the five flavour ions and the HCO₃ setting above. Reusing a name
                    overwrites that profile.
                  </p>
                )}
                {saveError && <p className="mt-2 text-xs text-red-400">{saveError}</p>}
              </div>
            )}
            <IonGrid profile={target} onChange={setTargetIon} idPrefix="tgt" ions={TARGET_IONS} limits={limits} />
            {/* Bicarbonate sits apart from the five flavour ions because it
                behaves differently: it arrives already answered by the mash-pH
                model, and typing here is an override rather than a first
                choice. Showing it as a filled field beats hiding it — the
                figure drives the Resulting water table's HCO₃ target either
                way, so a brewer who disagrees with it needs somewhere to say
                so. */}
            <div className="mt-4 border-t border-zinc-800/60 pt-3">
              <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
                <label className="block" htmlFor="tgt-hco3">
                  <span className="block text-xs font-medium text-zinc-400">
                    {ION_META.hco3.label} <span className="text-zinc-600">{ION_META.hco3.symbol}</span>
                  </span>
                  <span className="mt-1 flex items-center">
                    <NumField
                      id="tgt-hco3"
                      // Rounded only while the model owns it: rounding a typed
                      // value would snap "105.5" back to 106 mid-keystroke.
                      value={hco3Override ?? Math.round(solvedHco3)}
                      min={0}
                      step={1}
                      ariaLabel="Bicarbonate target"
                      onChange={setTargetHco3}
                    />
                    <UnitSuffix>ppm</UnitSuffix>
                  </span>
                </label>
                {/* Only offered once there's something to undo: on the derived
                    figure the button would do nothing and read as a mode the
                    page isn't in. */}
                {hco3Override != null && (
                  <button
                    type="button"
                    onClick={clearTargetHco3}
                    className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-300 transition hover:border-zinc-500 hover:bg-zinc-800"
                  >
                    Auto ({Math.round(solvedHco3)} ppm)
                  </button>
                )}
              </div>
              <p className="mt-2 text-xs leading-snug text-zinc-500">
                {hco3Override == null
                  ? 'Set from what the grist needs to hit its mash pH, not from the style — see Predicted mash pH. Type over it to state your own.'
                  : `Your figure, overriding the ${Math.round(solvedHco3)} ppm the mash-pH model asks for. Predicted mash pH still grades the water you actually build.`}
              </p>
            </div>
            <p className="mt-3 text-xs leading-snug text-zinc-500">
              A range shown under an ion is an upper bound, not something to dose up to.
            </p>
          </Card>

          <Card title="Salt additions">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={autoSuggest}
                className="rounded-lg bg-gradient-to-br from-[#f87a68] to-[#e0463f] px-3 py-1.5 text-sm font-semibold text-white shadow transition hover:brightness-110"
              >
                Auto-suggest
              </button>
              <button
                type="button"
                onClick={clearSalts}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800"
              >
                Clear
              </button>
              <span className="text-xs text-zinc-500">Best-fit for the target — review and adjust.</span>
            </div>
            <div className="divide-y divide-zinc-800/70">
              {SALTS.map((salt) => (
                <div key={salt.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-zinc-200">{salt.name}</div>
                    <div className="text-xs text-zinc-500">
                      {salt.formula}
                      <span className="text-zinc-600"> · </span>
                      {Object.keys(salt.ppmPerGramPerL)
                        .map((ion) => ION_META[ion as Ion].symbol)
                        .join(' · ')}
                    </div>
                  </div>
                  <div className="flex w-28 shrink-0 items-center">
                    <NumField
                      value={salts[salt.id]}
                      min={0}
                      step={0.1}
                      ariaLabel={`${salt.name} grams`}
                      onChange={(v) => setSalt(salt.id, v)}
                    />
                    <UnitSuffix>g</UnitSuffix>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Results --------------------------------------------------------- */}
        <div className="space-y-5 xl:sticky xl:top-5 xl:self-start">
          <Card title="Salts to add">
            {SALTS.some((salt) => salts[salt.id] > 0) ? (
              <ul className="space-y-2.5">
                {SALTS.filter((salt) => salts[salt.id] > 0).map((salt) => (
                  <li
                    key={salt.id}
                    className="flex items-baseline justify-between gap-3 border-b border-zinc-800/60 pb-2.5 last:border-0 last:pb-0"
                  >
                    <span className="min-w-0">
                      <span className="text-sm font-medium text-zinc-200">{salt.name}</span>
                      <span className="ml-1.5 text-xs text-zinc-500">{salt.formula}</span>
                    </span>
                    <span className="shrink-0 text-lg font-semibold tabular-nums text-zinc-50">
                      {trimNum(salts[salt.id])}
                      <span className="ml-1 text-sm font-normal text-zinc-400">g</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-zinc-400">
                Nothing to add yet — hit{' '}
                <span className="font-semibold text-zinc-200">Auto-suggest</span> or enter amounts
                under Salt additions.
              </p>
            )}
          </Card>

          <Card title="Resulting water" hint="Source + salts, compared to your target.">
            <div className="overflow-x-auto">
              <table className="w-full text-sm tabular-nums">
                <thead>
                  <tr className="text-xs uppercase tracking-wider text-zinc-500">
                    <th className="py-1 text-left font-medium">Ion</th>
                    <th className="py-1 text-right font-medium">Src</th>
                    <th className="py-1 text-right font-medium">Add</th> 
                    <th className="py-1 text-right font-medium">Result</th>
                    <th className="py-1 text-right font-medium">Target</th>
                    <th className="py-1 text-right font-medium">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {IONS.map((ion) => {
                    const res = result[ion];
                    const tgt = fullTarget[ion];
                    const limit = limits[ion];
                    const delta = res - tgt;
                    const tone = deltaTone(res, tgt, limit);
                    return (
                      <tr key={ion} className="border-t border-zinc-800/60">
                        <td className="py-1.5 text-left text-zinc-300">{ION_META[ion].symbol}</td>
                        <td className="py-1.5 text-right text-zinc-500">{Math.round(effectiveSource[ion])}</td>
                        <td className="py-1.5 text-right text-zinc-400">
                          {added[ion] > 0 ? `+${Math.round(added[ion])}` : '—'}
                        </td>
                        <td className="py-1.5 text-right font-semibold text-zinc-100">{Math.round(res)}</td>
                        {/* A banded ion states the band, so the ✓ beside it is
                            legible as "inside the range" rather than a near-miss
                            on a number it plainly doesn't equal. */}
                        <td className="py-1.5 text-right text-zinc-400">
                          {limit == null ? Math.round(tgt) : `${Math.round(tgt)}–${Math.round(limit)}`}
                        </td>
                        <td className={`py-1.5 text-right font-semibold ${TONE_CLASS[tone]}`}>
                          {tone === 'good'
                            ? '✓'
                            : `${tone === 'over' ? '↑' : '↓'} ${Math.round(Math.abs(tone === 'over' && limit != null ? res - limit : delta))}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs">
              <span className="text-emerald-400">✓ on target / within band</span>
              <span className="text-zinc-600"> · </span>
              <span className="text-amber-400">↓ below (add more)</span>
              <span className="text-zinc-600"> · </span>
              <span className="text-red-400">↑ above (can't reduce)</span>
            </p>
            <p className="mt-1 text-xs text-zinc-600">
              All values ppm (mg/L). Salts only add ions — to lower one, start from RO water. The
              HCO₃⁻ target comes from the mash-pH model unless you've set it yourself.
            </p>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <Metric label="Hardness" value={`${Math.round(hardnessCaCO3(result))}`} unit={`ppm · ${caco3ToDH(hardnessCaCO3(result)).toFixed(1)} °dH`} />
              <Metric label="Alkalinity" value={`${Math.round(alkalinityCaCO3(result))}`} unit="ppm CaCO₃" />
              <Metric label="Residual alkalinity" value={`${Math.round(achievedRA)}`} unit={`needs ${Math.round(requiredRA)} ppm CaCO₃`} />
              <Metric
                label="SO₄ : Cl ratio"
                value={ratio == null ? '—' : isFinite(ratio) ? ratio.toFixed(2) : '∞'}
                unit={ratioDescriptor(ratio)}
              />
            </div>
          </Card>

          {/* The point of all the alkalinity arithmetic, stated as the number
              the brewer will actually meter on brew session — and, behind Adjust,
              the grist inputs that produced it. They live here rather than in
              their own input card because their only visible output is this
              pH and the dose beneath it: the bicarbonate target they also feed
              is zero for any grist starting above its target pH, which is
              every pale one, so leading with that figure said nothing. */}
          <Card title="Predicted mash pH" hint="From the grist's distilled-water pH and the residual alkalinity this water delivers.">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
              <div className="flex items-baseline gap-3">
                <span className={`text-3xl font-semibold tabular-nums ${TONE_CLASS[phTone(mashPh, mash.targetPh)]}`}>
                  {mashPh.toFixed(2)}
                </span>
                <span className="text-sm text-zinc-500">
                  target {mash.targetPh.toFixed(2)}
                  {Math.abs(mashPh - mash.targetPh) >= 0.01 && (
                    <> · {mashPh > mash.targetPh ? '+' : ''}{(mashPh - mash.targetPh).toFixed(2)}</>
                  )}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setMashOpen((open) => !open)}
                aria-expanded={mashOpen}
                className="shrink-0 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-300 transition hover:border-zinc-500 hover:bg-zinc-800"
              >
                {mashOpen ? 'Done' : 'Adjust grist'}
              </button>
            </div>
            {acidMEq > 0.5 ? (
              <p className="mt-3 text-sm leading-snug text-zinc-300">
                Acidify by{' '}
                <span className="font-semibold text-zinc-50">
                  {(acidMEq / LACTIC_88_MEQ_PER_ML).toFixed(1)} mL
                </span>{' '}
                of 88 % lactic acid into the {trimNum(mashWaterL)} L of strike water (
                {Math.round(acidMEq)} mEq) — not the full {trimNum(volumeL)} L, since only the
                mash meets the grist. Salts can only raise alkalinity, so this is the one
                adjustment they can't make.
              </p>
            ) : (
              <p className="mt-3 text-sm leading-snug text-zinc-400">
                No acid needed — the salt additions land this within reach of the target.
              </p>
            )}

            {mashOpen && (
              <div className="mt-4 border-t border-zinc-800/60 pt-4">
                <p className="text-xs leading-snug text-zinc-500">
                  What the grist asks of the water.{' '}
                  {fromRecipe && params.get('distilledph')
                    ? `The distilled-water pH below is worked out from ${fromRecipe}'s grain bill — colour-weighted, with acidulated malt counted separately. Override it if you've measured yours.`
                    : "Measure the distilled-water pH if you can — it's the malt's own figure, and 0.1 either way moves this prediction by about the same. With no grain bill to work from, the default assumes a pale all-malt grist; roast and crystal land lower."}
                </p>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <Field label="Distilled-water pH" hint="This grist, no minerals">
                    <NumField
                      value={mash.distilledPh}
                      min={4}
                      max={7}
                      step={0.05}
                      ariaLabel="Distilled-water mash pH"
                      onChange={(v) => setMash({ distilledPh: v })}
                    />
                  </Field>
                  <Field label="Target pH" hint="At room temperature">
                    <NumField
                      value={mash.targetPh}
                      min={4}
                      max={7}
                      step={0.05}
                      ariaLabel="Target mash pH"
                      onChange={(v) => setMash({ targetPh: v })}
                    />
                  </Field>
                  <Field label="Mash thickness" hint="Strike water per kg grain">
                    <NumField
                      value={mash.gristRatioLPerKg}
                      min={1}
                      max={10}
                      step={0.1}
                      ariaLabel="Mash thickness, litres per kilogram"
                      onChange={(v) => setMash({ gristRatioLPerKg: v })}
                    />
                    <UnitSuffix>L/kg</UnitSuffix>
                  </Field>
                  {/* Not part of the pH arithmetic — it's here because with
                      the thickness above it fixes the strike volume, which is
                      what the acid dose gets metered into. */}
                  <Field label="Grain bill" hint="Sets the strike volume">
                    <NumField
                      value={mash.grainKg}
                      min={0}
                      step={0.1}
                      ariaLabel="Grain bill, kilograms"
                      onChange={(v) => setMash({ grainKg: v })}
                    />
                    <UnitSuffix>kg</UnitSuffix>
                  </Field>
                </div>
                <MetricsLine
                  items={[
                    { label: 'Buffering', value: `${buffer.toFixed(1)} mEq/(pH·L)` },
                    { label: 'Residual alkalinity needed', value: `${Math.round(requiredRA)} ppm CaCO₃` },
                    { label: 'Strike water', value: `${trimNum(mashWaterL)} L of ${trimNum(volumeL)} L` },
                  ]}
                />
                {/* Only worth saying when it's true. A pale grist needs acid
                    and no bicarbonate at all, which the dose above already
                    covers; naming a target of zero there would be noise. */}
                {requiredRA > 0 && (
                  <p className="mt-3 text-xs leading-snug text-zinc-500">
                    This grist starts below its target, so the water should carry{' '}
                    <span className="font-medium text-zinc-300">
                      {Math.round(solvedHco3)} ppm HCO₃⁻
                    </span>{' '}
                    — Auto-suggest doses that as Baking Soda, which brings sodium with it.
                    {hco3Override != null &&
                      ` Your Target profile overrides this with ${Math.round(hco3Override)} ppm, which is what gets dosed.`}
                  </p>
                )}
              </div>
            )}

            <p className="mt-2 text-xs leading-snug text-zinc-600">
              An estimate from the Kolbach/Troester buffering model, sensitive to malt bill and
              crush. Treat it as a starting dose and check with a meter at mash-in.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}

// --- Small presentational helpers ------------------------------------------

/**
 * A 2/3-column grid of ion inputs, each labelled with its symbol + unit. The
 * source grid takes all six; the target grid takes the five flavour ions, since
 * bicarbonate gets its own field with an Auto affordance the others don't need.
 * `limits` annotates the ions whose target is an upper bound.
 */
function IonGrid({
  profile,
  onChange,
  idPrefix,
  ions = IONS,
  limits,
}: {
  profile: WaterProfile;
  onChange: (ion: Ion, value: number) => void;
  idPrefix: string;
  ions?: Ion[];
  limits?: IonLimits;
}): JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {ions.map((ion) => (
        <label key={ion} className="block" htmlFor={`${idPrefix}-${ion}`}>
          <span className="block text-xs font-medium text-zinc-400">
            {ION_META[ion].label} <span className="text-zinc-600">{ION_META[ion].symbol}</span>
          </span>
          <span className="mt-1 flex items-center">
            <NumField
              id={`${idPrefix}-${ion}`}
              value={profile[ion]}
              min={0}
              step={1}
              ariaLabel={ION_META[ion].label}
              onChange={(v) => onChange(ion, v)}
            />
            <UnitSuffix>ppm</UnitSuffix>
          </span>
          {limits?.[ion] != null && (
            <span className="mt-0.5 block text-[11px] text-zinc-600">
              up to {limits[ion]} ppm
            </span>
          )}
        </label>
      ))}
    </div>
  );
}

/**
 * How a resulting ion sits against its target: `good` when within ~10 % (min
 * 5 ppm, so small targets like Mg aren't flattered by a fixed floor), else
 * `over` (too much — salts can't remove it) or `under` (add more).
 *
 * With a `limit`, the target is a band rather than a point: anything between the
 * target and the ceiling is on spec. Magnesium and sodium are the cases — their
 * published ranges start at zero, and grading 8 ppm of magnesium as "8 too high"
 * against a target of 0 would be a false alarm when the guidance is 0–10.
 */
type Tone = 'good' | 'over' | 'under';

function deltaTone(result: number, target: number, limit?: number): Tone {
  const tolerance = Math.max(5, target * 0.1);
  if (limit != null) {
    if (result <= limit + tolerance) return result < target - tolerance ? 'under' : 'good';
    return 'over';
  }
  const delta = result - target;
  if (Math.abs(delta) <= tolerance) return 'good';
  return delta > 0 ? 'over' : 'under';
}

/**
 * Mash pH against its target. Tighter than the ion tolerances because pH is a
 * log scale: 0.1 either way is the band brewers actually work to, and 0.2 out is
 * a beer that tastes different.
 */
function phTone(predicted: number, target: number): Tone {
  const delta = predicted - target;
  if (Math.abs(delta) <= 0.1) return 'good';
  return delta > 0 ? 'over' : 'under';
}

/** Text colour per {@link Tone}: green on target, amber below, red above. */
const TONE_CLASS: Record<Tone, string> = {
  good: 'text-emerald-400',
  under: 'text-amber-400',
  over: 'text-red-400',
};

