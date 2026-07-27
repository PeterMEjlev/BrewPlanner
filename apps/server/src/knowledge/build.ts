/**
 * Building the knowledge index, without deciding how to report it.
 *
 * This is the work `npm run knowledge` used to do inline. It moved here when
 * the Bruce page grew an "Add a book" button: the same chunk-reuse-embed-write
 * sequence now has two callers, one that prints to a terminal and one that
 * feeds a progress bar in a browser, and duplicating it would have meant two
 * subtly different indexes depending on which button you pressed.
 *
 * Split in two on purpose:
 *   planBuild()  — reads and chunks the files, works out what still needs a
 *                  vector. Fast, no API key, no writes. This is `--dry-run`.
 *   runBuild()   — embeds what the plan says is missing and writes the index.
 *
 * Failures throw `BuildError` with a message meant for a human, rather than
 * calling process.exit — a server must answer 400 where a CLI would die.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkMarkdown } from './chunk.js';
import type { KnowledgeChunk } from './chunk.js';
import { EMBEDDING_BATCH, EMBEDDING_MODEL, embedBatch } from './embed.js';
import {
  INDEX_FORMAT_VERSION,
  hashContent,
  knowledgeDir,
  knowledgeFiles,
  loadIndex,
  writeIndex,
} from './store.js';
import type { IndexedSource, LoadedIndex } from './store.js';

/** Rough token estimate for the cost line; 4 chars/token is close enough. */
export const CHARS_PER_TOKEN = 4;
/** USD per million tokens for text-embedding-3-small — a ballpark, not a quote. */
export const USD_PER_MTOK = 0.02;

/** A failure worth showing verbatim to whoever asked for the build. */
export class BuildError extends Error {}

export interface BuildPlan {
  /** Files that will be in the index, in knowledge/ order. */
  sources: IndexedSource[];
  chunks: KnowledgeChunk[];
  /** Vectors carried over from the previous index, keyed by new chunk index. */
  carried: Map<number, Float32Array>;
  /** Chunk indices that must be embedded. */
  pending: number[];
  /** Files whose vectors were reused wholesale. */
  reused: { file: string; passages: number }[];
  /** Files being embedded fresh (new, changed, or a forced rebuild). */
  fresh: { file: string; title: string; passages: number }[];
  /** Files that produced nothing usable — empty, or not really markdown. */
  skipped: string[];
  /** Estimated tokens and cost for `pending`. */
  tokens: number;
  costUsd: number;
}

/**
 * Passages already embedded for this exact file content, with their vectors.
 * Re-embedding a 270-page book to add a one-page note is pure waste, and the
 * hash makes "has this file changed" exact rather than a guess.
 */
function reusableFor(
  previous: LoadedIndex | null,
  file: string,
  hash: string,
): { chunks: KnowledgeChunk[]; vectors: Float32Array; dims: number } | null {
  if (!previous || previous.manifest.model !== EMBEDDING_MODEL) return null;
  const source = previous.manifest.sources.find((s) => s.file === file && s.hash === hash);
  if (!source) return null;
  const { dims, chunks } = previous.manifest;
  const end = source.start + source.passages;
  if (end > chunks.length || source.passages === 0) return null; // manifest disagrees with itself
  return {
    chunks: chunks.slice(source.start, end),
    vectors: previous.vectors.subarray(source.start * dims, end * dims),
    dims,
  };
}

/**
 * Chunk every file and work out which passages still need a vector. No API
 * calls, so this is safe to run to show a cost before spending anything.
 */
export function planBuild(force = false): BuildPlan {
  const files = knowledgeFiles();
  if (files.length === 0) {
    throw new BuildError(`No .md files found in ${knowledgeDir()} — nothing to index.`);
  }

  const previous = force ? null : loadIndex();

  const sources: IndexedSource[] = [];
  const chunks: KnowledgeChunk[] = [];
  const carried = new Map<number, Float32Array>();
  const pending: number[] = [];
  const reused: { file: string; passages: number }[] = [];
  const fresh: { file: string; title: string; passages: number }[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const content = readFileSync(join(knowledgeDir(), file), 'utf-8');
    const hash = hashContent(content);
    const start = chunks.length;
    const reuse = reusableFor(previous, file, hash);

    if (reuse) {
      const { dims } = reuse;
      reuse.chunks.forEach((chunk, n) => {
        carried.set(chunks.length, reuse.vectors.subarray(n * dims, (n + 1) * dims));
        chunks.push(chunk);
      });
      const title = reuse.chunks[0]?.title ?? file;
      sources.push({ file, title, hash, start, passages: reuse.chunks.length });
      reused.push({ file, passages: reuse.chunks.length });
      continue;
    }

    const fileChunks = chunkMarkdown(file, content);
    const title = fileChunks[0]?.title;
    if (fileChunks.length === 0 || !title) {
      skipped.push(file);
      continue;
    }
    for (const chunk of fileChunks) {
      pending.push(chunks.length);
      chunks.push(chunk);
    }
    sources.push({ file, title, hash, start, passages: fileChunks.length });
    fresh.push({ file, title, passages: fileChunks.length });
  }

  if (chunks.length === 0) {
    throw new BuildError('No passages produced — check the files in knowledge/.');
  }

  const newChars = pending.reduce((n, i) => n + (chunks[i]?.text.length ?? 0), 0);
  const tokens = Math.round(newChars / CHARS_PER_TOKEN);

  return {
    sources,
    chunks,
    carried,
    pending,
    reused,
    fresh,
    skipped,
    tokens,
    costUsd: (tokens / 1e6) * USD_PER_MTOK,
  };
}

/**
 * Embed everything the plan marked pending and write the index.
 *
 * `onProgress` is called as each batch lands — a big book takes a minute or
 * two, and silence looks like a hang whether you're watching a terminal or a
 * progress bar.
 */
export async function runBuild(
  plan: BuildPlan,
  onProgress?: (embedded: number, total: number) => void,
): Promise<{ passages: number; builtAt: string }> {
  const { chunks, pending, carried, sources } = plan;

  const vectors = new Map<number, Float32Array>(carried);
  for (let at = 0; at < pending.length; at += EMBEDDING_BATCH) {
    const slice = pending.slice(at, at + EMBEDDING_BATCH);
    const embedded = await embedBatch(slice.map((i) => chunks[i]?.text ?? ''));
    slice.forEach((chunkIndex, n) => {
      const vector = embedded[n];
      if (vector) vectors.set(chunkIndex, vector);
    });
    onProgress?.(Math.min(at + EMBEDDING_BATCH, pending.length), pending.length);
  }

  const dims = [...vectors.values()][0]?.length ?? 0;
  if (!dims) {
    throw new BuildError('No vectors were produced — aborting without writing the index.');
  }

  // Pack into one flat buffer. A missing or odd-sized vector here means a bug
  // upstream; better to fail loudly than to write an index that mispairs
  // passages with vectors and quietly returns nonsense forever.
  const flat = new Float32Array(chunks.length * dims);
  for (let i = 0; i < chunks.length; i++) {
    const vector = vectors.get(i);
    if (!vector || vector.length !== dims) {
      throw new BuildError(`Missing or wrong-size vector for passage ${i} — aborting without writing.`);
    }
    flat.set(vector, i * dims);
  }

  const builtAt = new Date().toISOString();
  writeIndex(
    {
      version: INDEX_FORMAT_VERSION,
      model: EMBEDDING_MODEL,
      dims,
      builtAt,
      sources,
      chunks,
    },
    flat,
  );

  return { passages: chunks.length, builtAt };
}
