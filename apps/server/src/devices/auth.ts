import type { Device } from '@checklist/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { deviceByKey, touchLastSeen } from './repo.js';

/**
 * The ingestion path is authenticated by a per-device API key, NOT by a user
 * session — satellites are headless and never log in. This is deliberately a
 * separate trust path from `requireAuth` (which guards the human-facing API).
 */
declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated device, set by `requireDevice` on ingestion routes. */
    device?: Device;
  }
}

/**
 * preHandler guard for ingestion routes. Requires a valid `Authorization:
 * Bearer <device-key>` header, attaches the device to the request, and stamps
 * its heartbeat. Replies 401 otherwise.
 */
export async function requireDevice(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  const key = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!key) {
    await reply.status(401).send({ error: 'Device API key required' });
    return;
  }
  const device = deviceByKey(key);
  if (!device) {
    await reply.status(401).send({ error: 'Invalid device API key' });
    return;
  }
  // Stamp the last-contact heartbeat. The device's LAN IP is recorded separately
  // by the ingest handler (which can prefer an agent-declared device IP over the
  // transport source address); command polls just refresh the heartbeat.
  touchLastSeen(device.id);
  req.device = device;
}
