/**
 * Markdown → retrieval passages.
 *
 * The books in knowledge/ are PDF transcriptions: a `# ` title, `# N. Chapter`
 * / `## Section` headings, and `<!-- source_pdf_page: N -->` markers between
 * pages. Those markers are what let an answer say "Water, p. 142" instead of
 * "somewhere in the book", so they are tracked through chunking and end up on
 * every passage.
 *
 * Plain markdown with no page markers works too — the page fields are simply
 * left off — so a future hand-written note in knowledge/ needs no special
 * handling.
 *
 * Pure functions only (no I/O, no network): this is the piece worth reasoning
 * about, and it stays testable without an API key.
 */

import { basename } from 'node:path';

export interface KnowledgeChunk {
  /** Source file name, e.g. `water-a-comprehensive-guide-for-brewers.md`. */
  file: string;
  /** Document title: the file's first `# ` heading, else a title-cased filename. */
  title: string;
  /** Heading trail at this point, e.g. `4. Residual Alkalinity › Water Alkalinity`. */
  section: string;
  /** First/last source-PDF page covered, when the file carries page markers. */
  pageStart?: number;
  pageEnd?: number;
  text: string;
}

/**
 * Target passage size in characters. ~1,400 chars is roughly 350 tokens: big
 * enough to hold a whole argument (a mash-pH explanation runs several
 * paragraphs), small enough that six of them plus the answer stay a cheap
 * request.
 */
const TARGET_CHARS = 1400;

/** Never emit a passage longer than this; a single huge paragraph is split. */
const MAX_CHARS = 2400;

/**
 * Passages shorter than this are dropped: page furniture, stray captions and
 * one-line fragments retrieve badly and crowd out real content.
 */
const MIN_CHARS = 120;

/** Headings whose sections are pure retrieval noise — a page-number list. */
const SKIP_SECTIONS = /^(table of contents|contents|index|about the authors?)$/i;

const PAGE_MARKER = /^<!--\s*source_pdf_page:\s*(\d+)\s*-->$/;
const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
/** Image-only line — the transcription links a scan of each page. */
const IMAGE_ONLY = /^!\[[^\]]*\]\([^)]*\)$/;
const NO_TEXT_PLACEHOLDER = /^\[No extractable text on this page\.?\]$/i;
/** `---` rules separate pages in the transcription and carry no meaning. */
const HORIZONTAL_RULE = /^-{3,}$|^\*{3,}$/;

/** Fallback title for a file with no `# ` heading: `my-notes.md` → `My notes`. */
function titleFromFilename(file: string): string {
  const stem = basename(file).replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

/** Collapse the runs of spaces that PDF transcription leaves behind. */
function tidy(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

/**
 * Split one markdown document into passages.
 *
 * @param file File name (used for `file` and as a title fallback)
 * @param markdown Raw file contents
 */
export function chunkMarkdown(file: string, markdown: string): KnowledgeChunk[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');

  const chunks: KnowledgeChunk[] = [];
  /** Heading text by level, so a `##` clears any deeper heading still in force. */
  const headings: (string | null)[] = [null, null, null, null, null, null, null];
  let docTitle: string | null = null;
  /**
   * Level of the skipped heading currently in force, or null. A level, not a
   * flag, because a book's index is `# Index` followed by `## A`, `## B`… —
   * with a flag, the first sub-heading would switch skipping back off and let
   * 200 lines of page numbers into the index.
   */
  let skipDepth: number | null = null;

  let page: number | null = null;
  /** Paragraphs waiting to be emitted, with the page each one started on. */
  let buffer: { text: string; page: number | null }[] = [];
  let paragraph: string[] = [];
  let paragraphPage: number | null = null;

  const sectionTrail = (): string =>
    headings
      .slice(1)
      .filter((h): h is string => h != null && h !== docTitle)
      .join(' › ');

  /** Emit whatever is buffered, optionally keeping the tail as overlap. */
  const flush = (keepOverlap: boolean): void => {
    if (buffer.length === 0) return;
    const text = buffer.map((p) => p.text).join('\n\n');
    if (text.length >= MIN_CHARS) {
      const pages = buffer.map((p) => p.page).filter((p): p is number => p != null);
      chunks.push({
        file,
        title: docTitle ?? titleFromFilename(file),
        section: sectionTrail(),
        ...(pages.length > 0 ? { pageStart: Math.min(...pages), pageEnd: Math.max(...pages) } : {}),
        text,
      });
    }
    // One paragraph of overlap keeps an idea that straddles a boundary
    // retrievable from either side. Not worth it across a heading, and not
    // worth it when the tail is already a full passage on its own.
    const tail = buffer[buffer.length - 1];
    const overlap = keepOverlap && buffer.length > 1 && tail && tail.text.length < TARGET_CHARS / 2;
    buffer = overlap && tail ? [tail] : [];
  };

  /** Close the current paragraph and decide whether the buffer is full. */
  const endParagraph = (): void => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(' ').trim();
    paragraph = [];
    if (text.length === 0) return;

    // A single oversized paragraph (an unbroken transcription block) is cut on
    // sentence boundaries so no passage blows past MAX_CHARS.
    for (const piece of splitLongText(text)) {
      const size = buffer.reduce((n, p) => n + p.text.length + 2, 0);
      // Flush *before* appending when this piece would overshoot the ceiling —
      // checking only afterwards lets a full buffer plus a long paragraph land
      // well past MAX_CHARS. No overlap here: keeping the tail would put the
      // buffer straight back over the limit, which is what we're avoiding.
      if (size > 0 && size + piece.length > MAX_CHARS) flush(false);
      buffer.push({ text: piece, page: paragraphPage });
      if (buffer.reduce((n, p) => n + p.text.length + 2, 0) >= TARGET_CHARS) flush(true);
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    const pageMatch = line.trim().match(PAGE_MARKER);
    if (pageMatch) {
      page = Number(pageMatch[1]);
      continue;
    }

    const headingMatch = line.match(HEADING);
    if (headingMatch) {
      endParagraph();
      flush(false); // a heading is a hard boundary — no overlap across it
      const level = (headingMatch[1] ?? '#').length;
      const text = tidy(headingMatch[2] ?? '');
      if (docTitle == null && level === 1) docTitle = text;
      headings[level] = text;
      for (let deeper = level + 1; deeper < headings.length; deeper++) headings[deeper] = null;
      // A skipped section ends at the next heading of the same level or
      // shallower; anything nested under it is skipped too.
      if (skipDepth != null && level <= skipDepth) skipDepth = null;
      if (SKIP_SECTIONS.test(text)) skipDepth = level;
      continue;
    }

    if (skipDepth != null) continue;

    const trimmed = line.trim();
    if (trimmed === '') {
      endParagraph();
      continue;
    }
    if (IMAGE_ONLY.test(trimmed) || NO_TEXT_PLACEHOLDER.test(trimmed)) continue;
    if (HORIZONTAL_RULE.test(trimmed)) {
      endParagraph();
      continue;
    }

    if (paragraph.length === 0) paragraphPage = page;
    paragraph.push(tidy(trimmed));
  }

  endParagraph();
  flush(false);
  return chunks;
}

/**
 * Cut text longer than MAX_CHARS on sentence boundaries, falling back to a
 * hard cut when there is no sentence end to use (tables, equation dumps).
 */
function splitLongText(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];

  const pieces: string[] = [];
  let rest = text;
  while (rest.length > MAX_CHARS) {
    const window = rest.slice(0, MAX_CHARS);
    const boundary = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('? '),
      window.lastIndexOf('! '),
    );
    const cut = boundary > MAX_CHARS / 2 ? boundary + 1 : MAX_CHARS;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

/**
 * Strip the transcription's scaffolding so a book can be *read* rather than
 * retrieved: page markers, the per-page scan images, the placeholder left where
 * a page held no text, and the rules that separate one page from the next.
 *
 * None of it means anything to a person — the images point at scans this server
 * doesn't serve, and `---` between every page renders as a wall of dashes. The
 * headings, paragraphs and tables are left exactly as they are.
 */
export function readableMarkdown(markdown: string): string {
  const kept: string[] = [];
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = raw.trim();
    if (PAGE_MARKER.test(trimmed) || IMAGE_ONLY.test(trimmed)) continue;
    if (NO_TEXT_PLACEHOLDER.test(trimmed) || HORIZONTAL_RULE.test(trimmed)) continue;
    // Runs of blank lines are left by what was just dropped; one is a paragraph
    // break, three is a hole in the page.
    if (trimmed === '' && kept[kept.length - 1] === '') continue;
    kept.push(trimmed === '' ? '' : raw.trimEnd());
  }
  return kept.join('\n').trim();
}

/** Human-readable page reference for a passage: `142`, `142–144`, or undefined. */
export function pageLabel(chunk: {
  pageStart?: number;
  pageEnd?: number;
}): string | undefined {
  if (chunk.pageStart == null) return undefined;
  if (chunk.pageEnd == null || chunk.pageEnd === chunk.pageStart) return String(chunk.pageStart);
  return `${chunk.pageStart}–${chunk.pageEnd}`;
}
