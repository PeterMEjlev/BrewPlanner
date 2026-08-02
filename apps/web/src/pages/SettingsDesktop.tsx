import {
  DEFAULT_DEVICE_DATA_SOURCES,
  DEFAULT_GRAPH_COLORS,
  DEFAULT_NOTIFICATION_SETTINGS,
  REPORTING_INTERVAL_OPTIONS,
  SENSOR_CATALOG,
  type DeviceDataSource,
  type DeviceDataSources,
  type DeviceStatus,
  type GraphColors,
  type KegContentColors,
  type HostStatus,
  type NotificationSettings,
  type RecipeDefaults,
  type User,
  type UserRole,
} from '@checklist/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type BrewSystemUpdateStatus, type SystemUpdateStatus } from '../api';
import { useAuth } from '../auth';
import { DashboardShell } from '../components/DashboardShell';
import { Select } from '../components/Select';
import { BATCH_TARGETS, PITCH_RATES } from '../recipeCatalog';
import {
  resetRecipeDefaults,
  saveRecipeDefaults,
  useRecipeDefaults,
} from '../recipeDefaults';
import { useHosts } from '../useDeviceData';
import { usePoll } from '../usePoll';
import { resetGraphColors, saveGraphColors, useGraphColors } from '../graphColors';
import {
  resetKegContentColors,
  saveKegContentColors,
  useKegContentColors,
} from '../kegContentColors';
import {
  DASHBOARD_ZOOM,
  FERMENT_DAYS,
  FERMENT_SG,
  KEG_OLD_DAYS,
  KEG_WARN_DAYS,
  TEMP_MIN_SPAN,
  clampStep,
  resetSettings,
  setSetting,
  useSettings,
  type PressureUnit,
} from '../settings';
import { asMessage, dateTime } from '../util';

/**
 * Desktop Settings — the mouse-and-keyboard counterpart to the kiosk's touch
 * Settings screen ([Settings.tsx]). It wraps the kiosk's options in the desktop
 * shell with compact form controls, and adds settings that only make sense with
 * a keyboard: account (username/password) changes and the shared graph-colour
 * palette. The per-browser display prefs (pressure unit, refresh, fermentation
 * tuning) match the kiosk's localStorage store, so editing them here only
 * affects this browser; notifications and colours are server-shared.
 */
type SettingsCategoryId =
  | 'dashboard'
  | 'sensors'
  | 'recipes'
  | 'colours'
  | 'notifications'
  | 'account'
  | 'accounts'
  | 'maintenance';

const SETTINGS_CATEGORIES: {
  id: SettingsCategoryId;
  label: string;
  description: string;
}[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    description: 'Local display and fermentation tuning',
  },
  {
    id: 'sensors',
    label: 'Sensors',
    description: 'Data source and logging interval per sensor',
  },
  {
    id: 'recipes',
    label: 'Recipes',
    description: 'What a new brew sheet starts from',
  },
  {
    id: 'colours',
    label: 'Colours',
    description: 'Shared graph and keg palettes',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Server-side Telegram alerts',
  },
  {
    id: 'account',
    label: 'Account',
    description: 'Your username and password',
  },
  {
    id: 'accounts',
    label: 'Accounts',
    description: 'Add, remove, and set privileges',
  },
  {
    id: 'maintenance',
    label: 'Maintenance',
    description: 'Restore default preferences',
  },
];

export function SettingsDesktopPage(): JSX.Element {
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>('dashboard');
  const active = SETTINGS_CATEGORIES.find((category) => category.id === activeCategory)!;

  return (
    <DashboardShell active="settings">
      <main className="w-full max-w-6xl px-5 py-6">
        <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <aside className="lg:sticky lg:top-6 lg:self-start">
            {/* Phones get a compact dropdown — the horizontal button rail below
                is too wide to scroll comfortably on a narrow screen. */}
            <label className="block sm:hidden">
              <span className="sr-only">Settings category</span>
              <Select
                value={activeCategory}
                onChange={setActiveCategory}
                aria-label="Settings category"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-100 outline-none transition focus:border-[#f87a68]"
                options={SETTINGS_CATEGORIES.map((category) => ({
                  value: category.id,
                  label: category.label,
                  description: category.description,
                }))}
              />
            </label>

            <nav
              aria-label="Settings categories"
              role="tablist"
              className="hidden gap-2 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900 p-2 sm:flex lg:flex-col lg:overflow-visible"
            >
              {SETTINGS_CATEGORIES.map((category) => {
                const selected = category.id === activeCategory;

                return (
                  <button
                    key={category.id}
                    type="button"
                    aria-controls={`settings-panel-${category.id}`}
                    aria-selected={selected}
                    onClick={() => setActiveCategory(category.id)}
                    role="tab"
                    className={`min-w-44 rounded-lg border px-3 py-2 text-left transition lg:min-w-0 ${
                      selected
                        ? 'border-[#f87a68] bg-gradient-to-br from-[#f87a68]/25 to-[#e0463f]/25 text-zinc-50'
                        : 'border-transparent text-zinc-400 hover:border-zinc-800 hover:bg-zinc-950 hover:text-zinc-200'
                    }`}
                  >
                    <span className="block text-sm font-semibold">{category.label}</span>
                    <span className="mt-0.5 block text-xs leading-snug text-zinc-500">
                      {category.description}
                    </span>
                  </button>
                );
              })}
            </nav>
          </aside>

          {/* The heading that used to sit here repeated the selected category
              verbatim — label and description both — from the rail beside it
              (and from the phone dropdown), so the panel is labelled for
              screen readers instead of titled on screen. */}
          <section aria-label={active.label} className="min-w-0">
            {SETTINGS_CATEGORIES.map((category) => (
              <div
                key={category.id}
                id={`settings-panel-${category.id}`}
                role="tabpanel"
                hidden={category.id !== activeCategory}
                className="space-y-5"
              >
                {renderSettingsCategory(category.id)}
              </div>
            ))}
          </section>
        </div>
      </main>
    </DashboardShell>
  );
}

function renderSettingsCategory(category: SettingsCategoryId): React.ReactNode {
  switch (category) {
    case 'dashboard':
      return (
        <>
          <DisplaySection />
          <FermentationSection />
          <KegFreshnessSection />
        </>
      );
    case 'sensors':
      return (
        <>
          <DataSourcesSection />
          <LoggingIntervalSection />
        </>
      );
    case 'recipes':
      return <RecipeDefaultsSection />;
    case 'colours':
      return (
        <>
          <GraphColorsSection />
          <KegContentColorsSection />
        </>
      );
    case 'notifications':
      return <NotificationsSection />;
    case 'account':
      return <AccountSection />;
    case 'accounts':
      return <AccountsSection />;
    case 'maintenance':
      return (
        <>
          <SoftwareUpdateSection />
          <BrewSystemUpdateSection />
          <ResetSection />
        </>
      );
  }
}

// --- Shared layout primitives ----------------------------------------------

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
      {hint && <p className="mt-1 text-sm leading-snug text-zinc-500">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** A labelled control row: label on the left, control on the right. */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col items-start gap-2 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-zinc-200">{label}</div>
        {hint && <div className="text-xs text-zinc-500">{hint}</div>}
      </div>
      <div className="max-w-full shrink-0">{children}</div>
    </div>
  );
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <div className="inline-flex rounded-lg border border-zinc-700 p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
              active
                ? 'bg-gradient-to-br from-[#f87a68] to-[#e0463f] text-white shadow'
                : 'text-zinc-300 hover:bg-zinc-800'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const inputClass =
  'rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none transition focus:border-[#f87a68]';

const btnPrimary =
  'rounded-lg bg-gradient-to-br from-[#f87a68] to-[#e0463f] px-3.5 py-1.5 text-sm font-semibold text-white shadow transition hover:brightness-110 disabled:opacity-40';
const btnGhost =
  'rounded-lg border border-zinc-700 px-3.5 py-1.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-40';

function EyeIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.88 9.88a3 3 0 0 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}

// --- Display ---------------------------------------------------------------

function DisplaySection(): JSX.Element {
  const { pressureUnit, dashboardZoom, tempMinSpanC } = useSettings();
  return (
    <Card title="Display" hint="Applies to this browser only — the kiosk and other computers keep their own.">
      <div className="divide-y divide-zinc-800/70">
        <Row label="Pressure unit" hint="How the fermenter pressure is shown.">
          <Segmented<PressureUnit>
            value={pressureUnit}
            options={[
              { value: 'bar', label: 'Bar' },
              { value: 'psi', label: 'PSI' },
            ]}
            onChange={(v) => setSetting('pressureUnit', v)}
          />
        </Row>
        <Row label="Dashboard zoom" hint="Scale the whole Overview up or down. It scrolls if it no longer fits.">
          <Stepper
            value={dashboardZoom}
            format={(v) => `${Math.round(v * 100)}%`}
            bounds={DASHBOARD_ZOOM}
            onChange={(v) => setSetting('dashboardZoom', v)}
            ariaLabel="Dashboard zoom"
          />
        </Row>
        <Row
          label="Temp chart min span"
          hint="Smallest range the temperature graphs show — sparklines and the charts they open — so a fridge holding within a fraction of a degree doesn't look like a big swing."
        >
          <Stepper
            value={tempMinSpanC}
            format={(v) => `${v.toFixed(1)} °C`}
            bounds={TEMP_MIN_SPAN}
            onChange={(v) => setSetting('tempMinSpanC', v)}
            ariaLabel="Temperature chart minimum span"
          />
        </Row>
      </div>
    </Card>
  );
}

/** Compact −/value/+ stepper for a clamped numeric setting (mouse-friendly). */
function Stepper({
  value,
  format,
  bounds,
  onChange,
  ariaLabel,
}: {
  value: number;
  format: (value: number) => string;
  bounds: { min: number; max: number; step: number };
  onChange: (value: number) => void;
  ariaLabel: string;
}): JSX.Element {
  const stepBtn =
    'flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700 text-lg font-semibold leading-none text-zinc-200 transition hover:bg-zinc-800 disabled:opacity-40';
  const step = (dir: -1 | 1): void => onChange(clampStep(value + dir * bounds.step, bounds));
  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        aria-label={`Decrease ${ariaLabel}`}
        className={stepBtn}
        disabled={value <= bounds.min}
        onClick={() => step(-1)}
      >
        −
      </button>
      <span className="w-14 text-center text-sm font-semibold tabular-nums text-zinc-100">
        {format(value)}
      </span>
      <button
        type="button"
        aria-label={`Increase ${ariaLabel}`}
        className={stepBtn}
        disabled={value >= bounds.max}
        onClick={() => step(1)}
      >
        +
      </button>
    </div>
  );
}

// --- Sensor data sources (server-shared) -----------------------------------

/**
 * Per-sensor choice of mock (demo) vs. actual (live agent) data. Server-backed
 * and shared across screens, so flipping a sensor to Actual here also changes
 * what the Pi kiosk shows. Each toggle saves immediately (last-write-wins), like
 * the notification settings. A sensor set to Actual that isn't reporting renders
 * as a greyed "not connected" tile on the dashboard and Device Fleet.
 */
function DataSourcesSection(): JSX.Element {
  const [sources, setSources] = useState<DeviceDataSources | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getDeviceSources()
      .then((s) => !cancelled && setSources(s))
      .catch(() => !cancelled && setSources(DEFAULT_DEVICE_DATA_SOURCES));
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (key: string, value: DeviceDataSource): void => {
    setSources((prev) => {
      if (!prev) return prev;
      const next = { ...prev, [key]: value };
      void api.updateDeviceSources(next).catch(() => {});
      return next;
    });
  };

  return (
    <Card
      title="Sensor data"
      hint="Show demo (mock) data or the real reading from each sensor. A sensor set to Actual but not connected greys out on the dashboard and Device Fleet."
    >
      {!sources ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <div className="divide-y divide-zinc-800/70">
          {SENSOR_CATALOG.map((s) => (
            <Row key={s.key} label={s.label} hint={s.hint}>
              <Segmented<DeviceDataSource>
                value={sources[s.key] ?? 'mock'}
                options={[
                  { value: 'mock', label: 'Mock' },
                  { value: 'real', label: 'Actual' },
                ]}
                onChange={(v) => update(s.key, v)}
              />
            </Row>
          ))}
        </div>
      )}
    </Card>
  );
}

// --- Logging interval (per device) -----------------------------------------

/**
 * Synthesized mock/placeholder devices use ids at/above this base (the server's
 * MOCK_ID_BASE) and have no agent, so their logging interval isn't editable.
 */
const MOCK_ID_BASE = 900_000;

const DEVICE_KIND_LABEL: Record<string, string> = {
  pressure_sensor: 'Pressure',
  brew_controller: 'Controller',
  power_meter: 'Power meter',
  water_meter: 'Water meter',
  hydrometer: 'Hydrometer',
  other: 'Sensor',
};

/** A cadence as "30s" / "5m" / "1h" for the interval picker. */
function intervalLabel(sec: number): string {
  if (sec < 90) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

function LoggingIntervalSection(): JSX.Element {
  const [devices, setDevices] = useState<DeviceStatus[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listDevices()
      .then((d) => !cancelled && setDevices(d))
      .catch(() => !cancelled && setDevices([]));
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (id: number, seconds: number): void => {
    setDevices(
      (prev) => prev?.map((d) => (d.id === id ? { ...d, reportingIntervalSec: seconds } : d)) ?? prev,
    );
    void api.setDeviceInterval(id, seconds).catch(() => {});
  };

  // Real (registered) devices only — mock sensors have no agent to honour it.
  const real = (devices ?? [])
    .filter((d) => d.id < MOCK_ID_BASE)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);

  return (
    <Card
      title="Logging interval"
      hint="How often each device logs a reading. Its sensor agent matches its push rate to this, and the dashboards poll it at the same cadence. Demo (mock) sensors aren't shown."
    >
      {!devices ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : real.length === 0 ? (
        <p className="text-sm text-zinc-500">No registered devices yet.</p>
      ) : (
        <div className="divide-y divide-zinc-800/70">
          {real.map((d) => {
            const options = Array.from(
              new Set<number>([...REPORTING_INTERVAL_OPTIONS, d.reportingIntervalSec]),
            ).sort((a, b) => a - b);
            return (
              <Row key={d.id} label={d.name} hint={DEVICE_KIND_LABEL[d.type] ?? d.type}>
                <Select
                  value={d.reportingIntervalSec}
                  aria-label={`Logging interval for ${d.name}`}
                  onChange={(seconds) => update(d.id, seconds)}
                  className={`${inputClass} tabular-nums`}
                  options={options.map((s) => ({ value: s, label: intervalLabel(s) }))}
                />
              </Row>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// --- Fermentation tuning ---------------------------------------------------

function FermentationSection(): JSX.Element {
  const { fermentStableDays, fermentThresholdSg } = useSettings();
  return (
    <Card
      title="Fermentation complete"
      hint="When the gravity holds flat this long and within this spread, the fermenter is marked Complete."
    >
      <div className="divide-y divide-zinc-800/70">
        <Row label="Stable for (days)">
          <input
            type="number"
            className={`${inputClass} w-28 text-right tabular-nums`}
            min={FERMENT_DAYS.min}
            max={FERMENT_DAYS.max}
            step={FERMENT_DAYS.step}
            value={fermentStableDays}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) setSetting('fermentStableDays', clampStep(n, FERMENT_DAYS));
            }}
          />
        </Row>
        <Row label="Gravity spread (SG)">
          <input
            type="number"
            className={`${inputClass} w-28 text-right tabular-nums`}
            min={FERMENT_SG.min}
            max={FERMENT_SG.max}
            step={FERMENT_SG.step}
            value={fermentThresholdSg}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) setSetting('fermentThresholdSg', clampStep(n, FERMENT_SG));
            }}
          />
        </Row>
      </div>
    </Card>
  );
}

// --- Keg freshness indicator -----------------------------------------------

function KegFreshnessSection(): JSX.Element {
  const { kegWarnDays, kegOldDays } = useSettings();
  return (
    <Card
      title="Keg freshness indicator"
      hint="Shade a filled keg's date on the Kegs page once it's been stored this long — amber past the first mark, red past the second. A local cue, separate from the Telegram keg-age alert."
    >
      <div className="divide-y divide-zinc-800/70">
        <Row label="Amber after (days)" hint="Worth keeping an eye on (≈2 months by default).">
          <input
            type="number"
            className={`${inputClass} w-28 text-right tabular-nums`}
            min={KEG_WARN_DAYS.min}
            max={KEG_WARN_DAYS.max}
            step={KEG_WARN_DAYS.step}
            value={kegWarnDays}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) setSetting('kegWarnDays', clampStep(n, KEG_WARN_DAYS));
            }}
          />
        </Row>
        <Row label="Red after (days)" hint="Likely past its best (≈6 months by default).">
          <input
            type="number"
            className={`${inputClass} w-28 text-right tabular-nums`}
            min={KEG_OLD_DAYS.min}
            max={KEG_OLD_DAYS.max}
            step={KEG_OLD_DAYS.step}
            value={kegOldDays}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) setSetting('kegOldDays', clampStep(n, KEG_OLD_DAYS));
            }}
          />
        </Row>
      </div>
    </Card>
  );
}

// --- New recipe defaults (server-shared) ------------------------------------

/** The keys of {@link RecipeDefaults} that hold a number, for the fields below. */
type NumericRecipeDefault = {
  [K in keyof RecipeDefaults]: RecipeDefaults[K] extends number ? K : never;
}[keyof RecipeDefaults];

const RECIPE_DEFAULT_FIELDS: {
  key: NumericRecipeDefault;
  label: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
}[] = [
  { key: 'batchSizeL', label: 'Batch size (L)', hint: 'What ends up in the fermenter.', min: 0.5, max: 100_000, step: 0.5 },
  { key: 'boilTimeMinutes', label: 'Boil time (min)', min: 0, max: 1_000, step: 5 },
  { key: 'efficiencyPercent', label: 'Brewhouse efficiency (%)', hint: 'What the mash is expected to extract.', min: 1, max: 100, step: 1 },
  { key: 'boilOffLPerHour', label: 'Boil-off rate (L/h)', hint: 'With the boil time, this sets the pre-boil volume.', min: 0, max: 1_000, step: 0.5 },
  { key: 'trubChillerLossL', label: 'Trub & chiller loss (L)', hint: 'Left behind in the kettle, so the post-boil volume covers it.', min: 0, max: 10_000, step: 0.5 },
  { key: 'mashThicknessLPerKg', label: 'Mash thickness (L/kg)', hint: 'Strike water per kilo of grain.', min: 0.1, max: 100, step: 0.1 },
  { key: 'mashStrikeTempC', label: 'Strike temperature (°C)', hint: 'What the water goes in at…', min: 0, max: 120, step: 0.5 },
  { key: 'mashTargetTempC', label: 'Mash temperature (°C)', hint: '…and what the mash settles to.', min: 0, max: 120, step: 0.5 },
  { key: 'mashStepMinutes', label: 'Mash rest (min)', min: 0, max: 1_000, step: 5 },
];

/**
 * The brewhouse a new recipe is written for. Server-shared, so the kiosk, a
 * laptop and the phone all open a blank sheet on the same numbers — and edited
 * only here, because they describe equipment rather than a screen.
 */
function RecipeDefaultsSection(): JSX.Element {
  const live = useRecipeDefaults();
  const [draft, setDraft] = useState<RecipeDefaults>(live);
  // Adopt the server's figures into the draft when they load — but never
  // clobber edits the user has started (tracked by `touched`).
  const [touched, setTouched] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!touched) setDraft(live);
  }, [live, touched]);

  const dirty = (Object.keys(live) as (keyof RecipeDefaults)[]).some((key) => draft[key] !== live[key]);

  const edit = <K extends keyof RecipeDefaults>(key: K, value: RecipeDefaults[K]): void => {
    setStatus('idle');
    setTouched(true);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const save = async (): Promise<void> => {
    setStatus('saving');
    setError(null);
    try {
      await saveRecipeDefaults(draft);
      setTouched(false);
      setStatus('saved');
    } catch (e) {
      setError(asMessage(e));
      setStatus('error');
    }
  };

  const reset = async (): Promise<void> => {
    setStatus('saving');
    setError(null);
    try {
      const next = await resetRecipeDefaults();
      setDraft(next);
      setTouched(false);
      setStatus('saved');
    } catch (e) {
      setError(asMessage(e));
      setStatus('error');
    }
  };

  return (
    <Card
      title="New recipe defaults"
      hint="The figures a blank brew sheet opens on, shared by every screen. Recipes already saved keep the numbers they were written with — changing these only moves the starting point."
    >
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        <Row label="Batch target" hint="Whether the batch size means the fermenter or the kettle.">
          <Select
            className={`${inputClass} w-44`}
            aria-label="Batch target"
            value={draft.batchTarget}
            onChange={(value) => edit('batchTarget', value)}
            options={optionsWith(BATCH_TARGETS, draft.batchTarget).map((value) => ({ value }))}
          />
        </Row>
        {RECIPE_DEFAULT_FIELDS.map((field) => (
          <Row key={field.key} label={field.label} hint={field.hint}>
            <input
              type="number"
              className={`${inputClass} w-28 text-right tabular-nums`}
              min={field.min}
              max={field.max}
              step={field.step}
              value={draft[field.key]}
              onChange={(e) => {
                const n = Number(e.target.value);
                // Clamped rather than rejected: the server validates the same
                // bounds, and a half-typed "0" shouldn't fail to save later.
                if (Number.isFinite(n)) {
                  edit(field.key, Math.min(field.max, Math.max(field.min, n)));
                }
              }}
            />
          </Row>
        ))}
        <Row label="Pitch rate" hint="Carried onto the yeast section of a new sheet.">
          <Select
            className={`${inputClass} w-56`}
            aria-label="Pitch rate"
            value={draft.pitchRate}
            onChange={(value) => edit('pitchRate', value)}
            options={optionsWith(PITCH_RATES, draft.pitchRate).map((value) => ({ value }))}
          />
        </Row>
      </div>

      <div className="mt-4 flex items-center gap-3 border-t border-zinc-800 pt-4">
        <button type="button" className={btnPrimary} onClick={() => void save()} disabled={!dirty || status === 'saving'}>
          {status === 'saving' ? 'Saving…' : 'Save defaults'}
        </button>
        <button
          type="button"
          className={btnGhost}
          onClick={() => void reset()}
          disabled={status === 'saving'}
        >
          Reset to defaults
        </button>
        <span className="text-sm text-zinc-500">
          {error ? (
            <span className="text-red-400">{error}</span>
          ) : status === 'saved' ? (
            'Saved.'
          ) : dirty ? (
            'Unsaved changes.'
          ) : (
            ''
          )}
        </span>
      </div>
    </Card>
  );
}

/**
 * A dropdown's options with the stored value included even when it isn't one of
 * them — a figure saved before the list changed stays selectable rather than
 * silently becoming the first entry.
 */
function optionsWith(values: readonly string[], current: string): string[] {
  return values.includes(current) ? [...values] : [current, ...values];
}

// --- Graph colours (server-shared) -----------------------------------------

const COLOR_FIELDS: { key: keyof GraphColors; label: string }[] = [
  { key: 'pressure', label: 'Pressure' },
  { key: 'beerTemp', label: 'Beer temperature' },
  { key: 'fridgeTemp', label: 'Fridge / ambient temp' },
  { key: 'setpoint', label: 'Target (setpoint)' },
  { key: 'gravity', label: 'Gravity' },
  { key: 'power', label: 'Power' },
  { key: 'water', label: 'Water' },
];

function GraphColorsSection(): JSX.Element {
  const live = useGraphColors();
  const [draft, setDraft] = useState<GraphColors>(live);
  // Adopt the server palette into the draft when it loads/changes — but never
  // clobber edits the user has started (tracked by `touched`).
  const [touched, setTouched] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!touched) setDraft(live);
  }, [live, touched]);

  const dirty = COLOR_FIELDS.some((f) => draft[f.key].toLowerCase() !== live[f.key].toLowerCase());

  const save = async (): Promise<void> => {
    setStatus('saving');
    setError(null);
    try {
      await saveGraphColors(draft);
      setTouched(false);
      setStatus('saved');
    } catch (e) {
      setError(asMessage(e));
      setStatus('error');
    }
  };

  const reset = async (): Promise<void> => {
    setStatus('saving');
    setError(null);
    try {
      const next = await resetGraphColors();
      setDraft(next);
      setTouched(false);
      setStatus('saved');
    } catch (e) {
      setError(asMessage(e));
      setStatus('error');
    }
  };

  return (
    <Card
      title="Graph colours"
      hint="The chart palette shared by every screen — changing it here also recolours the Pi kiosk's graphs."
    >
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {COLOR_FIELDS.map((f) => (
          <Row key={f.key} label={f.label}>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs uppercase tabular-nums text-zinc-500">
                {draft[f.key]}
              </span>
              <input
                type="color"
                aria-label={`${f.label} colour`}
                value={draft[f.key]}
                onChange={(e) => {
                  setStatus('idle');
                  setTouched(true);
                  setDraft((d) => ({ ...d, [f.key]: e.target.value }));
                }}
                className="h-8 w-12 cursor-pointer rounded-md border border-zinc-700 bg-transparent"
              />
            </div>
          </Row>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3 border-t border-zinc-800 pt-4">
        <button type="button" className={btnPrimary} onClick={() => void save()} disabled={!dirty || status === 'saving'}>
          {status === 'saving' ? 'Saving…' : 'Save colours'}
        </button>
        <button
          type="button"
          className={btnGhost}
          onClick={() => void reset()}
          disabled={status === 'saving'}
        >
          Reset to defaults
        </button>
        <span className="text-sm text-zinc-500">
          {error ? (
            <span className="text-red-400">{error}</span>
          ) : status === 'saved' ? (
            'Saved.'
          ) : dirty ? (
            'Unsaved changes.'
          ) : (
            ''
          )}
        </span>
      </div>
    </Card>
  );
}

// --- Keg content colours (server-shared) ------------------------------------

const KEG_CONTENT_COLOR_FIELDS: { key: keyof KegContentColors; label: string }[] = [
  { key: 'IPA', label: 'IPA' },
  { key: 'NEIPA', label: 'NEIPA' },
  { key: 'Wiessbeer', label: 'Wiessbeer' },
  { key: 'Sour', label: 'Sour' },
  { key: 'Brown Ale', label: 'Brown Ale' },
  { key: 'SIPA', label: 'SIPA' },
  { key: 'Pilsner', label: 'Pilsner' },
  { key: 'Stout', label: 'Stout' },
  { key: 'Starsan', label: 'Starsan' },
  { key: 'Dirty', label: 'Dirty' },
  { key: 'Clean', label: 'Clean' },
  { key: '???', label: 'Empty / unknown' },
];

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const BARE_HEX_COLOR_RE = /^[0-9a-fA-F]{6}$/;

function isHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value);
}

function KegContentColorsSection(): JSX.Element {
  const live = useKegContentColors();
  const [draft, setDraft] = useState<KegContentColors>(live);
  const [touched, setTouched] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!touched) setDraft(live);
  }, [live, touched]);

  const dirty = KEG_CONTENT_COLOR_FIELDS.some(
    (f) => draft[f.key].toLowerCase() !== live[f.key].toLowerCase(),
  );
  const hasInvalidHex = KEG_CONTENT_COLOR_FIELDS.some((f) => !isHexColor(draft[f.key]));

  const save = async (): Promise<void> => {
    if (hasInvalidHex) {
      setError('Use #rrggbb hex values before saving.');
      setStatus('error');
      return;
    }

    setStatus('saving');
    setError(null);
    try {
      await saveKegContentColors(draft);
      setTouched(false);
      setStatus('saved');
    } catch (e) {
      setError(asMessage(e));
      setStatus('error');
    }
  };

  const reset = async (): Promise<void> => {
    setStatus('saving');
    setError(null);
    try {
      const next = await resetKegContentColors();
      setDraft(next);
      setTouched(false);
      setStatus('saved');
    } catch (e) {
      setError(asMessage(e));
      setStatus('error');
    }
  };

  return (
    <Card
      title="Keg content colours"
      hint="The beer/type palette used by the keg inventory and the Garmin API endpoint."
    >
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {KEG_CONTENT_COLOR_FIELDS.map((f) => {
          const value = draft[f.key];
          const valid = isHexColor(value);

          return (
            <Row key={f.key} label={f.label}>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  aria-label={`${f.label} hex colour`}
                  aria-invalid={!valid}
                  autoComplete="off"
                  inputMode="text"
                  maxLength={7}
                  pattern="#[0-9a-fA-F]{6}"
                  spellCheck={false}
                  value={value}
                  onBlur={() => {
                    if (!BARE_HEX_COLOR_RE.test(value)) return;
                    setDraft((d) => ({ ...d, [f.key]: `#${value}` }));
                  }}
                  onChange={(e) => {
                    setStatus('idle');
                    setError(null);
                    setTouched(true);
                    setDraft((d) => ({ ...d, [f.key]: e.target.value.trim() }));
                  }}
                  className={`h-8 w-24 rounded-md border bg-zinc-950 px-2 font-mono text-xs uppercase tabular-nums outline-none transition focus:ring-2 focus:ring-amber-500/30 ${
                    valid
                      ? 'border-zinc-700 text-zinc-300 focus:border-amber-500'
                      : 'border-red-500 text-red-300 focus:border-red-400'
                  }`}
                />
                <input
                  type="color"
                  aria-label={`${f.label} colour`}
                  value={valid ? value : live[f.key]}
                  onChange={(e) => {
                    setStatus('idle');
                    setError(null);
                    setTouched(true);
                    setDraft((d) => ({ ...d, [f.key]: e.target.value }));
                  }}
                  className="h-8 w-12 cursor-pointer rounded-md border border-zinc-700 bg-transparent"
                />
              </div>
            </Row>
          );
        })}
      </div>

      <div className="mt-4 flex items-center gap-3 border-t border-zinc-800 pt-4">
        <button
          type="button"
          className={btnPrimary}
          onClick={() => void save()}
          disabled={!dirty || hasInvalidHex || status === 'saving'}
        >
          {status === 'saving' ? 'Savingâ€¦' : 'Save colours'}
        </button>
        <button
          type="button"
          className={btnGhost}
          onClick={() => void reset()}
          disabled={status === 'saving'}
        >
          Reset to defaults
        </button>
        <span className="text-sm text-zinc-500">
          {error ? (
            <span className="text-red-400">{error}</span>
          ) : status === 'saved' ? (
            'Saved.'
          ) : dirty ? (
            'Unsaved changes.'
          ) : (
            ''
          )}
        </span>
      </div>
    </Card>
  );
}

// --- Notifications (server-shared) -----------------------------------------

function NotificationsSection(): JSX.Element {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [test, setTest] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  useEffect(() => {
    let cancelled = false;
    api
      .getNotificationSettings()
      .then((s) => !cancelled && setSettings(s))
      .catch(() => !cancelled && setSettings(DEFAULT_NOTIFICATION_SETTINGS));
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (patch: Partial<NotificationSettings>): void => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      void api.updateNotificationSettings(next).catch(() => {});
      return next;
    });
  };

  const runTest = (): void => {
    setTest('sending');
    api
      .sendTestNotification()
      .then(() => setTest('sent'))
      .catch(() => setTest('error'));
  };

  return (
    <Card
      title="Notifications"
      hint="Telegram alerts sent by the server. The bot token and chat are set on the server (env vars)."
    >
      {!settings ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <div className="divide-y divide-zinc-800/70">
          <Row label="Keg stored too long" hint="Alert when a filled keg passes the age below.">
            <Segmented<'on' | 'off'>
              value={settings.kegAlertEnabled ? 'on' : 'off'}
              options={[
                { value: 'on', label: 'On' },
                { value: 'off', label: 'Off' },
              ]}
              onChange={(v) => update({ kegAlertEnabled: v === 'on' })}
            />
          </Row>
          <Row label="Alert after (days)">
            <input
              type="number"
              className={`${inputClass} w-28 text-right tabular-nums`}
              min={1}
              max={365}
              step={1}
              value={settings.kegAlertDays}
              disabled={!settings.kegAlertEnabled}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (Number.isFinite(n)) update({ kegAlertDays: Math.min(365, Math.max(1, n)) });
              }}
            />
          </Row>
          <Row label="Fermentation complete" hint="Alert when the Tilt's gravity has held flat.">
            <Segmented<'on' | 'off'>
              value={settings.fermentDoneEnabled ? 'on' : 'off'}
              options={[
                { value: 'on', label: 'On' },
                { value: 'off', label: 'Off' },
              ]}
              onChange={(v) => update({ fermentDoneEnabled: v === 'on' })}
            />
          </Row>
          <Row
            label="Test message"
            hint={
              test === 'sent'
                ? 'Sent — check Telegram.'
                : test === 'error'
                  ? 'Send failed — is the server configured?'
                  : 'Send a test alert now.'
            }
          >
            <button type="button" className={btnGhost} onClick={runTest} disabled={test === 'sending'}>
              {test === 'sending' ? 'Sending…' : 'Send test'}
            </button>
          </Row>
        </div>
      )}
    </Card>
  );
}

// --- Account (username / password) -----------------------------------------

function AccountSection(): JSX.Element {
  const { auth, refresh } = useAuth();

  if (!auth.user) {
    return (
      <Card title="Account">
        <p className="text-sm text-zinc-500">
          {auth.isLocal
            ? "You're signed in automatically on the local network, so there's no account to manage here. Open the dashboard through the remote (login) URL to change a username or password."
            : 'Sign in to manage your account.'}
        </p>
      </Card>
    );
  }

  return (
    <Card title="Account">
      <div className="space-y-6">
        <UsernameForm currentUsername={auth.user.username} onChanged={refresh} />
        <div className="border-t border-zinc-800" />
        <PasswordForm onChanged={refresh} />
      </div>
    </Card>
  );
}

/** Status line shared by both account forms. */
function FormStatus({ error, ok }: { error: string | null; ok: string | null }): JSX.Element | null {
  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (ok) return <p className="text-sm text-emerald-400">{ok}</p>;
  return null;
}

function UsernameForm({
  currentUsername,
  onChanged,
}: {
  currentUsername: string;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const [username, setUsername] = useState(currentUsername);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setOk(null);
    if (username.trim() === currentUsername) {
      setError('That is already your username.');
      return;
    }
    setBusy(true);
    try {
      await api.changeUsername(username.trim(), password);
      await onChanged();
      setPassword('');
      setOk('Username updated.');
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <h3 className="text-sm font-semibold text-zinc-200">Change username</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-500">New username</span>
          <input
            className={`${inputClass} w-full`}
            value={username}
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-500">Current password</span>
          <input
            type="password"
            className={`${inputClass} w-full`}
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" className={btnPrimary} disabled={busy || !username.trim() || !password}>
          {busy ? 'Saving…' : 'Update username'}
        </button>
        <FormStatus error={error} ok={ok} />
      </div>
    </form>
  );
}

function PasswordForm({ onChanged }: { onChanged: () => Promise<void> }): JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setOk(null);
    if (next.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (next !== confirm) {
      setError('New passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      await onChanged();
      setCurrent('');
      setNext('');
      setConfirm('');
      setOk('Password updated.');
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <h3 className="text-sm font-semibold text-zinc-200">Change password</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-500">Current password</span>
          <input
            type="password"
            className={`${inputClass} w-full`}
            value={current}
            autoComplete="current-password"
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-500">New password</span>
          <input
            type="password"
            className={`${inputClass} w-full`}
            value={next}
            autoComplete="new-password"
            onChange={(e) => setNext(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-500">Confirm new</span>
          <input
            type="password"
            className={`${inputClass} w-full`}
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          className={btnPrimary}
          disabled={busy || !current || !next || !confirm}
        >
          {busy ? 'Saving…' : 'Update password'}
        </button>
        <FormStatus error={error} ok={ok} />
      </div>
    </form>
  );
}

/** Strip the leading "<status>: " our api client prefixes onto error messages. */
function cleanError(err: unknown): string {
  const msg = asMessage(err);
  return msg.replace(/^\d{3}:\s*/, '');
}

// --- Accounts (admin: manage every login account) --------------------------

const ROLE_OPTIONS: { value: UserRole; label: string }[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'guest', label: 'Guest' },
];

/**
 * Admin-only roster of every login account. Only reachable here because the
 * Settings route is gated to controllers (admins + the local kiosk). Lets an
 * admin add or remove accounts, flip a role, or reset a password. The server
 * refuses to remove or demote the last admin; the UI additionally blocks acting
 * on your own row so you can't accidentally lock or demote yourself.
 */
function AccountsSection(): JSX.Element {
  const { auth } = useAuth();
  const [accounts, setAccounts] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setAccounts(await api.listAccounts());
      setError(null);
    } catch (e) {
      setError(cleanError(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: number, fn: () => Promise<unknown>): Promise<void> => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusyId(null);
    }
  };

  const changeRole = (u: User, role: UserRole): void => {
    if (role === u.role) return;
    void act(u.id, () => api.setAccountRole(u.id, role));
  };

  const resetPassword = (u: User): void => {
    const pw = window.prompt(`New password for "${u.username}" (at least 8 characters):`);
    if (pw == null) return; // cancelled
    if (pw.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    void act(u.id, () => api.setAccountPassword(u.id, pw));
  };

  const remove = (u: User): void => {
    if (!window.confirm(`Delete account "${u.username}"? This cannot be undone.`)) return;
    void act(u.id, () => api.deleteAccount(u.id));
  };

  return (
    <Card
      title="Accounts"
      hint="Every login account and its privilege. Admins can do everything; guests can view the dashboard and graphs but can't change anything or open the Brew System page."
    >
      <CreateAccountForm onCreated={load} onError={setError} />

      <div className="mt-6 border-t border-zinc-800 pt-4">
        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
        {!accounts ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="text-sm text-zinc-500">No accounts.</p>
        ) : (
          <ul className="divide-y divide-zinc-800/70">
            {accounts.map((u) => {
              const isSelf = auth.user?.id === u.id;
              const busy = busyId === u.id;
              return (
                <li key={u.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-zinc-100">
                      {u.username}
                      {isSelf && <span className="ml-2 text-xs text-zinc-500">(you)</span>}
                    </div>
                    <div className="text-xs text-zinc-500">
                      Added {new Date(u.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <Select
                    aria-label={`Role for ${u.username}`}
                    value={u.role}
                    disabled={busy || isSelf}
                    onChange={(role) => changeRole(u, role)}
                    className={`${inputClass} py-1 disabled:opacity-60`}
                    align="right"
                    options={ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                  />
                  <button
                    type="button"
                    onClick={() => resetPassword(u)}
                    disabled={busy}
                    className={btnGhost}
                  >
                    Reset password
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(u)}
                    disabled={busy || isSelf}
                    title={isSelf ? "You can't delete your own account here." : undefined}
                    className="rounded-lg border border-red-500/40 px-3.5 py-1.5 text-sm font-medium text-red-400 transition hover:bg-red-500/10 disabled:opacity-40"
                  >
                    Delete
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

function CreateAccountForm({
  onCreated,
  onError,
}: {
  onCreated: () => Promise<void>;
  onError: (msg: string | null) => void;
}): JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState<UserRole>('guest');
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    onError(null);
    setOk(null);
    if (!username.trim()) {
      onError('Username is required.');
      return;
    }
    if (password.length < 8) {
      onError('Password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      const name = username.trim();
      await api.createAccount(name, password, role);
      await onCreated();
      setUsername('');
      setPassword('');
      setRole('guest');
      setOk(`Account “${name}” created.`);
    } catch (err) {
      onError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <h3 className="text-sm font-semibold text-zinc-200">Add account</h3>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-500">Username</span>
          <input
            className={`${inputClass} w-full`}
            value={username}
            autoComplete="off"
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-500">Password</span>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              className={`${inputClass} w-full pr-9`}
              value={password}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute inset-y-0 right-0 flex items-center px-2.5 text-zinc-500 transition hover:text-zinc-300"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              title={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-500">Role</span>
          <Select
            className={`${inputClass} w-full`}
            aria-label="Role"
            value={role}
            onChange={setRole}
            options={ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          className={btnPrimary}
          disabled={busy || !username.trim() || password.length < 8}
        >
          {busy ? 'Adding…' : 'Add account'}
        </button>
        {ok && <span className="text-sm text-emerald-400">{ok}</span>}
      </div>
    </form>
  );
}

// --- Software update (remote deploy) ---------------------------------------

/**
 * How long the current run has been going, ticking every second, as "12s" or
 * "3m 04s". Null when nothing is running — a deploy that takes two minutes on a
 * Pi looks identical to a wedged one without this.
 */
function useElapsed(startedAt: string | undefined, running: boolean): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);

  if (!running || !startedAt) return null;
  const seconds = Math.floor((now - Date.parse(startedAt)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** The little ring that says work is still happening while the log is quiet. */
function Spinner(): JSX.Element {
  return (
    <span
      className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-400"
      aria-hidden
    />
  );
}

/**
 * The deploy's console output, live.
 *
 * Both update buttons run a shell script somewhere else and tail its output into
 * here, so a deploy is watchable rather than a spinner you have to trust. It
 * follows the tail as new output lands, unless you've scrolled up to read
 * something — then it leaves you where you are until you scroll back down.
 */
function UpdateConsole({
  log,
  running,
  label,
}: {
  log: string;
  running: boolean;
  /** What the header says while running, e.g. "Deploying to the brewing rig". */
  label: string;
}): JSX.Element | null {
  const bodyRef = useRef<HTMLPreElement>(null);
  const following = useRef(true);

  useEffect(() => {
    const body = bodyRef.current;
    if (body && following.current) body.scrollTop = body.scrollHeight;
  }, [log, running]);

  if (!log && !running) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-xs">
        {running && <Spinner />}
        <span className={running ? 'text-blue-400' : 'text-zinc-500'}>
          {running ? label : 'Last run'}
        </span>
      </div>
      <pre
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          // "At the bottom" with a few px of slack — a fractional scroll height
          // otherwise leaves it permanently one pixel short of following.
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="max-h-64 overflow-auto whitespace-pre-wrap p-3 text-xs leading-relaxed text-zinc-400"
      >
        {log.trimEnd() || 'Waiting for the first output…'}
      </pre>
    </div>
  );
}

/** One-line status pill for the current/last deploy. */
function UpdateStatusBadge({
  status,
  restarting,
  elapsed,
}: {
  status: SystemUpdateStatus | null;
  restarting: boolean;
  elapsed: string | null;
}): JSX.Element | null {
  if (restarting) return <span className="text-sm text-amber-400">Server restarting…</span>;
  if (!status || status.state === 'idle') return null;
  if (status.state === 'running') {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-blue-400">
        <Spinner />
        Update in progress…{elapsed ? ` (${elapsed})` : ''}
      </span>
    );
  }
  if (status.state === 'ok') {
    return (
      <span className="text-sm text-emerald-400">
        Updated
        {status.finishedAt ? ` ${dateTime(status.finishedAt)}` : ''}
        {status.commit ? ` (${status.commit})` : ''}.
      </span>
    );
  }
  return <span className="text-sm text-red-400">Update failed.</span>;
}

/**
 * Trigger a remote deploy (git pull + rebuild + restart on the Pi) and watch it.
 * The server restarts itself partway through, so polling tolerates the brief
 * window where it's unreachable, then confirms success once it's back.
 */
function SoftwareUpdateSection(): JSX.Element {
  const [status, setStatus] = useState<SystemUpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await api.getUpdateStatus());
      setRestarting(false);
    } catch {
      // The server bounces mid-deploy; a failed poll just means it's briefly
      // unreachable. Keep the last status and show "restarting" rather than error.
      setRestarting(true);
    }
  }, []);

  // Fetch once on mount; while a deploy runs, poll for progress (tolerating
  // the restart blip).
  usePoll(refresh, status?.state === 'running' ? 2500 : null, [refresh]);

  const running = status?.state === 'running';
  const elapsed = useElapsed(status?.startedAt, running);

  const start = async (): Promise<void> => {
    if (
      !window.confirm(
        'Deploy the latest pushed commit to the Pi?\n\n' +
          'It will pull from GitHub, rebuild, run migrations, and restart — the ' +
          'dashboard will be briefly unavailable while it restarts. Make sure you ' +
          'have committed and pushed your changes first.',
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.triggerUpdate());
      setRestarting(false);
    } catch (e) {
      setError(cleanError(e));
      void refresh(); // pick up the server-recorded failure detail, if any
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Software update"
      hint="Pull the latest pushed code onto the Pi, rebuild, and restart — no SSH needed. Commit and push your changes first; the Pi deploys from GitHub."
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={btnPrimary}
            onClick={() => void start()}
            disabled={busy || running}
          >
            {busy ? 'Starting…' : running ? 'Updating…' : 'Update now'}
          </button>
          <UpdateStatusBadge status={status} restarting={restarting} elapsed={elapsed} />
        </div>

        {status?.repoCommit && status.repoCommit !== 'unknown' && (
          <p className="text-xs text-zinc-500">
            Version on the Pi: <span className="font-mono text-zinc-300">{status.repoCommit}</span>
            {status.commitSubject ? ` — ${status.commitSubject}` : ''}
          </p>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}
        {status?.state === 'failed' && status.error && (
          <p className="text-sm text-red-400">{status.error}</p>
        )}

        <UpdateConsole log={status?.log ?? ''} running={running} label="Deploying to this Pi" />
      </div>
    </Card>
  );
}

// --- Brew system update (deploy to the rig) --------------------------------

/**
 * Deploy the latest pushed brew-system-v3 commit to the brewing rig.
 *
 * Simpler than {@link SoftwareUpdateSection}: this server stays up throughout,
 * so there's no restart blip to paper over. The interesting case is the refusal
 * — the server won't restart a rig that's heating or pumping, and says which
 * pot or pump is the problem.
 *
 * The progress reporting is deliberately identical to its sibling's, down to the
 * console: this one runs the longer job of the two (an npm install and a Vite
 * build on a Pi), so it's the one you're most likely to sit and watch.
 */
function BrewSystemUpdateSection(): JSX.Element {
  const [status, setStatus] = useState<BrewSystemUpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // What the rig is running right now, read live over SSH (the status file only
  // knows what the last deploy left behind — and there may never have been one).
  const hosts = useHosts();
  const rig = hosts.data?.find((h) => h.id === 'brewsystem') ?? null;

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await api.getBrewSystemUpdateStatus());
    } catch {
      // Transient — keep whatever we last showed.
    }
  }, []);

  // Poll faster than the dashboard's sibling: this log is the only thing moving
  // on screen for a couple of minutes.
  usePoll(refresh, status?.state === 'running' ? 1500 : null, [refresh]);

  const running = status?.state === 'running';
  const elapsed = useElapsed(status?.startedAt, running);
  const version = rigVersion(status, rig);

  const start = async (): Promise<void> => {
    if (
      !window.confirm(
        'Deploy the latest pushed commit to the brewing rig?\n\n' +
          'It will pull from GitHub, rebuild the rig UI, and restart the brew ' +
          'system service — which switches the heaters off. Only do this when ' +
          'you are not brewing.',
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.triggerBrewSystemUpdate());
    } catch (e) {
      setError(cleanError(e));
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Brew system update"
      hint="Pull the latest pushed brew-system-v3 code onto the brewing rig, rebuild its UI, and restart it. Refused while the rig is heating or pumping, since the restart cuts the elements."
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={btnPrimary}
            onClick={() => void start()}
            disabled={busy || running}
          >
            {busy ? 'Starting…' : running ? 'Updating rig…' : 'Update brew system'}
          </button>
          <BrewSystemUpdateBadge status={status} elapsed={elapsed} />
        </div>

        {version && (
          <p className="text-xs text-zinc-500">
            Version on the rig: <span className="font-mono text-zinc-300">{version.commit}</span>
            {version.subject ? ` — ${version.subject}` : ''}
          </p>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}
        {status?.state === 'failed' && status.error && (
          <p className="text-sm text-red-400">{status.error}</p>
        )}

        <UpdateConsole
          log={status?.log ?? ''}
          running={running}
          label="Deploying to the brewing rig"
        />
      </div>
    </Card>
  );
}

/**
 * What the rig is running, preferring what it says about itself (read live over
 * SSH) over what the last deploy recorded — which is missing entirely on a rig
 * that has never been updated from here.
 */
function rigVersion(
  status: BrewSystemUpdateStatus | null,
  host: HostStatus | null,
): { commit: string; subject: string | null } | null {
  if (host?.commit) return { commit: host.commit, subject: host.commitSubject };
  if (status?.commit && status.commit !== 'unknown') {
    return { commit: status.commit, subject: status.commitSubject ?? null };
  }
  return null;
}

/** One-line status pill for the current/last rig deploy. */
function BrewSystemUpdateBadge({
  status,
  elapsed,
}: {
  status: BrewSystemUpdateStatus | null;
  elapsed: string | null;
}): JSX.Element | null {
  if (!status || status.state === 'idle') return null;
  if (status.state === 'running') {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-blue-400">
        <Spinner />
        Update in progress…{elapsed ? ` (${elapsed})` : ''}
      </span>
    );
  }
  if (status.state === 'ok') {
    return (
      <span className="text-sm text-emerald-400">
        Updated
        {status.finishedAt ? ` ${dateTime(status.finishedAt)}` : ''}
        {status.commit ? ` (${status.commit})` : ''}.
      </span>
    );
  }
  return <span className="text-sm text-red-400">Update failed.</span>;
}

// --- Reset -----------------------------------------------------------------

function ResetSection(): JSX.Element {
  const [done, setDone] = useState(false);

  const reset = async (): Promise<void> => {
    if (!window.confirm('Reset display preferences and shared colour palettes to their defaults?')) return;
    resetSettings();
    try {
      await resetGraphColors();
      await resetKegContentColors();
    } catch {
      // Colours are server-side; ignore a failed reset (e.g. offline).
    }
    setDone(true);
    setTimeout(() => setDone(false), 3000);
  };

  return (
    <Card
      title="Reset"
      hint="Restore this browser's display preferences and the shared colour palettes to their defaults. Notifications and your account are left unchanged."
    >
      <div className="flex items-center gap-3">
        <button type="button" className={btnGhost} onClick={() => void reset()}>
          Reset display & colours
        </button>
        {done && <span className="text-sm text-emerald-400">Reset to defaults.</span>}
      </div>
    </Card>
  );
}
