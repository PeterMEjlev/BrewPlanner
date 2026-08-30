import type { Todo, TodoCategory } from '@checklist/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { canControl, useAuth } from '../auth';
import { DashboardShell } from '../components/DashboardShell';
import {
  CheckCircleIcon,
  ChevronRightIcon,
  FolderIcon,
  MoreIcon,
  PencilIcon,
  PlusCircleIcon,
  TodoIcon,
  TrashIcon,
} from '../components/icons';
import { Popover } from '../components/Popover';
import { Select } from '../components/Select';
import { asMessage } from '../util';

/**
 * Standalone Brewery To-Do page: an add-task form over two columns — the open
 * work on the left, grouped by category, and the cards that support it on the
 * right (the categories themselves, and what has been ticked off).
 *
 * Deliberately separate from the checklist admin (no checklist list / "+ New");
 * the checklist editor lives in its own page.
 */
export function TodosPage(): JSX.Element {
  const [error, setError] = useState<string | null>(null);

  return (
    <DashboardShell active="todos">
      <main className="w-full max-w-[1500px] px-5 py-5">
        {error && (
          <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
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

/** Text fields: the add-task form and the inline row editors share one look. */
const FIELD =
  'w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-[#f87a68] focus:outline-none';
const ACCENT_BUTTON =
  'shrink-0 rounded-lg bg-gradient-to-br from-[#f87a68] to-[#e0463f] px-5 py-2.5 text-sm font-semibold text-white shadow transition hover:brightness-110';
const ACCENT_BUTTON_SM =
  'shrink-0 rounded-lg bg-gradient-to-br from-[#f87a68] to-[#e0463f] px-3.5 py-1.5 text-sm font-semibold text-white transition hover:brightness-110';
const GHOST_BUTTON =
  'rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100';

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

/** Newest first, by the moment the task was ticked off. */
function byMostRecentlyDone(a: Todo, b: Todo): number {
  return (b.doneAt ?? b.updatedAt).localeCompare(a.doneAt ?? a.updatedAt);
}

function TodoManager({ onError }: { onError: (msg: string | null) => void }): JSX.Element {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [categories, setCategories] = useState<TodoCategory[]>([]);
  const [text, setText] = useState('');
  /** Which section the add-a-task field files into. '' is Uncategorised. */
  const [addTo, setAddTo] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  /** The task open in the inline editor, and the field the editor opened on. */
  const [editing, setEditing] = useState<{ id: number; focus: 'text' | 'description' } | null>(null);
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

  const categoryOptions = useMemo(
    () => [
      { value: '', label: 'Uncategorised' },
      ...categories.map((c) => ({ value: String(c.id), label: c.name })),
    ],
    [categories],
  );

  const open = useMemo(() => todos.filter((t) => !t.done), [todos]);
  const completed = useMemo(() => todos.filter((t) => t.done).sort(byMostRecentlyDone), [todos]);

  /** Open tasks bucketed by section, in the order the sections are rendered. */
  const sections = useMemo(() => {
    const buckets = new Map<string, Todo[]>();
    for (const c of categories) buckets.set(String(c.id), []);
    // Last, so the fallback below always has somewhere to put a stray task.
    buckets.set(UNCATEGORISED, []);
    for (const t of open) {
      const key = t.categoryId === null ? UNCATEGORISED : String(t.categoryId);
      // A task pointing at a category this page doesn't know about — deleted in
      // another tab between the two requests — still has to appear somewhere.
      (buckets.get(key) ?? buckets.get(UNCATEGORISED)!).push(t);
    }
    return [
      ...categories.map((c) => ({
        key: String(c.id),
        name: c.name,
        items: buckets.get(String(c.id)) ?? [],
      })),
      { key: UNCATEGORISED, name: 'Uncategorised', items: buckets.get(UNCATEGORISED) ?? [] },
    ];
  }, [open, categories]);

  /** Only the sections with work in them; the empty ones are listed on the right. */
  const filled = sections.filter((s) => s.items.length > 0);
  const openCounts = useMemo(
    () => new Map(sections.map((s) => [s.key, s.items.length])),
    [sections],
  );

  const toggleSection = (key: string) =>
    setCollapsed((prev) => rememberCollapsed({ ...prev, [key]: !prev[key] }));
  const setAllCollapsed = (value: boolean) =>
    setCollapsed(rememberCollapsed(Object.fromEntries(sections.map((s) => [s.key, value]))));

  function deleteCategory(category: TodoCategory) {
    const held = todos.filter((t) => t.categoryId === category.id).length;
    // Spell out that the tasks survive: "delete" on something that visibly
    // contains things reads like it takes them with it.
    const kept = held === 1 ? 'Its 1 task moves' : `Its ${held} tasks move`;
    const warning =
      held === 0
        ? `Delete the category "${category.name}"?`
        : `Delete the category "${category.name}"?\n\n${kept} to Uncategorised.`;
    if (window.confirm(warning)) void run(() => api.deleteTodoCategory(category.id));
  }

  function markAllDone() {
    const count = open.length;
    if (!window.confirm(`Tick off all ${count} open ${count === 1 ? 'task' : 'tasks'}?`)) return;
    void run(() => Promise.all(open.map((t) => api.updateTodo(t.id, { done: true }))));
  }

  function clearCompleted() {
    if (window.confirm('Remove all completed tasks?')) void run(() => api.clearCompletedTodos());
  }

  return (
    <>
      {controllable && (
        <Card>
          <CardHead icon={PlusCircleIcon} title="Add task" divider={false} />
          <form
            className="flex flex-col gap-2.5 px-5 pb-5 sm:flex-row"
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
              placeholder="What needs doing?"
              aria-label="Task"
              className={`${FIELD} flex-1`}
            />
            <Select
              value={addTo}
              options={categoryOptions}
              onChange={setAddTo}
              aria-label="File the new task under"
              align="right"
              className={`${FIELD} sm:w-48`}
            />
            <button type="submit" className={ACCENT_BUTTON}>
              Add task
            </button>
          </form>
        </Card>
      )}

      <div
        className={`grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_23rem] ${controllable ? 'mt-4' : ''}`}
      >
        <Card>
          <CardHead icon={TodoIcon} title="Open tasks">
            <span className="shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-300">
              {open.length} open
            </span>
            <TodoPageMenu
              controllable={controllable}
              hasOpen={open.length > 0}
              hasCompleted={completed.length > 0}
              onExpandAll={() => setAllCollapsed(false)}
              onCollapseAll={() => setAllCollapsed(true)}
              onMarkAllDone={markAllDone}
              onClearCompleted={clearCompleted}
            />
          </CardHead>
          <div className="flex flex-col gap-6 p-4">
            {filled.length === 0 ? (
              <p className="py-8 text-center text-sm text-zinc-500">
                {todos.length === 0 ? 'No tasks yet.' : 'Nothing open — everything is ticked off.'}
              </p>
            ) : (
              filled.map((s) => (
                <TaskGroup
                  key={s.key}
                  name={s.name}
                  count={s.items.length}
                  open={!collapsed[s.key]}
                  onToggle={() => toggleSection(s.key)}
                >
                  {s.items.map((t) => (
                    <TodoRow
                      key={t.id}
                      todo={t}
                      controllable={controllable}
                      categoryOptions={categoryOptions}
                      editing={editing?.id === t.id ? editing.focus : null}
                      onEdit={(focus) => setEditing({ id: t.id, focus })}
                      onCancelEdit={() => setEditing(null)}
                      onToggle={() => void run(() => api.updateTodo(t.id, { done: !t.done }))}
                      onSave={(fields) => {
                        setEditing(null);
                        void run(() => api.updateTodo(t.id, fields));
                      }}
                      onDelete={() => void run(() => api.deleteTodo(t.id))}
                    />
                  ))}
                </TaskGroup>
              ))
            )}
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <CategoriesCard
            categories={categories}
            openCounts={openCounts}
            controllable={controllable}
            onCreate={(name) => void run(() => api.createTodoCategory(name))}
            onRename={(c, name) => void run(() => api.renameTodoCategory(c.id, name))}
            onDelete={deleteCategory}
          />
          <CompletedCard
            items={completed}
            controllable={controllable}
            onRestore={(t) => void run(() => api.updateTodo(t.id, { done: false }))}
            onDelete={(t) => void run(() => api.deleteTodo(t.id))}
            onClear={clearCompleted}
          />
        </div>
      </div>
    </>
  );
}

// --- Shared card chrome -----------------------------------------------------

function Card({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <section className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
      {children}
    </section>
  );
}

function CardHead({
  icon: Icon,
  title,
  divider = true,
  children,
}: {
  icon: (props: { className?: string }) => JSX.Element;
  title: string;
  /** The add-task card's form is part of the header block, so it skips the rule. */
  divider?: boolean;
  /** Right-hand action, e.g. "Clear completed". */
  children?: React.ReactNode;
}): JSX.Element {
  return (
    <div
      className={`flex items-center gap-2.5 px-5 py-3.5 ${divider ? 'border-b border-zinc-800' : ''}`}
    >
      <Icon className="h-5 w-5 shrink-0 text-zinc-400" />
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold uppercase tracking-wide text-white">
        {title}
      </h2>
      {children}
    </div>
  );
}

/** A row-level action: the pencil, the bin, and friends. */
function IconButton({
  icon: Icon,
  label,
  onClick,
  danger = false,
  className = '',
}: {
  icon: (props: { className?: string }) => JSX.Element;
  label: string;
  onClick: () => void;
  danger?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-800 ${
        danger ? 'hover:text-red-400' : 'hover:text-zinc-100'
      } ${className}`}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

// --- Page menu --------------------------------------------------------------

/**
 * The ⋮ menu: the whole-list actions that don't deserve a button of their own.
 * Folding is a view preference, so guests get it too; everything below the rule
 * changes tasks and is admin-only.
 */
function TodoPageMenu({
  controllable,
  hasOpen,
  hasCompleted,
  onExpandAll,
  onCollapseAll,
  onMarkAllDone,
  onClearCompleted,
}: {
  controllable: boolean;
  hasOpen: boolean;
  hasCompleted: boolean;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onMarkAllDone: () => void;
  onClearCompleted: () => void;
}): JSX.Element {
  return (
    <Popover
      title="List options"
      align="right"
      width="w-52"
      chevron={false}
      triggerClassName="rounded-lg p-2 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
      label={<MoreIcon className="h-5 w-5 rotate-90" />}
    >
      {(close) => (
        <>
          <MenuItem
            onClick={() => {
              onExpandAll();
              close();
            }}
          >
            Expand all
          </MenuItem>
          <MenuItem
            onClick={() => {
              onCollapseAll();
              close();
            }}
          >
            Collapse all
          </MenuItem>
          {controllable && (
            <>
              <MenuItem
                disabled={!hasOpen}
                onClick={() => {
                  onMarkAllDone();
                  close();
                }}
              >
                Mark all done
              </MenuItem>
              <div className="my-1 border-t border-zinc-800" />
              <MenuItem
                danger
                disabled={!hasCompleted}
                onClick={() => {
                  onClearCompleted();
                  close();
                }}
              >
                Clear completed
              </MenuItem>
            </>
          )}
        </>
      )}
    </Popover>
  );
}

function MenuItem({
  children,
  onClick,
  disabled = false,
  danger = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`block w-full rounded-lg px-3 py-2 text-left text-sm transition disabled:text-zinc-600 disabled:hover:bg-transparent ${
        danger
          ? 'text-red-300 hover:bg-red-500/10'
          : 'text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100'
      }`}
    >
      {children}
    </button>
  );
}

// --- Open tasks -------------------------------------------------------------

/**
 * One category's worth of open work. The heading is the fold toggle — the
 * chevron stays quiet until the pointer is on it, so a list at rest reads as
 * plain headings rather than as a stack of controls.
 */
function TaskGroup({
  name,
  count,
  open,
  onToggle,
  children,
}: {
  name: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="group flex w-full items-baseline gap-2 border-b border-zinc-800 pb-2.5 text-left"
      >
        <ChevronRightIcon
          className={`h-4 w-4 shrink-0 self-center text-zinc-700 transition group-hover:text-zinc-400 ${
            open ? 'rotate-90' : ''
          }`}
        />
        <span className="min-w-0 truncate text-lg font-semibold text-zinc-100">{name}</span>
        <span className="shrink-0 text-xs text-zinc-500">
          {count} {count === 1 ? 'task' : 'tasks'}
        </span>
      </button>
      {open && <ul className="mt-3 flex flex-col gap-2.5">{children}</ul>}
    </section>
  );
}

function TodoRow({
  todo,
  controllable,
  categoryOptions,
  editing,
  onEdit,
  onCancelEdit,
  onToggle,
  onSave,
  onDelete,
}: {
  todo: Todo;
  controllable: boolean;
  categoryOptions: readonly { value: string; label: string }[];
  /** Which field the inline editor opened on, or null when it is closed. */
  editing: 'text' | 'description' | null;
  onEdit: (focus: 'text' | 'description') => void;
  onCancelEdit: () => void;
  onToggle: () => void;
  onSave: (fields: {
    text?: string;
    description?: string | null;
    categoryId?: number | null;
  }) => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <li className="rounded-xl border border-zinc-800 bg-zinc-800/30 px-4 py-3 transition hover:border-zinc-700">
      {editing ? (
        <TodoEditor todo={todo} focus={editing} onCancel={onCancelEdit} onSave={onSave} />
      ) : (
        <div className="flex items-start gap-3.5">
          <button
            type="button"
            onClick={onToggle}
            disabled={!controllable}
            title="Mark done"
            aria-label="Mark done"
            className="mt-0.5 h-6 w-6 shrink-0 rounded-full border-2 border-zinc-600 transition hover:border-[#f87a68] disabled:cursor-default disabled:hover:border-zinc-600"
          />
          <div className="min-w-0 flex-1">
            <p className="break-words text-[15px] leading-6 text-zinc-100">{todo.text}</p>
            {todo.description ? (
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-400">
                {todo.description}
              </p>
            ) : (
              controllable && (
                <button
                  type="button"
                  onClick={() => onEdit('description')}
                  className="mt-1 text-sm text-zinc-500 transition hover:text-zinc-300"
                >
                  Add a description…
                </button>
              )
            )}
          </div>
          {controllable && (
            <div className="flex shrink-0 items-center gap-1">
              <Select
                value={todo.categoryId === null ? '' : String(todo.categoryId)}
                options={categoryOptions}
                onChange={(next) => onSave({ categoryId: next ? Number(next) : null })}
                aria-label={`Category for ${todo.text}`}
                align="right"
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-300"
              />
              <IconButton icon={PencilIcon} label="Edit task" onClick={() => onEdit('text')} />
              <IconButton icon={TrashIcon} label="Delete task" onClick={onDelete} danger />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The inline editor for one task. Mounted only while a row is being edited, so
 * its drafts start from whatever the row holds at that moment and a background
 * refresh cannot overwrite them mid-sentence.
 */
function TodoEditor({
  todo,
  focus,
  onCancel,
  onSave,
}: {
  todo: Todo;
  focus: 'text' | 'description';
  onCancel: () => void;
  onSave: (fields: { text?: string; description?: string | null }) => void;
}): JSX.Element {
  const [text, setText] = useState(todo.text);
  const [description, setDescription] = useState(todo.description ?? '');
  const textRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);

  // Open on whichever line was clicked: the pencil edits the task itself, the
  // "Add a description…" line goes straight to the description.
  useEffect(() => {
    const el = focus === 'description' ? descRef.current : textRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focus]);

  function commit() {
    const nextText = text.trim();
    // An empty task can't be saved, and shouldn't silently discard the edit.
    if (!nextText) {
      textRef.current?.focus();
      return;
    }
    const nextDescription = description.trim();
    const fields: { text?: string; description?: string | null } = {};
    if (nextText !== todo.text) fields.text = nextText;
    if (nextDescription !== (todo.description ?? '')) fields.description = nextDescription || null;
    if (Object.keys(fields).length === 0) onCancel();
    else onSave(fields);
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={textRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') onCancel();
        }}
        aria-label="Task"
        className={FIELD}
      />
      <textarea
        ref={descRef}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
        rows={2}
        placeholder="Description (optional)…"
        aria-label="Description"
        className={`${FIELD} resize-y`}
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={GHOST_BUTTON}>
          Cancel
        </button>
        <button type="button" onClick={commit} className={ACCENT_BUTTON_SM}>
          Save
        </button>
      </div>
    </div>
  );
}

// --- Right-hand column ------------------------------------------------------

/**
 * Every section that exists, with its open count — including the ones holding
 * nothing, which the left column leaves out.
 */
function CategoriesCard({
  categories,
  openCounts,
  controllable,
  onCreate,
  onRename,
  onDelete,
}: {
  categories: TodoCategory[];
  openCounts: Map<string, number>;
  controllable: boolean;
  onCreate: (name: string) => void;
  onRename: (category: TodoCategory, name: string) => void;
  onDelete: (category: TodoCategory) => void;
}): JSX.Element {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  return (
    <Card>
      <CardHead icon={FolderIcon} title="Categories" />
      <ul className="divide-y divide-zinc-800/70">
        {categories.map((c) => (
          <CategoryRow
            key={c.id}
            category={c}
            count={openCounts.get(String(c.id)) ?? 0}
            controllable={controllable}
            onRename={(next) => onRename(c, next)}
            onDelete={() => onDelete(c)}
          />
        ))}
        {/* Uncategorised is the absence of a category, so it has nothing to
            rename or delete — it is only ever a count. */}
        <li className="flex items-center gap-2 px-4 py-2.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-400">
            Uncategorised
          </span>
          <span className="shrink-0 text-sm font-semibold text-zinc-400">
            {openCounts.get(UNCATEGORISED) ?? 0}
          </span>
        </li>
      </ul>
      {controllable &&
        (adding ? (
          <form
            className="flex gap-2 border-t border-zinc-800 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              const value = name.trim();
              if (!value) return;
              onCreate(value);
              setName('');
              setAdding(false);
            }}
          >
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setName('');
                  setAdding(false);
                }
              }}
              placeholder="Category name…"
              aria-label="New category name"
              className={FIELD}
            />
            <button type="submit" className={ACCENT_BUTTON_SM}>
              Add
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex w-full items-center gap-2 border-t border-zinc-800 px-4 py-3 text-sm font-semibold text-[#f87a68] transition hover:bg-zinc-800/40"
          >
            <PlusCircleIcon className="h-4 w-4 shrink-0" />
            New category
          </button>
        ))}
    </Card>
  );
}

function CategoryRow({
  category,
  count,
  controllable,
  onRename,
  onDelete,
}: {
  category: TodoCategory;
  count: number;
  controllable: boolean;
  onRename: (name: string) => void;
  onDelete: () => void;
}): JSX.Element {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(category.name);
  useEffect(() => setDraft(category.name), [category.name]);

  function commitRename() {
    setRenaming(false);
    const next = draft.trim();
    if (next && next !== category.name) onRename(next);
    else setDraft(category.name);
  }

  if (renaming) {
    return (
      <li className="p-2">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') {
              setDraft(category.name);
              setRenaming(false);
            }
          }}
          aria-label="Category name"
          className={FIELD}
        />
      </li>
    );
  }

  return (
    <li className="group flex items-center gap-1 px-4 py-2.5 transition hover:bg-zinc-800/40">
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">
        {category.name}
      </span>
      {controllable && (
        <span className="flex shrink-0 items-center opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
          <IconButton
            icon={PencilIcon}
            label={`Rename ${category.name}`}
            onClick={() => setRenaming(true)}
          />
          <IconButton icon={TrashIcon} label={`Delete ${category.name}`} onClick={onDelete} danger />
        </span>
      )}
      <span className="w-5 shrink-0 text-right text-sm font-semibold text-zinc-300">{count}</span>
    </li>
  );
}

/** What has been ticked off, newest first. Clicking the tick puts one back. */
function CompletedCard({
  items,
  controllable,
  onRestore,
  onDelete,
  onClear,
}: {
  items: Todo[];
  controllable: boolean;
  onRestore: (todo: Todo) => void;
  onDelete: (todo: Todo) => void;
  onClear: () => void;
}): JSX.Element {
  return (
    <Card>
      <CardHead icon={CheckCircleIcon} title="Completed">
        {controllable && items.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="shrink-0 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100"
          >
            Clear completed
          </button>
        )}
      </CardHead>
      {items.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-zinc-500">Nothing ticked off yet.</p>
      ) : (
        <ul className="flex max-h-[26rem] flex-col gap-2 overflow-y-auto p-3">
          {items.map((t) => (
            <li
              key={t.id}
              className="group flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-800/30 px-3 py-2.5"
            >
              <button
                type="button"
                onClick={() => onRestore(t)}
                disabled={!controllable}
                title="Mark not done"
                aria-label="Mark not done"
                className="shrink-0 text-zinc-500 transition hover:text-zinc-200 disabled:cursor-default disabled:hover:text-zinc-500"
              >
                <CheckCircleIcon className="h-6 w-6" />
              </button>
              <span className="min-w-0 flex-1 truncate text-sm text-zinc-500 line-through">
                {t.text}
              </span>
              {controllable && (
                <IconButton
                  icon={TrashIcon}
                  label={`Delete ${t.text}`}
                  onClick={() => onDelete(t)}
                  danger
                  className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
