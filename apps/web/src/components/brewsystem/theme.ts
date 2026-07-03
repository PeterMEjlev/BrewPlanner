/**
 * Visual theme for the Brew System page, ported from brew-system-v3 so the
 * remote panel looks identical to the rig's own touchscreen. The defaults
 * mirror the rig's `:root` variables; if the rig's settings carry custom theme
 * colours they override these at runtime (see buildThemeVars).
 */

export interface BrewTheme {
  bgPrimary: string;
  bgSecondary: string;
  accentBlue: string;
  accentGreen: string;
  accentOrange: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textDark: string;
  border: string;
  borderLight: string;
  gradientWarmStart: string;
  gradientWarmEnd: string;
  gradientCoolStart: string;
  gradientCoolEnd: string;
  tempCold: string;
  tempHot: string;
}

export const DEFAULT_BREW_THEME: BrewTheme = {
  bgPrimary: '#0f172a',
  bgSecondary: '#1e293b',
  accentBlue: '#3b82f6',
  accentGreen: '#10b981',
  accentOrange: '#f97316',
  textPrimary: '#f1f5f9',
  textSecondary: '#cbd5e1',
  textMuted: '#94a3b8',
  textDark: '#64748b',
  border: '#334155',
  borderLight: '#475569',
  gradientWarmStart: '#f04c65',
  gradientWarmEnd: '#f58361',
  gradientCoolStart: '#3a47d5',
  gradientCoolEnd: '#00d2ff',
  tempCold: '#3b82f6',
  tempHot: '#ef4444',
};

/** Theme key → the CSS custom property the ported stylesheets read. */
const CSS_VAR_MAP: Record<keyof BrewTheme, string> = {
  bgPrimary: '--color-bg-primary',
  bgSecondary: '--color-bg-secondary',
  accentBlue: '--color-accent-blue',
  accentGreen: '--color-accent-green',
  accentOrange: '--color-accent-orange',
  textPrimary: '--color-text-primary',
  textSecondary: '--color-text-secondary',
  textMuted: '--color-text-muted',
  textDark: '--color-text-dark',
  border: '--color-border',
  borderLight: '--color-border-light',
  gradientWarmStart: '--color-gradient-warm-start',
  gradientWarmEnd: '--color-gradient-warm-end',
  gradientCoolStart: '--color-gradient-cool-start',
  gradientCoolEnd: '--color-gradient-cool-end',
  tempCold: '--color-temp-cold',
  tempHot: '--color-temp-hot',
};

/** Merge the rig's custom theme colours (if any) over the defaults. */
export function mergeBrewTheme(rigTheme: Record<string, string> | undefined): BrewTheme {
  if (!rigTheme) return DEFAULT_BREW_THEME;
  const merged = { ...DEFAULT_BREW_THEME };
  for (const key of Object.keys(CSS_VAR_MAP) as (keyof BrewTheme)[]) {
    const v = rigTheme[key];
    if (typeof v === 'string' && v) merged[key] = v;
  }
  return merged;
}

/** Inline CSS-variable overrides for the panel root (win over the stylesheet defaults). */
export function buildThemeVars(theme: BrewTheme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, cssVar] of Object.entries(CSS_VAR_MAP) as [keyof BrewTheme, string][]) {
    vars[cssVar] = theme[key];
  }
  return vars;
}

/**
 * Temperature colour gradient, 0–100 °C mapped blue → red (no green/yellow),
 * same maths as the rig so both UIs colour a temperature identically.
 */
export function getTemperatureColor(temp: number): string {
  const t = Math.max(0, Math.min(100, temp));
  const ratio = t / 100;
  const r = Math.round(59 + (239 - 59) * ratio);
  const g = Math.round(130 - 130 * ratio + 68 * ratio);
  const b = Math.round(246 - (246 - 68) * ratio);
  return `rgb(${r}, ${g}, ${b})`;
}
