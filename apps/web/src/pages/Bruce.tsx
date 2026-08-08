import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  BruceBook,
  BruceChatMessage,
  BruceChatReply,
  BruceChatSource,
  BruceChatState,
  BruceConversation,
  BruceIndexJob,
  BruceInstructions,
  BruceKnowledgeState,
  BruceMicLevelsResponse,
  BrucePhase,
  BrucePhaseName,
  BruceServiceStatus,
  BruceState,
  BruceToolCall,
  BruceTranscriptEntry,
} from '@checklist/shared';
import { MAX_KNOWLEDGE_FILE_CHARS } from '@checklist/shared';
import { api } from '../api';
import { setBrucePhase } from '../bruceActivity';
import type { VoiceCall, VoiceCallState, VoiceLine } from '../bruceVoice';
import { startVoiceCall, voiceSupported } from '../bruceVoice';
import { DashboardShell } from '../components/DashboardShell';
import { Markdown } from '../components/Markdown';
import { Popover } from '../components/Popover';
import {
  BookIcon,
  ChatIcon,
  ChevronRightIcon,
  GaugeIcon,
  GlobeIcon,
  KegIcon,
  MicIcon,
  MicOffIcon,
  MusicIcon,
  ThinkingDots,
} from '../components/icons';
import { useSettings } from '../settings';
import { usePoll } from '../usePoll';
import { clockTime, dateTime, relativeTime } from '../util';

/**
 * The Bruce page: a conversation with the brewery's assistant — typed or
 * spoken — plus the state of the brewery speaker alongside it.
 *
 * Three things answer here, and they fail independently, which is why they look
 * separate on screen:
 *
 * - The chat comes from the server, which retrieves passages from the brewing
 *   books in knowledge/ and answers from them. No microphone involved.
 * - The Talk button (VoiceBar, below) is this browser holding a Realtime
 *   session of its own — a phone, a laptop, the kiosk. It needs a microphone
 *   and therefore HTTPS, but nothing on the Pi beyond the API key.
 * - The right-hand rail proxies apps/bruce, the wake-word service, which needs
 *   real audio hardware in the brewery and is often simply not running.
 */

/** How often the voice-service rail refreshes. The chat is event-driven. */
const POLL_MS = 2000;

/**
 * What each step of answering looks like while it is happening.
 *
 * These are reported by the server as they start — the web line appears because
 * the model actually began a search, not because searching was permitted. That
 * is the whole point of listing them separately: "reading the books" and "out on
 * the web" cost different amounts of time and money, and used to be one
 * indistinguishable spinner.
 */
const PHASE_LOOK: Record<
  BrucePhaseName,
  { label: string; Icon: (props: { className?: string }) => JSX.Element; tint: string }
> = {
  library: { label: 'Searching the library', Icon: BookIcon, tint: 'text-zinc-400' },
  // The server sends the titles retrieval landed on as `detail`, so this reads
  // "Reading the books — Yeast, How to Brew" rather than naming no book at all.
  thinking: { label: 'Reading the books', Icon: BookIcon, tint: 'text-zinc-400' },
  // The one that had to be told apart from the rest: it is slower, it is billed
  // per search, and the answer stops being purely the brewery's own books.
  web: { label: 'Searching the web', Icon: GlobeIcon, tint: 'text-sky-400' },
  recipes: { label: 'Reading your recipe', Icon: KegIcon, tint: 'text-amber-400' },
  // He has put the books down and gone to look at the brewery itself — the
  // `detail` says which part (sensors, kegs, the to-do list, settings).
  brewery: { label: 'Checking the brewery', Icon: GaugeIcon, tint: 'text-emerald-400' },
  // The speaker is its own step rather than part of the brewery: "checking the
  // brewery" while he skips a track reads as though he were looking at sensors.
  music: { label: 'At the speaker', Icon: MusicIcon, tint: 'text-violet-400' },
  writing: { label: 'Writing the answer', Icon: ChatIcon, tint: 'text-zinc-400' },
};

/** Look of each assistant state: label, dot colour, and whether it pulses. */
const STATE_LOOK: Record<BruceState, { label: string; dot: string; pulse: boolean }> = {
  idle: { label: 'Idle — waiting for "Bruce!"', dot: 'bg-zinc-500', pulse: false },
  listening: { label: 'Listening…', dot: 'bg-emerald-400', pulse: true },
  thinking: { label: 'Thinking…', dot: 'bg-amber-400', pulse: true },
  speaking: { label: 'Speaking…', dot: 'bg-sky-400', pulse: true },
};

/** The app's warm accent, as used by every other primary button. */
const ACCENT_BUTTON =
  'bg-gradient-to-br from-[#f87a68] to-[#e0463f] text-white transition enabled:hover:brightness-110 disabled:opacity-40';

/** Where the real numbers live — this page only estimates (see server bruce/cost.ts). */
const OPENAI_BILLING_URL = 'https://platform.openai.com/settings/organization/billing/overview';

function formatTime(ts: number): string {
  return clockTime(ts, true);
}

/**
 * A thread's running cost, short enough to sit in a list row.
 *
 * Three decimals: one question of a cheap model lands around $0.002, so
 * anything coarser reads as free. Below a tenth of a cent it says so rather
 * than rounding to $0.000, which would look like a bug.
 */
function formatCost(usd: number): string {
  if (usd < 0.0005) return '<$0.001';
  return usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

// --- Chat -------------------------------------------------------------------

/**
 * The composer's resting height, in pixels: three lines of `text-sm` plus the
 * padding and border. Two lines was too mean — a question of any length spent
 * most of itself scrolled out of sight.
 */
const COMPOSER_MIN_PX = 78;

/**
 * Where it stops growing and starts scrolling instead. The page has room to
 * spare, but a composer that grew without limit would eventually push the
 * conversation it belongs to off the bottom of the screen.
 */
const COMPOSER_MAX_PX = 320;

/**
 * Grow a textarea to fit what's in it, between the two bounds above.
 *
 * Measured after every change to `value`, so it also shrinks back when the box
 * is emptied by sending. `useLayoutEffect` rather than `useEffect`: the height
 * is set before the browser paints, so typing past the end of a line doesn't
 * flash a scrollbar for a frame.
 */
function useAutoGrow(value: string): React.RefObject<HTMLTextAreaElement> {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Collapse first: `scrollHeight` can't report a *smaller* content height
    // while the element is still being held open at the taller one.
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, COMPOSER_MIN_PX), COMPOSER_MAX_PX)}px`;
  }, [value]);
  return ref;
}

/**
 * Citation chips under an answer: which book, section and page it came from,
 * and — when web search is on — which pages Bruce read on the internet.
 *
 * A web source carries a `url` and nothing else does, so the two are told apart
 * by that: books stay plain text, web pages become links that open in a new tab
 * and are marked with a ↗ so it's obvious which claims left the library.
 *
 * The third case is the quiet one. Retrieval hands Bruce its best few passages
 * for every question, whether or not they turn out to be relevant, so an answer
 * written entirely from the web used to appear over six book citations it never
 * opened. Those are folded away here and labelled as read rather than cited —
 * present, because he really was given them, but not passing as sources.
 */
function Sources({ message }: { message: BruceChatMessage }): JSX.Element | null {
  const [showRead, setShowRead] = useState(false);
  if (!message.sources || message.sources.length === 0) return null;

  // Passages retrieved for the question but never cited in the answer are not
  // sources for it — an answer written from the web listing six book pages
  // underneath claims a grounding it hasn't got. They still happened, so they
  // are kept, one fold away, described as what they are. `cited` is absent on
  // turns stored before this distinction existed, which read as cited.
  const used = message.sources.filter((source) => source.cited !== false);
  const read = message.sources.filter((source) => source.cited === false);

  const bookChip = (source: BruceChatSource, key: number, muted: boolean): JSX.Element => (
    <span
      key={key}
      className={`rounded-md px-1.5 py-0.5 text-[11px] ${
        muted ? 'bg-zinc-950/30 text-zinc-600' : 'bg-zinc-950/50 text-zinc-500'
      }`}
      title={[source.title, source.section].filter(Boolean).join(' — ')}
    >
      {source.title}
      {source.page && <span className={muted ? 'text-zinc-700' : 'text-zinc-600'}> p. {source.page}</span>}
    </span>
  );

  return (
    <div className="mt-2.5 border-t border-zinc-700/60 pt-2">
      <div className="flex flex-wrap gap-1.5">
        {used.map((source, i) =>
          source.url ? (
            <a
              key={i}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              title={source.url}
              className="max-w-[16rem] truncate rounded-md bg-sky-950/50 px-1.5 py-0.5 text-[11px] text-sky-400/90 transition hover:text-sky-300"
            >
              {source.title} ↗
            </a>
          ) : (
            bookChip(source, i, false)
          ),
        )}
      </div>

      {read.length > 0 && (
        <div className={used.length > 0 ? 'mt-1.5' : ''}>
          <button
            type="button"
            onClick={() => setShowRead((open) => !open)}
            title="Passages the library returned for this question that the answer doesn't cite"
            className="text-[11px] text-zinc-600 transition hover:text-zinc-400"
          >
            {showRead ? '▾' : '▸'} {read.length} more passage{read.length === 1 ? '' : 's'} read, not
            cited
          </button>
          {showRead && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {read.map((source, i) => bookChip(source, i, true))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The web-search switch, in the chat header beside the model picker.
 *
 * On by default, and deliberately visible rather than buried in settings: it
 * changes both where answers can come from and what each question costs, so it
 * should be as easy to see as it is to flip. The progress line says when a
 * search actually happens, so leaving it on doesn't mean losing track of it.
 */
function WebSearchToggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}): JSX.Element {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (): Promise<void> => {
    const next = !enabled;
    setSaving(true);
    setError(null);
    try {
      const { enabled: saved } = await api.setBruceWebSearch(next);
      onChange(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+:\s*/, '') : 'Could not change that');
    } finally {
      setSaving(false);
    }
  };

  return (
    <button
      type="button"
      disabled={saving}
      onClick={() => void toggle()}
      aria-pressed={enabled}
      title={
        error ??
        (enabled
          ? 'Bruce may search the web when the books are silent. Billed per search.'
          : 'Bruce answers from the library only. Click to let him search the web.')
      }
      className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition disabled:opacity-50 ${
        enabled
          ? 'border-sky-800 bg-sky-950/50 text-sky-300 hover:border-sky-700'
          : 'border-zinc-700 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300'
      }`}
    >
      <GlobeIcon className="h-3.5 w-3.5" />
      Web
      {error && <span className="text-red-400">!</span>}
    </button>
  );
}

/**
 * The bubble that stands in for the answer while it is being worked out, saying
 * which of Bruce's two sources he is on.
 *
 * Not a generic spinner: "searching the web" here means the model really did
 * start a web search a moment ago, which is worth knowing both because it is
 * slower and because it is billed per search.
 */
function PhaseBubble({ phase }: { phase: BrucePhase | null }): JSX.Element {
  const look = PHASE_LOOK[phase?.phase ?? 'library'];
  return (
    <div className="flex items-center gap-2 rounded-xl bg-zinc-800 px-3.5 py-2.5 text-sm">
      <look.Icon className={`h-4 w-4 shrink-0 ${look.tint}`} />
      <span className={look.tint}>
        {look.label}
        {phase?.detail && <span className="text-zinc-500"> — {phase.detail}</span>}
      </span>
      <ThinkingDots className={look.tint} />
    </div>
  );
}

/**
 * One tool Bruce called, as its own entry in the conversation.
 *
 * Its own line rather than a footnote on the answer, because it is a thing that
 * *happened* — he went and looked at the fermenter, or ticked a job off — and it
 * happened before the answer was written. It used to be visible only as a
 * progress line that vanished the moment the answer landed, so a reload left no
 * trace of which of the brewery's numbers he had actually read, or that he had
 * changed anything at all.
 *
 * Closed it is one quiet line. Opened it shows what he asked for and what came
 * back, which is where a wrong match becomes obvious — "ticked off *Order more
 * CO2*" reads fine until you see it matched the wrong job.
 */
function ToolCallEntry({ call }: { call: BruceToolCall }): JSX.Element {
  const [open, setOpen] = useState(false);
  const look = PHASE_LOOK[call.phase ?? 'brewery'];
  const args = call.args && Object.keys(call.args).length > 0 ? call.args : null;
  const detail = args || call.result;

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((was) => !was)}
          disabled={!detail}
          className="flex w-full items-center gap-2 text-left disabled:cursor-default"
          title={detail ? 'Show what he asked for and what came back' : undefined}
        >
          <look.Icon className={`h-3.5 w-3.5 shrink-0 ${look.tint}`} />
          <span className="text-xs text-zinc-400">
            {look.label}
            {call.detail && <span className="text-zinc-500"> — {call.detail}</span>}
          </span>
          <code className="truncate font-mono text-[10px] text-zinc-600">{call.name}</code>
          {detail && <span className="ml-auto shrink-0 text-[10px] text-zinc-600">{open ? '▾' : '▸'}</span>}
        </button>

        {open && detail && (
          <div className="mt-1.5 space-y-1.5 border-t border-zinc-800 pt-1.5">
            {args && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-zinc-500">
                {JSON.stringify(args, null, 2)}
              </pre>
            )}
            {call.result && (
              // Plain text, not rendered markdown: this is what the *model* was
              // handed, and dressing it up as prose would misrepresent it as
              // part of the answer.
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-zinc-400">
                {call.result}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: BruceChatMessage }): JSX.Element {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[92%] rounded-xl px-3.5 py-2.5 text-sm ${
          // Answers sit a shade below full brightness so that **bold** has
          // somewhere to go. At zinc-100 the emphasised words were already the
          // same white as everything around them, and only the weight said
          // otherwise — which is exactly the complaint. zinc-300 on zinc-800 is
          // still ~9:1, comfortably readable.
          isUser ? 'bg-emerald-950/60 text-emerald-100' : 'bg-zinc-800 text-zinc-300'
        }`}
      >
        {isUser ? <p className="whitespace-pre-wrap">{message.content}</p> : <Markdown text={message.content} />}
        <Sources message={message} />
      </div>
    </div>
  );
}

/**
 * An answer and the tools it was written from, in the order they happened: the
 * calls first, then the reply they fed.
 */
function AssistantTurn({ message }: { message: BruceChatMessage }): JSX.Element {
  return (
    <>
      {message.toolCalls?.map((call, i) => <ToolCallEntry key={`${message.id}-${i}`} call={call} />)}
      <ChatBubble message={message} />
    </>
  );
}

/** Shown in the composer's place when the server has no key to answer with. */
function MissingKeyNote(): JSX.Element {
  return (
    <p className="text-xs leading-relaxed text-amber-500/90">
      No <code className="text-amber-400">OPENAI_API_KEY</code> on the server — add it to{' '}
      <code className="text-amber-400">/etc/brewplanner.env</code> on the Pi, or a{' '}
      <code className="text-amber-400">.env</code> at the repo root in development, then restart
      the server.
    </p>
  );
}

/**
 * Model picker. Each option carries a plain-language note on what it is better
 * and worse at — the bare ids ("gpt-5.6-luna") say nothing about which one to
 * reach for. The blurbs come from the server, which measured them.
 *
 * The model in use is always listed, even if it came from BRUCE_CHAT_MODEL or
 * the model lookup failed.
 */
function ModelPicker({
  state,
  onChange,
}: {
  state: BruceChatState;
  onChange: (model: string) => void;
}): JSX.Element {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = state.models.some((m) => m.id === state.model)
    ? state.models
    : [{ id: state.model, label: 'In use', blurb: 'Set on the server.' }, ...state.models];

  const pick = async (model: string, close: () => void): Promise<void> => {
    close();
    if (model === state.model) return;
    setSaving(true);
    setError(null);
    try {
      const { model: saved } = await api.setBruceChatModel(model);
      onChange(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+:\s*/, '') : 'Could not change model');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover
      title={error ?? 'Which model answers your questions'}
      align="right"
      width="w-80"
      label={
        <span className="truncate">
          {saving ? 'Saving…' : state.model}
          {error && <span className="ml-1 text-red-400">!</span>}
        </span>
      }
    >
      {(close) => (
        <>
          <p className="px-2 pb-1 pt-1.5 text-[11px] text-zinc-500">
            All answer from the same books. They differ in cost, speed and how carefully they
            read.
          </p>
          {options.map((model) => {
            const active = model.id === state.model;
            return (
              <button
                key={model.id}
                type="button"
                onClick={() => void pick(model.id, close)}
                className={`block w-full rounded-lg px-2 py-1.5 text-left transition ${
                  active ? 'bg-zinc-800' : 'hover:bg-zinc-800/60'
                }`}
              >
                <div className="flex items-baseline gap-1.5">
                  <span className="text-xs font-medium text-zinc-100">{model.label}</span>
                  <span className="truncate font-mono text-[10px] text-zinc-500">{model.id}</span>
                  {active && <span className="ml-auto text-[10px] text-emerald-400">in use</span>}
                </div>
                <p className="mt-0.5 text-[11px] leading-snug text-zinc-400">{model.blurb}</p>
              </button>
            );
          })}
        </>
      )}
    </Popover>
  );
}

/**
 * The line under a thread's title: how big it is, what it has cost, and when it
 * was last used. Shared by the sidebar and the narrow-screen popover so the two
 * can't drift apart.
 *
 * The cost is an estimate the server works out from OpenAI's reported token
 * counts, and is simply absent on threads it couldn't price — nothing is shown
 * then, rather than a $0.000 that would read as "free".
 */
function ConversationMeta({ conversation }: { conversation: BruceConversation }): JSX.Element {
  return (
    <div className="text-[10px] text-zinc-500">
      {conversation.messages === 0
        ? 'empty'
        : `${conversation.messages} message${conversation.messages === 1 ? '' : 's'}`}
      {conversation.costUsd != null && (
        <span className="tabular-nums" title="Approximate OpenAI cost of this chat">
          {' · '}
          {formatCost(conversation.costUsd)}
        </span>
      )}
      {' · '}
      {relativeTime(conversation.updatedAt)}
    </div>
  );
}

/** Thread switcher: pick, start, rename or delete a conversation. */
function ConversationMenu({
  state,
  onSwitch,
  onNew,
  onRename,
  onDelete,
}: {
  state: BruceChatState;
  onSwitch: (id: number) => void;
  onNew: () => void;
  onRename: (id: number, title: string) => void;
  onDelete: (id: number) => void;
}): JSX.Element {
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  const startRename = (id: number, title: string): void => {
    setRenaming(id);
    setDraft(title);
  };

  const commitRename = (): void => {
    if (renaming != null && draft.trim()) onRename(renaming, draft.trim());
    setRenaming(null);
  };

  return (
    <Popover title="Switch chat" width="w-72" label={<span className="truncate">{state.conversation.title}</span>}>
      {(close) => (
        <>
          <button
            type="button"
            onClick={() => {
              close();
              onNew();
            }}
            className={`mb-1 block w-full rounded-lg px-2 py-1.5 text-left text-xs font-medium ${ACCENT_BUTTON}`}
          >
            + New chat
          </button>
          <div className="border-t border-zinc-800 pt-1">
            {state.conversations.map((conversation) => {
              const active = conversation.id === state.conversation.id;
              if (renaming === conversation.id) {
                return (
                  <input
                    key={conversation.id}
                    autoFocus
                    value={draft}
                    maxLength={80}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    className="mb-0.5 w-full rounded-lg border border-zinc-600 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 focus:outline-none"
                  />
                );
              }
              return (
                <div
                  key={conversation.id}
                  className={`group mb-0.5 flex items-center gap-1 rounded-lg px-2 py-1.5 ${
                    active ? 'bg-zinc-800' : 'hover:bg-zinc-800/60'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      close();
                      onSwitch(conversation.id);
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate text-xs text-zinc-100">{conversation.title}</div>
                    <ConversationMeta conversation={conversation} />
                  </button>
                  <button
                    type="button"
                    title="Rename"
                    onClick={() => startRename(conversation.id, conversation.title)}
                    className="shrink-0 px-1 text-[11px] text-zinc-600 opacity-0 transition group-hover:opacity-100 hover:text-zinc-300"
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    title="Delete this chat"
                    onClick={() => {
                      close();
                      onDelete(conversation.id);
                    }}
                    className="shrink-0 px-1 text-[11px] text-zinc-600 opacity-0 transition group-hover:opacity-100 hover:text-red-400"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Popover>
  );
}

/**
 * The always-visible thread list, in the manner of a chat app's sidebar.
 *
 * Same actions as ConversationMenu, which stays for narrow screens: below `lg`
 * this panel is hidden and the header popover takes over, so a phone or the
 * kiosk in portrait doesn't spend a third of its width on a list. The two are
 * never on screen at once.
 */
function ChatsPanel({
  state,
  onSwitch,
  onNew,
  onRename,
  onDelete,
}: {
  state: BruceChatState | null;
  onSwitch: (id: number) => void;
  onNew: () => void;
  onRename: (id: number, title: string) => void;
  onDelete: (id: number) => void;
}): JSX.Element {
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  const commitRename = (): void => {
    if (renaming != null && draft.trim()) onRename(renaming, draft.trim());
    setRenaming(null);
  };

  return (
    <section className="hidden h-fit flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-3 lg:sticky lg:top-5 lg:flex">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <h2 className="text-sm font-semibold text-zinc-400">Chats</h2>
        <button
          type="button"
          onClick={onNew}
          title="Start a new chat"
          className={`rounded-lg px-2 py-0.5 text-xs font-medium ${ACCENT_BUTTON}`}
        >
          + New
        </button>
      </div>

      {state == null ? (
        <p className="px-1 text-xs text-zinc-600">Loading…</p>
      ) : (
        <div className="max-h-[68vh] space-y-0.5 overflow-y-auto pr-0.5">
          {state.conversations.map((conversation) => {
            const active = conversation.id === state.conversation.id;
            if (renaming === conversation.id) {
              return (
                <input
                  key={conversation.id}
                  autoFocus
                  value={draft}
                  maxLength={80}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  className="w-full rounded-lg border border-zinc-600 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 focus:outline-none"
                />
              );
            }
            return (
              <div
                key={conversation.id}
                className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 ${
                  active ? 'bg-zinc-800' : 'hover:bg-zinc-800/60'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSwitch(conversation.id)}
                  className="min-w-0 flex-1 text-left"
                  title={conversation.title}
                >
                  <div className={`truncate text-xs ${active ? 'text-zinc-100' : 'text-zinc-300'}`}>
                    {conversation.title}
                  </div>
                  <ConversationMeta conversation={conversation} />
                </button>
                <button
                  type="button"
                  title="Rename"
                  onClick={() => {
                    setRenaming(conversation.id);
                    setDraft(conversation.title);
                  }}
                  className="shrink-0 px-1 text-[11px] text-zinc-600 opacity-0 transition group-hover:opacity-100 hover:text-zinc-300"
                >
                  ✎
                </button>
                <button
                  type="button"
                  title="Delete this chat"
                  onClick={() => onDelete(conversation.id)}
                  className="shrink-0 px-1 text-[11px] text-zinc-600 opacity-0 transition group-hover:opacity-100 hover:text-red-400"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// --- Talking to Bruce from this browser -------------------------------------

/** The look of a live call: what to call the state, and how the dot behaves. */
const CALL_LOOK: Record<VoiceCallState, { label: string; dot: string; pulse: boolean }> = {
  connecting: { label: 'Connecting…', dot: 'bg-amber-400', pulse: true },
  // The resting state of an open call. Named for what you can do, not for what
  // he is doing, because the answer to that is "waiting for you".
  listening: { label: 'Listening — just talk', dot: 'bg-emerald-400', pulse: true },
  thinking: { label: 'Thinking…', dot: 'bg-amber-400', pulse: true },
  speaking: { label: 'Speaking…', dot: 'bg-sky-400', pulse: true },
  ended: { label: 'Call ended', dot: 'bg-zinc-500', pulse: false },
};

/**
 * The Talk button and, once pressed, the call.
 *
 * This is Bruce's third front door and the only one that works from a sofa: the
 * brewery speaker needs the Pi's microphone and the wake word, and the composer
 * below needs both hands. Here the phone holds the conversation itself (see
 * bruceVoice.ts) — press once and talk, press again to hang up. There is no
 * wake word because there is a button, which is the same reason ChatGPT's voice
 * mode hasn't got one either.
 *
 * Each finished exchange is saved into the open thread as it completes, so what
 * was said out loud is in the same conversation as what was typed, and a call
 * cut short by a locked phone keeps everything up to that point.
 */
function VoiceBar({
  conversationId,
  onTurn,
}: {
  conversationId: number | undefined;
  onTurn: (reply: BruceChatReply) => void;
}): JSX.Element {
  const [call, setCall] = useState<VoiceCall | null>(null);
  const [state, setState] = useState<VoiceCallState>('ended');
  const [phase, setPhase] = useState<BrucePhase | null>(null);
  const [lines, setLines] = useState<VoiceLine[]>([]);
  /** Tools called in the exchange in flight; cleared when it is written down. */
  const [tools, setTools] = useState<BruceToolCall[]>([]);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // The thread to file turns under, read at save time rather than captured when
  // the call started: switching chats mid-call should move where they land.
  const threadRef = useRef(conversationId);
  threadRef.current = conversationId;

  // A live call is a billed microphone. Leaving the page must hang it up —
  // otherwise navigating away leaves Bruce listening to an empty room.
  const callRef = useRef<VoiceCall | null>(null);
  callRef.current = call;
  useEffect(() => () => callRef.current?.end(), []);

  const start = async (): Promise<void> => {
    if (starting || call) return;
    setStarting(true);
    setError(null);
    setLines([]);
    try {
      const live = await startVoiceCall({
        onState: (next) => {
          setState(next);
          if (next === 'ended') setCall(null);
        },
        onPhase: setPhase,
        onLine: (line) => setLines((prev) => [...prev.slice(-5), line]),
        onToolCall: (made) => setTools((prev) => [...prev, made]),
        onTurn: (question, answer, made) => {
          void api
            .saveBruceVoiceTurn(question, answer, threadRef.current, made)
            .then((reply) => {
              // It is in the thread above now, so the bar stops repeating it.
              setLines([]);
              setTools([]);
              onTurn(reply);
            })
            .catch(() => {
              // Losing the written copy is not worth ending a working call
              // over; the lines stay on screen instead of vanishing silently.
              setError('That exchange could not be saved to the chat.');
            });
        },
        onError: setError,
      });
      setCall(live);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the call.');
      setState('ended');
    } finally {
      setStarting(false);
    }
  };

  const hangUp = (): void => {
    call?.end();
    setCall(null);
    setPhase(null);
  };

  const toggleMute = (): void => {
    if (!call) return;
    const next = !muted;
    call.setMuted(next);
    setMuted(next);
  };

  // No microphone to be had: the browser only allows one over HTTPS or on
  // localhost. Said plainly, with the way round it, rather than as a dead
  // button — this is what a phone on the LAN's plain-HTTP address hits.
  if (!voiceSupported()) {
    return (
      <div className="mb-3 flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2">
        <MicIcon className="mt-0.5 h-4 w-4 shrink-0 text-zinc-600" />
        <p className="text-[11px] leading-relaxed text-zinc-500">
          Talking needs a microphone, which browsers only allow over HTTPS. Open the hub at its{' '}
          <span className="text-zinc-400">https address</span> on this device and the Talk button
          appears — the written chat below works either way.
        </p>
      </div>
    );
  }

  if (!call) {
    return (
      <div className="mb-3">
        <button
          type="button"
          onClick={() => void start()}
          disabled={starting}
          className={`flex w-full items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-medium ${ACCENT_BUTTON}`}
        >
          <MicIcon className="h-4 w-4" />
          {starting ? 'Connecting…' : 'Talk to Bruce'}
        </button>
        {error && <p className="mt-1.5 text-xs text-red-400">{error}</p>}
      </div>
    );
  }

  const look = CALL_LOOK[state];
  return (
    <div className="mb-3 rounded-lg border border-emerald-900/60 bg-emerald-950/20 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          {look.pulse && (
            <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${look.dot}`} />
          )}
          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${look.dot}`} />
        </span>
        <span className="text-sm text-zinc-200">{look.label}</span>
        {phase && (
          <span className="text-xs text-zinc-500">
            — {PHASE_LOOK[phase.phase].label.toLowerCase()}
            {phase.detail && ` (${phase.detail})`}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={toggleMute}
            aria-pressed={muted}
            title={muted ? 'Let Bruce hear you again' : 'Mute your microphone'}
            className={`rounded-lg border px-2 py-1 text-xs transition ${
              muted
                ? 'border-amber-800 bg-amber-950/40 text-amber-300'
                : 'border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
            }`}
          >
            {muted ? <MicOffIcon className="h-3.5 w-3.5" /> : <MicIcon className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={hangUp}
            className="rounded-lg bg-red-900/70 px-3 py-1 text-xs font-medium text-red-100 transition hover:bg-red-800"
          >
            End
          </button>
        </div>
      </div>

      {/* The exchange in flight. It clears as soon as the pair is written into
          the thread above, so nothing is on screen twice. */}
      {(lines.length > 0 || tools.length > 0) && (
        <div className="mt-2 space-y-0.5 border-t border-emerald-900/40 pt-2">
          {lines.map((line, i) => (
            <p key={`${line.at}-${i}`} className="text-xs leading-relaxed">
              <span className={line.role === 'user' ? 'text-emerald-400' : 'text-zinc-500'}>
                {line.role === 'user' ? 'You' : 'Bruce'}
              </span>{' '}
              <span className="text-zinc-300">{line.text}</span>
            </p>
          ))}
          {/* Named here as well as in the thread: something changing in the
              brewery mid-call should be visible while it is still a call. */}
          {tools.map((made, i) => (
            <p key={`tool-${i}`} className="text-[11px] text-zinc-500">
              <span className={PHASE_LOOK[made.phase ?? 'brewery'].tint}>
                {PHASE_LOOK[made.phase ?? 'brewery'].label}
              </span>
              {made.detail && <span className="text-zinc-600"> — {made.detail}</span>}{' '}
              <code className="font-mono text-[10px] text-zinc-600">{made.name}</code>
            </p>
          ))}
        </div>
      )}

      {error && <p className="mt-1.5 text-xs text-red-400">{error}</p>}
    </div>
  );
}

function Chat(): JSX.Element {
  const [state, setState] = useState<BruceChatState | null>(null);
  const [draft, setDraft] = useState('');
  /** The question already on screen while its answer is still being written. */
  const [pending, setPending] = useState<string | null>(null);
  /** What he is doing about it, streamed from the server as each step starts. */
  const [phase, setPhase] = useState<BrucePhase | null>(null);
  /** Tools called so far in the answer being written, shown as they finish. */
  const [liveTools, setLiveTools] = useState<BruceToolCall[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useAutoGrow(draft);

  const load = (conversationId?: number): void => {
    api
      .getBruceChat(conversationId)
      .then(setState)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message.replace(/^\d+:\s*/, '') : 'Could not load the conversation.');
      });
  };

  useEffect(() => {
    let stale = false;
    api
      .getBruceChat()
      .then((next) => {
        if (!stale) setState(next);
      })
      .catch((err: unknown) => {
        if (!stale) setError(err instanceof Error ? err.message : 'Could not load the conversation.');
      });
    return () => {
      stale = true;
    };
  }, []);

  // Follow the newest message, including the "reading…" placeholder. Keyed on
  // the thread too, so switching chats lands at the bottom of the new one.
  const messageCount = state?.messages.length ?? 0;
  const activeId = state?.conversation.id;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messageCount, pending, activeId]);

  const canAsk = state != null && state.configured && pending == null;

  const send = async (text: string): Promise<void> => {
    const question = text.trim();
    if (!question || !canAsk || !state) return;
    setDraft('');
    setPending(question);
    setLiveTools([]);
    // Start on the library: it is what the server does first, and saying so
    // straight away beats an empty bubble for the second before the stream
    // opens. Every phase after this one is reported, not assumed.
    setPhase({ phase: 'library' });
    setBrucePhase({ phase: 'library' });
    setError(null);
    try {
      const { question: asked, answer, conversation } = await api.askBruce(
        question,
        state.conversation.id,
        (next) => {
          setPhase(next);
          // The nav tab shows it too, so wandering off mid-question still shows
          // Bruce is working (and on what).
          setBrucePhase(next);
        },
        (call) => setLiveTools((prev) => [...prev, call]),
      );
      setState((prev) =>
        prev
          ? {
              ...prev,
              messages: [...prev.messages, asked, answer],
              // The thread may have just been auto-titled from this question.
              conversation,
              conversations: prev.conversations.map((c) => (c.id === conversation.id ? conversation : c)),
            }
          : prev,
      );
    } catch (err) {
      // Put the question back in the box so it isn't lost to a failed request.
      setDraft(question);
      setError(err instanceof Error ? err.message.replace(/^\d+:\s*/, '') : 'Bruce could not answer that.');
    } finally {
      setPending(null);
      setPhase(null);
      setBrucePhase(null);
      // The stored answer carries the same calls, so the live copies would
      // otherwise be on screen twice.
      setLiveTools([]);
    }
  };

  const clear = async (): Promise<void> => {
    if (!state || state.messages.length === 0) return;
    try {
      await api.clearBruceChat(state.conversation.id);
      setState({ ...state, messages: [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clear the conversation.');
    }
  };

  const newChat = async (): Promise<void> => {
    setError(null);
    try {
      const conversation = await api.newBruceConversation();
      load(conversation.id);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+:\s*/, '') : 'Could not start a chat.');
    }
  };

  const rename = async (id: number, title: string): Promise<void> => {
    try {
      const updated = await api.renameBruceConversation(id, title);
      setState((prev) =>
        prev
          ? {
              ...prev,
              conversation: prev.conversation.id === id ? updated : prev.conversation,
              conversations: prev.conversations.map((c) => (c.id === id ? updated : c)),
            }
          : prev,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+:\s*/, '') : 'Could not rename the chat.');
    }
  };

  const remove = async (id: number): Promise<void> => {
    try {
      await api.deleteBruceConversation(id);
      // Deleting the open thread falls back to the newest remaining one; the
      // server creates a fresh thread if that was the last.
      load(id === state?.conversation.id ? undefined : state?.conversation.id);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+:\s*/, '') : 'Could not delete the chat.');
    }
  };

  return (
    <>
      <ChatsPanel
        state={state}
        onSwitch={(id) => load(id)}
        onNew={() => void newChat()}
        onRename={(id, title) => void rename(id, title)}
        onDelete={(id) => void remove(id)}
      />

      <section className="flex min-h-[70vh] flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        {/* Below lg the panel is hidden, so the popover is the only way to
            switch threads; from lg it would be a second one, and the header
            shows which thread is open instead. */}
        {state && (
          <div className="lg:hidden">
            <ConversationMenu
              state={state}
              onSwitch={(id) => load(id)}
              onNew={() => void newChat()}
              onRename={(id, title) => void rename(id, title)}
              onDelete={(id) => void remove(id)}
            />
          </div>
        )}
        {state && (
          <h2 className="hidden min-w-0 truncate text-sm font-medium text-zinc-300 lg:block">
            {state.conversation.title}
          </h2>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* The per-chat figures on this page are estimates; this is the bill. */}
          <a
            href={OPENAI_BILLING_URL}
            target="_blank"
            rel="noreferrer"
            title="Your real OpenAI spend, on platform.openai.com"
            className="text-xs text-zinc-500 transition hover:text-zinc-300"
          >
            OpenAI billing ↗
          </a>
          {state?.configured && (
            <WebSearchToggle
              enabled={state.webSearch}
              onChange={(webSearch) => setState((prev) => (prev ? { ...prev, webSearch } : prev))}
            />
          )}
          {state?.configured && (
            <ModelPicker
              state={state}
              onChange={(model) => setState((prev) => (prev ? { ...prev, model } : prev))}
            />
          )}
          {state && state.messages.length > 0 && (
            <button
              type="button"
              onClick={() => void clear()}
              className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
              title="Empty this chat, keeping it in the list"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {state && !state.configured && (
        <div className="mb-3 border-b border-zinc-800 pb-2.5">
          <MissingKeyNote />
        </div>
      )}

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto pr-1" style={{ maxHeight: '62vh' }}>
        {state == null && !error && <p className="text-sm text-zinc-500">Loading…</p>}

        {state?.messages.map((message) =>
          message.role === 'assistant' ? (
            <AssistantTurn key={message.id} message={message} />
          ) : (
            <ChatBubble key={message.id} message={message} />
          ),
        )}

        {pending != null && (
          <>
            <div className="flex justify-end">
              <div className="max-w-[92%] rounded-xl bg-emerald-950/60 px-3.5 py-2.5 text-sm text-emerald-100">
                <p className="whitespace-pre-wrap">{pending}</p>
              </div>
            </div>
            {/* The calls land here as they finish, so the conversation builds up
                in front of you rather than appearing all at once at the end. */}
            {liveTools.map((call, i) => <ToolCallEntry key={`live-${i}`} call={call} />)}
            <div className="flex justify-start">
              <PhaseBubble phase={phase} />
            </div>
          </>
        )}
      </div>

      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

      <form
        className="mt-4 border-t border-zinc-800 pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        {/* Above the composer rather than beside it: talking and typing are two
            ways of asking the same Bruce, and the answers land in one thread. */}
        {state?.configured && (
          <VoiceBar
            conversationId={state.conversation.id}
            onTurn={({ question, answer, conversation }) =>
              setState((prev) =>
                prev
                  ? {
                      ...prev,
                      messages: [...prev.messages, question, answer],
                      conversation,
                      conversations: prev.conversations.map((c) =>
                        c.id === conversation.id ? conversation : c,
                      ),
                    }
                  : prev,
              )
            }
          />
        )}
        <div className="flex gap-2">
          {/* No `rows` and `resize-none`: useAutoGrow owns the height, so the
              box is always as tall as what has been typed into it. */}
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter breaks the line — chat convention.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
            maxLength={2000}
            disabled={state != null && !state.configured}
            placeholder={
              state != null && !state.configured ? 'Chat is not configured' : 'Ask Bruce something…'
            }
            className="min-w-0 flex-1 resize-none overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!canAsk || !draft.trim()}
            className={`shrink-0 self-end rounded-lg px-4 py-2 text-sm font-medium ${ACCENT_BUTTON}`}
          >
            {pending ? 'Asking…' : 'Ask'}
          </button>
        </div>
      </form>
      </section>
    </>
  );
}

// --- Voice service rail -----------------------------------------------------

/** Volume slider that follows the server value except while being dragged. */
function VolumeControl({ serverPercent }: { serverPercent: number }): JSX.Element {
  // Shown instead of the server value while the knob is being dragged — and
  // then until the poll reports the new volume back.
  const [local, setLocal] = useState<number | null>(null);
  const giveUp = useRef<ReturnType<typeof setTimeout> | null>(null);
  const value = local ?? serverPercent;

  const follow = (): void => {
    if (giveUp.current != null) clearTimeout(giveUp.current);
    giveUp.current = null;
    setLocal(null);
  };

  useEffect(
    () => () => {
      if (giveUp.current != null) clearTimeout(giveUp.current);
    },
    [],
  );

  // Hand the slider back to the server as soon as it reports the value we sent.
  // Waiting for that (rather than for the POST to resolve) is the point: the
  // rail only polls every POLL_MS, so `serverPercent` still holds the old
  // volume for up to a tick afterwards and the knob would snap back to it.
  // The timer is the escape hatch for a value that never lands — Bruce moving
  // the volume himself via set_volume — so a stale local can't mask him.
  useEffect(() => {
    if (local != null && local === serverPercent) follow();
  }, [local, serverPercent]);

  const commit = async (): Promise<void> => {
    if (local == null) return;
    try {
      // Trust the clamped value the service echoes back, not what we sent.
      const { volumePercent } = await api.bruceSetVolume(local);
      setLocal(volumePercent);
      if (giveUp.current != null) clearTimeout(giveUp.current);
      giveUp.current = setTimeout(follow, POLL_MS * 3);
    } catch {
      follow(); // The next poll re-syncs the slider to the real value.
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="text-zinc-400">Speech volume</span>
        <span className="tabular-nums text-zinc-200">{value}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={200}
        step={5}
        value={value}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={() => void commit()}
        onKeyUp={() => void commit()}
        className="w-full accent-emerald-400"
        aria-label="Bruce speech volume"
      />
      <div className="mt-0.5 flex justify-between text-[10px] text-zinc-600">
        <span>mute</span>
        <span>100 = normal</span>
        <span>200</span>
      </div>
    </div>
  );
}

/** Text box to make Bruce say something out loud in the brewery. */
function SpeakBox(): JSX.Element {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (): Promise<void> => {
    const text = message.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.bruceSpeak(text);
      setMessage('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div className="mb-1 text-sm text-zinc-400">Say something out loud</div>
      <div className="flex gap-2">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Speak in the brewery…"
          maxLength={500}
          className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || !message.trim()}
          className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition enabled:hover:bg-emerald-500 disabled:opacity-40"
        >
          {busy ? '…' : 'Say'}
        </button>
      </div>
      {error && <p className="mt-1.5 text-xs text-red-400">{error}</p>}
    </form>
  );
}

// --- The mic meter ----------------------------------------------------------
// Off unless Settings → Bruce turns it on. See MicMeter for what it is for.

/** How often the meter refreshes. Fast enough to watch a phrase land. */
const LEVEL_POLL_MS = 400;

/**
 * Quietest level the meter draws, in dBFS. Speech across a room lands around
 * −45 dBFS and a quiet room's own hiss around −58, so a linear scale would
 * squash every interesting reading into the bottom pixel.
 */
const LEVEL_FLOOR_DB = -66;

/** A PCM16 level (0–32768) as a 0–1 height on that scale. */
function levelHeight(value: number): number {
  if (value <= 0) return 0;
  const db = 20 * Math.log10(value / 32768);
  return Math.max(0, Math.min(1, (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB));
}

/** Peak this close to full scale means the capture gain itself is clipping. */
const CLIPPING = 32000;

/** One trace of bars, oldest → newest, drawn right-aligned so "now" is the right edge. */
function Trace({
  bars,
  heightClass,
}: {
  bars: { height: number; className: string }[];
  heightClass: string;
}): JSX.Element {
  return (
    <div className={`flex items-end gap-px overflow-hidden rounded bg-zinc-950 ${heightClass}`}>
      {bars.map((bar, i) => (
        <div
          key={i}
          className={`min-w-0 flex-1 rounded-sm ${bar.className}`}
          // A floor of 1px keeps silence readable as "the meter is running,
          // and there is nothing there" rather than as a blank panel.
          style={{ height: `${Math.max(bar.height * 100, 1.5)}%` }}
        />
      ))}
    </div>
  );
}

/**
 * What Bruce's microphone is hearing, live.
 *
 * The point is to separate three faults that all present as "he doesn't hear
 * me from over there": the mic not picking the phrase up (level trace barely
 * moves), the room being as loud as the phrase (level moves but never clears
 * the noise-floor line), or the wake model scoring a perfectly audible phrase
 * too low (level is fine, score stays under the threshold line). The first two
 * are fixed with hardware and placement, the third only by retraining — so
 * knowing which one it is decides the whole afternoon.
 *
 * Both traces cover the same six seconds: say "hey Bruce" from where he misses
 * you, then read them.
 */
function MicMeter(): JSX.Element {
  const [levels, setLevels] = useState<BruceMicLevelsResponse | null>(null);

  usePoll(async (isStale) => {
    try {
      const next = await api.getBruceMicLevels();
      if (!isStale()) setLevels(next);
    } catch {
      if (!isStale()) setLevels({ online: false });
    }
  }, LEVEL_POLL_MS);

  if (levels == null || !levels.online) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-600">
        {levels == null ? 'Reading the microphone…' : 'No microphone reading — Bruce stopped answering.'}
      </div>
    );
  }

  const { samples, noiseFloor, threshold, gain, gainMode } = levels;
  // The two numbers actually worth reading: you cannot watch a live bar while
  // saying the phrase, so the meter keeps the best of the window for you.
  const loudest = samples.reduce((max, s) => Math.max(max, s.peak), 0);
  const bestScore = samples.reduce<number | null>(
    (max, s) => (s.score == null ? max : Math.max(max ?? 0, s.score)),
    null,
  );
  const clipping = loudest >= CLIPPING;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Microphone</h3>
        <span className="text-[11px] tabular-nums text-zinc-500">
          {gain == null ? '—' : `×${gain.toFixed(1)}`}
          {gainMode === 'auto' && <span className="ml-1 text-zinc-600">auto</span>}
        </span>
      </div>

      <div className="relative">
        <Trace
          heightClass="h-14"
          bars={samples.map((s) => ({
            height: levelHeight(s.rms),
            className: s.peak >= CLIPPING ? 'bg-rose-500' : 'bg-emerald-500/80',
          }))}
        />
        {/* Where the room sits. A phrase has to clear this line by a good
            margin — amplification lifts both, so it can never close the gap. */}
        {noiseFloor != null && noiseFloor > 0 && (
          <div
            className="pointer-events-none absolute inset-x-0 border-t border-dashed border-amber-500/60"
            style={{ bottom: `${levelHeight(noiseFloor) * 100}%` }}
          />
        )}
      </div>

      <dl className="flex justify-between text-[11px] tabular-nums text-zinc-500">
        <div className="flex gap-1">
          <dt>loudest 6 s</dt>
          <dd className={clipping ? 'text-rose-400' : 'text-zinc-300'}>{loudest}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-amber-500/80">room</dt>
          <dd className="text-zinc-300">{noiseFloor == null ? '—' : Math.round(noiseFloor)}</dd>
        </div>
      </dl>

      <div className="relative">
        <Trace
          heightClass="h-8"
          bars={samples.map((s) => ({
            height: s.score ?? 0,
            className:
              s.score != null && threshold != null && s.score >= threshold
                ? 'bg-emerald-400'
                : 'bg-sky-500/70',
          }))}
        />
        {threshold != null && (
          <div
            className="pointer-events-none absolute inset-x-0 border-t border-dashed border-emerald-400/60"
            style={{ bottom: `${threshold * 100}%` }}
          />
        )}
      </div>

      <dl className="flex justify-between text-[11px] tabular-nums text-zinc-500">
        <div className="flex gap-1">
          <dt>best “hey Bruce” score</dt>
          <dd className="text-zinc-300">{bestScore == null ? '—' : bestScore.toFixed(3)}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-emerald-400/80">wakes at</dt>
          <dd className="text-zinc-300">{threshold == null ? '—' : threshold.toFixed(2)}</dd>
        </div>
      </dl>

      <p className="text-[11px] leading-relaxed text-zinc-600">
        {clipping
          ? 'The microphone is clipping — turn its capture gain down in alsamixer, distortion scores worse than quiet.'
          : 'Say “hey Bruce” from where he misses you. Level barely moving means the mic never heard it; level clear of the room line but the score short of the wake line means he heard it and didn’t recognise it.'}
      </p>
    </div>
  );
}

/** One line of the live voice transcript. */
function TranscriptLine({ entry }: { entry: BruceTranscriptEntry }): JSX.Element {
  if (entry.type === 'function_call' || entry.type === 'system') {
    return (
      <div className="flex items-baseline gap-2 py-0.5 text-[11px] text-zinc-600">
        <span className={entry.type === 'function_call' ? 'font-mono' : 'italic'}>
          {entry.type === 'function_call' ? `ƒ ${entry.content}` : entry.content}
        </span>
      </div>
    );
  }
  const isUser = entry.type === 'user';
  return (
    <div className="py-0.5 text-xs">
      <span className={`font-semibold ${isUser ? 'text-emerald-400' : 'text-zinc-400'}`}>
        {isUser ? 'You' : 'Bruce'}
      </span>
      <span className="ml-1.5 text-zinc-600 tabular-nums">{formatTime(entry.timestamp)}</span>
      <div className="text-zinc-300">{entry.content}</div>
    </div>
  );
}

function VoiceRail({ status }: { status: BruceServiceStatus | null }): JSX.Element {
  // Settings → Bruce → Microphone diagnostics. Off by default: the meter polls
  // several times a second, which a kiosk left on a wall has no reason to do.
  const { bruceMicDebug: micDebug } = useSettings();

  if (status == null) {
    return (
      <section className="h-fit rounded-xl border border-zinc-800 bg-zinc-900 p-5 text-sm text-zinc-500">
        Loading…
      </section>
    );
  }

  if (!status.online) {
    return (
      <section className="h-fit rounded-xl border border-zinc-800 bg-zinc-900 p-5">
        <div className="mb-2 flex items-center gap-2">
          <MicIcon className="h-4 w-4 text-zinc-600" />
          <h2 className="text-sm font-semibold text-zinc-400">Brewery speaker — offline</h2>
        </div>
        <p className="text-xs leading-relaxed text-zinc-600">
          The hands-free Bruce in the brewery — say &ldquo;Bruce!&rdquo; across the room — needs the
          microphone and speaker on the Pi. When the hardware is in, enable it with{' '}
          <code className="text-zinc-500">sudo systemctl enable --now bruce.service</code> — see
          deploy/README-bruce.md. This is only about that speaker: the chat, and the Talk button on
          it, work from any phone or laptop without it.
        </p>
      </section>
    );
  }

  return (
    <section className="h-fit space-y-5 rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="flex items-center gap-3">
        <span className="relative flex h-3 w-3">
          {STATE_LOOK[status.state].pulse && (
            <span
              className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${STATE_LOOK[status.state].dot}`}
            />
          )}
          <span className={`relative inline-flex h-3 w-3 rounded-full ${STATE_LOOK[status.state].dot}`} />
        </span>
        <span className="text-sm font-medium text-zinc-100">{STATE_LOOK[status.state].label}</span>
      </div>

      <dl className="space-y-2 text-sm">
        <div className="flex justify-between gap-2">
          <dt className="text-zinc-500">OpenAI session</dt>
          <dd className={status.connected ? 'text-emerald-400' : 'text-zinc-400'}>
            {/* The session closes between conversations by design. */}
            {status.connected ? 'Connected' : 'Standby'}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-zinc-500">Voice model</dt>
          <dd className="truncate text-zinc-200">{status.model}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-zinc-500">Service up since</dt>
          <dd className="text-zinc-200">{relativeTime(status.startedAt)}</dd>
        </div>
      </dl>

      {micDebug && <MicMeter />}

      <VolumeControl serverPercent={status.volumePercent} />
      <SpeakBox />

      {status.transcript.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Spoken recently
          </h3>
          {/* The voice transcript is a separate, in-memory ring in apps/bruce —
              it is not part of the written thread and is lost on restart. */}
          <div className="max-h-64 space-y-0.5 overflow-y-auto pr-1">
            {status.transcript.slice(-20).map((entry, i) => (
              <TranscriptLine key={`${entry.timestamp}-${i}`} entry={entry} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// --- The library ------------------------------------------------------------

/** How often the library refreshes while a rebuild is running. */
const JOB_POLL_MS = 1500;

/** Progress of a rebuild, or why it stopped. Silent once a build has landed. */
function IndexJobLine({ job }: { job: BruceIndexJob }): JSX.Element | null {
  if (job.state === 'running') {
    const percent = job.total > 0 ? Math.round((job.embedded / job.total) * 100) : 0;
    return (
      <div>
        <div className="mb-1 flex items-baseline justify-between gap-2 text-[11px]">
          <span className="truncate text-zinc-400">
            Indexing{job.note ? ` ${job.note}` : ''}…
          </span>
          <span className="shrink-0 tabular-nums text-zinc-500">
            {job.embedded}/{job.total}
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    );
  }
  if (job.state === 'failed') {
    return <p className="text-[11px] leading-relaxed text-red-400">Indexing failed: {job.error}</p>;
  }
  // A finished build speaks for itself — the book appears in the list above and
  // "Indexed just now" updates. Only the no-op case needs saying out loud.
  if (job.total === 0) {
    return <p className="text-[11px] text-zinc-500">Everything was already indexed.</p>;
  }
  return null;
}

/**
 * Bruce's instructions, editable. This is knowledge/PROMPT.md — the persona
 * sent with every question — which until now meant an SSH session and a text
 * editor on the Pi. Full-screen rather than in the card because a persona is
 * paragraphs, not a field.
 */
function InstructionsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [loaded, setLoaded] = useState<BruceInstructions | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    api
      .getBruceInstructions()
      .then((next) => {
        if (stale) return;
        setLoaded(next);
        setText(next.text);
      })
      .catch((err: unknown) => {
        if (!stale) setError(err instanceof Error ? err.message : 'Could not load the instructions.');
      });
    return () => {
      stale = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  /** Empty text deletes PROMPT.md server-side, which is the revert. */
  const save = async (next: string, close: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveBruceInstructions(next);
      setLoaded(saved);
      setText(saved.text);
      if (close) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+:\s*/, '') : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Bruce's instructions"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm"
      />

      <div className="relative z-10 flex max-h-[90vh] w-full max-w-3xl flex-col rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/50">
        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-5 py-3.5">
          <h2 className="text-base font-semibold tracking-tight text-zinc-50">
            Bruce&rsquo;s instructions
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
          >
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <p className="mb-3 text-xs leading-relaxed text-zinc-500">
            How Bruce answers in writing: sent with every question, on top of the passages
            retrieved from the books. Saved as{' '}
            <code className="text-zinc-400">knowledge/PROMPT.md</code> and used from the next
            question — nothing needs restarting. The voice assistant keeps its own, shorter
            instructions.
          </p>

          {loaded == null && !error && <p className="text-sm text-zinc-500">Loading…</p>}
          {loaded != null && (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={18}
              maxLength={20000}
              spellCheck={false}
              className="w-full resize-y rounded-lg border border-zinc-800 bg-zinc-900 p-3 font-mono text-xs leading-relaxed text-zinc-200 focus:border-zinc-600 focus:outline-none"
            />
          )}
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 px-5 py-3">
          <span className="text-[11px] text-zinc-600">
            {loaded?.custom ? 'Using knowledge/PROMPT.md' : 'Using the built-in instructions'}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !loaded?.custom}
              onClick={() => void save('', false)}
              title="Delete knowledge/PROMPT.md and go back to the built-in persona"
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition enabled:hover:border-zinc-600 enabled:hover:text-zinc-200 disabled:opacity-40"
            >
              Revert to built-in
            </button>
            <button
              type="button"
              disabled={busy || loaded == null || text.trim() === loaded.text.trim()}
              onClick={() => void save(text, true)}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-emerald-500 disabled:opacity-40"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A book off the shelf, opened for reading.
 *
 * Everything Bruce quotes lives in these files, and until now the only way to
 * see what was actually in one was to SSH to the Pi and page through raw
 * markdown. It reads a chapter at a time — the books are ~600 KB each, which is
 * a slow request over the tunnel and slower still to render on the kiosk — with
 * the table of contents down the side.
 */
/** Id prefix for the reader's heading anchors — see Markdown's `anchors` prop. */
const ANCHOR_PREFIX = 'book-heading-';

/**
 * How far down the reading pane the "you are here" line sits, in pixels.
 *
 * A heading counts as the section you are in once it has scrolled to within
 * this much of the top. On the line itself, a heading would only light up its
 * section after it had left the screen entirely.
 */
const READING_LINE_PX = 96;

function BookModal({ file, onClose }: { file: string; onClose: () => void }): JSX.Element {
  const [book, setBook] = useState<BruceBook | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Anchor of the section currently under the reading line; null above the first. */
  const [readingAnchor, setReadingAnchor] = useState<number | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  const open = (chapter?: number): void => {
    setLoading(true);
    setError(null);
    api
      .getBruceBook(file, chapter)
      .then((next) => {
        setBook(next);
        // A new chapter starts at its top, not wherever the last one was left.
        if (pageRef.current) pageRef.current.scrollTop = 0;
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message.replace(/^\d+:\s*/, '') : 'Could not open that book.');
      })
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps -- opening is keyed on the file alone
  useEffect(() => open(), [file]);

  /**
   * Scroll a section's heading into view. The ids are handed to Markdown as
   * `anchors` below and numbered the same way the server numbered the sections,
   * so this is a lookup rather than a search through the rendered text.
   */
  const jumpTo = (anchor: number): void => {
    document.getElementById(`${ANCHOR_PREFIX}${anchor}`)?.scrollIntoView({ block: 'start' });
  };

  /**
   * Follow the reading position: the contents rail lights up whichever section
   * the text on screen belongs to, so a long chapter says where you are in it
   * rather than only where you jumped from.
   *
   * Measured on scroll rather than with an IntersectionObserver — "the last
   * heading above the line" is one pass over a handful of elements and says
   * exactly what it means, where an observer would have to infer the same
   * answer from which headings happen to be visible. Coalesced onto animation
   * frames so a fast scroll measures once per paint.
   */
  useEffect(() => {
    const pane = pageRef.current;
    const sections = book?.chapter.sections;
    if (!pane || !sections || sections.length === 0) return;

    let frame = 0;
    const measure = (): void => {
      frame = 0;
      const line = pane.getBoundingClientRect().top + READING_LINE_PX;
      let current: number | null = null;
      // Sections come in document order, so the last one to start above the
      // line is the one being read.
      for (const section of sections) {
        const heading = document.getElementById(`${ANCHOR_PREFIX}${section.anchor}`);
        if (heading && heading.getBoundingClientRect().top <= line) current = section.anchor;
      }
      setReadingAnchor(current);
    };
    const onScroll = (): void => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    pane.addEventListener('scroll', onScroll, { passive: true });
    measure(); // the chapter may open already scrolled past its first heading
    return () => {
      pane.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
    // `loading` as well as `book`: the two land in separate renders, and the
    // headings only exist in the DOM once the second one has drawn the chapter.
  }, [book, loading]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const current = book?.chapter.id ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={book?.title ?? file}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm"
      />

      {/* 90rem rather than the old 5xl (64rem): wide enough to hold a couple of
          screens' worth of a chapter, still bounded so it doesn't sprawl on a
          large monitor. Smaller displays are capped by the viewport anyway. */}
      <div className="relative z-10 flex max-h-[92vh] w-full max-w-[90rem] flex-col rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/50">
        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold tracking-tight text-zinc-50">
              {book?.title ?? file}
            </h2>
            <p className="truncate font-mono text-[10px] text-zinc-600">{file}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
          >
            Close
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* The contents list. Hidden on a phone, where it would take the whole
              screen; the chapter itself is what you came for. */}
          {book && book.chapters.length > 1 && (
            <nav className="hidden w-60 shrink-0 overflow-y-auto border-r border-zinc-800 p-2 sm:block">
              {book.chapters.map((chapter) => (
                <div key={chapter.id}>
                  <button
                    type="button"
                    onClick={() => open(chapter.id)}
                    title={chapter.title}
                    className={`mb-0.5 block w-full rounded-lg px-2 py-1.5 text-left text-xs leading-snug transition ${
                      chapter.id === current
                        ? 'bg-zinc-800 text-zinc-100'
                        : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
                    }`}
                  >
                    {chapter.title}
                  </button>
                  {/* Sections only under the chapter you have open. Listing
                      every chapter's would be four hundred lines of contents
                      for a book with nineteen chapters in it. */}
                  {chapter.id === current &&
                    chapter.sections.map((section) => {
                      // Lit while the text on screen belongs to this section —
                      // the rail doubles as a position marker in a long chapter.
                      const here = section.anchor === readingAnchor;
                      return (
                        <button
                          key={section.anchor}
                          type="button"
                          onClick={() => jumpTo(section.anchor)}
                          title={section.title}
                          aria-current={here ? 'location' : undefined}
                          className={`mb-0.5 block w-full truncate border-l-2 py-1 pl-3 pr-2 text-left text-[11px] leading-snug transition ${
                            here
                              ? 'border-[#f87a68] font-medium text-zinc-200'
                              : 'border-transparent text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
                          }`}
                        >
                          {section.title}
                        </button>
                      );
                    })}
                </div>
              ))}
            </nav>
          )}

          <div ref={pageRef} className="min-w-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6 sm:py-5">
            {loading && <p className="text-sm text-zinc-500">Opening…</p>}
            {error && <p className="text-sm text-red-400">{error}</p>}
            {!loading && book && (
              // Fills the pane rather than sitting inside a `max-w-prose`
              // column: this is a reference book being consulted, not an essay
              // being read end to end, and the empty right-hand half was just
              // fewer paragraphs per screen.
              <article className="text-sm text-zinc-300">
                <Markdown text={book.chapter.content} anchors={ANCHOR_PREFIX} />
              </article>
            )}
          </div>
        </div>

        {/* Chapter paging, so the reader works without the contents list. */}
        {book && book.chapters.length > 1 && (
          <div className="flex items-center justify-between gap-2 border-t border-zinc-800 px-5 py-2.5 text-xs">
            <button
              type="button"
              disabled={current === 0}
              onClick={() => open(current - 1)}
              className="rounded-lg border border-zinc-700 px-2.5 py-1 text-zinc-400 transition enabled:hover:border-zinc-600 enabled:hover:text-zinc-200 disabled:opacity-30"
            >
              ← Previous
            </button>
            <span className="truncate text-zinc-600">
              {current + 1} of {book.chapters.length}
            </span>
            <button
              type="button"
              disabled={current >= book.chapters.length - 1}
              onClick={() => open(current + 1)}
              className="rounded-lg border border-zinc-700 px-2.5 py-1 text-zinc-400 transition enabled:hover:border-zinc-600 enabled:hover:text-zinc-200 disabled:opacity-30"
            >
              Next →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** One indexed book, as the knowledge status reports it. */
type KnowledgeDocument = NonNullable<BruceKnowledgeState['knowledge']>['documents'][number];

/**
 * Books that belong behind the exBEERiments disclosure rather than on the
 * shelf itself. There are a dozen-odd of these volumes and one of everything
 * else, so listed flat they *are* the library — the books you actually pick up
 * get pushed off the bottom of the card.
 */
function isExbeeriment(doc: KnowledgeDocument): boolean {
  return /^brulosophy[_-]/i.test(doc.file);
}

/** One book on the shelf. Opens the reader. */
function BookRow({
  doc,
  onOpen,
}: {
  doc: KnowledgeDocument;
  onOpen: () => void;
}): JSX.Element {
  return (
    // Reading what Bruce read used to mean an SSH session; a book on a shelf
    // you can't open isn't much of a library.
    <button
      type="button"
      onClick={onOpen}
      title={`Read ${doc.title}`}
      className="-mx-1.5 block w-full rounded-lg px-1.5 py-1 text-left transition hover:bg-zinc-800/60"
    >
      <div className="text-xs font-medium leading-snug text-zinc-200">{doc.title}</div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-mono text-[10px] text-zinc-600">{doc.file}</span>
        <span className="shrink-0 text-[10px] text-zinc-600">
          {doc.passages.toLocaleString()} passages
        </span>
      </div>
    </button>
  );
}

/**
 * The exBEERiments, collapsed into one line. Closed by default: the point of
 * the group is that the rest of the shelf stays visible without scrolling.
 */
function ExbeerimentGroup({
  docs,
  onOpen,
}: {
  docs: KnowledgeDocument[];
  onOpen: (file: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const passages = docs.reduce((sum, doc) => sum + doc.passages, 0);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        title={open ? 'Collapse the exBEERiments' : `Show all ${docs.length} exBEERiment volumes`}
        className="-mx-1.5 flex w-full items-baseline gap-1.5 rounded-lg px-1.5 py-1 text-left transition hover:bg-zinc-800/60"
      >
        <ChevronRightIcon
          className={`h-3 w-3 shrink-0 self-center text-zinc-600 transition-transform ${
            open ? 'rotate-90' : ''
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium leading-snug text-zinc-200">
            Brülosophy exBEERiments
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[10px] text-zinc-600">
              {docs.length} {docs.length === 1 ? 'volume' : 'volumes'}
            </span>
            <span className="shrink-0 text-[10px] text-zinc-600">
              {passages.toLocaleString()} passages
            </span>
          </div>
        </div>
      </button>

      {open && (
        <ul className="mt-1 space-y-1 border-l border-zinc-800 pl-2.5">
          {docs.map((doc) => (
            <li key={doc.file}>
              <BookRow doc={doc} onOpen={() => onOpen(doc.file)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * What Bruce has read, and the controls for changing it: add a book, rebuild
 * the index, rewrite his instructions.
 *
 * It owns its own data rather than reading the chat's copy, because a rebuild
 * has to be followed live — the card polls while a job runs and stops as soon
 * as it lands.
 */
function LibraryCard(): JSX.Element {
  const [state, setState] = useState<BruceKnowledgeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  /** The book being read, by file name; null when the reader is closed. */
  const [reading, setReading] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const running = state?.job?.state === 'running';
  usePoll(
    async (isStale) => {
      try {
        const next = await api.getBruceKnowledge();
        if (!isStale()) setState(next);
      } catch {
        // Keep the last known shelf through a transient failure.
      }
    },
    running ? JOB_POLL_MS : null,
    [running],
  );

  const upload = async (file: File): Promise<void> => {
    setError(null);
    if (!file.name.toLowerCase().endsWith('.md')) {
      setError('Bruce reads markdown — convert the book to .md first (see knowledge/README.md).');
      return;
    }
    setBusy(true);
    try {
      const content = await file.text();
      if (content.length > MAX_KNOWLEDGE_FILE_CHARS) {
        setError('That file is too large to index in one go.');
        return;
      }
      setState(await api.addBruceBook(file.name, content));
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+:\s*/, '') : 'Could not add that book.');
    } finally {
      setBusy(false);
    }
  };

  const rebuild = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      setState(await api.reindexBruceKnowledge());
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\d+:\s*/, '') : 'Could not rebuild.');
    } finally {
      setBusy(false);
    }
  };

  const knowledge = state?.knowledge;
  const documents = knowledge?.documents ?? [];
  const books = documents.filter((doc) => !isExbeeriment(doc));
  const exbeeriments = documents.filter(isExbeeriment);
  const buttonClass =
    'rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 transition enabled:hover:border-zinc-600 enabled:hover:text-zinc-200 disabled:opacity-40';

  return (
    <section className="h-fit space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-400">Library</h2>
        {knowledge && knowledge.documents.length > 0 && (
          <span className="text-[11px] text-zinc-600">
            {knowledge.passages.toLocaleString()} passages
          </span>
        )}
      </div>

      {state == null && <p className="text-xs text-zinc-600">Loading…</p>}
      {state != null && !state.configured && <MissingKeyNote />}

      {knowledge != null &&
        (knowledge.documents.length > 0 ? (
          <ul className="space-y-1">
            {books.map((doc) => (
              <li key={doc.file}>
                <BookRow doc={doc} onOpen={() => setReading(doc.file)} />
              </li>
            ))}
            {exbeeriments.length > 0 && (
              <li>
                <ExbeerimentGroup docs={exbeeriments} onOpen={setReading} />
              </li>
            )}
          </ul>
        ) : (
          <p className="text-xs leading-relaxed text-zinc-600">
            No books yet. Add a markdown book and Bruce answers from it, citing the page.
          </p>
        ))}

      {knowledge?.builtAt && !running && (
        <p
          className="text-[11px] text-zinc-600"
          title={dateTime(knowledge.builtAt)}
        >
          Indexed {relativeTime(knowledge.builtAt)}
        </p>
      )}

      {knowledge?.problem && (
        <p className="text-[11px] leading-relaxed text-amber-500/90">{knowledge.problem}</p>
      )}

      {state?.job && <IndexJobLine job={state.job} />}

      <div className="flex flex-wrap gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".md,text/markdown"
          className="hidden"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            // Cleared so picking the same file twice fires onChange again.
            e.target.value = '';
            if (picked) void upload(picked);
          }}
        />
        <button
          type="button"
          disabled={busy || running}
          onClick={() => fileRef.current?.click()}
          title="Upload a .md book into knowledge/ and index it"
          className={buttonClass}
        >
          {busy ? 'Working…' : 'Add a book'}
        </button>
        <button
          type="button"
          disabled={busy || running}
          onClick={() => void rebuild()}
          title="Re-index after editing the files on disk"
          className={buttonClass}
        >
          Rebuild
        </button>
        <button type="button" onClick={() => setEditing(true)} className={buttonClass}>
          Instructions
        </button>
      </div>

      {error && <p className="text-xs leading-relaxed text-red-400">{error}</p>}

      {editing && <InstructionsModal onClose={() => setEditing(false)} />}
      {reading && <BookModal file={reading} onClose={() => setReading(null)} />}
    </section>
  );
}

export function BrucePage(): JSX.Element {
  const [status, setStatus] = useState<BruceServiceStatus | null>(null);

  usePoll(async (isStale) => {
    try {
      const next = await api.getBruceStatus();
      if (!isStale()) setStatus(next);
    } catch {
      // Keep the last known status through a transient failure.
    }
  }, POLL_MS);

  return (
    <DashboardShell active="bruce">
      {/* Wider than the other pages: three columns at 1200px would leave the
          conversation itself about 640px, which reads badly for long answers. */}
      <main className="w-full max-w-[1400px] px-5 py-5">
        {/* Chat renders two grid children — the thread panel and the chat card
            — so the columns line up without nesting them in a wrapper. */}
        <div className="grid gap-4 lg:grid-cols-[210px_1fr_320px]">
          <Chat />
          <div className="space-y-4">
            <VoiceRail status={status} />
            <LibraryCard />
          </div>
        </div>
      </main>
    </DashboardShell>
  );
}
