import { KEG_SHEET_CSV_URL, type Keg, type KegContentColors, parseKegs } from '@checklist/shared';

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
