import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Uploading a file to Google Drive, with no SDK.
 *
 * `googleapis` is a hundred megabytes of generated clients for a service we use
 * one endpoint of, on a Pi that has to `npm ci` over a home connection. What is
 * actually needed is an OAuth access token and one multipart POST, which is the
 * whole of this file: sign a JWT with node's own crypto, trade it for a token,
 * upload.
 *
 * Two ways to get that token, because they fail in different places:
 *
 * - **Service account** (`GOOGLE_SERVICE_ACCOUNT_KEY_FILE`) — a key file on the
 *   Pi and no consent screen ever again. The catch is storage: a service
 *   account owns the files it creates but has no Drive quota of its own, so
 *   writing into a folder in a *personal* Google account fails with
 *   `storageQuotaExceeded`. It works when the target lives on a Shared Drive
 *   (Google Workspace).
 * - **OAuth refresh token** (`GOOGLE_OAUTH_*`) — one browser consent as
 *   yourself, after which the backups are owned by, and counted against, your
 *   own account. This is the one that works with an ordinary Drive folder.
 *
 * Whichever is configured wins; if both are, the refresh token is used, since
 * having gone to the trouble of minting one is a clear statement of intent.
 * See deploy/README-recipe-backup.md for the setup either way.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

/**
 * The brewery's backup folder, from the Drive link the folder was shared as.
 * Overridable, but defaulted so the Pi needs credentials and nothing else.
 */
export const DRIVE_FOLDER_ID =
  process.env.GOOGLE_DRIVE_FOLDER_ID ?? '1wYK4s0UCvFI7rQF_WoqhD-Q6DSd03NUC';

/** Full Drive scope: the service account can still only see what's shared with it. */
const SCOPE = 'https://www.googleapis.com/auth/drive';

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/** Thrown for a Drive problem the operator can act on — shown in the UI as-is. */
export class DriveError extends Error {}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function serviceAccountKey(): ServiceAccountKey | null {
  // Either the key file's path or the JSON itself, so systemd's EnvironmentFile
  // can carry it on machines where dropping a file is awkward.
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const file = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (!inline && !file) return null;
  try {
    const raw = inline ?? readFileSync(file!, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ServiceAccountKey>;
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('key is missing client_email or private_key');
    }
    return { client_email: parsed.client_email, private_key: parsed.private_key };
  } catch (err) {
    throw new DriveError(
      `Could not read the Google service account key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function oauthCredentials(): { clientId: string; clientSecret: string; refreshToken: string } | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  return clientId && clientSecret && refreshToken
    ? { clientId, clientSecret, refreshToken }
    : null;
}

/** Whether the Pi has any way at all of reaching Drive. */
export function driveConfigured(): boolean {
  if (oauthCredentials()) return true;
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_KEY ?? process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE);
}

/** Which credential is in play, for the status the Recipes page shows. */
export function driveAuthMethod(): 'oauth' | 'service-account' | null {
  if (oauthCredentials()) return 'oauth';
  return driveConfigured() ? 'service-account' : null;
}

// Tokens last an hour; re-minting one per upload would be a pointless round
// trip, so the live one is kept until it is nearly up.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function postForm(body: Record<string, string>): Promise<{ access_token?: string; expires_in?: number; error_description?: string; error?: string }> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await response.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!response.ok || !json.access_token) {
    throw new DriveError(
      `Google refused the credentials (${response.status}): ${json.error_description ?? json.error ?? 'no access token returned'}`,
    );
  }
  return json;
}

/** A signed assertion that this service account may act for itself. */
function serviceAccountAssertion(key: ServiceAccountKey): string {
  const issued = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: key.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: issued,
    exp: issued + 3600,
  }));
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(key.private_key);
  return `${header}.${claims}.${base64url(signature)}`;
}

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const oauth = oauthCredentials();
  const json = oauth
    ? await postForm({
        grant_type: 'refresh_token',
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        refresh_token: oauth.refreshToken,
      })
    : await (async () => {
        const key = serviceAccountKey();
        if (!key) throw new DriveError('No Google Drive credentials are configured on this server.');
        return postForm({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: serviceAccountAssertion(key),
        });
      })();

  cachedToken = {
    value: json.access_token!,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

/**
 * Put one JSON file in the backup folder and answer with its Drive id.
 *
 * `supportsAllDrives` is set so the same call works whether the folder lives in
 * an ordinary Drive or on a Shared Drive — which is the difference between a
 * service account being able to write there and not.
 */
export async function uploadJsonToDrive(name: string, contents: string): Promise<string> {
  const token = await accessToken();
  const boundary = `brewplanner-${Date.now().toString(36)}`;
  const metadata = JSON.stringify({ name, parents: [DRIVE_FOLDER_ID], mimeType: 'application/json' });
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    metadata,
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    contents,
    `--${boundary}--`,
    '',
  ].join('\r\n');

  const response = await fetch(`${UPLOAD_URL}?uploadType=multipart&supportsAllDrives=true&fields=id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    // The quota failure is the one worth naming: it means the credentials work
    // and the folder is reachable, but a service account has nowhere to put a
    // file it owns. Nothing about the recipe data is wrong.
    if (text.includes('storageQuotaExceeded')) {
      throw new DriveError(
        'Google refused the upload: a service account has no Drive storage of its own, so it cannot own files in a personal Drive folder. '
        + 'Move the backup folder to a Shared Drive, or switch to the GOOGLE_OAUTH_* refresh-token credentials (see deploy/README-recipe-backup.md).',
      );
    }
    throw new DriveError(`Google Drive rejected the upload (${response.status}): ${text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(text) as { id?: string };
  if (!parsed.id) throw new DriveError('Google Drive accepted the upload but returned no file id.');
  return parsed.id;
}
