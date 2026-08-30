import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { KnowledgeChunk } from './knowledge/chunk.js';
import { balanceSources } from './knowledge/store.js';

/**
 * The exBEERiment cap on retrieval (knowledge/store.ts `balanceSources`).
 *
 * The shelf is fourteen exBEERiment catalogues against two books, so an
 * unweighted top-k is usually all exBEERiments and Bruce's answer turns into a
 * survey of split-batch tests. What matters is that capping never costs the
 * model passages it would otherwise have had: when the books are silent, the
 * capped exBEERiments must come back to fill the empty slots.
 */

function hit(file: string, score: number): { chunk: KnowledgeChunk; score: number } {
  return { chunk: { file, title: file, section: '', text: 'x' }, score };
}

const book = (score: number) => hit('water-a-comprehensive-guide-for-brewers.md', score);
const exp = (score: number) => hit('brulosophy_hops_and_hopping_exbeeriments.md', score);

describe('balanceSources', () => {
  it('caps exBEERiments when books are available to promote', () => {
    const kept = balanceSources(
      [exp(0.9), exp(0.88), exp(0.86), exp(0.84), book(0.5), book(0.4)],
      4,
      2,
    );
    assert.equal(kept.filter((h) => h.chunk.file.startsWith('brulosophy')).length, 2);
    assert.equal(kept.length, 4);
  });

  it('keeps the highest-scoring exBEERiments when it caps', () => {
    const kept = balanceSources([exp(0.9), exp(0.5), exp(0.3), book(0.4)], 3, 2);
    assert.deepEqual(
      kept.map((h) => h.score),
      [0.9, 0.5, 0.4],
    );
  });

  it('backfills with capped exBEERiments rather than returning fewer passages', () => {
    const kept = balanceSources([exp(0.9), exp(0.8), exp(0.7), exp(0.6)], 4, 2);
    assert.equal(kept.length, 4);
  });

  it('returns hits best first', () => {
    const kept = balanceSources([exp(0.9), book(0.8), exp(0.7), book(0.6)], 4, 2);
    assert.deepEqual(
      kept.map((h) => h.score),
      [0.9, 0.8, 0.7, 0.6],
    );
  });

  it('leaves an all-book result untouched', () => {
    const kept = balanceSources([book(0.9), book(0.8)], 6, 2);
    assert.equal(kept.length, 2);
  });
});
