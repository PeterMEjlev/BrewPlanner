import {
  DEFAULT_GRAPH_COLORS,
  DEFAULT_NOTIFICATION_SETTINGS,
  type GraphColors,
  type KegContentColors,
  type NotificationSettings,
} from '@checklist/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { DashboardShell } from '../components/DashboardShell';
import { resetGraphColors, saveGraphColors, useGraphColors } from '../graphColors';
import {
  resetKegContentColors,
  saveKegContentColors,
  useKegContentColors,
} from '../kegContentColors';
import {
  FERMENT_DAYS,
  FERMENT_SG,
  REFRESH_SEC_OPTIONS,
  clampStep,
  resetSettings,
  setSetting,
  useSettings,
  type PressureUnit,
} from '../settings';
import { asMessage } from '../util';

/**
 * Desktop Settings — the mouse-and-keyboard counterpart to the kiosk's touch
 * Settings screen ([Settings.tsx]). It wraps the kiosk's options in the desktop
 * shell with compact form controls, and adds settings that only make sense with
 * a keyboard: account (username/password) changes and the shared graph-colour
 * palette. The per-browser display prefs (pressure unit, refresh, fermentation
 * tuning) match the kiosk's localStorage store, so editing them here only
 * affects this browser; notifications and colours are server-shared.
 */
export function SettingsDesktopPage(): JSX.Element {
  return (
    <DashboardShell active="settings">
      <main className="mx-auto max-w-3xl px-5 py-6">
        <div className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-zinc-50">Settings</h1>
          <p className="mt-0.5 text-sm text-zinc-500">
            Tune the dashboard for this computer, plus the shared graph colours and your account.
          </p>
        </div>

        <div className="space-y-5">
          <DisplaySection />
          <FermentationSection />
          <GraphColorsSection />
          <KegContentColorsSection />
          <NotificationsSection />
          <AccountSection />
          <ResetSection />
        </div>
      </main>
    </DashboardShell>
  );
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
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium text-zinc-200">{label}</div>
        {hint && <div className="text-xs text-zinc-500">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
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
              active ? 'bg-blue-600 text-white' : 'text-zinc-300 hover:bg-zinc-800'
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
  'rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none transition focus:border-blue-500';

const btnPrimary =
  'rounded-lg bg-blue-600 px-3.5 py-1.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-40';
const btnGhost =
  'rounded-lg border border-zinc-700 px-3.5 py-1.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-40';

// --- Display ---------------------------------------------------------------

function DisplaySection(): JSX.Element {
  const { pressureUnit, dashboardRefreshSec } = useSettings();
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
        <Row label="Dashboard refresh" hint="How often the Overview re-polls device status.">
          <Segmented<number>
            value={dashboardRefreshSec}
            options={REFRESH_SEC_OPTIONS.map((s) => ({ value: s, label: `${s}s` }))}
            onChange={(v) => setSetting('dashboardRefreshSec', v)}
          />
        </Row>
      </div>
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

  const save = async (): Promise<void> => {
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
        {KEG_CONTENT_COLOR_FIELDS.map((f) => (
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
