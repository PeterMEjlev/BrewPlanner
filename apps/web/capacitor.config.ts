import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor wraps the same Vite build that the browser app uses (webDir: dist)
 * into the Android app — there is no second codebase. The web view serves the
 * bundle from `https://localhost`, which is in the server's CORS allow-list; the
 * actual server URL is chosen at runtime in the in-app setup screen, so nothing
 * here is environment-specific.
 */
const config: CapacitorConfig = {
  appId: 'com.konfus.app',
  appName: 'Konfus',
  webDir: 'dist',
  android: {
    // Match the app's dark background so there's no white flash before React mounts.
    backgroundColor: '#09090b',
  },
  server: {
    // https is Capacitor's Android default; set explicitly so the API's allowed
    // origin (https://localhost) stays obvious alongside this file.
    androidScheme: 'https',
  },
};

export default config;
