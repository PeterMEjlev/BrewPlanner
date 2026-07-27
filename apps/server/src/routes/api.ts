import {
  alertsQuerySchema,
  auditQuerySchema,
  createChecklistSchema,
  createStepSchema,
  createTodoSchema,
  deviceDataSourcesSchema,
  graphColorsSchema,
  idParamSchema,
  kegContentColorsSchema,
  kegNumberParamSchema,
  notificationSettingsSchema,
  priceOptionsQuerySchema,
  priceOverrideQuerySchema,
  priceOverrideSchema,
  priceSearchQuerySchema,
  reorderStepsSchema,
  reorderTodosSchema,
  setActiveRecipeSchema,
  stepIdParamSchema,
  updateChecklistSchema,
  updateKegSchema,
  updateStepSchema,
  updateTodoSchema,
} from '@checklist/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { dismissAlert, dismissAllAlerts, listAlerts } from '../alerts/repo.js';
import { listAudit } from '../audit/repo.js';
import { registerAuditHook } from '../audit/hook.js';
import { requireAdmin, requireAuth } from '../auth/index.js';
import * as bf from '../brewersfriend.js';
import { KegWriteNotConfiguredError, fetchKegs, updateKeg } from '../kegs.js';
import * as prices from '../prices.js';
import { pricingInfo } from '../prices.js';
import { deleteOverride as deletePriceOverride, saveOverride as savePriceOverride } from '../priceOverrides.js';
import * as telegram from '../notify/telegram.js';
import * as repo from '../repo.js';
import {
  UpdateInProgressError,
  UpdateUnsupportedError,
  readUpdateStatus,
  triggerUpdate,
} from '../system/update.js';

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
 * Shared failure handling for the two Brewer's Friend proxy routes: a missing
 * API key is a configuration problem the user can fix (503, message shown on the
 * page), anything else is an upstream failure (502).
 */
function recipeError(err: unknown, req: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (err instanceof bf.BrewersFriendNotConfiguredError) {
    return reply.status(503).send({ error: err.message });
  }
  req.log.error(err, 'Brewer\'s Friend recipe fetch failed');
  return reply.status(502).send({ error: 'Could not reach Brewer\'s Friend' });
}

/**
 * Route options that add the admin-or-local guard on top of the plugin-wide
 * requireAuth hook. Applied to every mutating route below so a logged-in guest
 * (read-only) is refused with 403 while the kiosk/LAN and admins pass. GET
 * routes omit it — guests may view everything (except the Brew System page,
 * which is gated in the web app).
 */
const adminOnly = { preHandler: requireAdmin };

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  // Every route below requires authentication, except when the request is
  // trusted-local (the Pi's own kiosk on the LAN). Auth endpoints live in a
  // separate plugin (/api/auth) and are deliberately not affected by this.
  app.addHook('preHandler', requireAuth);

  // Record every successful admin mutation below into the change history.
  registerAuditHook(app);

  // --- Checklists -------------------------------------------------------
  app.get('/checklists', async () => repo.listChecklists());

  app.post('/checklists', adminOnly, async (req, reply) => {
    const body = parse(createChecklistSchema, req.body, reply);
    if (!body) return;
    return reply.status(201).send(repo.createChecklist(body.name));
  });

  app.get('/checklists/:id', async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    const checklist = repo.getChecklist(params.id);
    if (!checklist) return reply.status(404).send({ error: 'Checklist not found' });
    return checklist;
  });

  app.patch('/checklists/:id', adminOnly, async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    const body = parse(updateChecklistSchema, req.body, reply);
    if (!body) return;
    const updated = repo.updateChecklist(params.id, body.name);
    if (!updated) return reply.status(404).send({ error: 'Checklist not found' });
    return updated;
  });

  app.delete('/checklists/:id', adminOnly, async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    if (!repo.deleteChecklist(params.id)) {
      return reply.status(404).send({ error: 'Checklist not found' });
    }
    return reply.status(204).send();
  });

  app.post('/checklists/:id/activate', adminOnly, async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    const activated = repo.activateChecklist(params.id);
    if (!activated) return reply.status(404).send({ error: 'Checklist not found' });
    return activated;
  });

  // --- Steps ------------------------------------------------------------
  app.post('/checklists/:id/steps', adminOnly, async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    const body = parse(createStepSchema, req.body, reply);
    if (!body) return;
    const step = repo.addStep(params.id, body.text, body.required ?? true);
    if (!step) return reply.status(404).send({ error: 'Checklist not found' });
    return reply.status(201).send(step);
  });

  app.patch('/steps/:id', adminOnly, async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    const body = parse(updateStepSchema, req.body, reply);
    if (!body) return;
    const updated = repo.updateStep(params.id, body);
    if (!updated) return reply.status(404).send({ error: 'Step not found' });
    return updated;
  });

  app.delete('/steps/:id', adminOnly, async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    if (!repo.deleteStep(params.id)) return reply.status(404).send({ error: 'Step not found' });
    return reply.status(204).send();
  });

  app.post('/checklists/:id/reorder-steps', adminOnly, async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    const body = parse(reorderStepsSchema, req.body, reply);
    if (!body) return;
    const result = repo.reorderSteps(params.id, body.stepIds);
    if (!result) {
      return reply
        .status(400)
        .send({ error: 'stepIds must match the checklist steps exactly' });
    }
    return result;
  });

  // --- Active checklist / run / progress -------------------------------
  app.get('/active', async () => repo.getActiveState());

  app.post('/runs/start', adminOnly, async (_req, reply) => {
    const state = repo.startRun();
    if (!state) return reply.status(409).send({ error: 'No active checklist' });
    return state;
  });

  app.post('/runs/reset', adminOnly, async (_req, reply) => {
    const state = repo.resetRun();
    if (!state) return reply.status(409).send({ error: 'No active checklist' });
    return state;
  });

  app.post('/runs/current/steps/:stepId/toggle', adminOnly, async (req: FastifyRequest, reply) => {
    const params = parse(stepIdParamSchema, req.params, reply);
    if (!params) return;
    const state = repo.toggleStep(params.stepId);
    if (!state) {
      return reply
        .status(409)
        .send({ error: 'No active checklist, or step does not belong to it' });
    }
    return state;
  });

  // --- Brewery to-do list ----------------------------------------------
  app.get('/todos', async () => repo.listTodos());

  app.post('/todos', adminOnly, async (req, reply) => {
    const body = parse(createTodoSchema, req.body, reply);
    if (!body) return;
    return reply.status(201).send(repo.createTodo(body.text));
  });

  app.patch('/todos/:id', adminOnly, async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    const body = parse(updateTodoSchema, req.body, reply);
    if (!body) return;
    const updated = repo.updateTodo(params.id, body);
    if (!updated) return reply.status(404).send({ error: 'To-do not found' });
    return updated;
  });

  app.delete('/todos/:id', adminOnly, async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    if (!repo.deleteTodo(params.id)) return reply.status(404).send({ error: 'To-do not found' });
    return reply.status(204).send();
  });

  app.post('/todos/reorder', adminOnly, async (req, reply) => {
    const body = parse(reorderTodosSchema, req.body, reply);
    if (!body) return;
    const result = repo.reorderTodos(body.todoIds);
    if (!result) {
      return reply.status(400).send({ error: 'todoIds must match the to-do list exactly' });
    }
    return result;
  });

  app.post('/todos/clear-completed', adminOnly, async () => repo.clearCompletedTodos());

  // --- Alerts -----------------------------------------------------------
  // Recorded alert history (device offline episodes, keg-age and
  // fermentation-complete events), newest first.
  app.get('/alerts', async (req, reply) => {
    const query = parse(alertsQuerySchema, req.query, reply);
    if (!query) return;
    return listAlerts(query.limit);
  });

  // Clear the whole feed at once (the Alerts page's "Clear all"). Dismisses
  // rather than deletes, so the offline-alert dedup still sees the old rows.
  app.post('/alerts/clear', adminOnly, async () => ({ dismissed: dismissAllAlerts() }));

  // Dismiss an alert (clicked away on the dashboard). It drops out of every feed
  // but stays in the table so a still-offline device doesn't re-raise it.
  app.delete('/alerts/:id', adminOnly, async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    if (!dismissAlert(params.id)) return reply.status(404).send({ error: 'Alert not found' });
    return reply.status(204).send();
  });

  // --- Change history ---------------------------------------------------
  // The audit log of admin changes, newest first. Admin-only: it reveals who
  // did what, so a read-only guest can't open it (the web app hides the tab too).
  app.get('/history', adminOnly, async (req, reply) => {
    const query = parse(auditQuerySchema, req.query, reply);
    if (!query) return;
    return listAudit(query.limit);
  });

  // --- Brewer's Friend recipes -----------------------------------------
  // List the account's recipes (server-side proxy; the API key stays on the
  // server). Served from a short server-side cache; `?refresh=1` (the Recipes
  // page's refresh button) forces a re-walk of the upstream pages.
  // 503 when no key is configured; 502 if the upstream call fails.
  app.get('/recipes', async (req, reply) => {
    const { refresh } = req.query as { refresh?: string };
    try {
      return await bf.listRecipes(refresh === '1' || refresh === 'true');
    } catch (err) {
      return recipeError(err, req, reply);
    }
  });

  // Per-recipe cost and hop rate for the whole account, for the grid's price and
  // hops/L sorts. Registered before /recipes/:id, and matched ahead of it
  // regardless — a static segment beats a parametric one in Fastify's router.
  //
  // Heavy upstream (every recipe's ingredient list) but cached for half an hour,
  // so the Recipes page only asks for it when one of those sorts is chosen.
  app.get('/recipes/stats', async (req, reply) => {
    const { refresh } = req.query as { refresh?: string };
    try {
      const stats = await bf.listRecipeStats(refresh === '1' || refresh === 'true');
      return { stats, pricing: pricingInfo() };
    } catch (err) {
      return recipeError(err, req, reply);
    }
  });

  // One recipe's full brew sheet — ingredients, mash schedule and water targets.
  // A separate (much heavier) upstream call than the list, so the Recipes page
  // only makes it when a detail view is opened.
  app.get('/recipes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await bf.getRecipe(id);
    } catch (err) {
      if (err instanceof bf.RecipeNotFoundError) {
        return reply.status(404).send({ error: err.message });
      }
      return recipeError(err, req, reply);
    }
  });

  // The single "currently in the fermenter" recipe shown on the kiosk card.
  app.get('/recipe', async () => ({ recipe: repo.getActiveRecipe() }));

  app.put('/recipe', adminOnly, async (req, reply) => {
    const body = parse(setActiveRecipeSchema, req.body, reply);
    if (!body) return;
    const recipe = repo.setActiveRecipe({
      id: body.id,
      name: body.name,
      style: body.style ?? '',
      abv: body.abv ?? '',
      url: body.url ?? '',
      ibu: body.ibu ?? '',
      ebc: body.ebc ?? '',
    });
    return { recipe };
  });

  app.delete('/recipe', adminOnly, async (_req, reply) => {
    repo.clearActiveRecipe();
    return reply.status(204).send();
  });

  // --- Ingredient prices ------------------------------------------------
  // The price picker behind each ingredient on a brew sheet. Reads are open to
  // anyone who can see the recipe; changing a price is an admin action, and
  // takes effect account-wide (a decision is stored per ingredient, not per
  // recipe), so both mutations drop the cached per-recipe figures.

  // What one ingredient could be priced against, and what it is priced at now.
  app.get('/prices/options', async (req, reply) => {
    const query = parse(priceOptionsQuerySchema, req.query, reply);
    if (!query) return;
    return prices.ingredientOptions(
      query.kind,
      query.name,
      { grams: query.grams ?? null, units: query.units ?? null },
      query.ebc ?? null,
    );
  });

  // Free-text lookup across one catalogue, for when the name match was wrong.
  app.get('/prices/search', async (req, reply) => {
    const query = parse(priceSearchQuerySchema, req.query, reply);
    if (!query) return;
    return {
      results: prices.searchCatalogue(query.kind, query.q ?? '', {
        grams: query.grams ?? null,
        units: query.units ?? null,
      }),
    };
  });

  // Pin a product for an ingredient, set its price by hand, or both.
  app.put('/prices/override', adminOnly, async (req, reply) => {
    const body = parse(priceOverrideSchema, req.body, reply);
    if (!body) return;
    // A pin is only meaningful against a listing that exists — a stale id would
    // save cleanly and then silently fall back to automatic pricing.
    if (body.catalogueId != null && !prices.catalogueHasItem(body.kind, body.catalogueId)) {
      return reply.status(400).send({ error: 'No such product in the price catalogue' });
    }
    const saved = savePriceOverride({
      kind: body.kind,
      ingredient: prices.ingredientKey(body.name),
      label: body.name,
      catalogueId: body.catalogueId,
      unitPriceDkk: body.unitPriceDkk,
      priceUnit: body.priceUnit,
      packageSizeG: body.packageSizeG,
    });
    prices.invalidatePriceOverrides();
    bf.invalidateRecipeStats();
    return saved;
  });

  // Return an ingredient to automatic pricing.
  app.delete('/prices/override', adminOnly, async (req, reply) => {
    const query = parse(priceOverrideQuerySchema, req.query, reply);
    if (!query) return;
    deletePriceOverride(query.kind, prices.ingredientKey(query.name));
    prices.invalidatePriceOverrides();
    bf.invalidateRecipeStats();
    return reply.status(204).send();
  });

  // --- Keg inventory ----------------------------------------------------
  // The keg inventory from the shared Google Sheet, parsed to JSON. The web app
  // pulls the CSV straight from the browser, but headless clients that can't
  // parse CSV (the Garmin watch app) read it here. 502 if the sheet is
  // unreachable.
  app.get('/kegs', async (req, reply) => {
    try {
      return await fetchKegs(repo.getKegContentColors());
    } catch (err) {
      req.log.error(err, 'Keg sheet fetch failed');
      return reply.status(502).send({ error: 'Could not reach the keg inventory sheet' });
    }
  });

  // Write one keg's editable fields back to the sheet (desktop dashboard only —
  // the Pi kiosk's keg screen stays read-only). Routes through a Google Apps
  // Script web app whose URL is server-side (KEG_SHEET_WRITE_URL): 503 when that
  // isn't configured, 502 if the write fails. Returns 204 on success; the client
  // optimistically updates its own copy (the published CSV can lag a fresh edit).
  app.put('/kegs/:number', adminOnly, async (req, reply) => {
    const params = parse(kegNumberParamSchema, req.params, reply);
    if (!params) return;
    const body = parse(updateKegSchema, req.body, reply);
    if (!body) return;
    try {
      await updateKeg(params.number, body);
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof KegWriteNotConfiguredError) {
        return reply.status(503).send({ error: err.message });
      }
      req.log.error(err, 'Keg sheet update failed');
      const detail = err instanceof Error ? err.message : 'Keg update failed';
      return reply.status(502).send({ error: detail });
    }
  });

  // --- Notifications ----------------------------------------------------
  // Operator-tunable alert preferences (keg age, fermentation done). The
  // background scheduler reads these; Telegram credentials stay in env vars.
  app.get('/notifications/settings', async () => repo.getNotificationSettings());

  app.put('/notifications/settings', adminOnly, async (req, reply) => {
    const body = parse(notificationSettingsSchema, req.body, reply);
    if (!body) return;
    return repo.setNotificationSettings(body);
  });

  // --- Graph colours ----------------------------------------------------
  // The shared chart palette, edited from the desktop Settings page and read by
  // every screen (desktop dashboard + Pi kiosk).
  app.get('/graph-colors', async () => repo.getGraphColors());

  app.put('/graph-colors', adminOnly, async (req, reply) => {
    const body = parse(graphColorsSchema, req.body, reply);
    if (!body) return;
    return repo.setGraphColors(body);
  });

  // --- Device data sources (mock vs. real) -----------------------------
  // Per-sensor choice of synthesized mock telemetry vs. the real agent's
  // readings, consulted by the device fallback layer. Shared across screens; a
  // sensor pinned to real that isn't reporting shows as "not connected".
  app.get('/device-sources', async () => repo.getDeviceDataSources());

  app.put('/device-sources', adminOnly, async (req, reply) => {
    const body = parse(deviceDataSourcesSchema, req.body, reply);
    if (!body) return;
    return repo.setDeviceDataSources(body);
  });

  // --- Keg content colours ---------------------------------------------
  // The shared keg/beer palette used by `/api/kegs` (including Garmin) and the
  // web inventory views.
  app.get('/keg-content-colors', async () => repo.getKegContentColors());

  app.put('/keg-content-colors', adminOnly, async (req, reply) => {
    const body = parse(kegContentColorsSchema, req.body, reply);
    if (!body) return;
    return repo.setKegContentColors(body);
  });

  // Send a test message so the operator can confirm delivery from the UI.
  // 503 when the server has no Telegram credentials; 502 if the send fails.
  app.post('/notifications/test', adminOnly, async (req, reply) => {
    if (!telegram.isConfigured()) {
      return reply
        .status(503)
        .send({ error: 'Telegram is not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID).' });
    }
    try {
      await telegram.sendTelegram('✅ <b>BrewPlanner</b> test notification from Settings.');
      return { sent: true };
    } catch (err) {
      req.log.error(err, 'Telegram test send failed');
      return reply.status(502).send({ error: 'Telegram send failed.' });
    }
  });

  // --- System / software update ----------------------------------------
  // Trigger a remote deploy (git pull + rebuild + restart) by starting the
  // one-shot updater unit, and read its progress. Admin-only: this runs
  // whatever has been pushed to the repo's remote. See system/update.ts and
  // deploy/update.sh for how the restart-during-update is handled.
  app.post('/system/update', adminOnly, async (req, reply) => {
    try {
      const status = await triggerUpdate();
      return reply.status(202).send(status);
    } catch (err) {
      if (err instanceof UpdateInProgressError) {
        return reply.status(409).send({ error: err.message });
      }
      if (err instanceof UpdateUnsupportedError) {
        return reply.status(501).send({ error: err.message });
      }
      req.log.error(err, 'Failed to start software update');
      return reply
        .status(500)
        .send({ error: 'Could not start the update. Check the server logs and the Pi setup.' });
    }
  });

  app.get('/system/update/status', adminOnly, async () => readUpdateStatus());
}
