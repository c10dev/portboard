import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDevices, parsePeers } from '../src/core/devices.ts';
import { hostPorts, scopeOf } from '../src/core/hostports.ts';
import { fromHostsDoc, fromStateDoc, listeningOf, type PoolHost } from '../src/core/pool.ts';

const host = (over: Partial<PoolHost>): PoolHost => ({ name: 'x', kind: 'ssh', addresses: [], state: 'ok', inRotation: true, slots: 1, busy: 0, ...over });

// the desktop's WSL as compute-pool's probe reported it (mirrored networking: eth0 carries the Windows Tailscale IP)
const desktopListening = [
  { port: 53, address: '10.255.255.254' },
  { port: 53, address: '127.0.0.53' },
  { port: 53, address: '127.0.0.54' },
  { port: 2222, address: '0.0.0.0' },
  { port: 2222, address: '::' },
  { port: 3000, address: '100.64.10.2', process: 'node' },
  { port: 5190, address: '127.0.0.1', process: 'node' },
  { port: 8443, address: '::ffff:127.0.0.1' },
  { port: 9000, address: '*', process: 'vite' },
  { port: 9000, address: '::1', process: 'vite' },
];

const ts = JSON.stringify({
  Self: { HostName: 'devbox', DNSName: 'devbox.tail.ts.net.', OS: 'linux', TailscaleIPs: ['100.64.10.1'], Online: true },
  Peer: {
    a: { HostName: 'Mac', DNSName: 'dev-mac.tail.ts.net.', OS: 'macOS', Online: false, TailscaleIPs: ['100.64.10.3'] },
    b: { HostName: 'DESKTOP-PC', DNSName: 'desktop-pc.tail.ts.net.', OS: 'windows', Online: true, TailscaleIPs: ['100.64.10.2', 'fd7a:115c:a1e0::1'] },
  },
});

test('scopeOf: all interfaces, the device Tailscale IP, loopback (v4, v6, v4-mapped), anything else', () => {
  const ips = ['100.64.10.2'];
  assert.equal(scopeOf('0.0.0.0', ips), 'all');
  assert.equal(scopeOf('::', ips), 'all');
  assert.equal(scopeOf('*', ips), 'all');
  assert.equal(scopeOf('100.64.10.2', ips), 'tailnet');
  assert.equal(scopeOf('100.64.10.3', ips), 'other'); // another device's address is not this one's
  assert.equal(scopeOf('127.0.0.53', ips), 'loopback');
  assert.equal(scopeOf('::1', ips), 'loopback');
  assert.equal(scopeOf('::ffff:127.0.0.1', ips), 'loopback');
  assert.equal(scopeOf('10.255.255.254', ips), 'other');
  assert.equal(scopeOf('172.17.0.1', ips), 'other');
});

test('hostPorts groups by port, keeps the widest scope, links only tailnet-reachable HTTP-ish ports', () => {
  const hp = hostPorts(host({ listening: desktopListening, listeningAt: 123 }), {
    online: true,
    dnsName: 'desktop-pc.tail.ts.net',
    tailscaleIps: ['100.64.10.2'],
  });
  assert.ok(hp);
  assert.equal(hp.at, 123);
  const by = Object.fromEntries(hp.ports.map((p) => [p.port, p]));
  assert.deepEqual(hp.ports.map((p) => p.port), [53, 2222, 3000, 5190, 8443, 9000]);
  assert.deepEqual(by[53], { port: 53, scope: 'other', addresses: ['10.255.255.254', '127.0.0.53', '127.0.0.54'], processes: [], tailnet: false, lan: false, url: null });
  assert.equal(by[2222].scope, 'all');
  assert.equal(by[2222].tailnet, true);
  assert.equal(by[2222].url, null); // sshd: reachable, but not a web page
  assert.deepEqual(by[2222].addresses, ['0.0.0.0', '::']);
  assert.equal(by[3000].scope, 'tailnet');
  assert.equal(by[3000].url, 'http://desktop-pc.tail.ts.net:3000');
  assert.equal(by[5190].scope, 'loopback');
  assert.equal(by[5190].url, null);
  assert.equal(by[8443].scope, 'loopback');
  assert.equal(by[9000].scope, 'all'); // * wins over ::1
  assert.deepEqual(by[9000].processes, ['vite']);
  assert.equal(by[9000].url, 'http://desktop-pc.tail.ts.net:9000');
});

test('hostPorts: not reported → null; reported none → empty; offline or nameless device → no links', () => {
  const dev = { online: true, dnsName: 'm.tail.ts.net', tailscaleIps: [] };
  assert.equal(hostPorts(null, dev), null);
  assert.equal(hostPorts(host({}), dev), null);
  assert.equal(hostPorts(host({ listening: [{ port: 1, address: '*' }] }), dev), null); // no listeningAt
  assert.deepEqual(hostPorts(host({ listening: [], listeningAt: 5 }), dev), { at: 5, ports: [] });
  const off = hostPorts(host({ listening: [{ port: 3000, address: '*' }], listeningAt: 5 }), { ...dev, online: false });
  assert.equal(off?.ports[0].tailnet, false);
  assert.equal(off?.ports[0].url, null);
  const noName = hostPorts(host({ listening: [{ port: 3000, address: '*' }], listeningAt: 5 }), { ...dev, dnsName: null });
  assert.equal(noName?.ports[0].url, null);
});

test('listeningOf / fromHostsDoc pass ports through only with listeningAt, and drop malformed entries', () => {
  assert.deepEqual(listeningOf({ listening: [{ port: 22, address: '*' }] }), { listening: undefined, listeningAt: undefined });
  assert.deepEqual(listeningOf({ listening: null, listeningAt: 1 }), { listening: undefined, listeningAt: undefined });
  assert.deepEqual(
    listeningOf({ listeningAt: 9, listening: [{ port: 22, address: '*', process: '' }, { port: 0, address: '*' }, { port: 80 }, 'x', { port: 3000, address: '::1', process: 'node' }] }),
    { listening: [{ port: 22, address: '*' }, { port: 3000, address: '::1', process: 'node' }], listeningAt: 9 },
  );
  const doc = fromHostsDoc({
    version: 1,
    hosts: [
      { name: 'desktop', kind: 'ssh', addresses: ['192.168.1.7'], state: 'ok', inRotation: true, slots: 3, busy: 0, listening: desktopListening, listeningAt: 7 },
      { name: 'mac', kind: 'agent', addresses: [], state: 'agent-busy', inRotation: false, slots: 1, busy: 0 },
    ],
  });
  assert.equal(doc.hosts[0].listening?.length, desktopListening.length);
  assert.equal(doc.hosts[0].listeningAt, 7);
  assert.equal(doc.hosts[1].listening, undefined);
  assert.equal(doc.hosts[1].listeningAt, undefined);
  // older monitors have no ports at all
  const st = fromStateDoc({ hosts: [{ name: 'desktop', kind: 'ssh', slots: 3, health: { state: 'ok', listening: desktopListening } }] }, '{}');
  assert.equal(st.hosts[0].listening, undefined);
});

test('mergeDevices attaches ports with the device MagicDNS name; the mac offline gets none linked', () => {
  const pool = [
    host({ name: 'devbox', kind: 'local' }),
    host({ name: 'desktop', addresses: ['192.168.1.7'], listening: desktopListening, listeningAt: 1 }),
    host({ name: 'mac', kind: 'agent', addresses: ['100.64.10.3'], state: 'agent-away', listening: [{ port: 5173, address: '*', process: 'node' }], listeningAt: 2 }),
    host({ name: 'lonely', addresses: ['192.168.1.9'], listening: [{ port: 80, address: '0.0.0.0' }], listeningAt: 3 }),
  ];
  const ds = mergeDevices(parsePeers(ts), pool, { desktop: 'desktop-pc' });
  const by = Object.fromEntries(ds.map((d) => [d.id, d]));
  assert.equal(by['devbox'].ports, null); // this server: list_ports, not compute-pool
  assert.equal(by['desktop-pc'].dnsName, 'desktop-pc.tail.ts.net');
  assert.equal(by['desktop-pc'].ports?.ports.find((p) => p.port === 9000)?.url, 'http://desktop-pc.tail.ts.net:9000');
  assert.equal(by['dev-mac'].ports?.ports[0].url, null); // Tailscale says offline
  assert.equal(by['pool:lonely'].dnsName, null);
  assert.equal(by['pool:lonely'].ports?.ports[0].url, null); // not on the tailnet as far as we know
  assert.equal(by['pool:lonely'].ports?.ports[0].scope, 'all');
});
