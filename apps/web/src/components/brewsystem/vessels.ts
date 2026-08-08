import type { BrewPot } from '@checklist/shared';
import type { BrewTheme } from './theme';

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
  /** Which of the rig's themeable vessel colours this one is drawn in. */
  themeKey: 'vesselBK' | 'vesselMLT' | 'vesselHLT';
  /** The control key, for the two vessels that have a heater. */
  pot: BrewPot | null;
}

export const VESSELS: readonly VesselMeta[] = [
  { key: 'bk', label: 'BK', name: 'Boil Kettle', themeKey: 'vesselBK', pot: 'BK' },
  { key: 'mlt', label: 'MLT', name: 'Mash Tun', themeKey: 'vesselMLT', pot: null },
  { key: 'hlt', label: 'HLT', name: 'Hot Liquor Tank', themeKey: 'vesselHLT', pot: 'HLT' },
] as const;

/**
 * What colour to draw a vessel in, from the rig's own theme — so a trace here
 * is the colour the brewer already reads it as on the rig's screen. Pair with
 * {@link useRigTheme}; the colour was hardcoded here until the rig's vessel
 * colours became themeable and this stopped being true.
 */
export function vesselColor(theme: BrewTheme, vessel: VesselMeta): string {
  return theme[vessel.themeKey];
}

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
