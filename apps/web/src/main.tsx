import React from 'react';
import ReactDOM from 'react-dom/client';
import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom';
import { AdminPage } from './pages/Admin';
import { DisplayPage } from './pages/Display';
import './index.css';

const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/admin" replace /> },
  { path: '/display', element: <DisplayPage /> },
  { path: '/admin', element: <AdminPage /> },
  { path: '*', element: <Navigate to="/admin" replace /> },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
