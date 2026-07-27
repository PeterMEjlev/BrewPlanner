import type {
  BruceChatModel,
  BruceChatReply,
  BruceChatState,
  BruceServiceStatus,
  BruceStatus,
} from '@checklist/shared';
import {
  bruceChatModelSchema,
  bruceChatSchema,
  bruceConversationSchema,
  bruceSpeakSchema,
  bruceVolumeSchema,
} from '@checklist/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { registerAuditHook } from '../audit/hook.js';
import { requireAdmin, requireAuth } from '../auth/index.js';
import { answerQuestion, chatModel, listChatModels, setChatModel } from '../bruce/chat.js';
import {
  addMessage,
  clearMessages,
  conversationExists,
  createConversation,
  defaultConversation,
  deleteConversation,
  deleteMessage,
  listConversations,
  listMessages,
  renameConversation,
  titleFromFirstMessage,
  trimHistory,
} from '../bruce/repo.js';
import { knowledgeStatus } from '../knowledge/store.js';
import { isOpenAIConfigured } from '../openai.js';

/**
 * The Bruce page's two halves.
 *
 * `/status`, `/speak` and `/volume` proxy the voice assistant (apps/bruce),
 * which runs as its own service on this Pi behind a loopback-only API. Same
 * shape as the brew-rig proxy: reads need a session (or trusted-local),
 * controls need admin, and only the endpoints named here are forwarded. Bruce
 * being down is an expected state (service not enabled yet, or restarting) —
 * status answers `{ online: false }` and the dashboard shows him as offline.
 *
 * `/chat` is the text conversation, and deliberately does NOT go through that
 * proxy: it is answered here in the server from the indexed brewing books (see
 * bruce/chat.ts), so it works with no microphone, no speaker, and bruce.service
 * stopped.
 */

/** Bruce's loopback API; override with BRUCE_STATUS_URL if he runs elsewhere. */
function bruceBase(): string {
  const url = process.env.BRUCE_STATUS_URL?.trim().replace(/\/+$/, '');
  return url || 'http://127.0.0.1:3555';
}

/** Loopback answers in microseconds; anything slower means the service is down. */
const BRUCE_TIMEOUT_MS = 2000;

/** Parse with a Zod schema, replying 400 on failure. Returns null when invalid. */
function parse<T>(schema: z.ZodType<T>, data: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    reply.status(400).send({ error: 'Validation failed', issues: result.error.issues });
    return null;
  }
  return result.data;
}

/** Forward a control command; 502 with a friendly message when Bruce is down. */
async function brucePost(reply: FastifyReply, path: string, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${bruceBase()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BRUCE_TIMEOUT_MS),
    });
  } catch {
    return reply.status(502).send({ error: 'Bruce is not running (is bruce.service enabled?)' });
  }
  if (!res.ok) {
    let detail = `Bruce rejected the command (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (typeof data?.error === 'string') detail = data.error;
    } catch {
      /* keep the generic message */
    }
    return reply.status(502).send({ error: detail });
  }
  return await res.json();
}

export async function bruceRoutes(app: FastifyInstance): Promise<void> {
  registerAuditHook(app);

  // GET /api/bruce/status — live state + transcript, wrapped in an
  // availability envelope. Polled by the dashboard's Bruce page, so a down
  // service must be cheap and silent.
  app.get('/status', { preHandler: requireAuth }, async (): Promise<BruceServiceStatus> => {
    try {
      const res = await fetch(`${bruceBase()}/status`, {
        signal: AbortSignal.timeout(BRUCE_TIMEOUT_MS),
      });
      if (!res.ok) return { online: false };
      const status = (await res.json()) as BruceStatus;
      return { online: true, ...status };
    } catch {
      return { online: false };
    }
  });

  // POST /api/bruce/speak — make Bruce say a message out loud in the brewery.
  app.post('/speak', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parse(bruceSpeakSchema, req.body, reply);
    if (!body) return;
    return brucePost(reply, '/speak', body);
  });

  // POST /api/bruce/volume — set Bruce's speech volume (0–200 %).
  app.post('/volume', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parse(bruceVolumeSchema, req.body, reply);
    if (!body) return;
    return brucePost(reply, '/volume', body);
  });

  // GET /api/bruce/chat — the conversation so far, plus enough about the
  // server's own setup (key present? books indexed?) for the page to explain
  // itself instead of just failing when someone types.
  app.get('/chat', { preHandler: requireAuth }, async (req, reply): Promise<BruceChatState | void> => {
    // The model list is a nicety for the picker; a slow or failing lookup must
    // never stop the conversation from loading.
    let models: BruceChatModel[] = [];
    try {
      models = await listChatModels();
    } catch (err) {
      req.log.warn({ err }, 'Could not list OpenAI models');
    }

    // ?conversation=<id> picks a thread; without it the newest is shown (and
    // created on a brand-new install, so the page always has one to render).
    const wanted = Number((req.query as { conversation?: string })?.conversation);
    let conversation = defaultConversation();
    if (Number.isInteger(wanted) && wanted > 0) {
      if (!conversationExists(wanted)) {
        return reply.status(404).send({ error: 'That conversation no longer exists.' });
      }
      conversation = listConversations().find((c) => c.id === wanted) ?? conversation;
    }

    return {
      conversation,
      conversations: listConversations(),
      messages: listMessages(conversation.id),
      knowledge: knowledgeStatus(),
      configured: isOpenAIConfigured(),
      model: chatModel(),
      models,
    };
  });

  // POST /api/bruce/chat/conversations — start a new thread.
  app.post('/chat/conversations', { preHandler: requireAdmin }, async () => {
    return createConversation();
  });

  // PATCH /api/bruce/chat/conversations/:id — rename a thread.
  app.patch('/chat/conversations/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || !conversationExists(id)) {
      return reply.status(404).send({ error: 'Conversation not found' });
    }
    const body = parse(bruceConversationSchema, req.body, reply);
    if (!body) return;
    renameConversation(id, body.title);
    return listConversations().find((c) => c.id === id);
  });

  // DELETE /api/bruce/chat/conversations/:id — delete a thread and its turns.
  app.delete('/chat/conversations/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || !conversationExists(id)) {
      return reply.status(404).send({ error: 'Conversation not found' });
    }
    deleteConversation(id);
    return reply.status(204).send();
  });

  // POST /api/bruce/chat/model — choose which model answers. Stored in
  // settings, so it survives restarts and overrides BRUCE_CHAT_MODEL.
  app.post('/chat/model', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parse(bruceChatModelSchema, req.body, reply);
    if (!body) return;
    setChatModel(body.model);
    return { model: chatModel() };
  });

  // POST /api/bruce/chat — ask Bruce a question. Admin-only: every call costs
  // OpenAI credit, and guests are read-only everywhere else in the dashboard.
  app.post('/chat', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parse(bruceChatSchema, req.body, reply);
    if (!body) return;

    if (!isOpenAIConfigured()) {
      return reply
        .status(503)
        .send({ error: 'OPENAI_API_KEY is not set on the server — Bruce cannot answer.' });
    }

    const conversationId = body.conversationId ?? defaultConversation().id;
    if (!conversationExists(conversationId)) {
      return reply.status(404).send({ error: 'That conversation no longer exists.' });
    }

    // The question is stored first so history is right for the model, then
    // rolled back if the answer fails: a thread ending in an unanswered
    // question would poison every following turn's context.
    const history = listMessages(conversationId);
    const question = addMessage(conversationId, 'user', body.message);
    try {
      const answer = await answerQuestion(body.message, history);
      const stored = addMessage(conversationId, 'assistant', answer.text, answer.sources);
      // Name the thread after what it turned out to be about. Only takes
      // effect on an untitled thread, so a rename is never clobbered.
      titleFromFirstMessage(conversationId, body.message);
      trimHistory(conversationId);
      const conversation = listConversations().find((c) => c.id === conversationId);
      if (!conversation) throw new Error('Conversation vanished mid-answer.');
      return { question, answer: stored, conversation } satisfies BruceChatReply;
    } catch (err) {
      deleteMessage(question.id);
      req.log.error({ err }, 'Bruce chat failed');
      const message = err instanceof Error ? err.message : 'Bruce could not answer that.';
      return reply.status(502).send({ error: message });
    }
  });

  // DELETE /api/bruce/chat?conversation=<id> — empty a thread without deleting
  // it (the page's "Clear" button); use the conversations route to remove one.
  app.delete('/chat', { preHandler: requireAdmin }, async (req, reply) => {
    const wanted = Number((req.query as { conversation?: string })?.conversation);
    const conversationId = Number.isInteger(wanted) && wanted > 0 ? wanted : defaultConversation().id;
    if (!conversationExists(conversationId)) {
      return reply.status(404).send({ error: 'That conversation no longer exists.' });
    }
    clearMessages(conversationId);
    return reply.status(204).send();
  });
}
