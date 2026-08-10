import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyBaseLogger } from 'fastify';
import { type PushTarget, pushTargetsExcept, unregisterPushToken } from './pushTokens.js';

/**
 * Push notifications to the Android app, over Firebase Cloud Messaging.
 *
 * No SDK, for the same reason googleDrive.ts has none: firebase-admin is a large
 * dependency on a Pi that installs over a home connection, and what is actually
 * needed is an OAuth access token and one POST per device. The credential is a
 * Firebase service-account key (`FCM_SERVICE_ACCOUNT_KEY_FILE`, or the JSON
 * itself in `FCM_SERVICE_ACCOUNT_KEY` for systemd EnvironmentFile setups), the
 * same shape of file Drive uses — but a different key, from the Firebase
 * project, and scoped to messaging only.
 *
 * Unconfigured is a normal state, not an error: a hub with no Firebase project
 * simply never pushes, and every call here becomes a no-op.
 *
 * Delivery is best-effort by nature — the phone may be off, the token may have
 * been rotated — so nothing in here ever throws into the request that triggered
 * it. A token FCM reports as dead is deleted, which is the only way the registry
 * stays clean: an uninstalled app cannot tell us it is gone.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id: string;
}

/**
 * The Android notification channels the hub posts to. They exist so the two
 * kinds of message can be silenced independently on the phone: someone renaming
 * a keg and the fermenter losing pressure at 3am do not deserve the same
 * treatment, and Android only lets the person holding the phone make that
 * distinction per channel. Both are created by the app on first run — a message
 * posted to a channel that doesn't exist is dropped — so these ids must match
 * the ones in the web app's push.ts.
 */
const CHANGES_CHANNEL = 'konfus-changes';
const CRITICAL_CHANNEL = 'konfus-critical';

/** What a push says, plus where tapping it should land in the app. */
export interface PushMessage {
  title: string;
  body: string;
  /** In-app path to open on tap, e.g. `/kegs`. */
  path: string;
  /**
   * Something is wrong in the brewery right now: post to the critical channel
   * instead of the changes one. Only the hub's own alert checks set this — a
   * person's edit is never critical, however dramatic.
   */
  critical?: boolean;
  /**
   * What FCM should collapse this message against, so a burst about one subject
   * arrives as one line rather than ten. Defaults to the target path; critical
   * alerts pass their alert source, which keeps a pressure alarm from swallowing
   * a temperature alarm just because both open the dashboard.
   */
  collapseKey?: string;
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/** The Firebase key, or null when this hub has no push configured. */
function serviceAccountKey(): ServiceAccountKey | null {
  const inline = process.env.FCM_SERVICE_ACCOUNT_KEY;
  const file = process.env.FCM_SERVICE_ACCOUNT_KEY_FILE;
  if (!inline && !file) return null;
  try {
    const raw = inline ?? readFileSync(file!, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ServiceAccountKey>;
    if (!parsed.client_email || !parsed.private_key || !parsed.project_id) {
      throw new Error('key is missing client_email, private_key or project_id');
    }
    return {
      client_email: parsed.client_email,
      private_key: parsed.private_key,
      project_id: parsed.project_id,
    };
  } catch (err) {
    // A malformed key is worth one complaint, not a crash: the hub's job is
    // brewing, and push is a nicety layered on top.
    lastKeyError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

let lastKeyError: string | null = null;

/** Whether this hub can send a push at all. */
export function pushConfigured(): boolean {
  return serviceAccountKey() != null;
}

/** Why the key was rejected, for the log line on startup. Null when it wasn't. */
export function pushConfigError(): string | null {
  return pushConfigured() ? null : lastKeyError;
}

// Access tokens last an hour; minting one per notification would be a pointless
// round trip, so the live one is held until it is nearly up.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(key: ServiceAccountKey): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const issued = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: issued,
      exp: issued + 3600,
    }),
  );
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key);
  const assertion = `${header}.${claims}.${base64url(signature)}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(
      `Firebase refused the credentials (${res.status}): ${json.error_description ?? json.error ?? 'no access token'}`,
    );
  }
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

/**
 * Send one message to one device. Resolves to false when FCM says the token is
 * dead, so the caller can drop it.
 */
async function sendToToken(
  key: ServiceAccountKey,
  bearer: string,
  token: string,
  message: PushMessage,
): Promise<boolean> {
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${key.project_id}/messages:send`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: message.title, body: message.body },
          // Read by the app's tap handler to open the page the change was on.
          data: { path: message.path },
          android: {
            // Changes in the brewery are worth waking the phone for, but they
            // are not alarms — the channel is what separates the two, and the
            // collapse key keeps a burst about one subject to a single line.
            priority: 'HIGH',
            collapseKey: message.collapseKey ?? message.path,
            notification: {
              channelId: message.critical ? CRITICAL_CHANNEL : CHANGES_CHANNEL,
              defaultSound: true,
            },
          },
        },
      }),
    },
  );
  if (res.ok) return true;

  // 404 UNREGISTERED (app uninstalled) and 400 INVALID_ARGUMENT on the token
  // itself are permanent: the token will never work again.
  const detail = await res.text().catch(() => '');
  if (res.status === 404 || (res.status === 400 && detail.includes('registration token'))) {
    return false;
  }
  throw new Error(`FCM send failed (${res.status}): ${detail.slice(0, 200)}`);
}

/**
 * Fan one message out to a set of phones. Never throws: delivery is best-effort
 * by nature, and callers fire and forget rather than block a response on FCM.
 * Resolves to the number of phones that took it.
 */
async function deliver(
  targets: PushTarget[],
  message: PushMessage,
  log: FastifyBaseLogger,
): Promise<number> {
  try {
    const key = serviceAccountKey();
    if (!key || targets.length === 0) return 0;

    const bearer = await accessToken(key);
    const results = await Promise.all(
      targets.map(async (target) => {
        try {
          const alive = await sendToToken(key, bearer, target.token, message);
          if (!alive) {
            unregisterPushToken(target.token);
            log.info('Dropped a push token FCM no longer recognises');
            return false;
          }
          return true;
        } catch (err) {
          log.warn({ err }, 'Push notification failed for one device');
          return false;
        }
      }),
    );
    return results.filter(Boolean).length;
  } catch (err) {
    log.warn({ err }, 'Push notification failed');
    return 0;
  }
}

/**
 * Announce a change to every registered phone except the one belonging to the
 * account that made it. Never throws and never blocks the caller's response —
 * callers fire and forget.
 */
export async function pushChangeToOthers(
  actorUserId: number | null,
  message: PushMessage,
  log: FastifyBaseLogger,
): Promise<void> {
  await deliver(pushTargetsExcept(actorUserId), message, log);
}

/**
 * Tell *every* registered phone. Used for the hub's own alerts, which nobody
 * caused and so have no author to leave out — the person who happens to be
 * signed in on the phone next to the fermenter is exactly who needs telling.
 * Resolves to how many phones took it.
 */
export async function pushToEveryone(
  message: PushMessage,
  log: FastifyBaseLogger,
): Promise<number> {
  return deliver(pushTargetsExcept(null), message, log);
}
