import type { NowPlaying } from '@checklist/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import {
  PauseIcon,
  PlayIcon,
  SkipNextIcon,
  SkipPrevIcon,
  SpeakerIcon,
  VolumeIcon,
} from '../components/icons';

/** Now-playing moves quickly enough that a few seconds feels live. */
const POLL_MS = 4000;

/**
 * Touch-first "now playing" screen for the brewery speaker (Sonos / IKEA
 * SYMFONISK), reached from the kiosk home where the settings gear used to be.
 * MVP, Path A from the music research: it controls whatever the speaker is
 * already playing — album art + track, play/pause/skip, and volume — driven
 * server-side over the LAN. No Spotify account or browse/search here yet.
 */
export function KioskMusicPage(): JSX.Element {
  const [now, setNow] = useState<NowPlaying | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [artFailed, setArtFailed] = useState(false);

  // The volume slider is driven locally while the finger is down, then pushed to
  // the speaker on release — otherwise every drag tick would fire a request and
  // the poll would yank the thumb back mid-drag.
  const [volume, setVolume] = useState(30);
  const draggingVolume = useRef(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getNowPlaying();
      setNow(data);
      if (!draggingVolume.current) setVolume(data.volume);
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

  const playing = now?.state === 'playing';
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

  const hasMedia = now != null && now.state !== 'no_media' && now.state !== 'stopped';
  const showArt = artUrl && !artFailed;

  return (
    <div className="touch-none-select flex h-full flex-col bg-black text-white">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-6 py-4">
        <Link
          to="/kiosk"
          className="shrink-0 rounded-xl bg-zinc-800 px-4 py-3 text-2xl leading-none active:bg-zinc-700"
          aria-label="Home"
        >
          ⌂
        </Link>
        <h1 className="truncate py-1 text-3xl font-bold leading-normal">
          {now?.room ?? 'Brewery Speaker'}
        </h1>
      </header>

      {error && (
        <div className="bg-red-900/40 px-6 py-2 text-center text-lg text-red-300">{error}</div>
      )}

      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-7 px-8 py-6">
        {/* Album art (or a speaker placeholder). */}
        <div className="flex aspect-square w-full max-w-[15rem] shrink items-center justify-center overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950">
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

        {/* Track / artist (or an idle message). */}
        <div className="min-h-0 w-full max-w-md text-center">
          {hasMedia ? (
            <>
              <div className="truncate text-3xl font-bold leading-tight">
                {now?.title ?? 'Unknown track'}
              </div>
              <div className="mt-1 truncate text-xl text-zinc-400">
                {now?.artist ?? '—'}
              </div>
            </>
          ) : (
            <div className="text-2xl text-zinc-500">
              {error ? 'No speaker found' : 'Nothing playing'}
            </div>
          )}
        </div>

        {/* Transport: previous · play/pause · next. */}
        <div className="flex items-center justify-center gap-6">
          <TransportButton label="Previous" onClick={() => void run(api.musicPrevious)}>
            <SkipPrevIcon className="h-9 w-9" />
          </TransportButton>
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? 'Pause' : 'Play'}
            className="flex h-24 w-24 touch-manipulation items-center justify-center rounded-full bg-white text-black transition active:scale-95"
          >
            {playing ? (
              <PauseIcon className="h-11 w-11" />
            ) : (
              <PlayIcon className="ml-1 h-11 w-11" />
            )}
          </button>
          <TransportButton label="Next" onClick={() => void run(api.musicNext)}>
            <SkipNextIcon className="h-9 w-9" />
          </TransportButton>
        </div>

        {/* Volume. */}
        <div className="flex w-full max-w-md items-center gap-4 px-2">
          <VolumeIcon className="h-7 w-7 shrink-0 text-zinc-400" />
          <input
            type="range"
            min={0}
            max={100}
            value={volume}
            aria-label="Volume"
            onChange={(e) => {
              draggingVolume.current = true;
              setVolume(Number(e.target.value));
            }}
            onPointerUp={(e) => void commitVolume(Number((e.target as HTMLInputElement).value))}
            onTouchEnd={(e) => void commitVolume(Number((e.target as HTMLInputElement).value))}
            className="h-3 w-full cursor-pointer touch-manipulation appearance-none rounded-full bg-zinc-800 accent-white"
          />
          <span className="w-12 shrink-0 text-right text-xl tabular-nums text-zinc-300">
            {volume}
          </span>
        </div>
      </main>
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
