import { DEFAULT_GRAPH_COLORS, type GraphColors } from '@checklist/shared';
import { useSyncExternalStore } from 'react';
import { api } from './api';

/**
 * The shared chart colour palette. Unlike the per-browser prefs in settings.ts,
 * this lives on the server (so every screen — desktop dashboard and Pi kiosk —
 * draws with the same colours) and is edited from the desktop Settings page.
 *
 * The store seeds from {@link DEFAULT_GRAPH_COLORS} and hydrates from the server
 * the first time anything subscribes; a failed fetch (offline, or device-mock
 * dev with no server) silently keeps the defaults. Components read it live via
 * {@link useGraphColors} so a save on this screen recolours its charts at once.
 * Other screens pick up the change on their next load.
 */

let cache: GraphColors = DEFAULT_GRAPH_COLORS;
let hydrated = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  api
    .getGraphColors()
    .then((c) => {
      cache = c;
      emit();
    })
    .catch(() => {
      // No server / not reachable — keep the default palette.
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  hydrate();
  return () => {
    listeners.delete(listener);
  };
}

export function getGraphColors(): GraphColors {
  return cache;
}

/** Subscribe a component to the live palette (re-renders on any change). */
export function useGraphColors(): GraphColors {
  return useSyncExternalStore(subscribe, getGraphColors, getGraphColors);
}

/**
 * Persist the whole palette to the server and notify subscribers. Updates the
 * local cache optimistically; rethrows if the save fails so the caller can show
 * an error (the optimistic value stays until the next successful load).
 */
export async function saveGraphColors(next: GraphColors): Promise<void> {
  cache = next;
  emit();
  await api.updateGraphColors(next);
}

/** Restore and persist the default palette. */
export async function resetGraphColors(): Promise<GraphColors> {
  await saveGraphColors(DEFAULT_GRAPH_COLORS);
  return DEFAULT_GRAPH_COLORS;
}

function isGravityMetric(metric: string): boolean {
  return metric === 'gravity_sg' || metric.endsWith('_sg');
}

/**
 * Chart stroke for a metric, resolved from the shared palette. Temperatures use
 * the "beer" colour here; the Overview and Temperature page draw the fridge line
 * with `fridgeTemp` explicitly since both lines are `temp_c`.
 */
export function metricColor(metric: string, colors: GraphColors): string {
  if (metric === 'pressure_bar') return colors.pressure;
  if (isGravityMetric(metric)) return colors.gravity;
  if (metric === 'power_w' || metric === 'energy_kwh') return colors.power;
  if (metric === 'flow_lpm' || metric === 'water_l') return colors.water;
  if (metric === 'temp_c') return colors.beerTemp;
  if (metric === 'setpoint_c') return colors.setpoint;
  if (metric === 'hvac_state') return '#a78bfa'; // state line — not user-tunable
  return colors.water;
}

/** A translucent rgba() variant of a `#rrggbb` colour, for chart area fills. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1]!, 16);
  const g = parseInt(m[2]!, 16);
  const b = parseInt(m[3]!, 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
