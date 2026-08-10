import { parseKegDate } from '@checklist/shared';
import type { FastifyBaseLogger } from 'fastify';
import { recordAlert } from '../alerts/repo.js';
import { getRecentReadingsByMetric } from '../devices/repo.js';
import { fetchKegs } from '../kegs.js';
import { getNotificationSettings, getSetting, setSetting } from '../repo.js';
import { runCriticalChecks } from './critical.js';
import { pushToEveryone } from './push.js';

/**
 * Periodic notification checks, run on an interval from index.ts. Everything
 * here ends up in two places: the durable alert history the Alerts page reads,
 * and — for the ones worth interrupting someone over — a push to the phones.
 *
 * Two kinds of check share the loop. The **routine** ones below (a keg that has
 * been sitting too long, a fermentation that has finished) are one-shot facts
 * about a thing that has already happened: each send is recorded in the
 * key-value `settings` table under a `notify:` marker so it never repeats for
 * the same keg-fill or batch. The **critical** ones in critical.ts watch live
 * telemetry for something going wrong right now and manage their own
 * start/resolve episodes.
 *
 * A check throwing never stops the others or the loop — failures are logged and
 * retried next tick.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// --- Fermentation-complete thresholds --------------------------------------
// Defaults mirror the kiosk's "flat for ~2 days within 0.002 SG" definition;
// each is env-overridable for tuning without a redeploy.
const GRAVITY_METRIC = 'gravity_sg'; // the Tilt hydrometer's gravity metric
const STABLE_HOURS = Number(process.env.FERMENT_STABLE_HOURS ?? 48);
const STABLE_SG = Number(process.env.FERMENT_STABLE_SG ?? 0.002);
const OG_FLOOR_SG = Number(process.env.FERMENT_OG_FLOOR_SG ?? 1.03);
const MIN_DROP_SG = Number(process.env.FERMENT_MIN_DROP_SG ?? 0.01);
const FERMENT_LOOKBACK_DAYS = 21;

/**
 * Keg contents that aren't beer being conditioned (sanitiser, empty, cleaning
 * states) — these never trigger an age alert. Compared case-insensitively.
 */
const NON_BEER_CONTENTS = new Set(['clean', 'dirty', 'starsan', '???', '']);

/** Run all enabled checks. Safe to call on a timer; never throws. */
export async function runNotificationChecks(log: FastifyBaseLogger): Promise<void> {
  const settings = getNotificationSettings();

  if (settings.kegAlertEnabled) {
    try {
      await checkOldKegs(settings.kegAlertDays, log);
    } catch (err) {
      log.error(err, 'keg-age notification check failed');
    }
  }

  if (settings.fermentDoneEnabled) {
    try {
      await checkFermentationDone(log);
    } catch (err) {
      log.error(err, 'fermentation-complete notification check failed');
    }
  }

  await runCriticalChecks(settings, log);
}

// --- Keg age ----------------------------------------------------------------

/** Alert once per keg-fill when a beer keg has been stored `thresholdDays`+. */
async function checkOldKegs(thresholdDays: number, log: FastifyBaseLogger): Promise<void> {
  const kegs = await fetchKegs();

  const now = Date.now();
  for (const keg of kegs) {
    if (NON_BEER_CONTENTS.has(keg.contents.trim().toLowerCase())) continue;
    const filledAt = parseKegDate(keg.date);
    if (!filledAt) continue; // undated — can't age it
    const ageDays = Math.floor((now - filledAt) / DAY_MS);
    if (ageDays < thresholdDays) continue;

    // Marker includes the fill date so a refill (new date) can alert again.
    const marker = `notify:keg:${keg.number}:${keg.date}`;
    if (getSetting(marker)) continue;

    const title = `Keg ${keg.number}: ${keg.contents} is ${ageDays} days old`;
    const detail = `Filled ${keg.date}${keg.abv ? ` · ${keg.abv}` : ''}. Time to drink it before it fades.`;
    recordAlert({ source: 'keg_age', severity: 'warning', title, detail });
    // Routine news, not an emergency: the ordinary channel, and the marker is
    // written whether or not a phone was listening — an alert is "sent" once it
    // is in the history, and a hub with no phones must not re-raise it forever.
    await pushToEveryone({ title, body: detail, path: '/kegs' }, log);
    setSetting(marker, new Date().toISOString());
    log.info(`Sent keg-age alert for keg ${keg.number} (${ageDays} days).`);
  }
}

// --- Fermentation complete --------------------------------------------------

/**
 * Alert once per batch when the Tilt's gravity has gone quiet: a real
 * fermentation happened (peak gravity was fresh-wort high and has since dropped
 * meaningfully) and the last {@link STABLE_HOURS} of readings sit within
 * {@link STABLE_SG}. The batch is identified by its peak-gravity timestamp, so a
 * new pitch (gravity rises again) re-arms the alert automatically — no batch
 * table needed. Dormant until the Tilt feeds `gravity_sg` into readings.
 */
async function checkFermentationDone(log: FastifyBaseLogger): Promise<void> {
  const since = new Date(Date.now() - FERMENT_LOOKBACK_DAYS * DAY_MS).toISOString();
  const rows = getRecentReadingsByMetric(GRAVITY_METRIC, since);
  if (rows.length < 2) return;

  // Peak gravity in the window marks this batch's start (fresh wort).
  const peak = rows.reduce((a, b) => (b.value > a.value ? b : a));
  if (peak.value < OG_FLOOR_SG) return; // never saw fresh wort — not a real batch

  // The stability window must actually span ~STABLE_HOURS of readings; a sensor
  // gap that leaves only a few recent points must not read as "stable".
  const cutoff = Date.now() - STABLE_HOURS * HOUR_MS;
  const windowRows = rows.filter((r) => Date.parse(r.recordedAt) >= cutoff);
  if (windowRows.length < 2) return;
  const oldestInWindow = Math.min(...windowRows.map((r) => Date.parse(r.recordedAt)));
  if (oldestInWindow > cutoff + HOUR_MS) return; // window doesn't cover the full span

  const values = windowRows.map((r) => r.value);
  const fg = Math.min(...values);
  const spread = Math.max(...values) - fg;
  const dropped = peak.value - fg;
  if (spread > STABLE_SG || dropped < MIN_DROP_SG) return;

  const marker = `notify:ferment:${peak.recordedAt}`;
  if (getSetting(marker)) return;

  const title = 'Fermentation complete';
  const detail =
    `Gravity held at ${fg.toFixed(3)} SG (within ${STABLE_SG.toFixed(3)}) for ` +
    `${Math.round(STABLE_HOURS)}h, down from ${peak.value.toFixed(3)} — time to cold crash / keg.`;
  recordAlert({ source: 'ferment_done', severity: 'info', title, detail });
  await pushToEveryone({ title, body: detail, path: '/' }, log);
  setSetting(marker, new Date().toISOString());
  log.info('Sent fermentation-complete alert.');
}
