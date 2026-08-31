import {
  queuePositionSchema,
  reorderQueueSchema,
  seekSchema,
  setPlayModeSchema,
  setVolumeSchema,
} from '@checklist/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAdmin, requireAuth } from '../auth/index.js';
import * as sonos from '../sonos.js';
import { parse } from './parse.js';

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

  app.post('/seek', adminOnly, async (req, reply) => {
    const body = parse(seekSchema, req.body, reply);
    if (!body) return;
    return control(() => sonos.seek(body.positionSec), reply);
  });

  app.post('/play-mode', adminOnly, async (req, reply) => {
    const body = parse(setPlayModeSchema, req.body, reply);
    if (!body) return;
    return control(() => sonos.setPlayMode(body.shuffle, body.repeat), reply);
  });

  // Queue. Reading it is guest-visible like now-playing; changing it isn't.
  app.get('/queue', async (_req, reply) => {
    try {
      return await sonos.getQueue();
    } catch (err) {
      return speakerError(err, reply);
    }
  });

  app.post('/queue/reorder', adminOnly, async (req, reply) => {
    const body = parse(reorderQueueSchema, req.body, reply);
    if (!body) return;
    return control(() => sonos.reorderQueue(body.from, body.to), reply);
  });

  app.post('/queue/play', adminOnly, async (req, reply) => {
    const body = parse(queuePositionSchema, req.body, reply);
    if (!body) return;
    return control(() => sonos.playQueuePosition(body.position), reply);
  });

  app.post('/queue/remove', adminOnly, async (req, reply) => {
    const body = parse(queuePositionSchema, req.body, reply);
    if (!body) return;
    return control(() => sonos.removeFromQueue(body.position), reply);
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
