import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { databasePath } from '../db/index.js';

const execFileAsync = promisify(execFile);

/**
 * Remote software update ("deploy" button). The dashboard is internet-reachable
 * and admin-authed through the Cloudflare tunnel, so an admin can trigger a
 * pull + rebuild + restart from anywhere without SSH.
 *
 * The tricky bit is that the update restarts the very server process that asked
 * for it. So we don't run `update.sh` as a child of this process — we ask
 * systemd to start a *separate* one-shot unit (`brewplanner-update.service`),
 * which survives `checklist-server` bouncing. Progress is reported out-of-band
 * via a status file + log that the script writes into the data dir (the same
 * dir as the SQLite DB, which is preserved across rebuilds), so this server can
 * read it again after it comes back up.
 */

const UPDATE_UNIT = 'brewplanner-update.service';

// Status + log live next to the database (DATA_DIR survives rebuilds). The
// one-shot updater writes the same files; see deploy/update.sh.
const DATA_DIR = dirname(databasePath);
const STATUS_FILE = resolve(DATA_DIR, 'update-status.json');
const LOG_FILE = resolve(DATA_DIR, 'last-update.log');

// Resolve the repo from this module, NOT from the data dir: on the Pi the
// database deliberately lives outside the checkout (checklist-server.service
// sets DATABASE_PATH=/home/brewplanner/data/…), so `DATA_DIR/..` is the home
// directory. Four levels up from {src,dist}/system/ is the repo root in both
// dev and production.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '../../../..');

// Cap the log we hand back to the UI; deploys are short and we only need the tail.
const LOG_TAIL_BYTES = 16_000;

export type UpdateState = 'idle' | 'running' | 'ok' | 'failed';

/** The on-disk status the updater writes (and we seed when triggering). */
export interface UpdateStatus {
  state: UpdateState;
  startedAt?: string;
  finishedAt?: string;
  /** Short hash the deploy ended on. */
  commit?: string;
  commitSubject?: string;
  error?: string;
}

/** What `GET /system/update/status` returns: the status plus live context. */
export interface UpdateStatusResponse extends UpdateStatus {
  /** Tail of the last run's combined stdout/stderr. */
  log: string;
  /** The repo's current HEAD short hash, read live. */
  repoCommit: string;
}

/** Thrown by {@link triggerUpdate} when a deploy is already running. */
export class UpdateInProgressError extends Error {
  constructor() {
    super('An update is already in progress.');
    this.name = 'UpdateInProgressError';
  }
}

/** Thrown by {@link triggerUpdate} when this host has no systemd to drive. */
export class UpdateUnsupportedError extends Error {
  constructor() {
    super(
      `Remote update only works on the Pi — this server is running on ${process.platform}, ` +
        'which has no systemd. Point the dashboard at the Pi and press Update there.',
    );
    this.name = 'UpdateUnsupportedError';
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readStatusFile(): Promise<UpdateStatus> {
  try {
    const parsed = JSON.parse(await readFile(STATUS_FILE, 'utf8')) as UpdateStatus;
    if (parsed && typeof parsed.state === 'string') return parsed;
  } catch {
    // Missing or corrupt → treat as never-run.
  }
  return { state: 'idle' };
}

async function readLogTail(): Promise<string> {
  try {
    const raw = await readFile(LOG_FILE, 'utf8');
    return raw.length > LOG_TAIL_BYTES ? raw.slice(-LOG_TAIL_BYTES) : raw;
  } catch {
    return '';
  }
}

async function repoHead(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO_DIR,
    });
    return stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Read the current deploy status plus the running commit and recent log. */
export async function readUpdateStatus(): Promise<UpdateStatusResponse> {
  const [status, log, repoCommit] = await Promise.all([
    readStatusFile(),
    readLogTail(),
    repoHead(),
  ]);
  return { ...status, log, repoCommit };
}

/**
 * Kick off a deploy by starting the one-shot updater unit. Returns immediately
 * (`--no-block`); poll {@link readUpdateStatus} for progress. Refuses if a
 * deploy is already running. Uses `sudo -n` so a missing sudoers rule fails fast
 * instead of hanging on a password prompt.
 */
export async function triggerUpdate(): Promise<UpdateStatus> {
  // Dev boxes have no systemd, and on Windows `sudo` is a different program
  // entirely (it rejects `-n`), so the raw error is pure confusion. Bail before
  // touching the status file so a dev-machine click can't leave a bogus
  // "failed" deploy behind.
  if (process.platform !== 'linux') throw new UpdateUnsupportedError();

  const current = await readStatusFile();
  if (current.state === 'running') throw new UpdateInProgressError();

  const startedAt = new Date().toISOString();
  // Seed "running" so the UI flips immediately, before the script's own write.
  await writeFile(STATUS_FILE, JSON.stringify({ state: 'running', startedAt } satisfies UpdateStatus));

  try {
    await execFileAsync('sudo', ['-n', 'systemctl', 'start', '--no-block', UPDATE_UNIT]);
  } catch (err) {
    const failed: UpdateStatus = {
      state: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: `Could not start ${UPDATE_UNIT}. Is the unit installed and the sudoers rule in place? (${errMessage(err)})`,
    };
    await writeFile(STATUS_FILE, JSON.stringify(failed));
    throw err;
  }

  return { state: 'running', startedAt };
}
