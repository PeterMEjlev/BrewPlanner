import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Card, Metric, RawNumField, UnitSuffix } from '../components/CalcUi';
import { DashboardShell } from '../components/DashboardShell';
import { CarbonationIcon, DropletIcon, FlaskIcon, HydrometerIcon } from '../components/icons';
import { Select } from '../components/Select';
import {
  CARBONATION_GUIDELINES,
  carbonationPressure,
  correctedGravity,
  dilutedVolumeL,
  parseGravity,
  parseNumber,
} from '../tools';
import { WaterCalculator } from './WaterCalculator';

/**
 * Tools — the brewery's calculators under one roof, picked from a rail beside
 * them the way Settings picks its categories.
 *
 * The water calculator was a nav item of its own until the rig's own three
 * (dilution, hydrometer, carbonation — see BrewSystem 3.0's Tools screen) came
 * across and made a page of it. All four are client-side arithmetic with nothing
 * to save, so a read-only guest gets the lot.
 *
 * Which tool is showing lives in the path (`/tools/carbonation`) rather than in
 * component state: the recipe sheet hands the water calculator a target profile
 * as query params, so that one had to stay linkable, and a bookmarked calculator
 * is worth having anyway.
 */
type ToolId = 'water' | 'dilution' | 'hydrometer' | 'carbonation';

const TOOLS: {
  id: ToolId;
  label: string;
  description: string;
  Icon: (props: { className?: string }) => JSX.Element;
}[] = [
  {
    id: 'water',
    label: 'Water',
    description: 'Salt additions, mash pH, source profile',
    Icon: FlaskIcon,
  },
  {
    id: 'dilution',
    label: 'Dilution',
    description: 'Water to add to hit a lower gravity',
    Icon: DropletIcon,
  },
  {
    id: 'hydrometer',
    label: 'Hydrometer',
    description: 'Correct a reading for sample temperature',
    Icon: HydrometerIcon,
  },
  {
    id: 'carbonation',
    label: 'Carbonation',
    description: 'Regulator pressure for a target CO₂ level',
    Icon: CarbonationIcon,
  },
];

const DEFAULT_TOOL: ToolId = 'water';

export function ToolsPage(): JSX.Element {
  const { tool } = useParams<{ tool: string }>();
  const navigate = useNavigate();
  // The water calculator reads the recipe hand-off from here; carry it across a
  // tool switch so flicking to the carbonation tool and back doesn't drop the
  // profile a recipe sent over.
  const [params] = useSearchParams();

  const active = TOOLS.find((t) => t.id === tool)?.id ?? DEFAULT_TOOL;
  const search = params.toString();
  const show = (id: ToolId): void => {
    navigate({ pathname: `/tools/${id}`, search }, { replace: true });
  };

  return (
    <DashboardShell active="tools">
      {/* Wider than Settings: the water calculator carries a 30rem results
          column beside its inputs and wants the room at xl. */}
      <main className="w-full max-w-[1440px] px-5 py-5">
        <div className="grid gap-5 lg:grid-cols-[13rem_minmax(0,1fr)]">
          <aside className="lg:sticky lg:top-5 lg:self-start">
            {/* Phones get a dropdown; the rail below is a horizontal strip at
                sm and a column at lg. Same treatment as Settings. */}
            <label className="block sm:hidden">
              <span className="sr-only">Tool</span>
              <Select
                value={active}
                onChange={show}
                aria-label="Tool"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-100 outline-none transition focus:border-[#f87a68]"
                options={TOOLS.map((t) => ({
                  value: t.id,
                  label: t.label,
                  description: t.description,
                }))}
              />
            </label>

            <nav
              aria-label="Tools"
              role="tablist"
              className="hidden gap-2 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900 p-2 sm:flex lg:flex-col lg:overflow-visible"
            >
              {TOOLS.map((t) => {
                const selected = t.id === active;
                return (
                  <button
                    key={t.id}
                    id={`tool-tab-${t.id}`}
                    type="button"
                    role="tab"
                    aria-controls="tool-panel"
                    aria-selected={selected}
                    onClick={() => show(t.id)}
                    className={`min-w-44 rounded-lg border px-3 py-2 text-left transition lg:min-w-0 ${
                      selected
                        ? 'border-[#f87a68] bg-gradient-to-br from-[#f87a68]/25 to-[#e0463f]/25 text-zinc-50'
                        : 'border-transparent text-zinc-400 hover:border-zinc-800 hover:bg-zinc-950 hover:text-zinc-200'
                    }`}
                  >
                    <span className="flex items-start gap-2.5">
                      {/* Left at currentColor rather than the accent gradient
                          the main sidebar's active icon uses: the selected
                          button here is already painted in the accent, and an
                          accent icon on top of it stopped reading as an icon. */}
                      <t.Icon className="mt-0.5 h-5 w-5 shrink-0" />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold">{t.label}</span>
                        <span className="mt-0.5 block text-xs leading-snug text-zinc-500">
                          {t.description}
                        </span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </nav>
          </aside>

          {/* Only the chosen tool is mounted. Unlike Settings — which keeps
              every panel rendered and hides the inactive ones — a calculator
              holds a form the brewer has filled in, and each already persists
              what's worth keeping (the water one to localStorage, the rest are
              a few seconds of typing). */}
          <section
            id="tool-panel"
            role="tabpanel"
            aria-labelledby={`tool-tab-${active}`}
            className="min-w-0"
          >
            {active === 'water' && <WaterCalculator />}
            {active === 'dilution' && <DilutionCalculator />}
            {active === 'hydrometer' && <HydrometerCalculator />}
            {active === 'carbonation' && <CarbonationCalculator />}
          </section>
        </div>
      </main>
    </DashboardShell>
  );
}

// --- Dilution ---------------------------------------------------------------

/**
 * Wort came out stronger than planned: how much water brings it to the gravity
 * the recipe wanted, and what volume that leaves in the kettle.
 */
function DilutionCalculator(): JSX.Element {
  const [volume, setVolume] = usePersistedField('dilution.volume');
  const [current, setCurrent] = usePersistedField('dilution.current');
  const [desired, setDesired] = usePersistedField('dilution.desired');

  const volumeL = parseNumber(volume);
  const currentSg = parseGravity(current);
  const desiredSg = parseGravity(desired);
  const filled = volumeL != null && currentSg != null && desiredSg != null;

  // Only complain about the numbers once all three are there — a form that
  // scolds you mid-typing is worse than one that simply hasn't answered yet.
  let problem: string | null = null;
  if (filled) {
    if (volumeL <= 0) problem = 'Wort volume must be more than zero.';
    else if (currentSg <= 1 || desiredSg <= 1)
      problem = 'Both gravities must be above 1.000 — there is no sugar in water.';
    else if (desiredSg >= currentSg)
      problem = 'Diluting can only lower gravity: the desired figure must be below the current one.';
  }

  const newVolume =
    filled && !problem ? dilutedVolumeL(volumeL, currentSg, desiredSg) : null;

  return (
    <ToolLayout
      title="Dilution"
      hint="Water to add to bring wort down to a target gravity. Works in gravity points: the sugar in the kettle is fixed, so the volume rises in proportion."
      inputs={
        <>
          <ToolField label="Wort volume" unit="L">
            <RawNumField
              value={volume}
              onChange={setVolume}
              placeholder="20"
              ariaLabel="Wort volume in litres"
            />
          </ToolField>
          <ToolField label="Current gravity" hint="1.075 or 1075">
            <RawNumField
              value={current}
              onChange={setCurrent}
              placeholder="1.075"
              ariaLabel="Current gravity"
            />
          </ToolField>
          <ToolField label="Desired gravity" hint="1.050 or 1050">
            <RawNumField
              value={desired}
              onChange={setDesired}
              placeholder="1.050"
              ariaLabel="Desired gravity"
            />
          </ToolField>
        </>
      }
      problem={problem}
      results={
        newVolume != null ? (
          <>
            <Headline
              label="Water to add"
              value={(newVolume - volumeL!).toFixed(2)}
              unit="L"
              note={`Taking ${trim2(volumeL!)} L up to ${newVolume.toFixed(2)} L`}
            />
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Metric label="New volume" value={newVolume.toFixed(2)} unit="litres" />
              <Metric
                label="Gravity drop"
                value={`${Math.round((currentSg! - desiredSg!) * 1000)}`}
                unit="points"
              />
            </div>
            <p className="mt-3 text-xs leading-snug text-zinc-600">
              Add it cold and stir well before taking a confirming reading — a partly mixed kettle
              reads whatever the thief happened to scoop.
            </p>
          </>
        ) : null
      }
    />
  );
}

// --- Hydrometer -------------------------------------------------------------

/**
 * A hydrometer reads low in a warm sample. This is the correction, against the
 * calibration temperature printed on the instrument's own scale.
 */
function HydrometerCalculator(): JSX.Element {
  const [reading, setReading] = usePersistedField('hydrometer.reading');
  const [sample, setSample] = usePersistedField('hydrometer.sample');
  const [calibration, setCalibration] = usePersistedField('hydrometer.calibration', '20');

  const sg = parseGravity(reading);
  const sampleC = parseNumber(sample);
  const calibrationC = parseNumber(calibration);
  const filled = sg != null && sampleC != null && calibrationC != null;

  const corrected = filled ? correctedGravity(sg, sampleC, calibrationC) : null;
  const points = corrected == null ? 0 : Math.round((corrected - sg!) * 1000);

  return (
    <ToolLayout
      title="Hydrometer temperature adjustment"
      hint="What the reading would have been at the hydrometer's calibration temperature. Worth a couple of points on a sample pulled warm — enough to misjudge an efficiency."
      inputs={
        <>
          <ToolField label="Hydrometer reading" unit="SG" hint="1.020 or 1020">
            <RawNumField
              value={reading}
              onChange={setReading}
              placeholder="1.020"
              ariaLabel="Hydrometer reading"
            />
          </ToolField>
          <ToolField label="Sample temperature" unit="°C">
            <RawNumField
              value={sample}
              onChange={setSample}
              placeholder="27"
              ariaLabel="Sample temperature in Celsius"
            />
          </ToolField>
          <ToolField label="Calibration temperature" unit="°C" hint="Printed on the paper scale">
            <RawNumField
              value={calibration}
              onChange={setCalibration}
              placeholder="20"
              ariaLabel="Calibration temperature in Celsius"
            />
          </ToolField>
        </>
      }
      results={
        corrected != null ? (
          <>
            <Headline
              label="Corrected gravity"
              value={corrected.toFixed(3)}
              unit="SG"
              note={
                points === 0
                  ? 'Sample is at calibration temperature — nothing to correct'
                  : `${points > 0 ? '+' : ''}${points} point${Math.abs(points) === 1 ? '' : 's'} on the ${sg!.toFixed(3)} you read`
              }
            />
            <p className="mt-3 text-xs leading-snug text-zinc-600">
              Only valid for a hydrometer. A refractometer needs its own correction for alcohol, and
              a Tilt already reports at temperature.
            </p>
          </>
        ) : null
      }
    />
  );
}

// --- Carbonation ------------------------------------------------------------

/**
 * The regulator setting that holds a keg at a chosen CO₂ level, plus the
 * customary levels by style — tap a style to load the middle of its range.
 */
function CarbonationCalculator(): JSX.Element {
  const [volumes, setVolumes] = usePersistedField('carbonation.volumes');
  const [temp, setTemp] = usePersistedField('carbonation.temp');

  const v = parseNumber(volumes);
  const tempC = parseNumber(temp);
  const filled = v != null && tempC != null;

  const problem = filled && v <= 0 ? 'Volumes of CO₂ must be more than zero.' : null;
  const pressure = useMemo(
    () => (filled && !problem ? carbonationPressure(v, tempC) : null),
    [filled, problem, v, tempC],
  );

  return (
    <ToolLayout
      title="Carbonation"
      hint="Set the regulator here to carbonate a keg at this temperature — and leave it there afterwards, since the same pressure is what holds the CO₂ in."
      inputs={
        <>
          <ToolField label="Volumes of CO₂" hint="Pick a style below for a starting point">
            <RawNumField
              value={volumes}
              onChange={setVolumes}
              placeholder="2.4"
              ariaLabel="Volumes of CO2"
            />
          </ToolField>
          <ToolField label="Keg temperature" unit="°C">
            <RawNumField
              value={temp}
              onChange={setTemp}
              placeholder="3"
              ariaLabel="Keg temperature in Celsius"
            />
          </ToolField>
        </>
      }
      problem={problem}
      results={
        pressure ? (
          <>
            <Headline
              label="Regulator setting"
              value={pressure.bar.toFixed(2)}
              unit="bar"
              note={`${pressure.psi.toFixed(1)} PSI at ${trim2(tempC!)} °C`}
            />
            {/* A negative answer is a real result, not an error: the beer at
                this temperature already holds more than the target. */}
            {pressure.psi <= 0 && (
              <p className="mt-3 text-sm leading-snug text-amber-400">
                Below atmospheric — beer this cold already carries more than {trim2(v!)} volumes.
                Vent the keg and let it warm, or aim higher.
              </p>
            )}
            <p className="mt-3 text-xs leading-snug text-zinc-600">
              Cold beer holds far more CO₂ than warm, so this figure moves sharply with the fridge.
              Set-and-forget takes a week or so; shaking or high-pressure bursts get there sooner but
              want watching.
            </p>
          </>
        ) : null
      }
      extra={
        <Card title="By style" hint="Customary levels, in volumes of CO₂. Tap one to load the middle of its range.">
          <div className="divide-y divide-zinc-800/70">
            {CARBONATION_GUIDELINES.map(({ style, min, max }) => {
              const mid = Math.round(((min + max) / 2) * 10) / 10;
              return (
                <button
                  key={style}
                  type="button"
                  onClick={() => setVolumes(String(mid))}
                  className="flex w-full items-center justify-between gap-3 py-2 text-left transition hover:text-zinc-50"
                >
                  <span className="min-w-0 text-sm text-zinc-300">{style}</span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-zinc-400">
                    {min.toFixed(1)} – {max.toFixed(1)}
                  </span>
                </button>
              );
            })}
          </div>
        </Card>
      }
    />
  );
}

// --- Shared shape of a calculator -------------------------------------------

/**
 * The layout every tool on this page shares: a card of inputs on the left, the
 * answer in a sticky card on the right — the same two-column arrangement the
 * water calculator uses, at the smaller scale these three need.
 *
 * `results` is null until the form has enough in it to answer, which is what
 * makes recomputing-as-you-type bearable: an empty form says what it needs
 * rather than showing a confident 0.00.
 */
function ToolLayout({
  title,
  hint,
  inputs,
  problem,
  results,
  extra,
}: {
  title: string;
  hint: string;
  inputs: React.ReactNode;
  /** Set once the fields are filled but say something impossible. */
  problem?: string | null;
  results: React.ReactNode;
  /** An optional second card under the results (the style table). */
  extra?: React.ReactNode;
}): JSX.Element {
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_26rem]">
      <div className="space-y-5">
        <Card title={title} hint={hint}>
          <div className="grid gap-4 sm:grid-cols-2">{inputs}</div>
          {problem && <p className="mt-4 text-sm leading-snug text-amber-400">{problem}</p>}
        </Card>
      </div>

      <div className="space-y-5 xl:sticky xl:top-5 xl:self-start">
        <Card title="Result">
          {results ?? (
            <p className="text-sm text-zinc-400">
              Fill in the fields — the answer updates as you type.
            </p>
          )}
        </Card>
        {extra}
      </div>
    </div>
  );
}

/** A labelled input with an optional unit suffix and hint, in the inputs grid. */
function ToolField({
  label,
  hint,
  unit,
  children,
}: {
  label: string;
  hint?: string;
  unit?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-zinc-200">{label}</span>
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
      <span className="mt-1 flex items-center">
        {children}
        {unit && <UnitSuffix>{unit}</UnitSuffix>}
      </span>
    </label>
  );
}

/** The one number the brewer came for, with the reading it came from beneath. */
function Headline({
  label,
  value,
  unit,
  note,
}: {
  label: string;
  value: string;
  unit: string;
  note: string;
}): JSX.Element {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums text-zinc-50">{value}</span>
        <span className="text-sm text-zinc-400">{unit}</span>
      </div>
      <p className="mt-1 text-sm text-zinc-500">{note}</p>
    </div>
  );
}

/**
 * A text field whose contents survive leaving the page, kept per browser like
 * the water calculator's state. Brewers reach for the same tool twice in a
 * session (before and after the addition), and retyping the keg temperature
 * every time is the sort of small friction that sends people back to a website.
 *
 * The field is text rather than a number so it can hold a half-typed entry, and
 * writing straight through on every keystroke keeps that honest — no effect, so
 * nothing to get out of step with what's on screen.
 */
function usePersistedField(key: string, initial = ''): [string, (value: string) => void] {
  const storageKey = `brewplanner.tools.${key}`;
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(storageKey) ?? initial;
    } catch {
      return initial;
    }
  });
  const set = (next: string): void => {
    setValue(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // Per-browser convenience only — fine to lose if storage is unavailable.
    }
  };
  return [value, set];
}

/** Two decimals, but only when it needs them ("20" not "20.00"). */
function trim2(v: number): string {
  return String(Math.round(v * 100) / 100);
}
