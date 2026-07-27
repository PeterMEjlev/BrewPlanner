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
