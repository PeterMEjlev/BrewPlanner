import type { HostStatus } from '@checklist/shared';
import { execFile, spawn } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import { createConnection } from 'node:net';
import {
  availableParallelism,
  hostname,
  loadavg,
  networkInterfaces,
  release,
  totalmem,
  uptime,
} from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Vitals for the two Raspberry Pis the brewery runs on, for the Devices page.
 *
 * Every other device there is a satellite that pushes readings to the hub. These
 * two are the hub and the rig themselves — nothing reports them, so this module
 * reads them: the local box straight from /proc and /sys, the rig over the same
 * SSH trust the updater uses (see deploy/update-brew-system.sh).
 *
 * The rig is powered off between brew sessions, and a dead host is the slowest thing
 * to ask a question of. So a reachability probe on port 22 runs first and skips
 * the SSH entirely when nothing is listening — an offline rig costs ~1s rather
 * than the full connect timeout, and the answer is cached either way.
 */

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
// Four levels up from {src,dist}/system/ is the repo root, in dev and on the Pi.
const REPO_DIR = resolve(__dirname, '../../../..');

/** The unit each host's app runs under, for the "Service" row. */
const LOCAL_UNIT = 'checklist-server.service';
const RIG_UNIT = 'brew-system.service';

/**
 * How long a gathered snapshot is served before being read again. Vitals move
 * slowly (temperature, disk, uptime), and the cache is what keeps several open
 * dashboards from each opening an SSH connection to the rig.
 */
const CACHE_MS = 20_000;

/** Reachability probe on the rig's SSH port, before committing to a login. */
const PORT_PROBE_MS = 1200;
/** Ceiling on the whole remote gather — it's one short command over one connection. */
const SSH_TIMEOUT_MS = 8000;
const RIG_SSH_PORT = 22;

let cache: { at: number; hosts: HostStatus[] } | null = null;
let inFlight: Promise<HostStatus[]> | null = null;

/** Where the rig lives, e.g. `http://192.168.3.4:8000`. Null when unconfigured. */
function rigBase(): string | null {
  const url = process.env.BREW_SYSTEM_URL?.trim().replace(/\/+$/, '');
  return url ? url : null;
}

/** The rig's hostname/IP on its own, dropping scheme, path and port. */
function rigHost(): string | null {
  const explicit = process.env.BREW_SYSTEM_SSH?.trim();
  if (explicit) return explicit.includes('@') ? explicit.split('@')[1]! : explicit;
  const base = rigBase();
  if (!base) return null;
  try {
    return new URL(base).hostname || null;
  } catch {
    return null;
  }
}

/** `user@host` for SSH, mirroring how deploy/update-brew-system.sh picks its target. */
function rigSshTarget(): string | null {
  const explicit = process.env.BREW_SYSTEM_SSH?.trim();
  if (explicit) return explicit;
  const host = rigHost();
  return host ? `${process.env.BREW_SYSTEM_SSH_USER ?? 'pi'}@${host}` : null;
}

async function readText(path: string): Promise<string | null> {
  try {
    // Device-tree strings are NUL-terminated; trim them so they don't reach the UI.
    return (await readFile(path, 'utf8')).replace(/\0/g, '').trim() || null;
  } catch {
    return null;
  }
}

function numberOr(value: string | undefined, divisor = 1): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n / divisor : null;
}

/** PRETTY_NAME out of an /etc/os-release body. */
function prettyName(osRelease: string | null): string | null {
  const match = osRelease?.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
  return match?.[1] ?? null;
}

/** The first non-internal IPv4 address — the one the brewery LAN reaches us on. */
function localIp(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

/** Memory actually under pressure: total minus MemAvailable, not minus free. */
function usedMemory(meminfo: string | null): number | null {
  const available = meminfo?.match(/^MemAvailable:\s+(\d+) kB/m)?.[1];
  if (!available) return null;
  const used = totalmem() - Number(available) * 1024;
  return used >= 0 ? used : null;
}

async function localDisk(): Promise<{ total: number; used: number } | null> {
  try {
    const fs = await statfs('/');
    const total = Number(fs.blocks) * Number(fs.bsize);
    const used = total - Number(fs.bfree) * Number(fs.bsize);
    return total > 0 ? { total, used } : null;
  } catch {
    return null;
  }
}

/** `systemctl is-active` as a tri-state — null when there's no systemd to ask. */
async function unitActive(unit: string): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', unit], { timeout: 4000 });
    return stdout.trim() === 'active';
  } catch (err) {
    // `is-active` exits non-zero for an inactive unit, which rejects here — that
    // is still a definite answer, unlike systemctl not existing at all.
    const stdout = (err as { stdout?: string }).stdout?.trim();
    if (stdout) return stdout === 'active';
    return null;
  }
}

async function localCommit(): Promise<{ commit: string | null; subject: string | null }> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['--no-pager', 'log', '-1', '--pretty=%h%x09%s'],
      { cwd: REPO_DIR, timeout: 4000 },
    );
    const [commit, subject] = stdout.trim().split('\t');
    return { commit: commit || null, subject: subject || null };
  } catch {
    return { commit: null, subject: null };
  }
}

/** This machine — the one serving this request. */
async function readLocalHost(): Promise<HostStatus> {
  const [model, osRelease, meminfo, temp, disk, serviceActive, git] = await Promise.all([
    readText('/proc/device-tree/model'),
    readText('/etc/os-release'),
    readText('/proc/meminfo'),
    readText('/sys/class/thermal/thermal_zone0/temp'),
    localDisk(),
    unitActive(LOCAL_UNIT),
    localCommit(),
  ]);

  return {
    id: 'brewplanner',
    name: 'BrewPlanner Pi',
    role: 'Dashboard, database & device hub',
    online: true,
    hostname: hostname(),
    model,
    os: prettyName(osRelease),
    kernel: release(),
    ip: localIp(),
    uptimeSec: Math.round(uptime()),
    cpuTempC: temp ? numberOr(temp, 1000) : null,
    loadAvg1: Number(loadavg()[0]?.toFixed(2)) || 0,
    cpuCount: availableParallelism(),
    memTotalBytes: totalmem(),
    memUsedBytes: usedMemory(meminfo),
    diskTotalBytes: disk?.total ?? null,
    diskUsedBytes: disk?.used ?? null,
    serviceName: LOCAL_UNIT,
    serviceActive,
    commit: git.commit,
    commitSubject: git.subject,
  };
}

/** Is anything listening on the rig's SSH port? Cheap stand-in for "is it on?". */
function portOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    const done = (open: boolean): void => {
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * One shell command on the rig, printing `key=value` lines. Everything it reads
 * is a plain file or a one-shot command, so this is a single round trip rather
 * than one per field, and any single missing value just comes back empty.
 */
const REMOTE_PROBE = `
printf 'hostname=%s\\n' "$(hostname)"
printf 'model=%s\\n' "$(tr -d '\\0' < /proc/device-tree/model 2>/dev/null)"
printf 'os=%s\\n' "$(. /etc/os-release 2>/dev/null; printf '%s' "$PRETTY_NAME")"
printf 'kernel=%s\\n' "$(uname -r)"
printf 'uptime=%s\\n' "$(cut -d' ' -f1 /proc/uptime)"
printf 'load=%s\\n' "$(cut -d' ' -f1 /proc/loadavg)"
printf 'cpus=%s\\n' "$(nproc)"
printf 'temp=%s\\n' "$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null)"
printf 'memtotal=%s\\n' "$(awk '/^MemTotal:/{print $2}' /proc/meminfo)"
printf 'memavail=%s\\n' "$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)"
printf 'disktotal=%s\\n' "$(df -kP / | awk 'NR==2{print $2}')"
printf 'diskused=%s\\n' "$(df -kP / | awk 'NR==2{print $3}')"
printf 'ip=%s\\n' "$(hostname -I 2>/dev/null | cut -d' ' -f1)"
printf 'service=%s\\n' "$(systemctl is-active ${RIG_UNIT} 2>/dev/null)"
REPO="$(systemctl show ${RIG_UNIT} -p WorkingDirectory --value 2>/dev/null)"
if [ -n "$REPO" ] && [ -d "$REPO/.git" ]; then
  printf 'commit=%s\\n' "$(git -C "$REPO" --no-pager log -1 --pretty=%h 2>/dev/null)"
  printf 'subject=%s\\n' "$(git -C "$REPO" --no-pager log -1 --pretty=%s 2>/dev/null)"
fi
`;

/**
 * Run the probe over SSH, returning its `key=value` lines as a map. The script
 * goes in over stdin (`sh -s`) rather than as an argument, so nothing in it has
 * to survive a second round of shell quoting.
 */
function runSshProbe(target: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=5',
        '-o',
        'StrictHostKeyChecking=accept-new',
        target,
        'sh -s',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), SSH_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`ssh ${target} exited ${code ?? 'on a signal'}`));
    });
    child.stdin.end(REMOTE_PROBE);
  });
}

/**
 * The probe's `key=value` lines as a map. Empty values are dropped rather than
 * stored as `''`, so a field the rig couldn't answer reads as absent — which is
 * what {@link applyProbeValues} turns back into a null.
 */
export function parseProbeOutput(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      const value = line.slice(eq + 1).trim();
      if (value) values.set(line.slice(0, eq), value);
    }
  }
  return values;
}

/**
 * Fold a parsed probe onto a host record, converting the units the kernel hands
 * out: memory and disk in kB, SoC temperature in millidegrees.
 *
 * `apiUp` is the fallback opinion on the service — used only when systemd
 * couldn't be asked, since a rig whose brewing API answers is plainly running it.
 */
export function applyProbeValues(
  base: HostStatus,
  values: Map<string, string>,
  apiUp: boolean,
): HostStatus {
  const memTotal = numberOr(values.get('memtotal'));
  const memAvail = numberOr(values.get('memavail'));
  const diskTotal = numberOr(values.get('disktotal'));
  const diskUsed = numberOr(values.get('diskused'));
  const service = values.get('service');
  return {
    ...base,
    online: true,
    hostname: values.get('hostname') ?? null,
    model: values.get('model') ?? null,
    os: values.get('os') ?? null,
    kernel: values.get('kernel') ?? null,
    ip: values.get('ip') ?? base.ip,
    uptimeSec: numberOr(values.get('uptime')),
    cpuTempC: numberOr(values.get('temp'), 1000),
    loadAvg1: numberOr(values.get('load')),
    cpuCount: numberOr(values.get('cpus')),
    memTotalBytes: memTotal != null ? memTotal * 1024 : null,
    memUsedBytes: memTotal != null && memAvail != null ? (memTotal - memAvail) * 1024 : null,
    diskTotalBytes: diskTotal != null ? diskTotal * 1024 : null,
    diskUsedBytes: diskUsed != null ? diskUsed * 1024 : null,
    serviceActive: service ? service === 'active' : apiUp ? true : null,
    commit: values.get('commit') ?? null,
    commitSubject: values.get('subject') ?? null,
  };
}

/** Does the rig's brewing API answer? A second opinion on `service`, over HTTP. */
async function rigApiUp(): Promise<boolean> {
  const base = rigBase();
  if (!base) return false;
  try {
    const res = await fetch(`${base}/api/hardware/state`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The brewing rig, read over SSH. Powered off is its normal state, not an error. */
async function readRigHost(): Promise<HostStatus | null> {
  const host = rigHost();
  const target = rigSshTarget();
  if (!host || !target) return null;

  const base: HostStatus = {
    id: 'brewsystem',
    name: 'Brew System Pi',
    role: 'Brewing rig controller (brew-system-v3)',
    online: false,
    hostname: null,
    model: null,
    os: null,
    kernel: null,
    ip: host,
    uptimeSec: null,
    cpuTempC: null,
    loadAvg1: null,
    cpuCount: null,
    memTotalBytes: null,
    memUsedBytes: null,
    diskTotalBytes: null,
    diskUsedBytes: null,
    serviceName: RIG_UNIT,
    serviceActive: null,
    commit: null,
    commitSubject: null,
  };

  const [sshReachable, apiUp] = await Promise.all([
    portOpen(host, RIG_SSH_PORT, PORT_PROBE_MS),
    rigApiUp(),
  ]);

  if (!sshReachable) {
    // The API answering without SSH is odd but real (sshd stopped), so believe
    // whichever one did reply about whether the box is up.
    return apiUp
      ? { ...base, online: true, serviceActive: true, error: 'SSH is not answering — vitals unavailable.' }
      : base;
  }

  try {
    return applyProbeValues(base, parseProbeOutput(await runSshProbe(target)), apiUp);
  } catch {
    return {
      ...base,
      online: true,
      serviceActive: apiUp ? true : null,
      error: 'Could not read its vitals over SSH — is the key still authorised?',
    };
  }
}

/**
 * Both Pis, newest reading no older than {@link CACHE_MS}. Concurrent callers
 * share one gather; the rig is omitted entirely when no rig is configured.
 */
export async function readHosts(): Promise<HostStatus[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.hosts;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const [local, rig] = await Promise.all([readLocalHost(), readRigHost()]);
      const hosts = rig ? [local, rig] : [local];
      cache = { at: Date.now(), hosts };
      return hosts;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
