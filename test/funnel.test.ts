// Tailscale Funnel traffic (the public remote MCP on 443 → 8794): named "Funnel (공개, claude.ai 등)", not an unnamed device.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEstablished } from '../src/core/conn.ts';
import { emptyHistory, record, samplesOf, withHistory } from '../src/core/history.ts';
import type { PortEntry, Snapshot } from '../src/core/index.ts';
import { parseServe } from '../src/core/tailscale.ts';
import { buildTopology, funnelLabel } from '../src/core/topology.ts';
import { buildUsage } from '../src/core/usage.ts';
import { usageReport } from '../src/features/usage.ts';
import { redactUsage } from '../src/remote/redact.ts';

const FUNNEL_LABEL = funnelLabel();
const DNS = 'devbox.tail.ts.net';
const SELF_IPS = ['100.64.10.1', 'fd7a:115c:a1e0::10:1'];

test('parseServe marks AllowFunnel entries', () => {
  const entries = parseServe(
    JSON.stringify({
      Web: {
        [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8794' } } },
        [`${DNS}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8790' } } },
      },
      AllowFunnel: { [`${DNS}:443`]: true },
    }),
  );
  assert.deepEqual(entries, [
    { httpsPort: 443, upstream: 'http://127.0.0.1:8794', upstreamPort: 8794, funnel: true },
    { httpsPort: 8443, upstream: 'http://127.0.0.1:8790', upstreamPort: 8790 },
  ]);
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

function snap(funnel: boolean): Snapshot {
  return {
    at: '2026-10-18T10:00:00.000Z',
    host: { hostname: 'devbox', user: 'dev' },
    tailscale: { available: true, dnsName: DNS, hostName: 'devbox', ips: SELF_IPS },
    ports: [
      port({ port: 443, addresses: SELF_IPS, owned: false, kind: 'system', visible: false, scope: 'tailnet' }),
      port({
        port: 8794, addresses: ['127.0.0.1', '100.64.10.1'], scope: 'tailnet', name: 'Portboard remote MCP',
        served: { httpsPort: 443, upstream: 'http://127.0.0.1:8794', upstreamPort: 8794, ...(funnel ? { funnel: true } : {}) },
      }),
    ],
  };
}

// tailscaled (root, so ss shows no process) proxying to 127.0.0.1:8794, seen from both ends
const leg = (n: number) => [
  `0      0                   127.0.0.1:${41000 + n}              127.0.0.1:8794`,
  `0      0                   127.0.0.1:8794              127.0.0.1:${41000 + n} users:(("MainThread",pid=372520,fd=30))`,
];
// The owner's Mac on the tailnet, through the same :443 listener
const TAILNET_FRONT = '0      0               100.64.10.1:443             100.64.10.3:50000';

const PEERS = [
  { self: true, name: 'devbox', ips: SELF_IPS },
  { self: false, name: 'dev-mac', ips: ['100.64.10.3'] },
] as any;

function topo(funnel: boolean, rows: string[]) {
  return buildTopology({
    snapshot: snap(funnel),
    peers: PEERS,
    conns: parseEstablished(rows.join('\n')),
    lanIps: ['192.168.1.205'],
    selfIps: ['127.0.0.1', '192.168.1.205', ...SELF_IPS],
    firstSeen: () => Date.parse('2026-10-18T09:00:00Z'),
    startedAt: Date.parse('2026-10-18T08:00:00Z'),
  });
}

const edgesOf = (t: ReturnType<typeof topo>) => t.edges.map((e) => [e.from, e.port, e.via, e.servePort, e.connections]);

test('buildTopology names unpaired proxy legs on a Funnel port as Funnel, not an unknown serve device', () => {
  const t = topo(true, [...leg(1), ...leg(2)]);
  assert.deepEqual(edgesOf(t), [['funnel', 8794, 'serve', 443, 2]]);
  assert.deepEqual(t.clients, [{ id: 'funnel', kind: 'funnel', label: FUNNEL_LABEL, address: null }]);
  assert.equal(FUNNEL_LABEL, 'Funnel (공개, claude.ai 등)');
});

test('buildTopology keeps Funnel legs beyond the tailnet-side connections instead of hiding them', () => {
  const t = topo(true, [TAILNET_FRONT, ...leg(1), ...leg(2)]);
  assert.deepEqual(edgesOf(t), [
    ['dev:dev-mac', 8794, 'serve', 443, 1],
    ['funnel', 8794, 'serve', 443, 1],
  ]);
  // One leg per tailnet connection: nothing left over for Funnel
  assert.deepEqual(edgesOf(topo(true, [TAILNET_FRONT, ...leg(1)])), [['dev:dev-mac', 8794, 'serve', 443, 1]]);
});

test('buildTopology: a tailnet-only serve port still shows its unpaired legs as tailscale serve', () => {
  const t = topo(false, [...leg(1)]);
  assert.deepEqual(edgesOf(t), [['serve', 8794, 'serve', 443, 1]]);
  assert.equal(t.clients[0].label, 'tailscale serve · 기기 미확인');
  assert.deepEqual(edgesOf(topo(false, [TAILNET_FRONT, ...leg(1), ...leg(2)])), [['dev:dev-mac', 8794, 'serve', 443, 1]]);
});

function usage() {
  return buildUsage({
    topology: topo(true, [TAILNET_FRONT, ...leg(1), ...leg(2), ...leg(3)]),
    devices: { at: '2026-10-18T10:00:00.000Z', pool: { available: false, source: 'hosts', url: '', healthAt: null }, devices: [] } as any,
    neighbors: new Map(),
    oui: new Map(),
    names: {},
  });
}

test('buildUsage gives Funnel its own named card and byPort entry', () => {
  const u = usage();
  const f = u.cards.find((c) => c.id === 'funnel');
  assert.ok(f);
  assert.equal(f.name, FUNNEL_LABEL);
  assert.equal(f.kind, 'funnel');
  assert.equal(f.nameSource, 'funnel');
  assert.equal(f.nameKey, null, 'nothing to name');
  assert.equal(f.connections, 2);
  assert.deepEqual(f.uses.map((r) => [r.port, r.via, r.servePort, r.service]), [[8794, 'serve', 443, 'Portboard remote MCP']]);
  assert.deepEqual(u.byPort[8794].find((x) => x.id === 'funnel'), { id: 'funnel', name: FUNNEL_LABEL, kind: 'funnel', connections: 2 });
});

test('who_uses and its history name Funnel', () => {
  const u = usage();
  const h = emptyHistory();
  record(h, samplesOf(u), Date.parse('2026-10-18T10:00:00Z'));
  const r = usageReport(withHistory(u, h, Date.parse('2026-10-18T10:01:00Z')), 8794);
  assert.deepEqual(r.ports[0].now.find((x) => x.id === 'funnel'), { device: FUNNEL_LABEL, id: 'funnel', kind: 'funnel', connections: 2 });
  assert.equal(r.ports[0].recent7d.find((x) => x.id === 'funnel')?.device, FUNNEL_LABEL);
  const d = r.devices.find((x) => x.id === 'funnel');
  assert.equal(d?.name, FUNNEL_LABEL);
  assert.equal(d?.online, null);

  // Once it disconnects, the history-only entry keeps the name
  const later = usageReport(withHistory({ ...u, cards: u.cards.filter((c) => c.id !== 'funnel'), byPort: {} }, h, Date.parse('2026-10-18T10:05:00Z')));
  assert.equal(later.devices.find((x) => x.id === 'funnel')?.name, FUNNEL_LABEL);
});

test('remote who_uses_what keeps the Funnel name under the strict policy (not "unnamed device")', () => {
  const out = redactUsage(usage());
  const f = out.cards.find((c) => c.id === 'funnel');
  assert.equal(f?.name, FUNNEL_LABEL);
  assert.equal(out.byPort[8794].find((x: { id: string }) => x.id === 'funnel')?.name, FUNNEL_LABEL);
  assert.equal(f?.kind, 'funnel');
});
