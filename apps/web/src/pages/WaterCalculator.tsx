import { useEffect, useMemo, useState } from 'react';
import { DashboardShell } from '../components/DashboardShell';
import {
  DEFAULT_SOURCE,
  DEFAULT_SOURCE_PH,
  EMPTY_PROFILE,
  EMPTY_SALTS,
  IONS,
  ION_META,
  SALTS,
  TARGET_PRESETS,
  additions,
  alkalinityCaCO3,
  caco3ToDH,
  hardnessCaCO3,
  ratioDescriptor,
  residualAlkalinity,
  resultingProfile,
  suggestSalts,
  sulfateChlorideRatio,
  type Ion,
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
 */

const STORAGE_KEY = 'brewplanner.watercalc';

/** Where the brewing water starts: pure RO/distilled, or the brewery's tap water. */
type SourceMode = 'ro' | 'tap';

interface CalcState {
  /** Total brewing water (mash + sparge), litres. */
  volumeL: number;
  /** RO (all ions 0) by default; switch to 'tap' to start from the local supply. */
  sourceMode: SourceMode;
  /** The editable tap-water profile, used when sourceMode is 'tap'. */
  source: WaterProfile;
  target: WaterProfile;
  salts: SaltGrams;
}

const DEFAULT_STATE: CalcState = {
  volumeL: 30,
  sourceMode: 'ro',
  source: { ...DEFAULT_SOURCE },
  target: { ...TARGET_PRESETS[0]!.profile },
  salts: { ...EMPTY_SALTS },
};

function loadState(): CalcState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // First visit: open with a worked example — the best-fit salts for the
      // default target from RO water — so the headline answer (grams) is on
      // screen immediately rather than a page full of zeros.
      return {
        ...DEFAULT_STATE,
        salts: suggestSalts(EMPTY_PROFILE, DEFAULT_STATE.target, DEFAULT_STATE.volumeL),
      };
    }
    const p = JSON.parse(raw) as Partial<CalcState>;
    // Merge over defaults so a partial/older blob still yields every field.
    return {
      ...DEFAULT_STATE,
      ...p,
      source: { ...DEFAULT_STATE.source, ...p.source },
      target: { ...DEFAULT_STATE.target, ...p.target },
      salts: { ...DEFAULT_STATE.salts, ...p.salts },
    };
  } catch {
    return DEFAULT_STATE;
  }
}

export function WaterCalculatorPage(): JSX.Element {
  const [state, setState] = useState<CalcState>(loadState);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Per-browser convenience only — fine to lose if storage is unavailable.
    }
  }, [state]);

  const { volumeL, sourceMode, source, target, salts } = state;

  // RO/distilled starts from pure water (zero ions); tap uses the editable profile.
  const effectiveSource = sourceMode === 'ro' ? EMPTY_PROFILE : source;

  const added = useMemo(() => additions(salts, volumeL), [salts, volumeL]);
  const result = useMemo(
    () => resultingProfile(effectiveSource, salts, volumeL),
    [effectiveSource, salts, volumeL],
  );

  const setSourceIon = (ion: Ion, v: number): void =>
    setState((s) => ({ ...s, source: { ...s.source, [ion]: v } }));
  const setTargetIon = (ion: Ion, v: number): void =>
    setState((s) => ({ ...s, target: { ...s.target, [ion]: v } }));
  const setSalt = (id: SaltId, v: number): void =>
    setState((s) => ({ ...s, salts: { ...s.salts, [id]: v } }));

  const autoSuggest = (): void =>
    setState((s) => {
      const src = s.sourceMode === 'ro' ? EMPTY_PROFILE : s.source;
      return { ...s, salts: suggestSalts(src, s.target, s.volumeL) };
    });
  const clearSalts = (): void => setState((s) => ({ ...s, salts: { ...EMPTY_SALTS } }));

  const ratio = sulfateChlorideRatio(result);

  return (
    <DashboardShell active="water">
      <main className="w-full max-w-[1280px] px-5 py-5">
        <div className="mb-5">
          <h1 className="text-xl font-semibold tracking-tight text-zinc-50">Water Calculator</h1>
          <p className="mt-0.5 max-w-3xl text-sm text-zinc-500">
            Work out how much gypsum, Epsom salt, calcium chloride and table salt to add to your
            brewing water to move it toward a target profile. Enter amounts by hand and watch the
            result, or hit Auto-suggest for a best-fit starting point.
          </p>
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_30rem]">
          {/* Inputs ----------------------------------------------------------- */}
          <div className="space-y-5">
            <Card title="Brewing water">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Total water" hint="Mash + sparge, all the water you treat.">
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

            <Card title="Source water" hint="Where your brewing water starts before adding salts.">
              <div className="mb-4 inline-flex rounded-lg border border-zinc-700 p-0.5">
                {(['ro', 'tap'] as SourceMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={sourceMode === mode}
                    onClick={() => setState((s) => ({ ...s, sourceMode: mode }))}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                      sourceMode === mode ? 'bg-blue-600 text-white' : 'text-zinc-300 hover:bg-zinc-800'
                    }`}
                  >
                    {mode === 'ro' ? 'RO / distilled' : 'Tap water'}
                  </button>
                ))}
              </div>

              {sourceMode === 'ro' ? (
                <p className="text-sm text-zinc-400">
                  Starting from pure RO / distilled water — all ions 0. Build the whole profile from
                  the salts below.
                </p>
              ) : (
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

            <Card title="Target profile" hint="The water you want to brew with. Pick a preset to start, then tweak.">
              <div className="mb-4 flex flex-wrap gap-1.5">
                {TARGET_PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    type="button"
                    title={preset.note}
                    onClick={() => setState((s) => ({ ...s, target: { ...preset.profile } }))}
                    className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-300 transition hover:border-zinc-500 hover:bg-zinc-800"
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
              <IonGrid profile={target} onChange={setTargetIon} idPrefix="tgt" />
            </Card>

            <Card title="Salt additions">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={autoSuggest}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-blue-500"
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
            <Card title="Salts to add" hint={`Grams for ${trimNum(volumeL)} L of total water.`}>
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
                      const tgt = target[ion];
                      const delta = res - tgt;
                      const tone = deltaTone(res, tgt);
                      return (
                        <tr key={ion} className="border-t border-zinc-800/60">
                          <td className="py-1.5 text-left text-zinc-300">{ION_META[ion].symbol}</td>
                          <td className="py-1.5 text-right text-zinc-500">{Math.round(effectiveSource[ion])}</td>
                          <td className="py-1.5 text-right text-zinc-400">
                            {added[ion] > 0 ? `+${Math.round(added[ion])}` : '—'}
                          </td>
                          <td className="py-1.5 text-right font-semibold text-zinc-100">{Math.round(res)}</td>
                          <td className="py-1.5 text-right text-zinc-400">{Math.round(tgt)}</td>
                          <td className={`py-1.5 text-right font-semibold ${TONE_CLASS[tone]}`}>
                            {tone === 'good'
                              ? '✓'
                              : `${tone === 'over' ? '↑' : '↓'} ${Math.round(Math.abs(delta))}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs">
                <span className="text-emerald-400">✓ on target</span>
                <span className="text-zinc-600"> · </span>
                <span className="text-amber-400">↓ below (add more)</span>
                <span className="text-zinc-600"> · </span>
                <span className="text-red-400">↑ above (can't reduce)</span>
              </p>
              <p className="mt-1 text-xs text-zinc-600">
                All values ppm (mg/L). Salts only add ions — to lower one, start from RO water.
              </p>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <Metric label="Hardness" value={`${Math.round(hardnessCaCO3(result))}`} unit={`ppm · ${caco3ToDH(hardnessCaCO3(result)).toFixed(1)} °dH`} />
                <Metric label="Alkalinity" value={`${Math.round(alkalinityCaCO3(result))}`} unit="ppm CaCO₃" />
                <Metric label="Residual alkalinity" value={`${Math.round(residualAlkalinity(result))}`} unit="ppm CaCO₃" />
                <Metric
                  label="SO₄ : Cl ratio"
                  value={ratio == null ? '—' : isFinite(ratio) ? ratio.toFixed(2) : '∞'}
                  unit={ratioDescriptor(ratio)}
                />
              </div>
            </Card>
          </div>
        </div>
      </main>
    </DashboardShell>
  );
}

// --- Small presentational helpers ------------------------------------------

function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">{title}</h2>
      {hint && <p className="mt-1 text-xs leading-snug text-zinc-500">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

const fieldClass =
  'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-right text-sm tabular-nums text-zinc-100 outline-none transition focus:border-blue-500';

/** A label/hint stacked over a control (control passed as children). */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-zinc-200">{label}</span>
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
      <span className="mt-1.5 flex items-center">{children}</span>
    </label>
  );
}

function UnitSuffix({ children }: { children: React.ReactNode }): JSX.Element {
  return <span className="ml-2 shrink-0 text-sm text-zinc-500">{children}</span>;
}

/** A 2/3-column grid of the six ion inputs, each labelled with its symbol + unit. */
function IonGrid({
  profile,
  onChange,
  idPrefix,
}: {
  profile: WaterProfile;
  onChange: (ion: Ion, value: number) => void;
  idPrefix: string;
}): JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {IONS.map((ion) => (
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
        </label>
      ))}
    </div>
  );
}

/** A compact inline row of derived metrics under an input card. */
function MetricsLine({ items }: { items: { label: string; value: string }[] }): JSX.Element {
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-zinc-800/60 pt-3 text-xs text-zinc-500">
      {items.map((it, i) => (
        <span key={i}>
          {it.label && <span className="text-zinc-600">{it.label}: </span>}
          <span className="font-medium tabular-nums text-zinc-300">{it.value}</span>
        </span>
      ))}
    </div>
  );
}

/** A boxed result metric: big value + unit/descriptor beneath a label. */
function Metric({ label, value, unit }: { label: string; value: string; unit: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-zinc-100">{value}</div>
      <div className="text-xs text-zinc-500">{unit}</div>
    </div>
  );
}

/**
 * How a resulting ion sits against its target: `good` when within ~10 % (min
 * 5 ppm, so small targets like Mg aren't flattered by a fixed floor), else
 * `over` (too much — salts can't remove it) or `under` (add more).
 */
type Tone = 'good' | 'over' | 'under';

function deltaTone(result: number, target: number): Tone {
  const delta = result - target;
  const tolerance = Math.max(5, target * 0.1);
  if (Math.abs(delta) <= tolerance) return 'good';
  return delta > 0 ? 'over' : 'under';
}

/** Text colour per {@link Tone}: green on target, amber below, red above. */
const TONE_CLASS: Record<Tone, string> = {
  good: 'text-emerald-400',
  under: 'text-amber-400',
  over: 'text-red-400',
};

/**
 * A controlled number input that keeps a local text buffer so partial entries
 * ("0.", "1.2") survive re-renders, syncing to the numeric prop only on a real
 * external change (preset applied, Auto-suggest, etc.). Emits a parsed number.
 */
function NumField({
  value,
  onChange,
  step = 1,
  min = 0,
  max,
  ariaLabel,
  id,
}: {
  value: number;
  onChange?: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  ariaLabel?: string;
  id?: string;
}): JSX.Element {
  const [text, setText] = useState(() => trimNum(value));
  useEffect(() => {
    const parsed = parseFloat(text);
    const current = Number.isFinite(parsed) ? parsed : 0;
    if (current !== value) setText(trimNum(value));
    // Only resync when the external numeric value changes, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      step={step}
      min={min}
      max={max}
      value={text}
      aria-label={ariaLabel}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const n = parseFloat(raw);
        onChange?.(Number.isFinite(n) ? Math.max(min, n) : 0);
      }}
      className={fieldClass}
    />
  );
}

/** Trim a number to a short, human string (no trailing zeros), '' for non-finite. */
function trimNum(v: number): string {
  if (!Number.isFinite(v)) return '';
  return String(Math.round(v * 1000) / 1000);
}
