import type {
  BruceChatMessage,
  BruceChatSource,
  BruceConversation,
  BruceToolCall,
} from '@checklist/shared';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bruceConversations, bruceMessages } from '../db/schema.js';

/**
 * Persistence for Bruce's text chat: threads (`bruce_conversations`) and the
 * turns inside them (`bruce_messages`).
 *
 * Threads are shared, not per-account — this is one brewery with a kiosk and a
 * couple of logins, and a question asked on the phone should still be there on
 * the kiosk. Old turns are trimmed per thread on write so the table can't grow
 * without bound on the Pi's SD card.
 */

/**
 * Turns kept per thread. 200 is a long conversation and comfortably under a
 * megabyte, while leaving plenty of history for follow-up questions.
 */
const MAX_MESSAGES_PER_CONVERSATION = 200;

/** Longest auto-generated title before it is cut at a word boundary. */
const TITLE_MAX = 60;

function toPublicMessage(row: typeof bruceMessages.$inferSelect): BruceChatMessage {
  let sources: BruceChatSource[] | undefined;
  if (row.sources) {
    try {
      const parsed = JSON.parse(row.sources) as BruceChatSource[];
      if (Array.isArray(parsed) && parsed.length > 0) sources = parsed;
    } catch {
      // A malformed citation list costs the chips, not the message.
    }
  }
  let toolCalls: BruceToolCall[] | undefined;
  if (row.toolCalls) {
    try {
      const parsed = JSON.parse(row.toolCalls) as BruceToolCall[];
      if (Array.isArray(parsed) && parsed.length > 0) toolCalls = parsed;
    } catch {
      // Same bargain as the citations: a bad record loses its own entries, not
      // the answer it belongs to.
    }
  }
  return {
    id: row.id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    ...(sources ? { sources } : {}),
    ...(toolCalls ? { toolCalls } : {}),
    createdAt: row.createdAt,
  };
}

// --- Threads ----------------------------------------------------------------

/** Every thread, most recently used first, with a count and running cost. */
export function listConversations(): BruceConversation[] {
  const totals = db
    .select({
      id: bruceMessages.conversationId,
      n: sql<number>`count(*)`,
      // SUM over all-null costs is null, which is the answer we want: a thread
      // whose turns predate cost tracking has an unknown cost, not a zero one.
      cost: sql<number | null>`sum(${bruceMessages.costUsd})`,
    })
    .from(bruceMessages)
    .groupBy(bruceMessages.conversationId)
    .all();
  const byId = new Map(totals.map((t) => [t.id, t]));

  return db
    .select()
    .from(bruceConversations)
    .orderBy(desc(bruceConversations.updatedAt), desc(bruceConversations.id))
    .all()
    .map((row) => {
      const total = byId.get(row.id);
      return {
        id: row.id,
        title: row.title,
        messages: total?.n ?? 0,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(total?.cost != null ? { costUsd: total.cost } : {}),
      };
    });
}

export function createConversation(title = 'New chat'): BruceConversation {
  const row = db.insert(bruceConversations).values({ title: title.trim() || 'New chat' }).returning().get();
  return { id: row.id, title: row.title, messages: 0, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export function conversationExists(id: number): boolean {
  return db.select({ id: bruceConversations.id }).from(bruceConversations).where(eq(bruceConversations.id, id)).get() != null;
}

export function renameConversation(id: number, title: string): void {
  db.update(bruceConversations)
    .set({ title: title.trim() || 'Untitled', updatedAt: sql`(CURRENT_TIMESTAMP)` })
    .where(eq(bruceConversations.id, id))
    .run();
}

/** Delete a thread. Its messages go with it (ON DELETE CASCADE). */
export function deleteConversation(id: number): void {
  db.delete(bruceConversations).where(eq(bruceConversations.id, id)).run();
}

/**
 * The thread to show when the page opens without naming one: the most recently
 * used, or a fresh one when the brewery has never chatted before. Always
 * returns something, so the page never has to handle "no thread yet".
 */
export function defaultConversation(): BruceConversation {
  const [newest] = listConversations();
  return newest ?? createConversation('New chat');
}

/** True while a thread still carries the placeholder name. */
export function isUntitled(id: number): boolean {
  const row = db.select().from(bruceConversations).where(eq(bruceConversations.id, id)).get();
  return row?.title === 'New chat';
}

/**
 * Name a thread after what it is about — "Mash pH for a pale ale" beats five
 * rows of "New chat". Only applied while the title is still the placeholder,
 * so a rename is never overwritten.
 *
 * `summary` is the short label the model wrote for the question (see
 * summariseTitle in chat.ts); the question itself is the fallback for when
 * that couldn't be had, trimmed to fit the thread list.
 */
export function titleFromFirstMessage(id: number, question: string, summary?: string | null): void {
  if (!isUntitled(id)) return;

  const clean = (summary?.trim() || question).replace(/\s+/g, ' ').trim();
  let title = clean;
  if (clean.length > TITLE_MAX) {
    const cut = clean.slice(0, TITLE_MAX);
    const lastSpace = cut.lastIndexOf(' ');
    title = `${(lastSpace > TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut).trim()}…`;
  }
  db.update(bruceConversations).set({ title }).where(eq(bruceConversations.id, id)).run();
}

// --- Turns ------------------------------------------------------------------

/** One thread's messages, oldest first. */
export function listMessages(conversationId: number, limit = MAX_MESSAGES_PER_CONVERSATION): BruceChatMessage[] {
  return db
    .select()
    .from(bruceMessages)
    .where(eq(bruceMessages.conversationId, conversationId))
    .orderBy(asc(bruceMessages.id))
    .limit(limit)
    .all()
    .map(toPublicMessage);
}

/**
 * Append one turn and bump the thread's activity time.
 *
 * `costUsd` is what that answer is estimated to have cost (see bruce/cost.ts);
 * pass it only on assistant turns, and leave it out when the answer could not
 * be priced so the thread's total stays honest about what it doesn't know.
 */
export function addMessage(
  conversationId: number,
  role: 'user' | 'assistant',
  content: string,
  sources?: BruceChatSource[],
  costUsd?: number | null,
  toolCalls?: BruceToolCall[],
): BruceChatMessage {
  const row = db
    .insert(bruceMessages)
    .values({
      conversationId,
      role,
      content,
      sources: sources && sources.length > 0 ? JSON.stringify(sources) : null,
      costUsd: costUsd ?? null,
      toolCalls: toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
    })
    .returning()
    .get();
  db.update(bruceConversations)
    .set({ updatedAt: sql`(CURRENT_TIMESTAMP)` })
    .where(eq(bruceConversations.id, conversationId))
    .run();
  return toPublicMessage(row);
}

/**
 * Drop everything past the newest MAX_MESSAGES_PER_CONVERSATION turns in this
 * thread. Called after a successful exchange rather than on a timer — a thread
 * only grows when someone is chatting in it.
 */
export function trimHistory(conversationId: number): void {
  const cutoff = db
    .select({ id: bruceMessages.id })
    .from(bruceMessages)
    .where(eq(bruceMessages.conversationId, conversationId))
    .orderBy(desc(bruceMessages.id))
    .limit(1)
    .offset(MAX_MESSAGES_PER_CONVERSATION - 1)
    .get();
  if (!cutoff) return;
  db.delete(bruceMessages)
    .where(sql`${bruceMessages.conversationId} = ${conversationId} AND ${bruceMessages.id} < ${cutoff.id}`)
    .run();
}

/** Empty one thread without deleting it (the page's "Clear" button). */
export function clearMessages(conversationId: number): void {
  db.delete(bruceMessages).where(eq(bruceMessages.conversationId, conversationId)).run();
}

/** Remove one turn — used to roll back the question when the answer fails. */
export function deleteMessage(id: number): void {
  db.delete(bruceMessages).where(eq(bruceMessages.id, id)).run();
}
