import type {
  ActiveState,
  ChecklistSummary,
  ChecklistWithSteps,
} from '@checklist/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { asMessage } from '../util';

/**
 * Checklist admin: manage procedure checklists and their steps. The brewery
 * to-do list is a separate page ([TodosPage]); both are reached from the
 * dashboard so neither carries the other's chrome.
 */
export function AdminPage() {
  const { auth, refresh: refreshAuth } = useAuth();
  const [checklists, setChecklists] = useState<ChecklistSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<ChecklistWithSteps | null>(null);
  const [active, setActive] = useState<ActiveState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    const list = await api.listChecklists();
    setChecklists(list);
    return list;
  }, []);

  const refreshActive = useCallback(async () => {
    setActive(await api.getActive());
  }, []);

  const loadSelected = useCallback(async (id: number) => {
    setSelected(await api.getChecklist(id));
  }, []);

  // Initial load.
  useEffect(() => {
    void (async () => {
      try {
        const list = await refreshList();
        await refreshActive();
        if (list.length > 0 && list[0]) setSelectedId(list[0].id);
      } catch (e) {
        setError(asMessage(e));
      }
    })();
  }, [refreshList, refreshActive]);

  // Load detail whenever selection changes.
  useEffect(() => {
    if (selectedId == null) {
      setSelected(null);
      return;
    }
    void loadSelected(selectedId).catch((e) => setError(asMessage(e)));
  }, [selectedId, loadSelected]);

  async function run(action: () => Promise<unknown>) {
    try {
      setError(null);
      await action();
      await refreshList();
      await refreshActive();
      if (selectedId != null) await loadSelected(selectedId);
    } catch (e) {
      setError(asMessage(e));
    }
  }

  async function createChecklist() {
    const name = window.prompt('New checklist name:')?.trim();
    if (!name) return;
    try {
      setError(null);
      const created = await api.createChecklist(name);
      await refreshList();
      setSelectedId(created.id);
    } catch (e) {
      setError(asMessage(e));
    }
  }

  return (
    <div className="flex h-full bg-slate-950 text-slate-100">
      {/* Sidebar */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-slate-800 bg-slate-900">
        {/* Back to the hub dashboard */}
        <Link
          to="/"
          className="border-b border-slate-800 px-4 py-2 text-sm text-slate-500 hover:bg-slate-800 hover:text-slate-100"
        >
          ← Dashboard
        </Link>
        <div className="flex items-center justify-between border-b border-slate-800 p-4">
          <h1 className="text-lg font-bold">Checklists</h1>
          <button
            type="button"
            onClick={() => void createChecklist()}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            + New
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          {checklists.length === 0 ? (
            <p className="p-3 text-sm text-slate-500">No checklists yet.</p>
          ) : (
            checklists.map((c) => (
              <button
                type="button"
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className={`mb-1 flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ${
                  c.id === selectedId
                    ? 'bg-blue-500/15 text-blue-300'
                    : 'hover:bg-slate-800'
                }`}
              >
                <span className="truncate font-medium">{c.name}</span>
                <span className="ml-2 flex shrink-0 items-center gap-2">
                  {c.isActive && (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-400">
                      active
                    </span>
                  )}
                  <span className="text-xs text-slate-400">{c.stepCount}</span>
                </span>
              </button>
            ))
          )}
        </nav>
        <a
          href="/display"
          target="_blank"
          rel="noreferrer"
          className="border-t border-slate-800 p-3 text-center text-sm text-blue-400 hover:underline"
        >
          Open display view ↗
        </a>
        {auth.user && (
          <div className="flex items-center justify-between border-t border-slate-800 px-3 py-2 text-sm">
            <span className="truncate text-slate-500">
              Signed in as <span className="font-medium text-slate-200">{auth.user.username}</span>
            </span>
            <button
              type="button"
              onClick={async () => {
                await api.logout();
                await refreshAuth();
              }}
              className="shrink-0 rounded-md px-2 py-1 text-slate-500 hover:bg-slate-800 hover:text-slate-100"
            >
              Sign out
            </button>
          </div>
        )}
      </aside>

      {/* Detail */}
      <main className="flex-1 overflow-y-auto">
        {error && (
          <div className="m-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
        {selected ? (
          <ChecklistEditor
            checklist={selected}
            active={active}
            onRun={run}
            onDeleted={() => {
              setSelectedId(null);
              void refreshList();
              void refreshActive();
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-slate-400">
            Select or create a checklist to begin.
          </div>
        )}
      </main>
    </div>
  );
}

function ChecklistEditor({
  checklist,
  active,
  onRun,
  onDeleted,
}: {
  checklist: ChecklistWithSteps;
  active: ActiveState | null;
  onRun: (action: () => Promise<unknown>) => Promise<void>;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(checklist.name);
  const [newStep, setNewStep] = useState('');

  useEffect(() => setName(checklist.name), [checklist.id, checklist.name]);

  const isActive = active?.checklist?.id === checklist.id;
  const steps = checklist.steps;

  return (
    <div className="mx-auto max-w-3xl p-6">
      {/* Name + actions */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name.trim() && name.trim() !== checklist.name) {
              void onRun(() => api.renameChecklist(checklist.id, name.trim()));
            }
          }}
          className="flex-1 rounded-md border border-slate-700 px-3 py-2 text-xl font-semibold focus:border-blue-500 focus:outline-none"
        />
        {isActive ? (
          <span className="rounded-md bg-emerald-500/15 px-3 py-2 text-sm font-semibold text-emerald-400">
            Active
          </span>
        ) : (
          <button
            type="button"
            onClick={() => void onRun(() => api.activateChecklist(checklist.id))}
            className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
          >
            Set active
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Delete checklist "${checklist.name}"? This cannot be undone.`)) {
              void api.deleteChecklist(checklist.id).then(onDeleted);
            }
          }}
          className="rounded-md border border-red-500/40 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10"
        >
          Delete
        </button>
      </div>

      {/* Active progress */}
      {isActive && active && (
        <div className="mt-4 flex items-center justify-between rounded-md border border-slate-800 bg-slate-900 px-4 py-3">
          <span className="text-sm text-slate-300">
            Progress:{' '}
            <span className="font-semibold text-slate-100">
              {active.progress.completed} / {active.progress.total}
            </span>{' '}
            complete
          </span>
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Reset progress for the active run?')) {
                void onRun(() => api.resetRun());
              }
            }}
            className="rounded-md border border-slate-700 px-3 py-1.5 text-sm font-medium hover:bg-slate-800"
          >
            Reset progress
          </button>
        </div>
      )}

      {/* Steps */}
      <h2 className="mt-8 mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Steps
      </h2>
      <ul className="flex flex-col gap-2">
        {steps.map((step, index) => (
          <StepRow
            key={step.id}
            text={step.text}
            description={step.description}
            required={step.required}
            isFirst={index === 0}
            isLast={index === steps.length - 1}
            onSave={(fields) => onRun(() => api.updateStep(step.id, fields))}
            onDelete={() => onRun(() => api.deleteStep(step.id))}
            onMove={(dir) => {
              const ids = steps.map((s) => s.id);
              const target = index + dir;
              if (target < 0 || target >= ids.length) return Promise.resolve();
              [ids[index], ids[target]] = [ids[target]!, ids[index]!];
              return onRun(() => api.reorderSteps(checklist.id, ids));
            }}
          />
        ))}
        {steps.length === 0 && <li className="text-sm text-slate-400">No steps yet.</li>}
      </ul>

      {/* Add step */}
      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const text = newStep.trim();
          if (!text) return;
          void onRun(() => api.addStep(checklist.id, text)).then(() => setNewStep(''));
        }}
      >
        <input
          value={newStep}
          onChange={(e) => setNewStep(e.target.value)}
          placeholder="Add a step…"
          className="flex-1 rounded-md border border-slate-700 px-3 py-2 focus:border-blue-500 focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Add
        </button>
      </form>
    </div>
  );
}

function StepRow({
  text,
  description,
  required,
  isFirst,
  isLast,
  onSave,
  onDelete,
  onMove,
}: {
  text: string;
  description: string | null;
  required: boolean;
  isFirst: boolean;
  isLast: boolean;
  onSave: (fields: {
    text?: string;
    required?: boolean;
    description?: string | null;
  }) => Promise<void>;
  onDelete: () => Promise<void>;
  onMove: (dir: -1 | 1) => Promise<void>;
}) {
  const [value, setValue] = useState(text);
  const [desc, setDesc] = useState(description ?? '');
  useEffect(() => setValue(text), [text]);
  useEffect(() => setDesc(description ?? ''), [description]);

  return (
    <li className="flex gap-2 rounded-md border border-slate-800 bg-slate-900 px-3 py-2">
      <div className="flex flex-col pt-1">
        <button
          type="button"
          disabled={isFirst}
          onClick={() => void onMove(-1)}
          className="px-1 text-slate-500 disabled:opacity-30 hover:text-slate-100"
          aria-label="Move up"
        >
          ▲
        </button>
        <button
          type="button"
          disabled={isLast}
          onClick={() => void onMove(1)}
          className="px-1 text-slate-500 disabled:opacity-30 hover:text-slate-100"
          aria-label="Move down"
        >
          ▼
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => {
              if (value.trim() && value.trim() !== text) void onSave({ text: value.trim() });
            }}
            className="flex-1 rounded border border-transparent px-2 py-1 focus:border-blue-500 focus:outline-none"
          />
          <label className="flex shrink-0 items-center gap-1 text-xs text-slate-500">
            <input
              type="checkbox"
              checked={required}
              onChange={(e) => void onSave({ required: e.target.checked })}
            />
            required
          </label>
          <button
            type="button"
            onClick={() => void onDelete()}
            className="shrink-0 rounded px-2 py-1 text-sm text-red-400 hover:bg-red-500/10"
            aria-label="Delete step"
          >
            ✕
          </button>
        </div>
        <textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onBlur={() => {
            if (desc !== (description ?? '')) void onSave({ description: desc });
          }}
          rows={desc ? 2 : 1}
          placeholder="Add a description (optional)…"
          className="resize-y rounded border border-transparent px-2 py-1 text-sm text-slate-300 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none"
        />
      </div>
    </li>
  );
}
