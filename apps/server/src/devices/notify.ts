/**
 * Wake-ups for parked command polls — the hub's half of the "apply a setpoint
 * now" path.
 *
 * A satellite agent asks for its queued commands with `GET /api/commands?wait=N`
 * and the hub holds that request open here until something is queued for that
 * device (or the wait elapses). Without it, a setpoint change sat in
 * `device_commands` until the agent's next read cycle — up to a full logging
 * interval, which is five minutes on the brewery controllers.
 *
 * Deliberately in-process and deliberately tiny: one Fastify instance owns every
 * device connection, so a Map of pending resolvers is the entire mechanism — no
 * broker, no table polling, nothing to keep running. The queue in SQLite stays
 * the source of truth; this only decides *when* an agent is told to look at it.
 * If the hub restarts, parked polls simply drop, every agent reconnects, and the
 * pending row is still there — so a missed wake-up costs latency, never a write.
 */

/** A parked poll, resolved when its device gets a command. */
type Waiter = () => void;

const waiters = new Map<number, Set<Waiter>>();

/**
 * Park until a command is queued for `deviceId`, `timeoutMs` elapses, or
 * `signal` aborts (the agent hung up). Resolves true only when woken by a real
 * queued command, so the caller knows whether to re-read the queue.
 */
export function waitForCommand(
  deviceId: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout;

    // Every exit path runs this exactly once: a wake-up, the timeout, and a
    // dropped connection all have to clear the timer and drop the registration,
    // or a flapping agent would leak a waiter per reconnect.
    const finish = (woken: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const parked = waiters.get(deviceId);
      if (parked) {
        parked.delete(waiter);
        if (parked.size === 0) waiters.delete(deviceId);
      }
      resolve(woken);
    };

    const waiter: Waiter = () => finish(true);
    const onAbort = (): void => finish(false);

    timer = setTimeout(() => finish(false), timeoutMs);
    // A parked poll must never be the reason the process stays alive — it holds
    // no state worth draining on shutdown.
    timer.unref();

    let parked = waiters.get(deviceId);
    if (!parked) {
      parked = new Set();
      waiters.set(deviceId, parked);
    }
    parked.add(waiter);
    signal?.addEventListener('abort', onAbort);
  });
}

/**
 * Wake every poll parked on this device. Called right after a command is written
 * to the queue (see {@link import('./repo.js').queueSetpoint}); safe to call when
 * nothing is parked, which is the normal case for an offline or busy agent.
 */
export function notifyCommandQueued(deviceId: number): void {
  const parked = waiters.get(deviceId);
  if (!parked) return;
  // Copy first: each waiter deregisters itself as it resolves, which mutates the
  // set we would otherwise be iterating.
  for (const waiter of [...parked]) waiter();
}
