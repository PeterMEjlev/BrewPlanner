import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databasePath } from '../db/index.js';

/**
 * "Update brew system" button — deploys the latest pushed commit of
 * brew-system-v3 onto the brewing rig (the separate Pi) over SSH.
 *
 * Sibling of system/update.ts, with one structural difference: that update
 * restarts *this* server, so it has to hand off to a systemd unit. This one
 * only touches the rig, so a detached child process is enough — no unit file
 * and no sudoers entry on this side. It is still detached rather than awaited
 * because a build on the rig takes a minute or two, far longer than a request
 * should hang; progress goes to a status file the dashboard polls.
 *
 * The heater guard below is the reason this isn't just an SSH one-liner:
 * updating restarts the service that drives the elements, so doing it mid-brew
 * would drop the heaters without warning. deploy/update-brew-system.sh
 * re-checks the same thing right before the restart, since the build gives the
 * rig plenty of time to be switched on after this check passes.
 */

const DATA_DIR = dirname(databasePath);
const STATUS_FILE = resolve(DATA_DIR, 'brew-system-update-status.json');
const LOG_FILE = resolve(DATA_DIR, 'last-brew-system-update.log');

// Resolve the script from this module, NOT from the data dir: on the Pi the
// database deliberately lives outside the checkout (see checklist-server.service),
// so `DATA_DIR/..` is the home directory, not the repo. Four levels up from
// {src,dist}/system/ lands on the repo root in both dev and production.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '../../../..');
const SCRIPT = resolve(REPO_DIR, 'deploy/update-brew-system.sh');

const LOG_TAIL_BYTES = 16_000;

/** How long the rig gets to answer the pre-flight state check. */
const RIG_TIMEOUT_MS = 2500;

/**
 * A run older than this with no result is treated as dead rather than running,
 * so a crash mid-update can't wedge the button forever. Comfortably longer than
 * a slow `npm install` + Vite build on a Pi.
 */
const STALE_RUN_MS = 15 * 60 * 1000;

export type BrewSystemUpdateState = 'idle' | 'running' | 'ok' | 'failed';

export interface BrewSystemUpdateStatus {
  state: BrewSystemUpdateState;
  startedAt?: string;
  finishedAt?: string;
  /** Short hash the rig ended on. */
  commit?: string;
  commitSubject?: string;
  error?: string;
}

export interface BrewSystemUpdateStatusResponse extends BrewSystemUpdateStatus {
  /** Tail of the last run's combined output. */
  log: string;
}

export class BrewSystemUpdateInProgressError extends Error {
  constructor() {
    super('A brew system update is already in progress.');
    this.name = 'BrewSystemUpdateInProgressError';
  }
}

export class BrewSystemUpdateUnsupportedError extends Error {
  constructor() {
    super(
      `Updating the rig only works from the Pi — this server runs on ${process.platform}. ` +
        'Open the dashboard on the Pi and press the button there.',
    );
    this.name = 'BrewSystemUpdateUnsupportedError';
  }
}

export class BrewSystemUnconfiguredError extends Error {
  constructor() {
    super('The brewing rig is not configured (set BREW_SYSTEM_URL, or BREW_SYSTEM_SSH for a different host).');
    this.name = 'BrewSystemUnconfiguredError';
  }
}

/** The rig is heating or pumping — updating would restart it out from under a brew. */
export class BrewSystemBusyError extends Error {
  constructor(active: string[]) {
    super(
      `The rig is in use (${active.join(', ')} still on). Updating restarts it, ` +
        'which would cut the heaters — switch them off first.',
    );
    this.name = 'BrewSystemBusyError';
  }
}

/** The rig didn't answer, so we can't tell whether it's mid-brew. */
export class BrewSystemUnreachableError extends Error {
  constructor() {
    super('The brewing rig is not responding — is it powered on and on the network?');
    this.name = 'BrewSystemUnreachableError';
  }
}

/** The updater script isn't where it should be — a broken or partial deploy. */
export class BrewSystemUpdateScriptMissingError extends Error {
  constructor(path: string) {
    super(`The updater script is missing (${path}). Deploy the dashboard first.`);
    this.name = 'BrewSystemUpdateScriptMissingError';
  }
}

function rigBase(): string | null {
  const url = process.env.BREW_SYSTEM_URL?.trim().replace(/\/+$/, '');
  return url ? url : null;
}

async function readStatusFile(): Promise<BrewSystemUpdateStatus> {
  try {
    const parsed = JSON.parse(await readFile(STATUS_FILE, 'utf8')) as BrewSystemUpdateStatus;
    if (parsed && typeof parsed.state === 'string') return parsed;
  } catch {
    // Missing or corrupt → never run.
  }
  return { state: 'idle' };
}

/** True when a status says "running" but has been saying so for implausibly long. */
function isStale(status: BrewSystemUpdateStatus): boolean {
  if (status.state !== 'running' || !status.startedAt) return false;
  const started = Date.parse(status.startedAt);
  return Number.isFinite(started) && Date.now() - started > STALE_RUN_MS;
}

async function readLogTail(): Promise<string> {
  try {
    const raw = await readFile(LOG_FILE, 'utf8');
    return raw.length > LOG_TAIL_BYTES ? raw.slice(-LOG_TAIL_BYTES) : raw;
  } catch {
    return '';
  }
}

export async function readBrewSystemUpdateStatus(): Promise<BrewSystemUpdateStatusResponse> {
  const [status, log] = await Promise.all([readStatusFile(), readLogTail()]);
  if (isStale(status)) {
    return {
      state: 'failed',
      startedAt: status.startedAt,
      error: 'The update stopped reporting progress — it may have died. Check the log below.',
      log,
    };
  }
  return { ...status, log };
}

/** Names of anything currently drawing power on the rig. Throws if it can't tell. */
async function activeHardware(base: string): Promise<string[]> {
  let state: {
    controlState?: {
      pots?: Record<string, { heaterOn?: boolean }>;
      pumps?: Record<string, { on?: boolean }>;
    };
  };
  try {
    const res = await fetch(`${base}/api/hardware/state`, {
      signal: AbortSignal.timeout(RIG_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`rig answered ${res.status}`);
    state = (await res.json()) as typeof state;
  } catch {
    throw new BrewSystemUnreachableError();
  }
  const pots = state.controlState?.pots ?? {};
  const pumps = state.controlState?.pumps ?? {};
  return [
    ...Object.entries(pots)
      .filter(([, p]) => p?.heaterOn)
      .map(([name]) => name),
    ...Object.entries(pumps)
      .filter(([, p]) => p?.on)
      .map(([name]) => name),
  ];
}

/**
 * Start a rig deploy. Returns as soon as it's launched; poll
 * {@link readBrewSystemUpdateStatus} for progress.
 */
export async function triggerBrewSystemUpdate(): Promise<BrewSystemUpdateStatus> {
  if (process.platform !== 'linux') throw new BrewSystemUpdateUnsupportedError();

  const base = rigBase();
  if (!base && !process.env.BREW_SYSTEM_SSH) throw new BrewSystemUnconfiguredError();

  const current = await readStatusFile();
  if (current.state === 'running' && !isStale(current)) throw new BrewSystemUpdateInProgressError();

  // Fail loudly here rather than leaving a detached child to die silently.
  try {
    await access(SCRIPT);
  } catch {
    throw new BrewSystemUpdateScriptMissingError(SCRIPT);
  }

  // Pre-flight: never restart a rig that's mid-brew. Skipped only when there's
  // no HTTP base to ask (SSH-only config), where the remote script's own check
  // is the backstop.
  if (base) {
    const active = await activeHardware(base);
    if (active.length > 0) throw new BrewSystemBusyError(active);
  }

  const startedAt = new Date().toISOString();
  await writeFile(
    STATUS_FILE,
    JSON.stringify({ state: 'running', startedAt } satisfies BrewSystemUpdateStatus),
  );

  // Detached with its own session: the script outlives this request, and would
  // outlive the server being restarted mid-run. It writes its own final status,
  // so nothing here needs to wait for it.
  const child = spawn('/bin/bash', [SCRIPT], {
    cwd: REPO_DIR,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.on('error', (err) => {
    void writeFile(
      STATUS_FILE,
      JSON.stringify({
        state: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        error: `Could not start ${SCRIPT}: ${err.message}`,
      } satisfies BrewSystemUpdateStatus),
    );
  });
  child.unref();

  return { state: 'running', startedAt };
}
