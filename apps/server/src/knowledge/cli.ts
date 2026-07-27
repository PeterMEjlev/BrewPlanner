/**
 * `npm run knowledge` — build the index Bruce's chat answers from.
 *
 * Reads every `.md` in knowledge/, splits it into passages, embeds them, and
 * writes knowledge-index.{json,bin} next to the database. Run it once after
 * adding or editing a book; the dashboard says so when the index is stale.
 *
 * Needs OPENAI_API_KEY. On the Pi that is already in /etc/brewplanner.env:
 *
 *   set -a && . /etc/brewplanner.env && set +a && npm run knowledge
 *
 *   npm run knowledge              build (unchanged files keep their vectors)
 *   npm run knowledge -- --force   re-embed everything
 *   npm run knowledge -- --status  show what's indexed, without calling OpenAI
 *   npm run knowledge -- --dry-run chunk only: print the plan and the cost
 */

// Must stay first: later imports read process.env when they load. See env.ts.
import '../env.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isOpenAIConfigured } from '../openai.js';
import { chunkMarkdown } from './chunk.js';
import type { KnowledgeChunk } from './chunk.js';
import { EMBEDDING_BATCH, EMBEDDING_MODEL, embedBatch } from './embed.js';
import type { IndexManifest, IndexedSource, LoadedIndex } from './store.js';
import {
  INDEX_FORMAT_VERSION,
  hashContent,
  knowledgeDir,
  knowledgeFiles,
  loadIndex,
  writeIndex,
} from './store.js';

/** Rough token estimate for the cost line; 4 chars/token is close enough. */
const CHARS_PER_TOKEN = 4;
/** USD per million tokens for text-embedding-3-small — a ballpark, not a quote. */
const USD_PER_MTOK = 0.02;

function printStatus(): void {
  const index = loadIndex();
  const files = knowledgeFiles();
  console.log(`knowledge/  ${knowledgeDir()}`);
  console.log(`Files:      ${files.length === 0 ? '(none)' : files.join(', ')}`);
  if (!index) {
    console.log('Index:      not built yet — run `npm run knowledge`');
    return;
  }
  const { manifest } = index;
  console.log(
    `Index:      ${manifest.chunks.length} passages, model ${manifest.model}, built ${manifest.builtAt}`,
  );
  for (const source of manifest.sources) {
    let state = files.includes(source.file) ? 'ok' : 'REMOVED from knowledge/';
    if (state === 'ok') {
      try {
        const hash = hashContent(readFileSync(join(knowledgeDir(), source.file), 'utf-8'));
        if (hash !== source.hash) state = 'CHANGED — needs reindex';
      } catch {
        state = 'unreadable';
      }
    }
    console.log(`  ${source.title}  (${source.passages} passages, ${state})`);
  }
  for (const file of files.filter((f) => !manifest.sources.some((s) => s.file === f))) {
    console.log(`  ${file}  (NEW — not indexed)`);
  }
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');

  if (args.includes('--status')) {
    printStatus();
    return;
  }

  const files = knowledgeFiles();
  if (files.length === 0) {
    console.error(`No .md files found in ${knowledgeDir()} — nothing to index.`);
    process.exit(1);
  }

  const previous = force ? null : loadIndex();

  // Pass 1: chunk every file (fast, no API key needed) and work out which
  // passages still need a vector. This is also what --dry-run reports.
  const sources: IndexedSource[] = [];
  const chunks: KnowledgeChunk[] = [];
  /** Vectors carried over from the previous index, keyed by new chunk index. */
  const carried = new Map<number, Float32Array>();
  /** Chunk indices that must be embedded. */
  const pending: number[] = [];

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
      console.log(`= ${file}: unchanged, reusing ${reuse.chunks.length} passages`);
      continue;
    }

    const fileChunks = chunkMarkdown(file, content);
    const title = fileChunks[0]?.title;
    if (fileChunks.length === 0 || !title) {
      console.warn(`! ${file}: produced no passages (empty or unreadable) — skipped`);
      continue;
    }
    for (const chunk of fileChunks) {
      pending.push(chunks.length);
      chunks.push(chunk);
    }
    sources.push({ file, title, hash, start, passages: fileChunks.length });
    console.log(`+ ${file}: ${fileChunks.length} passages ("${title}")`);
  }

  if (chunks.length === 0) {
    console.error('No passages produced — check the files in knowledge/.');
    process.exit(1);
  }

  const newChars = pending.reduce((n, i) => n + (chunks[i]?.text.length ?? 0), 0);
  const tokens = Math.round(newChars / CHARS_PER_TOKEN);
  console.log(
    `\n${chunks.length} passages total, ${pending.length} to embed ` +
      `(~${tokens.toLocaleString()} tokens, ~$${((tokens / 1e6) * USD_PER_MTOK).toFixed(4)} with ${EMBEDDING_MODEL}).`,
  );

  if (dryRun) {
    console.log('Dry run — nothing embedded, nothing written.');
    return;
  }
  if (pending.length === 0 && previous) {
    console.log('Everything is already indexed. Nothing to do.');
    return;
  }
  if (!isOpenAIConfigured()) {
    console.error(
      '\nOPENAI_API_KEY is not set, so there is nothing to embed with.\n\n' +
        'On a dev machine (Windows/Mac/Linux) — put it in a .env at the repo root:\n' +
        '  OPENAI_API_KEY=sk-...\n' +
        '(.env is gitignored; the server and this command both read it.)\n\n' +
        'On the Pi it already lives in /etc/brewplanner.env, which systemd loads\n' +
        'for the service but not for your shell, so load it by hand:\n' +
        '  set -a && . /etc/brewplanner.env && set +a && npm run knowledge',
    );
    process.exit(1);
  }

  // Pass 2: embed. A big book takes a minute or two, and silence looks like a
  // hang, so progress is written as each batch lands.
  const vectors = new Map<number, Float32Array>(carried);
  for (let at = 0; at < pending.length; at += EMBEDDING_BATCH) {
    const slice = pending.slice(at, at + EMBEDDING_BATCH);
    const embedded = await embedBatch(slice.map((i) => chunks[i]?.text ?? ''));
    slice.forEach((chunkIndex, n) => {
      const vector = embedded[n];
      if (vector) vectors.set(chunkIndex, vector);
    });
    process.stdout.write(`\rEmbedding… ${Math.min(at + EMBEDDING_BATCH, pending.length)}/${pending.length}`);
  }
  if (pending.length > 0) process.stdout.write('\n');

  const dims = [...vectors.values()][0]?.length ?? 0;
  if (!dims) {
    console.error('No vectors were produced — aborting without writing the index.');
    process.exit(1);
  }

  // Pack into one flat buffer. A missing or odd-sized vector here means a bug
  // upstream; better to fail loudly than to write an index that mispairs
  // passages with vectors and quietly returns nonsense forever.
  const flat = new Float32Array(chunks.length * dims);
  for (let i = 0; i < chunks.length; i++) {
    const vector = vectors.get(i);
    if (!vector || vector.length !== dims) {
      console.error(`Missing or wrong-size vector for passage ${i} — aborting without writing.`);
      process.exit(1);
    }
    flat.set(vector, i * dims);
  }

  writeIndex(
    {
      version: INDEX_FORMAT_VERSION,
      model: EMBEDDING_MODEL,
      dims,
      builtAt: new Date().toISOString(),
      sources,
      chunks,
    },
    flat,
  );

  console.log(
    `\nIndexed ${chunks.length} passages from ${sources.length} document(s). ` +
      'Restart the server (or it will pick this up on next boot) and Bruce can answer from them.',
  );
}

main().catch((err) => {
  console.error(`\nIndexing failed: ${err instanceof Error ? err.message : String(err)}`);
  // Not process.exit(): calling it here, with the HTTP client's sockets still
  // being torn down, trips a libuv assertion on Windows and reports a garbage
  // exit code instead of 1. Setting the code lets Node finish closing them.
  process.exitCode = 1;
  // Failsafe in case a keep-alive socket would otherwise hold the process
  // open. Unref'd, so it never delays an exit that is already happening.
  setTimeout(() => process.exit(1), 250).unref();
});
