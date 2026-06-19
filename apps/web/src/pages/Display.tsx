import type { ActiveState, ChecklistSummary, DisplayStep } from '@checklist/shared';
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
import { canControl, useAuth } from '../auth';
import { DescriptionModal, InfoButton, useTouchSensors } from '../components/touch';

/** Poll interval so a second device / the admin page stays roughly in sync. */
const POLL_MS = 5000;

export function DisplayPage() {
  const [state, setState] = useState<ActiveState | null>(null);
  const [checklists, setChecklists] = useState<ChecklistSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // When set, a step's description is shown in a modal over everything else.
  const [info, setInfo] = useState<{ title: string; description: string } | null>(null);
  const pendingToggles = useRef(new Set<number>());
  const pendingReorder = useRef(false);
  const { auth } = useAuth();
  // Guests can watch the run but can't tick steps, reorder, reset, or switch
  // checklists; the kiosk/LAN and admins keep full control.
  const controllable = canControl(auth);

  const sensors = useTouchSensors();

  const load = useCallback(async () => {
    try {
      setChecklists(await api.listChecklists());
      // Don't clobber optimistic step state while a tap/drag is in flight.
      if (pendingToggles.current.size === 0 && !pendingReorder.current) {
        setState(await api.getActive());
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, []);

  async function switchTo(id: number) {
    try {
      await api.activateChecklist(id);
      setState(await api.getActive());
      setChecklists(await api.listChecklists());
      setPickerOpen(false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to switch checklist');
    }
  }

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  async function toggle(stepId: number) {
    if (!controllable) return; // read-only guests can't tick steps
    pendingToggles.current.add(stepId);
    try {
      setState(await api.toggleStep(stepId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update');
    } finally {
      pendingToggles.current.delete(stepId);
    }
  }

  async function doReset() {
    try {
      setState(await api.resetRun());
      setConfirmReset(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reset');
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    if (!controllable) return; // read-only guests can't reorder
    const { active, over } = event;
    if (!state?.checklist || !over || active.id === over.id) return;
    const current = state.steps;
    const oldIndex = current.findIndex((s) => s.id === active.id);
    const newIndex = current.findIndex((s) => s.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const reordered = arrayMove(current, oldIndex, newIndex);
    // Optimistically apply the new order, then persist it to the template.
    pendingReorder.current = true;
    setState((prev) => (prev ? { ...prev, steps: reordered } : prev));
    try {
      await api.reorderSteps(
        state.checklist.id,
        reordered.map((s) => s.id),
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reorder');
      void load(); // revert to the server's order on failure
    } finally {
      pendingReorder.current = false;
    }
  }

  const infoModal = info ? (
    <DescriptionModal
      title={info.title}
      description={info.description}
      onClose={() => setInfo(null)}
    />
  ) : null;

  if (!state) {
    return (
      <CenteredMessage>
        <p className="text-3xl text-zinc-300">{error ?? 'Loading…'}</p>
      </CenteredMessage>
    );
  }

  if (!state.checklist) {
    return (
      <CenteredMessage>
        {checklists.length === 0 ? (
          <>
            <p className="text-4xl font-semibold text-zinc-200">No checklists yet</p>
            <p className="mt-4 text-2xl text-zinc-400">Create one from the admin page.</p>
          </>
        ) : (
          <>
            <p className="text-4xl font-semibold text-zinc-200">No active checklist</p>
            {controllable && (
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="mt-6 rounded-xl bg-blue-600 px-8 py-4 text-2xl font-semibold text-white active:bg-blue-500"
              >
                Choose a checklist
              </button>
            )}
          </>
        )}
        <Link to="/kiosk" className="mt-8 text-xl text-zinc-400 underline active:text-zinc-200">
          ⌂ Home
        </Link>
        {pickerOpen && (
          <ChecklistPicker
            checklists={checklists}
            activeId={null}
            onPick={(id) => void switchTo(id)}
            onClose={() => setPickerOpen(false)}
          />
        )}
        {infoModal}
      </CenteredMessage>
    );
  }

  const { checklist, steps, progress } = state;
  const allDone = progress.total > 0 && progress.completed === progress.total;

  return (
    <div className="touch-none-select flex h-full flex-col bg-zinc-900 text-white">
      {/* Header */}
      <header className="flex items-center justify-between gap-4 border-b border-zinc-700 px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/kiosk"
            className="shrink-0 rounded-xl bg-zinc-700 px-4 py-3 text-2xl leading-none active:bg-zinc-600"
            aria-label="Home"
          >
            ⌂
          </Link>
          {controllable ? (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="flex min-w-0 items-center gap-3 text-left active:opacity-70"
            >
              <h1 className="min-w-0 truncate py-1 text-3xl font-bold leading-normal sm:text-4xl">
                {checklist.name}
              </h1>
              {checklists.length > 1 && (
                <span className="shrink-0 text-2xl text-zinc-400" aria-hidden>
                  ▾
                </span>
              )}
            </button>
          ) : (
            <h1 className="min-w-0 truncate py-1 text-3xl font-bold leading-normal sm:text-4xl">
              {checklist.name}
            </h1>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div
            className={`rounded-xl px-5 py-2 text-2xl font-bold sm:text-3xl ${
              allDone ? 'bg-green-600' : 'bg-zinc-700'
            }`}
          >
            {progress.completed} / {progress.total}
          </div>
          {controllable && (
            <button
              type="button"
              onClick={() => setConfirmReset(true)}
              className="rounded-xl bg-amber-600 px-6 py-3 text-xl font-semibold text-white active:bg-amber-500"
            >
              Reset
            </button>
          )}
        </div>
      </header>

      {/* Error banner (only when something went wrong) */}
      {error && (
        <div className="bg-red-900/40 px-6 py-2 text-center text-lg text-red-300">
          {error}
        </div>
      )}

      {/* Steps */}
      <main className="flex-1 overflow-y-auto p-4 sm:p-6">
        {steps.length === 0 ? (
          <p className="mt-10 text-center text-2xl text-zinc-400">
            This checklist has no steps yet.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={(e) => void handleDragEnd(e)}
          >
            <SortableContext
              items={steps.map((s) => s.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="flex flex-col gap-4">
                {steps.map((step) => (
                  <SortableStep
                    key={step.id}
                    step={step}
                    controllable={controllable}
                    onToggle={() => void toggle(step.id)}
                    onInfo={() =>
                      setInfo({ title: step.text, description: step.description ?? '' })
                    }
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </main>

      {/* Checklist switcher */}
      {pickerOpen && (
        <ChecklistPicker
          checklists={checklists}
          activeId={checklist.id}
          onPick={(id) => void switchTo(id)}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {/* Reset confirmation */}
      {confirmReset && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-6">
          <div className="w-full max-w-md rounded-2xl bg-zinc-800 p-8 text-center">
            <p className="text-3xl font-bold">Reset progress?</p>
            <p className="mt-3 text-xl text-zinc-300">
              All checked steps will be cleared and a fresh run started.
            </p>
            <div className="mt-8 flex gap-4">
              <button
                type="button"
                onClick={() => setConfirmReset(false)}
                className="flex-1 rounded-xl bg-zinc-600 py-4 text-2xl font-semibold active:bg-zinc-500"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void doReset()}
                className="flex-1 rounded-xl bg-red-600 py-4 text-2xl font-semibold active:bg-red-500"
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      )}

      {infoModal}
    </div>
  );
}

function SortableStep({
  step,
  controllable,
  onToggle,
  onInfo,
}: {
  step: DisplayStep;
  controllable: boolean;
  onToggle: () => void;
  onInfo: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: step.id, disabled: !controllable });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <li ref={setNodeRef} style={style} className={`relative ${isDragging ? 'z-10' : ''}`}>
      <button
        type="button"
        onClick={onToggle}
        disabled={!controllable}
        {...(controllable ? attributes : {})}
        {...(controllable ? listeners : {})}
        className={`flex w-full touch-manipulation items-center gap-5 rounded-2xl border-2 py-6 pl-6 text-left transition active:scale-[0.99] ${
          step.description ? 'pr-24' : 'pr-6'
        } ${
          step.checked ? 'border-green-500 bg-green-600/20' : 'border-zinc-600 bg-zinc-800'
        } ${isDragging ? 'opacity-90 shadow-2xl ring-2 ring-blue-400' : ''}`}
      >
        <span
          className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border-2 text-3xl ${
            step.checked
              ? 'border-green-400 bg-green-500 text-white'
              : 'border-zinc-500 text-transparent'
          }`}
          aria-hidden
        >
          ✓
        </span>
        <span
          className={`text-2xl sm:text-3xl ${
            step.checked ? 'text-zinc-300 line-through' : 'text-white'
          }`}
        >
          {step.text}
          {step.required ? null : (
            <span className="ml-2 align-middle text-base text-zinc-400">(optional)</span>
          )}
        </span>
      </button>
      {step.description && <InfoButton onClick={onInfo} />}
    </li>
  );
}

function ChecklistPicker({
  checklists,
  activeId,
  onPick,
  onClose,
}: {
  checklists: ChecklistSummary[];
  activeId: number | null;
  onPick: (id: number) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-zinc-800 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-4 text-2xl font-bold text-white">Choose checklist</p>
        <ul className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto">
          {checklists.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onPick(c.id)}
                className={`flex w-full items-center justify-between gap-3 rounded-xl border-2 px-5 py-5 text-left text-2xl text-white transition active:scale-[0.99] ${
                  c.id === activeId
                    ? 'border-green-500 bg-green-600/20'
                    : 'border-zinc-600 bg-zinc-700'
                }`}
              >
                <span className="min-w-0 truncate">{c.name}</span>
                <span className="shrink-0 text-base text-zinc-300">
                  {c.id === activeId ? 'active' : `${c.stepCount} steps`}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onClose}
          className="mt-5 w-full rounded-xl bg-zinc-600 py-4 text-2xl font-semibold text-white active:bg-zinc-500"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-zinc-900 p-8 text-center">
      {children}
    </div>
  );
}
