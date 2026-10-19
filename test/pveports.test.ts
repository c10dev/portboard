import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachLan, attachPvePorts, mergeDevices, parsePeers, type Devices } from '../src/core/devices.ts';
import { matchGuests, type ProxmoxStatus } from '../src/core/proxmox.ts';
import {
  checkConfig, classify, DEFAULT_CONFIG, INTERVAL, nextDelay, parseListeners, parseOutput, processName, PvePortsCollector, SETUP_URL, sshArgs, STALE_AFTER,
} from '../src/core/pveports.ts';
import type { RunResult } from '../src/core/exec.ts';
import type { Topology } from '../src/core/topology.ts';
import { buildUsage } from '../src/core/usage.ts';
import { redactDevices } from '../src/remote/redact.ts';

const PVE1 = readFileSync(new URL('./fixtures/pveports-pve1.txt', import.meta.url), 'utf8');
const VARIANTS = readFileSync(new URL('./fixtures/pveports-variants.txt', import.meta.url), 'utf8');

// ---- parsing ----

test('parseOutput splits host and container sections and names each socket\'s owner', () => {
  const r = parseOutput(PVE1, 42)!;
  assert.equal(r.at, 42);
  const host = Object.fromEntries(r.host.map((l) => [`${l.address}:${l.port}`, l.process]));
  assert.equal(host['*:8006'], 'pveproxy'); // not "pveproxy worker"
  assert.equal(host['127.0.0.1:85'], 'pvedaemon');
  assert.equal(host['0.0.0.0:111'], 'rpcbind'); // not the socket-activating systemd
  assert.equal(host['::1:25'], 'master');
  assert.equal(host['fd7a:115c:a1e0::5c01:8380:39811'], 'tailscaled');
  assert.deepEqual(Object.keys(r.cts), ['203', '204']);
  assert.deepEqual([...new Set(r.cts[203].map((l) => l.port))].sort((a, b) => a - b), [22, 139, 445, 5357, 45213]);
  assert.deepEqual(r.cts[204].find((l) => l.port === 8096), { port: 8096, address: '0.0.0.0', process: 'jellyfin' });
});

test('parseOutput: ss without -p, netstat with headers (and a -p column), ss headers, junk; no host section → null', () => {
  const r = parseOutput(VARIANTS, 1)!;
  assert.deepEqual(r.host, [{ port: 22, address: '0.0.0.0' }, { port: 8006, address: '*' }]);
  assert.deepEqual(r.cts[210], [{ port: 8096, address: '0.0.0.0' }, { port: 631, address: '127.0.0.1', process: 'cupsd' }, { port: 22, address: '::' }]);
  assert.deepEqual(r.cts[211], [{ port: 53, address: '127.0.0.53' }, { port: 3000, address: '::1' }]);
  assert.deepEqual(r.cts[212], []); // a CT whose tools printed nothing usable
  assert.equal(parseOutput('## ct 203\nLISTEN 0 50 0.0.0.0:445 0.0.0.0:*\n'), null);
  assert.equal(parseOutput(''), null);
  assert.equal(parseOutput('sh: /usr/local/bin/portboard-ports: not found\n'), null);
  // a host section with nothing in it is still an answer
  assert.deepEqual(parseOutput('## host\n', 5), { at: 5, host: [], cts: {} });
});

test('parseListeners drops duplicates and out-of-range ports; processName prefers the parent over systemd', () => {
  const rows = parseListeners('LISTEN 0 1 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))\nLISTEN 0 1 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))\nLISTEN 0 1 0.0.0.0:70000 0.0.0.0:*\n');
  assert.deepEqual(rows, [{ port: 22, address: '0.0.0.0', process: 'sshd' }]);
  assert.equal(processName(['systemd']), 'systemd');
  assert.equal(processName(['spiceproxy work', 'spiceproxy']), 'spiceproxy');
  assert.equal(processName([]), undefined);
});

// ---- config, ssh, errors, schedule ----

test('checkConfig: pve1 defaults; host and user can\'t smuggle ssh options', () => {
  assert.deepEqual(checkConfig(undefined), DEFAULT_CONFIG);
  assert.deepEqual(checkConfig({ node: 'pve02', host: 'pve02.lan' }), { ...DEFAULT_CONFIG, node: 'pve02', host: 'pve02.lan' });
  assert.match(checkConfig({ host: '-oProxyCommand=touch /tmp/x' }) as string, /host/);
  assert.match(checkConfig({ user: 'root -o x' }) as string, /user/);
  assert.match(checkConfig({ enabled: 'yes' }) as string, /enabled/);
  assert.match(checkConfig([]) as string, /object/);
});

test('sshArgs: key auth only, known host key only, no config files, destination last and no remote command', () => {
  const a = sshArgs({ ...DEFAULT_CONFIG, host: '192.168.1.201', user: 'root' });
  const opts = a.filter((_, i) => a[i - 1] === '-o');
  for (const o of ['BatchMode=yes', 'IdentitiesOnly=yes', 'StrictHostKeyChecking=yes', 'PasswordAuthentication=no']) assert.ok(opts.includes(o), o);
  assert.equal(a[a.indexOf('-F') + 1], '/dev/null');
  assert.match(a[a.indexOf('-i') + 1], /\.ssh\/portboard_ro$/);
  assert.deepEqual(a.slice(-3), ['-l', 'root', '192.168.1.201']);
});

const res = (stdout: string, stderr = '', ok = true): RunResult => ({ ok, stdout, stderr });

test('classify reduces ssh failures to fixed codes', () => {
  assert.equal(classify(res(PVE1), false), null);
  assert.equal(classify(res(PVE1, '', false), false), null); // the script's last pct exec failed, the output is still good
  assert.equal(classify(res('', 'root@192.168.1.201: Permission denied (publickey,password).', false), false), 'not-installed');
  assert.equal(classify(res('', '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.', false), false), 'host-key');
  assert.equal(classify(res('', 'ssh: connect to host 192.168.1.201 port 22: No route to host', false), false), 'unreachable');
  assert.equal(classify(res('', 'ssh: connect to host 192.168.1.201 port 22: Connection refused', false), false), 'unreachable');
  assert.equal(classify(res('', '', false), true), 'timeout');
  assert.equal(classify(res('hello\n'), false), 'bad-output');
  assert.equal(classify(res('', 'sh: 1: pct: not found', false), false), 'failed');
});

test('nextDelay: a minute when fine, doubling to 10 min on failures, 5 min while the key is not installed', () => {
  assert.equal(nextDelay(0, null), INTERVAL);
  assert.equal(nextDelay(1, 'unreachable'), 60_000);
  assert.equal(nextDelay(2, 'timeout'), 120_000);
  assert.equal(nextDelay(4, 'failed'), 480_000);
  assert.equal(nextDelay(9, 'unreachable'), 600_000);
  assert.equal(nextDelay(1, 'not-installed'), 300_000);
  assert.equal(nextDelay(30, 'not-installed'), 300_000);
});

// ---- collector ----

async function keyAndConfig(extra: object = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pveports-'));
  const key = join(dir, 'portboard_ro');
  await writeFile(key, 'not a real key\n', { mode: 0o600 });
  const configPath = join(dir, 'pveports.json');
  // the reader's target spelled out: the defaults leave it off until a site names a host
  await writeFile(configPath, JSON.stringify({ host: '192.168.1.201', node: 'pve1', enabled: true, key, ...extra }));
  return { dir, key, configPath };
}

function harness(configPath: string, replies: RunResult[]) {
  let t = 1_000_000;
  const calls: { cmd: string; args: string[] }[] = [];
  const logs: string[] = [];
  const c = new PvePortsCollector({
    configPath,
    fakeCmd: null,
    now: () => t,
    log: (l) => logs.push(l),
    runner: async (cmd, args) => {
      calls.push({ cmd, args });
      return replies.shift() ?? res('', 'Permission denied', false);
    },
  });
  return { c, calls, logs, advance: (ms: number) => (t += ms), now: () => t };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test('collector: first get waits; not-installed backs off to 5 min; success caches; a later failure keeps the data until stale', async () => {
  const { configPath } = await keyAndConfig();
  const h = harness(configPath, [res('', 'root@192.168.1.201: Permission denied (publickey,password).', false)]);
  const first = await h.c.get(Infinity);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].cmd, 'ssh');
  assert.equal(first.data, null);
  assert.equal(first.status.ok, false);
  assert.equal(first.status.error, 'not-installed');
  assert.equal(first.status.setupUrl, SETUP_URL);
  assert.equal(first.status.nextAt, h.now() + 300_000);
  assert.doesNotMatch(JSON.stringify(first.status), /192\.168|root@|Permission/, 'ssh\'s own words stay out of the status');

  // not due yet: nothing runs, even when forced right after a check
  h.advance(10_000);
  h.c.refreshLater();
  h.c.refreshLater(true);
  await settle();
  assert.equal(h.calls.length, 1);
  // forced (새로고침) once 20 s have passed: the user just installed the key
  h.advance(15_000);
  h.c.refreshLater(true);
  await settle();
  assert.equal(h.calls.length, 2);

  // installed now: the next due attempt succeeds
  h.advance(300_000);
  (h as any).c['runner'] = async () => res(PVE1);
  h.c.refreshLater();
  await settle();
  const ok = h.c.current();
  assert.equal(ok.status.ok, true);
  assert.equal(ok.status.failures, 0);
  assert.equal(ok.status.lastOk, h.now());
  assert.equal(ok.status.nextAt, h.now() + INTERVAL);
  assert.equal(ok.data?.cts[204].length, 3);

  // pve1 goes away: the last good list stays (with its own time) until it is STALE_AFTER old
  (h as any).c['runner'] = async () => res('', 'ssh: connect to host 192.168.1.201 port 22: No route to host', false);
  h.advance(INTERVAL);
  h.c.refreshLater();
  await settle();
  const down = h.c.current();
  assert.equal(down.status.error, 'unreachable');
  assert.equal(down.status.failures, 1);
  assert.ok(down.data, 'still shown');
  h.advance(STALE_AFTER);
  assert.equal(h.c.current().data, null, 'dropped once stale');

  // one log line per change of state: not-installed, ok, unreachable
  assert.equal(h.logs.length, 3);
});

test('collector: a missing key or enabled=false never runs ssh', async () => {
  const { dir, configPath } = await keyAndConfig({ key: '/nonexistent/portboard_ro' });
  const h = harness(configPath, []);
  assert.equal((await h.c.get(Infinity)).status.error, 'no-key');
  assert.equal(h.calls.length, 0);

  const off = join(dir, 'off.json');
  await writeFile(off, JSON.stringify({ enabled: false }));
  const h2 = harness(off, []);
  const st = (await h2.c.get(Infinity)).status;
  assert.equal(st.enabled, false);
  assert.equal(st.error, null);
  assert.equal(h2.calls.length, 0);

  const bad = join(dir, 'bad.json');
  await writeFile(bad, '{"host": "-oProxyCommand=x"}');
  const h3 = harness(bad, []);
  assert.equal((await h3.c.get(Infinity)).status.error, 'bad-config');
  assert.equal(h3.calls.length, 0);
});

test('collector: concurrent first callers share one ssh call', async () => {
  const { configPath } = await keyAndConfig();
  const h = harness(configPath, [res(PVE1)]);
  const [a, b] = await Promise.all([h.c.get(Infinity), h.c.get(Infinity)]);
  assert.equal(h.calls.length, 1);
  assert.equal(a.status.ok && b.status.ok, true);
});

// ---- matching to devices and guests ----

const STATUS = JSON.stringify({
  Self: { HostName: 'devbox', DNSName: 'devbox.t.ts.net.', OS: 'linux', TailscaleIPs: ['100.64.10.1'] },
  Peer: {
    p: { HostName: 'pve1', DNSName: 'pve1.t.ts.net.', OS: 'linux', TailscaleIPs: ['100.64.10.8'], Online: true, PrimaryRoutes: ['192.168.1.0/24'] },
    n: { HostName: 'nas', DNSName: 'nas.t.ts.net.', OS: 'linux', TailscaleIPs: ['100.64.10.4'], Online: true },
  },
});

const guest = (vmid: number, name: string, type: 'lxc' | 'qemu', macs: string[], status = 'running') => ({
  vmid, name, type, node: 'pve1', status, template: false, cpu: 0, maxcpu: 2, mem: 1, maxmem: 2, uptime: 1, macs, ips: [], device: null, deviceMatch: null,
});

function world() {
  const list = mergeDevices(parsePeers(STATUS), [], {});
  attachLan(list.find((d) => d.id === 'pve1')!, ['192.168.1.201'], 'ssh-hostkey');
  const pve: ProxmoxStatus = matchGuests(
    {
      configured: true, ok: true,
      hosts: [{
        node: 'pve1', status: 'online', ip: '192.168.1.201', cpu: 0.1, maxcpu: 12, mem: 1, maxmem: 2, disk: 1, maxdisk: 4, uptime: 9, device: null,
        guests: [
          guest(202, 'docker-vm', 'qemu', ['BC:24:11:00:00:02']),
          guest(203, 'nas', 'lxc', ['BC:24:11:00:00:03']),
          guest(204, 'jellyfin', 'lxc', ['BC:24:11:00:00:04']),
          guest(205, 'devbox', 'qemu', ['BC:24:11:0A:0B:02']),
        ],
      }],
    },
    {
      self: { id: 'devbox', macs: ['BC:24:11:0A:0B:02'] },
      deviceIds: list.map((d) => d.id),
      neighbors: new Map([['192.168.1.204', 'bc:24:11:00:00:04']]),
      lanOwner: new Map([['192.168.1.201', 'pve1']]),
    },
  );
  return { list, pve };
}

test('attachPvePorts: host ports on pve1 (tailnet links, https for 8006), CT 203 on nas, CT 204 on jellyfin by LAN IP', () => {
  const { list, pve } = world();
  const data = parseOutput(PVE1, 7)!;
  const { proxmox, unmatched } = attachPvePorts(list, pve, data, 'pve1');
  assert.deepEqual(unmatched, []);

  const pve1 = list.find((d) => d.id === 'pve1')!;
  assert.equal(pve1.portsSource, 'pve-ssh');
  const hp = Object.fromEntries(pve1.ports!.ports.map((p) => [p.port, p]));
  assert.equal(hp[8006].url, 'https://pve1.t.ts.net:8006');
  assert.equal(hp[8006].tailnet, true);
  assert.equal(hp[22].url, null); // reachable, not a web page
  assert.equal(hp[85].scope, 'loopback');
  assert.equal(hp[39811].scope, 'tailnet');
  assert.equal(hp[39811].url, null); // tailscaled's PeerAPI
  assert.equal(hp[3128].url, null); // spiceproxy
  assert.deepEqual(hp[111].processes, ['rpcbind']);
  assert.equal(proxmox.hosts[0].ports, pve1.ports);

  const nas = list.find((d) => d.id === 'nas')!;
  assert.equal(nas.portsSource, 'pve-ssh');
  assert.equal(nas.ports!.at, 7);
  const np = Object.fromEntries(nas.ports!.ports.map((p) => [p.port, p]));
  assert.equal(np[445].tailnet, true);
  assert.equal(np[445].url, null); // SMB
  assert.equal(np[5357].scope, 'loopback');
  assert.equal(np[45213].scope, 'tailnet');

  const jf = proxmox.hosts[0].guests.find((g) => g.vmid === 204)!;
  assert.equal(jf.device, 'lan:192.168.1.204');
  const j = Object.fromEntries(jf.ports!.ports.map((p) => [p.port, p]));
  assert.equal(j[8096].tailnet, false);
  assert.equal(j[8096].lan, true);
  assert.equal(j[8096].url, 'http://192.168.1.204:8096');
  assert.equal(j[22].lan, true);
  assert.equal(j[22].url, null);

  // VMs get nothing from this script; the original tree isn't mutated
  assert.equal(proxmox.hosts[0].guests.find((g) => g.vmid === 202)!.ports, undefined);
  assert.equal(pve.hosts[0].ports, undefined);
});

test('attachPvePorts: compute-pool ports win; unknown CTs are reported; without a Proxmox tree the host still lands on pve1', () => {
  const { list, pve } = world();
  const nas = list.find((d) => d.id === 'nas')!;
  nas.ports = { at: 1, ports: [] };
  nas.portsSource = 'compute-pool';
  const data = parseOutput(`${PVE1}## ct 299\nLISTEN 0 1 0.0.0.0:80 0.0.0.0:*\n`, 7)!;
  const { proxmox, unmatched } = attachPvePorts(list, pve, data, 'pve1');
  assert.equal(nas.portsSource, 'compute-pool');
  assert.deepEqual(nas.ports, { at: 1, ports: [] });
  assert.ok(proxmox.hosts[0].guests.find((g) => g.vmid === 203)!.ports, 'the tree still has it');
  assert.deepEqual(unmatched, [299]);

  const bare = mergeDevices(parsePeers(STATUS), [], {});
  const r = attachPvePorts(bare, { configured: false, ok: false, hosts: [] }, data, 'pve1');
  assert.equal(bare.find((d) => d.id === 'pve1')!.ports!.ports.length, 7);
  assert.equal(bare.find((d) => d.id === 'nas')!.ports, null);
  assert.deepEqual(r.unmatched, [203, 204, 299]);

  // nothing read yet: untouched
  const again = world();
  assert.equal(attachPvePorts(again.list, again.pve, null, 'pve1').proxmox, again.pve);
});

const EMPTY_TOPO: Topology = {
  at: '2026-10-17T10:30:00.000Z',
  observingSince: '2026-10-17T10:00:00.000Z',
  self: { hostname: 'devbox', dnsName: 'devbox.t.ts.net', os: 'linux', tailscaleIps: ['100.64.10.1'], lanIps: ['192.168.1.205'] },
  clients: [],
  services: [],
  edges: [],
} as unknown as Topology;

const pvePortsState = (over = {}) => ({
  enabled: true, node: 'pve1', ok: true, pending: false, checkedAt: 7, lastOk: 7, error: null, failures: 0, nextAt: 60_007, setupUrl: SETUP_URL, unmatched: [], ...over,
});

function devicesDoc(): Devices {
  const { list, pve } = world();
  const { proxmox, unmatched } = attachPvePorts(list, pve, parseOutput(PVE1, 7)!, 'pve1');
  return { at: EMPTY_TOPO.at, pool: { available: false, source: null, url: '', healthAt: null }, devices: list, proxmox, pvePorts: pvePortsState({ unmatched }) };
}

test('buildUsage: jellyfin gets a LAN card named after its guest, with its ports; pve1 and nas keep theirs', () => {
  const u = buildUsage({
    topology: EMPTY_TOPO,
    devices: devicesDoc(),
    neighbors: new Map([['192.168.1.204', { mac: 'bc:24:11:00:00:04', state: 'REACHABLE', dev: 'ens18' }]]),
    oui: new Map([['BC2411', 'Proxmox Server Solutions GmbH']]),
    names: {},
  });
  const jf = u.cards.find((c) => c.id === 'lan:192.168.1.204')!;
  assert.equal(jf.kind, 'lan');
  assert.deepEqual([jf.name, jf.nameSource], ['jellyfin', 'proxmox']);
  assert.equal(jf.portsSource, 'pve-ssh');
  assert.equal(jf.ports?.ports.find((p) => p.port === 8096)?.url, 'http://192.168.1.204:8096');
  assert.deepEqual(jf.guestOf, { node: 'pve1', hostDevice: 'pve1', vmid: 204, type: 'lxc', status: 'running', match: 'mac' });
  assert.equal(u.cards.find((c) => c.id === 'pve1')?.portsSource, 'pve-ssh');
  assert.equal(u.cards.find((c) => c.id === 'nas')?.ports?.ports.length, 5);
  assert.equal(u.pvePorts?.ok, true);
  // a user name still wins
  const named = buildUsage({ topology: EMPTY_TOPO, devices: devicesDoc(), neighbors: new Map([['192.168.1.204', { mac: 'bc:24:11:00:00:04', state: 'REACHABLE', dev: 'ens18' }]]), oui: new Map(), names: { 'mac:bc:24:11:00:00:04': '영화 서버' } });
  assert.equal(named.cards.find((c) => c.id === 'lan:192.168.1.204')?.name, '영화 서버');
});

// ---- remote redaction ----

test('remote list_devices: Proxmox ports keep port and reach; no LAN URL, address, key path, user or ssh text', () => {
  const doc = devicesDoc();
  doc.pvePorts = pvePortsState({ ok: false, error: 'not-installed', unmatched: [299] }) as Devices['pvePorts'];
  const out = redactDevices(doc) as any;
  const s = JSON.stringify(out);
  assert.doesNotMatch(s, /192\.168|100\.\d+\.\d+\.\d+|fd7a:|root@|portboard_ro|pid=|"processes"|"addresses"|Permission/);
  const jf = out.proxmox.hosts[0].guests.find((g: any) => g.vmid === 204);
  assert.deepEqual(jf.ports.ports.find((p: any) => p.port === 8096), { port: 8096, scope: 'all', tailnet: false, lan: true, url: null });
  const pve1 = out.devices.find((d: any) => d.name === 'pve1');
  assert.equal(pve1.portsSource, 'pve-ssh');
  assert.equal(pve1.ports.ports.find((p: any) => p.port === 8006).url, 'https://pve1.t.ts.net:8006');
  assert.deepEqual(out.pvePorts, { enabled: true, node: 'pve1', ok: false, pending: false, error: 'not-installed', checkedAt: 7, lastOk: 7, unmatched: [299] });

  const loose = redactDevices(doc, { showAddresses: true, showProcesses: true }) as any;
  const jl = loose.proxmox.hosts[0].guests.find((g: any) => g.vmid === 204).ports.ports.find((p: any) => p.port === 8096);
  assert.equal(jl.url, 'http://192.168.1.204:8096');
  assert.deepEqual(jl.processes, ['jellyfin']);
});

test('live output from pve1 (2026-10-17, pids blanked): every section parses, worker names fold into their parent', () => {
  const live = readFileSync(new URL('./fixtures/pveports-live-2026-10-17.txt', import.meta.url), 'utf8');
  const r = parseOutput(live, 1)!;
  assert.deepEqual(Object.keys(r.cts), ['203', '204']);
  const procs = (l: { process?: string }[]) => [...new Set(l.map((x) => x.process))].sort();
  assert.deepEqual(procs(r.host), ['master', 'pvedaemon', 'pveproxy', 'rpcbind', 'spiceproxy', 'sshd', 'tailscaled']);
  assert.ok(procs(r.cts[203]).includes('smbd') && !procs(r.cts[203]).includes('smbd-scavenger'));
  assert.ok(r.cts[204].some((l) => l.address === '127.0.0.53' && l.port === 53), '127.0.0.53%lo');
  const { list, pve } = world();
  attachPvePorts(list, pve, r, 'pve1');
  const nas = list.find((d) => d.id === 'nas')!.ports!.ports;
  assert.equal(nas.find((p) => p.port === 22000)?.url, null); // Syncthing's sync protocol, not a page
  assert.equal(nas.find((p) => p.port === 8384)?.scope, 'loopback'); // its GUI only inside the CT
});
