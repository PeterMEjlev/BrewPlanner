// Must stay first: later imports read process.env when they load. See env.ts.
import './env.js';
import type { FastifyInstance } from 'fastify';
import { evaluateDeviceAlerts } from './alerts/evaluate.js';
import { buildApp } from './app.js';
import { startBrewSessionSampler } from './brewSessions/sampler.js';
import { sqlite } from './db/index.js';
import { RETENTION_DAYS, pruneOldReadings } from './devices/retention.js';
import { runNotificationChecks } from './notify/checks.js';
import { pushConfigError, pushConfigured } from './notify/push.js';
import { isConfigured as telegramConfigured } from './notify/telegram.js';
import { startRecipeBackupScheduler } from './recipeBackup.js';

const HOST = process.env.HOST ?? '0.0.0.0';
const PORT = Number(process.env.PORT ?? 3000);

/**
 * The running server: the app from app.ts, listening, plus the background
 * schedulers and signal handling that only make sense for a real process (tests
 * build the app without any of it).
 */
async function main(): Promise<void> {
  const app = await buildApp();
  try {
    await app.listen({ host: HOST, port: PORT });
    installShutdownHandlers(app);
    startAlertScheduler(app);
    startNotificationScheduler(app);
    reportPushStatus(app);
    startRetentionScheduler(app);
    startRecipeBackupScheduler(app.log);
    startBrewSessionSampler(app.log);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

/**
 * Shut down cleanly when systemd stops or restarts the unit — which the Settings
 * page's Update button does on every deploy. Without this, SIGTERM killed the
 * process outright: requests in flight died mid-response and SQLite was left to
 * recover its WAL on next boot. `app.close()` drains open connections and runs
 * onClose hooks, then the database handle is closed so the last writes and the
 * WAL are on disk before we exit.
 *
 * A second signal (or systemd's TimeoutStopSec) still kills us, so a wedged
 * connection can't block a restart forever.
 */
function installShutdownHandlers(app: FastifyInstance): void {
  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received — shutting down.`);
    void app
      .close()
      .catch((err) => app.log.error(err, 'Error closing the server'))
      .finally(() => {
        try {
          sqlite.close();
        } catch (err) {
          app.log.error(err, 'Error closing the database');
        }
        process.exit(0);
      });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/**
 * Periodically fold live device state into the durable alert history (offline
 * episodes; see alerts/evaluate.ts). Runs regardless of Telegram config so the
 * Alerts page always has data. Override the cadence with ALERT_INTERVAL_SECONDS;
 * the interval is unref'd so it never holds the process open on shutdown.
 */
function startAlertScheduler(app: FastifyInstance): void {
  const intervalMs = Number(process.env.ALERT_INTERVAL_SECONDS ?? 60) * 1000;
  const tick = () => evaluateDeviceAlerts(app.log);
  setInterval(tick, intervalMs).unref();
  // Give devices a moment to report after boot before judging them offline.
  setTimeout(tick, 20_000).unref();
  app.log.info(`Alert evaluation enabled (checking every ${intervalMs / 1000}s).`);
}

/**
 * Periodically check for notification conditions (keg age, fermentation done)
 * and push Telegram alerts. Only runs when Telegram is configured; the interval
 * is unref'd so it never holds the process open on shutdown. Override the cadence
 * with NOTIFY_INTERVAL_SECONDS.
 */
function startNotificationScheduler(app: FastifyInstance): void {
  if (!telegramConfigured()) {
    app.log.info(
      'Telegram notifications disabled (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable).',
    );
    return;
  }
  const intervalMs = Number(process.env.NOTIFY_INTERVAL_SECONDS ?? 300) * 1000;
  const tick = () => void runNotificationChecks(app.log);
  setInterval(tick, intervalMs).unref();
  // Run once shortly after boot so a due alert doesn't wait a full interval.
  setTimeout(tick, 15_000).unref();
  app.log.info(`Telegram notifications enabled (checking every ${intervalMs / 1000}s).`);
}

/**
 * Say once, at boot, whether the phones will be told about other people's
 * changes (see notify/push.ts). There is no scheduler behind this — pushes are
 * sent as changes happen — but "my phone stopped buzzing" is otherwise a silent
 * failure, and a line in the journal is where you'd go looking.
 */
function reportPushStatus(app: FastifyInstance): void {
  if (pushConfigured()) {
    app.log.info('Push notifications enabled (Android app is told about others\' changes).');
    return;
  }
  const err = pushConfigError();
  if (err) app.log.warn(`Push notifications disabled — the Firebase key was unreadable: ${err}`);
  else app.log.info('Push notifications disabled (set FCM_SERVICE_ACCOUNT_KEY_FILE to enable).');
}

/**
 * Daily readings retention (see devices/retention.ts): prune raw samples older
 * than READINGS_RETENTION_DAYS so the SQLite file stops growing forever on the
 * Pi's SD card. First run a few minutes after boot (off the startup rush), then
 * every 24h. The prune is synchronous (better-sqlite3), so it's deliberately
 * infrequent; the interval is unref'd like the other schedulers.
 */
function startRetentionScheduler(app: FastifyInstance): void {
  if (!(RETENTION_DAYS > 0)) {
    app.log.info('Readings retention disabled (READINGS_RETENTION_DAYS <= 0).');
    return;
  }
  const tick = () => {
    try {
      pruneOldReadings(app.log);
    } catch (err) {
      app.log.error(err, 'Readings retention failed');
    }
  };
  setInterval(tick, 24 * 60 * 60 * 1000).unref();
  setTimeout(tick, 2 * 60 * 1000).unref();
  app.log.info(`Readings retention enabled (pruning rows older than ${RETENTION_DAYS} days, daily).`);
}

void main();
