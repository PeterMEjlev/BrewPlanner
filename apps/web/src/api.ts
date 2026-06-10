import type {
  ActiveState,
  ChecklistSummary,
  ChecklistWithSteps,
  Step,
  Todo,
} from '@checklist/shared';

const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only send a JSON content-type when there's actually a body — Fastify
  // rejects an empty body that declares `Content-Type: application/json`.
  const headers = init?.body ? { 'Content-Type': 'application/json' } : undefined;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
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
};
