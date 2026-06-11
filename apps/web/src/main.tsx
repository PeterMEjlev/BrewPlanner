import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom';
import { RequireAuth } from './auth';
import { AdminPage } from './pages/Admin';
import { DashboardPage } from './pages/Dashboard';
import { DisplayPage } from './pages/Display';
import { KioskHomePage } from './pages/KioskHome';
import { KioskTodosPage } from './pages/KioskTodos';
import { LoginPage } from './pages/Login';
import { TodosPage } from './pages/Todos';
import './index.css';

// The chart pages pull in recharts (~400 kB). Load them on demand so the
// dashboard, admin, and kiosk-home bundles stay small.
const DevicePage = lazy(() =>
  import('./pages/Device').then((m) => ({ default: m.DevicePage })),
);
const KioskDevicePage = lazy(() =>
  import('./pages/KioskDevice').then((m) => ({ default: m.KioskDevicePage })),
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
    path: '/devices/:id',
    element: (
      <RequireAuth>
        <Suspense
          fallback={<div className="p-6 text-sm text-slate-400">Loading chart…</div>}
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
    path: '/kiosk/devices/:id',
    element: (
      <RequireAuth>
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center bg-slate-900 text-xl text-slate-400">
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
