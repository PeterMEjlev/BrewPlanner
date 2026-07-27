/**
 * Minimal OpenAI HTTP client.
 *
 * The rest of the codebase talks to every API with bare `fetch` (see
 * brewersfriend.ts, routes/bruce.ts), so this follows suit rather than pulling
 * in the SDK: two endpoints are used — /v1/embeddings when indexing the
 * brewing books, and /v1/responses when Bruce answers a question.
 *
 * OPENAI_API_KEY comes from /etc/brewplanner.env on the Pi (the same key
 * apps/bruce uses for speech). Without it the chat is simply reported as
 * unconfigured rather than failing per request.
 */

const API_BASE = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');

/** Embedding requests batch a lot of text; the default 30s is not always enough. */
const REQUEST_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? 120_000);

/** Retried once per step on 429/5xx, backing off between attempts. */
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 1000;

export function openaiKey(): string | null {
  const key = process.env.OPENAI_API_KEY?.trim();
  return key ? key : null;
}

/** True when the server can reach OpenAI at all. */
export function isOpenAIConfigured(): boolean {
  return openaiKey() != null;
}

/** Thrown for any non-2xx answer; `status` lets callers decide about retrying. */
export class OpenAIError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'OpenAIError';
    this.status = status;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** GET an OpenAI endpoint (only /models today — no retry, it's not critical). */
export async function openaiGet<T>(path: string): Promise<T> {
  const key = openaiKey();
  if (!key) throw new OpenAIError(401, 'OPENAI_API_KEY is not set on the server.');

  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new OpenAIError(res.status, `OpenAI answered ${res.status} for ${path}`);
  return (await res.json()) as T;
}

/**
 * POST a JSON body to an OpenAI endpoint and return the parsed answer.
 *
 * Rate limits (429) and server errors (5xx) are retried with exponential
 * backoff — indexing a book fires hundreds of embedding requests and will
 * otherwise trip the per-minute limit on a small account.
 *
 * @param path Endpoint path starting with `/`, e.g. `/embeddings`
 */
export async function openaiPost<T>(path: string, body: unknown): Promise<T> {
  const key = openaiKey();
  if (!key) throw new OpenAIError(401, 'OPENAI_API_KEY is not set on the server.');

  let lastError: OpenAIError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      lastError = new OpenAIError(0, 'Could not reach OpenAI (network or timeout).');
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      continue;
    }

    if (res.ok) return (await res.json()) as T;

    // Pull OpenAI's own message out of `{ error: { message } }` when present —
    // it names the actual problem ("model not found", "insufficient quota").
    let detail = `OpenAI answered ${res.status}`;
    try {
      const data = (await res.json()) as { error?: { message?: string } };
      if (typeof data?.error?.message === 'string') detail = data.error.message;
    } catch {
      /* keep the generic message */
    }
    lastError = new OpenAIError(res.status, detail);

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) break;
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
  }

  throw lastError ?? new OpenAIError(0, 'OpenAI request failed.');
}

/** One event off a streamed response: `{ type: 'response.…', … }`. */
export interface StreamEvent {
  type?: string;
  [key: string]: unknown;
}

/**
 * POST with `stream: true` and walk the server-sent events OpenAI answers with,
 * returning the final response object.
 *
 * Used for exactly one thing: knowing what the model is *doing* while it does
 * it. A plain POST only says what happened once it is over, so a question that
 * makes the model go and search the web looks identical to one it answered from
 * the retrieved passages — the page can only shrug and say "working…". Streamed,
 * `response.web_search_call.*` arrives the moment the search starts, and the
 * page can say so honestly.
 *
 * Not retried, unlike openaiPost: a stream that fails halfway has already
 * emitted events the caller acted on, and re-running it would replay them.
 * Failures here surface to the brewer, who can ask again.
 *
 * @param onEvent Called for every event; the final response is returned, not passed here.
 */
export async function openaiStream<T>(
  path: string,
  body: unknown,
  onEvent: (event: StreamEvent) => void,
): Promise<T> {
  const key = openaiKey();
  if (!key) throw new OpenAIError(401, 'OPENAI_API_KEY is not set on the server.');

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ ...(body as object), stream: true }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new OpenAIError(0, 'Could not reach OpenAI (network or timeout).');
  }

  if (!res.ok || !res.body) {
    let detail = `OpenAI answered ${res.status}`;
    try {
      const data = (await res.json()) as { error?: { message?: string } };
      if (typeof data?.error?.message === 'string') detail = data.error.message;
    } catch {
      /* keep the generic message */
    }
    throw new OpenAIError(res.status, detail);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed: T | null = null;
  let failure: string | null = null;

  /** One `data:` payload. Events arrive as blank-line-separated blocks. */
  const handle = (payload: string): void => {
    if (payload === '[DONE]') return;
    let event: StreamEvent;
    try {
      event = JSON.parse(payload) as StreamEvent;
    } catch {
      return; // A malformed frame is not worth failing the whole answer over.
    }
    onEvent(event);
    // `response.completed` carries the same object a non-streamed call returns,
    // so everything downstream (text extraction, citations, usage) is unchanged.
    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      completed = event.response as T;
    } else if (event.type === 'response.failed' || event.type === 'error') {
      const error = (event.response as { error?: { message?: string } } | undefined)?.error;
      failure = error?.message ?? (event.message as string | undefined) ?? 'The model stopped early.';
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Frames end at a blank line; anything after the last one is a partial
    // frame and stays in the buffer until the rest of it arrives.
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) handle(line.slice(5).trim());
      }
      split = buffer.indexOf('\n\n');
    }
  }

  if (failure) throw new OpenAIError(502, failure);
  if (!completed) throw new OpenAIError(502, 'OpenAI ended the stream without an answer.');
  return completed;
}
