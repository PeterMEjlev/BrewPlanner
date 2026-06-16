import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { authRoutes, seedAdminUser } from './auth/index.js';
import { resolveSessionSecret } from './auth/secret.js';
import { runMigrations } from './db/index.js';
import { runNotificationChecks } from './notify/checks.js';
import { isConfigured as telegramConfigured } from './notify/telegram.js';
import { apiRoutes } from './routes/api.js';
import { commandRoutes, deviceRoutes, ingestRoutes } from './routes/devices.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOST = process.env.HOST ?? '0.0.0.0';
const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  // Apply migrations before serving any requests.
  runMigrations();

  const app = Fastify({ logger: true });

  // Ensure a login account exists (first boot creates the admin user).
  seedAdminUser(app.log);

  // Signed session cookies. The secret signs the session cookie; a stable
  // value keeps sessions valid across restarts. See auth/secret.ts.
  await app.register(fastifyCookie, { secret: resolveSessionSecret(app.log) });

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

  // Telemetry: satellites push to /api/ingest and pull queued commands from
  // /api/commands (both device-key auth); the dashboard reads device
  // status/history and queues setpoint changes via /api/devices (user-session).
  await app.register(ingestRoutes, { prefix: '/api/ingest' });
  await app.register(commandRoutes, { prefix: '/api/commands' });
  await app.register(deviceRoutes, { prefix: '/api/devices' });

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
    startNotificationScheduler(app);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
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
