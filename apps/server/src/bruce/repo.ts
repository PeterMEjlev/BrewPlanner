import type { BruceChatMessage, BruceChatSource, BruceConversation } from '@checklist/shared';
import { asc, desc, eq, lt, sql } from 'drizzle-orm';
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
  return {
    id: row.id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    ...(sources ? { sources } : {}),
    createdAt: row.createdAt,
  };
}

// --- Threads ----------------------------------------------------------------

/** Every thread, most recently used first, with a count for the list. */
export function listConversations(): BruceConversation[] {
  const counts = db
    .select({ id: bruceMessages.conversationId, n: sql<number>`count(*)` })
    .from(bruceMessages)
    .groupBy(bruceMessages.conversationId)
    .all();
  const byId = new Map(counts.map((c) => [c.id, c.n]));

  return db
    .select()
    .from(bruceConversations)
    .orderBy(desc(bruceConversations.updatedAt), desc(bruceConversations.id))
    .all()
    .map((row) => ({
      id: row.id,
      title: row.title,
      messages: byId.get(row.id) ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
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

/**
 * Name a thread after its opening question — "What mash pH for a pale ale?"
 * beats five rows of "New chat". Only applied while the title is still the
 * placeholder, so a rename is never overwritten.
 */
export function titleFromFirstMessage(id: number, question: string): void {
  const row = db.select().from(bruceConversations).where(eq(bruceConversations.id, id)).get();
  if (!row || row.title !== 'New chat') return;

  const clean = question.replace(/\s+/g, ' ').trim();
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

/** Append one turn and bump the thread's activity time. */
export function addMessage(
  conversationId: number,
  role: 'user' | 'assistant',
  content: string,
  sources?: BruceChatSource[],
): BruceChatMessage {
  const row = db
    .insert(bruceMessages)
    .values({
      conversationId,
      role,
      content,
      sources: sources && sources.length > 0 ? JSON.stringify(sources) : null,
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
