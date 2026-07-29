// Must stay first: later imports read process.env when they load. See env.ts.
import './env.js';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCompress from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { SetHeadersResponse } from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { accountAdminRoutes, authRoutes, seedAdminUser } from './auth/index.js';
import { resolveSessionSecret } from './auth/secret.js';
import { runMigrations } from './db/index.js';
import { apiRoutes } from './routes/api.js';
import { brewSystemRoutes } from './routes/brewSystem.js';
import { bruceRoutes } from './routes/bruce.js';
import { commandRoutes, deviceRoutes, ingestRoutes } from './routes/devices.js';
import { musicRoutes } from './routes/music.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Vite's fingerprinted output directory — matched on either path separator. */
const FINGERPRINTED_ASSETS = /[\\/]assets[\\/]/;

/**
 * Cache policy for the built web app. Everything Vite emits under /assets/ has
 * a content hash in its filename, so a given URL can never change contents and
 * is safe to cache forever — that's the ~400 kB recharts chunk the kiosk and
 * the phone were re-downloading on every load. index.html is *not* fingerprinted
 * (it's what points at the current hashes), so it must be revalidated or a
 * deploy would never reach a browser that already has it.
 */
function setStaticCacheHeaders(res: SetHeadersResponse, filePath: string): void {
  res.setHeader(
    'Cache-Control',
    FINGERPRINTED_ASSETS.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache',
  );
}

/**
 * Build the server: migrations, plugins, every route, and the SPA fallback —
 * everything except listening on a port and starting the background schedulers,
 * which index.ts adds around this.
 *
 * Split out so tests can drive the real server through `app.inject()` without a
 * socket: point DATABASE_PATH at a temp file, call buildApp(), and make
 * requests. Nothing here is process-global, so each test gets a clean instance.
 */
export async function buildApp(options: FastifyServerOptions = {}): Promise<FastifyInstance> {
  // Apply migrations before serving any requests.
  runMigrations();

  const app = Fastify({ logger: true, ...options });

  // Ensure a login account exists (first boot creates the admin user).
  seedAdminUser(app.log);

  // Compress responses. Cloudflare already compresses what leaves the tunnel,
  // but the LAN kiosk and phone talk to this server directly and were pulling
  // history JSON (up to 5000 rows) and the JS bundles uncompressed. Registered
  // before any route so its onSend hook covers all of them; the Bruce SSE
  // stream is unaffected because it hijacks the socket and writes to reply.raw.
  await app.register(fastifyCompress, { global: true, threshold: 1024 });

  // Baseline security headers, which matter now that this server answers on a
  // public tunnel hostname: HSTS, nosniff, no framing, a tight referrer policy.
  await app.register(fastifyHelmet, {
    // No CSP. The kiosk's music page loads album art straight off the speaker
    // (`http://<sonos-ip>:1400/…`, see NowPlaying.albumArtUrl), so a useful
    // img-src would have to allow any plain-http host on the LAN; React and
    // recharts also style through inline `style` attributes. A policy loose
    // enough to keep both working wouldn't be buying anything.
    contentSecurityPolicy: false,
    // The Android app is a deliberate cross-origin consumer of this API (see
    // the CORS registration below), so don't let CORP contradict that.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

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

  // Bruce, the voice assistant (apps/bruce, loopback status API on this Pi):
  // live state + transcript for the dashboard's Bruce page, plus speak/volume
  // controls. Status is session-gated; controls are admin-only.
  await app.register(bruceRoutes, { prefix: '/api/bruce' });

  // Serve the built web app (apps/web/dist) in production. In dev the web app
  // is served by Vite on its own port, so this directory may not exist.
  const webDist = resolve(__dirname, '../../web/dist');
  if (existsSync(webDist)) {
    // `cacheControl: false` turns off the plugin's own header (a flat
    // `public, max-age=0`), which would otherwise overwrite what setHeaders
    // writes; ETag/Last-Modified still go out, so `no-cache` revalidates to 304.
    await app.register(fastifyStatic, {
      root: webDist,
      cacheControl: false,
      setHeaders: setStaticCacheHeaders,
    });

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

  return app;
}
