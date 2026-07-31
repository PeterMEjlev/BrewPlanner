import type {
  ActiveRecipe,
  ActiveState,
  Alert,
  AuditEntry,
  AuthState,
  BrewDay,
  BrewDayDetail,
  BrewPot,
  BrewPump,
  BrewSystemConfig,
  BrewSystemStatus,
  BruceBook,
  BruceChatEvent,
  BruceChatReply,
  BruceChatState,
  BruceConversation,
  BruceInstructions,
  BruceKnowledgeState,
  BrucePhase,
  BruceServiceStatus,
  ChecklistSummary,
  ChecklistWithSteps,
  DeviceDataSources,
  DeviceStatus,
  FermenterState,
  FermenterStatus,
  GraphColors,
  HostStatus,
  IngredientKind,
  IngredientPriceOptions,
  IngredientPriceOverride,
  Keg,
  KegContentColors,
  MetricTotal,
  NotificationSettings,
  NowPlaying,
  OutdoorTemperature,
  PriceOption,
  PriceOverrideInput,
  Reading,
  Recipe,
  RecipeBackupResult,
  RecipeBackupStatus,
  RecipeBrewCount,
  RecipeCostBreakdown,
  RecipeDefaults,
  RecipeDetail,
  RecipeEditInput,
  RecipeImportResult,
  RecipeIngredientOption,
  RecipeStatsResponse,
  Step,
  Todo,
  UpdateBrewDayInput,
  User,
  UserRole,
} from '@checklist/shared';

import { getApiBase, getToken, handleUnauthorized, setToken } from './native';

/** Progress of a remote software update (the Settings "Update" button). */
export interface SystemUpdateStatus {
  state: 'idle' | 'running' | 'ok' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  /** Short hash the deploy ended on. */
  commit?: string;
  commitSubject?: string;
  error?: string;
  /** Tail of the last run's combined output. */
  log: string;
  /** The repo's current HEAD short hash (the version that will run after restart). */
  repoCommit: string;
}

/** Progress of a deploy to the brewing rig (the separate brew-system-v3 Pi). */
export interface BrewSystemUpdateStatus {
  state: 'idle' | 'running' | 'ok' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  /** Short hash the rig ended on. */
  commit?: string;
  commitSubject?: string;
  error?: string;
  /** Tail of the last run's combined output. */
  log: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  // Only send a JSON content-type when there's actually a body — Fastify
  // rejects an empty body that declares `Content-Type: application/json`.
  if (init?.body) headers['Content-Type'] = 'application/json';
  // Native app: authenticate with the bearer token (it has no session cookie
  // across the tunnel origin). In the browser getToken() is null and the cookie
  // carries the session, so this header is simply absent.
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // getApiBase() is '' in the browser (same-origin /api) and the configured
  // server origin in the native app (calls go over the tunnel).
  const res = await fetch(`${getApiBase()}/api${path}`, { ...init, headers });
  // A 401 on a normal request means the session expired (or never existed for
  // a remote client). Bounce to the login page — except on /auth/* calls,
  // where the caller handles the status itself (e.g. wrong password on login).
  if (res.status === 401 && !path.startsWith('/auth/')) {
    handleUnauthorized();
    throw new Error('401: Authentication required');
  }
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error ?? JSON.stringify(body);
    } catch {
      detail = res.statusText;
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  // 204 No Content
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Ask Bruce a question, following what he's doing while he does it.
 *
 * The one streaming call in this client. `POST /api/bruce/chat` answers with
 * server-sent events: `phase` while he reads the library, searches the web or
 * pulls up a recipe, then a single `done` carrying the finished answer. The
 * answer itself is not streamed token by token — only the progress is — so the
 * caller still gets one reply object, just later than the first phase.
 *
 * Written on `fetch` + a reader rather than EventSource, which can only GET and
 * cannot carry the bearer token the native app authenticates with.
 */
async function askBruce(
  message: string,
  conversationId: number,
  onPhase?: (phase: BrucePhase) => void,
): Promise<BruceChatReply> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${getApiBase()}/api/bruce/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, conversationId }),
  });

  if (res.status === 401) {
    handleUnauthorized();
    throw new Error('401: Authentication required');
  }
  // Everything that can be refused outright — no API key, a deleted thread — is
  // refused before the stream starts, so it still arrives as JSON with a status.
  if (!res.ok || !res.body) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body?.error ?? JSON.stringify(body);
    } catch {
      /* keep the status text */
    }
    throw new Error(`${res.status}: ${detail}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reply: BruceChatReply | null = null;
  let failure: string | null = null;

  const handle = (payload: string): void => {
    let event: BruceChatEvent;
    try {
      event = JSON.parse(payload) as BruceChatEvent;
    } catch {
      return;
    }
    if (event.type === 'phase') onPhase?.(event);
    else if (event.type === 'done') reply = event.reply;
    else if (event.type === 'error') failure = event.message;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Frames are separated by a blank line; a partial one waits for its rest.
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      for (const line of buffer.slice(0, split).split('\n')) {
        if (line.startsWith('data:')) handle(line.slice(5).trim());
      }
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf('\n\n');
    }
  }

  if (failure) throw new Error(failure);
  // A stream that ends with neither is a dropped connection — the tunnel, or
  // the server restarting mid-answer.
  if (!reply) throw new Error('The connection to Bruce dropped before he answered.');
  return reply;
}

/**
 * Query string for the price endpoints. Null and undefined values are dropped
 * rather than sent as "null" — the server treats an absent amount as "no amount
 * to cost against", which is not the same as a zero.
 */
function priceQuery(params: Record<string, string | number | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') query.set(key, String(value));
  }
  return query.toString();
}

export const api = {
  // Auth
  getAuth: () => request<AuthState>('/auth/me'),
  login: async (username: string, password: string) => {
    // The server also returns a full-access bearer token; the native app stores
    // it for subsequent requests (the browser ignores it and uses its cookie).
    const res = await request<AuthState & { token?: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    if (res.token) await setToken(res.token);
    return res;
  },
  logout: async () => {
    try {
      await request<void>('/auth/logout', { method: 'POST' });
    } finally {
      // Clear the native token even if the request failed (e.g. already expired).
      await setToken(null);
    }
  },
  changePassword: async (currentPassword: string, newPassword: string) => {
    // Changing the password revokes every outstanding token (tokenVersion
    // bump), so the server hands this client a fresh one — store it or the
    // native app would be logged out by its own password change.
    const res = await request<AuthState & { token?: string }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (res.token) await setToken(res.token);
    return res;
  },
  changeUsername: (username: string, currentPassword: string) =>
    request<AuthState>('/auth/change-username', {
      method: 'POST',
      body: JSON.stringify({ username, currentPassword }),
    }),

  // Checklists
  listChecklists: () => request<ChecklistSummary[]>('/checklists'),
  getChecklist: (id: number) => request<ChecklistWithSteps>(`/checklists/${id}`),
  createChecklist: (name: string) =>
    request<ChecklistWithSteps>('/checklists', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  renameChecklist: (id: number, name: string) =>
    request<ChecklistWithSteps>(`/checklists/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  deleteChecklist: (id: number) =>
    request<void>(`/checklists/${id}`, { method: 'DELETE' }),
  activateChecklist: (id: number) =>
    request<ChecklistWithSteps>(`/checklists/${id}/activate`, { method: 'POST' }),

  // Steps
  addStep: (checklistId: number, text: string, required = true) =>
    request<Step>(`/checklists/${checklistId}/steps`, {
      method: 'POST',
      body: JSON.stringify({ text, required }),
    }),
  updateStep: (
    id: number,
    fields: { text?: string; required?: boolean; description?: string | null },
  ) =>
    request<Step>(`/steps/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(fields),
    }),
  deleteStep: (id: number) => request<void>(`/steps/${id}`, { method: 'DELETE' }),
  reorderSteps: (checklistId: number, stepIds: number[]) =>
    request<ChecklistWithSteps>(`/checklists/${checklistId}/reorder-steps`, {
      method: 'POST',
      body: JSON.stringify({ stepIds }),
    }),

  // Active / runs
  getActive: () => request<ActiveState>('/active'),
  startRun: () => request<ActiveState>('/runs/start', { method: 'POST' }),
  resetRun: () => request<ActiveState>('/runs/reset', { method: 'POST' }),
  toggleStep: (stepId: number) =>
    request<ActiveState>(`/runs/current/steps/${stepId}/toggle`, { method: 'POST' }),

  // Brewery to-do list
  listTodos: () => request<Todo[]>('/todos'),
  createTodo: (text: string) =>
    request<Todo>('/todos', { method: 'POST', body: JSON.stringify({ text }) }),
  updateTodo: (
    id: number,
    fields: { text?: string; done?: boolean; description?: string | null },
  ) =>
    request<Todo>(`/todos/${id}`, { method: 'PATCH', body: JSON.stringify(fields) }),
  deleteTodo: (id: number) => request<void>(`/todos/${id}`, { method: 'DELETE' }),
  reorderTodos: (todoIds: number[]) =>
    request<Todo[]>('/todos/reorder', { method: 'POST', body: JSON.stringify({ todoIds }) }),
  clearCompletedTodos: () =>
    request<Todo[]>('/todos/clear-completed', { method: 'POST' }),

  // Telemetry devices (fermentation pressure, brew controller, …)
  // The server serves real sensor data when available, otherwise mock fallback
  // data, so every client sees the same telemetry contract.
  listDevices: () => request<DeviceStatus[]>('/devices'),
  getDevice: (id: number) => request<DeviceStatus>(`/devices/${id}`),
  // `buckets` averages the window into that many evenly-spaced points instead of
  // returning raw rows — the right call for a preview that only has a few
  // hundred pixels to spend. See historyQuerySchema for why `limit` can't
  // stand in for it.
  getDeviceHistory: (
    id: number,
    opts: { metric?: string; since?: string; limit?: number; buckets?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.metric) params.set('metric', opts.metric);
    if (opts.since) params.set('since', opts.since);
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.buckets) params.set('buckets', String(opts.buckets));
    const qs = params.toString();
    return request<Reading[]>(`/devices/${id}/history${qs ? `?${qs}` : ''}`);
  },
  getDeviceTotal: (id: number, metric: string) =>
    request<MetricTotal>(`/devices/${id}/total?metric=${encodeURIComponent(metric)}`),
  // Queue a new target setpoint (°C) for a brew controller. The change is
  // applied asynchronously by the device's agent; the response echoes the
  // now-pending target (surfaced on the device's status as pendingSetpointC).
  setDeviceSetpoint: (id: number, value: number) =>
    request<{ pendingSetpointC: number }>(`/devices/${id}/setpoint`, {
      method: 'POST',
      body: JSON.stringify({ value }),
    }),
  // Change a device's logging cadence (seconds) — the single per-device interval
  // the agent matches its push rate to and the dashboards poll at. Admin/local
  // only; the agent adopts it on its next push. Echoes the saved value.
  setDeviceInterval: (id: number, reportingIntervalSec: number) =>
    request<{ reportingIntervalSec: number }>(`/devices/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ reportingIntervalSec }),
    }),

  // Per-sensor mock/real data source choice (server-shared, edited from the
  // Settings page). The whole map is sent on each save, like the colour palettes.
  getDeviceSources: () => request<DeviceDataSources>('/device-sources'),
  updateDeviceSources: (sources: DeviceDataSources) =>
    request<DeviceDataSources>('/device-sources', {
      method: 'PUT',
      body: JSON.stringify(sources),
    }),

  // Brewer's Friend recipes. listRecipes proxies the user's account via the
  // server (the API key stays server-side); the active recipe is the one shown
  // on the kiosk fermenter card.
  // `_refresh` is retained for the session-cache call sites; the server-side
  // library is already the source of truth.
  listRecipes: (_refresh = false) => request<Recipe[]>('/recipes'),
  // Every recipe's cost and hop rate, derived from its stored ingredient list.
  listRecipeStats: (_refresh = false) => request<RecipeStatsResponse>('/recipes/stats'),
  // One recipe's full brew sheet (ingredients, mash, water), for the detail page.
  getRecipe: (id: string) => request<RecipeDetail>(`/recipes/${encodeURIComponent(id)}`),
  createRecipe: (recipe: RecipeEditInput) =>
    request<RecipeDetail>('/recipes', {
      method: 'POST',
      body: JSON.stringify(recipe),
    }),
  updateRecipe: (id: string, recipe: RecipeEditInput) =>
    request<RecipeDetail>(`/recipes/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(recipe),
    }),
  // The figures a blank brew sheet opens on. Server-shared, so the kiosk, a
  // laptop and the phone all start a new recipe on the same brewhouse.
  getRecipeDefaults: () => request<RecipeDefaults>('/recipe-defaults'),
  updateRecipeDefaults: (defaults: RecipeDefaults) =>
    request<RecipeDefaults>('/recipe-defaults', {
      method: 'PUT',
      body: JSON.stringify(defaults),
    }),
  // What the sheet in the editor costs as it stands. Saves nothing: the prices
  // live in the server's catalogue, so an unsaved draft has to ask for them.
  priceRecipe: (recipe: RecipeEditInput) =>
    request<RecipeCostBreakdown>('/recipes/price', {
      method: 'POST',
      body: JSON.stringify(recipe),
    }),
  deleteRecipe: (id: string) =>
    request<void>(`/recipes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  importBrewersFriendRecipes: () =>
    request<RecipeImportResult>('/recipes/import/brewersfriend', { method: 'POST' }),
  // Nightly recipe backups: what the last one did, and a way to take one now.
  getRecipeBackupStatus: () => request<RecipeBackupStatus>('/recipes/backup'),
  backupRecipes: () => request<RecipeBackupResult>('/recipes/backup', { method: 'POST' }),
  // Ingredients to offer in the editor's pickers: the shop's catalogue, plus —
  // unless `catalogueOnly` — whatever saved recipes have called for before.
  searchRecipeIngredients: (
    kind: IngredientKind,
    q: string,
    options: { catalogueOnly?: boolean } = {},
  ) =>
    request<RecipeIngredientOption[]>(
      `/recipes/catalog?${new URLSearchParams({
        kind,
        q,
        ...(options.catalogueOnly ? { catalogueOnly: 'true' } : {}),
      }).toString()}`,
    ),
  // Today's daytime average outside — where a new recipe's grain temperature
  // starts. Null whenever the weather service couldn't be reached.
  getOutdoorTemperature: () =>
    request<{ outdoor: OutdoorTemperature | null }>('/weather/outdoor').then((r) => r.outdoor),
  getActiveRecipe: () => request<ActiveRecipe>('/recipe').then((r) => r.recipe),
  setActiveRecipe: (recipe: Recipe) =>
    request<ActiveRecipe>('/recipe', {
      method: 'PUT',
      body: JSON.stringify(recipe),
    }).then((r) => r.recipe),
  clearActiveRecipe: () => request<void>('/recipe', { method: 'DELETE' }),

  // The brewery's logbook. Starting a brew day snapshots the recipe as it reads
  // today (targets, cost, weights) onto the entry and puts the beer in the
  // fermenter; from there the entry is edited as the batch progresses.
  listBrewDays: () => request<BrewDay[]>('/brew-days'),
  getBrewDay: (id: number) => request<BrewDayDetail>(`/brew-days/${id}`),
  // How many times each recipe has been brewed, for the badges on the grid.
  listRecipeBrewCounts: () => request<RecipeBrewCount[]>('/brew-days/counts'),
  // `brewedAt` back-dates a brew that already happened; omit it for "brewing now".
  startBrewDay: (recipeId: string, brewedAt?: string) =>
    request<BrewDay>('/brew-days', {
      method: 'POST',
      body: JSON.stringify(brewedAt ? { recipeId, brewedAt } : { recipeId }),
    }),
  updateBrewDay: (id: number, fields: UpdateBrewDayInput) =>
    request<BrewDay>(`/brew-days/${id}`, { method: 'PATCH', body: JSON.stringify(fields) }),
  deleteBrewDay: (id: number) => request<void>(`/brew-days/${id}`, { method: 'DELETE' }),

  // Whether the empty fermenter has been washed. Separate from the selection
  // above — emptying the tank doesn't clean it — and null until someone says.
  getFermenterState: () => request<FermenterStatus>('/fermenter').then((r) => r.state),
  setFermenterState: (state: FermenterState) =>
    request<FermenterStatus>('/fermenter', {
      method: 'PUT',
      body: JSON.stringify({ state }),
    }).then((r) => r.state),

  // Ingredient prices. A decision is stored per ingredient name rather than per
  // recipe — pricing "Voss Kveik" once holds wherever it's pitched — so saving
  // one re-costs every recipe that uses it.
  //
  // The amount travels with a read because "cheapest" is a per-line judgement (a
  // 25 g pitch is cheaper as one sachet than as three), and a fermentable's
  // colour travels too, since the automatic match uses it to reject a
  // same-grain-wrong-roast listing.
  getPriceOptions: (line: {
    kind: IngredientKind;
    name: string;
    grams?: number | null;
    units?: number | null;
    ebc?: number | null;
  }) =>
    request<IngredientPriceOptions>(`/prices/options?${priceQuery(line)}`),
  searchPrices: (query: {
    kind: IngredientKind;
    q: string;
    grams?: number | null;
    units?: number | null;
  }) =>
    request<{ results: PriceOption[] }>(`/prices/search?${priceQuery(query)}`).then(
      (r) => r.results,
    ),
  savePriceOverride: (override: PriceOverrideInput) =>
    request<IngredientPriceOverride>('/prices/override', {
      method: 'PUT',
      body: JSON.stringify(override),
    }),
  clearPriceOverride: (kind: IngredientKind, name: string) =>
    request<void>(`/prices/override?${priceQuery({ kind, name })}`, { method: 'DELETE' }),

  // Notification preferences (server-backed, shared across browsers) + a test
  // send so the user can confirm Telegram delivery from the Settings screen.
  getNotificationSettings: () =>
    request<NotificationSettings>('/notifications/settings'),
  updateNotificationSettings: (settings: NotificationSettings) =>
    request<NotificationSettings>('/notifications/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  sendTestNotification: () =>
    request<{ sent: boolean }>('/notifications/test', { method: 'POST' }),

  // Recorded alert history (device offline episodes, keg-age and
  // fermentation-complete events), newest first.
  listAlerts: (limit?: number) =>
    request<Alert[]>(`/alerts${limit ? `?limit=${limit}` : ''}`),

  // Dismiss an alert (clicked away on the dashboard); removes it from every feed.
  dismissAlert: (id: number) => request<void>(`/alerts/${id}`, { method: 'DELETE' }),

  // Dismiss every alert at once; resolves with how many were cleared.
  clearAlerts: () => request<{ dismissed: number }>('/alerts/clear', { method: 'POST' }),

  // Change history: the audit log of admin changes, newest first (admin-only).
  listAudit: (limit?: number) =>
    request<AuditEntry[]>(`/history${limit ? `?limit=${limit}` : ''}`),

  // Shared chart colour palette (edited on the desktop Settings page, read by
  // every screen including the kiosk).
  getGraphColors: () => request<GraphColors>('/graph-colors'),
  updateGraphColors: (colors: GraphColors) =>
    request<GraphColors>('/graph-colors', {
      method: 'PUT',
      body: JSON.stringify(colors),
    }),

  // Shared keg content colour palette, used by `/api/kegs`.
  getKegContentColors: () => request<KegContentColors>('/keg-content-colors'),
  updateKegContentColors: (colors: KegContentColors) =>
    request<KegContentColors>('/keg-content-colors', {
      method: 'PUT',
      body: JSON.stringify(colors),
    }),

  // Keg inventory, enriched server-side with the saved content colours.
  getKegs: () => request<Keg[]>('/kegs'),
  // Write one keg's editable fields back to the shared sheet (desktop only). The
  // server proxies a Google Apps Script write; 204 on success. Volume is left
  // untouched (it's not sent).
  updateKeg: (
    number: string,
    fields: { contents: string; date: string; note: string; abv: string; recipeId: string },
  ) =>
    request<void>(`/kegs/${encodeURIComponent(number)}`, {
      method: 'PUT',
      body: JSON.stringify(fields),
    }),

  // Account administration (admin-only; the server guards these with
  // requireAdmin). Lets an admin list every account and add/remove one, change a
  // role, or reset a password from the desktop Settings page.
  listAccounts: () => request<User[]>('/accounts'),
  createAccount: (username: string, password: string, role: UserRole) =>
    request<User>('/accounts', {
      method: 'POST',
      body: JSON.stringify({ username, password, role }),
    }),
  setAccountRole: (id: number, role: UserRole) =>
    request<User>(`/accounts/${id}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }),
  setAccountPassword: (id: number, newPassword: string) =>
    request<User>(`/accounts/${id}/password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword }),
    }),
  deleteAccount: (id: number) => request<void>(`/accounts/${id}`, { method: 'DELETE' }),

  // Brewery speaker (Sonos / IKEA SYMFONISK) — now-playing + transport control,
  // driven server-side over the LAN. The controls are admin/local-only (the
  // kiosk on the Pi passes); a 503 means no speaker was reachable.
  getNowPlaying: () => request<NowPlaying>('/music/now-playing'),
  musicPlay: () => request<void>('/music/play', { method: 'POST' }),
  musicPause: () => request<void>('/music/pause', { method: 'POST' }),
  musicNext: () => request<void>('/music/next', { method: 'POST' }),
  musicPrevious: () => request<void>('/music/previous', { method: 'POST' }),
  musicSetVolume: (volume: number) =>
    request<void>('/music/volume', { method: 'POST', body: JSON.stringify({ volume }) }),
  musicSeek: (positionSec: number) =>
    request<void>('/music/seek', { method: 'POST', body: JSON.stringify({ positionSec }) }),

  // Software update (admin-only). triggerUpdate starts a remote deploy (git pull
  // + rebuild + restart) on the Pi and returns immediately; poll getUpdateStatus
  // for progress. The server briefly restarts itself mid-deploy, so callers
  // should tolerate transient request failures while polling.
  triggerUpdate: () => request<SystemUpdateStatus>('/system/update', { method: 'POST' }),
  getUpdateStatus: () => request<SystemUpdateStatus>('/system/update/status'),

  // Brew system update (admin-only). Same pattern, but the target is the rig's
  // Pi over SSH, so this server stays up throughout — no restart blip to
  // tolerate. Refused with 409 while the rig is heating or pumping.
  triggerBrewSystemUpdate: () =>
    request<BrewSystemUpdateStatus>('/system/brew-system-update', { method: 'POST' }),
  getBrewSystemUpdateStatus: () =>
    request<BrewSystemUpdateStatus>('/system/brew-system-update/status'),

  // The two Raspberry Pis themselves (this one and the rig's), for the Devices
  // page. Server-side cached, so polling is cheap; the rig is absent from the
  // list when no rig is configured.
  listHosts: () => request<HostStatus[]>('/system/hosts'),

  // Brewing rig (brew-system-v3 Pi), proxied server-side over the LAN. Reads
  // answer `{ online: false }` when the rig is powered off (its normal state
  // between brew days); controls are admin-only and 502 when it's unreachable.
  getBrewSystemState: () => request<BrewSystemStatus>('/brew-system/state'),
  getBrewSystemConfig: () => request<BrewSystemConfig>('/brew-system/config'),
  setBrewPotPower: (pot: BrewPot, on: boolean) =>
    request<void>(`/brew-system/pot/${pot}/power`, { method: 'POST', body: JSON.stringify({ on }) }),
  setBrewPotEfficiency: (pot: BrewPot, value: number) =>
    request<void>(`/brew-system/pot/${pot}/efficiency`, { method: 'POST', body: JSON.stringify({ value }) }),
  setBrewPotSv: (pot: BrewPot, value: number) =>
    request<void>(`/brew-system/pot/${pot}/sv`, { method: 'POST', body: JSON.stringify({ value }) }),
  setBrewPotRegulation: (pot: BrewPot, enabled: boolean) =>
    request<void>(`/brew-system/pot/${pot}/regulation`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  setBrewPumpPower: (pump: BrewPump, on: boolean) =>
    request<void>(`/brew-system/pump/${pump}/power`, { method: 'POST', body: JSON.stringify({ on }) }),
  setBrewPumpSpeed: (pump: BrewPump, value: number) =>
    request<void>(`/brew-system/pump/${pump}/speed`, { method: 'POST', body: JSON.stringify({ value }) }),
  brewTimerAction: (action: 'start' | 'stop' | 'reset' | 'set', seconds?: number) =>
    request<void>('/brew-system/timer', {
      method: 'POST',
      body: JSON.stringify(seconds === undefined ? { action } : { action, seconds }),
    }),

  // Bruce, the voice assistant (apps/bruce), proxied server-side from his
  // loopback API. Status answers `{ online: false }` when the service is down;
  // speak/volume are admin-only and 502 when he's unreachable.
  getBruceStatus: () => request<BruceServiceStatus>('/bruce/status'),
  bruceSpeak: (message: string) =>
    request<{ ok: boolean }>('/bruce/speak', { method: 'POST', body: JSON.stringify({ message }) }),
  bruceSetVolume: (percent: number) =>
    request<{ volumePercent: number }>('/bruce/volume', {
      method: 'POST',
      body: JSON.stringify({ percent }),
    }),

  // Bruce's text chat. Answered by the server itself from the indexed brewing
  // books (not by the voice service), so it works with Bruce's hardware
  // offline. Asking is admin-only and can take a few seconds.
  getBruceChat: (conversationId?: number) =>
    request<BruceChatState>(
      conversationId ? `/bruce/chat?conversation=${conversationId}` : '/bruce/chat',
    ),
  askBruce: (message: string, conversationId: number, onPhase?: (phase: BrucePhase) => void) =>
    askBruce(message, conversationId, onPhase),
  clearBruceChat: (conversationId: number) =>
    request<void>(`/bruce/chat?conversation=${conversationId}`, { method: 'DELETE' }),
  setBruceChatModel: (model: string) =>
    request<{ model: string }>('/bruce/chat/model', {
      method: 'POST',
      body: JSON.stringify({ model }),
    }),
  setBruceWebSearch: (enabled: boolean) =>
    request<{ enabled: boolean }>('/bruce/chat/web-search', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),

  // Chat threads: separate conversations so a brew day's water questions stay
  // apart from last month's hop reading.
  newBruceConversation: () =>
    request<BruceConversation>('/bruce/chat/conversations', { method: 'POST' }),
  renameBruceConversation: (id: number, title: string) =>
    request<BruceConversation>(`/bruce/chat/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  deleteBruceConversation: (id: number) =>
    request<void>(`/bruce/chat/conversations/${id}`, { method: 'DELETE' }),

  // Bruce's library. Uploading a book indexes it, which takes a minute or two,
  // so these return the job rather than waiting for it — poll getBruceKnowledge
  // while `job.state === 'running'`.
  getBruceKnowledge: () => request<BruceKnowledgeState>('/bruce/knowledge'),
  addBruceBook: (file: string, content: string) =>
    request<BruceKnowledgeState>('/bruce/knowledge/files', {
      method: 'POST',
      body: JSON.stringify({ file, content }),
    }),
  reindexBruceKnowledge: (force = false) =>
    request<BruceKnowledgeState>('/bruce/knowledge/reindex', {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),
  // Read a book on the shelf. A chapter at a time — the books are ~600 KB of
  // markdown each, and the table of contents comes back with every chapter.
  getBruceBook: (file: string, chapter?: number) =>
    request<BruceBook>(
      `/bruce/knowledge/files/${encodeURIComponent(file)}${chapter != null ? `?chapter=${chapter}` : ''}`,
    ),

  // Bruce's persona (knowledge/PROMPT.md). Saving empty text reverts to the
  // built-in instructions.
  getBruceInstructions: () => request<BruceInstructions>('/bruce/instructions'),
  saveBruceInstructions: (text: string) =>
    request<BruceInstructions>('/bruce/instructions', {
      method: 'PUT',
      body: JSON.stringify({ text }),
    }),
};
