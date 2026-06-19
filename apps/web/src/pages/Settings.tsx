import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from '@checklist/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import {
  FERMENT_DAYS,
  FERMENT_SG,
  KEG_OLD_DAYS,
  KEG_WARN_DAYS,
  clampStep,
  setSetting,
  useSettings,
  type PressureUnit,
} from '../settings';
import { homePath } from '../util';

/** Tap-stepper bounds for the keg-age alert threshold (server-backed setting). */
const KEG_ALERT_DAYS = { min: 7, max: 180, step: 1 } as const;

/**
 * Kiosk settings screen, reached from the gear button on the home hub. Built for
 * the touchscreen with no keyboard or mouse: every control is a big tap target —
 * a Bar/PSI toggle and −/+ steppers — so the brewer can tune the dashboard
 * standing at the Pi. Changes persist locally and take effect on the home hub
 * immediately (see [settings.ts]).
 */
export function SettingsPage(): JSX.Element {
  const settings = useSettings();

  return (
    <div className="touch-none-select flex h-full flex-col bg-black text-white">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-6 py-4">
        <Link
          to={homePath()}
          className="shrink-0 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-2xl leading-none transition active:bg-zinc-800"
          aria-label="Home"
        >
          ⌂
        </Link>
        <h1 className="py-1 text-3xl font-bold leading-normal tracking-tight">Settings</h1>
      </header>

      <main className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
        {/* Pressure unit ---------------------------------------------------- */}
        <SettingCard
          title="Pressure unit"
          hint="How the fermenter's pressure reading is shown on the home screen."
        >
          <SegmentedToggle<PressureUnit>
            value={settings.pressureUnit}
            options={[
              { value: 'bar', label: 'Bar' },
              { value: 'psi', label: 'PSI' },
            ]}
            onChange={(v) => setSetting('pressureUnit', v)}
          />
        </SettingCard>

        {/* Fermentation tuning --------------------------------------------- */}
        <SettingCard
          title="Fermentation complete"
          hint="When the gravity holds flat this long and within this spread, the fermenter is marked Complete."
        >
          <div className="flex flex-col gap-5">
            <Stepper
              label="Stable for"
              value={settings.fermentStableDays}
              format={(v) => `${formatDays(v)} ${v === 1 ? 'day' : 'days'}`}
              onStep={(dir) =>
                setSetting(
                  'fermentStableDays',
                  clampStep(settings.fermentStableDays + dir * FERMENT_DAYS.step, FERMENT_DAYS),
                )
              }
              canDecrease={settings.fermentStableDays > FERMENT_DAYS.min}
              canIncrease={settings.fermentStableDays < FERMENT_DAYS.max}
            />
            <Stepper
              label="Gravity spread"
              value={settings.fermentThresholdSg}
              format={(v) => `${v.toFixed(3)} SG`}
              onStep={(dir) =>
                setSetting(
                  'fermentThresholdSg',
                  clampStep(settings.fermentThresholdSg + dir * FERMENT_SG.step, FERMENT_SG),
                )
              }
              canDecrease={settings.fermentThresholdSg > FERMENT_SG.min}
              canIncrease={settings.fermentThresholdSg < FERMENT_SG.max}
            />
          </div>
        </SettingCard>

        {/* Keg freshness indicator ----------------------------------------- */}
        <SettingCard
          title="Keg freshness"
          hint="Shade a filled keg's date on the Keg Status page once it's been stored this long — amber first, then red."
        >
          <div className="flex flex-col gap-5">
            <Stepper
              label="Amber after"
              value={settings.kegWarnDays}
              format={(v) => `${v} ${v === 1 ? 'day' : 'days'}`}
              onStep={(dir) =>
                setSetting(
                  'kegWarnDays',
                  clampStep(settings.kegWarnDays + dir * KEG_WARN_DAYS.step, KEG_WARN_DAYS),
                )
              }
              canDecrease={settings.kegWarnDays > KEG_WARN_DAYS.min}
              canIncrease={settings.kegWarnDays < KEG_WARN_DAYS.max}
            />
            <Stepper
              label="Red after"
              value={settings.kegOldDays}
              format={(v) => `${v} ${v === 1 ? 'day' : 'days'}`}
              onStep={(dir) =>
                setSetting(
                  'kegOldDays',
                  clampStep(settings.kegOldDays + dir * KEG_OLD_DAYS.step, KEG_OLD_DAYS),
                )
              }
              canDecrease={settings.kegOldDays > KEG_OLD_DAYS.min}
              canIncrease={settings.kegOldDays < KEG_OLD_DAYS.max}
            />
          </div>
        </SettingCard>

        {/* Telegram notifications (server-backed) -------------------------- */}
        <NotificationSettingsCard />
      </main>
    </div>
  );
}

/**
 * Telegram alert preferences. Unlike the cards above (kiosk-local localStorage),
 * these are stored on the server — the background scheduler that sends the
 * alerts must see one shared value — so this card loads and saves over the API.
 * The Telegram bot token and chat id are server env vars, not edited here.
 */
function NotificationSettingsCard(): JSX.Element {
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

  // Apply a change optimistically and persist it (server is last-write-wins).
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
    <SettingCard
      title="Notifications"
      hint="Telegram alerts sent by the server. The bot token and chat are set on the server (env vars)."
    >
      {!settings ? (
        <p className="text-zinc-500">Loading…</p>
      ) : (
        <div className="flex flex-col gap-6">
          {/* Keg too old --------------------------------------------------- */}
          <div className="flex flex-col gap-5">
            <div className="flex items-center justify-between gap-4">
              <span className="text-lg text-zinc-300">Keg stored too long</span>
              <OnOffToggle
                value={settings.kegAlertEnabled}
                onChange={(v) => update({ kegAlertEnabled: v })}
              />
            </div>
            <Stepper
              label="Alert after"
              value={settings.kegAlertDays}
              format={(v) => `${v} ${v === 1 ? 'day' : 'days'}`}
              onStep={(dir) =>
                update({
                  kegAlertDays: clampStep(
                    settings.kegAlertDays + dir * KEG_ALERT_DAYS.step,
                    KEG_ALERT_DAYS,
                  ),
                })
              }
              canDecrease={settings.kegAlertDays > KEG_ALERT_DAYS.min}
              canIncrease={settings.kegAlertDays < KEG_ALERT_DAYS.max}
            />
          </div>

          {/* Fermentation complete --------------------------------------- */}
          <div className="flex items-center justify-between gap-4">
            <span className="text-lg text-zinc-300">Fermentation complete</span>
            <OnOffToggle
              value={settings.fermentDoneEnabled}
              onChange={(v) => update({ fermentDoneEnabled: v })}
            />
          </div>

          {/* Test send ---------------------------------------------------- */}
          <div className="flex items-center justify-between gap-4 border-t border-zinc-800 pt-5">
            <span className="text-sm leading-snug text-zinc-500">
              {test === 'sent'
                ? 'Sent — check Telegram.'
                : test === 'error'
                  ? 'Send failed — is the server configured?'
                  : 'Send a test message now.'}
            </span>
            <button
              type="button"
              onClick={runTest}
              disabled={test === 'sending'}
              className="shrink-0 touch-manipulation rounded-2xl border border-zinc-800 bg-black px-5 py-3 text-lg font-semibold text-zinc-200 transition active:scale-[0.98] active:bg-zinc-800 disabled:opacity-40"
            >
              {test === 'sending' ? 'Sending…' : 'Send test'}
            </button>
          </div>
        </div>
      )}
    </SettingCard>
  );
}

/** A compact On/Off switch built on the segmented toggle, for boolean settings. */
function OnOffToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
}): JSX.Element {
  return (
    <div className="w-40 shrink-0">
      <SegmentedToggle<'on' | 'off'>
        value={value ? 'on' : 'off'}
        options={[
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ]}
        onChange={(v) => onChange(v === 'on')}
      />
    </div>
  );
}

/** Drop trailing ".0" so half-days read "2 days" / "1.5 days". */
function formatDays(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** A titled section card with optional helper text, holding one group of controls. */
function SettingCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950 p-6">
      <h2 className="text-xl font-bold tracking-tight">{title}</h2>
      {hint && <p className="mt-1 text-sm leading-snug text-zinc-500">{hint}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** A two-or-more option pick rendered as full-width segmented buttons. */
function SegmentedToggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <div className="flex gap-2">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={`flex-1 touch-manipulation rounded-2xl py-4 text-2xl font-semibold transition active:scale-[0.98] ${
              active
                ? 'bg-blue-600 text-white'
                : 'border border-zinc-800 bg-black text-zinc-300 active:bg-zinc-800'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A labelled value with big −/+ buttons either side — keyboard-free numeric entry. */
function Stepper({
  label,
  value,
  format,
  onStep,
  canDecrease,
  canIncrease,
}: {
  label: string;
  value: number;
  format: (value: number) => string;
  onStep: (dir: -1 | 1) => void;
  canDecrease: boolean;
  canIncrease: boolean;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-lg text-zinc-300">{label}</span>
      <div className="flex items-center gap-3">
        <StepButton symbol="−" label={`Decrease ${label}`} onClick={() => onStep(-1)} disabled={!canDecrease} />
        <span className="min-w-[7rem] text-center text-2xl font-semibold tabular-nums">
          {format(value)}
        </span>
        <StepButton symbol="+" label={`Increase ${label}`} onClick={() => onStep(1)} disabled={!canIncrease} />
      </div>
    </div>
  );
}

function StepButton({
  symbol,
  label,
  onClick,
  disabled,
}: {
  symbol: string;
  label: string;
  onClick: () => void;
  disabled: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="flex h-14 w-14 shrink-0 touch-manipulation items-center justify-center rounded-2xl border border-zinc-800 bg-black text-3xl font-bold leading-none text-zinc-200 transition active:scale-95 active:bg-zinc-800 disabled:opacity-30"
    >
      {symbol}
    </button>
  );
}
