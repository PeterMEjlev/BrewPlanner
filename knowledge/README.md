# Bruce's library

Markdown files in this folder are what Bruce's chat (the `/bruce` page) answers
from. Ask him about mash pH and he retrieves the passages that cover it,
answers from them, and cites the book and page.

This is not the same as pasting a book into a prompt. Each file is split into
passages, each passage gets an embedding, and a question is matched against
those — so the library can grow past anything that would fit in a single
request, and an answer can point at where it came from.

## Adding a book

From the **Bruce page**, the Library card (under the voice card) has an **Add a
book** button: pick a `.md` file and the server saves it here and indexes it,
showing progress while it embeds. Nothing else to do — no SSH, no rebuild.

The card also has **Rebuild**, for when the files here were changed by hand and
the index has gone stale.

By hand instead:

1. Drop the `.md` file in this folder.
2. Rebuild the index:

   ```sh
   npm run knowledge
   ```

3. That's it — a running server notices the rebuilt index and starts using it
   without a restart.

A file that produces no passages is refused on upload rather than saved: very
short files, and pages that are all headings or tables of contents, chunk to
nothing (see `MIN_CHARS` in `apps/server/src/knowledge/chunk.ts`).

Indexing needs `OPENAI_API_KEY`. **In development** put it in a `.env` at the
repo root (gitignored, and the server reads the same file):

```
OPENAI_API_KEY=sk-...
```

**On the Pi** it is already in `/etc/brewplanner.env` — but systemd loads that
for the *service*, not for your shell, so load it by hand for the command:

```sh
set -a && . /etc/brewplanner.env && set +a && npm run knowledge
```

Unchanged files keep their existing vectors, so adding one book to a shelf of
five only embeds the new one. Indexing is cheap either way: a 270-page book is
roughly half a cent with `text-embedding-3-small`.

Until you reindex, the Bruce page says so — it compares each file's content
hash against what was indexed and reports new, changed and removed files.

Useful flags:

| Command | What it does |
| --- | --- |
| `npm run knowledge -- --status` | What's indexed and what's stale. No API calls. |
| `npm run knowledge -- --dry-run` | Chunk everything, print the plan and cost, write nothing. |
| `npm run knowledge -- --force` | Re-embed everything from scratch. |

## What makes a good source file

Plain markdown works. Two conventions are used when present:

- **Headings** (`# 4. Residual Alkalinity`, `## Water Alkalinity`) become the
  section trail on each passage, and start a fresh passage — so keep them.
- **`<!-- source_pdf_page: 142 -->`** markers between pages become the page
  numbers in citations. A PDF transcription that keeps page boundaries is worth
  much more than one that doesn't: without them Bruce can name the book but not
  the page.

Front matter, image links (`![…](…)`), "no extractable text" placeholders, and
the book's own table of contents and index are skipped — they retrieve badly
and crowd out real content.

## Units

Both books on the shelf were written in US units and have been converted to
metric in place — °C, litres, kilograms, hectares, hectolitres, g/L for hop
rates. Where a book already gave both ("140° F (60° C)") only its own metric
figure was kept, rather than a recomputed one. This brewery brews in metric, and
a converted book means Bruce quotes a number instead of doing arithmetic on one.

Four kinds of passage were deliberately left in US units, because there the unit
is the subject rather than a measurement and converting would break the text:

- the worked salt-addition examples in the water book (chains of arithmetic in
  grams per gallon — Tables 14 and 17 above them are metric-only, which is where
  a dose should be read from anyway)
- the appendix that derives those figures, which teaches the gallon↔litre step
  itself ("1 gallon of water = 3.785 liters")
- discussions of hardness scales — grains per gallon, degrees Clark, French and
  German degrees — and the historical table comparing them
- direct quotations from 19th-century sources measured in grains per gallon

If you add a book, convert it before indexing; nothing in the pipeline converts
units for you.

## What Bruce knows about his own shelf

Every request also carries a list of the indexed books and their chapters, so
"what do you know about?" and "what's in the hops book?" are answered from that
list rather than from retrieval — questions about the library match no
individual passage by nature, and without the list Bruce would claim the books
don't cover it.

Past ~80 chapters across the library, only the titles are sent, to keep the
request small.

## Giving Bruce different instructions

Add a `PROMPT.md` to this folder and its contents replace Bruce's built-in
persona for the chat. This is where the instructions from an existing custom
GPT go — paste them in as-is.

The Bruce page's Library card edits this file directly: **Instructions** opens
the persona in an editor, **Save** writes it here, and **Revert to built-in**
deletes it again. Changes apply from the next question — nothing restarts.

`PROMPT.md` is treated as instructions, not source material: it is never
indexed and never retrieved.

Without it, Bruce uses the default in `apps/server/src/bruce/chat.ts`: answer
from the passages, cite the page, say so when the books don't cover it, use
metric, and don't explain what a mash is. Note that this is a *written*
persona, separate from `apps/bruce/system-prompt.txt`, which is written for
speech and keeps answers to a sentence or two.

## Where the index lives

`knowledge-index.json` and `knowledge-index.bin` are written next to the
database (`DATABASE_PATH`'s folder). They are generated, gitignored, and safe
to delete — `npm run knowledge` rebuilds them.

They are deliberately kept out of `checklist.sqlite`, which is tracked in git in
this project: tens of megabytes of float vectors would land in every commit.

## Copyright

These are transcriptions of books, kept for one brewery's own use on its own
hardware. The index and the files never leave the Pi except as the short
passages sent with a question. Don't publish this folder.
