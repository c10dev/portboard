// The network tree (src/core/nettree.ts): routers and Proxmox hosts, guests, routed LANs and the rest. Neutral names
// and the 10.0.0.0/8 range only; the real network is checked against production by hand (docs/devices-tab/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDevices, parsePeers, type Device } from '../src/core/devices.ts';
import { buildNetTree, inCidr, walk, type LanHost, type NetNode, type NetTree } from '../src/core/nettree.ts';
import type { Guest, ProxmoxStatus, PveHost } from '../src/core/proxmox.ts';
import { redactDevices } from '../src/remote/redact.ts';

const dev = (id: string, over: Partial<Device> = {}): Device => ({
  id, name: id, dnsName: `${id}.example.ts.net`, os: 'linux', self: false, online: true, lastSeen: null,
  tailscaleIps: ['100.64.0.1'], path: null, lanIps: [], lanVia: {}, routes: [], standbyRoutes: [],
  pool: null, poolMatch: null, ports: null, portsSource: null, ...over,
});

const guest = (vmid: number, name: string, over: Partial<Guest> = {}): Guest => ({
  vmid, name, type: 'lxc', node: 'hv1', status: 'running', template: false, cpu: null, maxcpu: null, mem: null, maxmem: null,
  uptime: null, macs: [], ips: [], lanIp: null, device: null, deviceMatch: null, ...over,
});

const pveHost = (node: string, guests: Guest[], over: Partial<PveHost> = {}): PveHost => ({
  node, status: 'online', ip: null, cpu: null, maxcpu: null, mem: null, maxmem: null, disk: null, maxdisk: null, uptime: null,
  device: node, guests, ...over,
});

const pve = (hosts: PveHost[]): ProxmoxStatus => ({ configured: true, ok: true, hosts });
const lan = (ip: string, seen: LanHost['seen'], name = ip): LanHost => ({ ip, mac: null, name, seen });
const ports = (n: number) => ({ at: 0, ports: Array.from({ length: n }, (_, i) => ({ port: 1000 + i })) }) as unknown as Device['ports'];

/** "name" per node, indented by depth: the shape at a glance */
const shape = (t: NetTree) => [...walk(t.roots)].map(({ node, depth }) => `${'  '.repeat(depth)}${node.name}`);
const find = (t: NetTree, key: string) => [...walk(t.roots)].find(({ node }) => node.key === key)?.node as NetNode;
const deviceIds = (t: NetTree) => [...walk(t.roots)].map(({ node }) => node.device).filter(Boolean);

// The home network in miniature: hv1 is a Proxmox host and the subnet router for 10.0.0.0/24, and this server is one
// of its VMs; desk is on that LAN with its own Tailscale; media is a container with no Tailscale.
function home(over: { devices?: Device[]; lanHosts?: LanHost[]; proxmox?: ProxmoxStatus | null } = {}) {
  const devices = over.devices ?? [
    dev('box', { self: true }),
    dev('hv1', { routes: ['10.0.0.0/24'], lanIps: ['10.0.0.2'], lanVia: { '10.0.0.2': 'ssh-hostkey' }, path: { type: 'direct', endpoint: '10.0.0.2:41641' }, ports: ports(3) }),
    dev('store', { lanIps: ['10.0.0.3'], lanVia: { '10.0.0.3': 'proxmox' } }),
    dev('old', { online: false, lastSeen: '2026-10-01T00:00:00Z', lanIps: ['10.0.0.4'] }),
    dev('desk', { os: 'windows', lanIps: ['10.0.0.7'], lanVia: { '10.0.0.7': 'compute-pool' }, path: { type: 'direct', endpoint: '10.0.0.7:41641' } }),
    dev('laptop', { os: 'macOS', path: { type: 'relay', region: 'tok' } }),
    dev('phone', { os: 'iOS', online: false }),
  ];
  const proxmox = over.proxmox === undefined
    ? pve([pveHost('hv1', [
        guest(205, 'box', { type: 'qemu', device: 'box', deviceMatch: 'mac' }),
        guest(203, 'store', { lanIp: '10.0.0.3', device: 'store', deviceMatch: 'name' }),
        guest(204, 'media', { lanIp: '10.0.0.44', ips: ['10.0.0.44'], device: 'lan:10.0.0.44', deviceMatch: 'mac', ports: ports(2) }),
        guest(202, 'old', { type: 'qemu', lanIp: '10.0.0.4', device: 'old', deviceMatch: 'name' }),
        guest(900, 'tmpl', { template: true }),
      ], { ip: '10.0.0.2' })])
    : over.proxmox;
  const lanHosts = over.lanHosts ?? [
    lan('10.0.0.108', 'client', '개인 Wi-Fi 주소 기기'),
    lan('10.0.0.1', 'neighbor', 'Router 기기'),
    lan('10.0.0.44', 'neighbor'), // media's address: it is the guest
    lan('10.0.0.7', 'neighbor'), // desk's
    lan('172.18.0.5', 'neighbor'), // a docker bridge neighbour: not a LAN machine
  ];
  return buildNetTree({ devices, proxmox, lanHosts, selfLanIps: ['10.0.0.205'] });
}

test('inCidr: IPv4 prefixes, junk is false', () => {
  assert.equal(inCidr('10.0.0.7', '10.0.0.0/24'), true);
  assert.equal(inCidr('10.0.1.7', '10.0.0.0/24'), false);
  assert.equal(inCidr('10.9.9.9', '0.0.0.0/0'), true);
  assert.equal(inCidr('fd00::1', '10.0.0.0/24'), false);
  assert.equal(inCidr('10.0.0.7', '10.0.0.0/33'), false);
});

test('a Proxmox host that routes the LAN: guests, then the LAN group; the rest is 직접 연결', () => {
  const t = home();
  assert.deepEqual(shape(t), [
    'hv1',
    '  old', '  store', '  media', '  box',
    '  LAN 10.0.0.0/24',
    '    desk', '    개인 Wi-Fi 주소 기기', '    Router 기기',
    '직접 연결',
    '  laptop', '  phone',
  ]);
});

test('guests: vmid order, this server, LAN-only, offline, the template left out', () => {
  const t = home();
  const host = find(t, 'host:hv1');
  assert.deepEqual(host.proxmox, { node: 'hv1', status: 'online' });
  assert.deepEqual(host.routes, [{ cidr: '10.0.0.0/24', role: 'primary' }]);
  assert.equal(host.ports, 3);
  assert.deepEqual(host.children.filter((c) => c.kind === 'guest').map((c) => c.guest!.vmid), [202, 203, 204, 205]);
  const box = find(t, 'guest:hv1/205');
  assert.equal(box.self, true);
  assert.equal(box.device, 'box');
  assert.deepEqual(box.lanIps, ['10.0.0.205']); // the server's own LAN address
  assert.equal(box.guest!.type, 'qemu');
  const media = find(t, 'guest:hv1/204');
  assert.equal(media.device, 'lan:10.0.0.44');
  assert.equal(media.guest!.lanOnly, true);
  assert.deepEqual(media.tailscaleIps, []);
  assert.equal(media.online, true);
  assert.equal(media.ports, 2);
  // running on Proxmox, offline on the tailnet: both stay visible
  const old = find(t, 'guest:hv1/202');
  assert.equal(old.online, false);
  assert.equal(old.guest!.status, 'running');
  assert.equal(old.guest!.lanOnly, false);
  assert.equal([...walk(t.roots)].some(({ node }) => node.name === 'tmpl'), false);
});

test('LAN members: tailnet 직접, 경유로만, ARP로만; addresses of guests and hosts are not listed again', () => {
  const t = home();
  const net = find(t, 'subnet:10.0.0.0/24@hv1');
  assert.deepEqual(net.subnet, { cidr: '10.0.0.0/24', router: 'hv1', role: 'primary', primary: 'hv1', standby: [] });
  assert.deepEqual(net.children.map((c) => [c.name, c.reach, c.device]), [
    ['desk', 'tailnet', 'desk'],
    ['개인 Wi-Fi 주소 기기', 'routed', 'lan:10.0.0.108'],
    ['Router 기기', 'arp', 'lan:10.0.0.1'],
  ]);
  assert.equal(net.children[0].lanVia, 'compute-pool');
  assert.deepEqual(net.children[0].path, { type: 'direct', endpoint: '10.0.0.7:41641' });
});

test('every device appears once', () => {
  const ids = deviceIds(home());
  assert.deepEqual(ids, [...new Set(ids)]);
  assert.deepEqual(ids.sort(), ['box', 'desk', 'hv1', 'lan:10.0.0.1', 'lan:10.0.0.108', 'lan:10.0.0.44', 'laptop', 'old', 'phone', 'store']);
});

test('the same CIDR from two routers: the primary lists the LAN, the standby says so', () => {
  const devices = [
    dev('box', { self: true }),
    dev('gw-a', { routes: ['10.0.0.0/24'], lanIps: ['10.0.0.2'] }),
    dev('gw-b', { standbyRoutes: ['10.0.0.0/24'], lanIps: ['10.0.0.3'] }),
    dev('desk', { lanIps: ['10.0.0.7'] }),
  ];
  const t = buildNetTree({ devices, proxmox: null, lanHosts: [lan('10.0.0.50', 'client')], selfLanIps: [] });
  assert.deepEqual(shape(t), ['gw-a', '  LAN 10.0.0.0/24', '    desk', '    10.0.0.50', 'gw-b', '  LAN 10.0.0.0/24', '직접 연결', '  box']);
  assert.deepEqual(find(t, 'subnet:10.0.0.0/24@gw-a').subnet, { cidr: '10.0.0.0/24', router: 'gw-a', role: 'primary', primary: 'gw-a', standby: ['gw-b'] });
  assert.deepEqual(find(t, 'subnet:10.0.0.0/24@gw-b').subnet, { cidr: '10.0.0.0/24', router: 'gw-b', role: 'standby', primary: 'gw-a', standby: [] });
  assert.deepEqual(find(t, 'host:gw-b').routes, [{ cidr: '10.0.0.0/24', role: 'standby' }]);

  // both claiming primary (a stale netmap): the online one, then by name, is primary; still listed once
  const both = buildNetTree({
    devices: [dev('gw-b', { routes: ['10.0.0.0/24'] }), dev('gw-a', { routes: ['10.0.0.0/24'], online: false }), dev('desk', { lanIps: ['10.0.0.7'] })],
    proxmox: null, lanHosts: [], selfLanIps: [],
  });
  assert.equal(find(both, 'subnet:10.0.0.0/24@gw-b').subnet!.role, 'primary');
  assert.equal(find(both, 'subnet:10.0.0.0/24@gw-a').subnet!.role, 'standby');
  assert.deepEqual(find(both, 'subnet:10.0.0.0/24@gw-b').children.map((c) => c.name), ['desk']);
  assert.deepEqual(find(both, 'subnet:10.0.0.0/24@gw-a').children, []);

  // only standbys (the primary dropped out of the netmap): the best standby still lists the LAN
  const orphan = buildNetTree({ devices: [dev('gw-b', { standbyRoutes: ['10.0.0.0/24'] }), dev('desk', { lanIps: ['10.0.0.7'] })], proxmox: null, lanHosts: [], selfLanIps: [] });
  assert.deepEqual(find(orphan, 'subnet:10.0.0.0/24@gw-b').subnet, { cidr: '10.0.0.0/24', router: 'gw-b', role: 'standby', primary: null, standby: [] });
  assert.deepEqual(find(orphan, 'subnet:10.0.0.0/24@gw-b').children.map((c) => c.name), ['desk']);
});

test('several routers: each LAN under its own router, the most specific subnet wins', () => {
  const devices = [
    dev('wide', { routes: ['10.0.0.0/16'] }),
    dev('narrow', { routes: ['10.0.1.0/24', '0.0.0.0/0', '::/0'] }),
    dev('a', { lanIps: ['10.0.1.5'] }),
    dev('b', { lanIps: ['10.0.2.5'] }),
  ];
  const t = buildNetTree({ devices, proxmox: null, lanHosts: [lan('10.0.1.9', 'neighbor'), lan('10.0.3.9', 'client')], selfLanIps: [] });
  assert.deepEqual(shape(t), ['narrow', '  LAN 10.0.1.0/24', '    a', '    10.0.1.9', 'wide', '  LAN 10.0.0.0/16', '    b', '    10.0.3.9']);
  assert.deepEqual(find(t, 'host:narrow').routes, [{ cidr: '10.0.1.0/24', role: 'primary' }]); // exit routes are not LANs
});

test('a router that is not a Proxmox host, and Proxmox not configured', () => {
  const devices = [dev('box', { self: true, lanIps: [] }), dev('pi', { routes: ['10.0.0.0/24'], lanIps: ['10.0.0.2'] }), dev('laptop')];
  for (const proxmox of [null, { configured: false, ok: false, hosts: [] }]) {
    const t = buildNetTree({ devices, proxmox, lanHosts: [lan('10.0.0.30', 'client', 'nas')], selfLanIps: ['10.0.0.205'] });
    // this server is on the routed LAN with its own Tailscale: a LAN member, marked as itself
    assert.deepEqual(shape(t), ['pi', '  LAN 10.0.0.0/24', '    box', '    nas', '직접 연결', '  laptop']);
    const box = find(t, 'dev:box');
    assert.equal(box.self, true);
    assert.equal(box.reach, 'tailnet');
    assert.equal(find(t, 'host:pi').proxmox, undefined);
  }
});

test('a Proxmox host that routes nothing and has no tailnet device; guests with nothing matched', () => {
  const proxmox = pve([pveHost('hv2', [guest(100, 'vm-a', { type: 'qemu', status: 'stopped' }), guest(101, 'ct-b', { ips: ['10.0.5.9'] })], { device: null, status: 'offline', ip: '10.0.5.2' })]);
  const t = buildNetTree({ devices: [dev('box', { self: true })], proxmox, lanHosts: [], selfLanIps: [] });
  assert.deepEqual(shape(t), ['hv2', '  vm-a', '  ct-b', '직접 연결', '  box']);
  const host = find(t, 'host:hv2');
  assert.equal(host.device, null);
  assert.equal(host.online, false);
  assert.deepEqual(host.lanIps, ['10.0.5.2']);
  assert.equal(find(t, 'guest:hv2/100').device, null);
  assert.equal(find(t, 'guest:hv2/100').online, false);
  assert.equal(find(t, 'guest:hv2/101').guest!.lanOnly, true);
});

test('an offline router keeps its LAN group', () => {
  const t = buildNetTree({ devices: [dev('gw', { online: false, routes: ['10.0.0.0/24'] }), dev('box', { self: true, lanIps: [] })], proxmox: null, lanHosts: [lan('10.0.0.9', 'client')], selfLanIps: ['10.0.0.5'] });
  assert.deepEqual(shape(t), ['gw', '  LAN 10.0.0.0/24', '    box', '    10.0.0.9']);
  assert.equal(find(t, 'host:gw').online, false);
});

test('devices that match nothing: a pool-only host, a LAN client outside every routed subnet', () => {
  const devices = [dev('gw', { routes: ['10.0.0.0/24'] }), dev('pool:far', { tailscaleIps: [], lanIps: ['192.0.2.5'], online: false })];
  const t = buildNetTree({ devices, proxmox: null, lanHosts: [lan('10.1.0.9', 'client', 'lost'), lan('10.2.0.9', 'neighbor')], selfLanIps: [] });
  assert.deepEqual(shape(t), ['gw', '  LAN 10.0.0.0/24', '직접 연결', '  pool:far', '그 밖의 LAN 기기', '  lost']);
  assert.equal(find(t, 'lan:10.1.0.9').reach, undefined);
  // a pool host on a routed LAN without Tailscale: reached through the router
  const t2 = buildNetTree({ devices: [dev('gw', { routes: ['10.0.0.0/24'] }), dev('pool:nuc', { tailscaleIps: [], lanIps: ['10.0.0.8'], lanVia: { '10.0.0.8': 'compute-pool' } })], proxmox: null, lanHosts: [], selfLanIps: [] });
  assert.equal(find(t2, 'dev:pool:nuc').reach, 'routed');
  // nothing at all
  assert.deepEqual(buildNetTree({ devices: [], proxmox: null, lanHosts: [], selfLanIps: [] }).roots, []);
});

test('a guest that routes a subnet carries its LAN group; a client wins over its own ARP entry', () => {
  const devices = [dev('hv1'), dev('fw', { routes: ['10.9.0.0/24'] })];
  const proxmox = pve([pveHost('hv1', [guest(110, 'fw', { type: 'qemu', device: 'fw', deviceMatch: 'name' })])]);
  const t = buildNetTree({ devices, proxmox, lanHosts: [lan('10.9.0.4', 'neighbor'), lan('10.9.0.4', 'client', 'cam')], selfLanIps: [] });
  assert.deepEqual(shape(t), ['hv1', '  fw', '    LAN 10.9.0.0/24', '      cam']);
  assert.equal(find(t, 'lan:10.9.0.4').reach, 'routed');
});

test('Funnel/ingress peers never reach the tree; standby routes come from AllowedIPs', () => {
  const status = JSON.stringify({
    Self: { HostName: 'box', DNSName: 'box.example.ts.net.', OS: 'linux', TailscaleIPs: ['100.64.0.1'], Online: true },
    Peer: {
      a: { HostName: 'gw-a', DNSName: 'gw-a.example.ts.net.', Online: true, TailscaleIPs: ['100.64.0.2'], PrimaryRoutes: ['10.0.0.0/24'], AllowedIPs: ['100.64.0.2/32', '10.0.0.0/24'] },
      b: { HostName: 'gw-b', DNSName: 'gw-b.example.ts.net.', Online: true, TailscaleIPs: ['100.64.0.3', 'fd7a:115c:a1e0::3'], AllowedIPs: ['100.64.0.3/32', 'fd7a:115c:a1e0::3/128', '10.0.0.0/24', '0.0.0.0/0', '::/0'] },
      f: { HostName: 'funnel-ingress-node', Tags: ['tag:ingress'], ShareeNode: true, TailscaleIPs: ['100.64.9.9'], Online: true },
      g: { HostName: 'x', ShareeNode: true, TailscaleIPs: ['100.64.9.8'], Online: true },
    },
  });
  const peers = parsePeers(status);
  assert.deepEqual(peers.map((p) => [p.name, p.routes, p.standbyRoutes]), [['box', [], []], ['gw-a', ['10.0.0.0/24'], []], ['gw-b', [], ['10.0.0.0/24']]]);
  const t = buildNetTree({ devices: mergeDevices(peers, [], {}), proxmox: null, lanHosts: [], selfLanIps: [] });
  assert.deepEqual(shape(t), ['gw-a', '  LAN 10.0.0.0/24', 'gw-b', '  LAN 10.0.0.0/24', '직접 연결', '  box']);
});

test('remote list_devices: the tree without addresses or address-made keys; showAddresses keeps the subnets', () => {
  const tree = home();
  const d = { at: 'x', pool: { available: true }, devices: [], proxmox: { configured: false, ok: false, hosts: [] }, pvePorts: null, winPorts: null, tree } as any;
  const strict = redactDevices(d);
  const text = JSON.stringify(strict.tree);
  assert.doesNotMatch(text, /\b10\.0\.|100\.64\.|172\.18\./);
  assert.doesNotMatch(text, /"key"/);
  const host = strict.tree!.roots[0] as any;
  assert.deepEqual([host.name, host.routesSubnets, host.standbyFor], ['hv1', 1, 0]);
  const net = host.children.find((c: any) => c.kind === 'subnet');
  assert.equal(net.name, 'LAN');
  assert.deepEqual(net.subnet, { router: 'hv1', role: 'primary', primary: 'hv1', standby: [] });
  assert.deepEqual(net.children.map((c: any) => [c.device, c.reach]), [['desk', 'tailnet'], ['lan-device-2', 'routed'], ['lan-device-3', 'arp']]);
  // the LAN-only guest: aliased like the other lan: ids, in one response
  assert.equal(host.children.find((c: any) => c.guest?.vmid === 204).device, 'lan-device-1');
  const open = redactDevices(d, { showAddresses: true, showProcesses: false });
  const openNet = (open.tree!.roots[0] as any).children.find((c: any) => c.kind === 'subnet');
  assert.equal(openNet.subnet.cidr, '10.0.0.0/24');
  assert.equal(openNet.name, 'LAN 10.0.0.0/24');
});
