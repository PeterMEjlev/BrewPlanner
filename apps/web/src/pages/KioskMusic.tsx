import type { NowPlaying } from '@checklist/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import {
  HomeIcon,
  PauseIcon,
  PlayIcon,
  SkipNextIcon,
  SkipPrevIcon,
  SpeakerIcon,
  VolumeIcon,
} from '../components/icons';

/** Now-playing moves quickly enough that a few seconds feels live. */
const POLL_MS = 4000;

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
 * Sonos firmware), reached from the kiosk home. Landscape layout: album art on
 * the left; speaker label, track, scrubbable progress bar, and transport on the
 * right; a full-width volume bar along the bottom. Everything is driven
 * server-side over the LAN — no Spotify account or browse/search here.
 */
export function KioskMusicPage(): JSX.Element {
  const [now, setNow] = useState<NowPlaying | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [artFailed, setArtFailed] = useState(false);

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
      if (!draggingSeek.current) setPosition(data.positionSec ?? 0);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Speaker unavailable');
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

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

  const hasMedia = now != null && now.state !== 'no_media' && now.state !== 'stopped';
  const showArt = artUrl && !artFailed;
  const hasProgress = hasMedia && duration != null;
  const seekPct = duration ? (position / duration) * 100 : 0;

  const status = error != null ? 'offline' : now != null ? 'online' : 'connecting';

  return (
    <div className="touch-none-select flex h-full flex-col bg-black text-white">
      <header className="flex items-center gap-4 px-8 py-5">
        <Link
          to="/kiosk"
          className="shrink-0 rounded-2xl bg-zinc-800 p-3 active:bg-zinc-700"
          aria-label="Home"
        >
          <HomeIcon className="h-7 w-7" />
        </Link>
        <h1 className="truncate text-3xl font-bold">Brewery Speaker</h1>
        <ConnectionPill status={status} />
      </header>

      <main className="flex min-h-0 flex-1 items-stretch gap-8 px-8">
        {/* Album art (or a speaker placeholder), sized to fill the column height. */}
        <div className="flex aspect-square h-full shrink-0 items-center justify-center overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950">
          {showArt ? (
            <img
              src={artUrl}
              alt=""
              className="h-full w-full object-cover"
              onError={() => setArtFailed(true)}
            />
          ) : (
            <SpeakerIcon className="h-28 w-28 text-zinc-700" />
          )}
        </div>

        {/* Right column: speaker label, track, progress, transport. */}
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-5">
          <div className="flex items-center gap-3 text-zinc-400">
            <SpeakerIcon className="h-9 w-9 shrink-0" />
            <div className="min-w-0 leading-tight">
              <div className="truncate text-xl">{SPEAKER_NAME}</div>
              <div className="truncate text-lg text-zinc-500">{SPEAKER_ROOM}</div>
            </div>
          </div>

          {hasMedia ? (
            <div className="min-w-0">
              <div className="truncate text-4xl font-extrabold leading-tight xl:text-5xl">
                {now?.title ?? 'Unknown track'}
              </div>
              <div className="mt-2 truncate text-2xl text-zinc-400">{now?.artist ?? '—'}</div>
            </div>
          ) : (
            <div className="text-3xl text-zinc-500">
              {status === 'offline' ? 'No speaker found' : 'Nothing playing'}
            </div>
          )}

          {/* Scrubbable progress (hidden for live streams with no duration). */}
          {hasProgress && (
            <div className="flex items-center gap-4">
              <span className="w-14 shrink-0 text-lg tabular-nums text-zinc-300">
                {formatTime(position)}
              </span>
              <input
                type="range"
                min={0}
                max={duration ?? 0}
                value={Math.min(position, duration ?? 0)}
                aria-label="Seek"
                className="media-slider w-full cursor-pointer touch-manipulation"
                style={fillStyle(seekPct)}
                onChange={(e) => {
                  draggingSeek.current = true;
                  setPosition(Number(e.target.value));
                }}
                onPointerUp={(e) => void commitSeek(Number((e.target as HTMLInputElement).value))}
                onTouchEnd={(e) => void commitSeek(Number((e.target as HTMLInputElement).value))}
              />
              <span className="w-16 shrink-0 text-right text-lg tabular-nums text-zinc-400">
                -{formatTime((duration ?? 0) - position)}
              </span>
            </div>
          )}

          {/* Transport: previous · play/pause · next. */}
          <div className="flex items-center gap-6">
            <TransportButton label="Previous" onClick={() => void run(api.musicPrevious)}>
              <SkipPrevIcon className="h-9 w-9" />
            </TransportButton>
            <button
              type="button"
              onClick={togglePlay}
              aria-label={playing ? 'Pause' : 'Play'}
              className="flex h-20 w-20 touch-manipulation items-center justify-center rounded-full border-2 border-emerald-400 bg-zinc-900 text-white shadow-[0_0_25px_rgba(52,211,153,0.35)] transition active:scale-95"
            >
              {playing ? (
                <PauseIcon className="h-10 w-10" />
              ) : (
                <PlayIcon className="ml-1 h-10 w-10" />
              )}
            </button>
            <TransportButton label="Next" onClick={() => void run(api.musicNext)}>
              <SkipNextIcon className="h-9 w-9" />
            </TransportButton>
          </div>
        </div>
      </main>

      {/* Volume — full width along the bottom. */}
      <div className="mx-6 mb-6 mt-4 flex items-center gap-5 rounded-3xl bg-zinc-900/60 px-8 py-5">
        <VolumeIcon className="h-8 w-8 shrink-0 text-zinc-300" />
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          aria-label="Volume"
          className="media-slider w-full cursor-pointer touch-manipulation"
          style={fillStyle(volume)}
          onChange={(e) => {
            draggingVolume.current = true;
            setVolume(Number(e.target.value));
          }}
          onPointerUp={(e) => void commitVolume(Number((e.target as HTMLInputElement).value))}
          onTouchEnd={(e) => void commitVolume(Number((e.target as HTMLInputElement).value))}
        />
        <span className="w-12 shrink-0 text-right text-2xl tabular-nums text-zinc-300">
          {volume}
        </span>
      </div>
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

/** A round secondary transport button (previous / next). */
function TransportButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-16 w-16 touch-manipulation items-center justify-center rounded-full border border-zinc-800 bg-zinc-950 text-zinc-200 transition active:scale-95 active:bg-zinc-800"
    >
      {children}
    </button>
  );
}
