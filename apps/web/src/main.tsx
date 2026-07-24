import { App as CapacitorApp } from '@capacitor/app';
import { Style, StatusBar } from '@capacitor/status-bar';
import React, { Suspense, lazy, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom';
import { RequireAuth } from './auth';
import { hasServerUrl, hydrateConfig, isNative, setUnauthorizedHandler } from './native';
import { ReopenSetupContext } from './setupContext';
import { ServerSetup } from './pages/ServerSetup';
import { KioskFrame } from './components/KioskFrame';
import { AdminPage } from './pages/Admin';
import { AlertsPage } from './pages/Alerts';
import { BrewSystemPage } from './pages/BrewSystem';
import { BrucePage } from './pages/Bruce';
import { DashboardPage } from './pages/Dashboard';
import { DevicesPage } from './pages/Devices';
import { DisplayPage } from './pages/Display';
import { HistoryPage } from './pages/History';
import { KegsPage } from './pages/Kegs';
import { KegsDesktopPage } from './pages/KegsDesktop';
import { KioskHomePage } from './pages/KioskHome';
import { KioskMusicPage } from './pages/KioskMusic';
import { KioskTodosPage } from './pages/KioskTodos';
import { LoginPage } from './pages/Login';
import { RecipesPage } from './pages/Recipes';
import { RecipesDesktopPage } from './pages/RecipesDesktop';
import { SettingsDesktopPage } from './pages/SettingsDesktop';
import { TodosPage } from './pages/Todos';
import { WaterCalculatorPage } from './pages/WaterCalculator';
import './index.css';

// The physical Pi kiosk launches Chromium with ?kiosk=1 (see
// deploy/checklist-kiosk.service). Latch that onto <html> so CSS can hide the
// mouse pointer for the whole session: react-router drops the query string on
// the first in-app navigation, and on the Pi the pointer media query is
// unreliable (cage/wlroots reports a fine pointer), so a one-time class is the
// dependable signal that "we are the kiosk".
if (new URLSearchParams(window.location.search).has('kiosk')) {
  document.documentElement.classList.add('kiosk');
}

// The chart pages pull in recharts (~400 kB). Load them on demand so the
// dashboard, admin, and kiosk-home bundles stay small.
const DevicePage = lazy(() =>
  import('./pages/Device').then((m) => ({ default: m.DevicePage })),
);
const KioskDevicePage = lazy(() =>
  import('./pages/KioskDevice').then((m) => ({ default: m.KioskDevicePage })),
);
const TemperaturePage = lazy(() =>
  import('./pages/Temperature').then((m) => ({ default: m.TemperaturePage })),
);

const router = createBrowserRouter([
  // The hub dashboard is the front door. The physical kiosk still boots
  // straight to /display, so this change doesn't affect the touchscreen.
  {
    path: '/',
    element: (
      <RequireAuth>
        <DashboardPage />
      </RequireAuth>
    ),
  },
  { path: '/login', element: <LoginPage /> },
  {
    path: '/display',
    element: (
      <RequireAuth>
        <KioskFrame>
          <DisplayPage />
        </KioskFrame>
      </RequireAuth>
    ),
  },
  {
    path: '/admin',
    element: (
      <RequireAuth>
        <AdminPage />
      </RequireAuth>
    ),
  },
  {
    path: '/todos',
    element: (
      <RequireAuth>
        <TodosPage />
      </RequireAuth>
    ),
  },
  {
    path: '/devices',
    element: (
      <RequireAuth>
        <DevicesPage />
      </RequireAuth>
    ),
  },
  {
    path: '/alerts',
    element: (
      <RequireAuth>
        <AlertsPage />
      </RequireAuth>
    ),
  },
  // Change history (audit log). Admin-only, like Settings — a guest who reaches
  // it directly is bounced to the dashboard.
  {
    path: '/history',
    element: (
      <RequireAuth control>
        <HistoryPage />
      </RequireAuth>
    ),
  },
  {
    path: '/brew-system',
    element: (
      <RequireAuth control>
        <BrewSystemPage />
      </RequireAuth>
    ),
  },
  // Bruce, the voice assistant: live state, conversation transcript, remote
  // speech, and volume. Admin-only like the Brew System page — the speak box
  // and volume slider are controls.
  {
    path: '/bruce',
    element: (
      <RequireAuth control>
        <BrucePage />
      </RequireAuth>
    ),
  },
  // Brewing-water salt calculator. Client-side only (no mutations), so any
  // signed-in user — including a read-only guest — can use it.
  {
    path: '/water',
    element: (
      <RequireAuth>
        <WaterCalculatorPage />
      </RequireAuth>
    ),
  },
  // Desktop (mouse/keyboard) keg inventory. The kiosk keeps its touch variant
  // at /kiosk/kegs; the desktop sidebar's Kegs link points here.
  {
    path: '/kegs',
    element: (
      <RequireAuth>
        <KegsDesktopPage />
      </RequireAuth>
    ),
  },
  // Desktop (mouse/keyboard) recipe picker, linked from the Overview's fermenter
  // card. The kiosk keeps its touch variant at /kiosk/recipes.
  {
    path: '/recipes',
    element: (
      <RequireAuth>
        <RecipesDesktopPage />
      </RequireAuth>
    ),
  },
  // Settings live here only (the kiosk's touch Settings page was retired — the
  // desktop UI is richer and the kiosk now uses that slot for the speaker).
  {
    path: '/settings',
    element: (
      <RequireAuth control>
        <SettingsDesktopPage />
      </RequireAuth>
    ),
  },
  {
    path: '/devices/:id',
    element: (
      <RequireAuth>
        <Suspense
          fallback={<div className="p-6 text-sm text-zinc-400">Loading chart…</div>}
        >
          <DevicePage />
        </Suspense>
      </RequireAuth>
    ),
  },
  // Touch-first hub for the Pi's 10" screen (the kiosk boots here).
  {
    path: '/kiosk',
    element: (
      <RequireAuth>
        <KioskFrame>
          <KioskHomePage />
        </KioskFrame>
      </RequireAuth>
    ),
  },
  {
    path: '/kiosk/todos',
    element: (
      <RequireAuth>
        <KioskFrame>
          <KioskTodosPage />
        </KioskFrame>
      </RequireAuth>
    ),
  },
  {
    path: '/kiosk/recipes',
    element: (
      <RequireAuth>
        <KioskFrame>
          <RecipesPage />
        </KioskFrame>
      </RequireAuth>
    ),
  },
  {
    path: '/kiosk/kegs',
    element: (
      <RequireAuth>
        <KioskFrame>
          <KegsPage />
        </KioskFrame>
      </RequireAuth>
    ),
  },
  // Brewery speaker now-playing + controls. Reached from the kiosk home (where
  // the settings gear used to be — the kiosk Settings page was retired in favour
  // of the richer desktop one).
  {
    path: '/kiosk/music',
    element: (
      <RequireAuth>
        <KioskFrame>
          <KioskMusicPage />
        </KioskFrame>
      </RequireAuth>
    ),
  },
  {
    path: '/kiosk/temperature',
    element: (
      <RequireAuth>
        <KioskFrame>
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center bg-zinc-900 text-xl text-zinc-400">
                Loading chart…
              </div>
            }
          >
            <TemperaturePage />
          </Suspense>
        </KioskFrame>
      </RequireAuth>
    ),
  },
  {
    path: '/kiosk/devices/:id',
    element: (
      <RequireAuth>
        <KioskFrame>
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center bg-zinc-900 text-xl text-zinc-400">
                Loading chart…
              </div>
            }
          >
            <KioskDevicePage />
          </Suspense>
        </KioskFrame>
      </RequireAuth>
    ),
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

// A 401 anywhere routes back to /login through the router rather than a full
// page reload — a reload would break in the bundled native app, which has no
// server at its localhost origin to serve /login.
setUnauthorizedHandler(() => {
  void router.navigate('/login');
});

/**
 * Root gate. In the browser this is just the router. In the native app it first
 * requires a server URL (the one-time setup screen) and wires the Android
 * hardware back button plus a dark status bar.
 */
function AppRoot(): JSX.Element {
  const [configured, setConfigured] = useState(hasServerUrl());

  useEffect(() => {
    if (!isNative()) return;
    // The nav bar is hidden for an immersive feel (see MainActivity.java) but the
    // status bar stays. Keep the web view *below* the status bar (not edge-to-edge
    // under it) so page content never sits under the camera cutout, and match the
    // bar to the app's zinc-950 background with light icons.
    void StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
    void StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
    void StatusBar.setBackgroundColor({ color: '#09090b' }).catch(() => {});
    // Hardware back button: walk the in-app history, then exit at the root.
    const handle = CapacitorApp.addListener('backButton', () => {
      if (window.history.length > 1) window.history.back();
      else void CapacitorApp.exitApp();
    });
    return () => {
      void handle.then((h) => h.remove());
    };
  }, []);

  if (isNative() && !configured) {
    return <ServerSetup onConnected={() => setConfigured(true)} />;
  }
  return (
    <ReopenSetupContext.Provider value={() => setConfigured(false)}>
      <RouterProvider router={router} />
    </ReopenSetupContext.Provider>
  );
}

// Load the saved server URL / token before the first render (native only), then mount.
void hydrateConfig().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <AppRoot />
    </React.StrictMode>,
  );
});
