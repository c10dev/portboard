import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpoint, parseEstablished } from '../src/core/conn.ts';
import { parseSs } from '../src/core/ss.ts';
import { parsePeers } from '../src/core/devices.ts';
import { buildTopology, isPortboard } from '../src/core/topology.ts';
import type { PortEntry, Snapshot } from '../src/core/index.ts';
import { L } from './fixtures/locale.ts';

const EST = [
  '0      0               192.168.1.205:22             192.168.1.201:62776                                              ',
  '\t cubic wscale:6,10 rto:236 rtt:35.148/3.307 bytes_sent:78177650 bytes_acked:78007186 bytes_received:32059006 segs_out:105248',
  '0      0               100.64.10.1:22             100.64.10.3:57434                                              ',
  '\t cubic rtt:20.5/1 bytes_sent:100 bytes_received:50',
  '0      0                   127.0.0.1:55746              127.0.0.1:5281 users:(("MainThread",pid=2427190,fd=21))     ',
  '0      0                   127.0.0.1:5281              127.0.0.1:55746 users:(("node",pid=77,fd=44))',
  '0      0                   127.0.0.1:41000              127.0.0.1:8790',
  '0      0                   127.0.0.1:8790              127.0.0.1:41000 users:(("node",pid=88,fd=9))',
  '0      0      [fd7a:115c:a1e0::10:1]:443   [fd7a:115c:a1e0::10:3]:50000',
  '0      0               192.168.1.205:56930           172.66.0.243:443   users:(("tunnel-client",pid=1769,fd=8))      ',
  '0      0               100.64.10.1:7721           100.99.1.1:65329 users:(("cpool",pid=126354,fd=9))',
  '0      0        [::ffff:192.168.1.205]:3000           [::ffff:172.17.0.1]:40000',
  '0      0               192.168.1.205:3000           172.18.0.5:41234',
  '',
].join('\n');

test('parseEstablished reads rows without a State column and pairs the TCP-info line', () => {
  const c = parseEstablished(EST);
  assert.equal(c.length, 11);
  assert.deepEqual(c[0].local, { address: '192.168.1.205', port: 22 });
  assert.deepEqual(c[0].peer, { address: '192.168.1.201', port: 62776 });
  assert.equal(c[0].bytesSent, 78177650);
  assert.equal(c[0].bytesReceived, 32059006);
  assert.equal(c[0].rttMs, 35.148);
  assert.deepEqual(c[2].processes, [{ name: 'MainThread', pid: 2427190 }]);
  assert.equal(c[2].bytesSent, null);
  assert.equal(c[6].local.address, 'fd7a:115c:a1e0::10:1');
  assert.equal(c[9].peer.address, '172.17.0.1');
});

test('endpoint and parseSs strip the interface suffix outside IPv6 brackets', () => {
  assert.deepEqual(endpoint('[fd7a:115c:a1e0::10:1]%tailscale0:443'), { address: 'fd7a:115c:a1e0::10:1', port: 443 });
  assert.deepEqual(endpoint('100.64.10.1%tailscale0:443'), { address: '100.64.10.1', port: 443 });
  const [l] = parseSs('LISTEN 0 4096 [fd7a:115c:a1e0::10:1]%tailscale0:443 [::]:*');
  assert.equal(l.address, 'fd7a:115c:a1e0::10:1');
  assert.equal(l.scope, 'tailnet');
});

const STATUS = JSON.stringify({
  Self: { HostName: 'devbox', DNSName: 'devbox.tail.ts.net.', OS: 'linux', TailscaleIPs: ['100.64.10.1', 'fd7a:115c:a1e0::10:1'], Online: true },
  Peer: {
    a: {
      HostName: 'Dev’s MacBook Pro', DNSName: 'dev-mac.tail.ts.net.', OS: 'macOS',
      TailscaleIPs: ['100.64.10.3', 'fd7a:115c:a1e0::10:3'], Online: true, Active: true,
      CurAddr: '118.235.12.86:45229', Relay: 'tok', LastSeen: '2026-10-17T08:40:00.1Z', LastHandshake: '2026-10-17T10:11:43Z', RxBytes: 5, TxBytes: 7,
    },
    b: { HostName: 'localhost', DNSName: 'iphone.tail.ts.net.', OS: 'iOS', TailscaleIPs: ['100.64.10.7'], Online: true, Active: true, CurAddr: '', Relay: 'tok', LastSeen: '0001-01-01T00:00:00Z' },
    c: { HostName: 'docker-vm', DNSName: 'docker-vm.tail.ts.net.', OS: 'linux', TailscaleIPs: ['100.64.10.5'], Online: false, Active: false, CurAddr: '', Relay: 'tok', LastSeen: '2026-08-17T13:41:20.1Z' },
  },
});

function port(p: Partial<PortEntry> & { port: number; addresses: string[] }): PortEntry {
  return {
    listening: true, scope: 'loopback', owned: true, kind: 'app', container: null, composeProject: null, processes: [], systemOwner: null, group: null, role: null,
    name: `svc ${p.port}`, detectedName: `svc ${p.port}`, label: null, pinned: false, hidden: false, visible: true,
    probe: null, served: null, urls: { direct: null, served: null, ssh: '' },
    canExpose: false, exposeBlocker: null, control: null, canRestart: false, canStop: false,
    ...p,
  };
}

const SNAP: Snapshot = {
  at: '2026-10-17T10:00:00.000Z',
  host: { hostname: 'devbox', user: 'dev' },
  tailscale: { available: true, dnsName: 'devbox.tail.ts.net', hostName: 'devbox', ips: ['100.64.10.1', 'fd7a:115c:a1e0::10:1'] },
  ports: [
    port({ port: 22, addresses: ['0.0.0.0', '::'], owned: false, kind: 'system', visible: false, scope: 'all', name: 'SSH (sshd)' }), // snapshot() names well-known system ports
    port({ port: 443, addresses: ['100.64.10.1', 'fd7a:115c:a1e0::10:1'], owned: false, kind: 'system', visible: false, scope: 'tailnet' }),
    port({ port: 3000, addresses: ['*'], scope: 'all' }),
    port({ port: 5281, addresses: ['127.0.0.1'] }),
    port({ port: 7721, addresses: ['100.64.10.1'], scope: 'tailnet' }),
    port({
      port: 8790, addresses: ['127.0.0.1', '100.64.10.1'], scope: 'tailnet',
      served: { httpsPort: 443, upstream: 'http://127.0.0.1:8790', upstreamPort: 8790 },
      urls: { direct: null, served: 'https://devbox.tail.ts.net/', ssh: '' },
    }),
  ],
};

function build(est = EST) {
  return buildTopology({
    snapshot: SNAP,
    peers: parsePeers(STATUS),
    conns: parseEstablished(est),
    lanIps: ['192.168.1.205'],
    selfIps: ['192.168.1.205', '172.17.0.1'],
    firstSeen: () => Date.parse('2026-10-17T09:00:00Z'),
    startedAt: Date.parse('2026-10-17T08:00:00Z'),
  });
}

test('buildTopology attributes connections to devices, LAN, docker, local processes and serve', () => {
  const t = build();
  const edges = Object.fromEntries(t.edges.map((e) => [e.id, e]));
  assert.deepEqual(Object.keys(edges).sort(), [
    'dev:dev-mac>22',
    'dev:dev-mac>8790@443',
    'docker>3000',
    'lan:192.168.1.201>22',
    'local>3000',
    'local>5281',
    'ts:100.99.1.1>7721',
  ]);
  // loopback seen from both sides counts once, named after the client process
  assert.equal(edges['local>5281'].connections, 1);
  assert.deepEqual(edges['local>5281'].processes, ['MainThread (2427190)']);
  // serve: the tailnet leg is attributed to the device; the hidden-owner loopback leg is only counted
  assert.equal(edges['dev:dev-mac>8790@443'].via, 'serve');
  assert.equal(edges['dev:dev-mac>8790@443'].servePort, 443);
  assert.equal(t.services.find((s) => s.port === 8790)?.proxyConnections, 1);
  assert.equal(t.services.some((s) => s.port === 443), false);
  // self's docker bridge address counts as local
  assert.equal(edges['local>3000'].connections, 1);
  assert.equal(edges['lan:192.168.1.201>22'].bytesSent, 78177650);
  assert.equal(edges['lan:192.168.1.201>22'].since, '2026-10-17T09:00:00.000Z');
  assert.equal(t.observingSince, '2026-10-17T08:00:00.000Z');
  assert.equal(t.outboundConnections, 1);
  assert.equal(t.services.find((s) => s.port === 22)?.name, 'SSH (sshd)');
  // only clients with a connection; the tailnet IP resolves to the device's DNS label, not its HostName
  assert.deepEqual(t.clients.map((d) => d.id), ['lan:192.168.1.201', 'dev:dev-mac', 'local', 'ts:100.99.1.1', 'docker']);
  assert.equal(t.self.os, 'linux');
});

test('buildTopology shows unpaired serve proxy legs without guessing a device', () => {
  const t = build(['0      0                   127.0.0.1:41000              127.0.0.1:8790', '0      0                   127.0.0.1:8790              127.0.0.1:41000'].join('\n'));
  assert.deepEqual(t.edges.map((e) => [e.from, e.port, e.via, e.servePort, e.connections]), [['serve', 8790, 'serve', 443, 1]]);
  assert.equal(t.clients.find((d) => d.id === 'serve')?.label, L('tailscale serve · 기기 미확인', 'tailscale serve · unknown device'));
});

test("buildTopology leaves out Portboard's own HTTP probe connections", () => {
  const est = ['0      0                   127.0.0.1:41001              127.0.0.1:5281 users:(("node",pid=999,fd=3))', '0      0                   127.0.0.1:5281              127.0.0.1:41001'].join('\n');
  const t = buildTopology({
    snapshot: SNAP, peers: parsePeers(STATUS), conns: parseEstablished(est), lanIps: [], selfIps: [],
    firstSeen: () => 0, startedAt: 0, selfPid: 999,
  });
  assert.deepEqual(t.edges, []);
});

test('other Portboard processes (a preview, the MCP server) are probes too', () => {
  const est = ['0      0                   127.0.0.1:41002              127.0.0.1:5281 users:(("node",pid=4242,fd=3))', '0      0                   127.0.0.1:5281              127.0.0.1:41002'].join('\n');
  const input = { snapshot: SNAP, peers: parsePeers(STATUS), conns: parseEstablished(est), lanIps: [], selfIps: [], firstSeen: () => 0, startedAt: 0, selfPid: 999 };
  assert.equal(buildTopology(input).edges.length, 1);
  assert.deepEqual(buildTopology({ ...input, probePids: [4242] }).edges, []);
  assert.equal(isPortboard('node src/server.ts', '/home/dev/projects/worktrees/portboard-alerts'), true);
  assert.equal(isPortboard('/usr/bin/node /home/dev/projects/portboard/src/mcp.ts', '/home/dev'), true);
  assert.equal(isPortboard('node src/server.ts', '/home/dev/projects/acme'), false);
  assert.equal(isPortboard('node /home/dev/projects/portboard/scripts/x.ts', '/'), false);
});
