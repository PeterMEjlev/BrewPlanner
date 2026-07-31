import type { BrucePhase, BruceToolCall } from '@checklist/shared';
import { MAX_TOOL_RESULT_CHARS } from '@checklist/shared';
import { api } from './api';

/**
 * Talking to Bruce from this browser — the machinery behind the Talk button on
 * the Bruce page.
 *
 * The call is held here, in the tab, not on the Pi: the page opens a WebRTC
 * session straight to OpenAI's Realtime API, sends the microphone up it and
 * plays what comes back. The server's part is minting the short-lived
 * credential that opens it and answering the tool calls that come out of it
 * (see apps/server/src/bruce/voice.ts for why the audio does not go through the
 * Pi).
 *
 * There is no wake word and no push-to-hold. Pressing the button opens a
 * conversation and it stays open: the model's own turn detection decides when
 * you have stopped speaking, answers, and listens again — including while it is
 * talking, so you can cut in. Pressing the button again hangs up.
 */

/** Where the SDP offer goes. The one OpenAI endpoint the browser talks to. */
const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

/** A hung SDP exchange must not leave the button spinning forever. */
const CONNECT_TIMEOUT_MS = 20000;

/**
 * What the call is doing, as the page draws it.
 *
 * `listening` is the resting state of an open call rather than a moment in it —
 * the session is always listening unless it is working or talking.
 */
export type VoiceCallState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ended';

/** One line of the live transcript, as it is spoken. */
export interface VoiceLine {
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

export interface VoiceCallbacks {
  onState: (state: VoiceCallState) => void;
  /** What he is doing about it — the tool he just reached for, or null. */
  onPhase: (phase: BrucePhase | null) => void;
  /** A finished line of speech, either side. */
  onLine: (line: VoiceLine) => void;
  /** A tool the model just called, as it finishes. */
  onToolCall: (call: BruceToolCall) => void;
  /** A question, its answer and the tools used — for saving into the thread. */
  onTurn: (question: string, answer: string, toolCalls: BruceToolCall[]) => void;
  onError: (message: string) => void;
}

/** The live call. Everything the page can do to one once it has started. */
export interface VoiceCall {
  /** Stop sending the microphone. Bruce keeps talking; he just can't hear you. */
  setMuted: (muted: boolean) => void;
  muted: () => boolean;
  /** Hang up: closes the session, the microphone and the speaker. */
  end: () => void;
}

/** A function call the model made, as it appears in a finished response. */
interface FunctionCallItem {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
}

/** The events read off the data channel. Everything else is ignored. */
interface RealtimeEvent {
  type?: string;
  transcript?: string;
  error?: { message?: string; code?: string };
  response?: { output?: FunctionCallItem[]; status?: string };
}

/**
 * The element Bruce's voice comes out of.
 *
 * A real element in the document rather than a bare `new Audio()`: iOS only
 * reliably plays a stream through one, and keeping a single element across
 * calls means the permission the first `play()` earned isn't asked for again.
 */
function speaker(): HTMLAudioElement {
  const existing = document.getElementById('bruce-voice-out');
  if (existing instanceof HTMLAudioElement) return existing;
  const audio = document.createElement('audio');
  audio.id = 'bruce-voice-out';
  audio.autoplay = true;
  // Stops iOS taking the stream full-screen over the page.
  audio.setAttribute('playsinline', '');
  audio.style.display = 'none';
  document.body.appendChild(audio);
  return audio;
}

/**
 * Whether this page is allowed a microphone at all.
 *
 * Browsers only hand one over in a secure context — HTTPS, or localhost. The
 * hub is reachable three ways and only two of them qualify: the Cloudflare
 * domain (HTTPS) and the Pi's own kiosk (localhost) can talk to Bruce; a phone
 * on `http://192.168.3.3` cannot, and the page says so rather than offering a
 * button that fails when pressed.
 */
export function voiceSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices?.getUserMedia != null &&
    typeof RTCPeerConnection !== 'undefined'
  );
}

/** Why the microphone was refused, in words worth showing someone. */
function micError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError') {
    return 'The microphone was blocked. Allow it for this site in your browser settings, then try again.';
  }
  if (name === 'NotFoundError') return 'No microphone was found on this device.';
  if (name === 'NotReadableError') return 'The microphone is in use by another app.';
  return err instanceof Error ? err.message : 'The microphone could not be opened.';
}

/**
 * Open a call. Resolves once Bruce is connected and listening; rejects if the
 * microphone, the credential or the session could not be had, in which case
 * nothing is left running.
 */
export async function startVoiceCall(callbacks: VoiceCallbacks): Promise<VoiceCall> {
  callbacks.onState('connecting');

  // The microphone first: it is the only step that asks the human a question,
  // and there is no sense spending a session credential before it is answered.
  // The three constraints are what make an open-mic call in a room work at all
  // — without echo cancellation Bruce hears himself and answers his own reply.
  let mic: MediaStream;
  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    callbacks.onState('ended');
    throw new Error(micError(err));
  }

  const stopMic = (): void => mic.getTracks().forEach((track) => track.stop());

  let session: Awaited<ReturnType<typeof api.startBruceVoice>>;
  try {
    session = await api.startBruceVoice();
  } catch (err) {
    stopMic();
    callbacks.onState('ended');
    throw new Error(
      err instanceof Error ? err.message.replace(/^\d+:\s*/, '') : 'Could not start a voice session.',
    );
  }

  const pc = new RTCPeerConnection();
  const audio = speaker();
  let ended = false;

  const end = (): void => {
    if (ended) return;
    ended = true;
    stopMic();
    try {
      pc.close();
    } catch {
      /* already closed */
    }
    audio.srcObject = null;
    callbacks.onPhase(null);
    callbacks.onState('ended');
  };

  pc.ontrack = (event) => {
    audio.srcObject = event.streams[0] ?? null;
    // Autoplay is normally granted here — the call started from a tap — but a
    // rejected promise must not become an unhandled one.
    void audio.play().catch(() => {});
  };

  // A dropped connection is the common failure once a call is up (a phone
  // sleeping, a train tunnel). Hang up rather than sit in a dead session.
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      if (!ended) callbacks.onError('The connection to Bruce dropped.');
      end();
    }
  };

  // One audio transceiver, negotiated both ways: the microphone goes up it and
  // Bruce's voice comes back down the same one, into `ontrack` above.
  for (const track of mic.getAudioTracks()) pc.addTrack(track, mic);

  const channel = pc.createDataChannel('oai-events');

  // --- Pairing what was said with what was answered ------------------------
  //
  // The two arrive on their own schedules: your words are transcribed by a
  // separate model and can land after the reply they prompted. So each side is
  // held until the other shows up, and only then is the exchange written down.
  // A reply that comes in two parts (he speaks, calls a tool, speaks again)
  // joins onto the one before it rather than starting a second turn — which is
  // what `answering` is for: the exchange is only written down once the model
  // has stopped going round the tool loop, not at the first thing it says.
  let pendingQuestion: string | null = null;
  let pendingAnswer: string | null = null;
  let pendingTools: BruceToolCall[] = [];
  let answering = false;

  const pairUp = (): void => {
    if (!answering && pendingQuestion && pendingAnswer) {
      callbacks.onTurn(pendingQuestion, pendingAnswer, pendingTools);
      pendingQuestion = null;
      pendingAnswer = null;
      pendingTools = [];
    }
  };

  const send = (event: unknown): void => {
    if (channel.readyState === 'open') channel.send(JSON.stringify(event));
  };

  /**
   * Run the tools the model asked for, hand back the results, and let it carry
   * on. Each one goes to the server, which owns the brewery's data and audits
   * the change — the browser only carries the message.
   */
  const runTools = async (calls: FunctionCallItem[]): Promise<void> => {
    for (const call of calls) {
      if (!call.call_id) continue;
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(call.arguments ?? '{}');
        if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
      } catch {
        /* an unreadable argument list is the tool's problem to report */
      }

      let output: string;
      let phase: BrucePhase | null = null;
      try {
        const result = await api.runBruceVoiceTool(call.name ?? '', args);
        phase = result.phase ?? null;
        callbacks.onPhase(phase);
        output = result.output;
      } catch (err) {
        // The model is told what went wrong so it can say so out loud, rather
        // than the call dying silently on a failed request.
        output = `That could not be done: ${
          err instanceof Error ? err.message.replace(/^\d+:\s*/, '') : 'the hub did not answer'
        }.`;
      }

      // Recorded whether it worked or not, and kept for the turn — a spoken
      // question should leave the same trail in the thread as a typed one.
      const record: BruceToolCall = {
        name: call.name ?? 'unknown',
        ...(phase ? { phase: phase.phase } : {}),
        ...(phase?.detail ? { detail: phase.detail } : {}),
        ...(Object.keys(args).length > 0 ? { args } : {}),
        result: output.length > MAX_TOOL_RESULT_CHARS ? `${output.slice(0, MAX_TOOL_RESULT_CHARS)}…` : output,
      };
      pendingTools.push(record);
      callbacks.onToolCall(record);

      if (ended) return;
      send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: call.call_id, output },
      });
    }
    if (ended) return;
    callbacks.onPhase(null);
    // Nothing has been said yet — the model called a tool instead of speaking.
    // This is what turns the result into an answer.
    send({ type: 'response.create' });
  };

  channel.onmessage = (message: MessageEvent<string>) => {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(message.data) as RealtimeEvent;
    } catch {
      return;
    }

    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        // You started talking over him: the API cancels his reply for us, so
        // the page only has to stop claiming he is speaking.
        callbacks.onState('listening');
        callbacks.onPhase(null);
        break;

      case 'conversation.item.input_audio_transcription.completed': {
        const text = event.transcript?.trim();
        if (!text) break;
        callbacks.onLine({ role: 'user', text, at: Date.now() });
        pendingQuestion = pendingQuestion ? `${pendingQuestion}\n${text}` : text;
        pairUp();
        break;
      }

      case 'response.created':
        answering = true;
        callbacks.onState('thinking');
        break;

      case 'response.output_audio_transcript.delta':
        // The first fragment of speech transcript is the moment he starts
        // actually talking — the audio itself arrives on the media track, where
        // the page cannot see it.
        callbacks.onState('speaking');
        break;

      case 'response.output_audio_transcript.done': {
        const text = event.transcript?.trim();
        if (!text) break;
        callbacks.onLine({ role: 'assistant', text, at: Date.now() });
        pendingAnswer = pendingAnswer ? `${pendingAnswer}\n\n${text}` : text;
        pairUp();
        break;
      }

      case 'response.done': {
        const calls = (event.response?.output ?? []).filter((item) => item.type === 'function_call');
        if (calls.length > 0) {
          // Still mid-exchange: the results go back and he answers from them,
          // so nothing is written down until that second response finishes.
          answering = true;
          callbacks.onState('thinking');
          void runTools(calls);
        } else {
          answering = false;
          callbacks.onState('listening');
          callbacks.onPhase(null);
          pairUp();
        }
        break;
      }

      case 'error': {
        const message = event.error?.message ?? 'The voice session hit an error.';
        // Cancelling a response that already finished is a race, not a fault.
        if (event.error?.code === 'response_cancel_not_active') break;
        callbacks.onError(message);
        break;
      }

      default:
        break;
    }
  };

  // --- The SDP exchange ----------------------------------------------------
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const res = await fetch(`${REALTIME_CALLS_URL}?model=${encodeURIComponent(session.model)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.clientSecret}`,
        'Content-Type': 'application/sdp',
      },
      body: offer.sdp ?? '',
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`OpenAI refused the call (${res.status}). ${(await res.text()).slice(0, 200)}`);
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
  } catch (err) {
    end();
    throw new Error(
      err instanceof Error ? `Could not connect to Bruce: ${err.message}` : 'Could not connect to Bruce.',
    );
  }

  callbacks.onState('listening');

  let muted = false;
  return {
    setMuted: (next: boolean) => {
      muted = next;
      for (const track of mic.getAudioTracks()) track.enabled = !next;
    },
    muted: () => muted,
    end,
  };
}
