import { historyQuerySchema, idParamSchema, ingestSchema } from '@checklist/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/index.js';
import { requireDevice } from '../devices/auth.js';
import * as devices from '../devices/repo.js';

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
 * Ingestion API — satellites push here with an `Authorization: Bearer <key>`.
 * Authenticated per-device (NOT by user session); mounted under /api/ingest.
 */
export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  app.decorateRequest('device', undefined);
  app.addHook('preHandler', requireDevice);

  // POST /api/ingest — record readings; an empty body is a valid heartbeat
  // (the guard already stamped lastSeenAt before we got here).
  app.post('/', async (req, reply) => {
    const body = parse(ingestSchema, req.body, reply);
    if (!body) return;
    // `readings` defaults to [] in the schema, but its input type is optional.
    const samples = body.readings ?? [];
    devices.insertReadings(req.device!.id, samples);
    return reply.status(202).send({ accepted: samples.length });
  });
}

/**
 * Device read API for the human dashboard — list devices with live status and
 * pull history for charts. Guarded by user auth; mounted under /api/devices.
 */
export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async () => devices.listDeviceStatus());

  app.get('/:id', async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    const status = devices.getDeviceStatus(params.id);
    if (!status) return reply.status(404).send({ error: 'Device not found' });
    return status;
  });

  app.get('/:id/history', async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    if (!devices.getDevice(params.id)) {
      return reply.status(404).send({ error: 'Device not found' });
    }
    const query = parse(historyQuerySchema, req.query, reply);
    if (!query) return;
    return devices.getHistory(params.id, query);
  });
}
