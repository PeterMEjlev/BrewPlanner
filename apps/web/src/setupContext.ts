import { createContext, useContext } from 'react';

/**
 * Lets any screen send the native app back to the server-URL setup screen — used
 * by the "Connect to a different server" links on the login and connection-error
 * views. Null in the browser, where there is no setup step.
 */
export const ReopenSetupContext = createContext<(() => void) | null>(null);

export function useReopenSetup(): (() => void) | null {
  return useContext(ReopenSetupContext);
}
