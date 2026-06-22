import type { NowPlaying } from '@checklist/shared';
import { AsyncDeviceDiscovery, Sonos } from 'sonos';

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

/** Read what the brewery speaker is currently playing. */
export async function getNowPlaying(): Promise<NowPlaying> {
  return withDevice(async (device) => {
    const [track, rawState, volume] = await Promise.all([
      device.currentTrack(),
      device.getCurrentState(),
      device.getVolume(),
    ]);
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
    };
  });
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
