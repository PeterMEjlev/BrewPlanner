/**
 * Bruce by voice, in a browser — the phone-and-laptop half of the voice
 * assistant.
 *
 * The brewery speaker (apps/bruce) is a Pi process: a USB microphone, a wake
 * word, and a WebSocket to OpenAI. None of that helps you standing in the
 * garage with a phone, so this is the other way in — press a button, talk, and
 * the browser holds the Realtime session itself over WebRTC.
 *
 * The audio deliberately does not pass through this server. A Pi relaying two
 * 24 kHz PCM streams per listener would spend its CPU on transcoding and its
 * uplink on audio it has no use for, and every hop it added would be latency in
 * a conversation that lives or dies on latency. So the browser talks straight
 * to OpenAI, and the server keeps the three jobs a browser cannot be trusted
 * with:
 *
 *   1. The credential. `OPENAI_API_KEY` never leaves the Pi; the browser gets an
 *      ephemeral client secret, minted per call, that expires in minutes.
 *   2. What Bruce is. The instructions and the tool list are baked into that
 *      secret server-side, so a doctored client cannot hand him new powers.
 *   3. The tools themselves. A function call comes back over the data channel,
 *      the browser posts it to /api/bruce/voice/tool, and it runs here against
 *      the hub's own database — audited against whoever is logged in, exactly
 *      as the written chat's tools are.
 *
 * The one thing the voice model cannot do for itself is retrieval: the books
 * are embedded in this server's index, so `search_library` is added below to
 * the tools the written chat already has.
 */

import type { BrucePhase } from '@checklist/shared';
import { pageLabel } from '../knowledge/chunk.js';
import { embedQuery } from '../knowledge/embed.js';
import { balanceSources, search } from '../knowledge/store.js';
import { OpenAIError, openaiPost } from '../openai.js';
import { BREWERY_PROMPT, libraryBlock, RECIPES_PROMPT } from './chat.js';
import { recipeShelf } from './recipes.js';
import type { BruceActor } from './tools.js';
import { bruceToolDefinitions, bruceToolPhase, runBruceTool } from './tools.js';

/**
 * The speech model. Same default as the brewery speaker (apps/bruce/config.js)
 * — `gpt-realtime-mini` is the cheap one, `gpt-realtime` the better listener.
 * `BRUCE_VOICE_MODEL` overrides it for browsers alone, which is the useful
 * knob: a phone in a noisy garage is a harder listen than a mic on the bench.
 */
function voiceModel(): string {
  return (
    process.env.BRUCE_VOICE_MODEL?.trim() ||
    process.env.BRUCE_REALTIME_MODEL?.trim() ||
    'gpt-realtime-mini'
  );
}

/** Which voice he speaks in. */
function voiceName(): string {
  return process.env.BRUCE_VOICE?.trim() || 'alloy';
}

/** Turns your speech into the text shown on the page and stored in the thread. */
function transcriptionModel(): string {
  return process.env.BRUCE_TRANSCRIPTION_MODEL?.trim() || 'gpt-4o-mini-transcribe';
}

/**
 * How long the ephemeral secret lives. It only has to survive the SDP exchange
 * that follows — seconds, in practice — and the session it opens outlives it,
 * so there is nothing to gain from a longer window and a stolen one to lose.
 */
const SECRET_TTL_SECONDS = 120;

/**
 * How the turn ends. `semantic_vad` lets the model decide you have finished
 * speaking from what you said, not just from how long you have been quiet,
 * which is what stops it cutting in while you think mid-sentence. Set
 * `BRUCE_VOICE_VAD=server_vad` for the plain silence timer if a noisy brewery
 * fools it.
 */
function turnDetection(): Record<string, unknown> {
  const kind = process.env.BRUCE_VOICE_VAD?.trim() || 'semantic_vad';
  return kind === 'server_vad'
    ? { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 700 }
    : { type: 'semantic_vad', eagerness: 'auto' };
}

/**
 * Bruce's spoken persona.
 *
 * Kept apart from the written one (chat.ts's DEFAULT_PROMPT, and the PROMPT.md
 * that can replace it) for the same reason apps/bruce has its own: that persona
 * is told to lay out tables and bold the figure an answer turns on, and read
 * aloud it produces someone reciting markdown at you. The brewery knowledge is
 * shared — the blocks below come straight from the written chat — only the
 * manner of speaking differs.
 */
const VOICE_PERSONA = `You are Bruce, the brewing assistant for a home brewery running BrewPlanner.
You are being spoken to and you answer out loud, through a phone or a laptop —
often with a brewer whose hands are full.

Answer short. This is the rule that matters most, and it is not a style
preference — a spoken answer cannot be skimmed, so length costs the listener
everything it costs you nothing to add.

- One or two sentences. Say the thing, then stop. No preamble, no summary of
  what you are about to say, no offer of further help.
- Answer the question that was asked and not the neighbouring ones. "What's in
  our kegs?" is answered by "three IPA, two stout and two pilsner" — not by
  their ABVs, their fill dates, or which needs cleaning. If they want that they
  will ask, and asking is one short sentence for them.
- Numbers: give the one that answers the question. "Nineteen and a half" —
  not the setpoint, the swing overnight and how long the fridge has been
  cooling as well.
- The tools already answer you in summary form when you are speaking. Do not
  undo that by reading out everything they gave you, and do not ask for the
  full version unless the brewer asked for it — every tool that has a long
  form takes \`detail: "full"\` for exactly that case ("read me the whole list",
  "give me the full rundown", "everything about the saison").
- Never speak markdown: no asterisks, no bullet characters, no headings. If you
  would have written a list, say it as a sentence.
- Round numbers the way a person says them: "nineteen and a half degrees", not
  "19.47". Use metric — this brewery brews in celsius, litres and grams.
- A long list is unusable out loud. Past about five items, say how many there
  are, name the few that matter, and ask which they want.
- If you did not catch something, say so and ask. Do not guess at a number you
  half heard, especially before changing anything.
- If you ask a question, stop and wait for the answer. Never ask something and
  then act on your own guess in the same breath.

--- The brewery library

The brewing books and exBEERiment catalogues live in an index you can search
with \`search_library\`.

- Call it for anything about how brewing works — a fault, a water target, a
  yeast's behaviour — rather than answering from memory.
- It is not needed for what is happening in *this* brewery right now. That is
  what the brewery tools below are for.
- Say which book an answer came from, in passing: "Palmer puts it at about
  five point four". Do not read page numbers out loud unless asked.
- The books answer the question; an exBEERiment is one split batch and a small
  tasting panel. Mention one only when it changes what you would say — because
  it contradicts you, or because it says a worry isn't worth acting on — and
  never more than one in an answer.
- If the search comes back empty, say the books don't cover it and answer from
  general brewing knowledge, marked as such.`;

/**
 * Passages returned per search. Fewer than the written chat's six: this is read
 * aloud, and six 1,400-character passages is a model wading through four
 * minutes of prose to find one number.
 */
const VOICE_RETRIEVE_K = 4;

/** Same relevance floor as the written chat — see chat.ts's MIN_SCORE. */
const MIN_SCORE = 0.25;

/** Wider pool to balance from — see chat.ts's RETRIEVE_POOL. */
const VOICE_RETRIEVE_POOL = 16;

/**
 * Tighter than the written chat's cap: a spoken answer has no room to set out
 * what a triangle test is worth, so at most one exBEERiment reaches it.
 */
const MAX_EXBEERIMENT_PASSAGES = 1;

const SEARCH_LIBRARY_TOOL = {
  type: 'function',
  name: 'search_library',
  description:
    "Search this brewery's library — brewing books transcribed with their page numbers, and Brülosophy exBEERiment catalogues — for passages about a brewing question. Use it for how brewing works: faults, water chemistry, yeast, process. Not for the state of this brewery, which the other tools read.",
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'What to look up, as a phrase rather than a keyword — "why is my fermentation stuck at 1.030" finds more than "stuck".',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

/** One passage as the model hears it: where it is from, then the text. */
function renderPassage(chunk: {
  title: string;
  section: string;
  pageStart?: number;
  pageEnd?: number;
  text: string;
}): string {
  const page = pageLabel(chunk);
  const where = [chunk.section || null, page ? `p. ${page}` : null].filter(Boolean).join(', ');
  return `${chunk.title}${where ? ` — ${where}` : ''}\n${chunk.text}`;
}

async function searchLibrary(query: string): Promise<string> {
  const hits = balanceSources(
    search(await embedQuery(query), VOICE_RETRIEVE_POOL, MIN_SCORE),
    VOICE_RETRIEVE_K,
    MAX_EXBEERIMENT_PASSAGES,
  );
  if (hits.length === 0) {
    return 'Nothing in the library matched that. Say the books do not cover it, then answer from general brewing knowledge and make clear that is what you are doing.';
  }
  return `Passages from the brewery library, most relevant first:\n\n${hits
    .map((hit) => renderPassage(hit.chunk))
    .join('\n\n')}`;
}

/**
 * A tool definition as the Realtime API will accept it: name, description and
 * parameters, and nothing else.
 *
 * The written chat's definitions are written for the Responses API, which takes
 * fields Realtime does not — `get_recipe` carries `strict: true`, and a session
 * carrying it is refused outright with "Unknown parameter:
 * session.tools[1].strict", taking the whole Talk button down with it. Rather
 * than keep the two lists in step by hand, the definitions are narrowed to the
 * four fields both APIs agree on, which is all the model ever reads.
 */
function realtimeTool(definition: unknown): Record<string, unknown> {
  const spec = (definition ?? {}) as Record<string, unknown>;
  return {
    type: 'function',
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
  };
}

/**
 * Everything Bruce can reach by voice: the hub's tools, plus the books.
 * Exported for the test that guards the narrowing above — one stray field here
 * is not a degraded tool, it is a session OpenAI refuses to open.
 */
export function voiceToolDefinitions(): unknown[] {
  return [SEARCH_LIBRARY_TOOL, ...bruceToolDefinitions()].map(realtimeTool);
}

/** The progress line to show while `name` runs, or null for an unknown tool. */
export function voiceToolPhase(name: string, args: Record<string, unknown>): BrucePhase | null {
  if (name === SEARCH_LIBRARY_TOOL.name) return { phase: 'library' };
  return bruceToolPhase(name, args);
}

/**
 * Run one tool call from a browser session. Failures come back as text for the
 * same reason they do in the written chat: a model told what went wrong can
 * correct itself out loud, where a thrown error just ends the call.
 */
export async function runVoiceTool(
  name: string,
  args: Record<string, unknown>,
  actor: BruceActor,
): Promise<string> {
  if (name === SEARCH_LIBRARY_TOOL.name) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return 'No search phrase was given. Call search_library again with one.';
    try {
      return await searchLibrary(query);
    } catch (err) {
      return `The library could not be searched: ${err instanceof Error ? err.message : 'unknown error'}.`;
    }
  }
  // Every call through this function is going to be spoken — it is what the
  // brewery speaker and the phone's voice mode both run through, and nothing
  // else uses it. So the tools answer short here by default, and the model
  // overrules it per call with `detail: "full"` when the brewer asks for
  // everything. Instructing a model to be brief while handing it an eight-row
  // table does not work; not handing it the table does.
  return runBruceTool(name, args, actor, true);
}

/** Persona + this brewery's recipes + what is on the shelf, as one prompt. */
async function voicePrompt(): Promise<string> {
  const recipes = await recipeShelf();
  const blocks = [VOICE_PERSONA];
  if (recipes) blocks.push(`${RECIPES_PROMPT}\n\n${recipes}`);
  blocks.push(BREWERY_PROMPT);
  blocks.push(libraryBlock());
  return blocks.join('\n\n');
}

/** What OpenAI answers with when a client secret is minted. */
interface ClientSecretReply {
  value?: string;
  expires_at?: number;
}

/**
 * Mint an ephemeral Realtime credential for one browser call.
 *
 * The whole session — instructions, tools, voice, how a turn ends — is
 * described here and attached to the secret, so the browser's only say in the
 * matter is when to start and stop talking.
 */
export async function mintVoiceSession(): Promise<{
  clientSecret: string;
  expiresAt: number;
  model: string;
  voice: string;
}> {
  const model = voiceModel();
  const voice = voiceName();
  const instructions = await voicePrompt();
  const tools = voiceToolDefinitions();

  const body = (
    detection: Record<string, unknown>,
    ttl: number | null,
  ): Record<string, unknown> => ({
    ...(ttl ? { expires_after: { anchor: 'created_at', seconds: ttl } } : {}),
    session: {
      type: 'realtime',
      model,
      instructions,
      output_modalities: ['audio'],
      audio: {
        input: {
          transcription: { model: transcriptionModel() },
          turn_detection: detection,
        },
        output: { voice },
      },
      tools,
      tool_choice: 'auto',
    },
  });

  let reply: ClientSecretReply;
  try {
    reply = await openaiPost<ClientSecretReply>(
      '/realtime/client_secrets',
      body(turnDetection(), SECRET_TTL_SECONDS),
    );
  } catch (err) {
    // A 400 is the API refusing something in the request rather than the
    // request failing, and the two candidates are both refinements: the
    // `semantic_vad` turn detector, which is the newer of the two and not on
    // every account or model, and the expiry window. Retry without either — the
    // plain silence timer cuts in a little sooner and the secret lives for
    // OpenAI's default few minutes instead of two, which is a far better
    // outcome than a Talk button that does not connect.
    if (err instanceof OpenAIError && err.status === 400) {
      reply = await openaiPost<ClientSecretReply>(
        '/realtime/client_secrets',
        body({ type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 700 }, null),
      );
    } else {
      throw err;
    }
  }

  if (!reply.value) throw new Error('OpenAI did not return a client secret for the voice session.');
  return {
    clientSecret: reply.value,
    expiresAt: reply.expires_at ?? Math.floor(Date.now() / 1000) + SECRET_TTL_SECONDS,
    model,
    voice,
  };
}
