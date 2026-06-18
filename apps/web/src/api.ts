import type {
  ActiveRecipe,
  ActiveState,
  Alert,
  AuthState,
  ChecklistSummary,
  ChecklistWithSteps,
  DeviceStatus,
  GraphColors,
  Keg,
  KegContentColors,
  MetricTotal,
  NotificationSettings,
  Reading,
  Recipe,
  Step,
  Todo,
} from '@checklist/shared';

const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only send a JSON content-type when there's actually a body — Fastify
  // rejects an empty body that declares `Content-Type: application/json`.
  const headers = init?.body ? { 'Content-Type': 'application/json' } : undefined;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  // A 401 on a normal request means the session expired (or never existed for
  // a remote client). Bounce to the login page — except on /auth/* calls,
  // where the caller handles the status itself (e.g. wrong password on login).
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.location.assign('/login');
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

export const api = {
  // Auth
  getAuth: () => request<AuthState>('/auth/me'),
  login: (username: string, password: string) =>
    request<AuthState>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<AuthState>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
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
  getDeviceHistory: (
    id: number,
    opts: { metric?: string; since?: string; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.metric) params.set('metric', opts.metric);
    if (opts.since) params.set('since', opts.since);
    if (opts.limit) params.set('limit', String(opts.limit));
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

  // Brewer's Friend recipes. listRecipes proxies the user's account via the
  // server (the API key stays server-side); the active recipe is the one shown
  // on the kiosk fermenter card.
  listRecipes: () => request<Recipe[]>('/recipes'),
  getActiveRecipe: () => request<ActiveRecipe>('/recipe').then((r) => r.recipe),
  setActiveRecipe: (recipe: Recipe) =>
    request<ActiveRecipe>('/recipe', {
      method: 'PUT',
      body: JSON.stringify(recipe),
    }).then((r) => r.recipe),
  clearActiveRecipe: () => request<void>('/recipe', { method: 'DELETE' }),

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
    fields: { contents: string; date: string; note: string; abv: string },
  ) =>
    request<void>(`/kegs/${encodeURIComponent(number)}`, {
      method: 'PUT',
      body: JSON.stringify(fields),
    }),
};
