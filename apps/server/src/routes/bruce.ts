import type {
  BruceChatEvent,
  BruceChatModel,
  BruceChatReply,
  BruceChatState,
  BruceInstructions,
  BruceKnowledgeState,
  BrucePhaseName,
  BruceServiceStatus,
  BruceStatus,
  BruceVoiceSession,
  BruceVoiceToolResult,
} from '@checklist/shared';
import {
  bruceChatModelSchema,
  bruceChatSchema,
  bruceConversationSchema,
  bruceInstructionsSchema,
  bruceKnowledgeFileSchema,
  bruceReindexSchema,
  bruceSpeakSchema,
  bruceVoiceToolSchema,
  bruceVoiceTurnSchema,
  bruceVolumeSchema,
  bruceWebSearchSchema,
} from '@checklist/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { registerAuditHook } from '../audit/hook.js';
import { getSessionUser, requireAdmin, requireAuth } from '../auth/index.js';
import {
  answerQuestion,
  bruceInstructions,
  chatModel,
  listChatModels,
  setBruceInstructions,
  setChatModel,
  setWebSearchEnabled,
  summariseTitle,
  webSearchEnabled,
} from '../bruce/chat.js';
import {
  addMessage,
  clearMessages,
  conversationExists,
  createConversation,
  defaultConversation,
  deleteConversation,
  deleteMessage,
  isUntitled,
  listConversations,
  listMessages,
  renameConversation,
  titleFromFirstMessage,
  trimHistory,
} from '../bruce/repo.js';
import { mintVoiceSession, runVoiceTool, voiceToolDefinitions, voiceToolPhase } from '../bruce/voice.js';
import { BuildError } from '../knowledge/build.js';
import { chunkMarkdown } from '../knowledge/chunk.js';
import { indexJob, startIndexJob } from '../knowledge/job.js';
import {
  isReservedKnowledgeName,
  knowledgeStatus,
  readKnowledgeBook,
  writeKnowledgeFile,
} from '../knowledge/store.js';
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

/**
 * Body limit for a book upload. Fastify defaults to 1 MB for every route,
 * which is under the cap the schema allows (MAX_KNOWLEDGE_FILE_CHARS), so a
 * large book would be refused by the framework before the schema ever saw it.
 * Raised here only — the rest of the API has no reason to accept megabytes.
 */
const UPLOAD_BODY_LIMIT = 12 * 1024 * 1024;

/** The progress lines a stored tool call may name; anything else loses its icon. */
const PHASE_NAMES = ['library', 'thinking', 'web', 'recipes', 'brewery', 'writing'] as const;

function isPhaseName(value: string | undefined): value is BrucePhaseName {
  return value != null && (PHASE_NAMES as readonly string[]).includes(value);
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
      webSearch: webSearchEnabled(),
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

  // POST /api/bruce/chat/web-search — let Bruce off the shelf, or put him back.
  // Admin-only like the model choice: it changes what every later question
  // costs, and where its answers can come from.
  app.post('/chat/web-search', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parse(bruceWebSearchSchema, req.body, reply);
    if (!body) return;
    setWebSearchEnabled(body.enabled);
    return { enabled: webSearchEnabled() };
  });

  // POST /api/bruce/chat — ask Bruce a question. Admin-only: every call costs
  // OpenAI credit, and guests are read-only everywhere else in the dashboard.
  //
  // Answers as a server-sent event stream rather than one JSON body. Not to
  // stream the prose — the answer still arrives whole, in the final `done`
  // event — but to say what he is *doing* while he does it. A question that
  // sends him to the web takes noticeably longer than one the books answer, and
  // before this the page could only guess which was happening; now the phases
  // come from the model's own tool calls (see bruce/chat.ts).
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

    // Everything that could fail with a status code has now been checked, so
    // the response can commit to being a stream. After this point a failure is
    // an `error` event, not an HTTP status — the headers are long gone.
    //
    // `hijack` hands the socket over: Fastify stops expecting the handler to
    // return a body, and stops trying to serialise one. Everything from here is
    // written by hand and ended in the `finally`.
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx and friends buffer event streams by default, which would hold
      // every phase back until the answer landed and defeat the point.
      'X-Accel-Buffering': 'no',
    });

    const send = (event: BruceChatEvent): void => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // The question is stored first so history is right for the model, then
    // rolled back if the answer fails: a thread ending in an unanswered
    // question would poison every following turn's context.
    const history = listMessages(conversationId);
    const question = addMessage(conversationId, 'user', body.message);

    // Naming a still-unnamed thread runs *beside* the answer, not after it: it
    // is a second (small) round trip, and sequenced it would add its latency to
    // every first question. Started before the await below, collected after,
    // by which time the much longer answer call has covered it.
    const title = isUntitled(conversationId) ? summariseTitle(body.message) : null;

    // Bruce's tools can change the hub (to-dos, settings, the fermenter), and
    // the audit hook can't see them: this route answers as a hijacked stream, so
    // `onResponse` never fires for it. The tools record their own entries
    // instead, against whoever asked — a change made through the chat is that
    // account's change, not the assistant's. `requireAdmin` has already run, so
    // no session here means the trusted-local kiosk.
    const sessionUser = getSessionUser(req);
    const actor = sessionUser
      ? { userId: sessionUser.id, username: sessionUser.username }
      : { userId: null, username: 'Local kiosk' };

    try {
      const answer = await answerQuestion(
        body.message,
        history,
        (phase) => send({ type: 'phase', ...phase }),
        actor,
        // Each tool as it finishes, so the page can show the call as its own
        // entry while the answer is still being written. The same records are
        // stored below, so a reload shows what the live view showed.
        (call) => send({ type: 'tool', ...call }),
      );
      const stored = addMessage(
        conversationId,
        'assistant',
        answer.text,
        answer.sources,
        answer.costUsd,
        answer.toolCalls,
      );
      // Name the thread after what it turned out to be about. Only takes
      // effect on an untitled thread, so a rename is never clobbered.
      titleFromFirstMessage(conversationId, body.message, await title);
      trimHistory(conversationId);
      const conversation = listConversations().find((c) => c.id === conversationId);
      if (!conversation) throw new Error('Conversation vanished mid-answer.');
      send({ type: 'done', reply: { question, answer: stored, conversation } satisfies BruceChatReply });
    } catch (err) {
      deleteMessage(question.id);
      req.log.error({ err }, 'Bruce chat failed');
      send({ type: 'error', message: err instanceof Error ? err.message : 'Bruce could not answer that.' });
    } finally {
      reply.raw.end();
    }
  });

  // --- Voice, in a browser -------------------------------------------------
  // The phone-and-laptop way in, beside the brewery speaker and the written
  // chat. The audio itself never comes through here: the browser holds a WebRTC
  // session straight to OpenAI (see bruce/voice.ts for why), and these three
  // endpoints are the parts a browser must not be trusted with — the
  // credential, the tools, and writing the conversation down.

  // POST /api/bruce/voice/session — mint a short-lived credential for one call.
  // Admin-only, like the written chat: a Realtime session is billed by the
  // minute and can change the brewery.
  app.post('/voice/session', { preHandler: requireAdmin }, async (req, reply): Promise<BruceVoiceSession | void> => {
    if (!isOpenAIConfigured()) {
      return reply
        .status(503)
        .send({ error: 'OPENAI_API_KEY is not set on the server — Bruce cannot talk.' });
    }
    try {
      return await mintVoiceSession();
    } catch (err) {
      req.log.error({ err }, 'Could not mint a Bruce voice session');
      return reply
        .status(502)
        .send({ error: 'OpenAI would not open a voice session. Check the server log.' });
    }
  });

  // GET /api/bruce/voice/tools — the tool definitions themselves.
  //
  // The browser never needs this: its session is opened with the tools already
  // baked into the credential above. It exists for the brewery speaker
  // (apps/bruce), which builds its own Realtime session on the Pi and used to
  // carry a second, hand-maintained copy of every tool. It fetches this list at
  // startup instead, so a tool added here reaches all three Bruces at once.
  app.get('/voice/tools', { preHandler: requireAuth }, async () => {
    return { tools: voiceToolDefinitions() };
  });

  // POST /api/bruce/voice/tool — run one function call the model made in the
  // browser. The same tools the written chat uses, run here against the hub's
  // database and audited against whoever is logged in: a fermenter changed by
  // voice is that account's change, not the assistant's. Nothing about a
  // browser session gets its own privileges — `requireAdmin` has already run,
  // and no session here means the trusted-local kiosk, as everywhere else.
  app.post('/voice/tool', { preHandler: requireAdmin }, async (req, reply): Promise<BruceVoiceToolResult | void> => {
    const body = parse(bruceVoiceToolSchema, req.body, reply);
    if (!body) return;
    const sessionUser = getSessionUser(req);
    const actor = sessionUser
      ? { userId: sessionUser.id, username: sessionUser.username }
      : { userId: null, username: 'Local kiosk' };
    const args = body.args ?? {};
    const phase = voiceToolPhase(body.name, args);
    return {
      output: await runVoiceTool(body.name, args, actor),
      ...(phase ? { phase } : {}),
    };
  });

  // POST /api/bruce/voice/turn — write one finished spoken exchange into a
  // chat thread, so a question asked out loud can be scrolled back to and
  // followed up in writing.
  //
  // Saved per turn rather than at the end of the call: a call ends as often by
  // a phone locking or a tab closing as by the button, and a whole conversation
  // that only existed in a closed tab is a conversation lost. There is no cost
  // to record — the audio was billed directly to the OpenAI account by the
  // browser's own session, and never passed through this server to be counted.
  app.post('/voice/turn', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parse(bruceVoiceTurnSchema, req.body, reply);
    if (!body) return;
    const conversationId = body.conversationId ?? defaultConversation().id;
    if (!conversationExists(conversationId)) {
      return reply.status(404).send({ error: 'That conversation no longer exists.' });
    }
    const question = addMessage(conversationId, 'user', body.question);
    // The browser reports which tools its session called; they are stored on the
    // answer exactly as a typed turn's are, so the thread reads the same however
    // the question was asked. `phase` is narrowed here rather than in the schema
    // — an unknown one from a future client should cost the icon, not the entry.
    const answer = addMessage(conversationId, 'assistant', body.answer, undefined, null, body.toolCalls?.map(
      (call) => ({
        name: call.name,
        ...(isPhaseName(call.phase) ? { phase: call.phase } : {}),
        ...(call.detail ? { detail: call.detail } : {}),
        ...(call.args ? { args: call.args } : {}),
        ...(call.result ? { result: call.result } : {}),
      }),
    ));
    titleFromFirstMessage(conversationId, body.question, await summariseTitle(body.question));
    trimHistory(conversationId);
    const conversation = listConversations().find((c) => c.id === conversationId);
    if (!conversation) return reply.status(404).send({ error: 'That conversation no longer exists.' });
    return { question, answer, conversation } satisfies BruceChatReply;
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

  // --- The library ---------------------------------------------------------
  // Putting a book on Bruce's shelf used to mean an SSH session on the Pi: scp
  // the markdown into knowledge/, then `npm run knowledge` with the API key
  // loaded by hand. Same for his instructions, which are a file in that folder
  // too. These four endpoints are that work, from the dashboard.

  /** Kick off a rebuild, turning a BuildError into a 400 the page can show. */
  const startRebuild = async (
    options: { force?: boolean; note?: string },
    reply: FastifyReply,
  ): Promise<BruceKnowledgeState | void> => {
    try {
      const job = startIndexJob(options);
      return { knowledge: knowledgeStatus(), job, configured: isOpenAIConfigured() };
    } catch (err) {
      if (err instanceof BuildError) return reply.status(400).send({ error: err.message });
      throw err;
    }
  };

  // GET /api/bruce/knowledge — what's on the shelf, plus any rebuild in flight.
  // Polled by the page's library card while a job runs.
  app.get('/knowledge', { preHandler: requireAuth }, async (): Promise<BruceKnowledgeState> => {
    return { knowledge: knowledgeStatus(), job: indexJob(), configured: isOpenAIConfigured() };
  });

  // GET /api/bruce/knowledge/files/:file?chapter=N — read a book on the shelf.
  // Registered after the POST above, and distinct from it by method. A chapter
  // at a time: see readKnowledgeBook for why the whole file doesn't travel.
  app.get('/knowledge/files/:file', { preHandler: requireAuth }, async (req, reply) => {
    const { file } = req.params as { file: string };
    const wanted = Number((req.query as { chapter?: string })?.chapter);
    const book = readKnowledgeBook(file, Number.isInteger(wanted) ? wanted : undefined);
    if (!book) return reply.status(404).send({ error: 'No such book in the library.' });
    return book;
  });

  // POST /api/bruce/knowledge/files — upload a book and index it. Admin-only:
  // it writes to disk and then spends OpenAI credit embedding what it wrote.
  app.post(
    '/knowledge/files',
    { preHandler: requireAdmin, bodyLimit: UPLOAD_BODY_LIMIT },
    async (req, reply) => {
      const body = parse(bruceKnowledgeFileSchema, req.body, reply);
      if (!body) return;
      if (isReservedKnowledgeName(body.file)) {
        return reply.status(400).send({
          error: `${body.file} is a reserved name — PROMPT.md holds Bruce's instructions and README.md documents the folder.`,
        });
      }
      // Chunk it before it touches the disk. A file that produces no passages
      // (too short, or a table of contents rather than prose) would otherwise
      // sit in knowledge/ nagging "1 new file not indexed" after every build.
      if (chunkMarkdown(body.file, body.content).length === 0) {
        return reply.status(400).send({
          error: `There is nothing to index in ${body.file} — Bruce needs markdown prose, and very short files are skipped.`,
        });
      }
      try {
        writeKnowledgeFile(body.file, body.content);
      } catch (err) {
        req.log.error({ err }, 'Could not save an uploaded book');
        return reply.status(500).send({ error: 'Could not save the file into knowledge/.' });
      }
      // Index it straight away: a book on disk that nothing embedded answers
      // no questions, and needing a second button for that is a trap.
      return startRebuild({ note: body.file }, reply);
    },
  );

  // POST /api/bruce/knowledge/reindex — rebuild after editing files by hand, or
  // when the page reports the index is stale. `force` re-embeds everything.
  app.post('/knowledge/reindex', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parse(bruceReindexSchema, req.body ?? {}, reply);
    if (!body) return;
    return startRebuild({ ...(body.force ? { force: true } : {}) }, reply);
  });

  // GET /api/bruce/instructions — the persona in use, and the built-in one.
  app.get('/instructions', { preHandler: requireAuth }, async (): Promise<BruceInstructions> => {
    return bruceInstructions();
  });

  // PUT /api/bruce/instructions — rewrite knowledge/PROMPT.md. Empty text
  // deletes it, which is how you go back to the built-in persona.
  app.put('/instructions', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parse(bruceInstructionsSchema, req.body, reply);
    if (!body) return;
    try {
      return setBruceInstructions(body.text);
    } catch (err) {
      req.log.error({ err }, 'Could not save Bruce instructions');
      return reply.status(500).send({ error: 'Could not write knowledge/PROMPT.md.' });
    }
  });
}
