import type { Todo } from '@checklist/shared';
import { DndContext, type DragEndEvent, closestCenter } from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { DescriptionModal, InfoButton, useTouchSensors } from '../components/touch';

const POLL_MS = 5000;

/**
 * Full-screen touch to-do list for the Pi (its own page, not an overlay on the
 * checklist). Tap to tick off; long-press and drag to reorder. Tasks are
 * created/edited on the laptop To-Do page; here they're ticked off.
 */
export function KioskTodosPage() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [info, setInfo] = useState<{ title: string; description: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingReorder = useRef(false);
  const sensors = useTouchSensors();

  const load = useCallback(async () => {
    try {
      // Don't clobber an optimistic drag that's still being persisted.
      if (!pendingReorder.current) setTodos(await api.listTodos());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  async function runTodo(action: () => Promise<unknown>) {
    try {
      await action();
      setTodos(await api.listTodos());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'To-do action failed');
    }
  }

  async function handleReorder(newTodos: Todo[]) {
    pendingReorder.current = true;
    setTodos(newTodos); // optimistic
    try {
      await api.reorderTodos(newTodos.map((t) => t.id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reorder');
      setTodos(await api.listTodos()); // revert
    } finally {
      pendingReorder.current = false;
    }
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = todos.findIndex((t) => t.id === active.id);
    const newIndex = todos.findIndex((t) => t.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    void handleReorder(arrayMove(todos, oldIndex, newIndex));
  }

  return (
    <div className="touch-none-select flex h-full flex-col bg-slate-900 text-white">
      <header className="flex items-center justify-between gap-4 border-b border-slate-700 px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/kiosk"
            className="shrink-0 rounded-xl bg-slate-700 px-4 py-3 text-2xl leading-none active:bg-slate-600"
            aria-label="Home"
          >
            ⌂
          </Link>
          <h1 className="py-1 text-3xl font-bold leading-normal sm:text-4xl">Brewery To-Do</h1>
        </div>
      </header>

      {error && (
        <div className="bg-red-900/40 px-6 py-2 text-center text-lg text-red-300">{error}</div>
      )}

      {/* Tap to tick off; hold and drag to reorder. Tasks are added on the To-Do page. */}
      <main className="flex-1 overflow-y-auto p-4 sm:p-6">
        {todos.length === 0 ? (
          <p className="mt-10 text-center text-2xl text-slate-400">
            No to-do items. Add some from the To-Do page.
          </p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={todos.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              <ul className="flex flex-col gap-4">
                {todos.map((t) => (
                  <SortableTodo
                    key={t.id}
                    todo={t}
                    onToggle={() => void runTodo(() => api.updateTodo(t.id, { done: !t.done }))}
                    onInfo={() => setInfo({ title: t.text, description: t.description ?? '' })}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </main>

      {info && (
        <DescriptionModal
          title={info.title}
          description={info.description}
          onClose={() => setInfo(null)}
        />
      )}
    </div>
  );
}

function SortableTodo({
  todo,
  onToggle,
  onInfo,
}: {
  todo: Todo;
  onToggle: () => void;
  onInfo: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: todo.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <li ref={setNodeRef} style={style} className={`relative ${isDragging ? 'z-10' : ''}`}>
      <button
        type="button"
        onClick={onToggle}
        {...attributes}
        {...listeners}
        className={`flex w-full touch-manipulation items-center gap-5 rounded-2xl border-2 py-6 pl-6 text-left transition active:scale-[0.99] ${
          todo.description ? 'pr-24' : 'pr-6'
        } ${
          todo.done ? 'border-green-500 bg-green-600/20' : 'border-slate-600 bg-slate-800'
        } ${isDragging ? 'opacity-90 shadow-2xl ring-2 ring-blue-400' : ''}`}
      >
        <span
          className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border-2 text-3xl ${
            todo.done
              ? 'border-green-400 bg-green-500 text-white'
              : 'border-slate-500 text-transparent'
          }`}
          aria-hidden
        >
          ✓
        </span>
        <span
          className={`text-2xl sm:text-3xl ${
            todo.done ? 'text-slate-300 line-through' : 'text-white'
          }`}
        >
          {todo.text}
        </span>
      </button>
      {todo.description && <InfoButton onClick={onInfo} />}
    </li>
  );
}
