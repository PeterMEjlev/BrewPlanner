import type { MusicQueue, MusicRepeat, NowPlaying } from '@checklist/shared';
import { AsyncDeviceDiscovery, type PlayMode, Sonos } from 'sonos';

/**
 * Brewery speaker control. The IKEA SYMFONISK in the brewery runs Sonos
 * firmware, so we drive it directly over the LAN with the `sonos` library — no
 * Spotify account, OAuth, or cloud round-trip (Path A of the music research in
 * TODO.md). This is the MVP surface: read now-playing and run basic transport
 * (play/pause/skip) + volume on whatever the speaker is already playing.
 *
 * Targeting (most reliable first):
 *   - SONOS_HOST=<ip>     talk to that speaker directly (no discovery needed).
 *   - SONOS_ROOM=<name>   SSDP-discover, then pick the zone with this name.
 *   - (neither)           SSDP-discover and use the first speaker that answers.
 *
 * Discovery is multicast and slow, so the resolved device is cached; a control
 * error drops the cache so the next call re-resolves (handles an IP change).
 */

/** Raised when no speaker can be reached, so routes can answer a clean 503. */
export class SonosUnavailableError extends Error {
  constructor(message = 'No Sonos speaker could be reached on the network.') {
    super(message);
    this.name = 'SonosUnavailableError';
  }
}

let cached: Sonos | null = null;
let cachedRoom: string | null = null;

/** Forget the resolved speaker so the next call re-discovers it. */
function resetDevice(): void {
  cached = null;
  cachedRoom = null;
}

/** Resolve (and cache) the speaker to control, per the targeting rules above. */
async function resolveDevice(): Promise<Sonos> {
  if (cached) return cached;

  const host = process.env.SONOS_HOST?.trim();
  if (host) {
    cached = new Sonos(host);
    cachedRoom = process.env.SONOS_ROOM?.trim() || null;
    return cached;
  }

  let discovered: Sonos;
  try {
    discovered = await new AsyncDeviceDiscovery().discover({ timeout: 5000 });
  } catch {
    throw new SonosUnavailableError();
  }

  const room = process.env.SONOS_ROOM?.trim();
  if (room) {
    // Best-effort name match; fall back to the first device if anything throws
    // or the name isn't found, so a typo never leaves the page dead.
    try {
      const groups = await discovered.getAllGroups();
      for (const group of groups) {
        for (const member of group.ZoneGroupMember ?? []) {
          if (member.ZoneName?.toLowerCase() === room.toLowerCase()) {
            cached = new Sonos(new URL(member.Location).hostname);
            cachedRoom = member.ZoneName;
            return cached;
          }
        }
      }
    } catch {
      // ignore — use the discovered device below
    }
  }

  cached = discovered;
  cachedRoom = room || null;
  return cached;
}

/** Run an action against the speaker, dropping the cache on failure. */
async function withDevice<T>(action: (device: Sonos) => Promise<T>): Promise<T> {
  const device = await resolveDevice();
  try {
    return await action(device);
  } catch (err) {
    resetDevice();
    if (err instanceof SonosUnavailableError) throw err;
    throw new SonosUnavailableError(
      err instanceof Error ? err.message : 'Sonos command failed.',
    );
  }
}

/** Map the speaker's transport state onto our NowPlaying union. */
function normalizeState(raw: string): NowPlaying['state'] {
  switch (raw) {
    case 'playing':
    case 'paused':
    case 'stopped':
    case 'transitioning':
      return raw;
    default:
      return 'no_media';
  }
}

/** A speaker field that's empty/blank becomes null for a clean UI. */
function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** A non-positive duration/position (live stream, nothing queued) becomes null. */
function positiveOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && value > 0 ? value : null;
}

/**
 * Split the speaker's single PlayMode string into the two toggles the UI shows.
 * Sonos folds shuffle and repeat into one enum, and confusingly plain `SHUFFLE`
 * means "shuffle *and* repeat all" — `SHUFFLE_NOREPEAT` is shuffle on its own.
 */
function splitPlayMode(mode: string): { shuffle: boolean; repeat: MusicRepeat } {
  switch (mode) {
    case 'REPEAT_ALL':
      return { shuffle: false, repeat: 'all' };
    case 'REPEAT_ONE':
      return { shuffle: false, repeat: 'one' };
    case 'SHUFFLE':
      return { shuffle: true, repeat: 'all' };
    case 'SHUFFLE_NOREPEAT':
      return { shuffle: true, repeat: 'off' };
    case 'SHUFFLE_REPEAT_ONE':
      return { shuffle: true, repeat: 'one' };
    default:
      return { shuffle: false, repeat: 'off' };
  }
}

/** The inverse of splitPlayMode: the two toggles back into one Sonos PlayMode. */
function joinPlayMode(shuffle: boolean, repeat: MusicRepeat): PlayMode {
  if (shuffle) {
    if (repeat === 'all') return 'SHUFFLE';
    return repeat === 'one' ? 'SHUFFLE_REPEAT_ONE' : 'SHUFFLE_NOREPEAT';
  }
  if (repeat === 'all') return 'REPEAT_ALL';
  return repeat === 'one' ? 'REPEAT_ONE' : 'NORMAL';
}

/** currentTrack() reports NaN or 0 for a source that isn't the queue. */
function queueSlotOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Read what the brewery speaker is currently playing. */
export async function getNowPlaying(): Promise<NowPlaying> {
  return withDevice(async (device) => {
    const [track, rawState, volume, rawMode] = await Promise.all([
      device.currentTrack(),
      device.getCurrentState(),
      device.getVolume(),
      // Some sources don't implement GetTransportSettings; a missing play mode
      // shouldn't take the whole now-playing panel down with it.
      device.getPlayMode().catch(() => 'NORMAL'),
    ]);
    const { shuffle, repeat } = splitPlayMode(rawMode);
    return {
      state: normalizeState(rawState),
      title: clean(track.title),
      artist: clean(track.artist),
      album: clean(track.album),
      albumArtUrl: clean(track.albumArtURL),
      durationSec: positiveOrNull(track.duration),
      positionSec: positiveOrNull(track.position),
      volume: typeof volume === 'number' ? volume : 0,
      room: cachedRoom,
      queuePosition: queueSlotOrNull(track.queuePosition),
      shuffle,
      repeat,
    };
  });
}

/**
 * Read the speaker's queue, plus which slot is playing right now. A speaker on
 * a radio stream or a Spotify Connect session has no Sonos queue at all, which
 * surfaces here as an empty list rather than an error.
 */
export async function getQueue(): Promise<MusicQueue> {
  return withDevice(async (device) => {
    const [result, track] = await Promise.all([
      // An empty queue comes back as an empty DIDL document, which the library
      // parses inconsistently — sometimes throwing rather than yielding no
      // items. `currentTrack` below is the reachability check, so a queue that
      // won't parse is reported as empty rather than as a dead speaker.
      device.getQueue().catch(() => null),
      device.currentTrack(),
    ]);
    const items = result?.items ?? [];
    return {
      tracks: items.map((item, index) => ({
        position: index + 1,
        title: clean(item.title),
        artist: clean(item.artist),
        album: clean(item.album),
        albumArtUrl: clean(item.albumArtURI ?? undefined),
        uri: clean(item.uri),
      })),
      currentPosition: queueSlotOrNull(track.queuePosition),
    };
  });
}

/** Set shuffle and repeat together (Sonos only exposes them as one setting). */
export async function setPlayMode(shuffle: boolean, repeat: MusicRepeat): Promise<void> {
  await withDevice((device) => device.setPlayMode(joinPlayMode(shuffle, repeat)));
}

/** Jump the speaker to a queue slot (1-based) and play it. */
export async function playQueuePosition(position: number): Promise<void> {
  await withDevice(async (device) => {
    await device.selectTrack(position);
    await device.play();
  });
}

/** Drop a track out of the queue by its 1-based position. */
export async function removeFromQueue(position: number): Promise<void> {
  await withDevice((device) => device.removeTracksFromQueue(position, 1));
}

/**
 * Move the track at `from` so it ends up at `to` (both 1-based, as displayed).
 *
 * Sonos doesn't take a destination — it takes `InsertBefore`, the slot in the
 * *pre-move* queue that the track should land in front of. Moving a track down
 * the list therefore has to aim one slot past the target, because removing the
 * track from above shifts everything below it up by one.
 */
export async function reorderQueue(from: number, to: number): Promise<void> {
  if (from === to) return;
  const insertBefore = to > from ? to + 1 : to;
  await withDevice((device) => device.reorderTracksInQueue(from, 1, insertBefore));
}

export async function play(): Promise<void> {
  await withDevice((device) => device.play());
}

export async function pause(): Promise<void> {
  await withDevice((device) => device.pause());
}

export async function next(): Promise<void> {
  await withDevice((device) => device.next());
}

export async function previous(): Promise<void> {
  await withDevice((device) => device.previous());
}

export async function setVolume(volume: number): Promise<void> {
  await withDevice((device) => device.setVolume(volume));
}

/** Seek to an absolute position (seconds) within the current track. */
export async function seek(positionSec: number): Promise<void> {
  await withDevice((device) => device.seek(positionSec));
}
