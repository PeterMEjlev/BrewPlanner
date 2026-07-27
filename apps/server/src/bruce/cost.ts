/**
 * What a question cost, in US dollars.
 *
 * OpenAI bills per token and reports the token counts back on every answer, so
 * the arithmetic is exact — the *prices* are the guess. They live in a table
 * here rather than being fetched, because OpenAI publishes no pricing endpoint.
 * That makes this an estimate with two known ways to drift:
 *
 *   - a price changes and this table doesn't
 *   - the model isn't in the table at all, and is priced by family (below)
 *
 * It is still worth showing. The point of the figure on the Bruce page is to
 * answer "is asking Bruce things costing me anything?", where being out by a
 * few percent changes nothing and being out by an order of magnitude — which
 * picking the wrong model would be — matters. Treat platform.openai.com's
 * billing page as the truth; this is the running tally between visits.
 *
 * Deliberately excluded, both negligible against the answer itself:
 *   - embedding the question (text-embedding-3-small, ~$0.02 per 1M tokens —
 *     a question costs about two millionths of a cent)
 *   - the cached-input discount, which makes a repeated prompt prefix cheaper
 *     than charged here. So a long thread is estimated slightly high, which is
 *     the better direction to be wrong in.
 */

/** USD per million tokens. */
interface Price {
  input: number;
  output: number;
}

/**
 * List prices per million tokens, as published by OpenAI. Update alongside
 * SHORTLIST in chat.ts when the models on offer change.
 */
const PRICES: Record<string, Price> = {
  'gpt-5': { input: 1.25, output: 10.0 },
  'gpt-5-mini': { input: 0.25, output: 2.0 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  o3: { input: 2.0, output: 8.0 },
  'o4-mini': { input: 1.1, output: 4.4 },
};

/**
 * Prices for a model the table has never heard of, guessed from its name.
 *
 * The picker offers whatever the account can see, and tops the shortlist up
 * with models newer than this file — so an unknown id is the normal case for a
 * new release, not an error. Within a generation the -mini and -nano tiers have
 * held roughly steady in price while the flagship's has not, so the tiers are
 * guessed at their usual rate and anything else at the current flagship's.
 */
function fallbackPrice(model: string): Price {
  if (/-nano\b/.test(model)) return { input: 0.05, output: 0.4 };
  if (/-mini\b/.test(model)) return { input: 0.25, output: 2.0 };
  return { input: 1.25, output: 10.0 };
}

/** Token counts as the Responses API reports them. */
export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
}

/**
 * Estimate what one answer cost. Returns null when there is nothing to price —
 * an answer OpenAI reported no usage for is better shown as unknown than as
 * free.
 *
 * Reasoning tokens need no special handling: the Responses API already counts
 * them inside `output_tokens`, and they are billed at the output rate.
 */
export function estimateCostUsd(model: string, usage: TokenUsage | undefined): number | null {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  if (input <= 0 && output <= 0) return null;

  const price = PRICES[model] ?? fallbackPrice(model);
  return (input * price.input + output * price.output) / 1_000_000;
}
