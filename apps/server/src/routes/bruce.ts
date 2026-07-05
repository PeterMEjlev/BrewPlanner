import type { BruceServiceStatus, BruceStatus } from '@checklist/shared';
import { bruceSpeakSchema, bruceVolumeSchema } from '@checklist/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { registerAuditHook } from '../audit/hook.js';
import { requireAdmin, requireAuth } from '../auth/index.js';

/**
 * Proxy to Bruce, the voice assistant (apps/bruce), which runs as its own
 * service on this Pi and serves a loopback-only status API. Same shape as the
 * brew-rig proxy: reads need a session (or trusted-local), controls need
 * admin, and only the endpoints named here are forwarded. Bruce being down is
 * an expected state (service not enabled yet, or restarting) — status answers
 * `{ online: false }` and the dashboard shows an offline card.
 */

/** Bruce's loopback API; override with BRUCE_STATUS_URL if he runs elsewhere. */
function bruceBase(): string {
  const url = process.env.BRUCE_STATUS_URL?.trim().replace(/\/+$/, '');
  return url || 'http://127.0.0.1:3555';
}

/** Loopback answers in microseconds; anything slower means the service is down. */
const BRUCE_TIMEOUT_MS = 2000;

/** Parse with a Zod schema, replying 400 on failure. Returns null when invalid. */
function parse<T>(schema: z.ZodType<T>, data: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    reply.status(400).send({ error: 'Validation failed', issues: result.error.issues });
    return null;
  }
  return result.data;
}

/** Forward a control command; 502 with a friendly message when Bruce is down. */
async function brucePost(reply: FastifyReply, path: string, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${bruceBase()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BRUCE_TIMEOUT_MS),
    });
  } catch {
    return reply.status(502).send({ error: 'Bruce is not running (is bruce.service enabled?)' });
  }
  if (!res.ok) {
    let detail = `Bruce rejected the command (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (typeof data?.error === 'string') detail = data.error;
    } catch {
      /* keep the generic message */
    }
    return reply.status(502).send({ error: detail });
  }
  return await res.json();
}

export async function bruceRoutes(app: FastifyInstance): Promise<void> {
  registerAuditHook(app);

  // GET /api/bruce/status — live state + transcript, wrapped in an
  // availability envelope. Polled by the dashboard's Bruce page, so a down
  // service must be cheap and silent.
  app.get('/status', { preHandler: requireAuth }, async (): Promise<BruceServiceStatus> => {
    try {
      const res = await fetch(`${bruceBase()}/status`, {
        signal: AbortSignal.timeout(BRUCE_TIMEOUT_MS),
      });
      if (!res.ok) return { online: false };
      const status = (await res.json()) as BruceStatus;
      return { online: true, ...status };
    } catch {
      return { online: false };
    }
  });

  // POST /api/bruce/speak — make Bruce say a message out loud in the brewery.
  app.post('/speak', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parse(bruceSpeakSchema, req.body, reply);
    if (!body) return;
    return brucePost(reply, '/speak', body);
  });

  // POST /api/bruce/volume — set Bruce's speech volume (0–200 %).
  app.post('/volume', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parse(bruceVolumeSchema, req.body, reply);
    if (!body) return;
    return brucePost(reply, '/volume', body);
  });
}
