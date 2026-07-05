'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');

// GA Realtime API only. The original beta protocol (OpenAI-Beta header,
// gpt-4o-*-realtime-preview models, `response.audio.*` events) was retired by
// OpenAI — the server now answers "The Realtime Beta API is no longer
// supported" and the preview models return model_not_found (verified
// 2026-07-05), so there is deliberately no legacy code path here.
const REALTIME_BASE_URL = 'wss://api.openai.com/v1/realtime';
const DEFAULT_MODEL = 'gpt-realtime-mini';
const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
const CONNECT_TIMEOUT_MS = 15000;

class RealtimeClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey - OpenAI API key
   * @param {string} [opts.voice='alloy'] - TTS voice
   * @param {string} [opts.systemPrompt=''] - System instructions for the assistant
   * @param {import('./FunctionRegistry')} opts.registry - Function registry instance
   * @param {string} [opts.model='gpt-realtime-mini'] - Realtime model id
   * @param {string} [opts.transcriptionModel='gpt-4o-mini-transcribe'] - Input transcription model
   */
  constructor({ apiKey, voice = 'alloy', systemPrompt = '', registry, model, transcriptionModel }) {
    super();
    this._apiKey = apiKey;
    this._voice = voice;
    this._systemPrompt = systemPrompt;
    this._registry = registry;
    this._model = model || DEFAULT_MODEL;
    this._transcriptionModel = transcriptionModel || DEFAULT_TRANSCRIPTION_MODEL;
    this._ws = null;
    this._sessionReady = false;
    this._streaming = false;
    // True while a close we asked for is in flight, so the engine can tell a
    // planned shutdown (idle timeout, stop()) from a dropped session.
    this._deliberateClose = false;
    // Set by cancelResponse(): swallow the response.done of the cancelled
    // response so the phase machine doesn't chain a new response from it.
    this._suppressNextResponseDone = false;
    // Accumulate function call arguments keyed by call_id
    this._pendingFunctionCalls = new Map();
    // Completed function calls waiting to be executed when response.done fires
    this._completedCalls = [];
    // Stores stringified function results to inject into the results-phase prompt
    this._lastFunctionResults = '';
    // Response phase: null | 'announce' | 'execute' | 'results'
    this._responsePhase = null;
  }

  /**
   * Open WebSocket and configure the session.
   * Resolves when the session is ready to receive audio.
   * Safe to call again after a disconnect — all per-session state is reset.
   * @returns {Promise<void>}
   */
  connect() {
    // Drop any half-dead previous socket before starting fresh.
    if (this._ws) {
      this._deliberateClose = true;
      try { this._ws.terminate(); } catch { /* already dead */ }
      this._ws = null;
    }
    this._sessionReady = false;
    this._streaming = false;
    this._deliberateClose = false;
    this._suppressNextResponseDone = false;
    this._pendingFunctionCalls.clear();
    this._completedCalls = [];
    this._lastFunctionResults = '';
    this._responsePhase = null;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${REALTIME_BASE_URL}?model=${encodeURIComponent(this._model)}`, {
        headers: { Authorization: `Bearer ${this._apiKey}` },
      });
      this._ws = ws;

      let settled = false;
      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        fn(arg);
      };

      // A hung TLS/WebSocket handshake must not wedge the caller forever.
      const connectTimer = setTimeout(() => {
        try { ws.terminate(); } catch { /* ignore */ }
        settle(reject, new Error('Timed out connecting to the OpenAI Realtime API'));
      }, CONNECT_TIMEOUT_MS);

      ws.on('message', (data) => {
        let event;
        try {
          event = JSON.parse(data.toString());
        } catch {
          return;
        }
        this._handleServerEvent(
          event,
          () => settle(resolve),
          (err) => settle(reject, err)
        );
      });

      ws.on('error', (err) => {
        this.emit('error', err);
        settle(reject, err);
      });

      ws.on('close', (code, reason) => {
        this._sessionReady = false;
        this._streaming = false;
        this.emit('disconnected', {
          code,
          reason: reason.toString(),
          deliberate: this._deliberateClose,
        });
        settle(reject, new Error(`Realtime connection closed during connect (code ${code})`));
      });
    });
  }

  disconnect() {
    if (this._ws) {
      this._deliberateClose = true;
      this._ws.close();
      this._ws = null;
    }
    this._sessionReady = false;
    this._streaming = false;
  }

  /**
   * Stream a PCM16 audio chunk to the Realtime API input buffer.
   * @param {Buffer} chunk - Raw PCM16 LE bytes
   */
  sendAudioChunk(chunk) {
    if (!this._sessionReady || !this._streaming) return;
    this._send({
      type: 'input_audio_buffer.append',
      audio: chunk.toString('base64'),
    });
  }

  /**
   * Begin accepting audio chunks for a new utterance.
   */
  startStreaming() {
    this._streaming = true;
  }

  /**
   * Finalize the audio input and trigger a model response.
   */
  commitAndRespond() {
    if (!this._sessionReady) return;
    this._streaming = false;
    this._send({ type: 'input_audio_buffer.commit' });
    // Phase 1: force speech-only so Bruce announces before calling functions
    this._responsePhase = 'announce';
    this._send({
      type: 'response.create',
      response: {
        tool_choice: 'none',
        instructions: 'Briefly announce what you are ABOUT to do (e.g. "Sure, let me turn those on for you"). Do NOT confirm completion or say you have done it — you have not performed the actions yet. Keep it to one short sentence.',
      },
    });
    this.emit('thinking');
  }

  /**
   * Inject a text message into the conversation and trigger a model response.
   * Used for unprompted speech (e.g. reminders) without requiring audio input.
   * @param {string} text - The text to send as a user message
   */
  sendText(text) {
    if (!this._sessionReady) return;
    this._send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
    this._responsePhase = null;
    this._send({ type: 'response.create' });
    this.emit('thinking');
  }

  /**
   * Cancel an in-progress response (for barge-in).
   *
   * If a phase is active, its response.done will still arrive (status
   * "cancelled") — flag it to be swallowed so the phase machine doesn't chain
   * a new response from it and start talking over the interrupting user. When
   * no phase is active (all responses finished, speaker just draining local
   * audio) there is nothing server-side to cancel; the cancel is still sent
   * and the resulting "no active response" error is ignored in the handler.
   */
  cancelResponse() {
    if (this._responsePhase !== null) {
      this._suppressNextResponseDone = true;
      this._responsePhase = null;
      this._completedCalls = [];
      this._lastFunctionResults = '';
    }
    this._send({ type: 'response.cancel' });
  }

  /**
   * Clear the input audio buffer without committing (e.g. when no speech was detected).
   */
  clearAudioBuffer() {
    this._streaming = false;
    this._send({ type: 'input_audio_buffer.clear' });
  }

  get isReady() {
    return this._sessionReady;
  }

  get responsePhase() {
    return this._responsePhase;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _send(event) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(event));
    }
  }

  /**
   * GA response modalities: exactly ['audio'] (transcript events come with
   * audio) or ['text'].
   * @private
   */
  _modalities(mods) {
    return { output_modalities: mods.includes('audio') ? ['audio'] : ['text'] };
  }

  _configureSession() {
    const tools = this._registry.getToolDefinitions();
    this._send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: this._systemPrompt,
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: this._transcriptionModel },
            // Disable server-side VAD — we commit audio manually after wake
            // word + silence detection
            turn_detection: null,
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice: this._voice,
          },
        },
        tools: tools,
        tool_choice: tools.length > 0 ? 'auto' : 'none',
      },
    });
  }

  /**
   * Re-send the session configuration (e.g. after a function was registered
   * post-connect, so the model actually sees the new tool).
   */
  refreshTools() {
    if (this._sessionReady) this._configureSession();
  }

  async _handleServerEvent(event, resolveConnect, rejectConnect) {
    switch (event.type) {
      case 'session.created':
        // Server is ready — send our configuration
        this._configureSession();
        break;

      case 'session.updated':
        // Our config was accepted — session is fully ready
        this._sessionReady = true;
        this.emit('ready');
        if (resolveConnect) resolveConnect();
        break;

      case 'response.output_audio.delta': {
        // Incremental TTS audio chunk (Base64 PCM16)
        const audioBuffer = Buffer.from(event.delta, 'base64');
        this.emit('audioChunk', audioBuffer);
        break;
      }

      case 'response.output_audio.done':
        this.emit('audioDone');
        break;

      case 'response.output_audio_transcript.done': {
        const text = event.transcript?.trim();
        if (text) this.emit('reply', text);
        break;
      }

      case 'response.output_item.added': {
        // Capture function name when the output item is first announced
        const item = event.item;
        if (item && item.type === 'function_call') {
          if (!this._pendingFunctionCalls.has(item.call_id)) {
            this._pendingFunctionCalls.set(item.call_id, { name: item.name, argumentsStr: '' });
          } else {
            this._pendingFunctionCalls.get(item.call_id).name = item.name;
          }
        }
        break;
      }

      case 'response.function_call_arguments.delta': {
        // Accumulate partial function call arguments
        const { call_id, delta } = event;
        if (!this._pendingFunctionCalls.has(call_id)) {
          this._pendingFunctionCalls.set(call_id, { name: null, argumentsStr: '' });
        }
        this._pendingFunctionCalls.get(call_id).argumentsStr += delta;
        break;
      }

      case 'response.function_call_arguments.done': {
        // All arguments have arrived — queue for batch execution at response.done
        const { call_id } = event;
        const pending = this._pendingFunctionCalls.get(call_id);
        if (!pending) break;

        const fnName = pending.name;
        let args = {};
        try {
          args = JSON.parse(pending.argumentsStr || '{}');
        } catch {
          args = {};
        }

        this._pendingFunctionCalls.delete(call_id);
        this.emit('functionCall', fnName, args);
        this._completedCalls.push({ call_id, fnName, args });
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = event.transcript?.trim();
        if (transcript) this.emit('transcript', transcript);
        break;
      }

      case 'response.done': {
        if (this._suppressNextResponseDone) {
          // The done of a response we cancelled for barge-in — discard its
          // leftovers and let the new user turn drive the next response.
          this._suppressNextResponseDone = false;
          this._completedCalls = [];
          break;
        }
        const calls = this._completedCalls.splice(0);

        if (this._responsePhase === 'announce') {
          // Phase 1 done: Bruce spoke announcement, now let model call functions
          this._responsePhase = 'execute';
          this._send({
            type: 'response.create',
            response: { ...this._modalities(['text']), tool_choice: 'auto' },
          });
        } else if (calls.length > 0) {
          // Functions were called — execute all in parallel
          const results = await Promise.all(
            calls.map(async ({ call_id, fnName, args }) => {
              let result;
              try {
                result = await this._registry.execute(fnName, args);
              } catch (err) {
                result = `Error executing ${fnName}: ${err.message}`;
              }
              return { call_id, fnName, result };
            })
          );

          const ended = results.some(r => r.fnName === 'end_conversation');

          // Store function results so we can inject them into the results-phase prompt
          this._lastFunctionResults = results
            .filter(r => r.fnName !== 'end_conversation')
            .map(r => `${r.fnName}: ${r.result}`)
            .join('\n');

          for (const { call_id, result } of results) {
            this._send({
              type: 'conversation.item.create',
              item: { type: 'function_call_output', call_id, output: result },
            });
          }

          if (!ended) {
            // Stay in execute phase — model may need to call more functions
            this._responsePhase = 'execute';
            this._send({
              type: 'response.create',
              response: {
                ...this._modalities(['text']),
                tool_choice: 'auto',
                instructions: 'If you need to call additional functions, do so now. Otherwise respond with just the word "done" — do NOT summarize or discuss the results yet, you will speak them aloud in the next step.',
              },
            });
          } else {
            this._responsePhase = null;
          }
        } else if (this._responsePhase === 'execute') {
          // No more functions to call — Phase 3: let model share results with audio
          this._responsePhase = 'results';
          const fnResults = this._lastFunctionResults || '';
          this._lastFunctionResults = '';

          // Inject the function results as a system message so they're in the
          // conversation history — the model can't miss them this way.
          this._send({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: `[SYSTEM] The functions have finished. Here are the results — you MUST speak ALL of this data to the user:\n\n${fnResults}\n\nSpeak these results now. Read EVERY item, EVERY number, and EVERY name listed above. Do NOT skip entries, abbreviate lists, or leave out any keg numbers, values, or data points. If there are 5 items, say all 5. Do NOT replace them with a generic response.` }],
            },
          });
          this._send({
            type: 'response.create',
            response: {
              ...this._modalities(['text', 'audio']),
              tool_choice: 'none',
            },
          });
        } else if (this._responsePhase === 'results') {
          // Phase 3 done — results have been spoken
          this._responsePhase = null;
          this.emit('responseDone');
        } else {
          this.emit('responseDone');
        }
        break;
      }

      case 'error': {
        // Cancelling when the response already finished naturally is a no-op
        // race (audio playback outlasts response.done), not a real error.
        if (event.error?.code === 'response_cancel_not_active') break;
        const err = new Error(`Realtime API error: ${event.error?.message || JSON.stringify(event.error)}`);
        this.emit('error', err);
        if (rejectConnect) rejectConnect(err);
        break;
      }

      default:
        // Silently ignore unhandled events (rate_limits.updated, input_audio_buffer.committed, etc.)
        break;
    }
  }
}

module.exports = RealtimeClient;
