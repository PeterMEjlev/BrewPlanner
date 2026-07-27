/**
 * The index rebuild as a background job, so the dashboard can trigger one.
 *
 * Embedding a freshly uploaded book takes a minute or two — far longer than a
 * request should stay open, and longer than a kiosk browser will wait. So the
 * route starts a job and returns immediately, and the Bruce page polls
 * `GET /api/bruce/knowledge` for the progress reported here.
 *
 * One at a time, deliberately: two concurrent builds would both write
 * knowledge-index.* and the loser would silently overwrite the winner. The
 * state lives in this module rather than in the database because it is about
 * this process — a restart mid-build loses the job, and the index on disk is
 * whatever the last completed build wrote.
 */

import type { BruceIndexJob } from '@checklist/shared';
import { isOpenAIConfigured } from '../openai.js';
import { BuildError, planBuild, runBuild } from './build.js';

let job: BruceIndexJob | null = null;

/** The latest rebuild — running or finished. Null until one has been asked for. */
export function indexJob(): BruceIndexJob | null {
  return job;
}

/**
 * Plan a rebuild and start embedding in the background.
 *
 * Planning happens synchronously so the caller still gets a real error (no
 * files, nothing chunked, no API key) instead of a job that fails a second
 * later somewhere nobody is looking. Throws `BuildError` for anything the
 * person who pressed the button should read.
 */
export function startIndexJob(options: { force?: boolean; note?: string } = {}): BruceIndexJob {
  if (job?.state === 'running') {
    throw new BuildError('A rebuild is already running — wait for it to finish.');
  }
  if (!isOpenAIConfigured()) {
    throw new BuildError('OPENAI_API_KEY is not set on the server, so there is nothing to embed with.');
  }

  const plan = planBuild(options.force ?? false);
  const startedAt = new Date().toISOString();

  // Nothing changed since the last build: report a finished job rather than
  // spinning up a run that would embed zero passages. `total: 0` is how the
  // page knows to say so — `note` stays a file name, never a sentence.
  if (plan.pending.length === 0) {
    job = { state: 'ok', startedAt, finishedAt: startedAt, embedded: 0, total: 0 };
    return job;
  }

  const running: BruceIndexJob = {
    state: 'running',
    startedAt,
    embedded: 0,
    total: plan.pending.length,
    ...(options.note ? { note: options.note } : {}),
  };
  job = running;

  // Not awaited: the caller answers the HTTP request while this runs on.
  void (async () => {
    try {
      await runBuild(plan, (embedded, total) => {
        // Only if this job is still the current one — a restart of the process
        // is the only way that changes, but the check keeps a stale closure
        // from clobbering a newer job's progress.
        if (job === running) {
          running.embedded = embedded;
          running.total = total;
        }
      });
      running.state = 'ok';
      running.embedded = running.total;
    } catch (err) {
      running.state = 'failed';
      running.error = err instanceof Error ? err.message : String(err);
    } finally {
      running.finishedAt = new Date().toISOString();
    }
  })();

  return job;
}
