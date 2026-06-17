import type { Todo } from '@checklist/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { DashboardShell } from '../components/DashboardShell';
import { asMessage } from '../util';

/**
 * Standalone Brewery To-Do page. Deliberately separate from the checklist
 * admin (no checklist list / "+ New") — wrapped in the desktop [DashboardShell]
 * with its own nav entry. Shares the {@link TodoManager} list component with
 * nothing else; the checklist editor lives in its own page.
 */
export function TodosPage() {
  const [error, setError] = useState<string | null>(null);

  return (
    <DashboardShell active="todos">
      <main className="flex-1 overflow-y-auto">
        {error && (
          <div className="m-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
        <TodoManager onError={setError} />
      </main>
    </DashboardShell>
  );
}

function TodoManager({ onError }: { onError: (msg: string | null) => void }) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [text, setText] = useState('');

  const refresh = useCallback(async () => {
    setTodos(await api.listTodos());
  }, []);

  useEffect(() => {
    void refresh().catch((e) => onError(asMessage(e)));
  }, [refresh, onError]);

  async function run(action: () => Promise<unknown>) {
    try {
      onError(null);
      await action();
      await refresh();
    } catch (e) {
      onError(asMessage(e));
    }
  }

  const openCount = todos.filter((t) => !t.done).length;
  const hasCompleted = todos.some((t) => t.done);

  return (
    <div className="w-full max-w-3xl p-6">
      <h2 className="text-xl font-semibold">Brewery To-Do</h2>
      <p className="mt-1 text-sm text-zinc-500">
        A standalone task list, separate from procedure checklists. Add and edit tasks
        here; the touchscreen can tick them off.
      </p>

      {/* Add task */}
      <form
        className="mt-5 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const value = text.trim();
          if (!value) return;
          void run(() => api.createTodo(value)).then(() => setText(''));
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a brewery task…"
          className="flex-1 rounded-md border border-zinc-700 px-3 py-2 focus:border-blue-500 focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Add
        </button>
      </form>

      <div className="mt-6 mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Tasks ({openCount} open)
        </span>
        {hasCompleted && (
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Remove all completed tasks?')) {
                void run(() => api.clearCompletedTodos());
              }
            }}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm font-medium hover:bg-zinc-800"
          >
            Clear completed
          </button>
        )}
      </div>

      <ul className="flex flex-col gap-2">
        {todos.map((t) => (
          <TodoRow
            key={t.id}
            todo={t}
            onToggle={() => void run(() => api.updateTodo(t.id, { done: !t.done }))}
            onSave={(fields) => void run(() => api.updateTodo(t.id, fields))}
            onDelete={() => void run(() => api.deleteTodo(t.id))}
          />
        ))}
        {todos.length === 0 && <li className="text-sm text-zinc-400">No tasks yet.</li>}
      </ul>
    </div>
  );
}

function TodoRow({
  todo,
  onToggle,
  onSave,
  onDelete,
}: {
  todo: Todo;
  onToggle: () => void;
  onSave: (fields: { text?: string; description?: string | null }) => void;
  onDelete: () => void;
}) {
  const [value, setValue] = useState(todo.text);
  const [desc, setDesc] = useState(todo.description ?? '');
  useEffect(() => setValue(todo.text), [todo.text]);
  useEffect(() => setDesc(todo.description ?? ''), [todo.description]);

  return (
    <li className="flex gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
      <input
        type="checkbox"
        checked={todo.done}
        onChange={onToggle}
        className="mt-1.5 h-5 w-5 shrink-0"
        aria-label={todo.done ? 'Mark not done' : 'Mark done'}
      />
      <div className="flex flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => {
              if (value.trim() && value.trim() !== todo.text) onSave({ text: value.trim() });
            }}
            className={`flex-1 rounded border border-transparent px-2 py-1 focus:border-blue-500 focus:outline-none ${
              todo.done ? 'text-zinc-400 line-through' : ''
            }`}
          />
          <button
            type="button"
            onClick={onDelete}
            className="shrink-0 rounded px-2 py-1 text-sm text-red-400 hover:bg-red-500/10"
            aria-label="Delete task"
          >
            ✕
          </button>
        </div>
        <textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onBlur={() => {
            if (desc !== (todo.description ?? '')) onSave({ description: desc });
          }}
          rows={desc ? 2 : 1}
          placeholder="Add a description (optional)…"
          className="resize-y rounded border border-transparent px-2 py-1 text-sm text-zinc-300 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none"
        />
      </div>
    </li>
  );
}
