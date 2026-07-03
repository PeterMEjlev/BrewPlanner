import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { evaluateDeviceAlerts } from './alerts/evaluate.js';
import { accountAdminRoutes, authRoutes, seedAdminUser } from './auth/index.js';
import { resolveSessionSecret } from './auth/secret.js';
import { runMigrations } from './db/index.js';
import { runNotificationChecks } from './notify/checks.js';
import { isConfigured as telegramConfigured } from './notify/telegram.js';
import { apiRoutes } from './routes/api.js';
import { brewSystemRoutes } from './routes/brewSystem.js';
import { commandRoutes, deviceRoutes, ingestRoutes } from './routes/devices.js';
import { musicRoutes } from './routes/music.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOST = process.env.HOST ?? '0.0.0.0';
const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  // Apply migrations before serving any requests.
  runMigrations();

  const app = Fastify({ logger: true });

  // Ensure a login account exists (first boot creates the admin user).
  seedAdminUser(app.log);

  // Allow the bundled native app to call the API cross-origin. Capacitor's
  // Android web view serves the app from a `localhost` origin, so its requests
  // to this server over the tunnel are cross-origin and need CORS. The browser
  // dashboard is same-origin and unaffected. Auth is by bearer token, not
  // cookies, so no credentialed-CORS (and the SameSite cookie stays `lax`).
  await app.register(fastifyCors, {
    origin: ['https://localhost', 'http://localhost', 'capacitor://localhost'],
    // @fastify/cors defaults to GET,HEAD,POST only — name every verb the API
    // uses so the native app's keg edits (PUT), device/role changes (PATCH) and
    // alert dismissals (DELETE) aren't blocked at the CORS preflight.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Signed session cookies. The secret signs the session cookie; a stable
  // value keeps sessions valid across restarts. See auth/secret.ts.
  await app.register(fastifyCookie, { secret: resolveSessionSecret(app.log) });

  // Brute-force protection. Registered with `global: false` so it only applies
  // to routes that opt in via `config.rateLimit` (today: the login endpoint) —
  // it must NOT throttle the dashboard's frequent /me polling or device ingest.
  // Behind the Cloudflare tunnel every remote request reaches us from localhost,
  // so `req.ip` is useless for keying; key on the real client IP that Cloudflare
  // forwards in `cf-connecting-ip`, falling back to `req.ip` for LAN/loopback.
  await app.register(fastifyRateLimit, {
    global: false,
    keyGenerator: (req) => {
      const cf = req.headers['cf-connecting-ip'];
      return (Array.isArray(cf) ? cf[0] : cf) || req.ip;
    },
  });

  // Auth endpoints (login/logout/me) live outside the guarded /api routes.
  await app.register(authRoutes, { prefix: '/api/auth' });

  // Treat an empty body as no body even when the request declares
  // `Content-Type: application/json` — several endpoints are bodyless POSTs.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      if (body === '' || body == null) return done(null, undefined);
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error);
      }
    },
  );

  await app.register(apiRoutes, { prefix: '/api' });

  // Account administration (admin-only): list/create/delete accounts, change a
  // role, reset a password. Guarded internally by requireAdmin.
  await app.register(accountAdminRoutes, { prefix: '/api/accounts' });

  // Telemetry: satellites push to /api/ingest and pull queued commands from
  // /api/commands (both device-key auth); the dashboard reads device
  // status/history and queues setpoint changes via /api/devices (user-session).
  await app.register(ingestRoutes, { prefix: '/api/ingest' });
  await app.register(commandRoutes, { prefix: '/api/commands' });
  await app.register(deviceRoutes, { prefix: '/api/devices' });

  // Brewery speaker (Sonos / IKEA SYMFONISK) now-playing + transport control,
  // driven over the LAN. Read is session-gated; controls are admin/local-only.
  await app.register(musicRoutes, { prefix: '/api/music' });

  // Brewing rig (brew-system-v3 Pi) status + control, proxied over the LAN.
  // The rig's own API is unauthenticated, so this proxy is its only remote
  // door: reads are session-gated, controls are admin-only. Set BREW_SYSTEM_URL
  // to enable; unset, the Brew System page shows "not configured".
  await app.register(brewSystemRoutes, { prefix: '/api/brew-system' });

  // Serve the built web app (apps/web/dist) in production. In dev the web app
  // is served by Vite on its own port, so this directory may not exist.
  const webDist = resolve(__dirname, '../../web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });

    // SPA fallback: any non-API, non-file route returns index.html so the
    // client-side router can handle /display and /admin.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) {
        return reply.status(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.log.warn(`Web build not found at ${webDist} — serving API only (dev mode).`);
  }

  try {
    await app.listen({ host: HOST, port: PORT });
    startAlertScheduler(app);
    startNotificationScheduler(app);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
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

void main();
