import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkName, isRandomMac, loadNames, nameKey, parseNeigh, parseOui, resolveName, setName, shortVendor, vendorOf,
} from '../src/core/clients.ts';
import { mergeDevices, parsePeers } from '../src/core/devices.ts';
import type { PoolHost } from '../src/core/pool.ts';
import type { Topology } from '../src/core/topology.ts';
import { buildUsage, displayName } from '../src/core/usage.ts';

const NEIGH = [
  '192.168.1.7 dev ens18 lladdr 04:7c:16:0a:0b:03 REACHABLE ',
  '192.168.1.201 dev ens18 lladdr 50:81:40:0a:0b:01 STALE',
  '192.168.1.108 dev ens18 FAILED ',
  '192.168.1.50 dev ens18 lladdr 3a:11:22:33:44:55 REACHABLE',
  'fe80::be24:11ff:fec8:3a44 dev ens18 lladdr BC:24:11:0A:0B:04 STALE ',
  '',
].join('\n');

const OUI = [
  'OUI/MA-L                                                    Organization',
  '',
  '50-81-40   (hex)\t\tHP Inc.',
  '508140     (base 16)\t\tHP Inc.',
  '\t\t\t\t1501 Page Mill Road',
  '',
  '04-7C-16   (hex)\t\tMicro-Star INTL CO., LTD.',
  'BC-24-11   (hex)\t\tProxmox Server Solutions GmbH',
  '00-11-22   (hex)\t\tCIMSYS Inc',
].join('\n');

test('parseNeigh keeps entries with a MAC, lower-cased; FAILED ones have none', () => {
  const n = parseNeigh(NEIGH);
  assert.deepEqual(n.get('192.168.1.7'), { mac: '04:7c:16:0a:0b:03', state: 'REACHABLE', dev: 'ens18' });
  assert.equal(n.get('192.168.1.201')?.state, 'STALE');
  assert.equal(n.has('192.168.1.108'), false);
  assert.equal(n.get('fe80::be24:11ff:fec8:3a44')?.mac, 'bc:24:11:0a:0b:04');
});

test('parseOui reads only the (hex) lines; vendorOf skips random MACs', () => {
  const oui = parseOui(OUI);
  assert.equal(oui.size, 4);
  assert.equal(oui.get('508140'), 'HP Inc.');
  assert.equal(vendorOf('04:7c:16:0a:0b:03', oui), 'Micro-Star INTL CO., LTD.');
  assert.equal(isRandomMac('3a:11:22:33:44:55'), true);
  assert.equal(isRandomMac('50:81:40:0a:0b:01'), false);
  assert.equal(vendorOf('3a:11:22:33:44:55', new Map([['3A1122', 'Somebody']])), null);
  assert.equal(vendorOf('aa:bb:cc:00:00:00', oui), null);
});

test('shortVendor', () => {
  assert.equal(shortVendor('HP Inc.'), 'HP');
  assert.equal(shortVendor('Micro-Star INTL CO., LTD.'), 'MSI');
  assert.equal(shortVendor('Proxmox Server Solutions GmbH'), 'Proxmox VM');
  assert.equal(shortVendor('Foo Technologies Co., Ltd.'), 'Foo');
  assert.equal(shortVendor('CIMSYS Inc'), 'CIMSYS');
});

test('resolveName: user > Tailscale > compute-pool > vendor > IP', () => {
  const all = { user: '회사 노트북', tailscale: 'desktop-pc', pool: 'desktop', vendor: 'HP Inc.', ip: '192.168.1.201' };
  assert.deepEqual(resolveName(all), { name: '회사 노트북', source: 'user' });
  assert.deepEqual(resolveName({ ...all, user: null }), { name: 'desktop-pc', source: 'tailscale' });
  assert.deepEqual(resolveName({ ...all, user: '', tailscale: null }), { name: 'desktop', source: 'pool' });
  assert.deepEqual(resolveName({ ip: all.ip, vendor: all.vendor }), { name: 'HP 기기', source: 'vendor' });
  assert.deepEqual(resolveName({ ip: '192.168.1.203', vendor: 'Proxmox Server Solutions GmbH' }), { name: 'Proxmox VM', source: 'vendor' });
  assert.deepEqual(resolveName({ ip: '192.168.1.50', randomMac: true }), { name: '개인 Wi-Fi 주소 기기', source: 'ip' });
  assert.deepEqual(resolveName({ ip: '192.168.1.9' }), { name: '192.168.1.9', source: 'ip' });
});

test('nameKey prefers a real MAC, else the IP', () => {
  assert.equal(nameKey('192.168.1.201', '50:81:40:0A:0B:01'), 'mac:50:81:40:0a:0b:01');
  assert.equal(nameKey('192.168.1.50', '3a:11:22:33:44:55'), 'ip:192.168.1.50');
  assert.equal(nameKey('192.168.1.9', null), 'ip:192.168.1.9');
});

test('checkName validates the POST body', () => {
  assert.equal(checkName({ key: 'mac:50:81:40:0a:0b:01', name: 'HP 노트북' }), null);
  assert.equal(checkName({ key: 'ip:192.168.1.9', name: null }), null);
  assert.match(checkName({ key: 'mac:zz', name: 'x' }) ?? '', /key/);
  assert.match(checkName({ key: 'ip:1.2.3.4', name: 'x'.repeat(41) }) ?? '', /40/);
  assert.match(checkName({ key: 'ip:1.2.3.4', name: 'x', extra: 1 }) ?? '', /unknown field/);
  assert.match(checkName({ key: 'ip:1.2.3.4', name: 5 }) ?? '', /string/);
});

test('setName writes atomically; empty clears', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'portboard-')), 'sub', 'clients.json');
  await Promise.all([setName('mac:50:81:40:0a:0b:01', ' HP 노트북 ', path), setName('ip:192.168.1.9', 'NAS', path)]);
  assert.deepEqual(await loadNames(path), { 'mac:50:81:40:0a:0b:01': 'HP 노트북', 'ip:192.168.1.9': 'NAS' });
  await setName('ip:192.168.1.9', '', path);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).names, { 'mac:50:81:40:0a:0b:01': 'HP 노트북' });
});

test('displayName drops the tagline and the parenthetical', () => {
  assert.equal(displayName('compute-pool monitor (host health, alerts, dashboard on 127.0.0.1:7720)'), 'compute-pool monitor');
  assert.equal(displayName('Portboard — listening ports dashboard on :8790 (loopback + tailnet)'), 'Portboard');
  assert.equal(displayName('Syncthing - Open Source Continuous File Synchronization'), 'Syncthing');
  assert.equal(displayName('docker: supabase_kong_webapp'), 'docker: supabase_kong_webapp');
});

// ---- buildUsage ----

const STATUS = JSON.stringify({
  Self: { HostName: 'devbox', DNSName: 'devbox.t.ts.net.', OS: 'linux', TailscaleIPs: ['100.64.10.1'] },
  Peer: {
    a: { HostName: 'Mac', DNSName: 'dev-mac.t.ts.net.', OS: 'macOS', TailscaleIPs: ['100.64.10.3'], Online: true, CurAddr: '1.2.3.4:5' },
    b: { HostName: 'DESKTOP-PC', DNSName: 'desktop-pc.t.ts.net.', OS: 'windows', TailscaleIPs: ['100.64.10.2'], Online: true },
    c: { HostName: 'localhost', DNSName: 'iphone.t.ts.net.', OS: 'iOS', TailscaleIPs: ['100.64.10.7'], Online: true },
  },
});

const POOL: PoolHost[] = [
  { name: 'devbox', kind: 'local', addresses: [], state: 'ok', inRotation: true, slots: 2, busy: 0 },
  { name: 'desktop', kind: 'ssh', addresses: ['192.168.1.7'], state: 'ok', inRotation: true, slots: 3, busy: 0 },
];

function edge(from: string, port: number, connections = 1, extra = {}) {
  return {
    id: `${from}>${port}`, from, port, via: 'direct' as const, servePort: null, connections,
    bytesSent: 100 * connections, bytesReceived: 10 * connections, rttMs: 5, processes: [], peers: [], since: '2026-10-17T10:00:00.000Z', ...extra,
  };
}

const svc = (port: number, name: string, extra = {}) => ({
  port, name, labeled: false, scope: 'all' as const, kind: 'app' as const, visible: true, owner: null, project: null, url: null, proxyConnections: 0, ...extra,
});

const TOPO: Topology = {
  at: '2026-10-17T10:30:00.000Z',
  observingSince: '2026-10-17T10:00:00.000Z',
  self: { hostname: 'devbox', dnsName: 'devbox.t.ts.net', os: 'linux', tailscaleIps: ['100.64.10.1'], lanIps: ['192.168.1.205'] },
  clients: [
    { id: 'dev:dev-mac', kind: 'device', label: 'dev-mac', address: '100.64.10.3' },
    { id: 'lan:192.168.1.201', kind: 'lan', label: 'LAN 192.168.1.201', address: '192.168.1.201' },
    { id: 'lan:192.168.1.7', kind: 'lan', label: 'LAN 192.168.1.7', address: '192.168.1.7' },
    { id: 'local', kind: 'local', label: '이 서버 (로컬)', address: null },
  ],
  services: [
    svc(22, 'SSH (sshd)', { kind: 'system', visible: false }),
    svc(7721, 'compute-pool monitor (host health)'),
    svc(8790, 'Portboard — dashboard', { url: 'https://devbox.t.ts.net/' }),
    svc(3000, 'my app', { labeled: true }),
    svc(5281, 'ShopSim'),
  ],
  edges: [
    edge('dev:dev-mac', 22, 2),
    edge('dev:dev-mac', 7721),
    edge('dev:dev-mac', 8790, 1, { via: 'serve', servePort: 443 }),
    edge('lan:192.168.1.201', 22, 6),
    edge('lan:192.168.1.7', 22),
    edge('local', 3000, 1, { processes: ['curl (9)'] }),
  ],
  outboundConnections: 0,
};

function build(names: Record<string, string> = {}) {
  return buildUsage({
    topology: TOPO,
    devices: { at: TOPO.at, pool: { available: true, source: 'hosts', url: '', healthAt: null }, devices: mergeDevices(parsePeers(STATUS), POOL, { desktop: 'desktop-pc' }) },
    neighbors: parseNeigh(NEIGH),
    oui: parseOui(OUI),
    names,
  });
}

test('buildUsage: one card per device, LAN address merged into the device compute-pool reaches there', () => {
  const u = build();
  const ids = u.cards.map((c) => c.id);
  assert.deepEqual(ids.slice(0, 3), ['lan:192.168.1.201', 'dev-mac', 'desktop-pc']);
  assert.equal(ids[3], 'devbox'); // this server after the active devices
  assert.deepEqual(ids.slice(4), ['iphone']);

  const hp = u.cards[0];
  assert.deepEqual([hp.name, hp.nameSource, hp.kind, hp.nameKey], ['HP 기기', 'vendor', 'lan', 'mac:50:81:40:0a:0b:01']);
  assert.equal(hp.connections, 6);

  const win = u.cards.find((c) => c.id === 'desktop-pc')!;
  assert.deepEqual(win.networks, ['lan']);
  assert.equal(win.pool?.name, 'desktop');
  assert.equal(win.vendor, 'Micro-Star INTL CO., LTD.');
  assert.equal(win.nameSource, 'tailscale');

  const mac = u.cards.find((c) => c.id === 'dev-mac')!;
  assert.deepEqual(mac.uses.map((r) => [r.port, r.service, r.via, r.connections]), [
    [22, 'SSH', 'direct', 2],
    [7721, 'compute-pool monitor', 'direct', 1],
    [8790, 'Portboard', 'serve', 1],
  ]);
  assert.equal(mac.bytes, 4 * 110);

  // user labels are shown as given; this server's own connections are kept apart
  assert.deepEqual(u.local.uses.map((r) => [r.port, r.service, r.processes]), [[3000, 'my app', ['curl (9)']]]);
  assert.equal(u.idleServices, 1); // ShopSim (sshd is not a visible service)
});

test('buildUsage: byPort lists devices first, most connections first, this server last', () => {
  const u = build();
  assert.deepEqual(u.byPort[22].map((x) => [x.name, x.connections]), [['HP 기기', 6], ['dev-mac', 2], ['desktop-pc', 1]]);
  assert.deepEqual(u.byPort[3000], [{ id: 'local', name: '이 서버', kind: 'local', connections: 1 }]);
  assert.equal(u.byPort[5281], undefined);
});

test('buildUsage: a user name wins over the vendor and over the Tailscale name of a merged LAN address', () => {
  const u = build({ 'mac:50:81:40:0a:0b:01': '회사 노트북', 'mac:04:7c:16:0a:0b:03': '거실 PC' });
  assert.deepEqual([u.cards[0].name, u.cards[0].nameSource], ['회사 노트북', 'user']);
  assert.equal(u.byPort[22][0].name, '회사 노트북');
  assert.equal(u.cards.find((c) => c.id === 'desktop-pc')?.name, '거실 PC');
});

// ---- subnet router + Proxmox ----

test('inCidr', async () => {
  const { inCidr } = await import('../src/core/usage.ts');
  assert.equal(inCidr('192.168.1.205', '192.168.1.0/24'), true);
  assert.equal(inCidr('192.168.2.5', '192.168.1.0/24'), false);
  assert.equal(inCidr('10.1.2.3', '0.0.0.0/0'), true);
  assert.equal(inCidr('fd7a::1', '192.168.1.0/24'), false);
});

test('buildUsage: connections from a subnet router\'s LAN address are its forwarding, not its own use', async () => {
  const { attachLan } = await import('../src/core/devices.ts');
  const { matchGuests } = await import('../src/core/proxmox.ts');
  const status = JSON.stringify({
    Self: { HostName: 'devbox', DNSName: 'devbox.t.ts.net.', OS: 'linux', TailscaleIPs: ['100.64.10.1'] },
    Peer: {
      p: { HostName: 'pve1', DNSName: 'pve1.t.ts.net.', OS: 'linux', TailscaleIPs: ['100.64.10.8'], Online: true, PrimaryRoutes: ['192.168.1.0/24'] },
      n: { HostName: 'nas', DNSName: 'nas.t.ts.net.', OS: 'linux', TailscaleIPs: ['100.64.10.4'], Online: true },
    },
  });
  const list = mergeDevices(parsePeers(status), [], {});
  attachLan(list.find((d) => d.id === 'pve1')!, ['192.168.1.201'], 'ssh-hostkey');
  const pve = matchGuests(
    {
      configured: true, ok: true,
      hosts: [{
        node: 'pve1', status: 'online', ip: '192.168.1.201', cpu: 0.1, maxcpu: 12, mem: 1, maxmem: 2, disk: 1, maxdisk: 4, uptime: 9, device: null,
        guests: [
          { vmid: 203, name: 'nas', type: 'lxc', node: 'pve1', status: 'running', template: false, cpu: 0, maxcpu: 2, mem: 1, maxmem: 2, uptime: 1, macs: [], ips: [], device: null, deviceMatch: null },
          { vmid: 205, name: 'devbox', type: 'qemu', node: 'pve1', status: 'running', template: false, cpu: 0, maxcpu: 2, mem: 1, maxmem: 2, uptime: 1, macs: ['BC:24:11:0A:0B:02'], ips: [], device: null, deviceMatch: null },
        ],
      }],
    },
    { self: { id: 'devbox', macs: ['BC:24:11:0A:0B:02'] }, deviceIds: list.map((d) => d.id), neighbors: new Map(), lanOwner: new Map([['192.168.1.201', 'pve1']]) },
  );
  const topo: Topology = {
    ...TOPO,
    clients: [
      { id: 'lan:192.168.1.201', kind: 'lan', label: 'LAN 192.168.1.201', address: '192.168.1.201' },
      { id: 'dev:nas', kind: 'device', label: 'nas', address: '100.64.10.4' },
    ],
    edges: [edge('lan:192.168.1.201', 22, 6), edge('dev:nas', 22)],
  };
  const u = buildUsage({
    topology: topo,
    devices: { at: TOPO.at, pool: { available: false, source: null, url: '', healthAt: null }, devices: list, proxmox: pve },
    neighbors: parseNeigh(NEIGH),
    oui: parseOui(OUI),
    names: {},
  });
  const router = u.cards.find((c) => c.id === 'pve1')!;
  assert.deepEqual(router.uses.map((r) => [r.port, r.connections, r.routed]), [[22, 6, true]]);
  assert.equal(router.nameSource, 'tailscale'); // not "HP 기기": the LAN card is gone
  assert.equal(u.cards.some((c) => c.id === 'lan:192.168.1.201'), false);
  assert.deepEqual(u.byPort[22].map((x) => [x.id, x.name, x.kind, x.connections]), [
    ['pve1~routed', 'pve1 경유', 'routed', 6],
    ['nas', 'nas', 'tailnet', 1],
  ]);
  // Proxmox: host card carries the tree, guests point back at it
  assert.deepEqual(router.pveHost?.guests.map((x) => [x.vmid, x.device]), [[203, 'nas'], [205, 'devbox']]);
  assert.deepEqual(u.cards.find((c) => c.id === 'nas')?.guestOf, { node: 'pve1', hostDevice: 'pve1', vmid: 203, type: 'lxc', status: 'running', match: 'name' });
  assert.equal(u.cards.find((c) => c.id === 'devbox')?.guestOf?.match, 'mac');
  assert.deepEqual(u.proxmox, { configured: true, ok: true, hosts: 1 });
});
