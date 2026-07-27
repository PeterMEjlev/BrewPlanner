import type { ReactNode } from 'react';

/**
 * A small markdown renderer for Bruce's answers.
 *
 * The chat model writes markdown — headings, bullet lists, and tables of water
 * profiles or ion concentrations — and showing that raw puts literal `**` and
 * `|---|` on screen. A full library (react-markdown and its remark tree) is
 * ~40KB for one page in an app the kiosk loads over a tunnel, so this covers
 * what the model actually produces: headings, bold/italic/code, bullet and
 * numbered lists, fenced code, GFM tables, and paragraphs.
 *
 * Everything is built as React nodes, never `dangerouslySetInnerHTML` — model
 * output is untrusted text and this way it can never become markup.
 *
 * Not supported (and deliberately so): links, images, blockquotes, nested
 * lists. Unrecognised syntax falls through as plain text rather than
 * disappearing.
 */

/** Inline: `**bold**`, `*italic*`/`_italic_`, `` `code` ``. */
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const parts = text.split(INLINE);
  parts.forEach((part, i) => {
    if (!part) return;
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      nodes.push(
        <strong key={key} className="font-semibold text-zinc-50">
          {part.slice(2, -2)}
        </strong>,
      );
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      nodes.push(
        <code key={key} className="rounded bg-zinc-950/70 px-1 py-0.5 font-mono text-[0.85em] text-emerald-300">
          {part.slice(1, -1)}
        </code>,
      );
    } else if (
      ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) &&
      part.length > 2
    ) {
      nodes.push(
        <em key={key} className="italic">
          {part.slice(1, -1)}
        </em>,
      );
    } else {
      nodes.push(part);
    }
  });
  return nodes;
}

/** Split a GFM table row into cells, dropping the leading/trailing pipes. */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

const TABLE_DIVIDER = /^\|?[\s:|-]+\|[\s:|-]*$/;

export function Markdown({ text }: { text: string }): JSX.Element {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (trimmed === '') {
      i++;
      continue;
    }

    // Fenced code
    if (trimmed.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        body.push(lines[i] ?? '');
        i++;
      }
      i++; // closing fence
      blocks.push(
        <pre
          key={key++}
          className="overflow-x-auto rounded-lg bg-zinc-950/70 p-3 font-mono text-xs text-zinc-200"
        >
          {body.join('\n')}
        </pre>,
      );
      continue;
    }

    // Table: a pipe row followed by a |---|---| divider
    const next = (lines[i + 1] ?? '').trim();
    if (trimmed.includes('|') && TABLE_DIVIDER.test(next) && next.includes('-')) {
      const header = tableCells(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').trim().includes('|')) {
        rows.push(tableCells(lines[i] ?? ''));
        i++;
      }
      blocks.push(
        // Wide tables scroll inside the bubble rather than stretching the page.
        <div key={key++} className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr>
                {header.map((cell, c) => (
                  <th key={c} className="border-b border-zinc-700 px-2 py-1.5 font-semibold text-zinc-300">
                    {renderInline(cell, `th-${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className="border-b border-zinc-800/70 px-2 py-1.5 tabular-nums text-zinc-300">
                      {renderInline(cell, `td-${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Heading
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push(
        <p key={key++} className="mt-2 font-semibold text-zinc-100">
          {renderInline(heading[2] ?? '', `h-${key}`)}
        </p>,
      );
      i++;
      continue;
    }

    // Lists: consecutive `- ` / `* ` / `1. ` lines
    const bullet = /^[-*]\s+(.*)$/;
    const numbered = /^\d+[.)]\s+(.*)$/;
    if (bullet.test(trimmed) || numbered.test(trimmed)) {
      const ordered = numbered.test(trimmed);
      const items: string[] = [];
      while (i < lines.length) {
        const current = (lines[i] ?? '').trim();
        const match = current.match(ordered ? numbered : bullet);
        if (!match) break;
        items.push(match[1] ?? '');
        i++;
      }
      const ListTag = ordered ? 'ol' : 'ul';
      blocks.push(
        <ListTag
          key={key++}
          className={`ml-4 space-y-1 ${ordered ? 'list-decimal' : 'list-disc'} marker:text-zinc-600`}
        >
          {items.map((item, n) => (
            <li key={n}>{renderInline(item, `li-${n}`)}</li>
          ))}
        </ListTag>,
      );
      continue;
    }

    // Paragraph: run of non-blank lines that start no other block
    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = (lines[i] ?? '').trim();
      if (
        current === '' ||
        current.startsWith('```') ||
        /^#{1,6}\s/.test(current) ||
        bullet.test(current) ||
        numbered.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      i++;
    }
    blocks.push(<p key={key++}>{renderInline(paragraph.join(' '), `p-${key}`)}</p>);
  }

  return <div className="space-y-2 leading-relaxed">{blocks}</div>;
}
