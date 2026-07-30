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
  DEFAULT_GRAPH_COLORS,
  REPORTING_INTERVAL_SEC,
  SENSOR_CATALOG,
  type BrucePhase,
  type DeviceStatus,
  type GraphColors,
  type Keg,
  type KegContentColors,
  type RecipeDefaults,
  type Todo,
} from '@checklist/shared';
import { recordAudit } from '../audit/repo.js';
import { listAlerts } from '../alerts/repo.js';
import * as deviceFallback from '../devices/fallback.js';
import { setReportingInterval } from '../devices/repo.js';
import { fetchKegs } from '../kegs.js';
import * as repo from '../repo.js';
import * as recipeRepo from '../recipeRepo.js';
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
  /** Answer the model reads back. Failures are text, never exceptions. */
  run: (args: ToolArgs, actor: BruceActor) => Promise<string> | string;
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
const NON_BEER = ['???', 'Clean', 'Dirty', 'Starsan'];

async function kegSection(): Promise<string> {
  let kegs: Keg[];
  try {
    kegs = await fetchKegs(repo.getKegContentColors());
  } catch {
    // The board lives in a Google Sheet; Google being unreachable is not a
    // reason for the whole answer to fail.
    return '## Kegs\nThe keg sheet could not be read just now.';
  }
  if (kegs.length === 0) return '## Kegs\nThe keg sheet is empty.';

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

function todoText(todos: Todo[]): string {
  if (todos.length === 0) return 'The to-do list is empty.';
  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);
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

const TOOLS: Record<string, ToolSpec> = {
  // --- Recipes (read only; the editor owns writing a brew sheet) ------------

  [RECIPE_TOOL.name]: {
    definition: RECIPE_TOOL as unknown as Record<string, unknown>,
    phase: (args) => ({ phase: 'recipes', ...(text(args, 'name') ? { detail: text(args, 'name') as string } : {}) }),
    run: async (args) => {
      const wanted = text(args, 'name');
      if (!wanted) return 'No recipe name was given. Call get_recipe again with one.';
      return (await runRecipeTool(wanted)).text;
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
      },
    ),
    phase: () => ({ phase: 'brewery', detail: 'sensors and fermenter' }),
    run: (args) => {
      const section = text(args, 'section') ?? 'overview';
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

  get_kegs: {
    definition: tool(
      'get_kegs',
      "Read the keg board: what is in each keg, its volume, ABV, when it was filled and any note. Contents that are not a beer are keg states — Dirty (emptied, needs cleaning), Clean (ready to fill), Starsan, or ??? (unknown). Use for anything about what is on tap or how old a beer is.",
      {},
    ),
    phase: () => ({ phase: 'brewery', detail: 'keg board' }),
    run: () => kegSection(),
  },

  get_todos: {
    definition: tool(
      'get_todos',
      'Read the brewery to-do list — the running list of jobs, which is not the brew-day checklist.',
      {},
    ),
    phase: () => ({ phase: 'brewery', detail: 'to-do list' }),
    run: () => todoText(repo.listTodos()),
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
      'Change the alert preferences: whether a keg raises an alert once it has been full for a while (and after how many days), and whether an alert fires when fermentation looks finished. Send only the fields the user asked to change; the rest are left as they are.',
      {
        keg_alert_enabled: { type: 'boolean', description: 'Whether old kegs raise an alert.' },
        keg_alert_days: { type: 'number', description: 'Age in days at which a keg raises one (1–365).' },
        ferment_done_enabled: { type: 'boolean', description: 'Whether a finished fermentation raises an alert.' },
      },
    ),
    phase: () => ({ phase: 'brewery', detail: 'alert settings' }),
    run: (args, actor) => {
      const kegEnabled = bool(args, 'keg_alert_enabled');
      const kegDays = num(args, 'keg_alert_days');
      const fermentDone = bool(args, 'ferment_done_enabled');
      if (kegEnabled === undefined && kegDays === undefined && fermentDone === undefined) {
        return 'No setting was given to change, so nothing changed.';
      }
      if (kegDays !== undefined && (!Number.isInteger(kegDays) || kegDays < 1 || kegDays > 365)) {
        return 'The keg alert age must be a whole number of days between 1 and 365. Nothing changed.';
      }

      const current = repo.getNotificationSettings();
      const next = {
        kegAlertEnabled: kegEnabled ?? current.kegAlertEnabled,
        kegAlertDays: kegDays ?? current.kegAlertDays,
        fermentDoneEnabled: fermentDone ?? current.fermentDoneEnabled,
      };
      repo.setNotificationSettings(next);

      const changed = [
        kegEnabled !== undefined ? `keg age alerts ${next.kegAlertEnabled ? 'on' : 'off'}` : null,
        kegDays !== undefined ? `keg age threshold ${next.kegAlertDays} days` : null,
        fermentDone !== undefined ? `fermentation-complete alerts ${next.fermentDoneEnabled ? 'on' : 'off'}` : null,
      ].filter(Boolean);
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
 */
export async function runBruceTool(name: string, args: ToolArgs, actor: BruceActor): Promise<string> {
  const spec = TOOLS[name];
  if (!spec) return `There is no tool called ${name}.`;
  try {
    return await spec.run(args, actor);
  } catch (err) {
    return `That could not be read from BrewPlanner: ${err instanceof Error ? err.message : 'unknown error'}.`;
  }
}

export { matchTodos };
