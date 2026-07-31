import type {
  BrewPot,
  BrewPump,
  BrewSystemAppSettings,
  BrewSystemState,
} from '@checklist/shared';
import { brewEnabledSchema, brewOnSchema, brewTimerActionSchema, brewValueSchema } from '@checklist/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { registerAuditHook } from '../audit/hook.js';
import { requireAdmin, requireAuth } from '../auth/index.js';
import { RIG_TIMEOUT_MS, rigBase, rigGet } from '../brewSystemClient.js';

/**
 * Proxy to the brewing rig (a separate Raspberry Pi running brew-system-v3).
 *
 * The rig's FastAPI has NO authentication — it's designed to be LAN-only, driven
 * by its own touchscreen. This module is the only path to it from outside: reads
 * require a session (or trusted-local), controls require admin. Only the
 * endpoints named here are forwarded — never a blind pass-through — so the rig's
 * destructive endpoints (hardware re-init, settings reset) stay unreachable.
 *
 * The rig is normally powered off between brew days, so "unreachable" is an
 * expected state, not an error: reads answer `{ online: false }` and the UI
 * shows an offline card instead of failing.
 */

/**
 * Forward a control command. Distinguishes "rig said no" (bad request — its
 * detail is passed through) from "rig didn't answer" (502, expected when off).
 */
async function rigPost(reply: FastifyReply, base: string, path: string, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RIG_TIMEOUT_MS),
    });
  } catch {
    return reply.status(502).send({ error: 'Brew system is not responding (is it powered on?)' });
  }
  if (!res.ok) {
    let detail = `Brew system rejected the command (${res.status})`;
    try {
      const data = (await res.json()) as { detail?: string };
      if (typeof data?.detail === 'string') detail = data.detail;
    } catch {
      /* keep the generic message */
    }
    return reply.status(502).send({ error: detail });
  }
  return await res.json();
}

/** Parse with a Zod schema, replying 400 on failure. Returns null when invalid. */
function parse<T>(schema: z.ZodType<T>, data: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    reply.status(400).send({ error: 'Validation failed', issues: result.error.issues });
    return null;
  }
  return result.data;
}

const potParamSchema = z.object({ pot: z.enum(['BK', 'HLT']) });
const pumpParamSchema = z.object({ pump: z.enum(['P1', 'P2']) });

/** Query for GET /temperature/average — MLT has no heater but does have a sensor. */
const tempAverageQuerySchema = z.object({
  pot: z.enum(['BK', 'MLT', 'HLT']),
  minutes: z.coerce.number().positive(),
});

export async function brewSystemRoutes(app: FastifyInstance): Promise<void> {
  registerAuditHook(app);

  // --- Reads: any signed-in user (or trusted-local) -------------------------

  // GET /api/brew-system/state — the rig's full live state, wrapped in an
  // availability envelope. Polled by the dashboard, so failures must be cheap
  // and silent (a powered-off rig is the normal case most of the year).
  app.get('/state', { preHandler: requireAuth }, async () => {
    const base = rigBase();
    if (!base) return { configured: false, online: false };
    try {
      const state = await rigGet<BrewSystemState>(base, '/api/hardware/state');
      return { configured: true, online: true, state };
    } catch {
      return { configured: true, online: false };
    }
  });

  // GET /api/brew-system/config — the rig's app settings (power limits,
  // auto-efficiency steps) and theme colours. Fetched once per page load;
  // deliberately does NOT expose the rig's GPIO/sensor wiring.
  app.get('/config', { preHandler: requireAuth }, async () => {
    const base = rigBase();
    if (!base) return { configured: false, online: false };
    try {
      const settings = await rigGet<{ app?: BrewSystemAppSettings; theme?: Record<string, string> }>(
        base,
        '/api/settings',
      );
      return { configured: true, online: true, app: settings.app, theme: settings.theme };
    } catch {
      return { configured: true, online: false };
    }
  });

  // GET /api/brew-system/temperature/average?pot=BK&minutes=5 — average pot
  // temperature over the rig's current session log. Added for Bruce (the voice
  // assistant), who answers "what was the average mash temp the last 10
  // minutes?" from it; same availability envelope as the other reads.
  app.get('/temperature/average', { preHandler: requireAuth }, async (req, reply) => {
    const base = rigBase();
    if (!base) return { configured: false, online: false };
    const query = parse(tempAverageQuerySchema, req.query, reply);
    if (!query) return;
    try {
      const data = await rigGet<Record<string, unknown>>(
        base,
        `/api/temperature/average?pot=${query.pot}&minutes=${query.minutes}`,
      );
      return { configured: true, online: true, ...data };
    } catch {
      return { configured: true, online: false };
    }
  });

  // --- Controls: admin only (guests can't even see the page) ----------------

  /** Register a POST forward with param + body validation in one place. */
  function control(
    routePath: string,
    paramSchema: z.ZodType<Record<string, string>>,
    bodySchema: z.ZodType<unknown>,
    rigPath: (params: Record<string, string>) => string,
  ): void {
    app.post(routePath, { preHandler: requireAdmin }, async (req, reply) => {
      const base = rigBase();
      if (!base) {
        return reply.status(503).send({ error: 'Brew system is not configured (set BREW_SYSTEM_URL)' });
      }
      const params = parse(paramSchema, req.params, reply);
      if (!params) return;
      const body = parse(bodySchema, req.body, reply);
      if (body === null) return;
      return rigPost(reply, base, rigPath(params), body);
    });
  }

  control('/pot/:pot/power', potParamSchema, brewOnSchema, (p) => `/api/hardware/pot/${p.pot as BrewPot}/power`);
  control('/pot/:pot/efficiency', potParamSchema, brewValueSchema, (p) => `/api/hardware/pot/${p.pot}/efficiency`);
  control('/pot/:pot/sv', potParamSchema, brewValueSchema, (p) => `/api/hardware/pot/${p.pot}/sv`);
  control('/pot/:pot/regulation', potParamSchema, brewEnabledSchema, (p) => `/api/hardware/pot/${p.pot}/regulation`);
  control('/pump/:pump/power', pumpParamSchema, brewOnSchema, (p) => `/api/hardware/pump/${p.pump as BrewPump}/power`);
  control('/pump/:pump/speed', pumpParamSchema, brewValueSchema, (p) => `/api/hardware/pump/${p.pump}/speed`);
  control('/timer', z.object({}), brewTimerActionSchema, () => '/api/hardware/timer');
}
