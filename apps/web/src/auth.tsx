import type { AuthState } from '@checklist/shared';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api } from './api';

interface AuthContextValue {
  auth: AuthState;
  /** Re-fetch auth state (e.g. after logging out). */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Access the current auth state. Only valid inside <RequireAuth>. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <RequireAuth>');
  return ctx;
}

/**
 * Gate that protects a page. It asks the server who we are: trusted-local
 * requests (the Pi's kiosk on the LAN) and logged-in sessions pass through;
 * everyone else is redirected to /login. The resolved state is provided to
 * children via useAuth() so they can show the user / a logout button.
 */
export function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [failed, setFailed] = useState(false);
  const location = useLocation();

  const refresh = useCallback(async () => {
    setAuth(await api.getAuth());
  }, []);

  useEffect(() => {
    api.getAuth().then(setAuth).catch(() => setFailed(true));
  }, []);

  if (failed) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-950 p-6 text-center text-slate-400">
        Couldn’t reach the server. Check your connection and reload.
      </div>
    );
  }

  if (!auth) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-950 text-slate-500">
        Loading…
      </div>
    );
  }

  if (!auth.user && !auth.isLocal) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  return <AuthContext.Provider value={{ auth, refresh }}>{children}</AuthContext.Provider>;
}
