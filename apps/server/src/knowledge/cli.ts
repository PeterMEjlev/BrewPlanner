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
import { BuildError, planBuild, runBuild } from './build.js';
import { EMBEDDING_MODEL } from './embed.js';
import { hashContent, knowledgeDir, knowledgeFiles, loadIndex } from './store.js';

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');

  if (args.includes('--status')) {
    printStatus();
    return;
  }

  // Pass 1: chunk every file (fast, no API key needed) and work out which
  // passages still need a vector. This is also what --dry-run reports.
  const plan = planBuild(force);
  for (const { file, passages } of plan.reused) {
    console.log(`= ${file}: unchanged, reusing ${passages} passages`);
  }
  for (const { file, title, passages } of plan.fresh) {
    console.log(`+ ${file}: ${passages} passages ("${title}")`);
  }
  for (const file of plan.skipped) {
    console.warn(`! ${file}: produced no passages (empty or unreadable) — skipped`);
  }

  console.log(
    `\n${plan.chunks.length} passages total, ${plan.pending.length} to embed ` +
      `(~${plan.tokens.toLocaleString()} tokens, ~$${plan.costUsd.toFixed(4)} with ${EMBEDDING_MODEL}).`,
  );

  if (dryRun) {
    console.log('Dry run — nothing embedded, nothing written.');
    return;
  }
  if (plan.pending.length === 0) {
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
  const { passages } = await runBuild(plan, (embedded, total) => {
    process.stdout.write(`\rEmbedding… ${embedded}/${total}`);
  });
  process.stdout.write('\n');

  console.log(
    `\nIndexed ${passages} passages from ${plan.sources.length} document(s). ` +
      'Bruce picks the rebuilt index up straight away — no restart needed.',
  );
}

main().catch((err) => {
  // A BuildError already reads as an explanation ("No .md files found in …"),
  // so it is printed as-is; anything else is an unexpected failure.
  const message = err instanceof Error ? err.message : String(err);
  console.error(err instanceof BuildError ? `\n${message}` : `\nIndexing failed: ${message}`);
  // Not process.exit(): calling it here, with the HTTP client's sockets still
  // being torn down, trips a libuv assertion on Windows and reports a garbage
  // exit code instead of 1. Setting the code lets Node finish closing them.
  process.exitCode = 1;
  // Failsafe in case a keep-alive socket would otherwise hold the process
  // open. Unref'd, so it never delays an exit that is already happening.
  setTimeout(() => process.exit(1), 250).unref();
});
