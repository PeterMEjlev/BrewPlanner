import { setVolumeSchema } from '@checklist/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';
import { requireAdmin, requireAuth } from '../auth/index.js';
import * as sonos from '../sonos.js';

/** Parse with a Zod schema, replying 400 on failure. Returns null when invalid. */
function parse<T>(schema: z.ZodType<T>, data: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    reply.status(400).send({ error: 'Validation failed', issues: result.error.issues });
    return null;
  }
  return result.data;
}

/**
 * Brewery speaker (Sonos / IKEA SYMFONISK) control, mounted at /api/music.
 * Reading now-playing only needs a session (guests may watch); the transport +
 * volume controls are guarded by requireAdmin, so — exactly like device
 * setpoints — the Pi kiosk on the LAN and admins can drive the music while a
 * remote guest through the Cloudflare tunnel cannot. A 503 means no speaker was
 * reachable (none on the network, or the wrong SONOS_HOST/SONOS_ROOM).
 */
export async function musicRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  const adminOnly = { preHandler: requireAdmin };

  app.get('/now-playing', async (_req, reply) => {
    try {
      return await sonos.getNowPlaying();
    } catch (err) {
      return speakerError(err, reply);
    }
  });

  app.post('/play', adminOnly, async (_req, reply) => control(() => sonos.play(), reply));
  app.post('/pause', adminOnly, async (_req, reply) => control(() => sonos.pause(), reply));
  app.post('/next', adminOnly, async (_req, reply) => control(() => sonos.next(), reply));
  app.post('/previous', adminOnly, async (_req, reply) => control(() => sonos.previous(), reply));

  app.post('/volume', adminOnly, async (req, reply) => {
    const body = parse(setVolumeSchema, req.body, reply);
    if (!body) return;
    return control(() => sonos.setVolume(body.volume), reply);
  });
}

/** Run a control action, returning 204 on success or 503 if the speaker is gone. */
async function control(action: () => Promise<void>, reply: FastifyReply): Promise<unknown> {
  try {
    await action();
    return reply.status(204).send();
  } catch (err) {
    return speakerError(err, reply);
  }
}

/** Map a Sonos failure to 503 with its message. */
function speakerError(err: unknown, reply: FastifyReply): FastifyReply {
  const message = err instanceof Error ? err.message : 'Speaker unavailable.';
  return reply.status(503).send({ error: message });
}
