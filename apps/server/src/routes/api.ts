import {
  createChecklistSchema,
  createStepSchema,
  createTodoSchema,
  idParamSchema,
  reorderStepsSchema,
  reorderTodosSchema,
  stepIdParamSchema,
  updateChecklistSchema,
  updateStepSchema,
  updateTodoSchema,
} from '@checklist/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
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
}
