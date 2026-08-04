/**
 * Minimal ambient types for the `sonos` package (it ships no declarations). Only
 * the surface used by ../sonos.ts is described; extend as we use more of it.
 */
declare module 'sonos' {
  export interface Track {
    title?: string;
    artist?: string;
    album?: string;
    albumArtURL?: string;
    duration?: number;
    position?: number;
    uri?: string;
    /** 1-based slot in the queue; NaN/0 when the source isn't the queue. */
    queuePosition?: number;
  }

  /** A queue entry as returned by getQueue() — browse results, not the loaded track. */
  export interface QueueItem {
    id?: string;
    title?: string;
    artist?: string;
    album?: string;
    /** Already absolutised to `http://<speaker>:1400/...` by the library. */
    albumArtURI?: string | null;
    uri?: string;
  }

  export interface QueueResult {
    returned?: string;
    total?: string;
    updateID?: string;
    /** Undefined rather than empty when the queue has no tracks. */
    items?: QueueItem[];
  }

  export type PlayMode =
    | 'NORMAL'
    | 'REPEAT_ONE'
    | 'REPEAT_ALL'
    | 'SHUFFLE'
    | 'SHUFFLE_NOREPEAT'
    | 'SHUFFLE_REPEAT_ONE';

  export interface ZoneGroupMember {
    ZoneName: string;
    Location: string;
    UUID: string;
  }

  export interface ZoneGroup {
    Name?: string;
    host?: string;
    port?: number;
    Coordinator?: string;
    ZoneGroupMember: ZoneGroupMember[];
  }

  export class Sonos {
    constructor(host: string, port?: number);
    host: string;
    currentTrack(): Promise<Track>;
    getCurrentState(): Promise<string>;
    getVolume(): Promise<number>;
    setVolume(volume: number): Promise<unknown>;
    play(): Promise<unknown>;
    pause(): Promise<unknown>;
    next(): Promise<unknown>;
    previous(): Promise<unknown>;
    seek(seconds: number): Promise<unknown>;
    getAllGroups(): Promise<ZoneGroup[]>;
    getZoneAttrs(): Promise<{ CurrentZoneName?: string }>;
    getQueue(): Promise<QueueResult>;
    /** Jump to a queue slot (1-based). */
    selectTrack(trackNr: number): Promise<unknown>;
    removeTracksFromQueue(startIndex: number, numberOfTracks?: number): Promise<unknown>;
    reorderTracksInQueue(
      startingIndex: number,
      numberOfTracks: number,
      insertBefore: number,
      updateId?: number,
    ): Promise<unknown>;
    getPlayMode(): Promise<string>;
    setPlayMode(playmode: PlayMode): Promise<unknown>;
  }

  export class AsyncDeviceDiscovery {
    discover(options?: { timeout?: number }): Promise<Sonos>;
  }
}
