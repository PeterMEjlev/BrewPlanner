import {
  alertsQuerySchema,
  auditQuerySchema,
  createChecklistSchema,
  createStepSchema,
  createTodoSchema,
  deviceDataSourcesSchema,
  fermenterStateSchema,
  graphColorsSchema,
  idParamSchema,
  kegContentColorsSchema,
  kegNumberParamSchema,
  notificationSettingsSchema,
  pushTokenSchema,
  priceOptionsQuerySchema,
  priceOverrideQuerySchema,
  priceOverrideSchema,
  priceSearchQuerySchema,
  reorderStepsSchema,
  reorderTodosSchema,
  recipeDefaultsSchema,
  recipeDraftSchema,
  recipeEditSchema,
  recipeSaveSchema,
  recipeIngredientCatalogQuerySchema,
  setActiveRecipeSchema,
  startBrewSessionSchema,
  stepIdParamSchema,
  sumCost,
  unpricedIngredients,
  updateBrewSessionSchema,
  updateChecklistSchema,
  updateKegSchema,
  updateStepSchema,
  updateTodoSchema,
} from '@checklist/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { dismissAlert, dismissAllAlerts, listAlerts } from '../alerts/repo.js';
import { auditFilters, listAudit } from '../audit/repo.js';
import * as brewSessions from '../brewSessions/repo.js';
import { registerAuditHook } from '../audit/hook.js';
import { getRequestUser, requireAdmin, requireAuth } from '../auth/index.js';
import * as bf from '../brewersfriend.js';
import { KegWriteNotConfiguredError, fetchKegs, updateKeg } from '../kegs.js';
import { pushConfigured, pushToEveryone } from '../notify/push.js';
import { countPushTargets, registerPushToken, unregisterPushToken } from '../notify/pushTokens.js';
import * as prices from '../prices.js';
import { pricingInfo } from '../prices.js';
import { deleteOverride as deletePriceOverride, saveOverride as savePriceOverride } from '../priceOverrides.js';
import { recipeBackupStatus, runRecipeBackup } from '../recipeBackup.js';
import { hydrateRecipe } from '../recipeData.js';
import { ensureInitialRecipeImport, importFromBrewersFriend } from '../recipeImport.js';
import * as recipeRepo from '../recipeRepo.js';
import { outdoorTemperature } from '../weather.js';
import { yeastSpecFor } from '../yeastStrains.js';
import * as repo from '../repo.js';
import {
  UpdateInProgressError,
  UpdateUnsupportedError,
  readUpdateStatus,
  triggerUpdate,
} from '../system/update.js';
import {
  BrewSystemBusyError,
  BrewSystemUnconfiguredError,
  BrewSystemUnreachableError,
  BrewSystemUpdateInProgressError,
  BrewSystemUpdateScriptMissingError,
  BrewSystemUpdateUnsupportedError,
  readBrewSystemUpdateStatus,
  triggerBrewSystemUpdate,
} from '../system/brewSystemUpdate.js';
import { readHosts } from '../system/hosts.js';

/** Parse with a Zod schema, replying 400 on failure. Returns null when invalid. */
function parse<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
  reply: FastifyReply,
): z.output<S> | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    reply.status(400).send({ error: 'Validation failed', issues: result.error.issues });
    return null;
  }
  return result.data;
}

/**
 * Shared failure handling for Brewer's Friend import requests: a missing
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

/**
 * Stand-in identity for a recipe that isn't saved yet, so the pricing pass can
 * reuse the same hydration the library does. Nothing in a cost depends on it.
 */
const DRAFT_METADATA = {
  id: '',
  origin: 'local' as const,
  url: '',
  familyId: '',
  version: 1,
  versionNote: '',
  versions: [],
  createdAt: '',
  updatedAt: '',
};

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
    return listAudit(query);
  });

  // The accounts and categories the log contains, for the page's filter
  // dropdowns. Its own read so narrowing the list never narrows the options
  // you'd need to widen it again.
  app.get('/history/filters', adminOnly, async () => auditFilters());

  // --- App-owned recipe library -------------------------------------------
  // The first read after upgrading performs a one-way legacy import. A failed
  // import is logged without taking down the local library, so new recipes can
  // still be created while Brewer's Friend is unavailable.
  app.get('/recipes', async (req) => {
    try {
      await ensureInitialRecipeImport();
    } catch (err) {
      req.log.warn(err, 'Initial Brewer\'s Friend recipe import failed');
    }
    return recipeRepo.listRecipes();
  });

  // Explicit retry / later import. Existing ids are skipped, so importing can
  // never overwrite a recipe that has already been edited in BrewPlanner.
  app.post('/recipes/import/brewersfriend', adminOnly, async (req, reply) => {
    try {
      return await importFromBrewersFriend();
    } catch (err) {
      return recipeError(err, req, reply);
    }
  });

  app.get('/recipes/stats', async () => ({
    stats: recipeRepo.listRecipeStats(),
    pricing: pricingInfo(),
  }));

  // --- Recipe backups -----------------------------------------------------
  // What the nightly backup last did, and a way to take one now. The manual run
  // is an admin action because it publishes the whole library to Drive.
  app.get('/recipes/backup', async () => recipeBackupStatus());

  app.post('/recipes/backup', adminOnly, async (req) => runRecipeBackup('manual', req.log));

  app.get('/recipes/catalog', async (req, reply) => {
    const query = parse(recipeIngredientCatalogQuerySchema, req.query, reply);
    if (!query) return;
    const quantity = query.kind === 'yeast'
      ? { grams: null, units: 1 }
      : { grams: 1_000, units: null };
    const combined = [
      ...prices.searchCatalogue(query.kind, query.q ?? '', quantity, null, 200).map((option) => ({
        // The purées are the shop's listings, and every one of them opens with
        // the same brand: a recipe calls for mango purée, not for Ponthier. Malt
        // and yeast keep their producer — three maltsters sell a "Pilsner Malt",
        // two labs sell a Voss kveik, and the name is how the brewer tells them
        // apart in a single field.
        name: query.kind === 'other' ? option.ingredientName : option.label,
        source: 'catalogue' as const,
        // Also on its own, so the malt picker can group by maltster without
        // having to work out where the brand stops and the malt starts.
        producer: option.producer ?? null,
        ebcMin: option.ebcMin ?? null,
        ebcMax: option.ebcMax ?? null,
        ebc: option.ebcMin != null && option.ebcMax != null
          ? (option.ebcMin + option.ebcMax) / 2
          : option.ebcMin ?? option.ebcMax ?? null,
        aa: option.aa ?? null,
        // The shop lists a sachet, not a strain: what the yeast attenuates to
        // and ferments at comes from the producer's own figures.
        yeast: query.kind === 'yeast' ? yeastSpecFor(option.label) : null,
      })),
      // What past recipes have called for — dropped when the caller asked for
      // the shop only (a new recipe, which should be written from what can
      // actually be bought and priced).
      ...(query.catalogueOnly === 'true'
        ? []
        : recipeRepo
            .listRecipeIngredientOptions(query.kind, query.q ?? '')
            .map((option) =>
              query.kind === 'yeast'
                ? { ...option, yeast: yeastSpecFor(option.name, option.yeast) }
                : option,
            )),
    ];
    const attenuation = (option: { yeast?: { attenuation: string } | null }) => {
      const parsed = Number.parseFloat(option.yeast?.attenuation ?? '');
      return Number.isFinite(parsed) ? parsed : null;
    };
    combined.sort((a, b) => {
      const aValue = query.kind === 'fermentable'
        ? a.ebc
        : query.kind === 'hop' ? a.aa : query.kind === 'yeast' ? attenuation(a) : null;
      const bValue = query.kind === 'fermentable'
        ? b.ebc
        : query.kind === 'hop' ? b.aa : query.kind === 'yeast' ? attenuation(b) : null;
      if (aValue != null || bValue != null) {
        if (aValue == null) return 1;
        if (bValue == null) return -1;
        if (aValue !== bValue) return aValue - bValue;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    const seen = new Set<string>();
    return combined.filter((option) => {
      const key = option.name.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
      // The yeast and malt pickers sort and regroup what they are given — by
      // attenuation, colour, maltster and the rest — so they have to be given
      // the whole shelf rather than the first 60 of it, or "sort by brand"
      // would only ever reorder the palest malts.
    }).slice(0, query.kind === 'yeast' || query.kind === 'fermentable' ? 250 : 60);
  });

  // What it is outside the brewhouse, which a new recipe's grain temperature
  // starts from. Answers `{ outdoor: null }` rather than an error when the
  // lookup is unavailable: the editor simply opens with the field empty.
  app.get('/weather/outdoor', async () => ({ outdoor: await outdoorTemperature() }));

  // A new beer — including the copy that "Clone" saves, which is a new beer
  // rather than a version of the one it was copied from.
  app.post('/recipes', adminOnly, async (req, reply) => {
    const body = parse(recipeSaveSchema, req.body, reply);
    if (!body) return;
    return reply.status(201).send(recipeRepo.createRecipe(body.recipe, body.versionNote ?? ''));
  });

  // The next version of an existing beer: a sheet of its own, in the same
  // family, so the recipe it was written from stays exactly as it was brewed.
  app.post('/recipes/:id/versions', adminOnly, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(recipeSaveSchema, req.body, reply);
    if (!body) return;
    const saved = recipeRepo.createRecipeVersion(id, body.recipe, body.versionNote ?? '');
    if (!saved) return reply.status(404).send({ error: 'Recipe not found' });
    return reply.status(201).send(saved);
  });

  // What the sheet in the editor would cost, without saving it. A POST because
  // the whole draft is the question, but it changes nothing — the catalogue and
  // the brewer's price overrides only exist server-side, so the editor can't
  // work this out for itself.
  app.post('/recipes/price', async (req, reply) => {
    const body = parse(recipeDraftSchema, req.body, reply);
    if (!body) return;
    const priced = hydrateRecipe(DRAFT_METADATA, body);
    return {
      fermentables: sumCost(priced.fermentables),
      hops: sumCost(priced.hops),
      yeast: sumCost(priced.yeast),
      other: sumCost(priced.otherIngredients),
      cost: priced.cost,
      pricing: priced.pricing,
      // Which ingredients the total is missing, so the editor can offer to
      // price them rather than only report that something is unpriced.
      unpricedLines: unpricedIngredients(priced),
    };
  });

  app.get('/recipes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const recipe = recipeRepo.getRecipe(id);
    return recipe ?? reply.status(404).send({ error: 'Recipe not found' });
  });

  app.put('/recipes/:id', adminOnly, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(recipeSaveSchema, req.body, reply);
    if (!body) return;
    const saved = recipeRepo.updateRecipe(id, body.recipe, body.versionNote);
    if (!saved) return reply.status(404).send({ error: 'Recipe not found' });
    const active = repo.getActiveRecipe();
    if (active?.id === id) {
      repo.setActiveRecipe({
        ...active,
        name: saved.name,
        style: saved.style,
        abv: saved.abv,
        ibu: saved.ibu,
        ebc: saved.ebc,
      });
    }
    return saved;
  });

  app.delete('/recipes/:id', adminOnly, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!recipeRepo.deleteRecipe(id)) {
      return reply.status(404).send({ error: 'Recipe not found' });
    }
    if (repo.getActiveRecipe()?.id === id) repo.clearActiveRecipe();
    return reply.status(204).send();
  });

  // --- Brew sessions (the brewery's logbook) ----------------------------------
  // One row per batch, from "I'm brewing this" to packaged. Reads are open to
  // anyone who can see the recipes; writing to the log is an admin action.

  app.get('/brew-sessions', async () => brewSessions.listBrewSessions());

  // How often each recipe has been brewed, for the badges on the recipe grid.
  app.get('/brew-sessions/counts', async () => brewSessions.recipeBrewCounts());

  // The batches brewed from one recipe — the brew history on its sheet. Its own
  // route rather than filtering the whole log in the browser: a sheet wants the
  // handful of rows that belong to it, not every batch the brewery has logged.
  app.get('/recipes/:id/brew-sessions', async (req) => {
    const { id } = req.params as { id: string };
    return brewSessions.listRecipeBrewSessions(id);
  });

  /**
   * Start a brew session. The recipe is snapshotted onto the row as it reads today
   * (targets, cost, grain and hop weights), so the log stays truthful after the
   * recipe is edited, re-costed or deleted.
   *
   * Starting also puts the beer in the fermenter — the same selection the kiosk
   * card and the Recipes page show — because that is what pressing this button
   * means, and doing it by hand afterwards was only ever a second step.
   */
  app.post('/brew-sessions', adminOnly, async (req, reply) => {
    const body = parse(startBrewSessionSchema, req.body, reply);
    if (!body) return;
    const recipe = recipeRepo.getRecipe(body.recipeId);
    if (!recipe) return reply.status(404).send({ error: 'Recipe not found' });
    const brewSession = brewSessions.startBrewSession(body.recipeId, recipe, body.brewedAt);
    repo.setActiveRecipe({
      id: recipe.id,
      origin: recipe.origin,
      name: recipe.name,
      style: recipe.style,
      abv: recipe.abv,
      url: recipe.url,
      ibu: recipe.ibu,
      ebc: recipe.ebc,
    });
    // There's wort in it now, whatever it was before.
    repo.setFermenterState('dirty');
    return reply.status(201).send(brewSession);
  });

  app.get('/brew-sessions/:id', async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    const brewSession = brewSessions.getBrewSession(params.id);
    if (!brewSession) return reply.status(404).send({ error: 'Brew session not found' });
    return brewSession;
  });

  app.patch('/brew-sessions/:id', adminOnly, async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    const body = parse(updateBrewSessionSchema, req.body, reply);
    if (!body) return;
    const updated = brewSessions.updateBrewSession(params.id, body);
    if (!updated) return reply.status(404).send({ error: 'Brew session not found' });
    return updated;
  });

  app.delete('/brew-sessions/:id', adminOnly, async (req, reply) => {
    const params = parse(idParamSchema, req.params, reply);
    if (!params) return;
    if (!brewSessions.deleteBrewSession(params.id)) {
      return reply.status(404).send({ error: 'Brew session not found' });
    }
    return reply.status(204).send();
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

  // Whether the empty fermenter has been washed — the same clean/dirty question
  // the keg board asks of an emptied keg. Deliberately a separate resource from
  // the selection above: taking a beer out doesn't answer it, so clearing the
  // recipe leaves whatever was last recorded (null until someone says).
  app.get('/fermenter', async () => ({ state: repo.getFermenterState() }));

  app.put('/fermenter', adminOnly, async (req, reply) => {
    const body = parse(fermenterStateSchema, req.body, reply);
    if (!body) return;
    return { state: repo.setFermenterState(body.state) };
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
  // Operator-tunable alert preferences: which conditions raise an alert and at
  // what threshold. The background scheduler reads these; the Firebase
  // credentials that deliver them stay in env vars.
  app.get('/notifications/settings', async () => repo.getNotificationSettings());

  app.put('/notifications/settings', adminOnly, async (req, reply) => {
    const body = parse(notificationSettingsSchema, req.body, reply);
    if (!body) return;
    // Merged, not replaced: the critical-alert fields are optional so an older
    // app build can still save the settings it knows about (see the schema).
    return repo.setNotificationSettings({ ...repo.getNotificationSettings(), ...body });
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
  // The figures a blank brew sheet opens on. Readable by anyone who can see the
  // recipes; changing what every future recipe starts from is an admin action.
  app.get('/recipe-defaults', async () => repo.getRecipeDefaults());

  app.put('/recipe-defaults', adminOnly, async (req, reply) => {
    const body = parse(recipeDefaultsSchema, req.body, reply);
    if (!body) return;
    return repo.setRecipeDefaults(body);
  });

  app.get('/keg-content-colors', async () => repo.getKegContentColors());

  app.put('/keg-content-colors', adminOnly, async (req, reply) => {
    const body = parse(kegContentColorsSchema, req.body, reply);
    if (!body) return;
    return repo.setKegContentColors(body);
  });

  // Whether a notification would actually reach anyone, for the Settings page:
  // the hub needs Firebase credentials *and* at least one phone to have handed
  // over a token. Both can be missing independently, and the two failures need
  // different fixes, so they're reported separately rather than as one boolean.
  app.get('/notifications/status', async () => ({
    pushConfigured: pushConfigured(),
    registeredDevices: countPushTargets(),
  }));

  // Send a test push so the operator can confirm delivery from the UI. 503 when
  // there's nothing to deliver through (no Firebase key, or no phone
  // registered); 502 if every send failed.
  app.post('/notifications/test', adminOnly, async (req, reply) => {
    if (!pushConfigured()) {
      return reply
        .status(503)
        .send({ error: 'Push is not configured (set FCM_SERVICE_ACCOUNT_KEY_FILE on the server).' });
    }
    if (countPushTargets() === 0) {
      return reply
        .status(503)
        .send({ error: 'No phone has registered for notifications yet. Sign in to the app first.' });
    }
    const sent = await pushToEveryone(
      {
        title: 'BrewPlanner test',
        body: 'Notifications are wired up — this is what a brewery alert will look like.',
        path: '/alerts',
        critical: true,
        collapseKey: 'test',
      },
      req.log,
    );
    if (sent === 0) {
      return reply.status(502).send({ error: 'Firebase accepted nothing — check the server log.' });
    }
    return { sent: true, devices: sent };
  });

  // --- Push notifications (Android app) ---------------------------------
  // The app hands over its FCM token after signing in, and gives it back on
  // sign-out. Deliberately NOT adminOnly: a guest account may want to be told
  // what changed too, and receiving a notification grants nothing.
  //
  // The token is stored against the signed-in account, which is what lets the
  // hub leave the person who made a change out of the announcement — so a
  // request with no account behind it (the trusted-local kiosk, which has no
  // user) has nothing to attach and is refused rather than stored ownerless.
  app.post('/push/register', async (req, reply) => {
    const body = parse(pushTokenSchema, req.body, reply);
    if (!body) return;
    const user = getRequestUser(req);
    if (!user) return reply.status(401).send({ error: 'Sign in to receive notifications.' });
    registerPushToken(body.token, user.id);
    return { registered: true, configured: pushConfigured() };
  });

  app.post('/push/unregister', async (req, reply) => {
    const body = parse(pushTokenSchema, req.body, reply);
    if (!body) return;
    unregisterPushToken(body.token);
    return reply.status(204).send();
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

  // Vitals for the machines themselves (this Pi and the rig's), for the Devices
  // page. Session-gated rather than admin-only: it's the same "what's up right
  // now" glance as the device list it sits above. Cached server-side, so polling
  // it costs one SSH to the rig every 20s no matter how many tabs are open.
  app.get('/system/hosts', { preHandler: requireAuth }, async () => readHosts());

  // --- System / brew system update --------------------------------------
  // Same idea for the brewing rig: pull + rebuild + restart brew-system.service
  // on the other Pi over SSH. Refuses while the rig is heating or pumping —
  // the restart would cut the elements mid-brew. See
  // system/brewSystemUpdate.ts and deploy/update-brew-system.sh.
  app.post('/system/brew-system-update', adminOnly, async (req, reply) => {
    try {
      const status = await triggerBrewSystemUpdate();
      return reply.status(202).send(status);
    } catch (err) {
      if (err instanceof BrewSystemUpdateInProgressError) {
        return reply.status(409).send({ error: err.message });
      }
      if (err instanceof BrewSystemBusyError) {
        return reply.status(409).send({ error: err.message });
      }
      if (err instanceof BrewSystemUnreachableError) {
        return reply.status(502).send({ error: err.message });
      }
      if (err instanceof BrewSystemUnconfiguredError) {
        return reply.status(503).send({ error: err.message });
      }
      if (err instanceof BrewSystemUpdateUnsupportedError) {
        return reply.status(501).send({ error: err.message });
      }
      if (err instanceof BrewSystemUpdateScriptMissingError) {
        return reply.status(500).send({ error: err.message });
      }
      req.log.error(err, 'Failed to start brew system update');
      return reply
        .status(500)
        .send({ error: 'Could not start the rig update. Check the server logs.' });
    }
  });

  app.get('/system/brew-system-update/status', adminOnly, async () => readBrewSystemUpdateStatus());
}
