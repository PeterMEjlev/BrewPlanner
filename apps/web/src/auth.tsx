import type { AuthState } from '@checklist/shared';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api } from './api';
import { isNative } from './native';
import { useReopenSetup } from './setupContext';

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
 * Whether this session may *control* things — change device setpoints, edit
 * kegs, pick recipes, manage settings and accounts — as opposed to only viewing.
 * True for the trusted-local kiosk/LAN (which has no user but full control) and
 * for an admin account; false for a logged-in guest. The single switch every
 * write affordance in the UI checks; the server enforces the same rule.
 */
export function canControl(auth: AuthState): boolean {
  return auth.isLocal || auth.user?.role === 'admin';
}

/**
 * Gate that protects a page. It asks the server who we are: trusted-local
 * requests (the Pi's kiosk on the LAN) and logged-in sessions pass through;
 * everyone else is redirected to /login. The resolved state is provided to
 * children via useAuth() so they can show the user / a logout button.
 *
 * Pass `control` for pages only an admin (or the local kiosk) may see — the Brew
 * System page and Settings. A logged-in guest who reaches one is bounced to the
 * dashboard rather than shown a page they can't use.
 */
export function RequireAuth({
  children,
  control = false,
}: {
  children: ReactNode;
  control?: boolean;
}): JSX.Element {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [failed, setFailed] = useState(false);
  const location = useLocation();
  const reopenSetup = useReopenSetup();

  const refresh = useCallback(async () => {
    setAuth(await api.getAuth());
  }, []);

  useEffect(() => {
    api.getAuth().then(setAuth).catch(() => setFailed(true));
  }, []);

  if (failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-zinc-950 p-6 text-center text-zinc-400">
        Couldn’t reach the server. Check your connection and reload.
        {isNative() && reopenSetup && (
          <button
            type="button"
            onClick={reopenSetup}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:bg-zinc-800"
          >
            Connect to a different server
          </button>
        )}
      </div>
    );
  }

  if (!auth) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-950 text-zinc-500">
        Loading…
      </div>
    );
  }

  if (!auth.user && !auth.isLocal) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  // Admin-only page reached by a guest: send them back to the dashboard.
  if (control && !canControl(auth)) {
    return <Navigate to="/" replace />;
  }

  return <AuthContext.Provider value={{ auth, refresh }}>{children}</AuthContext.Provider>;
}
