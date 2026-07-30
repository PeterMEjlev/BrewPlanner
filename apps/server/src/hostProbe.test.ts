import type { HostStatus } from '@checklist/shared';
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyProbeValues, parseProbeOutput } from './system/hosts.js';

/**
 * The rig's vitals come back as `key=value` lines from a shell probe run over
 * SSH (see system/hosts.ts). Everything interesting happens between that text
 * and the card on the Devices page: kB and millidegrees have to become bytes and
 * °C, and a field the rig couldn't answer has to become a null rather than a
 * zero — a Pi reporting "0 °C" or "0 GB free" would be read as a real problem.
 *
 * The sample below is real output from the brewing rig.
 */

const PROBE = `hostname=raspberrypi
model=Raspberry Pi 4 Model B Rev 1.5
os=Debian GNU/Linux 12 (bookworm)
kernel=6.6.62+rpt-rpi-v8
uptime=7043.16
load=0.63
cpus=4
temp=59887
memtotal=7997328
memavail=6983992
disktotal=122322964
diskused=11053284
ip=192.168.3.4
service=active
commit=7c138f8
subject=Actually apply the 10-bit DS18B20 resolution
`;

const BASE: HostStatus = {
  id: 'brewsystem',
  name: 'Brew System Pi',
  role: 'Brewing rig controller (brew-system-v3)',
  online: false,
  hostname: null,
  model: null,
  os: null,
  kernel: null,
  ip: '192.168.3.4',
  uptimeSec: null,
  cpuTempC: null,
  loadAvg1: null,
  cpuCount: null,
  memTotalBytes: null,
  memUsedBytes: null,
  diskTotalBytes: null,
  diskUsedBytes: null,
  serviceName: 'brew-system.service',
  serviceActive: null,
  commit: null,
  commitSubject: null,
};

test('a rig that answers is described in the units the dashboard shows', () => {
  const host = applyProbeValues(BASE, parseProbeOutput(PROBE), false);

  assert.equal(host.online, true);
  assert.equal(host.hostname, 'raspberrypi');
  assert.equal(host.model, 'Raspberry Pi 4 Model B Rev 1.5');
  assert.equal(host.cpuCount, 4);
  // Millidegrees in, °C out — 59887 is a warm-but-fine Pi, not 59,887 degrees.
  assert.ok(host.cpuTempC != null && Math.abs(host.cpuTempC - 59.887) < 1e-9);
  // kB in, bytes out. Used memory is total minus *available*.
  assert.equal(host.memTotalBytes, 7997328 * 1024);
  assert.equal(host.memUsedBytes, (7997328 - 6983992) * 1024);
  assert.equal(host.diskTotalBytes, 122322964 * 1024);
  assert.equal(host.diskUsedBytes, 11053284 * 1024);
  assert.equal(host.serviceActive, true);
  assert.equal(host.commit, '7c138f8');
  assert.equal(host.commitSubject, 'Actually apply the 10-bit DS18B20 resolution');
});

test('a value with an "=" in it survives the parse', () => {
  // Commit subjects are free text and do reach this parser.
  const values = parseProbeOutput('subject=Fix x=y in the settings screen\n');
  assert.equal(values.get('subject'), 'Fix x=y in the settings screen');
});

test('fields the rig could not answer become null, never zero', () => {
  // A sensor-less board, an empty `systemctl is-active`, no git checkout.
  const values = parseProbeOutput('hostname=raspberrypi\ntemp=\nservice=\nmemtotal=\n');
  const host = applyProbeValues(BASE, values, false);

  assert.equal(host.cpuTempC, null);
  assert.equal(host.memTotalBytes, null);
  assert.equal(host.memUsedBytes, null);
  assert.equal(host.commit, null);
  // Nothing to go on from systemd, and the brewing API wasn't answering either.
  assert.equal(host.serviceActive, null);
});

test('a live brewing API stands in for a systemd answer we could not get', () => {
  const host = applyProbeValues(BASE, parseProbeOutput('service=\n'), true);
  assert.equal(host.serviceActive, true);
});

test('a stopped unit is reported stopped even while the API still answers', () => {
  // The unit is the authority: a stale HTTP success must not paint it green.
  const host = applyProbeValues(BASE, parseProbeOutput('service=inactive\n'), true);
  assert.equal(host.serviceActive, false);
});

test('an unreadable IP falls back to the address we reached the host on', () => {
  const host = applyProbeValues(BASE, parseProbeOutput('hostname=raspberrypi\n'), false);
  assert.equal(host.ip, '192.168.3.4');
});
