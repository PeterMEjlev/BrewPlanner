'use strict';

/**
 * Thin client for the BrewPlanner server's REST API.
 *
 * Bruce runs on the same Pi as the server and calls it over loopback, so every
 * request arrives as "trusted local" (see apps/server/src/auth/index.ts) and
 * passes both requireAuth and requireAdmin without a session or token. Going
 * through the server — rather than straight at the brew rig or the keg sheet —
 * means Bruce shares the server's config (BREW_SYSTEM_URL), its keg CSV cache,
 * and its audit log for control actions.
 */

const BASE_URL = (process.env.BREWPLANNER_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');

/**
 * Call the BrewPlanner server. Resolves with the parsed JSON body.
 *
 * On a non-2xx answer this throws an Error whose message is the server's
 * `{ error }` text when present (e.g. "Brew system is not responding (is it
 * powered on?)"). The Realtime client catches handler errors and feeds the
 * message back into the conversation, so these messages are written to be
 * spoken to the user as-is.
 *
 * @param {string} method - HTTP method
 * @param {string} endpoint - Path starting with /api/
 * @param {object} [body] - JSON body for POST/PUT
 * @returns {Promise<any>}
 */
async function apiCall(method, endpoint, body) {
  let res;
  try {
    res = await fetch(`${BASE_URL}${endpoint}`, {
      method,
      headers: body != null ? { 'Content-Type': 'application/json' } : {},
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('The BrewPlanner server is not responding.');
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      data && typeof data.error === 'string'
        ? data.error
        : `The BrewPlanner server answered with status ${res.status}.`;
    throw new Error(msg);
  }
  return data;
}

module.exports = { apiCall };
