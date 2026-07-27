/**
 * Bruce's text chat — the "write with Bruce" side of the Bruce page.
 *
 * Runs here in the server rather than in apps/bruce, which is a microphone
 * process that only starts when the Pi has audio hardware. Chat therefore
 * works whether or not bruce.service is up; the voice assistant is a separate
 * front door onto the same brewery.
 *
 * One question is answered in three steps:
 *   1. embed the question with the same model the books were indexed with
 *   2. pull the closest passages out of the knowledge index
 *   3. ask the model to answer from those passages, and cite them
 *
 * The grounding is the point. Left to its own memory a model will happily
 * invent a mash-pH figure; here it answers out of Palmer and Kaminski and says
 * which page it read it on, and says it doesn't know when the books are silent.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BruceChatMessage, BruceChatModel, BruceChatSource } from '@checklist/shared';
import { pageLabel } from '../knowledge/chunk.js';
import { embedQuery } from '../knowledge/embed.js';
import { knowledgeDir, libraryOutline, search } from '../knowledge/store.js';
import { openaiKey, OpenAIError, openaiGet, openaiPost } from '../openai.js';
import { getSetting, setSetting } from '../repo.js';

/**
 * Chat model, in order of precedence: whatever was picked on the Bruce page,
 * then BRUCE_CHAT_MODEL, then the built-in default.
 *
 * gpt-5-mini is the default because it is cheap and reasons well enough to
 * combine several retrieved passages into one answer. The page offers whatever
 * the account can actually see (see listChatModels), so this only decides where
 * a fresh install starts.
 */
const DEFAULT_CHAT_MODEL = 'gpt-5-mini';
const MODEL_SETTING_KEY = 'bruce_chat_model';

export function chatModel(): string {
  return getSetting(MODEL_SETTING_KEY)?.trim() || process.env.BRUCE_CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL;
}

export function setChatModel(model: string): void {
  setSetting(MODEL_SETTING_KEY, model.trim());
}

/**
 * Models this API key can actually use, as the page's dropdown.
 *
 * Asked live rather than hard-coded: OpenAI's line-up moves faster than this
 * repo does, and an account's access varies. Non-text models (audio, image,
 * realtime, embeddings) and dated snapshots are filtered out — the snapshots
 * trebled the list without adding a choice anyone wants to make.
 */
const NON_CHAT = /audio|realtime|image|tts|whisper|transcribe|embedding|moderation|dall-e|codex|deep-research|search|sora|guard|instruct/;
/** Pinned snapshots like `gpt-5.4-2026-03-05` — the bare alias is in the list already. */
const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;
/** Legacy point releases (`-0125`, `-1106`, `-16k`) whose base alias is listed. */
const LEGACY_VARIANT = /-\d{4}$|-\d+k$/;
/** GPT-3.5 is long superseded and only lengthens the menu. */
const OBSOLETE = /^gpt-3\.5/;
/** The list changes rarely; one lookup per hour is plenty. */
const MODEL_CACHE_MS = 60 * 60 * 1000;

let modelCache: { at: number; models: BruceChatModel[] } | null = null;

/**
 * Newest first, GPT before the o-series. Plain alphabetical buries this year's
 * model under a decade of older ones, and the picker's first entries are the
 * ones anyone actually wants.
 */
function byPreference(a: string, b: string): number {
  const family = (id: string): number => (id.startsWith('o') ? 1 : 0);
  return family(a) - family(b) || b.localeCompare(a, 'en', { numeric: true });
}

/** How many models the picker offers. A short menu of good choices beats 30. */
const MAX_OFFERED = 5;

/**
 * The shortlist, best first, chosen for *this* job: answering a brewing
 * question from half a dozen retrieved book passages, on a dashboard where you
 * sit and wait for the reply.
 *
 * Picked by running the same water-chemistry question through every candidate
 * the account offers and comparing answer quality, page-citation density and
 * latency (all landed between 5.5s and 10.8s, so cost and grounding decided it
 * rather than speed):
 *
 *   gpt-5-mini     the default: cheapest of the reasoning models and the most
 *                  thorough citer in the test — the right everyday choice
 *   gpt-5.6-terra  best answer outright: correct unit conversions, a clear
 *                  table, and it refused to compute a dose from insufficient
 *                  data instead of guessing. Reach for it on hard chemistry
 *   gpt-5.6-luna   fastest of the current generation (5.5s), for quick lookups
 *   gpt-5.4-mini   a cheap middle option, one generation back
 *   gpt-4.1-mini   no reasoning step at all: the cheapest way to ask
 *
 * Names are matched against the live list, so a retired model quietly drops
 * out rather than breaking the picker, and the shortlist is topped up from the
 * newest models the account can see if fewer than MAX_OFFERED survive. Edit
 * this list to change what the dropdown offers.
 */
const SHORTLIST: { id: string; label: string; blurb: string }[] = [
  {
    id: 'gpt-5-mini',
    label: 'Balanced',
    blurb: 'The everyday choice. Cheap, and quoted the most pages of any model tested — good when you want the books backing every claim.',
  },
  {
    id: 'gpt-5.6-terra',
    label: 'Most capable',
    blurb: 'Best answers, for hard water chemistry. Converts units correctly and asks for missing numbers instead of guessing. Costs more per question.',
  },
  {
    id: 'gpt-5.6-luna',
    label: 'Fastest',
    blurb: 'Roughly twice as quick to reply, with shorter answers and fewer citations. Good for quick lookups mid-brew.',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'Cheap',
    blurb: 'A generation behind, still cites well. Sensible if you are asking a lot of questions.',
  },
  {
    id: 'gpt-4.1-mini',
    label: 'Cheapest',
    blurb: 'Skips the reasoning step entirely, so it is the least expensive way to ask. Weaker on multi-step chemistry.',
  },
];

/** Given to a model that got in by top-up: we have no measurements for it. */
const UNRATED_BLURB = 'Newer model available on your account. Not benchmarked for this page.';

export async function listChatModels(): Promise<BruceChatModel[]> {
  if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.models;
  if (!openaiKey()) return [];

  const res = await openaiGet<{ data?: { id?: string }[] }>('/models');
  const available = new Set(
    (res.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string')
      .filter((id) => /^(gpt-|o[1-9]|chatgpt)/.test(id))
      .filter((id) => !NON_CHAT.test(id) && !DATED_SNAPSHOT.test(id))
      .filter((id) => !LEGACY_VARIANT.test(id) && !OBSOLETE.test(id)),
  );

  const models: BruceChatModel[] = SHORTLIST.filter((m) => available.has(m.id));
  // Top up with the newest models this account can see, so the picker still
  // offers real choices if the shortlist ages out from under us.
  for (const id of [...available].sort(byPreference)) {
    if (models.length >= MAX_OFFERED) break;
    if (!models.some((m) => m.id === id)) models.push({ id, label: 'Untested', blurb: UNRATED_BLURB });
  }

  modelCache = { at: Date.now(), models: models.slice(0, MAX_OFFERED) };
  return modelCache.models;
}

/**
 * How many passages to put in front of the model. Six ~1,400-character
 * passages is around 2k tokens of context: enough to cover a question that
 * spans a chapter, cheap enough to ask freely.
 */
const RETRIEVE_K = 6;

/**
 * Relevance floor. Without one, a question the books don't cover still returns
 * the six least-irrelevant paragraphs and the model builds an answer from
 * them. 0.25 cosine is well below anything genuinely on-topic for this
 * embedding family, so it only filters out the noise.
 */
const MIN_SCORE = 0.25;

/** Prior turns replayed for follow-ups ("and for a stout?"). Pairs, so keep it even. */
const HISTORY_TURNS = 8;

/** Generous: a reasoning model spends part of this budget before writing anything. */
const MAX_OUTPUT_TOKENS = 2000;

/**
 * Bruce's persona for text. Drop a `PROMPT.md` into knowledge/ to replace it
 * wholesale — that is where the instructions from an existing custom GPT go.
 *
 * Note the difference from apps/bruce/system-prompt.txt: that one is written
 * for speech ("one or two short sentences"), because everything it says is
 * spoken aloud in the brewery. This one is read on a screen, so it can lay out
 * numbers, steps and a table.
 */
const DEFAULT_PROMPT = `You are Bruce, the brewing assistant for a home brewery running BrewPlanner.

You are answering in writing, on a dashboard — not out loud. Write for the
screen: get to the point, use short paragraphs, and use a list or a small table
when comparing numbers, water profiles, or steps.

You have been given passages from the brewing books in this brewery's library.
Answer from those passages.

- Base your answer on the passages whenever they cover the question, and cite
  where it came from inline, like (Water, p. 142).
- If the passages only partly cover it, answer what they support and say
  plainly which part is your own general brewing knowledge.
- If they don't cover it at all, say so rather than inventing a figure. General
  brewing advice is fine — just don't attribute it to the books.
- Never invent a page number, a chapter, or a quotation.

If the brewer asks about the library itself — what you know, which books you
have, what a book covers — answer from the library contents listed below, not
from the retrieved passages. A question like that legitimately matches no
passage, so do not say the books don't cover it; say what is on the shelf.

The brewer is experienced: don't explain what a mash is. Prefer concrete
numbers, and give the reasoning behind a recommendation, not just the number.
Use metric units (°C, litres, grams), since that is what this brewery brews in,
converting from the books where they use US units.`;

/** Persona text: knowledge/PROMPT.md when present, else the built-in default. */
function personaPrompt(): string {
  const custom = join(knowledgeDir(), 'PROMPT.md');
  try {
    if (existsSync(custom)) {
      const text = readFileSync(custom, 'utf-8').trim();
      if (text.length > 0) return text;
    }
  } catch {
    // Unreadable persona file: fall back rather than take the chat down.
  }
  return DEFAULT_PROMPT;
}

/**
 * Chapter lists are dropped past this many chapters across the whole library.
 * With a couple of books the outline is a useful map; with twenty it would be
 * most of the request, so titles alone carry the answer from there on.
 */
const MAX_OUTLINE_CHAPTERS = 80;

/** Persona + what's actually on the shelf, sent as `instructions` each turn. */
export function chatPrompt(): string {
  const library = libraryOutline();
  if (library.length === 0) {
    return `${personaPrompt()}\n\n--- The brewery library\n\nThe library is empty — no books have been indexed yet. Say so if asked, and answer from general brewing knowledge.`;
  }

  const total = library.reduce((n, doc) => n + doc.chapters.length, 0);
  const detailed = total <= MAX_OUTLINE_CHAPTERS;
  const shelf = library
    .map((doc) =>
      detailed && doc.chapters.length > 0
        ? `- ${doc.title}\n${doc.chapters.map((c) => `    - ${c}`).join('\n')}`
        : `- ${doc.title}`,
    )
    .join('\n');

  return `${personaPrompt()}\n\n--- The brewery library\n\nThese are the only books you have. This is the complete list${detailed ? ', with each book\'s chapters' : ''}:\n\n${shelf}`;
}

/** Response shape of POST /v1/responses, narrowed to what's read here. */
interface ResponsesReply {
  status?: string;
  incomplete_details?: { reason?: string };
  output_text?: string;
  output?: {
    type: string;
    content?: { type: string; text?: string }[];
  }[];
}

/**
 * Pull the assistant's text out of a Responses answer.
 *
 * The raw HTTP body has no `output_text` (that is an SDK convenience), so the
 * output array is walked: message items hold the text, reasoning items are
 * skipped.
 */
function extractText(reply: ResponsesReply): string {
  if (typeof reply.output_text === 'string' && reply.output_text.trim()) {
    return reply.output_text.trim();
  }
  const parts: string[] = [];
  for (const item of reply.output ?? []) {
    if (item.type !== 'message') continue;
    for (const piece of item.content ?? []) {
      if (piece.type === 'output_text' && typeof piece.text === 'string') parts.push(piece.text);
    }
  }
  return parts.join('\n').trim();
}

/** One passage as the model sees it, numbered so it can cite by source. */
function renderPassage(
  n: number,
  chunk: { title: string; section: string; pageStart?: number; pageEnd?: number; text: string },
): string {
  const page = pageLabel(chunk);
  const where = [chunk.section || null, page ? `p. ${page}` : null].filter(Boolean).join(', ');
  return `[${n}] ${chunk.title}${where ? ` — ${where}` : ''}\n${chunk.text}`;
}

export interface ChatAnswer {
  text: string;
  sources: BruceChatSource[];
}

/**
 * Answer one question, grounded in the knowledge index.
 *
 * @param question What the brewer typed
 * @param history Prior turns, oldest first (the new question is not included)
 */
export async function answerQuestion(
  question: string,
  history: BruceChatMessage[],
): Promise<ChatAnswer> {
  const hits = search(await embedQuery(question), RETRIEVE_K, MIN_SCORE);

  const sources: BruceChatSource[] = [];
  const seen = new Set<string>();
  for (const { chunk } of hits) {
    const page = pageLabel(chunk);
    const key = `${chunk.title}|${chunk.section}|${page ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      title: chunk.title,
      ...(chunk.section ? { section: chunk.section } : {}),
      ...(page ? { page } : {}),
    });
  }

  // The passages ride along with the question rather than in `instructions`,
  // so each turn is grounded in what *that* question retrieved and the replayed
  // history stays a plain conversation.
  const context =
    hits.length > 0
      ? `Passages from the brewery library, most relevant first:\n\n${hits
          .map((hit, i) => renderPassage(i + 1, hit.chunk))
          .join('\n\n')}\n\n---\n\n`
      : // No hits is ambiguous: it can mean the books are silent on a brewing
        // question, or that this is a question *about* the library, which
        // matches no single passage by nature. The model has the shelf listing
        // in its instructions, so let it tell the two apart.
        'No individual passage matched this question. If it is a question about the library itself, answer from the library contents in your instructions. Otherwise answer from general brewing knowledge and say the books do not cover it.\n\n---\n\n';

  const input = [
    ...history.slice(-HISTORY_TURNS).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: `${context}Question: ${question}` },
  ];

  const model = chatModel();
  const body: Record<string, unknown> = {
    model,
    instructions: chatPrompt(),
    input,
    max_output_tokens: MAX_OUTPUT_TOKENS,
  };

  // Keep GPT-5 snappy: full reasoning effort on a lookup question costs seconds
  // of staring at a spinner for no better answer. Only sent for models known to
  // accept it; BRUCE_CHAT_REASONING_EFFORT overrides (or disables, with "").
  const effort = process.env.BRUCE_CHAT_REASONING_EFFORT?.trim();
  const reasoningEffort = effort ?? (model.startsWith('gpt-5') || /^o[1-9]/.test(model) ? 'low' : undefined);
  if (reasoningEffort) body.reasoning = { effort: reasoningEffort };

  let reply: ResponsesReply;
  try {
    reply = await openaiPost<ResponsesReply>('/responses', body);
  } catch (err) {
    // A 400 usually means this model doesn't take one of the optional
    // parameters. Retry bare before giving up, so swapping BRUCE_CHAT_MODEL to
    // something older doesn't need a code change.
    if (err instanceof OpenAIError && err.status === 400 && body.reasoning) {
      delete body.reasoning;
      reply = await openaiPost<ResponsesReply>('/responses', body);
    } else {
      throw err;
    }
  }

  const text = extractText(reply);
  if (!text) {
    // Empty output with a reasoning model almost always means the token budget
    // was spent thinking. Say that, rather than showing a blank bubble.
    const reason = reply.incomplete_details?.reason;
    throw new Error(
      reason === 'max_output_tokens'
        ? 'Bruce ran out of room before finishing the answer. Try a narrower question.'
        : 'Bruce came back empty-handed. Try asking again.',
    );
  }

  return { text, sources };
}
