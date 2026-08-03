import { App as CapacitorApp } from '@capacitor/app';
import { Style, StatusBar } from '@capacitor/status-bar';
import React, { Suspense, lazy, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import {
  Navigate,
  RouterProvider,
  createBrowserRouter,
  useLocation,
  useParams,
} from 'react-router-dom';
import { RequireAuth, clearCachedAuth } from './auth';
import { hasServerUrl, hydrateConfig, isNative, setUnauthorizedHandler } from './native';
import { setPushOpenHandler } from './push';
import { ReopenSetupContext } from './setupContext';
import { ServerSetup } from './pages/ServerSetup';
import { KioskFrame } from './components/KioskFrame';
import { AdminPage } from './pages/Admin';
import { AlertsPage } from './pages/Alerts';
import { BrewSessionsPage } from './pages/BrewSessions';
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
import { RecipeDetailPage } from './pages/RecipeDetail';
import { RecipeCreatePage } from './pages/RecipeCreate';
import { RecipesDesktopPage } from './pages/RecipesDesktop';
import { SettingsDesktopPage } from './pages/SettingsDesktop';
import { TodosPage } from './pages/Todos';
import { ToolsPage } from './pages/Tools';
import './index.css';

// The physical Pi kiosk launches Chromium with ?kiosk=1 (see
// deploy/checklist-kiosk.service). Latch that onto <html> so CSS can hide the
// mouse pointer for the whole session: react-router drops the query string on
// the first in-app navigation, and on the Pi the pointer media query is
// unreliable (cage/wlroots reports a fine pointer), so a one-time class is the
// dependable signal that "we are the kiosk".
const launchParams = new URLSearchParams(window.location.search);
if (launchParams.has('kiosk')) {
  document.documentElement.classList.add('kiosk');
}
// The brewery Pi is mounted upside down, so its Chromium launches with
// ?rotate=180 and the whole page spins to match (see index.css). Same latching
// trick as above, and kept a separate flag from ?kiosk so it stays a statement
// about how *this* unit is bolted up rather than about kiosks in general —
// re-mount the Pi the right way round and you drop the flag from the unit file,
// no rebuild. Rotating here rather than in the compositor is forced: cage 0.2.0
// dropped its -r flag and exposes no output-management protocol.
// NB: the class must not collide with a Tailwind utility name. `rotate-180` was
// the obvious choice and is a trap — Tailwind generates `.rotate-180` from this
// very string, so <html> rotated too and the two 180s cancelled to a no-op.
if (launchParams.get('rotate') === '180') {
  document.documentElement.classList.add('upside-down');
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
// One brew session's detail plots the rig's pot temperatures, so it pulls in
// recharts too — the log list itself stays in the main bundle.
const BrewSessionDetailPage = lazy(() =>
  import('./pages/BrewSessionDetail').then((m) => ({ default: m.BrewSessionDetailPage })),
);

/** `/water?ca=80&…` → `/tools/water?ca=80&…`, params intact. */
function WaterRedirect(): JSX.Element {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/tools/water', search }} replace />;
}

/** `/brew-days/12` → `/brew-sessions/12`, from before the log was renamed. */
function BrewSessionRedirect(): JSX.Element {
  const { id } = useParams();
  return <Navigate to={`/brew-sessions/${id ?? ''}`} replace />;
}

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
  // The brewery's calculators: water, dilution, hydrometer, carbonation. All
  // client-side only (no mutations), so any signed-in user — including a
  // read-only guest — can use them. The bare path opens the water calculator.
  {
    path: '/tools',
    element: (
      <RequireAuth>
        <ToolsPage />
      </RequireAuth>
    ),
  },
  {
    path: '/tools/:tool',
    element: (
      <RequireAuth>
        <ToolsPage />
      </RequireAuth>
    ),
  },
  // The water calculator's old address, kept for bookmarks and for recipe links
  // saved before the move. The query string is what carries a recipe's target
  // profile, so it travels with the redirect.
  { path: '/water', element: <WaterRedirect /> },
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
  // The BrewPlanner recipe library, reached from the sidebar: the list, then
  // one recipe's full brew sheet. Desktop/phone only — the kiosk deliberately has
  // no recipe screen (its fermenter card just shows what's currently in the tank).
  {
    path: '/recipes',
    element: (
      <RequireAuth>
        <RecipesDesktopPage />
      </RequireAuth>
    ),
  },
  {
    path: '/recipes/new',
    element: (
      <RequireAuth control>
        <RecipeCreatePage />
      </RequireAuth>
    ),
  },
  {
    path: '/recipes/:id',
    element: (
      <RequireAuth>
        <RecipeDetailPage />
      </RequireAuth>
    ),
  },
  // The brewery's logbook: every batch brewed, then one batch in full. Readable
  // by anyone signed in (a guest sees the log without the controls); writing to
  // it is admin-only server-side.
  {
    path: '/brew-sessions',
    element: (
      <RequireAuth>
        <BrewSessionsPage />
      </RequireAuth>
    ),
  },
  {
    path: '/brew-sessions/:id',
    element: (
      <RequireAuth>
        <Suspense fallback={<div className="p-6 text-sm text-zinc-400">Loading brew session…</div>}>
          <BrewSessionDetailPage />
        </Suspense>
      </RequireAuth>
    ),
  },
  // The log used to live at /brew-days. Bookmarks and older app builds still
  // point there, so send them on rather than showing them a blank page.
  { path: '/brew-days', element: <Navigate to="/brew-sessions" replace /> },
  { path: '/brew-days/:id', element: <BrewSessionRedirect /> },
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
  // The session is gone, so the cached auth state RequireAuth renders from is
  // stale — drop it, or coming back would flash the old signed-in shell.
  clearCachedAuth();
  void router.navigate('/login');
});

// Tapping a push notification opens the page the change was on (the server puts
// the path in the message — see notify/push.ts). Routed rather than reloaded, so
// the app doesn't restart to show a keg.
setPushOpenHandler((path) => {
  void router.navigate(path);
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
