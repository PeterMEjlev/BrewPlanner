/**
 * Turning text into vectors — the one network call both indexing and asking
 * need. Indexing embeds every passage once; a question embeds one string.
 * Both must use the *same* model or the numbers are meaningless, which is why
 * the model name is written into the index manifest and checked on load.
 */

import { openaiPost } from '../openai.js';
import { normalize } from './store.js';

/**
 * text-embedding-3-small: 1536 dimensions, and cheap enough that a 270-page
 * book costs well under a cent to index. Override for the (better, pricier)
 * large model with KNOWLEDGE_EMBEDDING_MODEL — changing it requires a rebuild.
 */
export const EMBEDDING_MODEL = process.env.KNOWLEDGE_EMBEDDING_MODEL?.trim() || 'text-embedding-3-small';

/**
 * Passages per request. The API accepts far more, but a smaller batch keeps
 * each request under the token limit and makes a mid-index failure cheap to
 * retry.
 */
export const EMBEDDING_BATCH = 64;

interface EmbeddingResponse {
  data: { index: number; embedding: number[] }[];
}

/**
 * Embed a batch of strings, returning unit-length vectors in the input order.
 *
 * The API is documented to return results in order, but it also carries an
 * explicit `index` on each row — that is what's used here, so a reordered
 * response can't silently pair the wrong vector with the wrong passage.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const res = await openaiPost<EmbeddingResponse>('/embeddings', {
    model: EMBEDDING_MODEL,
    input: texts,
  });

  if (!Array.isArray(res?.data) || res.data.length !== texts.length) {
    throw new Error(`Embedding API returned ${res?.data?.length ?? 0} vectors for ${texts.length} inputs.`);
  }

  const out = new Array<Float32Array | undefined>(texts.length);
  for (const row of res.data) {
    if (!Array.isArray(row.embedding)) throw new Error('Embedding API returned a malformed vector.');
    out[row.index] = normalize(Float32Array.from(row.embedding));
  }

  const vectors = out.filter((v): v is Float32Array => v != null);
  if (vectors.length !== texts.length) throw new Error('Embedding API skipped an input.');
  return vectors;
}

/** Embed a single string (a user's question). */
export async function embedQuery(text: string): Promise<Float32Array> {
  const vectors = await embedBatch([text]);
  const vector = vectors[0];
  if (!vector) throw new Error('The embedding API returned nothing for the question.');
  return vector;
}
