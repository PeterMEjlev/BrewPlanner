import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

/**
 * Native-app glue. The same React app runs as a browser web app and, bundled by
 * Capacitor, as the Android app. In the browser it's served by the Pi's server
 * and talks to it same-origin (`/api/…`) with a session cookie. In the native
 * app the bundle runs from a `localhost` origin and talks to the Pi across the
 * Cloudflare tunnel, so it needs (a) an absolute API base URL — chosen once in
 * the in-app setup screen — and (b) a bearer token instead of a cookie (the
 * browser won't attach a cross-origin cookie). This module holds both, plus the
 * platform check the rest of the app branches on.
 */

const SERVER_URL_KEY = 'konfus.serverUrl';
const TOKEN_KEY = 'konfus.authToken';

/** True when running inside the native (Capacitor) app, false in a browser. */
export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

// Hydrated once at startup (see hydrateConfig) so the rest of the app — notably
// the API layer, which can't await on every request — can read them synchronously.
let serverUrl = '';
let authToken: string | null = null;

/** Load the saved server URL + token before the app first renders (native only). */
export async function hydrateConfig(): Promise<void> {
  if (!isNative()) return;
  const [url, token] = await Promise.all([
    Preferences.get({ key: SERVER_URL_KEY }),
    Preferences.get({ key: TOKEN_KEY }),
  ]);
  serverUrl = (url.value ?? '').replace(/\/+$/, '');
  authToken = token.value ?? null;
}

/**
 * Base for API calls. Empty string in the browser (so calls stay same-origin,
 * `/api/…`); the configured server origin in the native app (so they go over the
 * tunnel, `https://host/api/…`).
 */
export function getApiBase(): string {
  return serverUrl;
}

/** The configured server origin (native only), e.g. `https://brew.example.com`. */
export function getServerUrl(): string {
  return serverUrl;
}

/** Whether a server URL has been chosen. Always true in the browser (same-origin). */
export function hasServerUrl(): boolean {
  return !isNative() || serverUrl !== '';
}

/** Persist the server origin chosen in the setup screen. Trailing slashes trimmed. */
export async function setServerUrl(url: string): Promise<void> {
  serverUrl = url.trim().replace(/\/+$/, '');
  await Preferences.set({ key: SERVER_URL_KEY, value: serverUrl });
}

/** The full-access bearer token, or null. Only ever set in the native app. */
export function getToken(): string | null {
  return authToken;
}

/** Store (or, with null, clear) the bearer token. No-op in the browser. */
export async function setToken(token: string | null): Promise<void> {
  if (!isNative()) return;
  authToken = token;
  if (token) await Preferences.set({ key: TOKEN_KEY, value: token });
  else await Preferences.remove({ key: TOKEN_KEY });
}

// --- 401 handling -----------------------------------------------------------
// The API layer can't import the router directly without an import cycle, so a
// 401 calls through this hook. main.tsx registers a handler that navigates to
// /login via the router (no full page reload, which would break in the bundled
// app since there's no server at the localhost origin to serve /login).

let unauthorizedHandler: () => void = () => {
  window.location.assign('/login');
};

export function setUnauthorizedHandler(fn: () => void): void {
  unauthorizedHandler = fn;
}

export function handleUnauthorized(): void {
  unauthorizedHandler();
}
