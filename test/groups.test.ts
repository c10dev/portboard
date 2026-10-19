import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseComposeProjects, parseDockerPs } from '../src/core/docker.ts';
import { assignGroups, commonPrefix, groupKey, type Groupable } from '../src/core/groups.ts';
import { wellKnown, type PortEntry, type Snapshot } from '../src/core/index.ts';
import { emptyHistory, historyView, record, withHistory } from '../src/core/history.ts';
import { peerApiPorts } from '../src/core/tailscale.ts';
import type { Usage } from '../src/core/usage.ts';
import { callTool, type Core } from '../src/mcp/tools.ts';
import { usageReport } from '../src/features/usage.ts';
import { summarize } from '../src/mcp/views.ts';

function g(over: Partial<Groupable> & { port: number }): Groupable {
  return { listening: true, owned: true, container: null, processes: [], detectedName: `svc ${over.port}`, probe: null, ...over };
}

const unit = (u: string, pid: number, desc: string | null = null) => [{ pid, unit: u, unitDescription: desc }];

// What devbox looked like on 2026-10-17
const LIVE = () => [
  g({ port: 22, owned: false, systemOwner: 'sshd', detectedName: 'SSH (sshd)' }),
  g({ port: 443, owned: false, systemOwner: 'tailscaled', detectedName: 'tailscale serve HTTPS (tailscaled)' }),
  g({ port: 3000, processes: [{ pid: 2408824, unit: null }], detectedName: 'webapp' }), // cwd project webapp, not docker
  g({ port: 7720, processes: unit('compute-pool-monitor.service', 3480132, 'compute-pool monitor (host health, alerts, dashboard on 127.0.0.1:7720)'), probe: { http: true, title: 'compute-pool' } }),
  g({ port: 7721, processes: unit('compute-pool-monitor.service', 3480132, 'compute-pool monitor (host health, alerts, dashboard on 127.0.0.1:7720)') }),
  g({ port: 8080, processes: unit('supabase-mcp-tunnel.service', 1763) }),
  g({ port: 8384, processes: unit('syncthing.service', 1919, 'Syncthing - Open Source Continuous File Synchronization'), probe: { http: true, title: 'Syncthing - Open Source Continuous File Synchronization' } }),
  g({ port: 22000, processes: unit('syncthing.service', 1919, 'Syncthing - Open Source Continuous File Synchronization') }),
  g({ port: 33819, owned: false, systemOwner: 'tailscaled', detectedName: 'Tailscale PeerAPI (tailscaled)' }),
  g({ port: 46389, processes: [{ pid: 3005236, unit: null }], detectedName: 'MainThread' }),
  g({ port: 46390, processes: [{ pid: 3005236, unit: null }], detectedName: 'MainThread' }),
  g({ port: 54321, owned: false, container: 'supabase_kong_webapp', composeProject: 'webapp' }),
  g({ port: 54322, owned: false, container: 'supabase_db_webapp', composeProject: 'webapp' }),
  g({ port: 9000, listening: false, processes: unit('syncthing.service', 1919) }),
];

test('assignGroups: same unit, compose project, process or tailscaled; lone ports stay alone', () => {
  const ports = assignGroups(LIVE());
  const by = (p: number) => ports.find((x) => x.port === p)!;
  assert.deepEqual(by(7720).group, { key: 'unit:compute-pool-monitor.service', name: 'compute-pool monitor', ports: [7720, 7721] });
  assert.equal(by(7720).role, 'compute-pool');
  assert.equal(by(7721).role, 'TCP');
  assert.deepEqual(by(8384).group?.ports, [8384, 22000]);
  assert.equal(by(8384).group?.name, 'Syncthing');
  assert.equal(by(8384).role, '웹 (HTTP)'); // title equals the group name, so it says what kind of port it is
  assert.equal(by(54321).group?.name, 'supabase (webapp)');
  assert.deepEqual([by(54321).role, by(54322).role], ['kong', 'db']);
  // The next.js dev server's folder is also called webapp; it must not join the compose group
  assert.equal(by(3000).group, null);
  assert.deepEqual(by(46389).group?.ports, [46389, 46390]);
  assert.equal(by(46389).group?.key, 'pid:3005236');
  assert.deepEqual(by(443).group, { key: 'sys:tailscaled', name: 'tailscaled', ports: [443, 33819] });
  assert.equal(by(33819).role, 'Tailscale PeerAPI');
  for (const p of [22, 8080]) assert.equal(by(p).group, null);
  assert.equal(by(9000).group, null); // a serve entry with nothing listening
});

test('groupKey namespaces and commonPrefix', () => {
  assert.equal(groupKey(g({ port: 1, container: 'redis' })), 'container:redis');
  assert.equal(groupKey(g({ port: 1, owned: false })), null);
  assert.equal(commonPrefix(['supabase_kong', 'supabase_db']), 'supabase');
  assert.equal(commonPrefix(['web', 'worker']), '');
  assert.equal(commonPrefix(['app', 'app_worker']), ''); // a prefix must leave something of every name
});

test('docker ps third column gives the compose project; the port map ignores it', () => {
  const text = [
    'supabase_db_webapp\t0.0.0.0:54322->5432/tcp, [::]:54322->5432/tcp\twebapp',
    'supabase_rest_webapp\t3000/tcp\twebapp',
    'loose\t0.0.0.0:8081->80/tcp\t',
  ].join('\n');
  assert.deepEqual([...parseComposeProjects(text)], [
    ['supabase_db_webapp', 'webapp'],
    ['supabase_rest_webapp', 'webapp'],
  ]);
  assert.deepEqual([...parseDockerPs(text)], [[54322, 'supabase_db_webapp'], [8081, 'loose']]);
});

test('wellKnown names root-owned ports; tailscaled listeners come from tailscale itself', () => {
  const ts = { peerApiPorts: peerApiPorts(['http://100.64.10.1:33819', 'http://[fd7a:115c:a1e0::10:1]:63055']) };
  assert.deepEqual(ts.peerApiPorts, [33819, 63055]);
  const serve = [{ httpsPort: 443, upstream: 'http://127.0.0.1:8790', upstreamPort: 8790 }];
  assert.deepEqual(wellKnown(22, 'all', ts, serve), { name: 'SSH (sshd)', owner: 'sshd' });
  assert.equal(wellKnown(53, 'loopback', ts, serve)?.owner, 'systemd-resolved');
  assert.equal(wellKnown(631, 'all', ts, serve)?.name, 'CUPS 프린터 (cupsd)');
  assert.equal(wellKnown(443, 'tailnet', ts, serve)?.name, 'tailscale serve HTTPS (tailscaled)');
  assert.equal(wellKnown(63055, 'tailnet', ts, serve)?.name, 'Tailscale PeerAPI (tailscaled)');
  assert.equal(wellKnown(33809, 'loopback', ts, serve), null); // unverified owner: stays unknown
  assert.equal(wellKnown(33819, 'loopback', ts, serve), null); // PeerAPI listens on the Tailscale IPs only
  assert.deepEqual(peerApiPorts(undefined), []);
});

// ---- MCP ----

function entry(over: Partial<PortEntry> & { port: number }): PortEntry {
  return {
    listening: true, scope: 'loopback', addresses: ['127.0.0.1'], owned: true, kind: 'app', container: null,
    composeProject: null, processes: [], systemOwner: null, group: null, role: null, name: 'x', detectedName: 'x',
    label: null, pinned: false, hidden: false, visible: true, probe: null, served: null,
    urls: { direct: null, served: null, ssh: '' }, canExpose: false, exposeBlocker: null, control: null,
    canRestart: false, canStop: false, ...over,
  } as PortEntry;
}

const T = Date.parse('2026-10-17T10:00:00Z');
const NOW = T + 3 * 3600_000;

function fixture() {
  const h = emptyHistory();
  const lan = { device: 'lan:192.168.1.7', name: 'MSI 기기', kind: 'lan', nameKey: 'mac:04:7c:16:0a:0b:03', port: 8384, service: 'Syncthing', connections: 1 };
  const macSsh = { device: 'dev-mac', name: 'dev-mac', kind: 'tailnet', nameKey: null, port: 22, service: 'SSH', connections: 2 };
  for (let t = T; t <= T + 600_000; t += 30_000) record(h, [lan, macSsh], t);
  record(h, [macSsh], NOW);
  const syncGroup = { key: 'unit:syncthing.service', name: 'Syncthing', ports: [8384, 22000] };
  const u: Usage = {
    at: new Date(NOW).toISOString(), observingSince: new Date(NOW - 60_000).toISOString(),
    cards: [{
      id: 'dev-mac', name: 'dev-mac', nameSource: 'tailscale', kind: 'tailnet', os: 'macOS', vendor: null,
      mac: null, randomMac: false, networks: ['tailnet'], addresses: [], tailscaleIps: [], lanIps: [], online: true,
      lastSeen: null, path: null, pool: null, poolMatch: null, nameKey: null, lanVia: {}, routes: [], virt: null,
      guestOf: null, pveHost: null, connections: 2, bytes: 0,
      uses: [{ port: 22, service: 'SSH', fullName: 'SSH (sshd)', kind: 'system', url: null, via: 'direct', servePort: null, connections: 2, bytesSent: 0, bytesReceived: 0, rttMs: null, since: new Date(NOW - 60_000).toISOString(), processes: [], routed: false }],
    }],
    local: { connections: 0, uses: [] },
    byPort: { 22: [{ id: 'dev-mac', name: 'dev-mac', kind: 'tailnet', connections: 2 }] },
    idleServices: 2,
    idle: [{ port: 8384, service: 'Syncthing', group: syncGroup }, { port: 22000, service: 'Syncthing', group: syncGroup }],
    pool: { available: false, source: null, url: '', healthAt: null } as Usage['pool'],
    selfLanIps: [], proxmox: { configured: false, ok: false, hosts: 0 },
  };
  const usage = withHistory(u, h, NOW);
  const snap: Snapshot = {
    at: u.at, host: { hostname: 'box', user: 'me' }, tailscale: { available: true, dnsName: 'box.ts.net', hostName: 'box', ips: [] },
    ports: [
      entry({ port: 8384, name: 'Syncthing', group: syncGroup, role: '웹 (HTTP)' }),
      entry({ port: 22000, name: 'Syncthing', group: syncGroup, role: 'TCP' }),
      entry({ port: 3000, name: 'next' }),
    ],
  };
  const calls: string[] = [];
  const core = {
    snapshot: async () => snap,
    usage: async () => usage,
    history: async () => historyView(h, NOW),
    setClientName: async (key: string, name: string | null) => calls.push(`${key}=${name}`),
  } as unknown as Core;
  return { usage, snap, core, calls, h };
}

const payload = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

test('who_uses / list_usage: now plus last-used history, filtered by port', async () => {
  const { core, usage } = fixture();
  const all = usageReport(usage);
  assert.deepEqual(all.ports.map((p) => p.port), [22, 8384]);
  const ssh = all.ports[0];
  assert.deepEqual(ssh.now, [{ device: 'dev-mac', id: 'dev-mac', kind: 'tailnet', connections: 2 }]);
  assert.equal(ssh.lastUsed?.by, 'dev-mac');
  const sync = all.ports[1];
  assert.equal(sync.group, 'Syncthing');
  assert.deepEqual(sync.now, []);
  assert.equal(sync.lastUsed?.by, 'MSI 기기');
  assert.equal(sync.recent7d[0].minutes, 10.5);
  // The LAN machine isn't connected now, but the history still gives its key for name_device
  const msi = all.devices.find((d) => d.id === 'lan:192.168.1.7')!;
  assert.equal(msi.nameKey, 'mac:04:7c:16:0a:0b:03');
  assert.deepEqual(msi.usingNow, []);

  const one = payload(await callTool('who_uses', { port: 8384 }, core));
  assert.deepEqual(one.ports.map((p: any) => p.port), [8384]);
  assert.deepEqual(one.devices.map((d: any) => d.id), ['lan:192.168.1.7']);
  assert.deepEqual(payload(await callTool('list_usage', {}, core)).ports.length, 2);
  assert.equal((await callTool('who_uses', { port: 70000 }, core)).isError, true);
});

test('name_device writes the clients store by nameKey or device id; Tailscale devices are refused', async () => {
  const { core, calls } = fixture();
  assert.deepEqual(payload(await callTool('name_device', { key: 'lan:192.168.1.7', name: ' 데스크톱 ' }, core)), {
    ok: true, key: 'mac:04:7c:16:0a:0b:03', device: 'lan:192.168.1.7', name: '데스크톱',
  });
  await callTool('name_device', { key: 'ip:192.168.1.50', name: '' }, core);
  assert.deepEqual(calls, ['mac:04:7c:16:0a:0b:03=데스크톱', 'ip:192.168.1.50=null']);
  const ts = await callTool('name_device', { key: 'dev-mac', name: 'x' }, core);
  assert.equal(ts.isError, true);
  assert.match(ts.content[0].text, /Tailscale/);
  assert.equal((await callTool('name_device', { key: 'mac:zz', name: 'x' }, core)).isError, true);
  assert.equal((await callTool('name_device', { key: 'lan:192.168.1.7', name: 'x'.repeat(41) }, core)).isError, true);
  assert.equal((await callTool('name_device', { key: 'nope', name: 'x' }, core)).isError, true);
  assert.equal(calls.length, 2);
});

test('list_ports carries group and lastUsed', async () => {
  const { core, snap, h } = fixture();
  const out = payload(await callTool('list_ports', {}, core));
  const sync = out.ports.find((p: any) => p.port === 8384);
  assert.deepEqual(sync.group, { name: 'Syncthing', ports: [8384, 22000], role: '웹 (HTTP)' });
  assert.equal(sync.lastUsed.by, 'MSI 기기');
  const next = out.ports.find((p: any) => p.port === 3000);
  assert.equal(next.group, undefined);
  assert.equal(next.lastUsed, undefined);
  // without history it still works
  assert.equal(summarize(snap, {}).ports.length, 3);
  assert.ok(h.startedAt);
});
