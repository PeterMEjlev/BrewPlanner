import {
  alertsQuerySchema,
  createChecklistSchema,
  createStepSchema,
  createTodoSchema,
  graphColorsSchema,
  idParamSchema,
  notificationSettingsSchema,
  reorderStepsSchema,
  reorderTodosSchema,
  setActiveRecipeSchema,
  stepIdParamSchema,
  updateChecklistSchema,
  updateStepSchema,
  updateTodoSchema,
} from '@checklist/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { listAlerts } from '../alerts/repo.js';
import { requireAuth } from '../auth/index.js';
import * as bf from '../brewersfriend.js';
import * as telegram from '../notify/telegram.js';
import * as repo from '../repo.js';

/** Parse with a Zod schema, replying 400 on failure. Returns null when invalid. */
function parse<T>(schema: z.ZodType<T>, data: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    reply.status(400).send({ error: 'Validation failed', issues: result.error.issues });
    return null;
  }
  return result.data;
}

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  // Every route below requires authentication, except when the request is
  // trusted-local (the Pi's own kiosk on the LAN). Auth endpoints live in a
  // separate plugin (/api/auth) and are deliberately not affected by this.
  app.addHook('preHandler', requireAuth);

  // --- Checklists -------------------------------------------------------
  app.get('/checklists', async () => repo.listChecklists());

  app.post('/checklists', async (req, reply) => {
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

  app.patch('/checklists/:id', async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    const body = parse(updateChecklistSchema, req.body, reply);
    if (!body) return;
    const updated = repo.updateChecklist(params.id, body.name);
    if (!updated) return reply.status(404).send({ error: 'Checklist not found' });
    return updated;
  });

  app.delete('/checklists/:id', async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    if (!repo.deleteChecklist(params.id)) {
      return reply.status(404).send({ error: 'Checklist not found' });
    }
    return reply.status(204).send();
  });

  app.post('/checklists/:id/activate', async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    const activated = repo.activateChecklist(params.id);
    if (!activated) return reply.status(404).send({ error: 'Checklist not found' });
    return activated;
  });

  // --- Steps ------------------------------------------------------------
  app.post('/checklists/:id/steps', async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    const body = parse(createStepSchema, req.body, reply);
    if (!body) return;
    const step = repo.addStep(params.id, body.text, body.required ?? true);
    if (!step) return reply.status(404).send({ error: 'Checklist not found' });
    return reply.status(201).send(step);
  });

  app.patch('/steps/:id', async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    const body = parse(updateStepSchema, req.body, reply);
    if (!body) return;
    const updated = repo.updateStep(params.id, body);
    if (!updated) return reply.status(404).send({ error: 'Step not found' });
    return updated;
  });

  app.delete('/steps/:id', async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    if (!repo.deleteStep(params.id)) return reply.status(404).send({ error: 'Step not found' });
    return reply.status(204).send();
  });

  app.post('/checklists/:id/reorder-steps', async (req, reply) => {
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

  app.post('/runs/start', async (_req, reply) => {
    const state = repo.startRun();
    if (!state) return reply.status(409).send({ error: 'No active checklist' });
    return state;
  });

  app.post('/runs/reset', async (_req, reply) => {
    const state = repo.resetRun();
    if (!state) return reply.status(409).send({ error: 'No active checklist' });
    return state;
  });

  app.post('/runs/current/steps/:stepId/toggle', async (req: FastifyRequest, reply) => {
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

  app.post('/todos', async (req, reply) => {
    const body = parse(createTodoSchema, req.body, reply);
    if (!body) return;
    return reply.status(201).send(repo.createTodo(body.text));
  });

  app.patch('/todos/:id', async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    const body = parse(updateTodoSchema, req.body, reply);
    if (!body) return;
    const updated = repo.updateTodo(params.id, body);
    if (!updated) return reply.status(404).send({ error: 'To-do not found' });
    return updated;
  });

  app.delete('/todos/:id', async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    if (!repo.deleteTodo(params.id)) return reply.status(404).send({ error: 'To-do not found' });
    return reply.status(204).send();
  });

  app.post('/todos/reorder', async (req, reply) => {
    const body = parse(reorderTodosSchema, req.body, reply);
    if (!body) return;
    const result = repo.reorderTodos(body.todoIds);
    if (!result) {
      return reply.status(400).send({ error: 'todoIds must match the to-do list exactly' });
    }
    return result;
  });

  app.post('/todos/clear-completed', async () => repo.clearCompletedTodos());

  // --- Alerts -----------------------------------------------------------
  // Recorded alert history (device offline episodes, keg-age and
  // fermentation-complete events), newest first.
  app.get('/alerts', async (req, reply) => {
    const query = parse(alertsQuerySchema, req.query, reply);
    if (!query) return;
    return listAlerts(query.limit);
  });

  // --- Brewer's Friend recipes -----------------------------------------
  // List the account's recipes (server-side proxy; the API key stays on the
  // server). 503 when no key is configured; 502 if the upstream call fails.
  app.get('/recipes', async (req, reply) => {
    try {
      return await bf.listRecipes();
    } catch (err) {
      if (err instanceof bf.BrewersFriendNotConfiguredError) {
        return reply.status(503).send({ error: err.message });
      }
      req.log.error(err, 'Brewer\'s Friend recipe fetch failed');
      return reply.status(502).send({ error: 'Could not reach Brewer\'s Friend' });
    }
  });

  // The single "currently in the fermenter" recipe shown on the kiosk card.
  app.get('/recipe', async () => ({ recipe: repo.getActiveRecipe() }));

  app.put('/recipe', async (req, reply) => {
    const body = parse(setActiveRecipeSchema, req.body, reply);
    if (!body) return;
    const recipe = repo.setActiveRecipe({
      id: body.id,
      name: body.name,
      style: body.style ?? '',
    });
    return { recipe };
  });

  app.delete('/recipe', async (_req, reply) => {
    repo.clearActiveRecipe();
    return reply.status(204).send();
  });

  // --- Notifications ----------------------------------------------------
  // Operator-tunable alert preferences (keg age, fermentation done). The
  // background scheduler reads these; Telegram credentials stay in env vars.
  app.get('/notifications/settings', async () => repo.getNotificationSettings());

  app.put('/notifications/settings', async (req, reply) => {
    const body = parse(notificationSettingsSchema, req.body, reply);
    if (!body) return;
    return repo.setNotificationSettings(body);
  });

  // --- Graph colours ----------------------------------------------------
  // The shared chart palette, edited from the desktop Settings page and read by
  // every screen (desktop dashboard + Pi kiosk).
  app.get('/graph-colors', async () => repo.getGraphColors());

  app.put('/graph-colors', async (req, reply) => {
    const body = parse(graphColorsSchema, req.body, reply);
    if (!body) return;
    return repo.setGraphColors(body);
  });

  // Send a test message so the operator can confirm delivery from the UI.
  // 503 when the server has no Telegram credentials; 502 if the send fails.
  app.post('/notifications/test', async (req, reply) => {
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
}
