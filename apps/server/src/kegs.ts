import {
  KEG_SHEET_CSV_URL,
  type Keg,
  type KegContentColors,
  type UpdateKegInput,
  parseKegs,
} from '@checklist/shared';

/**
 * Keg inventory lives in a published Google Sheet (the same one the web app and
 * the brew-system app read). The sheet URL, column layout, and CSV parsing live
 * in @checklist/shared so every reader sees the same data. This server-side
 * fetch is shared by the read API (`GET /api/kegs`) and the keg-age
 * notification check, so they can't drift.
 *
 * The browser pulls the CSV directly (the sheet is CORS-enabled); the server
 * fetches it too so headless clients that can't parse CSV — notably the Garmin
 * watch app — can get the inventory as JSON.
 *
 * The shell's keg badge polls this every 15s from every open client, so the CSV
 * is cached for a short TTL rather than hitting Google on each request:
 * concurrent callers share one in-flight fetch, and when Google errors we keep
 * serving the last good copy (marking it fresh again so a flaky sheet is
 * retried once per TTL, not hammered). The *raw text* is cached — parsing is
 * cheap and per-caller, so each caller can apply its own colour palette.
 */
const KEG_CACHE_TTL_MS = Number(process.env.KEG_CACHE_TTL_SECONDS ?? 60) * 1000;

let cachedCsv: { text: string; fetchedAt: number } | null = null;
let inFlight: Promise<string> | null = null;

async function fetchKegCsv(): Promise<string> {
  const res = await fetch(KEG_SHEET_CSV_URL);
  if (!res.ok) throw new Error(`Keg sheet fetch failed: ${res.status} ${res.statusText}`);
  return res.text();
}

async function getKegCsv(): Promise<string> {
  if (cachedCsv && Date.now() - cachedCsv.fetchedAt < KEG_CACHE_TTL_MS) return cachedCsv.text;
  inFlight ??= fetchKegCsv()
    .then((text) => {
      cachedCsv = { text, fetchedAt: Date.now() };
      return text;
    })
    .catch((err) => {
      // Stale-on-error: a Google hiccup shouldn't blank every keg badge. Bump
      // fetchedAt so the next attempt waits a full TTL instead of retrying on
      // every poll tick.
      if (cachedCsv) {
        cachedCsv.fetchedAt = Date.now();
        return cachedCsv.text;
      }
      throw err;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export async function fetchKegs(colors?: KegContentColors): Promise<Keg[]> {
  return parseKegs(await getKegCsv(), colors);
}

/**
 * Thrown when no write URL is configured, so the route can answer 503 distinctly
 * (the read path keeps working — only edits need the Apps Script deployment).
 */
export class KegWriteNotConfiguredError extends Error {
  constructor() {
    super('Keg editing is not configured (set KEG_SHEET_WRITE_URL).');
    this.name = 'KegWriteNotConfiguredError';
  }
}

/**
 * Write one keg's editable fields back to the shared sheet. The published CSV is
 * read-only, so writes go through a Google Apps Script web app (the same script
 * the brew-system app uses; see google-apps-script/keg-updater.gs) whose
 * deployment URL is held server-side in KEG_SHEET_WRITE_URL. Keeping it on the
 * server means the URL never ships in the client bundle and the edit is gated by
 * the dashboard's auth.
 *
 * The Apps Script always responds 200 (ContentService can't set status codes),
 * signalling failures in the JSON body, so we surface `{ error }` as a thrown
 * Error rather than trusting the HTTP status alone.
 */
export async function updateKeg(number: string, fields: UpdateKegInput): Promise<void> {
  const url = process.env.KEG_SHEET_WRITE_URL;
  if (!url) throw new KegWriteNotConfiguredError();

  const res = await fetch(url, {
    method: 'POST',
    body: JSON.stringify({ number, ...fields }),
  });
  if (!res.ok) throw new Error(`Keg sheet write failed: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as { success?: boolean; error?: string };
  if (data.error) throw new Error(data.error);
  if (!data.success) throw new Error('Keg sheet write did not confirm success');

  // Expire the CSV cache so the edit shows up on the next read rather than
  // after a full TTL (the published CSV itself can still lag a little).
  cachedCsv = null;
}
