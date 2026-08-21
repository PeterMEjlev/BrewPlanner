import type {
  AlertRuleInput,
  CustomAlertRule,
  CustomAlertSignal,
  CustomAlertTest,
  CustomAlertTestKind,
  DeviceStatus,
  RigPot,
} from '@checklist/shared';
import { RIG_POTS, RIG_POT_LABELS } from '@checklist/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { metricLabel } from '../pages/Dashboard';
import { TYPE_LABEL } from '../pages/Devices';
import { asCleanMessage } from '../util';
import { Select } from './Select';

/**
 * The brewer's own alert rules: watch this, tell me when it does that.
 *
 * The built-in alerts above this card answer the questions the hub already
 * knows to ask — has the fermenter lost pressure, is the keg fridge warm. This
 * card is for the ones only the brewer knows to ask, and the two examples that
 * shaped it are "the fermenter fridge is over 25 °C" and "the boil kettle has
 * reached 100". Those come from different places (a registered sensor and the
 * brewing rig, which is a separate Pi the hub polls), so picking *what* to
 * watch comes first and everything else follows from it.
 *
 * A rule is edited in a draft and saved explicitly, unlike the toggles above.
 * A half-written rule is a rule that would fire on the wrong thing, and
 * save-as-you-type would put several of those live on the way to the right one.
 */

/** What a brand-new rule opens on: a device rule with nothing chosen yet. */
const BLANK: AlertRuleInput = {
  enabled: true,
  name: '',
  signal: { kind: 'device', deviceId: 0, metric: '' },
  test: { kind: 'above', value: 0 },
  holdMinutes: 0,
};

const TEST_LABELS: Record<CustomAlertTestKind, string> = {
  above: 'Rises to or above',
  below: 'Falls to or below',
  equals: 'Is exactly',
  flat: "Hasn't moved by more than",
};

const inputClass =
  'rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none transition focus:border-[#f87a68]';
const selectClass = `${inputClass} text-left`;
const btnPrimary =
  'rounded-lg bg-gradient-to-br from-[#f87a68] to-[#e0463f] px-3.5 py-1.5 text-sm font-semibold text-white shadow transition hover:brightness-110 disabled:opacity-40';
const btnGhost =
  'rounded-lg border border-zinc-700 px-3.5 py-1.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-40';

/** The card, with its list of rules and one open editor at a time. */
export function CustomAlertRulesCard(): JSX.Element {
  const [rules, setRules] = useState<CustomAlertRule[] | null>(null);
  const [devices, setDevices] = useState<DeviceStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Which rule is open in the editor: a rule id, 'new', or nothing. */
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Whether this hub knows where the brewing rig is. A rig rule on a hub with no
   * BREW_SYSTEM_URL would never fire and never say why, which is the worst
   * failure an alert can have — so the editor says it up front.
   */
  const [rigConfigured, setRigConfigured] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.listAlertRules(), api.listDevices()])
      .then(([loaded, fleet]) => {
        if (cancelled) return;
        setRules(loaded);
        setDevices(fleet);
      })
      .catch((e: unknown) => !cancelled && setError(asCleanMessage(e)));
    // Separately, and quietly: the rig being unreachable is normal (it's off
    // between brew sessions) and must not turn the whole card into an error.
    void api
      .getBrewSystemState()
      .then((status) => !cancelled && setRigConfigured(status.configured))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function reload(): Promise<void> {
    setRules(await api.listAlertRules());
  }

  /** Run one mutation, keeping the list and any error message honest. */
  async function run(action: () => Promise<unknown>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    try {
      await action();
      await reload();
      setError(null);
      return true;
    } catch (e) {
      setError(asCleanMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(id: string | 'new', draft: AlertRuleInput): Promise<void> {
    const ok = await run(() =>
      id === 'new' ? api.createAlertRule(draft) : api.updateAlertRule(id, draft),
    );
    if (ok) setEditing(null);
  }

  async function remove(rule: CustomAlertRule): Promise<void> {
    if (!window.confirm(`Delete the alert rule “${rule.name}”? This cannot be undone.`)) return;
    const ok = await run(() => api.deleteAlertRule(rule.id));
    if (ok && editing === rule.id) setEditing(null);
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">Custom alerts</h2>
      <p className="mt-1 text-sm leading-snug text-zinc-500">
        Your own conditions, on top of the built-in ones — a sensor crossing a number you care
        about, or a brewing-rig pot reaching temperature. Each one is raised once when it starts,
        clears itself when the reading comes back, and goes to the phone as a critical alert.
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="mt-4">
        {rules == null ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : rules.length === 0 && editing !== 'new' ? (
          <p className="text-sm text-zinc-500">
            No custom alerts yet. Add one to be told when a reading crosses a line that matters to
            you.
          </p>
        ) : (
          <div className="divide-y divide-zinc-800/70">
            {rules.map((rule) =>
              editing === rule.id ? (
                <RuleEditor
                  key={rule.id}
                  devices={devices}
                  rigConfigured={rigConfigured}
                  initial={rule}
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSave={(draft) => save(rule.id, draft)}
                />
              ) : (
                <RuleRow
                  key={rule.id}
                  rule={rule}
                  devices={devices}
                  busy={busy}
                  onEdit={() => setEditing(rule.id)}
                  onToggle={(enabled) =>
                    run(() => api.updateAlertRule(rule.id, { ...toInput(rule), enabled }))
                  }
                  onDelete={() => remove(rule)}
                />
              ),
            )}
            {editing === 'new' && (
              <RuleEditor
                devices={devices}
                rigConfigured={rigConfigured}
                initial={BLANK}
                busy={busy}
                onCancel={() => setEditing(null)}
                onSave={(draft) => save('new', draft)}
              />
            )}
          </div>
        )}
      </div>

      {editing !== 'new' && (
        <button
          type="button"
          className={`${btnGhost} mt-4`}
          disabled={rules == null}
          onClick={() => setEditing('new')}
        >
          Add an alert
        </button>
      )}
    </section>
  );
}

/** A saved rule as one line: what it watches, and the switch that arms it. */
function RuleRow({
  rule,
  devices,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  rule: CustomAlertRule;
  devices: DeviceStatus[];
  busy: boolean;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className={`min-w-0 ${rule.enabled ? '' : 'opacity-50'}`}>
        <div className="truncate text-sm font-medium text-zinc-200">{rule.name}</div>
        <div className="text-xs leading-snug text-zinc-500">{summarise(rule, devices)}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          aria-pressed={rule.enabled}
          disabled={busy}
          onClick={() => onToggle(!rule.enabled)}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:opacity-40 ${
            rule.enabled
              ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
              : 'border border-zinc-700 text-zinc-400 hover:bg-zinc-800'
          }`}
        >
          {rule.enabled ? 'On' : 'Off'}
        </button>
        <button type="button" className={btnGhost} disabled={busy} onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onDelete}
          className="rounded-lg border border-red-500/30 px-3.5 py-1.5 text-sm font-medium text-red-300 transition hover:bg-red-500/10 disabled:opacity-40"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

/**
 * The editor for one rule. Laid out as the sentence it is — watch *this*, tell
 * me when it does *that*, once it has held for *this long* — because that is
 * how a brewer says it out loud, and a rule that reads back as a sentence is one
 * they can check at a glance.
 */
function RuleEditor({
  devices,
  rigConfigured,
  initial,
  busy,
  onCancel,
  onSave,
}: {
  devices: DeviceStatus[];
  /** Whether this hub is configured to reach the brewing rig at all. */
  rigConfigured: boolean;
  initial: AlertRuleInput;
  busy: boolean;
  onCancel: () => void;
  onSave: (draft: AlertRuleInput) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<AlertRuleInput>(initial);

  const set = (patch: Partial<AlertRuleInput>): void => setDraft((prev) => ({ ...prev, ...patch }));

  /**
   * Every device metric the fleet is actually reporting, as pickable options.
   *
   * A brewery names its sensors after where they are, so the fermenter's
   * controller, its pressure sensor and its Tilt are all called "Fermenter".
   * Where a name is shared the device's kind is added, because otherwise two
   * rows read identically and picking the right one is guesswork.
   */
  const deviceOptions = useMemo(() => {
    const seen = new Map<string, number>();
    for (const device of devices) seen.set(device.name, (seen.get(device.name) ?? 0) + 1);
    return devices.flatMap((device) => {
      const kind = (seen.get(device.name) ?? 0) > 1 ? ` (${TYPE_LABEL[device.type]})` : '';
      return device.latest.map((reading) => ({
        value: `${device.id}:${reading.metric}`,
        label: `${device.name}${kind} — ${metricLabel(reading.metric)}`,
      }));
    });
  }, [devices]);

  const signalValue =
    draft.signal.kind === 'rig'
      ? `rig:${draft.signal.pot}`
      : `${draft.signal.deviceId}:${draft.signal.metric}`;

  function pickSignal(value: string): void {
    const [head, tail] = value.split(':');
    if (head === 'rig') {
      set({ signal: { kind: 'rig', pot: tail as RigPot } });
      return;
    }
    set({ signal: { kind: 'device', deviceId: Number(head), metric: tail ?? '' } });
  }

  function pickTest(kind: CustomAlertTestKind): void {
    // The number carries over between the comparison kinds, which all mean a
    // threshold; "hasn't moved" measures a tolerance instead, so it starts fresh.
    const value = draft.test.kind === 'flat' ? 0 : draft.test.value;
    set({
      test: kind === 'flat' ? { kind, within: 0 } : ({ kind, value } as CustomAlertTest),
      // A "hasn't moved" rule is a question about a span of time, so give it one
      // rather than letting the server reject a window of zero.
      holdMinutes: kind === 'flat' && draft.holdMinutes < 1 ? 60 : draft.holdMinutes,
    });
  }

  const testNumber = draft.test.kind === 'flat' ? draft.test.within : draft.test.value;

  function setTestNumber(n: number): void {
    set({
      test:
        draft.test.kind === 'flat'
          ? { kind: 'flat', within: Math.max(0, n) }
          : ({ kind: draft.test.kind, value: n } as CustomAlertTest),
    });
  }

  const chosen = draft.signal.kind === 'rig' || draft.signal.metric !== '';
  const canSave = draft.name.trim().length > 0 && chosen && !busy;

  return (
    <div className="space-y-3 rounded-lg bg-black/25 px-3 py-3">
      <label className="block">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          Call it
        </span>
        <input
          type="text"
          className={`${inputClass} w-full`}
          placeholder="Boil kettle at temperature"
          maxLength={80}
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
        />
        <span className="mt-1 block text-[11px] text-zinc-600">
          This is the headline on the notification, so write what you'd want to read on your phone.
        </span>
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          Watch
        </span>
        <Select
          value={signalValue}
          onChange={pickSignal}
          aria-label="What to watch"
          className={`${selectClass} w-full`}
          options={[
            ...(chosen ? [] : [{ value: '0:', label: 'Choose a sensor…' }]),
            ...deviceOptions,
            ...RIG_POTS.map((pot) => ({
              value: `rig:${pot}`,
              label: `Brewing rig — ${RIG_POT_LABELS[pot]}`,
            })),
          ]}
        />
        {draft.signal.kind === 'rig' &&
          (rigConfigured ? (
            <span className="mt-1 block text-[11px] text-zinc-600">
              The rig is a separate machine the hub asks every minute. While it's powered off
              there's nothing to judge, so the rule simply waits.
            </span>
          ) : (
            <span className="mt-1 block text-[11px] text-amber-300/90">
              This hub doesn't know where the brewing rig is (no BREW_SYSTEM_URL is set), so a rule
              watching it can never fire.
            </span>
          ))}
      </label>

      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-[13rem] flex-1">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">
            Tell me when it
          </span>
          <Select
            value={draft.test.kind}
            onChange={(v) => pickTest(v as CustomAlertTestKind)}
            aria-label="Condition"
            className={`${selectClass} w-full`}
            options={(Object.keys(TEST_LABELS) as CustomAlertTestKind[]).map((kind) => ({
              value: kind,
              label: TEST_LABELS[kind],
            }))}
          />
        </label>
        <label>
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">
            {draft.test.kind === 'flat' ? 'Tolerance' : 'Value'}
          </span>
          <input
            type="number"
            inputMode="decimal"
            step="any"
            className={`${inputClass} w-28 text-right tabular-nums`}
            value={String(testNumber)}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) setTestNumber(n);
            }}
          />
        </label>
        <label>
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">
            {draft.test.kind === 'flat' ? 'Over' : 'For at least'}
          </span>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              inputMode="numeric"
              min={draft.test.kind === 'flat' ? 1 : 0}
              max={7 * 24 * 60}
              step="1"
              className={`${inputClass} w-24 text-right tabular-nums`}
              value={String(draft.holdMinutes)}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) set({ holdMinutes: Math.min(7 * 24 * 60, Math.max(0, n)) });
              }}
            />
            <span className="text-xs text-zinc-500">min</span>
          </div>
        </label>
      </div>

      <p className="text-[11px] leading-snug text-zinc-600">
        {draft.test.kind === 'flat'
          ? 'The reading has to stay inside that tolerance for the whole window before this counts as stopped.'
          : draft.holdMinutes > 0
            ? 'The condition has to hold for that long before you hear about it — and the opposite has to hold just as long before the alert clears, so a reading hovering on the line never flickers.'
            : 'Zero means the moment it happens, which is what you want for something like a kettle reaching boil.'}
      </p>

      <div className="flex items-center gap-2 pt-1">
        <button type="button" className={btnPrimary} disabled={!canSave} onClick={() => onSave({ ...draft, name: draft.name.trim() })}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className={btnGhost} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** A saved rule as the sentence it stands for, under its name in the list. */
function summarise(rule: CustomAlertRule, devices: DeviceStatus[]): string {
  const what = signalLabel(rule.signal, devices);
  const held =
    rule.holdMinutes > 0 ? ` for ${rule.holdMinutes >= 60 ? `${+(rule.holdMinutes / 60).toFixed(1)}h` : `${rule.holdMinutes} min`}` : '';
  if (rule.test.kind === 'flat') return `${what} hasn't moved by more than ${rule.test.within}${held}`;
  const verb =
    rule.test.kind === 'above' ? 'reaches' : rule.test.kind === 'below' ? 'falls to' : 'is exactly';
  return `${what} ${verb} ${rule.test.value}${held}`;
}

/** What a rule watches, in words — falling back to the ids when it's gone. */
function signalLabel(signal: CustomAlertSignal, devices: DeviceStatus[]): string {
  if (signal.kind === 'rig') return `Brewing rig ${RIG_POT_LABELS[signal.pot].toLowerCase()}`;
  const device = devices.find((d) => d.id === signal.deviceId);
  // A rule can outlive the device it watched; say so rather than showing a
  // sentence that reads as though it were still being checked against something.
  if (!device) return `A removed device (${metricLabel(signal.metric)})`;
  const shared = devices.filter((d) => d.name === device.name).length > 1;
  const kind = shared ? ` (${TYPE_LABEL[device.type]})` : '';
  return `${device.name}${kind} ${metricLabel(signal.metric).toLowerCase()}`;
}

/** A saved rule back to the shape the API takes, for a save that only toggles it. */
function toInput(rule: CustomAlertRule): AlertRuleInput {
  return {
    enabled: rule.enabled,
    name: rule.name,
    signal: rule.signal,
    test: rule.test,
    holdMinutes: rule.holdMinutes,
  };
}
