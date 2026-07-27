/**
 * The knowledge index: where it lives on disk, how it is loaded, and how a
 * question finds the passages that answer it.
 *
 * Deliberately NOT in checklist.sqlite. The index is derived data — a few tens
 * of megabytes of float vectors, rebuilt from knowledge/*.md by
 * `npm run knowledge` — and that database is committed to git on this project.
 * Two plain files next to it keep the repo (and every future commit) small:
 *
 *   knowledge-index.json  manifest + passage text
 *   knowledge-index.bin   embeddings, float32, one row per passage
 *
 * Search is a brute-force dot product over every passage. With one book that
 * is ~500 vectors — well under a millisecond — and it stays fine into the tens
 * of thousands, which is more brewing literature than anyone owns. Vectors are
 * stored L2-normalized so the dot product *is* the cosine similarity.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BruceBook, BruceBookChapter, BruceKnowledgeStatus } from '@checklist/shared';
import { databasePath } from '../db/index.js';
import type { KnowledgeChunk } from './chunk.js';
import { readableMarkdown } from './chunk.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Bumped when the on-disk format changes, forcing a rebuild rather than a crash. */
const INDEX_VERSION = 1;

export interface IndexedSource {
  file: string;
  title: string;
  /** SHA-256 of the file as indexed — how staleness is detected. */
  hash: string;
  /** Index of this document's first passage in `chunks` (its passages are contiguous). */
  start: number;
  passages: number;
}

export interface IndexManifest {
  version: number;
  /** Embedding model the vectors were produced with. */
  model: string;
  /** Vector length, e.g. 1536. */
  dims: number;
  builtAt: string;
  sources: IndexedSource[];
  chunks: KnowledgeChunk[];
}

export interface LoadedIndex {
  manifest: IndexManifest;
  /** All vectors back to back: passage `i` occupies `[i*dims, (i+1)*dims)`. */
  vectors: Float32Array;
}

/**
 * Where the brewing books live. Resolved from this module so it works from
 * both `src` (tsx) and `dist` (compiled) — the two differ by one directory, so
 * both candidates are tried, same approach as runMigrations().
 */
export function knowledgeDir(): string {
  const fromEnv = process.env.KNOWLEDGE_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  const fallback = resolve(__dirname, '../../../../knowledge'); // from dist/ and src/ alike
  const candidates = [fallback, resolve(__dirname, '../../../knowledge'), resolve(process.cwd(), 'knowledge')];
  return candidates.find((p) => existsSync(p)) ?? fallback;
}

/** Index files sit beside the database, so DATABASE_PATH moves them together. */
function indexPaths(): { manifest: string; vectors: string } {
  const dir = process.env.KNOWLEDGE_INDEX_DIR?.trim()
    ? resolve(process.env.KNOWLEDGE_INDEX_DIR.trim())
    : dirname(databasePath);
  return {
    manifest: join(dir, 'knowledge-index.json'),
    vectors: join(dir, 'knowledge-index.bin'),
  };
}

/**
 * Files in knowledge/ that are *about* the library rather than part of it:
 * PROMPT.md is Bruce's persona (see bruce/chat.ts) and README.md documents the
 * folder. Indexing either would have Bruce citing his own instructions as a
 * brewing source.
 */
const NOT_SOURCE_MATERIAL = new Set(['prompt.md', 'readme.md']);

/** The `.md` files currently in knowledge/, sorted for a stable index order. */
export function knowledgeFiles(): string[] {
  const dir = knowledgeDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .filter((f) => !NOT_SOURCE_MATERIAL.has(f.toLowerCase()))
    .sort();
}

/** True for the names knowledge/ keeps for itself — see NOT_SOURCE_MATERIAL. */
export function isReservedKnowledgeName(file: string): boolean {
  return NOT_SOURCE_MATERIAL.has(file.toLowerCase());
}

/**
 * Save a book into knowledge/, for the Bruce page's upload button.
 *
 * The name has already been validated by the route's schema; this re-checks
 * where it actually lands, because the cost of being wrong is a write outside
 * knowledge/ and the check is one comparison.
 */
export function writeKnowledgeFile(file: string, content: string): void {
  const dir = resolve(knowledgeDir());
  const path = resolve(dir, file);
  if (dirname(path) !== dir) {
    throw new Error(`Refusing to write ${file}: it would land outside knowledge/.`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Open a book for reading, one chapter at a time.
 *
 * Chapters, not the whole file, because the books here are ~600 KB of markdown
 * each: sending one whole is a slow request over the tunnel and a slower render
 * on the kiosk, to show a page nobody reads end to end. The table of contents
 * always comes back, so the reader can offer the rest without asking again.
 *
 * Only files actually in knowledge/ can be opened — the name is matched against
 * the directory listing rather than being resolved, so no path can escape it
 * however it is spelled.
 *
 * @param file Name as it appears in knowledge/
 * @param wanted Chapter id (its position in the file); the first when omitted
 */
export function readKnowledgeBook(file: string, wanted?: number): BruceBook | null {
  const name = knowledgeFiles().find((f) => f.toLowerCase() === file.toLowerCase());
  if (!name) return null;

  let markdown: string;
  try {
    markdown = readFileSync(join(knowledgeDir(), name), 'utf-8');
  } catch {
    return null;
  }

  const lines = readableMarkdown(markdown).split('\n');
  const title = lines.find((l) => /^#\s+\S/.test(l))?.replace(/^#\s+/, '').trim() ?? name;

  // Split on `# ` chapters. A book with only `## ` headings (or none at all —
  // a hand-written note) falls back so it still opens, as one piece if need be.
  const level = countHeadings(lines, 1) > 1 ? 1 : countHeadings(lines, 2) > 1 ? 2 : 0;
  const heading = new RegExp(`^#{${level || 1}}\\s+(.*\\S)\\s*$`);

  const chapters: { title: string; lines: string[] }[] = [];
  for (const line of lines) {
    const match = level > 0 ? line.match(heading) : null;
    if (match) chapters.push({ title: match[1] ?? title, lines: [] });
    // Text before the first heading is the front matter, and belongs to
    // something — a chapter of its own rather than silently dropped.
    if (chapters.length === 0) chapters.push({ title, lines: [] });
    chapters[chapters.length - 1]?.lines.push(line);
  }

  const toc: BruceBookChapter[] = chapters.map((chapter, id) => ({
    id,
    title: chapter.title,
    chars: chapter.lines.join('\n').trim().length,
  }));

  const id = wanted != null && wanted >= 0 && wanted < chapters.length ? wanted : 0;
  const chapter = chapters[id];
  const entry = toc[id];
  if (!chapter || !entry) return null;

  return { file: name, title, chapters: toc, chapter: { ...entry, content: chapter.lines.join('\n').trim() } };
}

/** How many headings of exactly this level the document has. */
function countHeadings(lines: string[], level: number): number {
  const heading = new RegExp(`^#{${level}}\\s+\\S`);
  return lines.filter((line) => heading.test(line)).length;
}

/**
 * Content hash of a knowledge file, skipping the read when size and mtime say
 * nothing has changed. Staleness is checked on every page load, and re-hashing
 * several megabytes of books each time is real work on a Pi for an answer that
 * is almost always "unchanged".
 */
const hashCache = new Map<string, { mtimeMs: number; size: number; hash: string }>();

function fileHash(path: string): string {
  const stat = statSync(path);
  const cachedHash = hashCache.get(path);
  if (cachedHash && cachedHash.mtimeMs === stat.mtimeMs && cachedHash.size === stat.size) {
    return cachedHash.hash;
  }
  const hash = hashContent(readFileSync(path, 'utf-8'));
  hashCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
  return hash;
}

/**
 * Write manifest + vectors. Vectors go first: the manifest is what `loadIndex`
 * stats and validates against, so writing it last means a crash mid-write
 * leaves the old (consistent) manifest rather than a new one pointing at
 * half-written vectors.
 */
export function writeIndex(manifest: IndexManifest, vectors: Float32Array): void {
  const paths = indexPaths();
  writeFileSync(paths.vectors, Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
  writeFileSync(paths.manifest, JSON.stringify(manifest));
  invalidateIndex();
}

/** Held in memory once loaded; reloaded when the file on disk changes. */
let cached: LoadedIndex | null = null;
let loadProblem: string | null = null;
/** mtime of the manifest that produced `cached`, so a rebuild is noticed. */
let cachedMtimeMs = 0;

export function invalidateIndex(): void {
  cached = null;
  loadProblem = null;
  cachedMtimeMs = 0;
}

/**
 * Load the index from disk, or return null when there isn't a usable one.
 * The reason is kept in `loadProblem` so the dashboard can explain itself.
 *
 * The manifest's mtime is checked on every call so that running
 * `npm run knowledge` takes effect immediately — without it a rebuilt index
 * would sit unused until the next restart, and worse, the page would compare
 * the new files against the *old* manifest and keep insisting the index is
 * stale right after you rebuilt it.
 */
export function loadIndex(): LoadedIndex | null {
  const paths = indexPaths();
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(paths.manifest).mtimeMs;
  } catch {
    // Missing or unreadable — fall through to the existence check below.
  }

  if (cached && mtimeMs === cachedMtimeMs) return cached;
  if (!cached && loadProblem && mtimeMs === cachedMtimeMs) return null;

  cached = null;
  loadProblem = null;
  cachedMtimeMs = mtimeMs;

  if (!existsSync(paths.manifest) || !existsSync(paths.vectors)) {
    loadProblem = 'No knowledge index yet — run `npm run knowledge` to build one.';
    return null;
  }

  try {
    const manifest = JSON.parse(readFileSync(paths.manifest, 'utf-8')) as IndexManifest;
    if (manifest.version !== INDEX_VERSION) {
      loadProblem = 'The knowledge index was built by an older version — rebuild it with `npm run knowledge`.';
      return null;
    }
    const raw = readFileSync(paths.vectors);
    const expected = manifest.chunks.length * manifest.dims * 4;
    if (raw.byteLength !== expected) {
      loadProblem = 'The knowledge index files disagree with each other — rebuild with `npm run knowledge`.';
      return null;
    }
    // Copy into a fresh buffer: the file Buffer may not be 4-byte aligned,
    // which Float32Array requires.
    const vectors = new Float32Array(manifest.chunks.length * manifest.dims);
    Buffer.from(vectors.buffer).set(raw);
    cached = { manifest, vectors };
    return cached;
  } catch (err) {
    loadProblem = `The knowledge index could not be read (${err instanceof Error ? err.message : 'unknown error'}).`;
    return null;
  }
}

/** Manifest for the current index, for tools that don't need the vectors. */
export function currentManifest(): IndexManifest | null {
  return loadIndex()?.manifest ?? null;
}

export const INDEX_FORMAT_VERSION = INDEX_VERSION;

/**
 * What the dashboard shows about the index: is it usable, and does it still
 * match the files on disk? Staleness is compared by content hash, so editing a
 * book or dropping a new one in is noticed without a restart.
 */
export function knowledgeStatus(): BruceKnowledgeStatus {
  const index = loadIndex();
  if (!index) {
    return { ready: false, problem: loadProblem ?? 'The knowledge index is unavailable.', documents: [], passages: 0 };
  }

  const { manifest } = index;
  const documents = manifest.sources.map((s) => ({
    file: s.file,
    title: s.title,
    passages: s.passages,
  }));
  const base = {
    documents,
    passages: manifest.chunks.length,
    builtAt: manifest.builtAt,
  };

  const onDisk = knowledgeFiles();
  const indexed = new Map(manifest.sources.map((s) => [s.file, s.hash]));

  const added = onDisk.filter((f) => !indexed.has(f));
  const removed = manifest.sources.filter((s) => !onDisk.includes(s.file)).map((s) => s.file);
  const changed = onDisk.filter((f) => {
    const hash = indexed.get(f);
    if (!hash) return false;
    try {
      return fileHash(join(knowledgeDir(), f)) !== hash;
    } catch {
      return true;
    }
  });

  // Stale is a warning, not a failure: the old index still answers questions,
  // it just doesn't know about the newest file yet.
  const notes: string[] = [];
  if (added.length > 0) notes.push(`${added.length} new file(s) not indexed (${added.join(', ')})`);
  if (changed.length > 0) notes.push(`${changed.length} file(s) changed since indexing`);
  if (removed.length > 0) notes.push(`${removed.length} indexed file(s) no longer in knowledge/`);

  if (notes.length > 0) {
    return { ready: true, ...base, problem: `${notes.join('; ')} — run \`npm run knowledge\` to update.` };
  }
  return { ready: true, ...base };
}

/**
 * What the library contains, for the model to read.
 *
 * Retrieval can only answer questions the books *discuss*; "what do you
 * know?" or "which books do you have?" match nothing in particular and score
 * near the relevance floor, so without this Bruce refuses to answer questions
 * about his own shelf. The outline is small enough to sit in every request.
 */
export function libraryOutline(): { title: string; chapters: string[] }[] {
  const index = loadIndex();
  if (!index) return [];

  const byTitle = new Map<string, Set<string>>();
  for (const chunk of index.manifest.chunks) {
    const chapters = byTitle.get(chunk.title) ?? new Set<string>();
    // The first segment of the heading trail is the chapter; sections below it
    // would make the outline longer than the answer it supports.
    const chapter = chunk.section.split('›')[0]?.trim();
    if (chapter) chapters.add(chapter);
    byTitle.set(chunk.title, chapters);
  }
  return [...byTitle].map(([title, chapters]) => ({ title, chapters: [...chapters] }));
}

export interface SearchHit {
  chunk: KnowledgeChunk;
  /** Cosine similarity, roughly 0–1 for this embedding family. */
  score: number;
}

/**
 * The `k` passages closest to `query`, best first.
 *
 * A relevance floor matters more than it looks: without it, asking Bruce
 * something the books don't cover still returns the five least-irrelevant
 * paragraphs, and the model dutifully builds an answer out of them.
 */
export function search(query: Float32Array, k: number, minScore = 0): SearchHit[] {
  const index = loadIndex();
  if (!index) return [];
  const { manifest, vectors } = index;
  const { dims, chunks } = manifest;
  if (query.length !== dims) return [];

  // Keep a small top-k by insertion rather than sorting every passage.
  const best: SearchHit[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    let score = 0;
    const offset = i * dims;
    for (let d = 0; d < dims; d++) score += (query[d] as number) * (vectors[offset + d] as number);
    if (score < minScore) continue;
    const worst = best[best.length - 1];
    if (best.length < k) {
      best.push({ chunk, score });
      best.sort((a, b) => b.score - a.score);
    } else if (worst && score > worst.score) {
      best[best.length - 1] = { chunk, score };
      best.sort((a, b) => b.score - a.score);
    }
  }
  return best;
}

/** Scale a vector to unit length in place, so dot product == cosine similarity. */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += (vector[i] as number) ** 2;
  const length = Math.sqrt(sum);
  if (length > 0) {
    for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] as number) / length;
  }
  return vector;
}
