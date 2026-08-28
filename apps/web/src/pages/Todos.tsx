import type { Todo, TodoCategory } from '@checklist/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { canControl, useAuth } from '../auth';
import { DashboardShell } from '../components/DashboardShell';
import { Select } from '../components/Select';
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

/** Which sections are folded. Per-browser convenience, not shared state. */
const COLLAPSE_KEY = 'todos.collapsedCategories';

/**
 * Key for the catch-all section. It is deliberately not a category row —
 * "Uncategorised" is the *absence* of one, so it has no id to key on, and every
 * task that has never been filed lives here without anything being created.
 */
const UNCATEGORISED = 'uncategorised';

function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function rememberCollapsed(next: Record<string, boolean>): Record<string, boolean> {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
  } catch {
    // A section that won't stay folded is not worth failing the page over.
  }
  return next;
}

function TodoManager({ onError }: { onError: (msg: string | null) => void }) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [categories, setCategories] = useState<TodoCategory[]>([]);
  const [text, setText] = useState('');
  const [categoryName, setCategoryName] = useState('');
  /** Which section the add-a-task field files into. '' is Uncategorised. */
  const [addTo, setAddTo] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const { auth } = useAuth();
  // Guests can read the list but can't add, tick off, edit, or remove tasks —
  // nor manage the categories they sit in.
  const controllable = canControl(auth);

  const refresh = useCallback(async () => {
    // One render for both, so the page never paints tasks against a category
    // list that hasn't caught up with them.
    const [nextTodos, nextCategories] = await Promise.all([
      api.listTodos(),
      api.listTodoCategories(),
    ]);
    setTodos(nextTodos);
    setCategories(nextCategories);
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

  const toggleSection = (key: string) =>
    setCollapsed((prev) => rememberCollapsed({ ...prev, [key]: !prev[key] }));

  const categoryOptions = useMemo(
    () => [
      { value: '', label: 'Uncategorised' },
      ...categories.map((c) => ({ value: String(c.id), label: c.name })),
    ],
    [categories],
  );

  /** Tasks bucketed by section, in the order the sections are rendered. */
  const grouped = useMemo(() => {
    const buckets = new Map<string, Todo[]>();
    buckets.set(UNCATEGORISED, []);
    for (const c of categories) buckets.set(String(c.id), []);
    for (const t of todos) {
      const key = t.categoryId === null ? UNCATEGORISED : String(t.categoryId);
      // A task pointing at a category this page doesn't know about — deleted in
      // another tab between the two requests — still has to appear somewhere.
      (buckets.get(key) ?? buckets.get(UNCATEGORISED)!).push(t);
    }
    return buckets;
  }, [todos, categories]);

  const openCount = todos.filter((t) => !t.done).length;
  const hasCompleted = todos.some((t) => t.done);
  const loose = grouped.get(UNCATEGORISED) ?? [];

  function section(key: string, name: string, items: Todo[], category: TodoCategory | null) {
    return (
      <CategorySection
        key={key}
        name={name}
        openCount={items.filter((t) => !t.done).length}
        open={!collapsed[key]}
        onToggle={() => toggleSection(key)}
        onRename={
          category && controllable
            ? (next) => void run(() => api.renameTodoCategory(category.id, next))
            : undefined
        }
        onDelete={
          category && controllable
            ? () => {
                // Spell out that the tasks survive: "delete" on something that
                // visibly contains things reads like it takes them with it.
                const kept = items.length === 1 ? 'Its 1 task moves' : `Its ${items.length} tasks move`;
                const warning =
                  items.length === 0
                    ? `Delete the category "${category.name}"?`
                    : `Delete the category "${category.name}"?\n\n${kept} to Uncategorised.`;
                if (window.confirm(warning)) void run(() => api.deleteTodoCategory(category.id));
              }
            : undefined
        }
      >
        {items.length === 0 ? (
          <li className="px-3 py-2 text-sm text-zinc-400">Nothing filed here yet.</li>
        ) : (
          items.map((t) => (
            <TodoRow
              key={t.id}
              todo={t}
              controllable={controllable}
              categoryOptions={categoryOptions}
              onToggle={() => void run(() => api.updateTodo(t.id, { done: !t.done }))}
              onSave={(fields) => void run(() => api.updateTodo(t.id, fields))}
              onDelete={() => void run(() => api.deleteTodo(t.id))}
            />
          ))
        )}
      </CategorySection>
    );
  }

  return (
    <div className="w-full max-w-3xl p-6">
      {/* Add task */}
      {controllable && (
        <form
          className="mt-5 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const value = text.trim();
            if (!value) return;
            void run(() => api.createTodo(value, addTo ? Number(addTo) : null)).then(() =>
              setText(''),
            );
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Add a brewery task…"
            className="flex-1 rounded-md border border-zinc-700 px-3 py-2 focus:border-[#f87a68] focus:outline-none"
          />
          <Select
            value={addTo}
            options={categoryOptions}
            onChange={setAddTo}
            aria-label="File the new task under"
            className="rounded-md border border-zinc-700 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="rounded-md bg-gradient-to-br from-[#f87a68] to-[#e0463f] px-4 py-2 text-sm font-medium text-white shadow transition hover:brightness-110"
          >
            Add
          </button>
        </form>
      )}

      {/* Add category */}
      {controllable && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const value = categoryName.trim();
            if (!value) return;
            void run(() => api.createTodoCategory(value)).then(() => setCategoryName(''));
          }}
        >
          <input
            value={categoryName}
            onChange={(e) => setCategoryName(e.target.value)}
            placeholder="New category…"
            className="flex-1 rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-1.5 text-sm focus:border-[#f87a68] focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm font-medium hover:bg-zinc-800"
          >
            Add category
          </button>
        </form>
      )}

      <div className="mt-6 mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Tasks ({openCount} open)
        </span>
        {controllable && hasCompleted && (
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

      <div className="flex flex-col gap-2">
        {categories.map((c) => section(String(c.id), c.name, grouped.get(String(c.id)) ?? [], c))}
        {/* The catch-all only earns a heading once something is in it. With no
            categories yet every task is in here, so this *is* the list. */}
        {loose.length > 0 && section(UNCATEGORISED, 'Uncategorised', loose, null)}
        {todos.length === 0 && categories.length === 0 && (
          <p className="text-sm text-zinc-400">No tasks yet.</p>
        )}
      </div>
    </div>
  );
}

/**
 * One collapsible section of the list. The whole header is the fold toggle, so
 * the obvious thing to click does the obvious thing; renaming and deleting sit
 * outside that button because a control nested in a button is neither
 * clickable nor announced properly.
 */
function CategorySection({
  name,
  openCount,
  open,
  onToggle,
  onRename,
  onDelete,
  children,
}: {
  name: string;
  openCount: number;
  open: boolean;
  onToggle: () => void;
  /** Absent for guests, and for "Uncategorised", which has no row to rename. */
  onRename?: (name: string) => void;
  onDelete?: () => void;
  children: React.ReactNode;
}): JSX.Element {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);

  function commitRename() {
    setRenaming(false);
    const next = draft.trim();
    if (next && next !== name) onRename?.(next);
    else setDraft(name);
  }

  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center gap-1 pr-2">
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') {
                setDraft(name);
                setRenaming(false);
              }
            }}
            aria-label="Category name"
            className="m-2 flex-1 rounded border border-zinc-700 px-2 py-1 text-sm focus:border-[#f87a68] focus:outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left transition hover:bg-zinc-800/50"
          >
            <span className={`shrink-0 text-zinc-500 transition-transform ${open ? '' : '-rotate-90'}`} aria-hidden>
              ⌄
            </span>
            <span className="truncate text-sm font-semibold text-zinc-100">{name}</span>
            <span className="shrink-0 text-xs text-zinc-500">{openCount} open</span>
          </button>
        )}
        {onRename && !renaming && (
          <button
            type="button"
            onClick={() => setRenaming(true)}
            className="shrink-0 rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800"
            aria-label={`Rename ${name}`}
          >
            ✎
          </button>
        )}
        {onDelete && !renaming && (
          <button
            type="button"
            onClick={onDelete}
            className="shrink-0 rounded px-2 py-1 text-sm text-red-400 hover:bg-red-500/10"
            aria-label={`Delete ${name}`}
          >
            ✕
          </button>
        )}
      </div>
      {open && <ul className="flex flex-col gap-2 border-t border-zinc-800 p-2">{children}</ul>}
    </section>
  );
}

function TodoRow({
  todo,
  controllable,
  categoryOptions,
  onToggle,
  onSave,
  onDelete,
}: {
  todo: Todo;
  controllable: boolean;
  categoryOptions: readonly { value: string; label: string }[];
  onToggle: () => void;
  onSave: (fields: { text?: string; description?: string | null; categoryId?: number | null }) => void;
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
        disabled={!controllable}
        onChange={onToggle}
        className="mt-1.5 h-5 w-5 shrink-0"
        aria-label={todo.done ? 'Mark not done' : 'Mark done'}
      />
      <div className="flex flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <input
            value={value}
            readOnly={!controllable}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => {
              if (controllable && value.trim() && value.trim() !== todo.text) onSave({ text: value.trim() });
            }}
            className={`flex-1 rounded border border-transparent px-2 py-1 focus:border-[#f87a68] focus:outline-none ${
              todo.done ? 'text-zinc-400 line-through' : ''
            }`}
          />
          {controllable && (
            <Select
              value={todo.categoryId === null ? '' : String(todo.categoryId)}
              options={categoryOptions}
              onChange={(next) => onSave({ categoryId: next ? Number(next) : null })}
              aria-label={`Category for ${todo.text}`}
              className="shrink-0 rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-400"
            />
          )}
          {controllable && (
            <button
              type="button"
              onClick={onDelete}
              className="shrink-0 rounded px-2 py-1 text-sm text-red-400 hover:bg-red-500/10"
              aria-label="Delete task"
            >
              ✕
            </button>
          )}
        </div>
        {(controllable || desc) && (
          <textarea
            value={desc}
            readOnly={!controllable}
            onChange={(e) => setDesc(e.target.value)}
            onBlur={() => {
              if (controllable && desc !== (todo.description ?? '')) onSave({ description: desc });
            }}
            rows={desc ? 2 : 1}
            placeholder="Add a description (optional)…"
            className="resize-y rounded border border-transparent px-2 py-1 text-sm text-zinc-300 placeholder:text-zinc-400 focus:border-[#f87a68] focus:outline-none"
          />
        )}
      </div>
    </li>
  );
}
