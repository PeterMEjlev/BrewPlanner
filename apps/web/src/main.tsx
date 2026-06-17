import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom';
import { RequireAuth } from './auth';
import { AdminPage } from './pages/Admin';
import { DashboardPage } from './pages/Dashboard';
import { DevicesPage } from './pages/Devices';
import { DisplayPage } from './pages/Display';
import { KegsPage } from './pages/Kegs';
import { KioskHomePage } from './pages/KioskHome';
import { KioskTodosPage } from './pages/KioskTodos';
import { LoginPage } from './pages/Login';
import { RecipesPage } from './pages/Recipes';
import { SettingsPage } from './pages/Settings';
import { SettingsDesktopPage } from './pages/SettingsDesktop';
import { TodosPage } from './pages/Todos';
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
        <DisplayPage />
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
  // Desktop (mouse/keyboard) settings. The kiosk keeps its touch variant at
  // /kiosk/settings; the desktop sidebar's Settings link points here.
  {
    path: '/settings',
    element: (
      <RequireAuth>
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
        <KioskHomePage />
      </RequireAuth>
    ),
  },
  {
    path: '/kiosk/todos',
    element: (
      <RequireAuth>
        <KioskTodosPage />
      </RequireAuth>
    ),
  },
  {
    path: '/kiosk/recipes',
    element: (
      <RequireAuth>
        <RecipesPage />
      </RequireAuth>
    ),
  },
  {
    path: '/kiosk/kegs',
    element: (
      <RequireAuth>
        <KegsPage />
      </RequireAuth>
    ),
  },
  {
    path: '/kiosk/settings',
    element: (
      <RequireAuth>
        <SettingsPage />
      </RequireAuth>
    ),
  },
  {
    path: '/kiosk/temperature',
    element: (
      <RequireAuth>
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center bg-zinc-900 text-xl text-zinc-400">
              Loading chart…
            </div>
          }
        >
          <TemperaturePage />
        </Suspense>
      </RequireAuth>
    ),
  },
  {
    path: '/kiosk/devices/:id',
    element: (
      <RequireAuth>
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center bg-zinc-900 text-xl text-zinc-400">
              Loading chart…
            </div>
          }
        >
          <KioskDevicePage />
        </Suspense>
      </RequireAuth>
    ),
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
