import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  authorize,
  createAgentHandler,
  identityAllowed,
  identityResolver,
  parseIdentity,
  processName,
  projectPorts,
  tokenMatches,
  type AgentInfo,
  type AuthOptions,
  type Identity,
} from '../src/agent/server.ts';
import { STRICT } from '../src/remote/redact.ts';
import type { Snapshot } from '../src/core/index.ts';
import { assertClean, entry, snap as baseSnap, usage } from './fixtures/remote-redact.ts';

// #10: `portboard agent` serves one machine's ports, usage and load read-only; who may read is loopback, a bearer
// token or a Tailscale identity on the allowlist.

const TAILNET_PEER = '100.64.0.9';
const known: Record<string, Identity> = {
  [TAILNET_PEER]: { device: { addr: TAILNET_PEER, name: 'board', id: 'nBoard1CNTRL' }, login: 'owner@example.com' },
  '100.64.0.10': { device: { addr: '100.64.0.10', name: 'ci', id: 'nCi1CNTRL', tags: ['tag:portboard'] } },
  '100.64.0.11': { device: { addr: '100.64.0.11', name: 'phone', id: 'nPhone1CNTRL' }, login: 'friend@example.com' },
};
let whoisCalls: string[] = [];
const whois = async (addr: string): Promise<Identity> => {
  whoisCalls.push(addr);
  return known[addr] ?? { device: { addr } };
};
const opts = (over: Partial<AuthOptions> = {}): AuthOptions => ({ allow: ['board'], token: 's3cret-token', whois, ...over });
const req = (addr: string, headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress: addr } });

test('authorize: loopback reads unless a proxy header says it came through serve', async () => {
  assert.deepEqual(await authorize(req('127.0.0.1'), opts()), { ok: true, via: 'loopback', who: 'loopback' });
  const proxied = await authorize(req('127.0.0.1', { 'x-forwarded-for': TAILNET_PEER }), opts());
  assert.equal(proxied.ok, false);
  assert.equal((await authorize(req('127.0.0.1'), opts({ trustLoopback: false }))).ok, false);
});

test('authorize: a bearer token must match; a wrong one is 401 and never falls back to whois', async () => {
  whoisCalls = [];
  assert.equal((await authorize(req('192.0.2.1', { authorization: 'Bearer s3cret-token' }), opts())).ok, true);
  const bad = await authorize(req(TAILNET_PEER, { authorization: 'Bearer nope' }), opts());
  assert.deepEqual(bad, { ok: false, status: 401, error: 'bad token' });
  assert.deepEqual(whoisCalls, []);
  // no token configured: any presented token is wrong
  assert.equal((await authorize(req('192.0.2.1', { authorization: 'Bearer ' }), opts({ token: null }))).ok, false);
  assert.equal(tokenMatches('a', null), false);
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abc', 'abd'), false);
});

test('authorize: a tailnet caller reads when its node, login or tag is allowed', async () => {
  assert.deepEqual(await authorize(req(TAILNET_PEER), opts()), { ok: true, via: 'tailscale', who: 'board' });
  assert.deepEqual(await authorize(req(`::ffff:${TAILNET_PEER}`), opts()), { ok: true, via: 'tailscale', who: 'board' });
  assert.equal((await authorize(req('100.64.0.11'), opts())).ok, false);
  assert.equal((await authorize(req('100.64.0.11'), opts({ allow: ['friend@example.com'] }))).ok, true);
  assert.equal((await authorize(req('100.64.0.10'), opts({ allow: ['tag:portboard'] }))).ok, true);
  assert.equal((await authorize(req(TAILNET_PEER), opts({ allow: ['nBoard1CNTRL'] }))).ok, true);
  assert.equal((await authorize(req(TAILNET_PEER), opts({ allow: ['board.tail0000.ts.net'] }))).ok, true);
  // outside the tailnet ranges: never looked up, refused
  whoisCalls = [];
  assert.deepEqual(await authorize(req('192.168.1.5'), opts({ allow: ['board'] })), { ok: false, status: 403, error: 'not allowed' });
  assert.deepEqual(whoisCalls, []);
  // nothing allowed: only loopback and the token
  assert.equal((await authorize(req(TAILNET_PEER), opts({ allow: [] }))).ok, false);
});

test('identityAllowed and parseIdentity: a tagged node has no login to match', () => {
  const json = JSON.stringify({ Node: { Name: 'ci.tail0000.ts.net.', ComputedName: 'ci', StableID: 'nCi', Tags: ['tag:ci'] }, UserProfile: { LoginName: 'tagged-devices' } });
  assert.deepEqual(parseIdentity(json, '100.64.0.10'), { device: { addr: '100.64.0.10', name: 'ci', id: 'nCi', tags: ['tag:ci'] } });
  const user = JSON.stringify({ Node: { Name: 'mac.tail0000.ts.net.', StableID: 'nMac' }, UserProfile: { LoginName: 'Owner@Example.com' } });
  const who = parseIdentity(user, TAILNET_PEER);
  assert.equal(who.login, 'Owner@Example.com');
  assert.ok(identityAllowed(who, ['owner@example.com']));
  assert.ok(identityAllowed(who, ['MAC']));
  assert.ok(!identityAllowed(who, ['tag:ci', 'other@example.com']));
  assert.deepEqual(parseIdentity('not json', '1.2.3.4'), { device: { addr: '1.2.3.4' } });
});

test('identityResolver: whois per tailnet address, cached; other addresses never run it', async () => {
  const runs: string[][] = [];
  const resolve = identityResolver({
    run: async (args) => {
      runs.push(args);
      return { ok: true, code: 0, stdout: JSON.stringify({ Node: { Name: 'board.ts.net.', StableID: 'nB' }, UserProfile: { LoginName: 'o@example.com' } }), stderr: '' } as any;
    },
  });
  assert.equal((await resolve(TAILNET_PEER)).device.name, 'board');
  await resolve(TAILNET_PEER);
  await resolve('192.168.0.1');
  assert.deepEqual(runs, [['whois', '--json', TAILNET_PEER]]);
});

// ---- projection ----

const snap: Snapshot = {
  ...baseSnap,
  ports: [
    ...baseSnap.ports,
    entry({ port: 5432, scope: 'other', addresses: ['192.168.50.5', '127.0.0.1'], container: 'db', name: 'postgres' }),
    entry({ port: 22, scope: 'all', addresses: ['0.0.0.0', '::'], owned: false, kind: 'system', processes: [], systemOwner: 'sshd' } as any),
    entry({ port: 9999, listening: false, addresses: [] }),
  ],
};

test('processName: container, unit, the command without path or arguments, the system owner', () => {
  assert.equal(processName({ container: 'db', processes: [], systemOwner: null }), 'db');
  assert.equal(processName({ container: null, processes: [{ pid: 1, cmdline: '/usr/bin/node /home/a/x.js --token=1', cwd: null, project: null, unit: null, unitDescription: null }], systemOwner: null }), 'node');
  assert.equal(processName({ container: null, processes: [{ pid: 1, cmdline: 'x', cwd: null, project: null, unit: 'acme.service', unitDescription: null }], systemOwner: null }), 'acme');
  assert.equal(processName({ container: null, processes: [], systemOwner: 'sshd' }), 'sshd');
});

test('projectPorts: one row per bind address, LAN addresses scrubbed, no pids, command lines or paths', () => {
  const out = projectPorts(snap, STRICT);
  assert.equal(out.schema, 1);
  assert.equal(out.at, Date.parse(baseSnap.at));
  const rows = (port: number) => out.listening.filter((l) => l.port === port);
  assert.deepEqual(rows(3080), [{ port: 3080, address: '100.101.102.103', process: 'node' }]);
  assert.deepEqual(rows(5432), [{ port: 5432, address: '[lan-ip]', process: 'db' }, { port: 5432, address: '127.0.0.1', process: 'db' }]);
  assert.deepEqual(rows(22).map((r) => r.address), ['0.0.0.0', '::']);
  assert.deepEqual(rows(9999), []);
  const text = JSON.stringify(out);
  for (const leak of ['4242', '--token', 'server.js', '/home/', 'alice@', '192.168.50.5', 'ssh -N']) assert.ok(!text.includes(leak), leak);
  // the services list is the remote connector's projection, as clean as list_ports
  assertClean('services', out.services);
  assert.ok(out.services.some((s) => s.port === 22), 'system ports included');
  // showAddresses keeps the LAN address
  assert.ok(projectPorts(snap, { showAddresses: true, showProcesses: false }).listening.some((l) => l.address === '192.168.50.5'));
});

// ---- HTTP ----

const info: AgentInfo = { schema: 1, version: '9.9.9', host: 'box', dnsName: 'box.tail0000.ts.net', at: 1, load: { cores: 4, load1: 0.5, memTotalMb: 8000, memAvailMb: 4000, diskFreePct: 50, uptimeSec: 100 } };

async function agentServer(over: Partial<AuthOptions> = {}): Promise<{ server: Server; port: number }> {
  const handler = createAgentHandler({
    sources: { snapshot: async () => snap, usage: async () => usage, info: async () => info },
    auth: opts({ trustLoopback: false, ...over }),
    policy: STRICT,
    hosts: new Set(['127.0.0.1', 'localhost']),
    log: () => {},
  });
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port };
}

function call(port: number, path: string, o: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...o.headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }));
    });
    r.on('error', reject);
    r.end();
  });
}

test('agent HTTP: GET only, behind auth and the Host check; info, ports and usage', async (t) => {
  const { server, port } = await agentServer();
  t.after(() => server.close());
  const auth = { authorization: 'Bearer s3cret-token' };
  assert.equal((await call(port, '/agent/v1/info')).status, 403);
  assert.equal((await call(port, '/agent/v1/info', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await call(port, '/agent/v1/info', { headers: { ...auth, host: 'evil.example' } })).status, 421);
  assert.equal((await call(port, '/agent/v1/ports', { method: 'POST', headers: auth })).status, 405);
  assert.equal((await call(port, '/agent/v1/stop', { headers: auth })).status, 404);
  const i = await call(port, '/agent/v1/info', { headers: auth });
  assert.equal(i.status, 200);
  assert.equal(i.body.version, '9.9.9');
  const p = await call(port, '/agent/v1/ports/', { headers: auth });
  assert.equal(p.status, 200);
  assert.ok(p.body.listening.some((l: any) => l.port === 3080));
  const u = await call(port, '/agent/v1/usage', { headers: auth });
  assert.equal(u.status, 200);
  assert.equal(u.body.schema, 1);
  assertClean('usage', u.body);
});

test('agent HTTP: a source that throws is a generic 500, its message stays in the log', async (t) => {
  const lines: string[] = [];
  const handler = createAgentHandler({
    sources: { snapshot: async () => { throw new Error('ss failed at /home/alice'); }, usage: async () => usage, info: async () => info },
    auth: opts(),
    policy: STRICT,
    hosts: null,
    log: (l) => lines.push(l),
  });
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const r = await call((server.address() as AddressInfo).port, '/agent/v1/ports');
  assert.deepEqual(r, { status: 500, body: { error: 'internal error' } });
  assert.match(lines[0], /ss failed/);
});
