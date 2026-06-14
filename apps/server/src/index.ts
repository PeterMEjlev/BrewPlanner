import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { authRoutes, seedAdminUser } from './auth/index.js';
import { resolveSessionSecret } from './auth/secret.js';
import { runMigrations } from './db/index.js';
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
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
