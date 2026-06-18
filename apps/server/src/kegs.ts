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
 */
export async function fetchKegs(colors?: KegContentColors): Promise<Keg[]> {
  const res = await fetch(KEG_SHEET_CSV_URL);
  if (!res.ok) throw new Error(`Keg sheet fetch failed: ${res.status} ${res.statusText}`);
  return parseKegs(await res.text(), colors);
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
}
