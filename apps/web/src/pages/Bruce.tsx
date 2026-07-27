import { useEffect, useRef, useState } from 'react';
import type {
  BruceChatMessage,
  BruceChatState,
  BruceKnowledgeStatus,
  BruceServiceStatus,
  BruceState,
  BruceTranscriptEntry,
} from '@checklist/shared';
import { api } from '../api';
import { DashboardShell } from '../components/DashboardShell';
import { Markdown } from '../components/Markdown';
import { Popover } from '../components/Popover';
import { MicIcon } from '../components/icons';
import { usePoll } from '../usePoll';
import { relativeTime } from '../util';

/**
 * The Bruce page: a written conversation with the brewery's assistant, plus
 * the state of his voice service alongside it.
 *
 * The two halves are answered by different things. The chat comes from the
 * server, which retrieves passages from the brewing books in knowledge/ and
 * answers from them — it works with no microphone attached. The rail proxies
 * apps/bruce, the wake-word service, which needs real audio hardware and is
 * often simply not running.
 */

/** How often the voice-service rail refreshes. The chat is event-driven. */
const POLL_MS = 2000;

/** Look of each assistant state: label, dot colour, and whether it pulses. */
const STATE_LOOK: Record<BruceState, { label: string; dot: string; pulse: boolean }> = {
  idle: { label: 'Idle — waiting for "Bruce!"', dot: 'bg-zinc-500', pulse: false },
  listening: { label: 'Listening…', dot: 'bg-emerald-400', pulse: true },
  thinking: { label: 'Thinking…', dot: 'bg-amber-400', pulse: true },
  speaking: { label: 'Speaking…', dot: 'bg-sky-400', pulse: true },
};

/** Shown on an empty thread — also a hint at what he actually knows about. */
const STARTERS = [
  'What mash pH should I target for a pale ale, and why?',
  'How do I build a Burton-on-Trent water profile from RO water?',
  'What does high bicarbonate do to a dark beer?',
];

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// --- Chat -------------------------------------------------------------------

/** Citation chips under an answer: which book, section and page it came from. */
function Sources({ message }: { message: BruceChatMessage }): JSX.Element | null {
  if (!message.sources || message.sources.length === 0) return null;
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-zinc-700/60 pt-2">
      {message.sources.map((source, i) => (
        <span
          key={i}
          className="rounded-md bg-zinc-950/50 px-1.5 py-0.5 text-[11px] text-zinc-500"
          title={[source.title, source.section].filter(Boolean).join(' — ')}
        >
          {source.title}
          {source.page && <span className="text-zinc-600"> p. {source.page}</span>}
        </span>
      ))}
    </div>
  );
}

function ChatBubble({ message }: { message: BruceChatMessage }): JSX.Element {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[92%] rounded-xl px-3.5 py-2.5 text-sm ${
          isUser ? 'bg-emerald-950/60 text-emerald-100' : 'bg-zinc-800 text-zinc-100'
        }`}
      >
        {isUser ? <p className="whitespace-pre-wrap">{message.content}</p> : <Markdown text={message.content} />}
        <Sources message={message} />
      </div>
    </div>
  );
}

/** One line explaining what Bruce can currently answer from — or why he can't. */
function KnowledgeNote({ state }: { state: BruceChatState }): JSX.Element {
  if (!state.configured) {
    return (
      <p className="text-xs text-amber-500/90">
        No <code className="text-amber-400">OPENAI_API_KEY</code> on the server — add it to{' '}
        <code className="text-amber-400">/etc/brewplanner.env</code> on the Pi, or a{' '}
        <code className="text-amber-400">.env</code> at the repo root in development, then
        restart the server.
      </p>
    );
  }
  if (!state.knowledge.ready) {
    return <p className="text-xs text-amber-500/90">{state.knowledge.problem}</p>;
  }
  if (state.knowledge.documents.length === 0) {
    return <p className="text-xs text-zinc-600">Nothing indexed from the brewery library yet.</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-600">
      <KnowledgeLibrary knowledge={state.knowledge} />
      {state.knowledge.problem && <span className="text-amber-500/90">{state.knowledge.problem}</span>}
    </div>
  );
}

/**
 * The shelf itself: which books Bruce answers from, and how much of each was
 * indexed. Behind a popover because the titles are long and the answer to
 * "what has he read?" is wanted occasionally, not on every glance — but the
 * trigger still carries the summary so a glance is usually enough.
 */
function KnowledgeLibrary({ knowledge }: { knowledge: BruceKnowledgeStatus }): JSX.Element {
  const books = knowledge.documents.length;
  return (
    <Popover
      title="Which books Bruce answers from"
      width="w-80"
      label={
        <span className="truncate">
          {books} {books === 1 ? 'book' : 'books'} · {knowledge.passages.toLocaleString()} passages
        </span>
      }
    >
      {() => (
        <>
          <p className="px-2 pb-1 pt-1.5 text-[11px] text-zinc-500">
            Answers are retrieved from these files in <code className="text-zinc-400">knowledge/</code>.
          </p>
          {knowledge.documents.map((doc) => (
            <div key={doc.file} className="rounded-lg px-2 py-1.5">
              <div className="flex items-baseline gap-1.5">
                <span className="text-xs font-medium text-zinc-100">{doc.title}</span>
                <span className="ml-auto shrink-0 text-[10px] text-zinc-500">
                  {doc.passages.toLocaleString()} passages
                </span>
              </div>
              <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-500" title={doc.file}>
                {doc.file}
              </p>
            </div>
          ))}
          {knowledge.builtAt && (
            <p
              className="border-t border-zinc-800 px-2 pb-1 pt-1.5 text-[11px] text-zinc-500"
              title={new Date(knowledge.builtAt).toLocaleString()}
            >
              Indexed {relativeTime(knowledge.builtAt)}. Adding or editing a book means rebuilding —
              see <code className="text-zinc-400">npm run knowledge</code>.
            </p>
          )}
        </>
      )}
    </Popover>
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
            className="mb-1 block w-full rounded-lg px-2 py-1.5 text-left text-xs font-medium text-emerald-400 transition hover:bg-zinc-800/60"
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
                    <div className="text-[10px] text-zinc-500">
                      {conversation.messages === 0
                        ? 'empty'
                        : `${conversation.messages} message${conversation.messages === 1 ? '' : 's'}`}
                      {' · '}
                      {relativeTime(conversation.updatedAt)}
                    </div>
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

function Chat(): JSX.Element {
  const [state, setState] = useState<BruceChatState | null>(null);
  const [draft, setDraft] = useState('');
  /** The question already on screen while its answer is still being written. */
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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
    setError(null);
    try {
      const { question: asked, answer, conversation } = await api.askBruce(question, state.conversation.id);
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
    <section className="flex min-h-[70vh] flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        {state && (
          <ConversationMenu
            state={state}
            onSwitch={(id) => load(id)}
            onNew={() => void newChat()}
            onRename={(id, title) => void rename(id, title)}
            onDelete={(id) => void remove(id)}
          />
        )}
        <div className="flex shrink-0 items-center gap-2">
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

      {state && (
        <div className="mb-3 border-b border-zinc-800 pb-2.5">
          <KnowledgeNote state={state} />
        </div>
      )}

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto pr-1" style={{ maxHeight: '62vh' }}>
        {state == null && !error && <p className="text-sm text-zinc-500">Loading…</p>}

        {state != null && state.messages.length === 0 && pending == null && (
          <div className="py-6">
            <p className="mb-3 text-sm text-zinc-500">
              Ask about water chemistry, mash pH, or anything else in the brewery library.
            </p>
            <div className="flex flex-col items-start gap-2">
              {STARTERS.map((starter) => (
                <button
                  key={starter}
                  type="button"
                  disabled={!canAsk}
                  onClick={() => void send(starter)}
                  className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-left text-sm text-zinc-400 transition enabled:hover:border-zinc-700 enabled:hover:text-zinc-200 disabled:opacity-50"
                >
                  {starter}
                </button>
              ))}
            </div>
          </div>
        )}

        {state?.messages.map((message) => <ChatBubble key={message.id} message={message} />)}

        {pending != null && (
          <>
            <div className="flex justify-end">
              <div className="max-w-[92%] rounded-xl bg-emerald-950/60 px-3.5 py-2.5 text-sm text-emerald-100">
                <p className="whitespace-pre-wrap">{pending}</p>
              </div>
            </div>
            <div className="flex justify-start">
              <div className="rounded-xl bg-zinc-800 px-3.5 py-2.5 text-sm text-zinc-500">
                <span className="animate-pulse">Reading the books…</span>
              </div>
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
        <div className="flex gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter breaks the line — chat convention.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
            rows={2}
            maxLength={2000}
            disabled={state != null && !state.configured}
            placeholder={
              state != null && !state.configured ? 'Chat is not configured' : 'Ask Bruce something…'
            }
            className="min-w-0 flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!canAsk || !draft.trim()}
            className="shrink-0 self-end rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition enabled:hover:bg-emerald-500 disabled:opacity-40"
          >
            {pending ? 'Asking…' : 'Ask'}
          </button>
        </div>
      </form>
    </section>
  );
}

// --- Voice service rail -----------------------------------------------------

/** Volume slider that follows the server value except while being dragged. */
function VolumeControl({ serverPercent }: { serverPercent: number }): JSX.Element {
  const [local, setLocal] = useState<number | null>(null);
  const value = local ?? serverPercent;

  const commit = async (): Promise<void> => {
    if (local == null) return;
    try {
      await api.bruceSetVolume(local);
    } catch {
      // The next poll re-syncs the slider to the real value.
    }
    setLocal(null);
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
          <h2 className="text-sm font-semibold text-zinc-400">Voice — offline</h2>
        </div>
        <p className="text-xs leading-relaxed text-zinc-600">
          Talking to Bruce out loud needs the microphone and speaker on the Pi. The chat works
          without them. When the hardware is in, enable it with{' '}
          <code className="text-zinc-500">sudo systemctl enable --now bruce.service</code> — see
          deploy/README-bruce.md.
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
      <main className="w-full max-w-[1200px] px-5 py-5">
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <Chat />
          <VoiceRail status={status} />
        </div>
      </main>
    </DashboardShell>
  );
}
