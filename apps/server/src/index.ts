import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { runMigrations } from './db/index.js';
import { apiRoutes } from './routes/api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOST = process.env.HOST ?? '0.0.0.0';
const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  // Apply migrations before serving any requests.
  runMigrations();

  const app = Fastify({ logger: true });

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
