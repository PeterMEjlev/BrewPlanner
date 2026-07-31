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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BruceChatMessage,
  BruceChatModel,
  BruceChatSource,
  BruceInstructions,
  BrucePhase,
  BruceToolCall,
} from '@checklist/shared';
import { MAX_TOOL_RESULT_CHARS } from '@checklist/shared';
import { pageLabel } from '../knowledge/chunk.js';
import { embedQuery } from '../knowledge/embed.js';
import { knowledgeDir, libraryOutline, search } from '../knowledge/store.js';
import type { StreamEvent } from '../openai.js';
import { openaiKey, OpenAIError, openaiGet, openaiPost, openaiStream } from '../openai.js';
import { getSetting, setSetting } from '../repo.js';
import type { TokenUsage } from './cost.js';
import { estimateCostUsd } from './cost.js';
import { recipeShelf } from './recipes.js';
import type { BruceActor } from './tools.js';
import { bruceToolDefinitions, bruceToolPhase, runBruceTool } from './tools.js';

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
 * Whether Bruce may search the web, stored alongside the model choice.
 *
 * On unless switched off. It started opt-in, on the worry that a model with the
 * open web in reach would answer a mash-pH question from the first forum post
 * it finds instead of from Palmer. In practice the instructions below hold: the
 * retrieved passages arrive with the question, and the model reaches for the web
 * for what the books cannot know — a hop released after they were printed,
 * current stock, a piece of kit. Leaving it off by default mostly meant asking a
 * dated question, getting "the books don't cover it", and going to switch it on.
 *
 * It is still billed per search on top of the tokens, and still a switch in the
 * chat header — this only decides where a fresh install starts.
 */
const WEB_SEARCH_SETTING_KEY = 'bruce_web_search';

export function webSearchEnabled(): boolean {
  // Unset means never touched, which is the default-on case; only an explicit
  // "off" (the toggle) turns it off, so flipping it still sticks across restarts.
  return getSetting(WEB_SEARCH_SETTING_KEY) !== 'off';
}

export function setWebSearchEnabled(enabled: boolean): void {
  setSetting(WEB_SEARCH_SETTING_KEY, enabled ? 'on' : 'off');
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

Markdown is rendered, so use it where it earns its place:

- **Bold** the figure or term the answer turns on — the target pH, the dose, the
  name of the fault — so it can be found again at a glance. A few per answer.
- *Italics* for a light emphasis or an aside, not for whole sentences.
- \`Backticks\` for a unit, a formula or a value being quoted exactly.
- Headings only when an answer genuinely has two or more parts.

Don't bold everything: if half the answer is bold, none of it is.

You have been given passages from this brewery's library. It holds two kinds of
source, and they carry different weight:

- Brewing books, transcribed with their page numbers.
- Brülosophy exBEERiment catalogues — one entry per experiment, each with its
  purpose, its result and the triangle-test p-value, and a link to the article.

Answer from those passages.

- Base your answer on the passages whenever they cover the question, and cite
  where it came from inline, like (Water, p. 142). Give the page whenever the
  passage has one. An exBEERiment has no page, so cite it by catalogue and
  experiment instead, like (exBEERiments: Hops, "Dry Hop Duration"). That
  citation is what attaches a passage to your answer on screen, so cite every
  passage you actually used — and none that you didn't.
- If the passages only partly cover it, answer what they support and say
  plainly which part is your own general brewing knowledge.
- If they don't cover it at all, say so rather than inventing a figure. General
  brewing advice is fine — just don't attribute it to the library.
- Never invent a page number, a chapter, a p-value, or a quotation.

An exBEERiment is evidence of a particular shape, so say what it actually
shows rather than reporting it as a finding:

- One brewer, one split batch, a small tasting panel. A significant result means
  that panel could tell the two beers apart — not that either was better, and
  not that the difference carries to another recipe or process.
- A non-significant result means the panel failed to detect a difference. That
  is worth knowing, and it is the usual outcome for variables brewers worry
  about, but it is not proof the two are equivalent.
- Quote the p-value and the panel size when an answer leans on one.
- Where an exBEERiment and a book disagree, say so and say which is which: the
  book has the mechanism, the exBEERiment has one test of whether it was
  perceptible on a brew day. Neither of them settles it alone.

If the brewer asks about the library itself — what you know, which books and
catalogues you have, what one of them covers — answer from the library contents
listed below, not from the retrieved passages. A question like that legitimately
matches no passage, so do not say the library doesn't cover it; say what is on
the shelf.

The brewer is experienced: don't explain what a mash is. Prefer concrete
numbers, and give the reasoning behind a recommendation, not just the number.
Use metric units (°C, litres, grams), since that is what this brewery brews in,
converting from the library where it uses US units.`;

/** Where a custom persona lives. Instructions, not source material: never indexed. */
function promptPath(): string {
  return join(knowledgeDir(), 'PROMPT.md');
}

/** Persona in use: knowledge/PROMPT.md when it has content, else the built-in. */
function persona(): { text: string; custom: boolean } {
  try {
    if (existsSync(promptPath())) {
      const text = readFileSync(promptPath(), 'utf-8').trim();
      if (text.length > 0) return { text, custom: true };
    }
  } catch {
    // Unreadable persona file: fall back rather than take the chat down.
  }
  return { text: DEFAULT_PROMPT, custom: false };
}

function personaPrompt(): string {
  return persona().text;
}

/**
 * The persona as the Bruce page shows it: what is in use, whether it came from
 * PROMPT.md, and the built-in text so the page can show what reverting gives.
 */
export function bruceInstructions(): BruceInstructions {
  return { ...persona(), builtIn: DEFAULT_PROMPT };
}

/**
 * Rewrite knowledge/PROMPT.md from the dashboard. Empty text deletes the file,
 * which puts the built-in persona back — that is the revert, so there is no
 * separate endpoint for it.
 *
 * Takes effect on the next question: the file is read per turn, so nothing
 * needs restarting and a bad edit is one save away from being undone.
 */
export function setBruceInstructions(text: string): BruceInstructions {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    rmSync(promptPath(), { force: true });
  } else {
    mkdirSync(knowledgeDir(), { recursive: true });
    writeFileSync(promptPath(), `${trimmed}\n`, 'utf-8');
  }
  return bruceInstructions();
}

/**
 * Chapter lists are dropped past this many chapters across the whole library.
 * With a couple of books the outline is a useful map; with twenty it would be
 * most of the request, so titles alone carry the answer from there on.
 */
const MAX_OUTLINE_CHAPTERS = 80;

/**
 * Appended to the instructions only while web search is on.
 *
 * It is kept out of DEFAULT_PROMPT (and so out of PROMPT.md) deliberately: it
 * describes a capability that can be switched off under the persona's feet, and
 * a persona claiming to browse when the tool isn't attached produces a model
 * that apologises for failing to search. Written here, it appears exactly when
 * the tool does, whichever persona is in use.
 */
const WEB_SEARCH_PROMPT = `--- Searching the web

You can search the web, and should when it genuinely helps:

- The library first. If the retrieved passages answer the question, answer from
  them — don't search to double-check what Palmer already told you.
- Search when the question is about something the library cannot know: a hop
  variety released after it was written, current stock or prices, a piece of
  equipment, a supplier, a recent study, anything dated.
- Say which part came from the web, and cite the page you read it on with its
  title and link.
- The web is not the library. Where a brewing forum contradicts the library,
  prefer the library and say the two disagree.`;

/**
 * Appended when the brewery's recipes could be listed. Written here rather than
 * in DEFAULT_PROMPT for the same reason as the web-search block: it describes a
 * tool that isn't always attached (no Brewer's Friend key, upstream down), and a
 * persona that claims to read recipes it cannot reach apologises instead of
 * answering.
 */
export const RECIPES_PROMPT = `--- This brewery's recipes

The list below is every recipe on this brewery's Brewer's Friend account, with
its headline numbers only.

- When a question is about one of them — "is my saison under-hopped?", "what
  should I change about the stout?" — call \`get_recipe\` first and answer from
  the actual grain bill, hop schedule and water targets. Do not guess at a
  recipe's contents from its name and style.
- The list itself answers questions about the collection: how many there are,
  which is strongest, what was brewed most recently.
- Advice on a recipe is worth more when it is specific: name the addition or the
  malt you would change, and say by how much.
- These are the brewer's own recipes, not a source. Cite the library for the
  principle, and the recipe for what it currently does.`;

/**
 * Appended always, because unlike the two blocks above these tools are always
 * attached: they read this server's own database, so there is no key to be
 * missing and no upstream to be down.
 *
 * Its real job is the last two paragraphs. The read tools look after
 * themselves — a model that can see the fermenter will look at it — but a model
 * that can also *change* things will helpfully tidy up, and "delete the CO2
 * to-do" is not recoverable from a chat window. So: act on what was asked, name
 * what changed, and never guess between two candidates.
 */
export const BREWERY_PROMPT = `--- This brewery, right now

You can see and change BrewPlanner itself — this brewery's hub — through the
tools attached to you:

- \`get_brewery_status\` — what is in the fermenter and how it is fermenting, the
  Inkbird controllers' temperatures and targets, which devices are online, the
  latest reading from every sensor, and active alerts.
- \`get_sensor_history\` — the same sensors over a window of time: min, mean and
  max, where a reading started and ended, how much a meter consumed.
- \`get_brew_days\` — the brew-day log: what was brewed and when, the measured
  gravities, the efficiency worked back from them, how the rig ran, how the
  fermentation went, and the notes and rating.
- \`get_kegs\` / \`manage_keg\` — the keg board: what is in each keg, its ABV and
  when it was filled; filling, emptying and cleaning one.
- \`get_todos\` / \`manage_todo\` — the brewery to-do list.
- \`get_settings\` and the \`update_\` / \`set_\` tools — alert preferences, what a
  blank recipe starts from, the chart and keg colours, and which sensors show
  mock demo data.
- \`set_fermenter\` — which recipe is in the fermenter, and whether the empty one
  has been washed.
- \`configure_device\` — a device's logging interval, and an Inkbird's target
  temperature.
- \`get_rig_status\` — the brewing rig's kettle, mash tun, hot liquor tank, pumps
  and timer. Read-only from here; the rig is usually powered off between brew
  days, and reports as offline then.
- \`brewing_calculator\` — dilution, hydrometer temperature correction and
  carbonation pressure.

Look before you answer. A question about *this* brewery — "how's the
fermentation going?", "what's on tap?", "is anything offline?" — is answered by
calling the tool, not from the recipe list or the books. You cannot see any of
it otherwise, and a plausible guess about a real fermenter is worse than saying
you'll look.

Two of them are worth reaching for more often than they look:

- A question with a period in it — overnight, this week, during the brew day,
  since I pitched — is \`get_sensor_history\`, not \`get_brewery_status\`. The
  status tool shows the newest single reading, so answering "has it been stable?"
  from it is answering a different question than the one asked.
- Never do brewing arithmetic in your head when \`brewing_calculator\` covers it.
  Regulator pressure and hydrometer correction are polynomial fits; a figure you
  work out yourself will look right and be wrong, and the brewer has no way to
  tell. Say the number the tool returned.

The brew-day log is the brewery's own record of what happened, and the books
cannot know any of it. Lean on it when advice would otherwise be generic: what
this brewhouse actually yields, how a recipe behaved the last three times, and
whether a problem is new or has been there all along.

Changing things is different from reading them:

- Only change what the brewer actually asked you to change. Noticing that
  something else could be tidied up is a thing to mention, not to do.
- Every tool that changes something says what it changed, by name. Repeat that
  back — "ticked off *Order more CO2*" — so a wrong match is visible.
- When a tool reports that several items matched and it changed nothing, do not
  pick one. Ask which was meant.
- Recipes are read-only to you. You can say which one is in the fermenter, but
  writing or deleting a brew sheet is done in the recipe editor.
- The brewing rig is read-only too. You can say the kettle is at 74 °C; turning
  an element on is done at the brewery speaker or on the Brew System page, by
  somebody standing next to it.`;

/**
 * The shelf listing, or a note that there is nothing on it. Exported because
 * the spoken Bruce (voice.ts) needs the same shelf: he has a different persona,
 * not a different library.
 */
export function libraryBlock(): string {
  const library = libraryOutline();
  if (library.length === 0) {
    return '--- The brewery library\n\nThe library is empty — nothing has been indexed yet. Say so if asked, and answer from general brewing knowledge.';
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

  return `--- The brewery library\n\nThese are the only sources you have — books and exBEERiment catalogues alike. This is the complete list${detailed ? ', with the chapters or sections of each' : ''}:\n\n${shelf}`;
}

/**
 * Persona + what's actually on the shelf + what's in the recipe book, sent as
 * `instructions` each turn.
 *
 * @param recipes Recipe list from recipeShelf(), or null when unavailable
 */
export function chatPrompt(recipes: string | null): string {
  const blocks = [personaPrompt()];
  if (webSearchEnabled()) blocks.push(WEB_SEARCH_PROMPT);
  if (recipes) blocks.push(`${RECIPES_PROMPT}\n\n${recipes}`);
  blocks.push(BREWERY_PROMPT);
  blocks.push(libraryBlock());
  return blocks.join('\n\n');
}

/** One web page the model read, as attached to the text it informed. */
interface UrlCitation {
  type: string;
  url?: string;
  title?: string;
}

/** One item in a response's output: a message, a reasoning step, a tool call. */
interface OutputItem {
  type: string;
  content?: { type: string; text?: string; annotations?: UrlCitation[] }[];
  /** Function calls only: which tool, with what, and the id to answer against. */
  name?: string;
  arguments?: string;
  call_id?: string;
}

/** Response shape of POST /v1/responses, narrowed to what's read here. */
interface ResponsesReply {
  status?: string;
  incomplete_details?: { reason?: string };
  output_text?: string;
  output?: OutputItem[];
  /** Token counts for this call — priced by cost.ts. */
  usage?: TokenUsage;
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

/**
 * Web pages the model read, pulled out of the answer's `url_citation`
 * annotations and returned as sources beside the book passages.
 *
 * The model is asked to link its web claims in the prose too, but these are
 * what it actually opened — so the chips under an answer stay honest even when
 * it forgets to. Deduplicated by URL: one page cited three times is one chip.
 */
function webSources(reply: ResponsesReply): BruceChatSource[] {
  const sources: BruceChatSource[] = [];
  const seen = new Set<string>();
  for (const item of reply.output ?? []) {
    if (item.type !== 'message') continue;
    for (const piece of item.content ?? []) {
      for (const note of piece.annotations ?? []) {
        if (note.type !== 'url_citation' || !note.url || seen.has(note.url)) continue;
        seen.add(note.url);
        // Fall back to the hostname: a chip has to say *something*, and an
        // untitled citation is otherwise a link with no label.
        let title = note.title?.trim();
        if (!title) {
          try {
            title = new URL(note.url).hostname.replace(/^www\./, '');
          } catch {
            title = note.url;
          }
        }
        sources.push({ title, url: note.url });
      }
    }
  }
  return sources;
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

/**
 * How many book titles the progress line names before it starts counting.
 * Two fits on a phone next to "Reading the books —"; a list of six wraps and
 * stops being readable at the glance it exists for.
 */
const BROWSING_TITLES = 2;

/**
 * Which books are open, for the progress line: "Reading the books — Yeast".
 *
 * Plural because that is what actually happens. Retrieval hands the model its
 * best passages in one go and they routinely come from several books, so there
 * is no single volume being browsed at a given moment — naming them all is the
 * truthful version of "which book is he in". They arrive in relevance order, so
 * the ones that survive the cut are the ones the answer most likely leans on.
 */
function browsingDetail(sources: BruceChatSource[]): string | undefined {
  const titles = [...new Set(sources.map((s) => s.title))];
  if (titles.length === 0) return undefined;
  if (titles.length <= BROWSING_TITLES) return titles.join(', ');
  return `${titles.slice(0, BROWSING_TITLES).join(', ')} +${titles.length - BROWSING_TITLES} more`;
}

export interface ChatAnswer {
  text: string;
  sources: BruceChatSource[];
  /** Roughly what this answer cost in USD; null when it couldn't be priced. */
  costUsd: number | null;
  /** Every tool the model called on the way, in the order they ran. */
  toolCalls: BruceToolCall[];
}

/** Told what Bruce is doing, as he starts doing it. See BrucePhase. */
export type PhaseReporter = (phase: BrucePhase) => void;

/** Told which tool just ran, and what it said, as each one finishes. */
export type ToolReporter = (call: BruceToolCall) => void;

/**
 * Report only the *changes*, not every event that implies a phase.
 *
 * `response.output_text.delta` arrives per token, and each one means "writing" —
 * relaying all of them would be hundreds of stream frames and hundreds of React
 * renders to say the same thing. A phase can legitimately repeat (a search, an
 * answer, then a second search), so only consecutive duplicates are dropped.
 */
function onlyChanges(report: PhaseReporter): PhaseReporter {
  let last = '';
  return (phase) => {
    const key = `${phase.phase}|${phase.detail ?? ''}`;
    if (key === last) return;
    last = key;
    report(phase);
  };
}

/**
 * How many times the model may call a tool and be asked again before the answer
 * is forced. Each round is another billed request.
 *
 * Raised from four when the brewery tools arrived. Several calls in one round
 * are free of extra rounds — the model can ask for the fermenter, the kegs and
 * the to-do list at once — so this only bounds genuinely *sequential* work:
 * look at the fermenter, then read the recipe it named, then act. Three or four
 * such steps is a real question; seven is a loop.
 */
const MAX_TOOL_ROUNDS = 6;

/** Bruce's own tools. `web_search` is OpenAI's and is added separately. */
function functionTools(): unknown[] {
  return bruceToolDefinitions();
}

/**
 * Turn one streamed OpenAI event into a phase, or nothing.
 *
 * This is the honest half of the progress line on the Bruce page: the web phase
 * is reported because OpenAI said a search started, not because searching was
 * *allowed*. With the switch on but the books answering the question, the page
 * never claims he went to the web — because he didn't.
 */
function phaseForEvent(event: StreamEvent, report: PhaseReporter): void {
  const type = event.type ?? '';
  if (type === 'response.web_search_call.in_progress' || type === 'response.web_search_call.searching') {
    report({ phase: 'web' });
  } else if (type === 'response.output_text.delta') {
    // First text token: the thinking and searching are over, prose is arriving.
    report({ phase: 'writing' });
  }
}

/**
 * Name a thread from its opening question — "Chocolate malt and mash pH"
 * rather than the whole sentence the brewer typed.
 *
 * Its own small call, made *alongside* the answer rather than after it (see the
 * route), so naming the thread costs no extra waiting. It is one call per
 * conversation, not per question, and a handful of tokens: a rounding error
 * against the answer it runs next to.
 *
 * Returns null on any failure, which is not an error — the caller falls back to
 * the trimmed question, which is what every thread was named before this.
 */
export async function summariseTitle(question: string): Promise<string | null> {
  if (!openaiKey()) return null;
  const model = chatModel();
  try {
    const reply = await openaiPost<ResponsesReply>('/responses', {
      model,
      instructions: `Write a title for a brewing chat that opens with this question. Three to six words, no quotes, no full stop, capitalised like a headline. Name the subject, not the asking: "Mash pH for a pale ale", not "Question about mash pH". Reply with the title and nothing else.`,
      input: [{ role: 'user', content: question.slice(0, 500) }],
      max_output_tokens: TITLE_TOKEN_BUDGET,
      // As little thinking as the model allows: naming a thread needs none, and
      // spent on reasoning the budget above comes back empty. The o-series has
      // no "minimal", so it gets the lowest it does take.
      ...(model.startsWith('gpt-5')
        ? { reasoning: { effort: 'minimal' } }
        : /^o[1-9]/.test(model)
          ? { reasoning: { effort: 'low' } }
          : {}),
    });
    // Models like to wrap a title in quotes however firmly they are asked not
    // to, and a trailing full stop is just as common — often both at once, so
    // the quotes come off before the stop underneath them.
    const title = (extractText(reply).split('\n')[0] ?? '')
      .trim()
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .replace(/\s*\.+$/, '')
      .trim();
    return title.length >= 3 ? title : null;
  } catch {
    return null;
  }
}

/**
 * Room for a title and, on a reasoning model, the minimum it insists on
 * spending before writing one. Six words is nothing; the floor is the model's.
 */
const TITLE_TOKEN_BUDGET = 200;

/**
 * A parenthesised aside — `(Water, p. 78–79)`. Citations are asked for in this
 * form, and looking only inside brackets keeps a page number mentioned in the
 * prose ("mash in with 30 p. of…") from reading as one.
 */
const PARENTHETICAL = /\(([^)]{1,200})\)/g;

/** `p. 78`, `pp. 78–79`, `page 78` — the page (and range end) being cited. */
const CITED_PAGE = /\bpp?\.\s*(\d+)(?:\s*[–—-]\s*(\d+))?|\bpages?\s+(\d+)(?:\s*[–—-]\s*(\d+))?/gi;

/** Every number a passage covers: `"78–79"` → `[78, 79]`. */
function pageNumbers(page: string | undefined): number[] {
  if (!page) return [];
  return [...page.matchAll(/\d+/g)].map((m) => Number(m[0]));
}

/** The longer words of a phrase, which inside a bracket are a deliberate reference. */
function referenceWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 5);
}

/**
 * Work out which retrieved passages the answer actually leaned on.
 *
 * The evidence is the answer's own inline citations: the persona asks for
 * `(Water, p. 142)`, so a passage whose pages appear in a bracket is one the
 * model used, and an answer with no library citation at all used no passage.
 *
 * An exBEERiment has no page, so it is cited by name — `(exBEERiments: Hops,
 * "Dry Hop Duration")` — and is attributed on the words a bracket shares with
 * exactly one passage's title and section. Shared words ("exbeeriments", "hops",
 * which every catalogue carries) prove a citation happened without saying which
 * one, so they only count towards the fallback below.
 *
 * Deliberately biased towards over-showing. If the answer cites the library in
 * some way this can't pin to a particular passage — an unusual format, a
 * citation by chapter — everything is marked cited. The failure this avoids is a
 * claim of provenance that isn't there; quietly hiding a real one would be the
 * same mistake pointed the other way.
 */
function markCited(sources: BruceChatSource[], answer: string): BruceChatSource[] {
  const books = sources.filter((source) => !source.url);
  if (books.length === 0) return sources;

  const brackets = [...answer.matchAll(PARENTHETICAL)].map((m) => m[1] ?? '');
  const citedPages = new Set<number>();
  for (const bracket of brackets) {
    for (const match of bracket.matchAll(CITED_PAGE)) {
      for (const number of match.slice(1)) {
        if (number) citedPages.add(Number(number));
      }
    }
  }

  // Which passages each reference word could mean. A word that lands on one
  // names it; a word several of them share can only say that some passage was
  // cited, which is what `namesABook` is for.
  const owners = new Map<string, Set<BruceChatSource>>();
  for (const source of books) {
    for (const word of referenceWords(`${source.title} ${source.section ?? ''}`)) {
      const set = owners.get(word) ?? new Set<BruceChatSource>();
      set.add(source);
      owners.set(word, set);
    }
  }

  // Whether a bracket refers to the library at all, on titles alone: a section
  // is made of ordinary brewing words ("temperature", "fermentation") that an
  // aside can use without citing anything.
  const titleWords = new Set(books.flatMap((source) => referenceWords(source.title)));

  const namedByBracket = new Set<BruceChatSource>();
  let namesABook = false;
  for (const bracket of brackets) {
    const words = referenceWords(bracket);
    const citesTitle = words.some((word) => titleWords.has(word));
    if (citesTitle) namesABook = true;
    // Only brackets that are citations get to name a passage. Plenty of asides
    // ("a longer fermentation") share a word with a section heading without
    // pointing at anything, and marking one of those cited would put a source
    // under an answer that never used it.
    if (!citesTitle && [...bracket.matchAll(CITED_PAGE)].length === 0) continue;
    for (const word of words) {
      const candidates = owners.get(word);
      const [only] = candidates ?? [];
      if (candidates?.size === 1 && only) namedByBracket.add(only);
    }
  }

  const matched = books.filter(
    (source) =>
      pageNumbers(source.page).some((n) => citedPages.has(n)) || namedByBracket.has(source),
  );
  // Cited the library but not in a way that lands on a passage: show them all
  // rather than guess wrong about which one.
  const allCited = matched.length === 0 && (citedPages.size > 0 || namesABook);

  return sources.map((source) =>
    source.url ? source : { ...source, cited: allCited || matched.includes(source) },
  );
}

/**
 * Answer one question, grounded in the knowledge index.
 *
 * @param question What the brewer typed
 * @param history Prior turns, oldest first (the new question is not included)
 * @param report Called as each step begins, for the page's progress line
 * @param actor Who asked, recorded against anything the tools change on their
 *   behalf. Defaults to the trusted-local kiosk, which is what a request with no
 *   session is (see the chat route's requireAdmin guard).
 */
export async function answerQuestion(
  question: string,
  history: BruceChatMessage[],
  report: PhaseReporter = () => {},
  actor: BruceActor = { userId: null, username: 'Local kiosk' },
  reportTool: ToolReporter = () => {},
): Promise<ChatAnswer> {
  const onPhase = onlyChanges(report);
  /** Kept as well as reported: the stream shows them live, the record persists. */
  const toolCalls: BruceToolCall[] = [];
  const onTool: ToolReporter = (call) => {
    toolCalls.push(call);
    reportTool(call);
  };
  onPhase({ phase: 'library' });
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
        'No individual passage matched this question. If it is a question about the library itself, answer from the library contents in your instructions. Otherwise answer from general brewing knowledge and say the library does not cover it.\n\n---\n\n';

  // Input grows across tool rounds: the model's own output items and the tool
  // results are appended, so the next call sees what it asked for.
  const input: unknown[] = [
    ...history.slice(-HISTORY_TURNS).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: `${context}Question: ${question}` },
  ];

  const model = chatModel();
  const body: Record<string, unknown> = {
    model,
    instructions: chatPrompt(await recipeShelf()),
    input,
    max_output_tokens: MAX_OUTPUT_TOKENS,
  };

  // Keep GPT-5 snappy: full reasoning effort on a lookup question costs seconds
  // of staring at a spinner for no better answer. Only sent for models known to
  // accept it; BRUCE_CHAT_REASONING_EFFORT overrides (or disables, with "").
  const effort = process.env.BRUCE_CHAT_REASONING_EFFORT?.trim();
  const reasoningEffort = effort ?? (model.startsWith('gpt-5') || /^o[1-9]/.test(model) ? 'low' : undefined);
  if (reasoningEffort) body.reasoning = { effort: reasoningEffort };

  // What he is allowed to reach for. `web_search` is run by OpenAI, not by us:
  // the model decides whether a question needs it, searches, reads the results
  // and cites them back as url_citation annotations — so there is no crawler,
  // no scraping and no extra key here. `get_recipe` is ours, and is answered in
  // the loop below.
  body.tools = [...(webSearchEnabled() ? [{ type: 'web_search' }] : []), ...functionTools()];

  /** Token counts summed over every round, so a tool call isn't billed as free. */
  const usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
  const webPages: BruceChatSource[] = [];
  let reply: ResponsesReply | null = null;

  // Named once here rather than per round: the passages don't change between
  // tool rounds, so the line would only repeat itself.
  const browsing = browsingDetail(sources);

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    onPhase({ phase: 'thinking', ...(browsing ? { detail: browsing } : {}) });

    try {
      reply = await openaiStream<ResponsesReply>('/responses', body, (event) =>
        phaseForEvent(event, onPhase),
      );
    } catch (err) {
      // A 400 usually means this model doesn't take one of the optional
      // parameters — an older one with no reasoning step, or one that can't use
      // tools. Retry bare before giving up, so swapping the model on the Bruce
      // page to something older doesn't need a code change. Only on the first
      // round: once a tool has answered, the input holds results that would be
      // invalid with the tools removed.
      if (round === 1 && err instanceof OpenAIError && err.status === 400 && (body.reasoning || body.tools)) {
        delete body.reasoning;
        delete body.tools;
        reply = await openaiStream<ResponsesReply>('/responses', body, (event) =>
          phaseForEvent(event, onPhase),
        );
      } else {
        throw err;
      }
    }

    usage.input_tokens = (usage.input_tokens ?? 0) + (reply.usage?.input_tokens ?? 0);
    usage.output_tokens = (usage.output_tokens ?? 0) + (reply.usage?.output_tokens ?? 0);
    // Citations are collected per round: a page read while deciding to look up a
    // recipe is still a page that informed the answer.
    webPages.push(...webSources(reply));

    const calls = (reply.output ?? []).filter((item) => item.type === 'function_call');
    if (calls.length === 0) break;

    // Everything the model produced goes back in — including its reasoning
    // items, which the reasoning models need in order to pick up where they
    // left off — followed by each tool's result.
    input.push(...(reply.output ?? []));
    for (const call of calls) {
      input.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: await runTool(call, onPhase, onTool, actor),
      });
    }

    // The last round has to produce prose, not another tool call.
    if (round === MAX_TOOL_ROUNDS - 1) body.tool_choice = 'none';
  }

  const text = reply ? extractText(reply) : '';
  if (!text) {
    // Empty output with a reasoning model almost always means the token budget
    // was spent thinking. Say that, rather than showing a blank bubble.
    const reason = reply?.incomplete_details?.reason;
    throw new Error(
      reason === 'max_output_tokens'
        ? 'Bruce ran out of room before finishing the answer. Try a narrower question.'
        : 'Bruce came back empty-handed. Try asking again.',
    );
  }

  // Deduplicate web citations across rounds — one page read twice is one chip.
  const uniqueWeb = [...new Map(webPages.map((page) => [page.url, page])).values()];

  // Priced from the counts OpenAI just reported, not from the request — a
  // retry, a reasoning step or a truncated answer all move the real number.
  // Note the per-search tool fee is *not* in `usage`, so a searched answer costs
  // a little more than this says; the page links the real bill for that reason.
  return {
    text,
    // The passages travel with the answer either way; `cited` is what separates
    // the ones it was written from and the ones it merely had to hand.
    sources: markCited([...sources, ...uniqueWeb], text),
    costUsd: estimateCostUsd(model, usage),
    toolCalls,
  };
}

/**
 * Run one tool call and return what the model should read back.
 *
 * Errors become text rather than exceptions — see runBruceTool. An unknown tool
 * name is treated the same way: the model invented it, and being told so is more
 * useful than a 500 on the brewer's screen. Unreadable arguments are the same
 * class of problem, and get the same treatment.
 *
 * `onTool` is told what happened either way, including for a call that could not
 * be read: an entry saying the model asked for something malformed is exactly
 * the kind of thing the record exists to make visible.
 */
async function runTool(
  call: OutputItem,
  onPhase: PhaseReporter,
  onTool: ToolReporter,
  actor: BruceActor,
): Promise<string> {
  const name = call.name ?? '';

  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(call.arguments ?? '{}');
    args = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    const refusal = `The arguments to ${name || 'that tool'} could not be read. Call it again with plain values.`;
    onTool({ name: name || 'unknown', result: refusal });
    return refusal;
  }

  const phase = bruceToolPhase(name, args);
  if (phase) onPhase(phase);
  const result = await runBruceTool(name, args, actor);
  onTool({
    name,
    ...(phase ? { phase: phase.phase } : {}),
    ...(phase?.detail ? { detail: phase.detail } : {}),
    ...(Object.keys(args).length > 0 ? { args } : {}),
    result: truncateResult(result),
  });
  return result;
}

/**
 * The part of a tool's answer kept beside the entry. A device table or a keg
 * board runs to kilobytes and the answer above it is the point — this is here
 * so a one-line confirmation can be checked at a glance.
 */
function truncateResult(result: string): string {
  const trimmed = result.trim();
  return trimmed.length <= MAX_TOOL_RESULT_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_TOOL_RESULT_CHARS)}…`;
}
