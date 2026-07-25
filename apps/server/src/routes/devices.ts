import {
  ackCommandsSchema,
  historyQuerySchema,
  idParamSchema,
  ingestSchema,
  metricTotalQuerySchema,
  setReportingIntervalSchema,
  setSetpointSchema,
} from '@checklist/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { registerAuditHook } from '../audit/hook.js';
import { requireAdmin, requireAuth } from '../auth/index.js';
import { requireDevice } from '../devices/auth.js';
import * as deviceFallback from '../devices/fallback.js';
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
    // Record the device's self-reported MAC (heartbeat metadata) when sent — a
    // no-op once stored, since it doesn't change.
    if (body.mac) devices.recordDeviceMac(req.device!.id, body.mac);
    // Same for the name the device carries in its manufacturer's app, when the
    // agent knows it — shown on the Devices page beside the registered name.
    if (body.vendorName) devices.recordDeviceVendorName(req.device!.id, body.vendorName);
    // Record the device's LAN IP: the agent-declared device address when present
    // (an agent polling a separate networked device — e.g. the Inkbird controller
    // — reports the controller's own IP), else the push's source IP.
    devices.recordDeviceIp(req.device!.id, body.ip ?? req.ip);
    // Echo the device's configured cadence so the agent self-adjusts its
    // sample/push rate to whatever the operator set in the dashboard.
    return reply
      .status(202)
      .send({ accepted: samples.length, intervalSec: req.device!.reportingIntervalSec });
  });
}

/**
 * Device read API for the human dashboard — list devices with live status and
 * pull history for charts. Guarded by user auth; mounted under /api/devices.
 */
export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Record setpoint changes (the one mutation here) into the change history.
  registerAuditHook(app);

  app.get('/', async () => deviceFallback.listDeviceStatus());

  app.get('/:id', async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    const status = deviceFallback.getDeviceStatus(params.id);
    if (!status) return reply.status(404).send({ error: 'Device not found' });
    return status;
  });

  app.get('/:id/history', async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    const query = parse(historyQuerySchema, req.query, reply);
    if (!query) return;
    const history = deviceFallback.getHistory(params.id, query);
    if (!history) return reply.status(404).send({ error: 'Device not found' });
    return history;
  });

  // All-time total for a cumulative metric (e.g. total energy / water used).
  app.get('/:id/total', async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    const query = parse(metricTotalQuerySchema, req.query, reply);
    if (!query) return;
    const total = deviceFallback.getMetricTotal(params.id, query.metric);
    if (total == null) return reply.status(404).send({ error: 'Device not found' });
    return { metric: query.metric, total };
  });

  // Update a device's logging cadence (seconds). Admin-or-local only, like the
  // setpoint control. Only real (registered) devices have an agent to honour it,
  // so a mock/placeholder id is rejected. The agent picks the new value up on
  // its next push (the ingest response).
  app.patch('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    const body = parse(setReportingIntervalSchema, req.body, reply);
    if (!body) return;
    if (!devices.setReportingInterval(params.id, body.reportingIntervalSec)) {
      return reply.status(404).send({ error: 'Device not found' });
    }
    return { reportingIntervalSec: body.reportingIntervalSec };
  });

  // Queue a new target setpoint for a brew controller. The change isn't applied
  // here — it's stored for the device's agent to pull and write to the hardware
  // (see commandRoutes); the response echoes the now-pending target so the UI
  // can show it immediately. Admin-or-local only: a read-only guest can't change
  // a setpoint (the kiosk on the LAN still can, without a login).
  app.post('/:id/setpoint', { preHandler: requireAdmin }, async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    const device = deviceFallback.getDeviceStatus(params.id);
    if (!device) return reply.status(404).send({ error: 'Device not found' });
    if (device.type !== 'brew_controller') {
      return reply.status(400).send({ error: 'Device does not support a setpoint' });
    }
    const body = parse(setSetpointSchema, req.body, reply);
    if (!body) return;
    if (!deviceFallback.queueSetpoint(params.id, body.value)) {
      return reply.status(400).send({ error: 'Device does not support a setpoint' });
    }
    return { pendingSetpointC: body.value };
  });
}

/**
 * Command API for satellites — a device pulls the commands queued for it (e.g. a
 * new setpoint to write to its controller) and acks them once applied. Same
 * per-device key trust path as ingestion (NOT user sessions); mounted under
 * /api/commands.
 */
export async function commandRoutes(app: FastifyInstance): Promise<void> {
  app.decorateRequest('device', undefined);
  app.addHook('preHandler', requireDevice);

  // GET /api/commands — this device's outstanding commands (oldest first).
  app.get('/', async (req) => devices.pendingCommands(req.device!.id));

  // POST /api/commands/ack — clear commands this device has applied.
  app.post('/ack', async (req, reply) => {
    const body = parse(ackCommandsSchema, req.body, reply);
    if (!body) return;
    return { acked: devices.ackCommands(req.device!.id, body.ids) };
  });
}
