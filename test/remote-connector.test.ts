// 원격 커넥터 관리 (#31): listing the remote MCP's clients and authorizations without any secret, revoking one
// authorization or a client from the dashboard, and the running remote server refusing a revoked token at once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientRef, connectorView } from '../src/remote/admin.ts';
import { createRemoteHandler } from '../src/remote/http.ts';
import { sha256, Store, TOUCH_EVERY_MS } from '../src/remote/store.ts';
import type { RemoteCore } from '../src/remote/tools.ts';
import { createRouter } from '../src/features/router.ts';
import { FEATURES, REGISTRY } from '../src/features/registry.ts';
import { L } from './fixtures/locale.ts';

const core: RemoteCore = {
  snapshot: async () => ({ at: 'now', host: { hostname: 'box', user: 'me' }, tailscale: { available: false } as any, ports: [] }) as any,
  devices: async () => ({ at: 'now', pool: { available: false } as any, devices: [], proxmox: { configured: false, ok: false, hosts: [] } }),
  freePorts: async () => [3000],
  usage: async () => ({ at: 'now', cards: [], local: { connections: 0, uses: [] }, byPort: {}, idleServices: 0 }) as any,
};

let dir: string;
let file: string;
let server: Server;
let base: string;
/** The remote server's store; the dashboard routes open their own on the same file, like the two processes do. */
let remoteStore: Store;
const route = createRouter(REGISTRY.routes);
const ctx = () => ({ paths: { profile: 'preview', remoteConfig: file } }) as any;

async function dash(method: 'GET' | 'POST', path: string, guard = true) {
  const req = { method, headers: guard ? { 'x-portboard': '1' } : {} } as any;
  const r = await route(req, new URL(`http://dash${path}`), ctx());
  assert.ok(r, `${method} ${path} is a route`);
  return r as { status: number; body: any };
}

async function mcp(token: string) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function refresh(clientId: string, token: string) {
  const res = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId }),
  });
  return { status: res.status, body: await res.json() };
}

/** Everything that must never leave remote.json through the dashboard */
async function secretsIn(path: string, extra: string[]): Promise<string[]> {
  const s = JSON.parse(await readFile(path, 'utf8'));
  return [
    ...extra,
    ...Object.keys(s.tokens),
    ...Object.values<any>(s.tokens).map((t) => t.family).filter(Boolean),
    ...Object.keys(s.clients),
    ...Object.values<any>(s.tokens).map((t) => t.clientId),
    ...(s.approval ? [s.approval.hash] : []),
  ];
}

function assertClean(body: unknown, secrets: string[]) {
  const text = JSON.stringify(body);
  for (const v of secrets) assert.ok(!text.includes(v), `response leaks ${v.slice(0, 12)}…`);
  assert.doesNotMatch(text, /[0-9a-f]{32,}/, 'no long hex (token hashes)');
  assert.doesNotMatch(text, /[A-Za-z0-9_-]{40,}/, 'no long base64url (tokens)');
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'portboard-rc-'));
  file = join(dir, 'remote.json');
  remoteStore = new Store(file);
  server = createServer(createRemoteHandler({ core, store: remoteStore, hosts: new Set(['127.0.0.1']), log: () => {} }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('registry (#31): remote-connector (then access and the 설정 tab), its routes (the POSTs guarded writes) and a 설정 page script, nothing remote', () => {
  const names = FEATURES.map((f) => f.name);
  assert.deepEqual(names.slice(-4), ['remote-connector', 'access', 'write-devices', 'settings']);
  const f = FEATURES.find((x) => x.name === 'remote-connector')!;
  assert.deepEqual(f.routes!.map((r) => `${r.method} ${r.path}`), ['GET /api/remote/clients', 'POST /api/remote/clients/:device/revoke', 'POST /api/remote/tokens/:device/revoke', 'POST /api/remote/approval-code']);
  assert.ok(f.routes!.filter((r) => r.method === 'POST').every((r) => r.write === true));
  assert.equal(f.tools, undefined);
  assert.equal(f.remoteTools, undefined);
  assert.equal(f.remoteResources, undefined);
  assert.equal(f.jobs, undefined);
  // moved from the 기기 tab to the 설정 tab
  assert.deepEqual(f.ui, [{ pages: ['#settings'], script: 'features/remote-connector.js' }]);
});

test('connectorView: registered and hosted clients, one row per authorization, rotated and expired tokens left out', () => {
  const now = 1_000_000_000_000;
  const tok = (o: object) => ({ clientName: 'x', resource: 'https://box.example:8443/mcp', scope: 'portboard:read', createdAt: now - 5000, ...o });
  const view = connectorView(
    {
      clients: { pb_reg: { name: 'Claude Code', redirectUris: ['http://127.0.0.1:33418/callback'], createdAt: now - 9000, lastUsedAt: now - 9000 } },
      approval: { hash: 'ab'.repeat(32), expiresAt: now + 60_000, failures: 0 },
      tokens: {
        a1: tok({ kind: 'access', clientId: 'pb_reg', clientName: 'Claude Code', family: 'F1', expiresAt: now + 3600_000, lastUsedAt: now - 1000 }),
        r1: tok({ kind: 'refresh', clientId: 'pb_reg', clientName: 'Claude Code', family: 'F1', expiresAt: now + 30 * 86400_000 }),
        u1: tok({ kind: 'used', clientId: 'pb_reg', clientName: 'Claude Code', family: 'F1', expiresAt: now + 29 * 86400_000, usedAt: now - 500, createdAt: now - 86400_000 }),
        r2: tok({ kind: 'refresh', clientId: 'https://claude.ai/oauth/claude', clientName: 'Claude', family: 'F2', expiresAt: now + 20 * 86400_000 }),
        // a dead family (only a rotated token left) and an expired one: not shown
        u3: tok({ kind: 'used', clientId: 'https://claude.ai/oauth/claude', clientName: 'Claude', family: 'F3', expiresAt: now + 86400_000 }),
        x4: tok({ kind: 'access', clientId: 'https://chatgpt.com/oauth/x', clientName: 'ChatGPT', family: 'F4', expiresAt: now - 1 }),
      },
    },
    now,
  );
  assert.equal(view.pendingApproval, true);
  assert.equal(view.publicUrl, false);
  assert.deepEqual(view.grants.map((g) => [g.clientName, g.lastUsedAt, g.expiresAt, g.accessExpiresAt, g.createdAt, g.resourceHost, g.scopes]), [
    ['Claude Code', now - 500, now + 30 * 86400_000, now + 3600_000, now - 86400_000, 'box.example:8443', ['portboard:read']],
    ['Claude', null, now + 20 * 86400_000, null, now - 5000, 'box.example:8443', ['portboard:read']],
  ]);
  assert.deepEqual(view.clients.map((c) => [c.name, c.kind, c.redirectHosts, c.grants]), [
    ['Claude Code', 'registered', ['127.0.0.1:33418'], 1],
    ['Claude', 'hosted', ['claude.ai'], 1],
  ]);
  assert.equal(view.clients[0].lastUsedAt, now - 500, 'a refresh counts as a use');
  assert.equal(view.grants[0].clientId, clientRef('pb_reg'));
  assertClean(view, ['pb_reg', 'https://claude.ai/oauth/claude', 'F1', 'F2', 'a1', 'r1', 'ab'.repeat(32)].filter((s) => s.length > 2));
});

test('dashboard → remote server: list without secrets, revoke one authorization, the remote server answers 401 at once', async () => {
  const resource = `${base}/mcp`;
  const regId = await remoteStore.registerClient('Claude Code', ['http://127.0.0.1:5555/cb']);
  const a = await remoteStore.issueTokens({ id: regId, name: 'Claude Code' }, resource, 'portboard:read');
  const b = await remoteStore.issueTokens({ id: regId, name: 'Claude Code' }, resource, 'portboard:read');
  const hosted = 'https://claude.ai/oauth/claude-client';
  const c = await remoteStore.issueTokens({ id: hosted, name: 'Claude' }, resource, 'portboard:read');
  const { code } = await remoteStore.newApprovalCode();

  assert.equal((await mcp(a.access)).status, 200);
  assert.equal((await mcp(b.access)).status, 200);
  assert.equal((await mcp(c.access)).status, 200);

  const list = await dash('GET', '/api/remote/clients');
  assert.equal(list.status, 200);
  assert.equal(list.body.profile, 'preview');
  assert.equal(list.body.pendingApproval, true);
  assert.equal(list.body.clients.length, 2);
  assert.equal(list.body.grants.length, 3);
  assert.ok(list.body.grants.every((g: any) => g.lastUsedAt !== null), 'the first /mcp call records last used');
  assertClean(list.body, await secretsIn(file, [a.access, a.refresh, b.access, b.refresh, c.access, c.refresh, code, code.replace('-', ''), sha256(a.access)]));

  // Writes go through the router's guard like every other write.
  const reg = list.body.clients.find((x: any) => x.kind === 'registered');
  const anyGrant = list.body.grants.find((g: any) => g.clientId === reg.id);
  assert.equal((await dash('POST', `/api/remote/tokens/${anyGrant.id}/revoke`, false)).status, 403);
  assert.equal((await dash('POST', `/api/remote/clients/${reg.id}/revoke`, false)).status, 403);
  assert.equal((await mcp(a.access)).status, 200, 'nothing revoked without the guard');

  // The list never says which token belongs to which row (that would take a token-derived value), so revoke one of
  // the registered client's two authorizations and check that exactly one of a, b stops working.
  const before = await dash('GET', '/api/remote/clients');
  const ids = before.body.grants.filter((g: any) => g.clientId === reg.id).map((g: any) => g.id);
  assert.equal(ids.length, 2);
  const r = await dash('POST', `/api/remote/tokens/${ids[0]}/revoke`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { revoked: { tokens: 2 } }, 'its access and refresh token');
  assertClean(r.body, await secretsIn(file, [a.access, b.access]));
  const results = [await mcp(a.access), await mcp(b.access)];
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 401], 'exactly one of the two authorizations is cut off');
  const [gone, kept] = results[0].status === 401 ? [a, b] : [b, a];
  assert.equal((await mcp(gone.access)).body.error, 'invalid_token');
  assert.equal((await mcp(kept.access)).status, 200);
  assert.equal((await mcp(c.access)).status, 200, 'other clients untouched');
  const re = await refresh(regId, gone.refresh);
  assert.equal(re.status, 400);
  assert.equal(re.body.error, 'invalid_grant', 'its refresh token is gone too');
  assert.equal((await dash('GET', '/api/remote/clients')).body.pendingApproval, true, 'a token revoke keeps the pending approval code');
  assert.equal(await remoteStore.consumeApprovalCode(code), 'ok');

  // A whole client: its registration and every token.
  const cr = await dash('POST', `/api/remote/clients/${reg.id}/revoke`);
  assert.equal(cr.status, 200);
  assert.deepEqual(cr.body, { revoked: { tokens: 2, registration: true } });
  assert.equal((await mcp(kept.access)).status, 401);
  const s = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(!Object.hasOwn(s.clients, regId), 'registration deleted');

  // A hosted (CIMD) client has no registration; its tokens go.
  const hostedRef = clientRef(hosted);
  assert.deepEqual((await dash('POST', `/api/remote/clients/${hostedRef}/revoke`)).body, { revoked: { tokens: 2, registration: false } });
  assert.equal((await mcp(c.access)).status, 401);

  const after = await dash('GET', '/api/remote/clients');
  assert.deepEqual([after.body.clients.length, after.body.grants.length], [0, 0]);
});

test('revoke: unknown or malformed ids change nothing', async () => {
  const resource = `${base}/mcp`;
  const t = await remoteStore.issueTokens({ id: 'pb_keep', name: 'keep' }, resource, 'portboard:read');
  const before = await readFile(file, 'utf8');
  assert.equal((await dash('POST', '/api/remote/tokens/g-0000000000000000/revoke')).status, 404);
  assert.equal((await dash('POST', '/api/remote/clients/c-0000000000000000/revoke')).status, 404);
  // A raw client_id or token is not an id the routes accept (and the path pattern refuses most of them).
  assert.equal((await dash('POST', '/api/remote/clients/pb-keep/revoke')).status, 404);
  assert.equal(await route({ method: 'POST', headers: { 'x-portboard': '1' } } as any, new URL('http://dash/api/remote/clients/pb_keep/revoke'), ctx()), null);
  assert.equal(await route({ method: 'POST', headers: { 'x-portboard': '1' } } as any, new URL('http://dash/api/remote/tokens/a.b/revoke'), ctx()), null);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal((await mcp(t.access)).status, 200);
});

test('last used is written at most once a minute per token', async () => {
  let now = 2_000_000_000_000;
  const p = join(dir, 'touch.json');
  const s = new Store(p, () => now);
  const t = await s.issueTokens({ id: 'pb_t', name: 't' }, 'http://x/mcp', 'portboard:read');
  assert.ok(await s.verifyAccessToken(t.access));
  const first = JSON.parse(await readFile(p, 'utf8')).tokens[sha256(t.access)].lastUsedAt;
  assert.equal(first, now);
  const m1 = (await stat(p)).mtimeMs;
  now += TOUCH_EVERY_MS - 1;
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(await s.verifyAccessToken(t.access));
  assert.equal((await stat(p)).mtimeMs, m1, 'no write within the minute');
  now += 1;
  assert.ok(await s.verifyAccessToken(t.access));
  assert.equal(JSON.parse(await readFile(p, 'utf8')).tokens[sha256(t.access)].lastUsedAt, now);
});

test('a revoke that lands between the read and the last-used write is not undone', async () => {
  const p = join(dir, 'race.json');
  const s = new Store(p);
  const t = await s.issueTokens({ id: 'pb_r', name: 'r' }, 'http://x/mcp', 'portboard:read');
  const other = new Store(p);
  // Whichever takes the file lock first, the token stays revoked: the touch only updates a record that still exists.
  await Promise.all([s.verifyAccessToken(t.access), other.revokeMatching(() => true)]);
  const state = JSON.parse(await readFile(p, 'utf8'));
  assert.deepEqual(state.tokens, {}, 'still revoked');
  assert.equal(await s.verifyAccessToken(t.access), null);
});

test('GET /api/remote/clients on an unreadable remote.json says so without the file content', async () => {
  const saved = file;
  file = join(dir, 'broken.json');
  await writeFile(file, '{"tokens": {"deadbeef": ');
  try {
    const r = await dash('GET', '/api/remote/clients');
    assert.equal(r.status, 500);
    assert.match(r.body.error, L(/remote\.json을 읽을 수 없어요/, /Can't read remote\.json/));
    assert.ok(!JSON.stringify(r.body).includes('deadbeef'));
  } finally {
    file = saved;
  }
});
