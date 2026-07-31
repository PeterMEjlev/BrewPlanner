import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

/**
 * The browser voice endpoints (routes/bruce.ts `/voice/*`), through
 * `app.inject()`.
 *
 * The session itself is not testable here and is not the risk: it is one POST
 * to OpenAI, and the audio never touches this server. What is worth pinning is
 * everything around it, because a browser is now holding one end of the
 * conversation:
 *
 *   - the three endpoints sit behind the same auth boundary as the rest of the
 *     API, so a session credential can't be minted from the open internet
 *   - a tool call arriving from a browser runs the *same* tools as the written
 *     chat, and leaves the same audit entry naming who asked — a fermenter
 *     changed by voice must be as attributable as one changed by typing
 *   - a spoken exchange lands in the thread as an ordinary pair of messages
 *
 * DATABASE_PATH must be set before the db module loads, hence dynamic imports.
 */

const dir = mkdtempSync(join(tmpdir(), 'brewplanner-brucevoice-'));
process.env.DATABASE_PATH = join(dir, 'test.sqlite');
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-be-accepted';
process.env.ADMIN_PASSWORD = 'test-admin-password';

/** Headers Cloudflare adds, which mark a request as *not* trusted-local. */
const REMOTE = { 'cf-connecting-ip': '203.0.113.7', 'cf-ray': 'test-ray' };

let app: FastifyInstance;
let sqlite: import('better-sqlite3').Database;
let audit: typeof import('./audit/repo.js');
let repo: typeof import('./repo.js');
let bruceRepo: typeof import('./bruce/repo.js');

before(async () => {
  const { buildApp } = await import('./app.js');
  sqlite = (await import('./db/index.js')).sqlite;
  audit = await import('./audit/repo.js');
  repo = await import('./repo.js');
  bruceRepo = await import('./bruce/repo.js');
  app = await buildApp({ logger: false });
  await app.ready();
  // After the imports, because loading the app loads a developer's .env with
  // it. Nothing here may reach OpenAI: minting a session must fail on the
  // missing key, and the turn endpoint's title summariser must stay offline.
  // The key is read per call, so removing it now is enough.
  delete process.env.OPENAI_API_KEY;
});

after(async () => {
  await app.close();
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/bruce/voice/session', () => {
  it('refuses to mint a credential for an anonymous remote caller', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/bruce/voice/session', headers: REMOTE });
    assert.equal(res.statusCode, 401);
  });

  it('says so plainly when the server has no OpenAI key', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/bruce/voice/session' });
    assert.equal(res.statusCode, 503);
    assert.match(res.json().error, /OPENAI_API_KEY/);
  });
});

describe('the tool list a voice session is opened with', () => {
  it('carries only the fields the Realtime API accepts', async () => {
    const { voiceToolDefinitions } = await import('./bruce/voice.js');
    const definitions = voiceToolDefinitions() as Record<string, unknown>[];

    // The written chat's definitions are written for the Responses API, which
    // takes fields Realtime does not — `get_recipe` has `strict: true`. One of
    // those reaching OpenAI is not a degraded tool: the session is refused
    // ("Unknown parameter: session.tools[1].strict") and the Talk button dies.
    const allowed = new Set(['type', 'name', 'description', 'parameters']);
    for (const definition of definitions) {
      const extra = Object.keys(definition).filter((key) => !allowed.has(key));
      assert.deepEqual(extra, [], `${String(definition.name)} carries ${extra.join(', ')}`);
      assert.equal(definition.type, 'function');
      assert.ok(definition.name);
    }
    // The books, and the same brewery tools the written chat has.
    assert.ok(definitions.some((d) => d.name === 'search_library'));
    assert.ok(definitions.some((d) => d.name === 'get_brewery_status'));
  });
});

describe('POST /api/bruce/voice/tool', () => {
  it('is closed to anonymous remote callers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/bruce/voice/tool',
      headers: REMOTE,
      payload: { name: 'get_todos', args: {} },
    });
    assert.equal(res.statusCode, 401);
  });

  it('rejects a call with no tool name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/bruce/voice/tool',
      payload: { args: {} },
    });
    assert.equal(res.statusCode, 400);
  });

  it('runs a read tool and reports the phase to show while it ran', async () => {
    repo.createTodo('Swap the CO2 bottle');
    const before = audit.listAudit(1)[0]?.id ?? 0;
    const res = await app.inject({
      method: 'POST',
      url: '/api/bruce/voice/tool',
      payload: { name: 'get_todos', args: {} },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.match(body.output, /Swap the CO2 bottle/);
    assert.equal(body.phase.phase, 'brewery');
    // Reading is not a change. Without the audit hook's opt-out every glance at
    // the to-do list mid-conversation would land in the change history.
    assert.equal(audit.listAudit(1)[0]?.id ?? 0, before);
  });

  it('audits a change made by voice, naming who asked', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/bruce/voice/tool',
      payload: { name: 'manage_todo', args: { action: 'add', text: 'Order more grain' } },
    });
    assert.equal(res.statusCode, 200);
    const entry = audit.listAudit(1)[0];
    assert.match(entry?.action ?? '', /Order more grain/);
    // No session on a LAN request: the kiosk is who asked, and it is named.
    assert.equal(entry?.username, 'Local kiosk');
  });

  it('tells the model an invented tool does not exist rather than failing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/bruce/voice/tool',
      payload: { name: 'open_the_pod_bay_doors', args: {} },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.json().output, /no tool called/i);
  });
});

describe('POST /api/bruce/voice/turn', () => {
  it('writes a spoken exchange into the thread as a pair of messages', async () => {
    const conversation = bruceRepo.createConversation();
    const res = await app.inject({
      method: 'POST',
      url: '/api/bruce/voice/turn',
      payload: {
        conversationId: conversation.id,
        question: 'What is in the fermenter?',
        answer: 'A saison, four days in and sitting at twenty two degrees.',
      },
    });
    assert.equal(res.statusCode, 200);

    const messages = bruceRepo.listMessages(conversation.id);
    assert.equal(messages.length, 2);
    assert.deepEqual(
      messages.map((m) => m.role),
      ['user', 'assistant'],
    );
    assert.equal(messages[0]?.content, 'What is in the fermenter?');
  });

  it('records the tools a spoken turn used, and drops an unknown phase without losing the entry', async () => {
    const conversation = bruceRepo.createConversation();
    const res = await app.inject({
      method: 'POST',
      url: '/api/bruce/voice/turn',
      payload: {
        conversationId: conversation.id,
        question: 'Tick off the CO2 job',
        answer: 'Done — ticked off order more CO2.',
        toolCalls: [
          {
            name: 'manage_todo',
            phase: 'brewery',
            detail: 'to-do list',
            args: { action: 'complete', text: 'order more CO2' },
            result: 'Completed "Order more CO2".',
          },
          // A phase this server has never heard of — from a newer client, say.
          // The call is still worth recording; only its icon is unknown.
          { name: 'invented_later', phase: 'astrology' },
        ],
      },
    });
    assert.equal(res.statusCode, 200);

    const [, answer] = bruceRepo.listMessages(conversation.id);
    assert.equal(answer?.toolCalls?.length, 2);
    assert.equal(answer?.toolCalls?.[0]?.name, 'manage_todo');
    assert.equal(answer?.toolCalls?.[0]?.phase, 'brewery');
    assert.deepEqual(answer?.toolCalls?.[0]?.args, { action: 'complete', text: 'order more CO2' });
    assert.equal(answer?.toolCalls?.[1]?.name, 'invented_later');
    assert.equal(answer?.toolCalls?.[1]?.phase, undefined);
  });

  it('keeps the answer when its tool record is unreadable', () => {
    const conversation = bruceRepo.createConversation();
    const answer = bruceRepo.addMessage(conversation.id, 'assistant', 'Twenty degrees.', undefined, null, [
      { name: 'get_brewery_status' },
    ]);
    // Corrupt the record the way a half-written row or an older format would.
    sqlite.prepare('UPDATE bruce_messages SET tool_calls = ? WHERE id = ?').run('{not json', answer.id);

    const [stored] = bruceRepo.listMessages(conversation.id);
    assert.equal(stored?.content, 'Twenty degrees.');
    assert.equal(stored?.toolCalls, undefined, 'the entries are lost, the answer is not');
  });

  it('404s a thread that has since been deleted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/bruce/voice/turn',
      payload: { conversationId: 99999, question: 'Hello?', answer: 'Nobody home.' },
    });
    assert.equal(res.statusCode, 404);
  });
});
