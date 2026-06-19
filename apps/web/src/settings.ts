import { useSyncExternalStore } from 'react';

/**
 * Kiosk-local preferences the brewer can tune from the Settings screen. These
 * live in localStorage (not the server): they're display/threshold choices for
 * *this* screen, so the touch kiosk and a laptop browsing the same dashboard can
 * each keep their own. The store is exposed through {@link useSettings} so the
 * home hub re-renders the instant a setting changes — no reload, no peripherals.
 */

export type PressureUnit = 'bar' | 'psi';

export interface Settings {
  /** Unit for the fermenter pressure reading (stored in bar, shown either way). */
  pressureUnit: PressureUnit;
  /** Gravity must hold flat this many days before fermentation reads "Complete". */
  fermentStableDays: number;
  /** Max SG spread over that window still counted as "flat". */
  fermentThresholdSg: number;
  /** How often (seconds) the desktop dashboard re-polls device status. */
  dashboardRefreshSec: number;
  /**
   * User zoom multiplier for the desktop Overview. 1 keeps the previous
   * auto-fit-only behaviour; below 1 shrinks everything, above 1 enlarges it
   * (the dashboard then scrolls if it no longer fits one screen).
   */
  dashboardZoom: number;
}

/**
 * Defaults match the kiosk's previous hardcoded behaviour: pressure shown in PSI,
 * the classic "flat for ~2 days within 0.002 SG" fermentation check, and the 10s
 * dashboard poll that was previously hardcoded.
 */
export const DEFAULT_SETTINGS: Settings = {
  pressureUnit: 'psi',
  fermentStableDays: 2,
  fermentThresholdSg: 0.002,
  dashboardRefreshSec: 10,
  dashboardZoom: 1,
};

/** Selectable dashboard refresh cadences, in seconds (desktop Settings page). */
export const REFRESH_SEC_OPTIONS = [5, 10, 30, 60] as const;

// Tuning bounds + step sizes, shared by the steppers so clamping and the UI
// agree. Days move in half-day clicks (1–7 days); the SG threshold in 0.001
// clicks (0.001–0.010), the granularity a Tilt actually resolves.
export const FERMENT_DAYS = { min: 0.5, max: 7, step: 0.5 } as const;
export const FERMENT_SG = { min: 0.001, max: 0.01, step: 0.001 } as const;

// Dashboard zoom range: half size up to double, in 10% clicks. The upper bound
// matches the "enlarge at most 2×" guidance for large monitors.
export const DASHBOARD_ZOOM = { min: 0.5, max: 2, step: 0.1 } as const;

const STORAGE_KEY = 'brewplanner.settings';
const BAR_TO_PSI = 14.5038;

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    // Merge over defaults so a partial/older stored blob still yields every key.
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

let cache: Settings = load();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Mirror changes made in another tab/window of the same kiosk.
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      cache = load();
      emit();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function getSettings(): Settings {
  return cache;
}

/** Update one setting, persist it, and notify subscribers. */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  cache = { ...cache, [key]: value };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage can throw (private mode, quota) — keep the in-memory value.
  }
  emit();
}

/** Restore every per-browser preference to its default and notify subscribers. */
export function resetSettings(): void {
  cache = DEFAULT_SETTINGS;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Keep the in-memory defaults if persistence fails.
  }
  emit();
}

/** Subscribe a component to the live settings (re-renders on any change). */
export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings);
}

/** Clamp a stepped value into [min, max] and round to the step to avoid float drift. */
export function clampStep(value: number, { min, max, step }: { min: number; max: number; step: number }): number {
  const clamped = Math.min(max, Math.max(min, value));
  return Math.round(clamped / step) * step;
}

/** A bar reading as the chosen unit: integer PSI, or 2-decimal bar. */
export function formatPressure(bar: number, unit: PressureUnit): { value: string; unit: string } {
  return unit === 'psi'
    ? { value: String(Math.round(bar * BAR_TO_PSI)), unit: 'PSI' }
    : { value: bar.toFixed(2), unit: 'bar' };
}
