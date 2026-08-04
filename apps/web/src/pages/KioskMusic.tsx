import type { MusicRepeat, NowPlaying } from '@checklist/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { usePoll } from '../usePoll';
import { KioskQueuePanel } from '../components/KioskQueuePanel';
import {
  HomeIcon,
  PauseIcon,
  PlayIcon,
  QueueIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShuffleIcon,
  SkipNextIcon,
  SkipPrevIcon,
  SpeakerIcon,
  VolumeIcon,
} from '../components/icons';

/** Now-playing moves quickly enough that a few seconds feels live. */
const POLL_MS = 4000;

/** Repeat cycles off → all → one → off, the order every music app uses. */
const NEXT_REPEAT: Record<MusicRepeat, MusicRepeat> = { off: 'all', all: 'one', one: 'off' };

/** Hard-coded speaker identity (the brewery's IKEA SYMFONISK, Sonos firmware). */
const SPEAKER_NAME = 'IKEA - Symfoni';
const SPEAKER_ROOM = 'Brewery';

/** Seconds → m:ss (e.g. 84 → "1:24"). */
function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
}

/** A green→grey track fill, painted as an inline gradient for `.media-slider`. */
function fillStyle(pct: number): React.CSSProperties {
  const clamped = Math.max(0, Math.min(100, pct));
  return { background: `linear-gradient(to right, #34d399 ${clamped}%, #3f3f46 ${clamped}%)` };
}

/**
 * Touch-first "now playing" screen for the brewery speaker (IKEA SYMFONISK on
 * Sonos firmware), reached from the kiosk home. Landscape layout for the Pi's
 * 800×480 panel: fixed-size album art on the left; speaker label, track,
 * scrubbable progress and the transport row on the right; a full-width volume
 * bar along the bottom. The queue lives behind the header's Queue button, as a
 * panel that slides over the whole view — at this size it needs the full height
 * to be usable, and overlaying it keeps the two from crowding each other.
 * Everything is driven server-side over the LAN — no Spotify account or
 * browse/search here.
 */
export function KioskMusicPage(): JSX.Element {
  const [now, setNow] = useState<NowPlaying | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [artFailed, setArtFailed] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);

  // The volume slider and the progress/seek bar are both driven locally while a
  // finger is down, then pushed to the speaker on release — otherwise every drag
  // tick would fire a request and the poll would yank the thumb back mid-drag.
  const [volume, setVolume] = useState(30);
  const draggingVolume = useRef(false);
  const [position, setPosition] = useState(0);
  const draggingSeek = useRef(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getNowPlaying();
      setNow(data);
      if (!draggingVolume.current) setVolume(data.volume);
      if (!draggingSeek.current) {
        const pos = data.positionSec ?? 0;
        // While paused, Sonos transiently reports position 0 during the
        // play→pause transition. Position can't change while paused (seeks are
        // applied locally), so keep the last known value instead of snapping to
        // 0 and back.
        setPosition((prev) => (data.state !== 'playing' && pos === 0 && prev > 0 ? prev : pos));
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Speaker unavailable');
    }
  }, []);

  usePoll(load, POLL_MS, [load]);

  // Reset the art-failed flag whenever the artwork URL changes (new track).
  const artUrl = now?.albumArtUrl ?? null;
  useEffect(() => {
    setArtFailed(false);
  }, [artUrl]);

  const playing = now?.state === 'playing';
  const duration = now?.durationSec ?? null;

  // Tick the position locally each second while playing so the bar moves
  // smoothly between the 4s polls; the poll corrects any drift.
  useEffect(() => {
    if (!playing || duration == null) return;
    const id = setInterval(() => {
      setPosition((p) => (draggingSeek.current || p >= duration ? p : p + 1));
    }, 1000);
    return () => clearInterval(id);
  }, [playing, duration]);

  /** Run a transport action, then refresh so the state catches up. */
  async function run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      setError(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Speaker command failed');
    }
  }

  const togglePlay = () => void run(playing ? api.musicPause : api.musicPlay);

  async function commitVolume(value: number): Promise<void> {
    draggingVolume.current = false;
    try {
      await api.musicSetVolume(value);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not set volume');
    }
  }

  async function commitSeek(value: number): Promise<void> {
    draggingSeek.current = false;
    try {
      await api.musicSeek(value);
      setError(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not seek');
    }
  }

  // Sonos folds shuffle and repeat into a single setting, so either toggle has
  // to send both — hence the current mode is read back off `now`.
  const shuffle = now?.shuffle ?? false;
  const repeat = now?.repeat ?? 'off';
  const toggleShuffle = (): void =>
    void run(() => api.musicSetPlayMode(!shuffle, repeat));
  const cycleRepeat = (): void =>
    void run(() => api.musicSetPlayMode(shuffle, NEXT_REPEAT[repeat]));

  const hasMedia = now != null && now.state !== 'no_media' && now.state !== 'stopped';
  const showArt = artUrl && !artFailed;
  const hasProgress = hasMedia && duration != null;
  const seekPct = duration ? (position / duration) * 100 : 0;

  const status = error != null ? 'offline' : now != null ? 'online' : 'connecting';

  return (
    // `relative` is the containing block for the queue panel's absolute inset-0.
    <div className="touch-none-select relative flex h-full flex-col overflow-hidden bg-black text-white">
      <header className="flex shrink-0 items-center gap-3 px-5 py-2.5">
        <Link
          to="/kiosk"
          className="shrink-0 rounded-2xl bg-zinc-800 p-2.5 active:bg-zinc-700"
          aria-label="Home"
        >
          <HomeIcon className="h-6 w-6" />
        </Link>
        <h1 className="truncate text-2xl font-bold">Brewery Speaker</h1>
        <button
          type="button"
          onClick={() => setQueueOpen(true)}
          className="ml-auto flex shrink-0 touch-manipulation items-center gap-2 rounded-2xl bg-zinc-800 px-4 py-2.5 text-lg font-semibold active:bg-zinc-700"
        >
          <QueueIcon className="h-6 w-6" />
          Queue
        </button>
        <ConnectionPill status={status} />
      </header>

      {/* min-h-0 lets this column shrink inside the fixed 480px frame; the art is
          a fixed square rather than h-full so the right column keeps enough room
          for five transport buttons on one line. */}
      <main className="flex min-h-0 flex-1 items-center gap-6 px-5">
        <div className="flex h-[264px] w-[264px] shrink-0 items-center justify-center overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950">
          {showArt ? (
            <img
              src={artUrl}
              alt=""
              className="h-full w-full object-cover"
              onError={() => setArtFailed(true)}
            />
          ) : (
            <SpeakerIcon className="h-24 w-24 text-zinc-700" />
          )}
        </div>

        {/* Right column: speaker label, track, progress, transport. */}
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-3">
          <div className="flex items-center gap-3 text-zinc-400">
            <SpeakerIcon className="h-7 w-7 shrink-0" />
            <div className="min-w-0 leading-tight">
              <div className="truncate text-lg">{SPEAKER_NAME}</div>
              <div className="truncate text-base text-zinc-500">{SPEAKER_ROOM}</div>
            </div>
          </div>

          {hasMedia ? (
            <div className="min-w-0">
              <ScrollingText
                text={now?.title ?? 'Unknown track'}
                className="text-3xl font-extrabold leading-tight"
              />
              <div className="mt-1 truncate text-xl text-zinc-400">{now?.artist ?? '—'}</div>
            </div>
          ) : (
            <div className="text-2xl text-zinc-500">
              {status === 'offline' ? 'No speaker found' : 'Nothing playing'}
            </div>
          )}

          {/* Scrubbable progress (hidden for live streams with no duration). */}
          {hasProgress && (
            <div className="flex items-center gap-3">
              <span className="w-12 shrink-0 text-base tabular-nums text-zinc-300">
                {formatTime(position)}
              </span>
              <input
                type="range"
                min={0}
                max={duration ?? 0}
                value={Math.min(position, duration ?? 0)}
                aria-label="Seek"
                className="media-slider w-full cursor-pointer touch-none"
                style={fillStyle(seekPct)}
                onChange={(e) => {
                  draggingSeek.current = true;
                  setPosition(Number(e.target.value));
                }}
                onPointerUp={(e) => void commitSeek(Number((e.target as HTMLInputElement).value))}
                onTouchEnd={(e) => void commitSeek(Number((e.target as HTMLInputElement).value))}
              />
              <span className="w-14 shrink-0 text-right text-base tabular-nums text-zinc-400">
                -{formatTime((duration ?? 0) - position)}
              </span>
            </div>
          )}

          {/* Transport: shuffle · previous · play/pause · next · repeat. */}
          <div className="flex items-center gap-3">
            <TransportButton label="Shuffle" onClick={toggleShuffle} active={shuffle}>
              <ShuffleIcon className="h-6 w-6" />
            </TransportButton>
            <TransportButton label="Previous" onClick={() => void run(api.musicPrevious)}>
              <SkipPrevIcon className="h-7 w-7" />
            </TransportButton>
            <button
              type="button"
              onClick={togglePlay}
              aria-label={playing ? 'Pause' : 'Play'}
              className="flex h-[68px] w-[68px] shrink-0 touch-manipulation items-center justify-center rounded-full border-2 border-emerald-400 bg-zinc-900 text-white shadow-[0_0_25px_rgba(52,211,153,0.35)] transition active:scale-95"
            >
              {playing ? <PauseIcon className="h-9 w-9" /> : <PlayIcon className="ml-1 h-9 w-9" />}
            </button>
            <TransportButton label="Next" onClick={() => void run(api.musicNext)}>
              <SkipNextIcon className="h-7 w-7" />
            </TransportButton>
            <TransportButton
              label={`Repeat: ${repeat === 'off' ? 'off' : repeat === 'all' ? 'all' : 'this track'}`}
              onClick={cycleRepeat}
              active={repeat !== 'off'}
            >
              {repeat === 'one' ? (
                <RepeatOneIcon className="h-6 w-6" />
              ) : (
                <RepeatIcon className="h-6 w-6" />
              )}
            </TransportButton>
          </div>
        </div>
      </main>

      {/* Volume — full width along the bottom. */}
      <div className="mx-5 mb-3 mt-2 flex shrink-0 items-center gap-4 rounded-2xl bg-zinc-900/60 px-6 py-3">
        <VolumeIcon className="h-7 w-7 shrink-0 text-zinc-300" />
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          aria-label="Volume"
          className="media-slider w-full cursor-pointer touch-none"
          style={fillStyle(volume)}
          onChange={(e) => {
            draggingVolume.current = true;
            setVolume(Number(e.target.value));
          }}
          onPointerUp={(e) => void commitVolume(Number((e.target as HTMLInputElement).value))}
          onTouchEnd={(e) => void commitVolume(Number((e.target as HTMLInputElement).value))}
        />
        <span className="w-11 shrink-0 text-right text-xl tabular-nums text-zinc-300">
          {volume}
        </span>
      </div>

      {queueOpen && (
        <KioskQueuePanel onClose={() => setQueueOpen(false)} onChanged={() => void load()} />
      )}
    </div>
  );
}

/** The "● Connected" status chip in the header. */
function ConnectionPill({ status }: { status: 'online' | 'offline' | 'connecting' }): JSX.Element {
  const config = {
    online: { dot: 'bg-emerald-400', text: 'text-emerald-400', label: 'Connected' },
    offline: { dot: 'bg-red-400', text: 'text-red-400', label: 'Disconnected' },
    connecting: { dot: 'bg-zinc-500', text: 'text-zinc-400', label: 'Connecting…' },
  }[status];
  return (
    <div
      className={`ml-auto flex shrink-0 items-center gap-2 rounded-full border border-zinc-800 px-4 py-1.5 text-lg font-semibold ${config.text}`}
    >
      <span className={`h-2.5 w-2.5 rounded-full ${config.dot}`} />
      {config.label}
    </div>
  );
}

/**
 * A round secondary transport button (skip, shuffle, repeat). `active` lights it
 * green — the only state shuffle and repeat have to show, since Sonos gives no
 * other feedback that they're on.
 */
function TransportButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  /** Omit on the plain skip buttons; they're actions, not toggles. */
  active?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-14 w-14 shrink-0 touch-manipulation items-center justify-center rounded-full border transition active:scale-95 ${
        active
          ? 'border-emerald-400/70 bg-emerald-500/15 text-emerald-300'
          : 'border-zinc-800 bg-zinc-950 text-zinc-200 active:bg-zinc-800'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * A single line of text that gently scrolls horizontally when it's wider than
 * its container, so a long song title reveals its end instead of being cut off
 * with an ellipsis. Text that fits — or when the viewer prefers reduced motion —
 * renders as a normal truncating line. The scroll distance is measured from the
 * live layout, so it adapts to any title length and screen width.
 */
function ScrollingText({ text, className }: { text: string; className?: string }): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0); // px the text overflows its box by; 0 = fits, don't scroll

  useEffect(() => {
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const measure = (): void => {
      const viewport = viewportRef.current;
      const textEl = textRef.current;
      if (!viewport || !textEl) return;
      // scrollWidth is the full text width even while truncated, so this detects
      // overflow whether we're currently scrolling or showing the static line.
      const overflow = textEl.scrollWidth - viewport.clientWidth;
      setShift(!prefersReduced && overflow > 4 ? overflow : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (viewportRef.current) observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [text]);

  const scrolling = shift > 0;
  // Slow, readable pace (~45 px/s). The keyframes spend ~38% of the cycle on each
  // sweep, so scale the total duration to hold that pace whatever the distance.
  const durationSec = scrolling ? shift / 45 / 0.38 : 0;
  const style = scrolling
    ? ({ '--marquee-shift': `-${shift}px`, animationDuration: `${durationSec}s` } as React.CSSProperties)
    : undefined;

  return (
    <div ref={viewportRef} className={`overflow-hidden ${className ?? ''}`}>
      <span
        ref={textRef}
        className={scrolling ? 'marquee-pingpong inline-block whitespace-nowrap' : 'block truncate'}
        style={style}
      >
        {text}
      </span>
    </div>
  );
}
