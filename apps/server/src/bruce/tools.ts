/**
 * What the text Bruce can look at and change in BrewPlanner.
 *
 * The books tell him how beer works and `get_recipe` tells him what this
 * brewery brews; this file is the rest of the hub — the fermenter, the sensor
 * fleet, the keg board, the to-do list and the settings. Without it the chat
 * on the dashboard is a librarian sitting in a brewery with its eyes shut: it
 * can explain what a stuck fermentation is, but not that yours is at 1.030 and
 * hasn't moved in three days.
 *
 * Everything reads the hub's own repositories directly rather than calling back
 * into the HTTP API. Chat runs *inside* the server (see chat.ts), so a loopback
 * request would only be this process asking itself, with a JSON round trip and
 * a second auth decision in the middle. The trade is that the audit hook — which
 * hangs off requests — never sees these changes, so every mutating tool records
 * its own entry. A change nobody can attribute afterwards is worse than no
 * change at all, and "Bruce did it" has to name who asked him.
 *
 * The voice assistant's equivalents live in apps/bruce/src/functions and *do*
 * go over HTTP, because that process is on the other side of a socket.
 */

import {
  CARBONATION_GUIDELINE_RANGES,
  DEFAULT_GRAPH_COLORS,
  EMPTIED_KEG_FIELDS,
  KEG_STATE_CONTENTS,
  REPORTING_INTERVAL_SEC,
  SENSOR_CATALOG,
  abvFromGravities,
  apparentAttenuation,
  carbonationPressure,
  correctedGravity,
  dilutedVolumeL,
  measuredEfficiency,
  type BrewSession,
  type BrewSessionDetail,
  type BrewSessionTempStats,
  type BrewPotControl,
  type BrewSystemState,
  type BrucePhase,
  type DeviceStatus,
  type GraphColors,
  type Keg,
  type KegContentColors,
  type MusicQueue,
  type MusicRepeat,
  type NowPlaying,
  type QueueTrack,
  type Reading,
  type RecipeDefaults,
  type Todo,
} from '@checklist/shared';
import { recordAudit } from '../audit/repo.js';
import { listAlerts } from '../alerts/repo.js';
import { getBrewSession, listBrewSessions } from '../brewSessions/repo.js';
import { readBrewSystemState, rigBase } from '../brewSystemClient.js';
import * as deviceFallback from '../devices/fallback.js';
import { setReportingInterval } from '../devices/repo.js';
import { KegWriteNotConfiguredError, fetchKegs, updateKeg } from '../kegs.js';
import * as repo from '../repo.js';
import * as recipeRepo from '../recipeRepo.js';
import * as sonos from '../sonos.js';
import { RECIPE_TOOL, matchRecipe, runRecipeTool } from './recipes.js';

/** Who is asking. Recorded against every change Bruce makes on their behalf. */
export interface BruceActor {
  userId: number | null;
  username: string;
}

/** The tool call as OpenAI hands it back, already parsed. */
type ToolArgs = Record<string, unknown>;

interface ToolSpec {
  /** The definition sent to the model, in Responses-API function-tool shape. */
  definition: Record<string, unknown>;
  /** The progress line shown on the Bruce page while this runs. */
  phase: (args: ToolArgs) => BrucePhase;
  /**
   * Answer the model reads back. Failures are text, never exceptions.
   *
   * `brief` is true when the answer is going to be spoken (see
   * {@link runBruceTool}). A tool with a long output must honour it: a model
   * handed an eight-row keg table will read out an eight-row keg table, whatever
   * its instructions say about being concise. The shortest way to make a spoken
   * answer short is not to hand it the long version.
   */
  run: (args: ToolArgs, actor: BruceActor, brief: boolean) => Promise<string> | string;
}

// ---------------------------------------------------------------------------
// Argument readers
// ---------------------------------------------------------------------------
//
// Tool arguments arrive as whatever the model decided to send. These narrow one
// field at a time and return undefined for anything unusable, so a malformed
// call becomes "I need X" rather than a thrown TypeError inside the answer.

function text(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(args: ToolArgs, key: string): number | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // Models write numbers as strings often enough to be worth accepting.
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function bool(args: ToolArgs, key: string): boolean | undefined {
  const value = args[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
//
// Markdown, like the book passages the model reads alongside these. The page
// renders the answer as markdown, and a model given a table tends to keep it.

/**
 * One reading as a brewer would write it, name included. Mirrors SENSORS.md;
 * an unknown metric falls back to its own name so a sensor added later still
 * reads sensibly without a change here.
 */
function metric(name: string, value: number): string {
  switch (name) {
    case 'temp_c': return `${value.toFixed(1)} °C`;
    case 'setpoint_c': return `target ${value.toFixed(1)} °C`;
    case 'pressure_bar': return `${value.toFixed(2)} bar`;
    case 'gravity_sg': return `gravity ${value.toFixed(3)}`;
    case 'power_w': return `${Math.round(value)} W`;
    case 'energy_kwh': return `${value.toFixed(2)} kWh`;
    case 'flow_lpm': return `${value.toFixed(1)} L/min`;
    case 'water_l': return `${Math.round(value)} L`;
    // Tri-state fridge/heater output: -1 cooling, 0 idle, +1 heating.
    case 'hvac_state': return value < 0 ? 'cooling' : value > 0 ? 'heating' : 'idle';
    default: return `${name.replace(/_/g, ' ')} ${value}`;
  }
}

function readings(device: DeviceStatus): string {
  if (device.latest.length === 0) return 'no readings yet';
  return device.latest.map((r) => metric(r.metric, r.value)).join(', ');
}

/** "4 minutes ago" — lastSeenAt is written as a real ISO-8601 UTC string. */
function ago(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'unknown';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function bullets(lines: string[]): string {
  return lines.map((line) => `- ${line}`).join('\n');
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The whole brewery in two or three sentences: what is fermenting and at what
 * temperature, whether anything is wrong, and nothing else.
 *
 * The full overview runs to three headed sections and a table of every sensor —
 * fine on a screen, a minute of talking out loud.
 */
function brewerySummary(): string {
  const recipe = repo.getActiveRecipe();
  const state = repo.getFermenterState();
  const controllers = deviceFallback.listDeviceStatus().filter((d) => d.type === 'brew_controller');
  const offline = deviceFallback.listDeviceStatus().filter((d) => !d.online);
  const active = listAlerts(50).filter((a) => a.resolvedAt == null);

  const fermenter = controllers.find((d) => /ferment/i.test(d.name));
  const temp = fermenter?.latest.find((r) => r.metric === 'temp_c');
  const setpoint = fermenter?.latest.find((r) => r.metric === 'setpoint_c');

  const lines = [
    recipe
      ? `Fermenting: ${recipe.name}${temp ? ` at ${temp.value.toFixed(1)} °C${setpoint ? `, target ${setpoint.value.toFixed(1)}` : ''}` : ''}.`
      : `The fermenter is empty${state ? ` and marked ${state}` : ''}.`,
    controllers.length > 0
      ? `Controllers: ${spokenList(
          controllers.map((d) => {
            const t = d.latest.find((r) => r.metric === 'temp_c');
            return d.online && t ? `${d.name} ${t.value.toFixed(1)} °C` : `${d.name} offline`;
          }),
          4,
        )}.`
      : null,
    offline.length > 0 ? `${offline.length} device${offline.length === 1 ? '' : 's'} offline.` : null,
    active.length > 0
      ? `${active.length} active alert${active.length === 1 ? '' : 's'}: ${spokenList(active.map((a) => a.title))}.`
      : 'No active alerts.',
  ].filter((line): line is string => line != null);

  return `## The brewery\n${lines.join(' ')}`;
}

function fermenterSection(): string {
  const recipe = repo.getActiveRecipe();
  const state = repo.getFermenterState();
  const devices = deviceFallback
    .listDeviceStatus()
    .filter((d) => /ferment/i.test(d.name) || d.type === 'pressure_sensor' || d.type === 'hydrometer');

  const lines: string[] = [];
  if (recipe) {
    const detail = [recipe.style, recipe.abv ? `${recipe.abv} % ABV target` : null]
      .filter(Boolean)
      .join(', ');
    lines.push(`In the fermenter: **${recipe.name}**${detail ? ` — ${detail}` : ''}`);
  } else {
    lines.push(
      `The fermenter is empty${state ? ` and marked **${state}**` : ' (nobody has said whether it is clean or dirty)'}`,
    );
  }
  for (const d of devices) {
    lines.push(d.online ? `${d.name} — ${readings(d)}` : `${d.name} — **offline**, last seen ${ago(d.lastSeenAt)}`);
  }
  return `## Fermenter\n${bullets(lines)}`;
}

function inkbirdSection(): string {
  const controllers = deviceFallback.listDeviceStatus().filter((d) => d.type === 'brew_controller');
  if (controllers.length === 0) return '## Inkbird controllers\nNone are registered.';

  const lines = controllers.map((d) => {
    if (!d.online) return `${d.name} — **offline**, last seen ${ago(d.lastSeenAt)}`;
    const temp = d.latest.find((r) => r.metric === 'temp_c');
    const setpoint = d.latest.find((r) => r.metric === 'setpoint_c');
    const hvac = d.latest.find((r) => r.metric === 'hvac_state');
    const parts = [
      temp ? `${temp.value.toFixed(1)} °C` : null,
      setpoint ? `target ${setpoint.value.toFixed(1)} °C` : null,
      hvac ? metric('hvac_state', hvac.value) : null,
      d.pendingSetpointC != null ? `change to ${d.pendingSetpointC} °C still pending` : null,
    ].filter(Boolean);
    return `${d.name} — ${parts.length ? parts.join(', ') : 'no readings yet'}`;
  });
  return `## Inkbird controllers\n${bullets(lines)}`;
}

function deviceSection(): string {
  const devices = deviceFallback.listDeviceStatus();
  if (devices.length === 0) return '## Devices\nNo devices are registered.';

  const offline = devices.filter((d) => !d.online);
  const rows = devices.map((d) => {
    const cadence =
      d.reportingIntervalSec % 60 === 0 && d.reportingIntervalSec >= 60
        ? `${d.reportingIntervalSec / 60} min`
        : `${d.reportingIntervalSec} s`;
    return `| ${d.name} | ${d.type.replace(/_/g, ' ')} | ${d.online ? 'online' : '**offline**'} | ${ago(d.lastSeenAt)} | ${cadence} | ${d.lastIp ?? '—'} |`;
  });
  return [
    `## Devices\n${devices.length - offline.length} of ${devices.length} online.`,
    '',
    '| Device | Type | Status | Last reading | Logs every | IP |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function sensorSection(): string {
  const devices = deviceFallback.listDeviceStatus();
  if (devices.length === 0) return '## Latest readings\nNo devices are registered.';
  return `## Latest readings\n${bullets(
    devices.map((d) => (d.online ? `${d.name} — ${readings(d)}` : `${d.name} — **offline**`)),
  )}`;
}

function alertSection(): string {
  const active = listAlerts(50).filter((a) => a.resolvedAt == null);
  if (active.length === 0) return '## Alerts\nNothing active.';
  return `## Alerts\n${bullets(
    active.map((a) => `${a.severity === 'critical' ? '**Critical** — ' : ''}${a.title}: ${a.detail}`),
  )}`;
}

/** Contents values that are a keg state rather than a beer. */
const NON_BEER = KEG_STATE_CONTENTS;

/**
 * The keg board in one sentence: how many of each beer, then the empties.
 *
 * What somebody standing at the taps actually asked when they said "what's in
 * our kegs?" — three IPA and two stout, not eight rows of ABV and fill dates.
 * The full table is a `detail: "full"` away, and is what the written chat gets.
 */
function kegSummary(kegs: Keg[]): string {
  const beer = kegs.filter((k) => !NON_BEER.includes(k.contents.trim()));
  const byContents = new Map<string, number>();
  for (const keg of beer) {
    const name = keg.contents.trim();
    byContents.set(name, (byContents.get(name) ?? 0) + 1);
  }

  // Most-of first: with one keg left of something and four of another, the four
  // is the answer to "what's on".
  const beers = [...byContents.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `${count} × ${name}`);

  const states = NON_BEER.map((state) => {
    const count = kegs.filter((k) => k.contents.trim() === state).length;
    return count > 0 ? `${count} ${state.toLowerCase()}` : null;
  }).filter((part): part is string => part != null);

  const lines = [
    beers.length > 0 ? `On tap: ${beers.join(', ')}.` : 'No keg holds beer.',
    states.length > 0 ? `Empty or unassigned: ${states.join(', ')}.` : null,
    `${kegs.length} kegs in total.`,
  ].filter((line): line is string => line != null);

  return `## Kegs\n${lines.join(' ')}\n\nAsk for the full board if you want each keg's ABV, fill date and note.`;
}

async function kegSection(brief: boolean): Promise<string> {
  let kegs: Keg[];
  try {
    kegs = await fetchKegs(repo.getKegContentColors());
  } catch {
    // The board lives in a Google Sheet; Google being unreachable is not a
    // reason for the whole answer to fail.
    return '## Kegs\nThe keg sheet could not be read just now.';
  }
  if (kegs.length === 0) return '## Kegs\nThe keg sheet is empty.';
  if (brief) return kegSummary(kegs);

  const beer = kegs.filter((k) => !NON_BEER.includes(k.contents.trim()));
  const rows = kegs.map(
    (k) => `| ${k.number} | ${k.contents || '—'} | ${k.volume || '—'} | ${k.abv || '—'} | ${k.date || '—'} | ${k.note || ''} |`,
  );
  return [
    `## Kegs\n${beer.length} of ${kegs.length} kegs hold beer.`,
    '',
    '| # | Contents | Volume | ABV | Filled | Note |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// History — the same sensors, over time rather than right now
// ---------------------------------------------------------------------------
//
// `get_brewery_status` answers "what is it doing?"; everything here answers
// "what has it been doing?", which is the question a brewer actually asks about
// a fermentation. A single 20.4 °C says nothing about whether the fridge held
// it there overnight or spent the night chasing a door left open.

/** Longest window the history tool will read, in hours. A month of a 30 s sensor. */
const MAX_HISTORY_HOURS = 24 * 31;

/** Cumulative meters, where the useful figure is the total rather than the trend. */
const CUMULATIVE = new Set(['energy_kwh', 'water_l']);

/** Match a device by name, the way a person would say it. Same shape as matchTodos. */
function matchDevices(spoken: string): DeviceStatus[] {
  const devices = deviceFallback.listDeviceStatus();
  const target = spoken.toLowerCase().trim();
  const exact = devices.filter((d) => d.name.toLowerCase() === target);
  if (exact.length > 0) return exact;
  const partial = devices.filter(
    (d) => d.name.toLowerCase().includes(target) || target.includes(d.name.toLowerCase()),
  );
  if (partial.length > 0) return partial;
  // Last resort: the words in common. "the fermenter fridge" should find
  // "Fermenter controller" without the brewer knowing its registered name.
  const words = new Set(target.split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
  return devices.filter((d) =>
    d.name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .some((word) => words.has(word)),
  );
}

/**
 * min / mean / max over a series, with how many points it rests on.
 *
 * Folded rather than spread into `Math.min(...)`: a month of a 30-second sensor
 * is tens of thousands of readings, and spreading an array that long into a
 * call blows the argument limit — a crash that would only ever appear on the
 * longest window somebody asked for.
 */
function summarise(values: number[]): { min: number; avg: number; max: number; count: number } | null {
  if (values.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  return { min, avg: sum / values.length, max, count: values.length };
}

/**
 * One metric's behaviour over the window, in a line.
 *
 * Ordered oldest → newest before the "started/ended" pair is taken, because
 * `getHistory` returns newest first and a fermentation read backwards tells the
 * opposite story.
 */
function metricTrend(name: string, readings: Reading[]): string | null {
  const ordered = [...readings].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  const stats = summarise(ordered.map((r) => r.value));
  if (!stats) return null;
  const first = ordered[0]?.value;
  const last = ordered[ordered.length - 1]?.value;

  if (CUMULATIVE.has(name) && first != null && last != null) {
    // A meter that counts up: the interesting number is what it consumed over
    // the window, not its min and max.
    return `${name.replace(/_/g, ' ')} — used ${metric(name, Math.max(0, last - first))} over the window (now reading ${metric(name, last)})`;
  }

  const spread = stats.max - stats.min;
  const parts = [
    `${metric(name, stats.avg)} average`,
    `${metric(name, stats.min)} to ${metric(name, stats.max)}`,
    first != null && last != null ? `started ${metric(name, first)}, ended ${metric(name, last)}` : null,
    `swing of ${spread.toFixed(2).replace(/\.?0+$/, '')}`,
    `${stats.count} readings`,
  ].filter((part): part is string => part != null);
  return `${name.replace(/_/g, ' ')} — ${parts.join(', ')}`;
}

/**
 * A metric's window in the fewest words that still answer "did it hold?" — the
 * average and the range it moved through, and nothing about sample counts.
 */
function briefTrend(name: string, readings: Reading[]): string | null {
  if (name === 'hvac_state') {
    const cooling = readings.filter((r) => r.value < 0).length;
    return `cooling ${Math.round((cooling / readings.length) * 100)} % of the time`;
  }
  const ordered = [...readings].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  const stats = summarise(ordered.map((r) => r.value));
  if (!stats) return null;
  if (CUMULATIVE.has(name)) {
    const first = ordered[0]?.value ?? 0;
    const last = ordered[ordered.length - 1]?.value ?? 0;
    return `used ${metric(name, Math.max(0, last - first))}`;
  }
  return `${metric(name, stats.avg)} average, ${metric(name, stats.min)} to ${metric(name, stats.max)}`;
}

function historySection(device: DeviceStatus, hours: number, wanted?: string, brief = false): string {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const history = deviceFallback.getHistory(device.id, {
    ...(wanted ? { metric: wanted } : {}),
    since,
    limit: 5000,
  });

  if (!history || history.length === 0) {
    return `**${device.name}** logged nothing${wanted ? ` for ${wanted}` : ''} in the last ${hours} h.${
      device.online ? '' : ` It has been offline since ${ago(device.lastSeenAt)}.`
    }`;
  }

  // Group by metric: one device reports several (a controller logs its
  // temperature, its target and whether it is cooling).
  const byMetric = new Map<string, Reading[]>();
  for (const reading of history) {
    const list = byMetric.get(reading.metric) ?? [];
    list.push(reading);
    byMetric.set(reading.metric, list);
  }

  if (brief) {
    // Setpoint and the target it is chasing are noise in a spoken summary of
    // whether a temperature held; the temperature itself is the question.
    const parts = [...byMetric]
      .filter(([name]) => name !== 'setpoint_c')
      .map(([name, readings]) => briefTrend(name, readings))
      .filter((part): part is string => part != null);
    return `**${device.name}**, last ${hours} h: ${parts.join('; ')}.`;
  }

  const lines: string[] = [];
  for (const [name, readings] of byMetric) {
    // hvac_state is a tri-state flag; averaging it produces a number that means
    // nothing. How long it spent cooling is the honest summary.
    if (name === 'hvac_state') {
      const cooling = readings.filter((r) => r.value < 0).length;
      const heating = readings.filter((r) => r.value > 0).length;
      const share = (n: number): string => `${Math.round((n / readings.length) * 100)} %`;
      lines.push(`hvac — cooling ${share(cooling)} of the time, heating ${share(heating)}, otherwise idle`);
      continue;
    }
    const line = metricTrend(name, readings);
    if (line) lines.push(line);
  }

  // The all-time totals live beside the window, because "how much power have I
  // ever used" and "how much did this brew session use" are both asked.
  for (const name of CUMULATIVE) {
    if (!byMetric.has(name)) continue;
    const total = deviceFallback.getMetricTotal(device.id, name);
    if (total != null && total > 0) {
      lines.push(`${name.replace(/_/g, ' ')} — ${metric(name, total)} all time`);
    }
  }

  return `**${device.name}**, last ${hours} h\n${bullets(lines)}`;
}

// ---------------------------------------------------------------------------
// Brew sessions
// ---------------------------------------------------------------------------

/** A gravity as the sheet holds it, or a dash. */
function gravityText(value: string): string {
  return value.trim() || '—';
}

/** Both efficiency figures for a logged brew session; see BrewSessionDetail for the why. */
function efficiencies(day: BrewSessionDetail | BrewSession): { brewhouse: number | null; mash: number | null } {
  return {
    brewhouse:
      day.measured.efficiencyPct ??
      measuredEfficiency({
        gravity: day.measured.og,
        litres: day.measured.volumeL,
        mashedPointGallons: day.recipe.mashedPointGallons,
        unmashedPointGallons: day.recipe.unmashedPointGallons,
      }),
    mash: measuredEfficiency({
      gravity: day.measured.preBoilGravity,
      litres: day.measured.preBoilVolumeL,
      mashedPointGallons: day.recipe.mashedPointGallons,
      unmashedPointGallons: day.recipe.preBoilUnmashedPointGallons,
    }),
  };
}

/** `20 %` or a dash — a percentage nobody could calculate is not a zero. */
function pct(value: number | null): string {
  return value == null ? '—' : `${value.toFixed(0)} %`;
}

/** The day itself: "12 Jul 2026". A session is logged against a date, not a timestamp. */
function day(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The brew-session log as a sentence: the last few brews, newest first. */
function brewSessionSummary(sessions: BrewSession[]): string {
  const recent = sessions.slice(0, SPOKEN_LIST_MAX).map((entry) => {
    const { brewhouse } = efficiencies(entry);
    return `${entry.recipe.name} on ${day(entry.brewedAt)}${brewhouse != null ? ` at ${pct(brewhouse)}` : ''}`;
  });
  return `${sessions.length} brew session${sessions.length === 1 ? '' : 's'} logged. Most recent: ${recent.join('; ')}.${
    sessions.length > recent.length ? ' Ask for one by name for its numbers.' : ''
  }`;
}

function brewSessionRows(sessions: BrewSession[]): string {
  const rows = sessions.map((entry) => {
    const { brewhouse } = efficiencies(entry);
    const abv = abvFromGravities(entry.measured.og, entry.measured.fg);
    return `| ${entry.id} | ${day(entry.brewedAt)} | ${entry.recipe.name} | #${entry.brewNumber} | ${entry.status} | ${gravityText(entry.measured.og)} | ${gravityText(entry.measured.fg)} | ${abv == null ? '—' : `${abv.toFixed(1)} %`} | ${pct(brewhouse)} | ${entry.rating == null ? '—' : `${entry.rating}/5`} |`;
  });
  return [
    '| id | Brewed | Recipe | Brew | Status | OG | FG | ABV | Brewhouse | Rating |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** Min/mean/max as one phrase, or nothing when the series was empty. */
function statsText(stats: BrewSessionTempStats | null, unit = '°C'): string {
  if (!stats) return 'not logged';
  return `${stats.avg.toFixed(1)} ${unit} average, ${stats.min.toFixed(1)}–${stats.max.toFixed(1)} ${unit} (${stats.count} samples)`;
}

/**
 * " against a target of 1.048 at 31 L", for a kettle reading the recipe stated a
 * figure for. Empty when it didn't — including on an entry logged before the
 * targets were snapshotted, where inventing one would misreport the day.
 */
function against(gravity: string | null, volumeL: number | null): string {
  const parts = [gravity || null, volumeL == null ? null : `${volumeL} L`].filter(Boolean);
  return parts.length === 0 ? '' : ` against a target of ${parts.join(' at ')}`;
}

function brewSessionDetail(entry: BrewSessionDetail): string {
  const { brewhouse, mash } = efficiencies(entry);
  const abv = abvFromGravities(entry.measured.og, entry.measured.fg);
  const attenuation = apparentAttenuation(entry.measured.og, entry.measured.fg);
  const m = entry.measured;

  const sections = [
    `## ${entry.recipe.name} — brew #${entry.brewNumber}, ${day(entry.brewedAt)}`,
    bullets(
      [
        `Status: **${entry.status}**${entry.durationMinutes ? `, took ${(entry.durationMinutes / 60).toFixed(1)} h` : ''}`,
        `Style: ${entry.recipe.style || 'unstated'}${entry.recipe.batchSizeL ? `, recipe written for ${entry.recipe.batchSizeL} L` : ''}`,
        entry.pitchedAt ? `Pitched ${day(entry.pitchedAt)}` : null,
        entry.packagedAt ? `Packaged ${day(entry.packagedAt)}` : null,
        entry.rating != null ? `Rated ${entry.rating}/5` : null,
        entry.recipe.costDkk != null ? `Ingredients cost ${Math.round(entry.recipe.costDkk)} kr that day` : null,
      ].filter((line): line is string => line != null),
    ),
    `### Measured\n${bullets(
      [
        `OG ${gravityText(m.og)} against a target of ${gravityText(entry.recipe.og)}`,
        `FG ${gravityText(m.fg)} against a target of ${gravityText(entry.recipe.fg)}`,
        abv != null ? `ABV ${abv.toFixed(1)} %${attenuation != null ? `, ${attenuation.toFixed(0)} % apparent attenuation` : ''}` : null,
        m.preBoilGravity
          ? `Pre-boil ${gravityText(m.preBoilGravity)}${m.preBoilVolumeL ? ` at ${m.preBoilVolumeL} L` : ''}${against(entry.recipe.preBoilGravity, entry.recipe.preBoilVolumeL)}`
          : null,
        m.postBoilGravity
          ? `Post-boil ${gravityText(m.postBoilGravity)}${m.postBoilVolumeL ? ` at ${m.postBoilVolumeL} L` : ''}${against(entry.recipe.postBoilGravity, entry.recipe.postBoilVolumeL)}`
          : null,
        m.volumeL != null
          ? `${m.volumeL} L into the fermenter${entry.recipe.batchSizeL != null ? ` against ${entry.recipe.batchSizeL} L planned` : ''}`
          : null,
        m.mashTempC != null ? `Mashed at ${m.mashTempC} °C` : null,
        `Brewhouse efficiency ${pct(brewhouse)}${m.efficiencyPct != null ? ' (entered by hand)' : ''}, mash efficiency ${pct(mash)}`,
        m.waterL != null ? `${m.waterL} L of brewing liquor` : null,
        m.energyKwh != null ? `${m.energyKwh} kWh of electricity` : null,
      ].filter((line): line is string => line != null),
    )}`,
  ];

  const rig = entry.rigStats;
  if (rig.bk || rig.mlt || rig.hlt) {
    sections.push(
      `### The rig on the day\n${bullets([
        `Boil kettle: ${statsText(rig.bk)}`,
        `Mash tun: ${statsText(rig.mlt)}`,
        `Hot liquor tank: ${statsText(rig.hlt)}`,
      ])}`,
    );
  }

  const f = entry.fermentation;
  if (f.temp || f.gravity || f.days != null) {
    sections.push(
      `### Fermentation${f.deviceName ? ` (from ${f.deviceName})` : ''}\n${bullets(
        [
          f.days != null ? `${f.days} days${entry.packagedAt ? ' to packaging' : ' so far'}` : null,
          f.temp ? `Temperature: ${statsText(f.temp)}` : null,
          f.gravity
            ? `Gravity: ${f.gravity.start.toFixed(3)} → ${f.gravity.end.toFixed(3)} (${f.gravity.count} readings)`
            : null,
        ].filter((line): line is string => line != null),
      )}`,
    );
  }

  if (entry.notes.trim()) sections.push(`### Brew-session notes\n${entry.notes.trim()}`);
  if (entry.tastingNotes.trim()) sections.push(`### Tasting notes\n${entry.tastingNotes.trim()}`);
  return sections.join('\n\n');
}

/** How many items a spoken list names before it starts counting instead. */
const SPOKEN_LIST_MAX = 3;

/** "a, b and 2 more" — a list a person can follow without a screen. */
function spokenList(items: string[], max = SPOKEN_LIST_MAX): string {
  if (items.length <= max) {
    if (items.length <= 1) return items[0] ?? '';
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  }
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

function todoText(todos: Todo[], brief = false): string {
  if (todos.length === 0) return 'The to-do list is empty.';
  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);

  if (brief) {
    if (open.length === 0) return `Nothing outstanding. ${done.length} finished.`;
    return `${open.length} outstanding: ${spokenList(open.map((t) => t.text))}.${
      done.length > 0 ? ` ${done.length} finished.` : ''
    }`;
  }
  const parts = [
    open.length === 0 ? '**Nothing outstanding.**' : `**Outstanding (${open.length})**\n${bullets(open.map((t) => t.text))}`,
  ];
  if (done.length > 0) parts.push(`**Done (${done.length})**\n${bullets(done.map((t) => t.text))}`);
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Chart lines, as [key, what a person calls it, ...aliases]. */
const GRAPH_LINES: [keyof GraphColors, ...string[]][] = [
  ['pressure', 'pressure', 'fermentation pressure'],
  ['gravity', 'gravity', 'tilt', 'hydrometer'],
  ['power', 'power', 'electricity', 'watts'],
  ['water', 'water'],
  ['beerTemp', 'beer temperature', 'beer', 'wort'],
  ['fridgeTemp', 'fridge temperature', 'fridge', 'ambient'],
  ['setpoint', 'setpoint', 'target', 'target temperature'],
];

function pickGraphLine(spoken: string): keyof GraphColors | null {
  const target = spoken.toLowerCase().trim();
  for (const [key, ...aliases] of GRAPH_LINES) {
    if (aliases.some((alias) => alias === target)) return key;
  }
  const hits = GRAPH_LINES.filter(([, ...aliases]) =>
    aliases.some((alias) => alias.includes(target) || target.includes(alias)),
  );
  return hits.length === 1 ? (hits[0]?.[0] ?? null) : null;
}

/** A `#rrggbb` value from a hex string; null when it isn't one. */
function hex(value: string): string | null {
  const raw = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
  return null;
}

/**
 * The numeric keys of {@link RecipeDefaults}. `batchTarget` and `pitchRate` are
 * free text on the Settings page and are read out but never written here — an
 * assistant retyping "Manufacturer recommended" as something almost identical
 * would change every future recipe for no reason anyone could see.
 */
type NumericRecipeDefault = {
  [K in keyof RecipeDefaults]: RecipeDefaults[K] extends number ? K : never;
}[keyof RecipeDefaults];

/** The recipe-default fields Bruce may set, with the bounds the API enforces. */
const RECIPE_DEFAULT_FIELDS: [NumericRecipeDefault, string, string, number, number][] = [
  ['batchSizeL', 'batch_size_l', 'L', 1, 100_000],
  ['boilTimeMinutes', 'boil_time_minutes', 'min', 0, 1_000],
  ['efficiencyPercent', 'efficiency_percent', '%', 1, 100],
  ['boilOffLPerHour', 'boil_off_l_per_hour', 'L/h', 0, 1_000],
  ['trubChillerLossL', 'trub_chiller_loss_l', 'L', 0, 10_000],
  ['mashThicknessLPerKg', 'mash_thickness_l_per_kg', 'L/kg', 0.01, 100],
  ['mashStrikeTempC', 'mash_strike_temp_c', '°C', 0, 120],
  ['mashTargetTempC', 'mash_target_temp_c', '°C', 0, 120],
  ['mashStepMinutes', 'mash_step_minutes', 'min', 0, 1_000],
];

function settingsSection(section: string): string {
  const want = (name: string): boolean => section === 'all' || section === name;
  const parts: string[] = [];

  if (want('notifications')) {
    const n = repo.getNotificationSettings();
    parts.push(
      `## Alerts\n${bullets([
        `Keg age alert: ${n.kegAlertEnabled ? `on, at ${n.kegAlertDays} days` : 'off'}`,
        `Fermentation-complete alert: ${n.fermentDoneEnabled ? 'on' : 'off'}`,
      ])}`,
    );
  }

  if (want('recipe_defaults')) {
    const d = repo.getRecipeDefaults();
    parts.push(
      `## What a new recipe starts from\n${bullets([
        `Batch size: ${d.batchSizeL} L into the ${d.batchTarget.toLowerCase()}`,
        `Boil: ${d.boilTimeMinutes} min, boiling off ${d.boilOffLPerHour} L/h, ${d.trubChillerLossL} L lost to trub and chiller`,
        `Efficiency: ${d.efficiencyPercent} %`,
        `Mash: ${d.mashThicknessLPerKg} L/kg, strike ${d.mashStrikeTempC} °C for a ${d.mashTargetTempC} °C rest of ${d.mashStepMinutes} min`,
        `Pitch rate: ${d.pitchRate}`,
      ])}`,
    );
  }

  if (want('graph_colors')) {
    const c = repo.getGraphColors();
    parts.push(
      `## Graph colours\n${bullets(
        GRAPH_LINES.map(([key, label]) => `${label}: \`${c[key]}\`${c[key] === DEFAULT_GRAPH_COLORS[key] ? ' (default)' : ''}`),
      )}`,
    );
  }

  if (want('keg_colors')) {
    const c = repo.getKegContentColors();
    parts.push(
      `## Keg colours\n${bullets(Object.entries(c).map(([content, value]) => `${content}: \`${value}\``))}`,
    );
  }

  if (want('device_sources')) {
    const s = repo.getDeviceDataSources();
    parts.push(
      `## Sensor data sources\n${bullets(
        SENSOR_CATALOG.map((entry) => `${entry.label}: **${s[entry.key] ?? 'mock'}**`),
      )}\n\nA sensor set to \`mock\` shows invented demo numbers on every screen, not its own readings.`,
    );
  }

  return parts.length > 0 ? parts.join('\n\n') : `There is no settings section called "${section}".`;
}

// ---------------------------------------------------------------------------
// Calculators
// ---------------------------------------------------------------------------
//
// Three sums a brewer does mid-brew, done in code rather than in the model's
// head. That is the entire point of them being tools: a language model asked to
// solve a cubic for regulator pressure will produce a confident number that is
// wrong by a few PSI, and nothing about the answer will look wrong.
//
// The pure formulas are shared with the browser calculators; this module keeps
// Bruce's conversational input validation and response wording.

/** Gravity as SG, accepting either `1.050` or `1050` — brewers write both. */
function gravity(value: number): number {
  return value > 1.2 ? value / 1000 : value;
}

function dilution(volumeL: number, current: number, desired: number): string {
  const og = gravity(current);
  const dg = gravity(desired);
  if (volumeL <= 0) return 'The volume has to be more than zero litres.';
  if (og <= 1) return 'The current gravity has to be above 1.000.';
  if (dg <= 1) return 'The target gravity has to be above 1.000.';
  if (dg >= og) return 'Diluting only lowers gravity — the target has to be below the current gravity.';

  const total = dilutedVolumeL(volumeL, og, dg);
  const water = total - volumeL;
  return `Add **${water.toFixed(1)} L** of water: ${volumeL} L at ${og.toFixed(3)} becomes ${total.toFixed(1)} L at ${dg.toFixed(3)}.`;
}

/** Temperature-correct a reading and phrase the result for Bruce. */
function hydrometerCorrection(reading: number, sampleC: number, calibrationC: number): string {
  const sg = gravity(reading);
  if (sg <= 0) return 'The hydrometer reading has to be above zero.';
  const corrected = correctedGravity(sg, sampleC, calibrationC);
  return `Corrected gravity **${corrected.toFixed(3)}** — read ${sg.toFixed(3)} at ${sampleC} °C on a hydrometer calibrated for ${calibrationC} °C.`;
}

/** Bruce-specific names/order over the shared numeric style ranges. */
const CARBONATION_STYLES: [string, { min: number; max: number }][] = [
  ['British ales', CARBONATION_GUIDELINE_RANGES.britishAles],
  ['Porter and stout', CARBONATION_GUIDELINE_RANGES.porterAndStout],
  ['Belgian ales', CARBONATION_GUIDELINE_RANGES.belgianAles],
  ['American ales and lager', CARBONATION_GUIDELINE_RANGES.americanAlesAndLager],
  ['European lagers', CARBONATION_GUIDELINE_RANGES.europeanLagers],
  ['Lambic', CARBONATION_GUIDELINE_RANGES.lambic],
  ['German wheat beer', CARBONATION_GUIDELINE_RANGES.germanWheatBeer],
  ['Fruit lambic', CARBONATION_GUIDELINE_RANGES.fruitLambic],
];

function carbonationRangeText(range: { min: number; max: number }): string {
  return `${range.min.toFixed(1)}–${range.max.toFixed(1)}`;
}

function carbonation(volumes: number, kegC: number): string {
  if (volumes <= 0) return 'Volumes of CO2 has to be above zero.';
  const { bar, psi } = carbonationPressure(volumes, kegC);
  if (psi <= 0) {
    return `At ${kegC} °C the beer already holds about ${volumes} volumes on its own — no pressure needed, and it is warm enough that you should chill it before carbonating.`;
  }
  return `Set the regulator to **${bar.toFixed(2)} bar** (${psi.toFixed(1)} PSI) for ${volumes} volumes at ${kegC} °C.`;
}

// ---------------------------------------------------------------------------
// The brewing rig, read-only
// ---------------------------------------------------------------------------
//
// Deliberately read-only here, where the speaker in the brewery can drive it.
// The difference is where you are standing: turning an element on in front of
// you is a decision, and turning one on from a phone somewhere else — on a
// sentence that may have been misheard — is an empty kettle with the heat on.

/** A pot's line: what it reads, what it is aiming at, and whether it is on. */
function potLine(name: string, temp: number | null, control: BrewPotControl | undefined): string {
  const parts = [
    temp == null ? 'no reading' : `${temp.toFixed(1)} °C`,
    control ? `target ${control.sv.toFixed(1)} °C` : null,
    control ? (control.heaterOn ? `**on** at ${control.efficiency} % duty` : 'off') : null,
    control?.regulationEnabled ? 'regulating to the target' : null,
  ].filter(Boolean);
  return `${name} — ${parts.join(', ')}`;
}

async function rigSection(): Promise<string> {
  let state: BrewSystemState | null;
  try {
    state = await readBrewSystemState();
  } catch {
    state = null;
  }
  if (!rigBase()) {
    return 'The brewing rig is not configured on this hub (no BREW_SYSTEM_URL), so there is nothing to read.';
  }
  if (!state) {
    return 'The brewing rig did not answer — it is almost certainly powered off, which is normal between brew sessions.';
  }

  const { temperatures: t, controlState, timer } = state;
  const pumps = Object.entries(controlState.pumps).map(
    ([name, pump]) => `Pump ${name} — ${pump.on ? `**on** at ${pump.speed} %` : 'off'}`,
  );
  // The rig's timer is a stopwatch when `target` is 0 and a countdown otherwise,
  // so the same `seconds` field means opposite things and has to be said
  // differently — "12 minutes elapsed" and "12 minutes left" are not the same
  // sentence to someone standing over a boil.
  const clock = (seconds: number): string => `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  const timerLine =
    timer.target > 0
      ? `Timer counting down, ${clock(Math.max(0, timer.seconds))} left${timer.running ? '' : ' (paused)'}`
      : timer.running || timer.seconds > 0
        ? `Stopwatch at ${clock(timer.seconds)}${timer.running ? '' : ' (stopped)'}`
        : 'Timer not running';

  return `## The brewing rig\n${bullets([
    potLine('Boil kettle (BK)', t.bk, controlState.pots.BK),
    potLine('Mash tun (MLT)', t.mlt, undefined),
    potLine('Hot liquor tank (HLT)', t.hlt, controlState.pots.HLT),
    ...pumps,
    timerLine,
  ])}\n\nYou can read the rig but not drive it. Ask at the brewery speaker to turn something on, or use the Brew System page.`;
}

// ---------------------------------------------------------------------------
// The brewery speaker
// ---------------------------------------------------------------------------
//
// The Sonos in the brewery, driven over the LAN by sonos.ts — the same module
// the kiosk's music screen goes through. Two things set it apart from the tools
// above:
//
//   - Nothing here is audited. Skipping a track is not a change to the brewery,
//     and a history page that records every song is one nobody reads. The music
//     routes make the same call: routes/music.ts is registered outside the audit
//     hook, so clicking skip on the kiosk records nothing either.
//   - Sonos folds shuffle and repeat into a single play mode, so changing one
//     means reading the other first — otherwise turning shuffle on would quietly
//     cancel the repeat that was already set.

/** What to say when the speaker doesn't answer. */
function speakerDown(changed: boolean): string {
  return `The brewery speaker did not answer — it is powered down, off the network, or not configured on this hub${
    changed ? ', so nothing changed' : ''
  }.`;
}

/** m:ss, for a position or a duration. */
function trackClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** One track as a person names it. Markdown off for answers that get spoken. */
function trackLabel(track: { title: string | null; artist: string | null }, markdown = true): string {
  const title = track.title ? (markdown ? `**${track.title}**` : track.title) : 'an untitled track';
  return track.artist ? `${title} by ${track.artist}` : title;
}

function repeatText(repeat: MusicRepeat): string {
  if (repeat === 'one') return 'the current track repeats';
  if (repeat === 'all') return 'the whole queue repeats';
  return 'repeat is off';
}

/** Both toggles in one sentence — they are one setting on the speaker. */
function modeText(shuffle: boolean, repeat: MusicRepeat): string {
  return `Shuffle is ${shuffle ? 'on' : 'off'} and ${repeatText(repeat)}`;
}

function nowPlayingText(now: NowPlaying, brief: boolean): string {
  const speaker = now.room ? `The ${now.room} speaker` : 'The brewery speaker';

  if (!now.title || now.state === 'no_media' || now.state === 'stopped') {
    const line = `${speaker} is not playing anything. ${modeText(now.shuffle, now.repeat)}.`;
    return brief ? line : `## Music\n${line}`;
  }

  const state =
    now.state === 'paused' ? 'is paused on' : now.state === 'transitioning' ? 'is changing track, onto' : 'is playing';

  if (brief) {
    return `${speaker} ${state} ${trackLabel(now, false)}. ${modeText(now.shuffle, now.repeat)}, volume ${now.volume}.`;
  }

  return `## Music\n${speaker} ${state} ${trackLabel(now)}.\n${bullets(
    [
      now.album ? `Album: ${now.album}` : null,
      now.durationSec ? `${trackClock(now.positionSec ?? 0)} of ${trackClock(now.durationSec)}` : null,
      now.queuePosition ? `Track ${now.queuePosition} in the queue` : null,
      modeText(now.shuffle, now.repeat),
      `Volume ${now.volume}`,
    ].filter((line): line is string => line != null),
  )}`;
}

/** How much of the queue a written answer prints before it starts counting. */
const QUEUE_TABLE_MAX = 100;

function queueText(queue: MusicQueue, brief: boolean): string {
  if (queue.tracks.length === 0) {
    const line =
      'There is no queue on the speaker — it is playing a radio stream, a line-in or a Spotify Connect session, or nothing at all.';
    return brief ? line : `## Queue\n${line}`;
  }

  const total = queue.tracks.length;
  const at = queue.currentPosition;

  if (brief) {
    // A queue read aloud is unusable past a few tracks: say how long it is and
    // what comes next, and let them ask for the rest.
    const upcoming = queue.tracks.filter((t) => at == null || t.position > at);
    const next = spokenList(upcoming.map((t) => trackLabel(t, false)));
    return [
      `${total} track${total === 1 ? '' : 's'} in the queue${at != null ? `, on number ${at}` : ''}.`,
      next ? `Coming up: ${next}.` : 'Nothing after the current track.',
    ].join(' ');
  }

  const shown = queue.tracks.slice(0, QUEUE_TABLE_MAX);
  const rows = shown.map(
    (t) =>
      `| ${t.position}${t.position === at ? ' ▶' : ''} | ${t.title ?? '—'} | ${t.artist ?? '—'} |`,
  );
  return [
    `## Queue\n${total} track${total === 1 ? '' : 's'}${at != null ? `, playing number ${at}` : ''}.${
      total > shown.length ? ` Showing the first ${shown.length}.` : ''
    }`,
    '',
    '| # | Track | Artist |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/**
 * Queue entries a phrase could mean, best tier only.
 *
 * The tiering mirrors {@link matchTodos} — exact, then substring, then shared
 * words — but over the title *and* the artist, because "play the Springsteen
 * one" and "play Thunder Road" are the same request said two ways. Every
 * candidate at the tier reached comes back, so the caller can ask which was
 * meant instead of playing a guess.
 */
function matchQueueTracks(tracks: QueueTrack[], wanted: string): QueueTrack[] {
  const normalize = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const target = normalize(wanted);
  if (!target) return [];

  const title = (t: QueueTrack): string => normalize(t.title ?? '');
  const artist = (t: QueueTrack): string => normalize(t.artist ?? '');

  const exact = tracks.filter((t) => title(t) === target || artist(t) === target);
  if (exact.length > 0) return firstOfEach(exact);

  const contains = tracks.filter((t) => {
    if (title(t) && (title(t).includes(target) || target.includes(title(t)))) return true;
    return artist(t) !== '' && artist(t).includes(target);
  });
  if (contains.length > 0) return firstOfEach(contains);

  const words = new Set(target.split(' '));
  const scored = tracks
    .map((track) => ({
      track,
      score: `${title(track)} ${artist(track)}`.split(' ').filter((w) => w && words.has(w)).length,
    }))
    .filter((entry) => entry.score > 0);
  if (scored.length === 0) return [];
  const best = Math.max(...scored.map((entry) => entry.score));
  return firstOfEach(scored.filter((entry) => entry.score === best).map((entry) => entry.track));
}

/**
 * Collapse repeats of the same song to their first slot. A queue holding one
 * track three times is not an ambiguity to put back to the brewer — they asked
 * for that song, and any copy of it plays the same music.
 */
function firstOfEach(tracks: QueueTrack[]): QueueTrack[] {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    const key = `${track.title ?? ''}|${track.artist ?? ''}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * What the speaker moved on to, appended to a skip.
 *
 * Sonos loads the next track as it answers the command, so reading straight
 * back usually names it — and a spoken "skipped" that doesn't say what is
 * playing now is half an answer. Usually, not always: a queue that has run out
 * or a track still transitioning reports no title, and the read is best-effort,
 * so a skip that worked is never reported as a failure because the follow-up
 * read didn't.
 */
async function landedOn(markdown: boolean): Promise<string> {
  try {
    const now = await sonos.getNowPlaying();
    return now.title ? ` Now playing ${trackLabel(now, markdown)}.` : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Record a change Bruce made on someone's behalf.
 *
 * The actor is the account that asked — the change is theirs, not the
 * assistant's — with "Bruce:" in front of the summary so the History page shows
 * at a glance which changes came through the chat. Method and path are the
 * request that really happened (the chat call), not the REST endpoint this
 * would have gone through if a human had clicked it.
 */
function audited(actor: BruceActor, entity: string, action: string): void {
  try {
    recordAudit({
      userId: actor.userId,
      username: actor.username,
      action: `Bruce: ${action}`,
      entity,
      method: 'POST',
      path: '/api/bruce/chat',
    });
  } catch (err) {
    // Recording must never take down the answer it was recording — but a change
    // that landed with no trace of who made it is worth a line in the journal,
    // because the History page will show nothing at all.
    console.error(`[Bruce] Change made but not recorded in the history: ${action}`, err);
  }
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

/** Shorthand for a Responses-API function-tool definition. */
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: 'function',
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

const enumOf = (values: string[], description: string): Record<string, unknown> => ({
  type: 'string',
  enum: values,
  description,
});

/**
 * The `detail` argument, offered by every tool whose full answer is long.
 *
 * The default is the caller's — short when the answer will be spoken, complete
 * when it will be read — so the common case needs no argument at all. This is
 * only the escape hatch for "read me the whole list", which is a thing people
 * do ask out loud.
 */
const DETAIL_ARG = enumOf(
  ['brief', 'full'],
  'Leave this out unless the brewer asked for a particular amount of detail. Spoken answers are summarised by default and written ones are complete. Pass "full" only when they explicitly want everything ("read me the whole list", "the full rundown"), or "brief" to summarise in writing.',
);

const TOOLS: Record<string, ToolSpec> = {
  // --- Recipes (read only; the editor owns writing a brew sheet) ------------

  [RECIPE_TOOL.name]: {
    definition: RECIPE_TOOL as unknown as Record<string, unknown>,
    phase: (args) => ({ phase: 'recipes', ...(text(args, 'name') ? { detail: text(args, 'name') as string } : {}) }),
    run: async (args, _actor, brief) => {
      const wanted = text(args, 'name');
      if (!wanted) return 'No recipe name was given. Call get_recipe again with one.';
      return (await runRecipeTool(wanted, brief)).text;
    },
  },

  // --- The hub, read --------------------------------------------------------

  get_brewery_status: {
    definition: tool(
      'get_brewery_status',
      "Read what the brewery is doing right now: what is in the fermenter and how it is fermenting, the Inkbird controllers' temperatures and targets, which devices are online, the latest reading from every sensor, and any active alerts. Call this before answering anything about the state of *this* brewery — you cannot see any of it otherwise.",
      {
        section: enumOf(
          ['overview', 'fermenter', 'inkbirds', 'devices', 'sensors', 'alerts'],
          '"overview" (default) covers the fermenter, the Inkbirds and any alerts; the others go into one area.',
        ),
        detail: DETAIL_ARG,
      },
    ),
    phase: () => ({ phase: 'brewery', detail: 'sensors and fermenter' }),
    run: (args, _actor, brief) => {
      const section = text(args, 'section') ?? 'overview';
      // Only the overview summarises: asking for one area is already a narrow
      // question, and answering "the Inkbirds" with a summary of the brewery
      // would be answering a different one.
      if (brief && section === 'overview') return brewerySummary();
      switch (section) {
        case 'fermenter': return fermenterSection();
        case 'inkbirds': return inkbirdSection();
        case 'devices': return deviceSection();
        case 'sensors': return sensorSection();
        case 'alerts': return alertSection();
        default: return [fermenterSection(), inkbirdSection(), alertSection()].join('\n\n');
      }
    },
  },

  get_sensor_history: {
    definition: tool(
      'get_sensor_history',
      'Read how a sensor has behaved OVER TIME rather than right now: min, mean, max, where it started and ended, and how much a meter consumed over the window. Use it for anything with a period in the question — "has the fermenter held its temperature overnight?", "how much power did the brew session use?", "how much has the keg fridge been cycling?", "was the brewery cold last night?". get_brewery_status only ever shows the latest single reading, which cannot answer any of those.',
      {
        sensor: {
          type: 'string',
          description:
            'Which sensor, as a person would say it — "fermenter", "keg fridge", "power meter", "brewery". Omit to summarise every sensor over the window.',
        },
        hours: {
          type: 'number',
          description: `How far back to look, in hours. Default 12, maximum ${MAX_HISTORY_HOURS} (a month).`,
        },
        metric: {
          type: 'string',
          description:
            'One metric only, when the question is about one: temp_c, setpoint_c, hvac_state, pressure_bar, gravity_sg, power_w, energy_kwh, flow_lpm, water_l. Omit for all of them.',
        },
        detail: DETAIL_ARG,
      },
    ),
    phase: (args) => ({
      phase: 'brewery',
      detail: text(args, 'sensor') ? `${text(args, 'sensor') as string} history` : 'sensor history',
    }),
    run: (args, _actor, brief) => {
      const hours = Math.min(Math.max(num(args, 'hours') ?? 12, 1), MAX_HISTORY_HOURS);
      const wanted = text(args, 'metric');
      const spoken = text(args, 'sensor');
      const join = brief ? '\n' : '\n\n';

      if (!spoken) {
        const devices = deviceFallback.listDeviceStatus();
        if (devices.length === 0) return 'No devices are registered.';
        return devices.map((device) => historySection(device, hours, wanted, brief)).join(join);
      }

      const matches = matchDevices(spoken);
      if (matches.length === 0) {
        const names = deviceFallback.listDeviceStatus().map((d) => d.name);
        return `No sensor here matches "${spoken}". The registered ones are: ${names.join(', ') || 'none'}.`;
      }
      // Several matches are answered rather than guessed between — the reads are
      // free, and "the fermenter" legitimately means two devices (the controller
      // and the Tilt in the same tank).
      return matches.map((device) => historySection(device, hours, wanted, brief)).join(join);
    },
  },

  get_brew_sessions: {
    definition: tool(
      'get_brew_sessions',
      'Read the brew-session log: what was brewed and when, the measured gravities, the brewhouse and mash efficiency worked back from them, how the rig ran on the day, how the fermentation went, and the rating and notes. Use it for anything about a past batch or a trend across batches — "how did the last saison go?", "is my efficiency improving?", "when did I last brew?", "what did I mash at last time?".',
      {
        recipe: {
          type: 'string',
          description: 'Only brews of this recipe, matched loosely by name. Omit for the most recent brews of anything.',
        },
        id: {
          type: 'number',
          description: 'A specific brew session, by the id shown in the list. Returns the full detail for it.',
        },
        full_writeup: {
          type: 'boolean',
          description:
            'True to return one brew session in full — its measurements, rig temperatures, fermentation and notes — rather than a row. Use with `recipe` when it names one brew; with several matches you get the list back and should ask which.',
        },
        limit: { type: 'number', description: 'How many rows to list, newest first. Default 10, maximum 50.' },
        detail: DETAIL_ARG,
      },
    ),
    phase: () => ({ phase: 'brewery', detail: 'the brew-session log' }),
    run: (args, _actor, brief) => {
      const wantedId = num(args, 'id');
      if (wantedId != null) {
        const entry = getBrewSession(Math.round(wantedId));
        return entry ? brewSessionDetail(entry) : `There is no brew session with id ${Math.round(wantedId)}.`;
      }

      const all = listBrewSessions();
      if (all.length === 0) return 'Nothing has been logged in the brew-session log yet.';

      const wantedRecipe = text(args, 'recipe');
      const matches = wantedRecipe
        ? all.filter((entry) => entry.recipe.name.toLowerCase().includes(wantedRecipe.toLowerCase()))
        : all;
      if (matches.length === 0) {
        return `No brew session matches "${wantedRecipe}". Brewed so far: ${[...new Set(all.map((e) => e.recipe.name))].join(', ')}.`;
      }

      // One match plus a request for the write-up is unambiguous; several is
      // not, and guessing which brew somebody meant would put the wrong numbers
      // in front of them with no way to tell.
      if (args.full_writeup === true) {
        if (matches.length === 1 && matches[0]) {
          const full = getBrewSession(matches[0].id);
          if (full) return brewSessionDetail(full);
        }
        return `${matches.length} brew sessions match. Ask which one, by id:\n\n${brewSessionRows(matches.slice(0, 20))}`;
      }

      if (brief) return brewSessionSummary(matches);

      const limit = Math.min(Math.max(Math.round(num(args, 'limit') ?? 10), 1), 50);
      const shown = matches.slice(0, limit);
      const header = wantedRecipe
        ? `${matches.length} brew${matches.length === 1 ? '' : 's'} of ${wantedRecipe}`
        : `${all.length} brew session${all.length === 1 ? '' : 's'} logged, newest first`;
      return `## Brew sessions\n${header}${matches.length > shown.length ? ` (showing ${shown.length})` : ''}\n\n${brewSessionRows(shown)}\n\nAsk for one by id with \`full_writeup\` for its rig temperatures, fermentation and notes.`;
    },
  },

  get_rig_status: {
    definition: tool(
      'get_rig_status',
      'Read the brewing rig: the boil kettle, mash tun and hot liquor tank temperatures, whether the elements are on and what they are aiming at, the pumps, and the brew timer. Read-only — you cannot switch anything on the rig from here. The rig is a separate machine that is normally powered off between brew sessions, and reports as offline then.',
      {},
    ),
    phase: () => ({ phase: 'brewery', detail: 'the brewing rig' }),
    run: () => rigSection(),
  },

  get_music: {
    definition: tool(
      'get_music',
      'Read the brewery speaker: what is playing right now — title, artist, album, how far in, the volume, and whether shuffle or repeat is on — or the queue, every track with its title and artist. Call this for any question about the music, and before control_music when you need to know what is in the queue to pick from.',
      {
        section: enumOf(
          ['now_playing', 'queue'],
          '"now_playing" (default) is the current track and the play mode; "queue" is the track list.',
        ),
        detail: DETAIL_ARG,
      },
    ),
    phase: (args) => ({
      phase: 'music',
      detail: text(args, 'section') === 'queue' ? 'the queue' : 'what is playing',
    }),
    run: async (args, _actor, brief) => {
      try {
        return text(args, 'section') === 'queue'
          ? queueText(await sonos.getQueue(), brief)
          : nowPlayingText(await sonos.getNowPlaying(), brief);
      } catch (err) {
        if (err instanceof sonos.SonosUnavailableError) return speakerDown(false);
        throw err;
      }
    },
  },

  brewing_calculator: {
    definition: tool(
      'brewing_calculator',
      'Work out one of three brewing figures exactly. Always call this rather than doing the arithmetic yourself — these are formulas, and a number you calculate in your head will be plausible and wrong. "dilution": water to add to hit a target gravity (needs volume_l, current_gravity, desired_gravity). "hydrometer": correct a reading for sample temperature (needs reading, sample_temp_c; calibration_temp_c defaults to 20). "carbonation": regulator pressure to force-carbonate (needs co2_volumes and keg_temp_c). If the brewer names a style instead of a CO2 volume, call it with `style` alone to get the usual range, ask them to pick, then call again with the number.',
      {
        kind: enumOf(['dilution', 'hydrometer', 'carbonation'], 'Which calculation to run.'),
        volume_l: { type: 'number', description: 'dilution: current wort volume, litres.' },
        current_gravity: { type: 'number', description: 'dilution: gravity now, e.g. 1.062 or 1062.' },
        desired_gravity: { type: 'number', description: 'dilution: gravity wanted, below the current one.' },
        reading: { type: 'number', description: 'hydrometer: the gravity as read.' },
        sample_temp_c: { type: 'number', description: 'hydrometer: the sample temperature, °C.' },
        calibration_temp_c: { type: 'number', description: "hydrometer: what the instrument is calibrated for, °C. Default 20." },
        co2_volumes: { type: 'number', description: 'carbonation: volumes of CO2 wanted, e.g. 2.4.' },
        keg_temp_c: { type: 'number', description: 'carbonation: the keg temperature, °C.' },
        style: {
          type: 'string',
          description: 'carbonation: a beer style, when no CO2 volume was given. Returns the usual range to choose from.',
        },
      },
      ['kind'],
    ),
    phase: () => ({ phase: 'thinking', detail: 'working it out' }),
    run: (args) => {
      switch (text(args, 'kind')) {
        case 'dilution': {
          const volume = num(args, 'volume_l');
          const current = num(args, 'current_gravity');
          const desired = num(args, 'desired_gravity');
          if (volume == null || current == null || desired == null) {
            return 'Diluting needs the current volume in litres, the gravity now and the gravity you want.';
          }
          return dilution(volume, current, desired);
        }
        case 'hydrometer': {
          const reading = num(args, 'reading');
          const sample = num(args, 'sample_temp_c');
          if (reading == null || sample == null) {
            return 'Correcting a reading needs the gravity as read and the temperature of the sample.';
          }
          return hydrometerCorrection(reading, sample, num(args, 'calibration_temp_c') ?? 20);
        }
        case 'carbonation': {
          const volumes = num(args, 'co2_volumes');
          const kegTemp = num(args, 'keg_temp_c');
          const style = text(args, 'style');
          if (volumes == null && style) {
            const wanted = style.toLowerCase();
            const hit = CARBONATION_STYLES.find(
              ([name]) => name.toLowerCase().includes(wanted) || wanted.includes(name.toLowerCase().split(' ')[0] ?? ''),
            );
            const table = CARBONATION_STYLES.map(
              ([name, range]) => `${name}: ${carbonationRangeText(range)}`,
            ).join('; ');
            return hit
              ? `${hit[0]} are usually carbonated at **${carbonationRangeText(hit[1])} volumes** of CO2. Ask which they want, then call this again with co2_volumes and keg_temp_c.`
              : `No style here matches "${style}". The usual ranges, in volumes of CO2: ${table}. Ask which they want, then call this again with the number.`;
          }
          if (volumes == null || kegTemp == null) {
            return 'Carbonation pressure needs the volumes of CO2 and the keg temperature — or a style on its own, to get the usual range.';
          }
          return carbonation(volumes, kegTemp);
        }
        default:
          return 'That calculation is not one of dilution, hydrometer or carbonation.';
      }
    },
  },

  get_kegs: {
    definition: tool(
      'get_kegs',
      "Read the keg board: what is in each keg, its volume, ABV, when it was filled and any note. Contents that are not a beer are keg states — Dirty (emptied, needs cleaning), Clean (ready to fill), Starsan, or ??? (unknown). Use for anything about what is on tap or how old a beer is.",
      { detail: DETAIL_ARG },
    ),
    phase: () => ({ phase: 'brewery', detail: 'keg board' }),
    run: (_args, _actor, brief) => kegSection(brief),
  },

  get_todos: {
    definition: tool(
      'get_todos',
      'Read the brewery to-do list — the running list of jobs, which is not the brew-session checklist.',
      { detail: DETAIL_ARG },
    ),
    phase: () => ({ phase: 'brewery', detail: 'to-do list' }),
    run: (_args, _actor, brief) => todoText(repo.listTodos(), brief),
  },

  get_settings: {
    definition: tool(
      'get_settings',
      "Read BrewPlanner's settings: alert preferences, what a blank recipe starts from, the chart and keg colours, and which sensors are showing mock demo data instead of real readings.",
      {
        section: enumOf(
          ['all', 'notifications', 'recipe_defaults', 'graph_colors', 'keg_colors', 'device_sources'],
          'Which settings to read (default "all").',
        ),
      },
    ),
    phase: () => ({ phase: 'brewery', detail: 'settings' }),
    run: (args) => settingsSection(text(args, 'section') ?? 'all'),
  },

  // --- The hub, written -----------------------------------------------------

  manage_keg: {
    definition: tool(
      'manage_keg',
      'Change one keg on the board: fill it with a beer, mark it emptied, mark it cleaned, or edit its ABV, note or fill date. Contents conventions the board uses: a beer name when full; "Dirty" = just emptied, needs cleaning; "Clean" = cleaned and ready; "Starsan" = holding sanitiser; "???" = unknown. Only call this when the brewer has said which keg and what changed — never to tidy the board up.',
      {
        number: { type: 'string', description: 'Which keg, as written on the board, e.g. "5".' },
        action: enumOf(
          ['fill', 'empty', 'clean', 'edit'],
          '"fill" needs `contents`, and stamps today unless a date is given. "empty" sets it Dirty and clears what the beer left behind — its date, ABV, recipe link and old note — though a `note` passed with it is kept, for what is wrong with the keg itself. "clean" sets it Clean. "edit" changes only the fields you pass.',
        ),
        contents: { type: 'string', description: 'What is in it — the beer name when filling.' },
        abv: { type: 'string', description: 'ABV as text, e.g. "6.2%".' },
        note: { type: 'string', description: 'A short note on the keg.' },
        date: { type: 'string', description: 'Fill date, DD/MM/YYYY. Defaults to today when filling.' },
      },
      ['number', 'action'],
    ),
    phase: (args) => ({ phase: 'brewery', detail: `keg ${text(args, 'number') ?? 'board'}` }),
    run: async (args, actor) => {
      // Everything answerable without the sheet is answered first: the board
      // lives in a Google spreadsheet, and there is no sense making a network
      // round trip to discover that the model never said which keg it meant.
      const number = text(args, 'number');
      const action = text(args, 'action');
      const contents = text(args, 'contents');
      if (!number) return 'Which keg? Call manage_keg again with its number.';
      if (!action) return 'Say what to do with it: fill, empty, clean or edit.';
      if (!['fill', 'empty', 'clean', 'edit'].includes(action)) {
        return `"${action}" is not one of fill, empty, clean or edit.`;
      }
      if (action === 'fill' && !contents) {
        return 'Filling a keg needs to know what went in it. Ask which beer.';
      }

      let kegs: Keg[];
      try {
        kegs = await fetchKegs();
      } catch {
        return 'The keg sheet could not be read just now, so nothing was changed.';
      }
      const keg = kegs.find((k) => k.number.trim() === number.trim());
      if (!keg) {
        return `There is no keg ${number} on the board. It holds: ${kegs.map((k) => k.number).join(', ')}.`;
      }

      // The sheet writer takes the whole row, so anything not being changed is
      // carried over from what is there — a voice edit of the ABV must not
      // silently blank the note beside it.
      const today = new Date();
      const todayText = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

      let fields: { contents: string; date: string; note: string; abv: string; recipeId?: string };
      switch (action) {
        case 'fill':
          fields = {
            contents: contents as string,
            date: text(args, 'date') ?? todayText,
            note: text(args, 'note') ?? '',
            abv: text(args, 'abv') ?? '',
          };
          break;
        // Emptying and cleaning both clear the beer's details: a Dirty keg
        // carrying the last beer's ABV and fill date reads, at a glance on the
        // board, as though it were still full of it. Emptying spells the whole
        // set out (recipe link included) — updateKeg would enforce it anyway,
        // but the audit summary below reads off these fields. The old beer's
        // note goes with them; a note given *now* is about the keg, so it stays.
        case 'empty':
          fields = { contents: 'Dirty', ...EMPTIED_KEG_FIELDS, note: text(args, 'note') ?? '' };
          break;
        case 'clean':
          fields = { contents: 'Clean', date: '', note: text(args, 'note') ?? '', abv: '' };
          break;
        default:
          // 'edit': only what was named changes; the rest of the row is carried
          // over, since the sheet writer takes every column at once.
          fields = {
            contents: contents ?? keg.contents,
            date: text(args, 'date') ?? keg.date,
            note: text(args, 'note') ?? keg.note,
            abv: text(args, 'abv') ?? keg.abv,
          };
          break;
      }

      try {
        await updateKeg(keg.number, fields);
      } catch (err) {
        if (err instanceof KegWriteNotConfiguredError) {
          return 'The keg board is read-only on this hub — no write key is configured for the sheet, so nothing was changed.';
        }
        return `Keg ${keg.number} could not be updated: ${err instanceof Error ? err.message : 'the sheet did not answer'}.`;
      }

      const summary =
        action === 'fill'
          ? `filled keg ${keg.number} with ${fields.contents}${fields.abv ? ` at ${fields.abv}` : ''} (${fields.date})`
          : action === 'empty'
            ? `marked keg ${keg.number} emptied — it was ${keg.contents || 'unrecorded'}`
            : action === 'clean'
              ? `marked keg ${keg.number} cleaned`
              : `updated keg ${keg.number}`;
      audited(actor, 'Keg', summary);
      return `Done — ${summary}.`;
    },
  },

  manage_todo: {
    definition: tool(
      'manage_todo',
      'Change the brewery to-do list: add a job, tick one off, put a completed one back, delete one outright, or clear every completed item. Items are matched on their text, so quote enough of it to be unambiguous — the result says which item was matched, and you must repeat that back. Deleting is not the same as completing: only delete when the user asked for the job to go away rather than be done.',
      {
        action: enumOf(['add', 'complete', 'reopen', 'delete', 'clear_completed'], 'What to do.'),
        text: {
          type: 'string',
          description: 'The job. For "add" this is the new text; for the others, enough of the existing item to identify it. Not needed for "clear_completed".',
        },
      },
      ['action'],
    ),
    phase: (args) => ({ phase: 'brewery', detail: `to-do list (${text(args, 'action') ?? 'change'})` }),
    run: (args, actor) => {
      const action = text(args, 'action');
      const wanted = text(args, 'text');

      if (action === 'clear_completed') {
        const done = repo.listTodos().filter((t) => t.done);
        if (done.length === 0) return 'There were no completed items to clear, so nothing changed.';
        repo.clearCompletedTodos();
        audited(actor, 'To-do', `cleared ${done.length} completed to-do${done.length === 1 ? '' : 's'}`);
        return `Cleared ${done.length} completed item${done.length === 1 ? '' : 's'}.`;
      }

      if (!wanted) return 'No to-do text was given. Call manage_todo again with one.';

      if (action === 'add') {
        const created = repo.createTodo(wanted);
        audited(actor, 'To-do', `added a to-do "${created.text}"`);
        return `Added "${created.text}" to the to-do list.`;
      }

      const pool = repo
        .listTodos()
        .filter((t) => (action === 'complete' ? !t.done : action === 'reopen' ? t.done : true));
      const matches = matchTodos(pool, wanted);
      if (matches.length === 0) {
        return `Nothing on the to-do list matches "${wanted}"${
          action === 'complete' ? ' among the outstanding items' : action === 'reopen' ? ' among the completed items' : ''
        }. Nothing was changed.`;
      }
      if (matches.length > 1) {
        return `Several to-dos match "${wanted}": ${matches
          .map((t) => `"${t.text}"`)
          .join(', ')}. Nothing was changed — ask which one is meant.`;
      }

      const todo = matches[0] as Todo;
      if (action === 'delete') {
        repo.deleteTodo(todo.id);
        audited(actor, 'To-do', `deleted the to-do "${todo.text}"`);
        return `Deleted "${todo.text}" from the to-do list.`;
      }
      const done = action === 'complete';
      repo.updateTodo(todo.id, { done });
      audited(actor, 'To-do', `${done ? 'completed' : 'reopened'} the to-do "${todo.text}"`);
      return done ? `Ticked off "${todo.text}".` : `Put "${todo.text}" back on the list.`;
    },
  },

  set_fermenter: {
    definition: tool(
      'set_fermenter',
      'Record what is in the fermenter, or the state of the empty one. "set" names which existing recipe went in (it must already be in the recipe library — this does not create one); "clear" records that the beer came out; "mark_clean" and "mark_dirty" answer whether the empty tank has been washed. Taking a beer out is not the same as cleaning the tank, so "clear" never marks it clean.',
      {
        action: enumOf(['set', 'clear', 'mark_clean', 'mark_dirty'], 'What to record.'),
        name: { type: 'string', description: 'For "set": the recipe that went into the fermenter. Matched loosely against the recipe list.' },
      },
      ['action'],
    ),
    phase: () => ({ phase: 'brewery', detail: 'fermenter' }),
    run: (args, actor) => {
      const action = text(args, 'action');

      if (action === 'mark_clean' || action === 'mark_dirty') {
        const state = action === 'mark_clean' ? 'clean' : 'dirty';
        repo.setFermenterState(state);
        audited(actor, 'Recipe', `marked the fermenter ${state}`);
        return `The fermenter is now marked **${state}**.`;
      }

      if (action === 'clear') {
        const was = repo.getActiveRecipe();
        if (!was) return 'The fermenter was already empty, so nothing changed.';
        repo.clearActiveRecipe();
        audited(actor, 'Recipe', `cleared the active recipe (was "${was.name}")`);
        return `Cleared the fermenter — "${was.name}" is no longer in it. Its clean/dirty state is unchanged.`;
      }

      const wanted = text(args, 'name');
      if (!wanted) return 'No recipe name was given. Call set_fermenter again with one.';
      const recipes = recipeRepo.listRecipes();
      const match = matchRecipe(recipes, wanted);
      if (!match) {
        const names = recipes.map((r) => r.name).join(', ');
        return `No recipe matches "${wanted}", so nothing changed. The recipes are: ${names || 'none'}.`;
      }
      repo.setActiveRecipe({
        id: match.id,
        name: match.name,
        style: match.style ?? '',
        abv: match.abv ?? '',
        url: match.url ?? '',
        ...(match.ibu != null ? { ibu: match.ibu } : {}),
        ...(match.ebc != null ? { ebc: match.ebc } : {}),
      });
      audited(actor, 'Recipe', `set the active recipe to "${match.name}"`);
      return `**${match.name}** is now recorded as the beer in the fermenter.`;
    },
  },

  update_notification_settings: {
    definition: tool(
      'update_notification_settings',
      'Switch the brewery alerts on or off: the routine ones (an old keg, a finished fermentation) and the critical ones that go to everyone\'s phone (fermenter pressure lost or too high, the fermenter overheating, the fermenter fridge not responding, the keg fridge warming up, the brewery near freezing, a critical sensor going quiet). Send only the fields the user asked to change; the rest are left as they are. The thresholds themselves are set on the Settings page, not here.',
      {
        keg_alert_enabled: { type: 'boolean', description: 'Whether old kegs raise an alert.' },
        keg_alert_days: { type: 'number', description: 'Age in days at which a keg raises one (1–365).' },
        ferment_done_enabled: { type: 'boolean', description: 'Whether a finished fermentation raises an alert.' },
        pressure_lost_enabled: { type: 'boolean', description: 'Whether losing fermenter pressure raises an alert.' },
        pressure_high_enabled: { type: 'boolean', description: 'Whether fermenter over-pressure raises an alert.' },
        fermenter_hot_enabled: { type: 'boolean', description: 'Whether an overheating fermenter raises an alert.' },
        fermenter_stalled_enabled: { type: 'boolean', description: 'Whether a fermenter fridge that is not responding raises an alert.' },
        kegs_warm_enabled: { type: 'boolean', description: 'Whether a warming keg fridge raises an alert.' },
        brewery_cold_enabled: { type: 'boolean', description: 'Whether a brewery near freezing raises an alert.' },
        sensor_offline_enabled: { type: 'boolean', description: 'Whether a critical sensor going quiet raises an alert.' },
      },
    ),
    phase: () => ({ phase: 'brewery', detail: 'alert settings' }),
    run: (args, actor) => {
      const kegDays = num(args, 'keg_alert_days');
      // Every other field is a plain on/off, so they share one table: the
      // argument name, the setting it writes, and how to say it back out loud.
      const toggles = [
        ['keg_alert_enabled', 'kegAlertEnabled', 'keg age alerts'],
        ['ferment_done_enabled', 'fermentDoneEnabled', 'fermentation-complete alerts'],
        ['pressure_lost_enabled', 'pressureLostEnabled', 'pressure-lost alerts'],
        ['pressure_high_enabled', 'pressureHighEnabled', 'over-pressure alerts'],
        ['fermenter_hot_enabled', 'fermenterHotEnabled', 'fermenter overheating alerts'],
        ['fermenter_stalled_enabled', 'fermenterStalledEnabled', 'fermenter fridge alerts'],
        ['kegs_warm_enabled', 'kegsWarmEnabled', 'keg fridge alerts'],
        ['brewery_cold_enabled', 'breweryColdEnabled', 'brewery freezing alerts'],
        ['sensor_offline_enabled', 'sensorOfflineEnabled', 'sensor offline alerts'],
      ] as const;

      const current = repo.getNotificationSettings();
      const next = { ...current };
      const changed: string[] = [];

      if (kegDays !== undefined) {
        if (!Number.isInteger(kegDays) || kegDays < 1 || kegDays > 365) {
          return 'The keg alert age must be a whole number of days between 1 and 365. Nothing changed.';
        }
        next.kegAlertDays = kegDays;
        changed.push(`keg age threshold ${kegDays} days`);
      }
      for (const [arg, field, label] of toggles) {
        const value = bool(args, arg);
        if (value === undefined) continue;
        next[field] = value;
        changed.push(`${label} ${value ? 'on' : 'off'}`);
      }

      if (changed.length === 0) return 'No setting was given to change, so nothing changed.';
      repo.setNotificationSettings(next);
      audited(actor, 'Settings', `updated notification settings (${changed.join(', ')})`);
      return `Updated: ${changed.join(', ')}.`;
    },
  },

  update_recipe_defaults: {
    definition: tool(
      'update_recipe_defaults',
      'Change the figures a blank brew sheet opens on — batch size, boil, efficiency and the mash. These describe the brewhouse, so they apply to every new recipe on every screen; recipes already saved keep the numbers they were written to. Send only the fields the user asked to change.',
      Object.fromEntries(
        RECIPE_DEFAULT_FIELDS.map(([, arg, unit, min, max]) => [
          arg,
          { type: 'number', description: `${arg.replace(/_/g, ' ')} in ${unit} (${min}–${max}).` },
        ]),
      ),
    ),
    phase: () => ({ phase: 'brewery', detail: 'recipe defaults' }),
    run: (args, actor) => {
      const given = RECIPE_DEFAULT_FIELDS.map(([key, arg, unit, min, max]) => ({
        key,
        arg,
        unit,
        min,
        max,
        value: num(args, arg),
      })).filter((field) => field.value !== undefined);

      if (given.length === 0) return 'No recipe default was given to change, so nothing changed.';
      for (const field of given) {
        const value = field.value as number;
        if (value < field.min || value > field.max) {
          return `${field.arg.replace(/_/g, ' ')} must be between ${field.min} and ${field.max} ${field.unit}. Nothing changed.`;
        }
      }

      const next = { ...repo.getRecipeDefaults() };
      for (const field of given) next[field.key] = field.value as number;
      repo.setRecipeDefaults(next);

      const changed = given.map((field) => `${field.arg.replace(/_/g, ' ')} ${field.value} ${field.unit}`);
      audited(actor, 'Settings', `changed what a new recipe starts from (${changed.join(', ')})`);
      return `New recipes will now start with ${changed.join(', ')}.`;
    },
  },

  set_color: {
    definition: tool(
      'set_color',
      'Recolour one chart line or one keg content. The palettes are shared, so a change shows on the desktop dashboard and the brewery kiosk alike. Colours must be given as a #rrggbb hex value — pick one yourself if the user named a colour, and say which hex you chose.',
      {
        target: enumOf(['graph_line', 'keg_content'], 'Which palette to change.'),
        item: {
          type: 'string',
          description: 'For "graph_line": pressure, gravity, power, water, beer temperature, fridge temperature or setpoint. For "keg_content": the keg content exactly as get_settings lists it (e.g. NEIPA, Stout, Clean).',
        },
        color: { type: 'string', description: 'A #rrggbb hex colour.' },
      },
      ['target', 'item', 'color'],
    ),
    phase: () => ({ phase: 'brewery', detail: 'colours' }),
    run: (args, actor) => {
      const target = text(args, 'target');
      const item = text(args, 'item');
      const color = text(args, 'color');
      if (!item || !color) return 'Both the item and the colour are needed. Nothing changed.';

      const value = hex(color);
      if (!value) return `"${color}" is not a #rrggbb hex colour. Nothing changed.`;

      if (target === 'keg_content') {
        const current: KegContentColors = repo.getKegContentColors();
        const key = Object.keys(current).find((name) => name.toLowerCase() === item.toLowerCase());
        if (!key) {
          return `There is no keg content called "${item}". The ones with colours are: ${Object.keys(current).join(', ')}. Nothing changed.`;
        }
        repo.setKegContentColors({ ...current, [key]: value } as KegContentColors);
        audited(actor, 'Settings', `set the ${key} keg colour to ${value}`);
        return `${key} kegs are now \`${value}\`.`;
      }

      const key = pickGraphLine(item);
      if (!key) {
        return `"${item}" does not name one chart line. They are: ${GRAPH_LINES.map(([, label]) => label).join(', ')}. Nothing changed.`;
      }
      repo.setGraphColors({ ...repo.getGraphColors(), [key]: value });
      audited(actor, 'Settings', `set the ${key} graph colour to ${value}`);
      return `The ${key} line is now \`${value}\`.`;
    },
  },

  set_device_source: {
    definition: tool(
      'set_device_source',
      'Switch one sensor between its real readings and the built-in mock demo data. Setting a sensor to mock makes every screen show invented numbers for it, so say that plainly when confirming. Setting it back to real means a sensor that is not reporting shows as not connected rather than quietly reading as mock.',
      {
        sensor: {
          type: 'string',
          description: `The sensor key, one of: ${SENSOR_CATALOG.map((s) => s.key).join(', ')}. Call get_settings with section "device_sources" if unsure.`,
        },
        source: enumOf(['real', 'mock'], '"real" = the sensor\'s own readings, "mock" = invented demo data.'),
      },
      ['sensor', 'source'],
    ),
    phase: () => ({ phase: 'brewery', detail: 'sensor data source' }),
    run: (args, actor) => {
      const sensor = text(args, 'sensor');
      const source = text(args, 'source');
      if (source !== 'real' && source !== 'mock') return 'The source must be "real" or "mock". Nothing changed.';

      const entry = SENSOR_CATALOG.find(
        (s) => s.key === sensor || s.label.toLowerCase() === (sensor ?? '').toLowerCase(),
      );
      if (!entry) {
        return `There is no sensor called "${sensor}". They are: ${SENSOR_CATALOG.map((s) => s.key).join(', ')}. Nothing changed.`;
      }

      const current = repo.getDeviceDataSources();
      if (current[entry.key] === source) {
        return `${entry.label} is already set to ${source}, so nothing changed.`;
      }
      repo.setDeviceDataSources({ ...current, [entry.key]: source });
      audited(actor, 'Settings', `set the ${entry.label} data source to ${source}`);
      return source === 'mock'
        ? `${entry.label} now shows **mock demo data** — every screen will show invented numbers for it until it is switched back to real.`
        : `${entry.label} now shows its real readings. If it is not reporting, it will show as not connected.`;
    },
  },

  configure_device: {
    definition: tool(
      'configure_device',
      "Change a device's settings: how often it logs a reading, and — for an Inkbird controller — its target temperature. A setpoint is queued for the controller's agent to write to the hardware, so it takes a moment to be confirmed; a new interval takes effect on the device's next push.",
      {
        device: { type: 'string', description: "Part of the device's name, e.g. \"fermenter\", \"power\"." },
        interval_seconds: { type: 'number', description: `Seconds between readings (${REPORTING_INTERVAL_SEC.min}–${REPORTING_INTERVAL_SEC.max}).` },
        setpoint_c: { type: 'number', description: 'Target temperature in °C (−10 to 50). Inkbird controllers only.' },
      },
      ['device'],
    ),
    phase: () => ({ phase: 'brewery', detail: 'device settings' }),
    run: (args, actor) => {
      const wanted = text(args, 'device');
      const interval = num(args, 'interval_seconds');
      const setpoint = num(args, 'setpoint_c');
      if (!wanted) return 'No device was named. Nothing changed.';
      if (interval === undefined && setpoint === undefined) {
        return 'Neither a logging interval nor a setpoint was given, so nothing changed.';
      }

      const all = deviceFallback.listDeviceStatus();
      const needle = wanted.toLowerCase();
      const matches = all.filter(
        (d) => d.name.toLowerCase().includes(needle) || (d.vendorName ?? '').toLowerCase().includes(needle),
      );
      if (matches.length === 0) {
        return `No device matches "${wanted}". The devices are: ${all.map((d) => d.name).join(', ')}. Nothing changed.`;
      }
      if (matches.length > 1) {
        return `Several devices match "${wanted}": ${matches.map((d) => d.name).join(', ')}. Nothing changed — ask which one is meant.`;
      }

      const device = matches[0] as DeviceStatus;
      const done: string[] = [];

      if (interval !== undefined) {
        const value = Math.round(interval);
        if (value < REPORTING_INTERVAL_SEC.min || value > REPORTING_INTERVAL_SEC.max) {
          return `The logging interval must be between ${REPORTING_INTERVAL_SEC.min} and ${REPORTING_INTERVAL_SEC.max} seconds. Nothing changed.`;
        }
        if (!setReportingInterval(device.id, value)) {
          return `${device.name} has no registered agent to honour a logging interval, so nothing changed.`;
        }
        audited(actor, 'Device', `set "${device.name}" logging interval to ${value}s`);
        done.push(`it will log every ${value} s from its next push`);
      }

      if (setpoint !== undefined) {
        if (setpoint < -10 || setpoint > 50) {
          return `A setpoint must be between −10 and 50 °C.${done.length ? ' The logging interval was still changed.' : ' Nothing changed.'}`;
        }
        // The same guard the HTTP route applies before queueing. `queueSetpoint`
        // itself doesn't check the type, so without this a target temperature
        // could be queued onto a water meter and reported as done.
        if (device.type !== 'brew_controller') {
          return `${device.name} is a ${device.type.replace(/_/g, ' ')} and has no setpoint.${done.length ? ' The logging interval was still changed.' : ' Nothing changed.'}`;
        }
        if (!deviceFallback.queueSetpoint(device.id, setpoint)) {
          return `${device.name} has no agent to receive a setpoint.${done.length ? ' The logging interval was still changed.' : ' Nothing changed.'}`;
        }
        audited(actor, 'Device', `set "${device.name}" setpoint to ${setpoint}°C`);
        done.push(
          device.online
            ? `its target is queued at ${setpoint} °C and the controller should confirm shortly`
            : `its target is queued at ${setpoint} °C, but the device is **offline** so it will not arrive until it reports again`,
        );
      }

      return `${device.name}: ${done.join('; ')}.`;
    },
  },

  control_music: {
    definition: tool(
      'control_music',
      'Drive the brewery speaker: play, pause, skip forward or back, turn shuffle on or off, repeat the current track / the whole queue / nothing, or jump to a track already in the queue by its title or artist. It only controls what the speaker already has — it cannot search for or add music that is not in the queue. Shuffle and repeat are one setting on Sonos, so changing either leaves the other as it was. Say back what the result reports: a skip names the track it landed on, and picking a track by name can match the wrong song.',
      {
        action: enumOf(
          [
            'play',
            'pause',
            'next',
            'previous',
            'shuffle_on',
            'shuffle_off',
            'repeat_one',
            'repeat_all',
            'repeat_off',
            'play_track',
          ],
          '"next"/"previous" skip a track. "repeat_one" keeps the track that is playing on a loop, "repeat_all" loops the queue, "repeat_off" stops repeating. "play_track" needs `track`.',
        ),
        track: {
          type: 'string',
          description:
            'For "play_track": the title or the artist of a track in the queue, as the brewer said it. Matched loosely against both; if several tracks match, nothing plays and the candidates come back so you can ask which one.',
        },
      },
      ['action'],
    ),
    phase: (args) => ({ phase: 'music', detail: (text(args, 'action') ?? 'the speaker').replace(/_/g, ' ') }),
    run: async (args, _actor, brief) => {
      const action = text(args, 'action');
      // Track names are the one thing here that gets said back verbatim, so they
      // carry markdown for the dashboard and none for an answer being spoken.
      const md = !brief;
      try {
        switch (action) {
          case 'play':
            await sonos.play();
            return `Playing.${await landedOn(md)}`;
          case 'pause':
            await sonos.pause();
            return 'Paused.';
          case 'next':
            await sonos.next();
            return `Skipped to the next track.${await landedOn(md)}`;
          case 'previous':
            await sonos.previous();
            return `Went back a track.${await landedOn(md)}`;

          // Both toggles read before they write: the speaker holds shuffle and
          // repeat as one combined mode, so setting shuffle without carrying the
          // current repeat across would cancel it as a side effect nobody asked
          // for. It also lets the answer say where both ended up.
          case 'shuffle_on':
          case 'shuffle_off': {
            const shuffle = action === 'shuffle_on';
            const now = await sonos.getNowPlaying();
            if (now.shuffle === shuffle) return `Shuffle was already ${shuffle ? 'on' : 'off'}, and ${repeatText(now.repeat)}.`;
            await sonos.setPlayMode(shuffle, now.repeat);
            return `${modeText(shuffle, now.repeat)}.`;
          }

          case 'repeat_one':
          case 'repeat_all':
          case 'repeat_off': {
            const repeat: MusicRepeat = action === 'repeat_one' ? 'one' : action === 'repeat_all' ? 'all' : 'off';
            const now = await sonos.getNowPlaying();
            if (now.repeat === repeat) return `That was already the setting — ${modeText(now.shuffle, repeat).toLowerCase()}.`;
            await sonos.setPlayMode(now.shuffle, repeat);
            // Name the track when it is the one being looped: "repeat one" said
            // out loud is only checkable if the brewer hears which song it stuck on.
            const looped = repeat === 'one' && now.title ? ` ${trackLabel(now, md)} will keep playing.` : '';
            return `${modeText(now.shuffle, repeat)}.${looped}`;
          }

          case 'play_track': {
            const wanted = text(args, 'track');
            if (!wanted) return 'Which track? Call control_music again with its title or artist.';

            const queue = await sonos.getQueue();
            if (queue.tracks.length === 0) {
              return 'The speaker has no queue to pick from — it is on a radio stream, a line-in or a Spotify Connect session. Nothing changed.';
            }
            const matches = matchQueueTracks(queue.tracks, wanted);
            if (matches.length === 0) {
              return `Nothing in the queue matches "${wanted}", so nothing changed. There are ${queue.tracks.length} tracks in it — read them with get_music if you need the list.`;
            }
            if (matches.length > 1) {
              return `Several tracks match "${wanted}": ${matches
                .slice(0, 6)
                .map((t) => trackLabel(t, md))
                .join('; ')}${matches.length > 6 ? `, and ${matches.length - 6} more` : ''}. Nothing changed — ask which one is meant.`;
            }

            const track = matches[0] as QueueTrack;
            await sonos.playQueuePosition(track.position);
            return `Playing ${trackLabel(track, md)} — track ${track.position} in the queue.`;
          }

          default:
            return `"${action ?? 'nothing'}" is not something control_music does. It plays, pauses, skips forward or back, sets shuffle and repeat, or jumps to a track in the queue.`;
        }
      } catch (err) {
        if (err instanceof sonos.SonosUnavailableError) return speakerDown(true);
        throw err;
      }
    },
  },
};

/**
 * To-dos a phrase could mean, best tier only.
 *
 * Exact text wins outright, then substring either way round, then shared words.
 * Returning every candidate at the tier reached is what lets the caller ask
 * which one instead of deleting a guess.
 */
function matchTodos(todos: Todo[], wanted: string): Todo[] {
  const normalize = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const target = normalize(wanted);
  if (!target) return [];

  const exact = todos.filter((t) => normalize(t.text) === target);
  if (exact.length > 0) return exact;

  const contains = todos.filter((t) => {
    const value = normalize(t.text);
    return value.includes(target) || target.includes(value);
  });
  if (contains.length > 0) return contains;

  const words = new Set(target.split(' '));
  const scored = todos
    .map((todo) => ({ todo, score: normalize(todo.text).split(' ').filter((w) => words.has(w)).length }))
    .filter((entry) => entry.score > 0);
  if (scored.length === 0) return [];
  const best = Math.max(...scored.map((entry) => entry.score));
  return scored.filter((entry) => entry.score === best).map((entry) => entry.todo);
}

/** Every tool definition, as sent to the model. */
export function bruceToolDefinitions(): unknown[] {
  return Object.values(TOOLS).map((spec) => spec.definition);
}

/** The progress line to show while `name` runs, or null for an unknown tool. */
export function bruceToolPhase(name: string, args: ToolArgs): BrucePhase | null {
  return TOOLS[name]?.phase(args) ?? null;
}

/**
 * Run one tool call and return what the model should read back.
 *
 * Every failure is text, not an exception: a tool that throws takes the whole
 * answer down, where a tool that says what went wrong lets the model correct
 * itself and carry on. That includes an unknown name — the model invented it,
 * and being told so is more useful than a 500 on the brewer's screen.
 *
 * @param brief Whether the answer is going to be spoken. The written chat is
 *   read on a screen and gets everything; voice gets the summary, because a
 *   table read aloud is unusable. The model can still override it per call with
 *   `detail: "full"` when the brewer asks for the whole thing.
 */
export async function runBruceTool(
  name: string,
  args: ToolArgs,
  actor: BruceActor,
  brief = false,
): Promise<string> {
  const spec = TOOLS[name];
  if (!spec) return `There is no tool called ${name}.`;
  try {
    return await spec.run(args, actor, wantsBrief(args, brief));
  } catch (err) {
    return `That could not be read from BrewPlanner: ${err instanceof Error ? err.message : 'unknown error'}.`;
  }
}

/**
 * Whether this call should answer short.
 *
 * The caller decides by default — spoken answers are brief, written ones are
 * not — and the model overrules it per call with `detail`, which is how "give me
 * the full rundown" out loud reaches the long version. Any other value falls
 * back to the default rather than being treated as a request for either.
 */
function wantsBrief(args: ToolArgs, fallback: boolean): boolean {
  const detail = text(args, 'detail');
  if (detail === 'full') return false;
  if (detail === 'brief') return true;
  return fallback;
}

export { matchTodos };

/**
 * The speaker's three pure parts, exported for their test. Everything else in
 * that tool needs a Sonos on the network, which a test cannot have; these are
 * the parts worth pinning anyway — which track a spoken phrase picks out of the
 * queue, and that a spoken answer is a sentence while a written one is a table.
 */
export { matchQueueTracks, nowPlayingText, queueText };

/**
 * The spoken keg summary, exported for its test. The tool itself has to read
 * the Google sheet first, which a test cannot do offline — this is the part
 * worth pinning: that "what's in our kegs?" comes back as counts.
 */
export { kegSummary as kegSummaryForTest };
