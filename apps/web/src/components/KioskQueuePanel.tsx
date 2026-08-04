import type { QueueTrack } from '@checklist/shared';
import { DndContext, type DragEndEvent, closestCenter } from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { usePoll } from '../usePoll';
import { CloseIcon, GripIcon, PlayIcon, SpeakerIcon } from './icons';
import { useTouchSensors } from './touch';

/** The queue changes only when someone acts on it, so a lazy poll is plenty. */
const POLL_MS = 5000;

/**
 * A track's identity within one snapshot of the queue. Sonos gives queue entries
 * no id of their own, and the same song can sit in the queue twice, so pair the
 * URI with the position it arrived at. The value travels with the object through
 * an optimistic drag (which reorders the array without renumbering), which is
 * exactly what dnd-kit needs from a sortable id.
 */
function trackId(track: QueueTrack): string {
  return `${track.position}|${track.uri ?? ''}`;
}

/**
 * The brewery speaker's queue, sliding in over the now-playing view on the
 * kiosk. Tap a row to jump to it, hold and drag to reorder, ✕ to drop it.
 *
 * The list shown here is local state rather than the raw server response: a drag
 * is applied optimistically and only renumbered on the next poll, so positions
 * are read off the array index (`i + 1`) and never off `track.position`, which
 * still holds the slot the track came back from the speaker in.
 */
export function KioskQueuePanel({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  /** Called after an action that also moves the speaker, so now-playing refreshes. */
  onChanged: () => void;
}): JSX.Element {
  const [tracks, setTracks] = useState<QueueTrack[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const pendingReorder = useRef(false);
  const sensors = useTouchSensors();
  const currentRowRef = useRef<HTMLLIElement | null>(null);
  const scrolledToCurrent = useRef(false);

  const load = useCallback(async () => {
    try {
      // Don't clobber an optimistic drag that hasn't been persisted yet.
      if (!pendingReorder.current) {
        const queue = await api.getMusicQueue();
        setTracks(queue.tracks);
        const current = queue.tracks.find((t) => t.position === queue.currentPosition);
        setCurrentId(current ? trackId(current) : null);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the queue');
    } finally {
      setLoaded(true);
    }
  }, []);

  usePoll(load, POLL_MS, [load]);

  // Open onto the track that's playing rather than the top of a long queue —
  // once only, so a later poll doesn't yank the list back while it's being read.
  useEffect(() => {
    if (scrolledToCurrent.current || !currentRowRef.current) return;
    scrolledToCurrent.current = true;
    currentRowRef.current.scrollIntoView({ block: 'center' });
  }, [currentId, tracks]);

  /** Run a queue command, then resync both the queue and now-playing. */
  async function run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      setError(null);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Queue command failed');
      await load();
    }
  }

  async function onDragEnd(event: DragEndEvent): Promise<void> {
    setDragging(false);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = tracks.findIndex((t) => trackId(t) === active.id);
    const to = tracks.findIndex((t) => trackId(t) === over.id);
    if (from < 0 || to < 0) return;

    pendingReorder.current = true;
    setTracks(arrayMove(tracks, from, to)); // optimistic
    try {
      await api.musicQueueReorder(from + 1, to + 1);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reorder the queue');
    } finally {
      pendingReorder.current = false;
      await load(); // adopt the speaker's numbering (or revert, if it refused)
      onChanged();
    }
  }

  return (
    <section
      className="slide-in-right absolute inset-0 z-20 flex flex-col bg-zinc-950"
      aria-label="Queue"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-zinc-800 px-5 py-3">
        <h2 className="text-2xl font-bold">Queue</h2>
        <span className="truncate text-lg text-zinc-500">
          {tracks.length > 0 ? `${tracks.length} tracks` : ''}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close queue"
          className="ml-auto flex h-12 w-12 shrink-0 touch-manipulation items-center justify-center rounded-2xl bg-zinc-800 active:bg-zinc-700"
        >
          <CloseIcon className="h-6 w-6" />
        </button>
      </header>

      {error && (
        <p className="shrink-0 bg-red-900/40 px-5 py-1.5 text-center text-base text-red-300">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {tracks.length === 0 ? (
          <p className="mt-16 px-8 text-center text-xl leading-relaxed text-zinc-500">
            {!loaded
              ? 'Reading the queue…'
              : // Radio, line-in and Spotify Connect all stream straight to the
                // speaker without ever filling the Sonos queue.
                'The queue is empty. Sonos only keeps a queue for tracks added to the speaker — a radio stream or Spotify Connect session won’t show up here.'}
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={() => setDragging(true)}
            onDragCancel={() => setDragging(false)}
            onDragEnd={(e) => void onDragEnd(e)}
          >
            <SortableContext items={tracks.map(trackId)} strategy={verticalListSortingStrategy}>
              <ul className="flex flex-col gap-1.5">
                {tracks.map((track, index) => {
                  const id = trackId(track);
                  const isCurrent = id === currentId;
                  return (
                    <QueueRow
                      key={id}
                      id={id}
                      rowRef={isCurrent ? currentRowRef : undefined}
                      track={track}
                      slot={index + 1}
                      // dnd-kit shuffles the rows visually without touching the
                      // array, so mid-drag every number would be a lie. Hide
                      // them until the drop renumbers the list for real.
                      showSlot={!dragging}
                      isCurrent={isCurrent}
                      onPlay={() => void run(() => api.musicQueuePlay(index + 1))}
                      onRemove={() => void run(() => api.musicQueueRemove(index + 1))}
                    />
                  );
                })}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {tracks.length > 0 && (
        <p className="shrink-0 border-t border-zinc-800 px-5 py-2 text-center text-sm text-zinc-600">
          Tap to play · hold and drag to reorder
        </p>
      )}
    </section>
  );
}

/**
 * One queue row: grip, slot number (a play glyph on the track that's live),
 * title and artist. The ✕ is a sibling of the drag/tap button rather than a
 * child, so removing a track can't be mistaken for playing it.
 */
function QueueRow({
  id,
  track,
  slot,
  showSlot,
  isCurrent,
  onPlay,
  onRemove,
  rowRef,
}: {
  id: string;
  track: QueueTrack;
  slot: number;
  showSlot: boolean;
  isCurrent: boolean;
  onPlay: () => void;
  onRemove: () => void;
  /** Set on the playing row only, so the panel can scroll it into view. */
  rowRef?: React.MutableRefObject<HTMLLIElement | null>;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  return (
    <li
      ref={(node) => {
        setNodeRef(node);
        if (rowRef) rowRef.current = node;
      }}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`relative ${isDragging ? 'z-10' : ''}`}
    >
      <button
        type="button"
        onClick={onPlay}
        {...attributes}
        {...listeners}
        aria-label={`Play ${track.title ?? 'track'}`}
        className={`flex w-full touch-manipulation items-center gap-3 rounded-xl border py-2 pl-3 pr-16 text-left transition active:scale-[0.99] ${
          isCurrent ? 'border-emerald-500/70 bg-emerald-500/10' : 'border-zinc-800 bg-zinc-900'
        } ${isDragging ? 'shadow-2xl ring-2 ring-emerald-400' : ''}`}
      >
        <GripIcon className="h-5 w-5 shrink-0 text-zinc-600" />
        <span
          className={`flex w-7 shrink-0 justify-center text-lg tabular-nums ${
            isCurrent ? 'text-emerald-400' : 'text-zinc-500'
          }`}
        >
          {isCurrent ? <PlayIcon className="h-5 w-5" /> : showSlot ? slot : null}
        </span>
        <AlbumThumb url={track.albumArtUrl} />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-lg font-semibold text-white">
            {track.title ?? 'Unknown track'}
          </span>
          <span className="block truncate text-base text-zinc-400">{track.artist ?? '—'}</span>
        </span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${track.title ?? 'track'} from the queue`}
        className="absolute right-2 top-1/2 flex h-11 w-11 -translate-y-1/2 touch-manipulation items-center justify-center rounded-full bg-zinc-800/90 text-zinc-400 active:bg-zinc-700"
      >
        <CloseIcon className="h-5 w-5" />
      </button>
    </li>
  );
}

/** A small album thumbnail, falling back to a speaker glyph if the art 404s. */
function AlbumThumb({ url }: { url: string | null }): JSX.Element {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);

  return (
    <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-zinc-800">
      {url && !failed ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <SpeakerIcon className="h-5 w-5 text-zinc-600" />
      )}
    </span>
  );
}
