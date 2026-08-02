import type { BrewPot } from '@checklist/shared';

/**
 * The three vessels of the brewing rig, in the order its own screen shows them.
 * Shared by the Overview's brew-system card and its enlarged view so the two
 * always agree on naming and colour.
 */

/** Keys of {@link BrewSystemState.temperatures} — MLT is a sensor with no heater. */
export type Vessel = 'bk' | 'mlt' | 'hlt';

export interface VesselMeta {
  key: Vessel;
  /** The rig's own short name, as painted on the brewery. */
  label: string;
  /** Spelled out, where there's room for it. */
  name: string;
  /**
   * The rig's chart colour for this vessel (its ThemeContext vesselBK/MLT/HLT),
   * so a trace here is the colour a brewer already reads it as on the rig.
   */
  color: string;
  /** The control key, for the two vessels that have a heater. */
  pot: BrewPot | null;
}

export const VESSELS: readonly VesselMeta[] = [
  { key: 'bk', label: 'BK', name: 'Boil Kettle', color: '#ef4444', pot: 'BK' },
  { key: 'mlt', label: 'MLT', name: 'Mash Tun', color: '#10b981', pot: null },
  { key: 'hlt', label: 'HLT', name: 'Hot Liquor Tank', color: '#3b82f6', pot: 'HLT' },
] as const;

/** One decimal place, or an em-dash-ish `--` for a sensor that didn't answer. */
export function formatTemp(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '--';
}

/** The rig's timer as h:mm:ss, dropping the hours until there are some. */
export function formatTimerSeconds(total: number): string {
  const seconds = Math.max(0, Math.round(total));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}
