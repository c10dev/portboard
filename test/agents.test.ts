import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentsCollector, checkInfo, checkPorts, type AgentRead } from '../src/core/agents.ts';
import { attachAgents, attachPvePorts, mergeDevices, parsePeers } from '../src/core/devices.ts';
import type { PoolHost } from '../src/core/pool.ts';
import { agentServeConfig, checkAgentTarget, parseSiteFile, resolveSite } from '../src/core/site.ts';

// #10: the board reads every agent portboard.json lists, keeps the last good answer per agent, backs off while one
// fails, and puts the ports on the tailnet device of that name ahead of compute-pool's.

const INFO = { schema: 1, version: '1.2.0', host: 'desk', dnsName: 'desk.tail.ts.net', at: 1, load: { cores: 8, load1: 0.3, memTotalMb: 16000, memAvailMb: 9000, diskFreePct: 40, uptimeSec: 5 } };
const PORTS = { schema: 1, at: 1_000, host: 'desk', listening: [{ port: 3000, address: '0.0.0.0', process: 'node' }, { port: 5432, address: '127.0.0.1', process: 'db' }, { port: 70000, address: '0.0.0.0' }], services: [] };

interface Call { url: string; headers: Record<string, string> }

function fakeFetch(answer: (url: string) => { status: number; body: unknown } | Error) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const a = answer(url);
    if (a instanceof Error) throw a;
    return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const ok = (url: string) => ({ status: 200, body: url.endsWith('/info') ? INFO : PORTS });

test('checkInfo / checkPorts: the schema and shapes the board accepts', () => {
  assert.equal(checkInfo({ ...INFO, schema: 2 }), null);
  assert.equal(checkInfo({ ...INFO, host: '' }), null);
  assert.equal(checkInfo({ ...INFO, dnsName: 'bad name/' })?.dnsName, null);
  assert.deepEqual(checkPorts(PORTS)?.listening.map((p) => p.port), [3000, 5432]); // 70000 dropped
  assert.equal(checkPorts({ schema: 1, listening: [] }), null);
});

test('AgentsCollector: reads info and ports with the token, caches for ttlMs', async () => {
  let now = 0;
  const { f, calls } = fakeFetch(ok);
  const c = new AgentsCollector({ targets: () => [{ name: 'desk', url: 'http://100.64.0.2:8797', token: 'tok' }], fetch: f, now: () => now });
  const [a] = await c.get();
  assert.equal(a.ok, true);
  assert.equal(a.pending, false);
  assert.equal(a.info?.version, '1.2.0');
  assert.deepEqual(a.ports?.listening.map((p) => p.port), [3000, 5432]);
  assert.deepEqual(calls.map((x) => x.url).sort(), ['http://100.64.0.2:8797/agent/v1/info', 'http://100.64.0.2:8797/agent/v1/ports']);
  assert.ok(calls.every((x) => x.headers.authorization === 'Bearer tok'));
  assert.ok(!JSON.stringify(a).includes('tok"'), 'the token is not in the status');
  now = 5_000;
  await c.get();
  assert.equal(calls.length, 2, 'cached');
  now = 11_000;
  await c.get();
  assert.equal(calls.length, 4);
});

test('AgentsCollector: a failing agent backs off, keeps its last good ports, and reports a fixed code', async () => {
  let now = 0;
  let mode: 'ok' | 'down' | 'auth' | 'garbage' = 'ok';
  const { f, calls } = fakeFetch((url) =>
    mode === 'ok' ? ok(url) : mode === 'down' ? new TypeError('fetch failed: connect ECONNREFUSED 100.64.0.2') : mode === 'auth' ? { status: 403, body: { error: 'not allowed' } } : { status: 200, body: '<html>' },
  );
  const c = new AgentsCollector({ targets: () => [{ name: 'desk', url: 'http://desk:8797' }], fetch: f, now: () => now, ttlMs: 1 });
  await c.get();
  mode = 'down';
  now = 10;
  let [a] = await c.get();
  assert.equal(a.ok, false);
  assert.equal(a.error, 'unreachable');
  assert.equal(a.failures, 1);
  assert.equal(a.nextAt, 10 + 15_000);
  assert.equal(a.lastOk, 0);
  assert.deepEqual(a.ports?.listening.map((p) => p.port), [3000, 5432], 'last good ports kept');
  const n = calls.length;
  now = 5_000;
  [a] = await c.get();
  assert.equal(calls.length, n, 'not asked while backing off');
  now = 20_000;
  [a] = await c.get();
  assert.equal(a.failures, 2);
  assert.equal(a.nextAt, 20_000 + 30_000, 'doubled');
  mode = 'auth';
  c.refresh();
  [a] = await c.get();
  assert.equal(a.error, 'auth');
  mode = 'garbage';
  c.refresh();
  [a] = await c.get();
  assert.equal(a.error, 'bad-answer');
  mode = 'ok';
  c.refresh();
  [a] = await c.get();
  assert.equal(a.ok, true);
  assert.equal(a.failures, 0);
  assert.equal(a.nextAt, null);
});

test('AgentsCollector: no agents listed → nothing fetched; a removed agent is forgotten', async () => {
  let targets = [{ name: 'a', url: 'http://a:1' }, { name: 'b', url: 'http://b:1' }];
  const { f, calls } = fakeFetch(ok);
  const c = new AgentsCollector({ targets: () => targets, fetch: f, ttlMs: 0 });
  assert.equal((await c.get()).length, 2);
  targets = [{ name: 'b', url: 'http://b:1' }];
  assert.deepEqual((await c.get()).map((x) => x.name), ['b']);
  targets = [];
  const before = calls.length;
  assert.deepEqual(await c.get(), []);
  assert.equal(calls.length, before);
});

// ---- devices ----

const status = JSON.stringify({
  Self: { HostName: 'devbox', DNSName: 'devbox.tail.ts.net.', OS: 'linux', TailscaleIPs: ['100.64.10.1'], Online: true },
  Peer: {
    a: { HostName: 'DESKTOP-PC', DNSName: 'desk.tail.ts.net.', OS: 'windows', Online: true, TailscaleIPs: ['100.64.10.2'] },
    b: { HostName: 'mac', DNSName: 'mac.tail.ts.net.', OS: 'macOS', Online: true, TailscaleIPs: ['100.64.10.3'] },
  },
});

const read = (over: Partial<AgentRead>): AgentRead => ({
  name: 'x', url: 'http://x:8797', ok: true, pending: false, error: null, checkedAt: 1, lastOk: 1, failures: 0, nextAt: null, info: null,
  ports: { at: 1_000, listening: [{ port: 3000, address: '0.0.0.0', process: 'node' }, { port: 5432, address: '127.0.0.1', process: 'db' }] },
  ...over,
});

const poolHost = (over: Partial<PoolHost>): PoolHost => ({ name: 'x', kind: 'agent', addresses: [], state: 'ok', inRotation: true, slots: 1, busy: 0, ...over });

test('attachAgents: by MagicDNS name, by Tailscale IP in the URL, by name; ahead of compute-pool; this server keeps its own', () => {
  const pool = [poolHost({ name: 'mac', addresses: ['100.64.10.3'], listening: [{ port: 22, address: '0.0.0.0' }], listeningAt: 5 })];
  const list = mergeDevices(parsePeers(status), pool, {});
  assert.equal(list.find((d) => d.id === 'mac')?.portsSource, 'compute-pool');
  const ids = attachAgents(list, [
    read({ name: 'workstation', info: { ...(INFO as any), dnsName: 'desk.tail.ts.net' } }),
    read({ name: 'laptop', url: 'http://100.64.10.3:8797' }),
    read({ name: 'devbox' }),
    read({ name: 'nas', ok: false, error: 'timeout' }),
  ]);
  assert.deepEqual(ids, ['desk', 'mac', 'devbox', 'agent:nas']);
  const desk = list.find((d) => d.id === 'desk')!;
  assert.equal(desk.portsSource, 'agent');
  assert.equal(desk.ports?.ports.find((p) => p.port === 3000)?.url, 'http://desk.tail.ts.net:3000');
  assert.equal(desk.ports?.ports.find((p) => p.port === 5432)?.scope, 'loopback');
  assert.equal(desk.agent?.ok, true);
  assert.ok(!('ports' in (desk.agent as object)), 'the device keeps the status, not the raw list');
  const mac = list.find((d) => d.id === 'mac')!;
  assert.equal(mac.portsSource, 'agent', 'preferred over compute-pool');
  assert.deepEqual(mac.ports?.ports.map((p) => p.port), [3000, 5432]);
  assert.ok(mac.pool, 'compute-pool status stays');
  const self = list.find((d) => d.self)!;
  assert.equal(self.ports, null, 'this server: the snapshot, not the agent');
  assert.equal(self.agent?.name, 'devbox');
  const nas = list.find((d) => d.id === 'agent:nas')!;
  assert.equal(nas.online, false);
  assert.equal(nas.agent?.error, 'timeout');
  assert.equal(nas.portsSource, 'agent', 'last good ports of an agent that is down');
  assert.equal(nas.ports?.ports.find((p) => p.port === 3000)?.url, null, 'no link without a tailnet name');
});

test('attachAgents then attachPvePorts: a device the agent covers keeps the agent ports', () => {
  const list = mergeDevices(parsePeers(status), [], {});
  attachAgents(list, [read({ name: 'desk' })]);
  attachPvePorts(list, { configured: false, ok: false, hosts: [] } as any, { at: 9, host: [{ port: 8006, address: '0.0.0.0' }], cts: {} }, 'desk');
  assert.equal(list.find((d) => d.id === 'desk')?.portsSource, 'agent');
});

// ---- site config ----

test('portboard.json agents and agent: valid entries kept, bad ones reported without the token', () => {
  const r = parseSiteFile(JSON.stringify({
    agents: [
      { name: 'desk', url: 'http://100.64.0.2:8797/', token: 'shh' },
      { name: 'mac', url: 'https://mac.tail.ts.net:8797' },
      { name: 'bad name', url: 'http://x' },
      { name: 'ftp', url: 'ftp://x' },
      { name: 'creds', url: 'http://u:p@x', token: 'zzz' },
      { name: 'DESK', url: 'http://y' },
    ],
    agent: { port: 9000, allow: ['board', ' ', 3], token: 't' },
  }));
  assert.deepEqual(r.file.agents, [{ name: 'desk', url: 'http://100.64.0.2:8797', token: 'shh' }, { name: 'mac', url: 'https://mac.tail.ts.net:8797' }]);
  assert.match(r.error ?? '', /agents\[/);
  assert.ok(!(r.error ?? '').includes('shh') && !(r.error ?? '').includes('zzz'));
  const site = resolveSite({ file: r.file });
  assert.equal(site.agents.length, 2);
  assert.deepEqual(site.agent, { port: 9000, allow: ['board'], token: 't', showAddresses: false });
  assert.equal(parseSiteFile(JSON.stringify({ agents: {} })).error?.includes('agents'), true);
  assert.deepEqual(resolveSite({}).agents, []);
  assert.deepEqual(agentServeConfig({ port: 'x', allow: 'board' }), { port: 8797, allow: [], token: null, showAddresses: false });
  assert.equal(typeof checkAgentTarget(null), 'string');
});
