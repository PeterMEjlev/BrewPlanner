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
  }

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
  }

  export class AsyncDeviceDiscovery {
    discover(options?: { timeout?: number }): Promise<Sonos>;
  }
}
