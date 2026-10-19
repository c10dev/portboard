// 소유자 전용 쓰기 (#29) and 기록 (#30): who may write (a table of callers), the audit log (append, rotate, query, what
// a line may hold), and the dashboard's router wiring both into every write route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { classify, decodeHeader, localOnly, ownerFromStatus, ownerLogin, MCP_CALLER, type Caller, type Device, type WriteDevices } from '../src/core/access.ts';
import { AuditLog, clean, targetOf, whoOf, type AuditEntry } from '../src/core/audit.ts';
import { appRouter } from '../src/features/router.ts';
import { REGISTRY, FEATURES } from '../src/features/registry.ts';
import { resolvePaths } from '../src/core/paths.ts';
import { callTool } from '../src/mcp/tools.ts';
import type { Route } from '../src/features/types.ts';
import type { ServerContext } from '../src/features/context.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OWNER = 'owner@example.com';
const tmp = () => mkdtempSync(join(tmpdir(), 'pb-access-'));

const SERVE = { 'x-forwarded-for': '100.101.102.103', 'x-forwarded-host': 'devbox.example.ts.net', 'x-forwarded-proto': 'https' };
const req = (remoteAddress: string | undefined, headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress } });

// ---- who may write ----

const CASES: { name: string; r: ReturnType<typeof req>; owner?: string | null; source: Caller['source']; canWrite: boolean; login?: string | null }[] = [
  { name: 'serve, the owner', r: req('127.0.0.1', { ...SERVE, 'tailscale-user-login': OWNER, 'tailscale-user-name': 'Dev', 'tailscale-headers-info': 'https://tailscale.com/s/serve-headers' }), source: 'serve', canWrite: true, login: OWNER },
  { name: 'serve, the owner in other letter case', r: req('127.0.0.1', { ...SERVE, 'tailscale-user-login': ' Owner@example.com ' }), source: 'serve', canWrite: true },
  { name: 'serve, another user (shared node)', r: req('127.0.0.1', { ...SERVE, 'tailscale-user-login': 'guest@example.com' }), source: 'serve', canWrite: false, login: 'guest@example.com' },
  { name: 'serve, a tagged node (no user headers)', r: req('127.0.0.1', SERVE), source: 'serve', canWrite: false, login: null },
  { name: 'serve over IPv6 loopback, the owner', r: req('::1', { ...SERVE, 'tailscale-user-login': OWNER }), source: 'serve', canWrite: true },
  { name: 'serve, owner login but the owner is unknown', r: req('127.0.0.1', { ...SERVE, 'tailscale-user-login': OWNER }), owner: null, source: 'serve', canWrite: false },
  { name: 'funnel (public), even with an owner login', r: req('127.0.0.1', { ...SERVE, 'tailscale-funnel-request': '?1', 'tailscale-user-login': OWNER }), source: 'serve', canWrite: false },
  { name: 'loopback hook (plugin, scripts, curl)', r: req('127.0.0.1', { 'content-type': 'application/json', 'x-portboard': '1' }), source: 'loopback', canWrite: true, login: null },
  { name: 'loopback, IPv4-mapped', r: req('::ffff:127.0.0.1'), source: 'loopback', canWrite: true },
  { name: 'loopback with only a spoofed login (counts as proxied: other user)', r: req('127.0.0.1', { 'tailscale-user-login': 'guest@example.com' }), source: 'serve', canWrite: false },
  { name: 'direct tailnet IP', r: req('100.64.0.9'), source: 'direct', canWrite: false, login: null },
  { name: 'direct tailnet IP, spoofed owner login', r: req('100.64.0.9', { ...SERVE, 'tailscale-user-login': OWNER }), source: 'direct', canWrite: false, login: null },
  { name: 'direct tailnet IPv6', r: req('fd7a:115c:a1e0::1'), source: 'direct', canWrite: false },
  { name: 'no socket address', r: req(undefined), source: 'direct', canWrite: false },
  // L5 (security review v1.0): other proxies' client-address headers are proxy markers too
  { name: 'loopback + X-Real-IP (an nginx-style local proxy)', r: req('127.0.0.1', { 'x-real-ip': '192.168.1.50' }), source: 'serve', canWrite: false, login: null },
  { name: 'loopback + Via', r: req('127.0.0.1', { via: '1.1 caddy' }), source: 'serve', canWrite: false },
  { name: 'loopback + X-Real-IP + Via', r: req('127.0.0.1', { 'x-real-ip': '10.0.0.2', via: '1.1 nginx' }), source: 'serve', canWrite: false },
  { name: 'loopback + True-Client-IP', r: req('127.0.0.1', { 'true-client-ip': '203.0.113.9' }), source: 'serve', canWrite: false },
  { name: 'loopback + CF-Connecting-IP', r: req('::1', { 'cf-connecting-ip': '203.0.113.9' }), source: 'serve', canWrite: false },
];

test('classify: who may write, case by case', () => {
  for (const c of CASES) {
    const got = classify(c.r, c.owner === undefined ? OWNER : c.owner);
    assert.equal(got.source, c.source, c.name);
    assert.equal(got.canWrite, c.canWrite, c.name);
    assert.equal(got.owner, c.canWrite, `${c.name}: owner and canWrite go together`);
    if (c.login !== undefined) assert.equal(got.login, c.login, c.name);
    if (!got.canWrite) assert.match(got.reason ?? '', /[가-힣]/, `${c.name}: a Korean reason`);
  }
});

test('localOnly: loopback without any proxy marker', () => {
  assert.equal(localOnly(req('127.0.0.1')), true);
  for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'tailscale-user-login', 'tailscale-user-name', 'tailscale-headers-info', 'tailscale-funnel-request', 'x-real-ip', 'via', 'true-client-ip', 'cf-connecting-ip', 'x-client-ip', 'x-cluster-client-ip', 'fastly-client-ip', 'x-original-forwarded-for']) {
    assert.equal(localOnly(req('127.0.0.1', { [h]: 'x' })), false, h);
  }
  assert.equal(localOnly(req('100.64.0.9')), false);
});

test('decodeHeader: tailscaled encodes non-ASCII values as RFC 2047 q-words', () => {
  assert.equal(decodeHeader('=?utf-8?q?=EC=B1=84_=ED=98=84?='), '채 현');
  assert.equal(decodeHeader('plain@example.com'), 'plain@example.com');
});

test('owner: Self.UserID → LoginName; a tagged server has none; PORTBOARD_OWNER_LOGIN wins', async () => {
  const status = (self: object) => JSON.stringify({ Self: self, User: { '42': { LoginName: OWNER }, '7': { LoginName: 'tagged-devices' } } });
  assert.equal(ownerFromStatus(status({ UserID: 42 })), OWNER);
  assert.equal(ownerFromStatus(status({ UserID: 42, Tags: ['tag:server'] })), null);
  assert.equal(ownerFromStatus(status({ UserID: 7 })), null, 'the tagged-devices pseudo-user is nobody');
  assert.equal(ownerFromStatus('not json'), null);
  assert.equal(await ownerLogin({ PORTBOARD_OWNER_LOGIN: ' me@example.com ' }), 'me@example.com');
});

// ---- the audit log ----

test('targetOf: route params and allowlisted identifiers; free text only as a field name', () => {
  assert.deepEqual(targetOf({ port: 8080, device: '' }, { label: 'my secret label', pinned: true }), { port: 8080, pinned: true, fields: ['label'] });
  assert.deepEqual(targetOf({ port: NaN, device: 'mac' }, { on: false }), { device: 'mac', on: false });
  assert.deepEqual(targetOf(null, { session_id: 'abcdefgh-1', cwd: '/home/x', reason: 'exit', transcript_path: '/t' }), { session: 'abcdefgh-1', fields: ['cwd', 'reason', 'transcript_path'] });
  assert.deepEqual(targetOf(null, { owner: 'pb', port: '4100', note: 'n' }), { owner: 'pb', port: 4100, fields: ['note'] });
  const paths = Array.from({ length: 25 }, (_, i) => `/w/${i}`);
  const t = targetOf(null, { repo: '/r', paths, ports: [1, 2, 'x', 70000] });
  assert.equal((t.paths as string[]).length, 20);
  assert.equal(t.pathsCount, 25);
  assert.deepEqual(t.ports, [1, 2]);
  assert.equal(targetOf(null, { path: 'a\nb\u0000c' }).path, 'a b c', 'no control characters in a line');
  assert.deepEqual(targetOf(null, 'raw string body'), {});
});

test('whoOf: login, "local", or the direct address', () => {
  assert.equal(whoOf(classify(req('127.0.0.1'), OWNER)), 'local');
  assert.equal(whoOf(MCP_CALLER), 'local');
  assert.equal(whoOf(classify(req('100.64.0.9'), OWNER)), '100.64.0.9');
  assert.equal(whoOf(classify(req('127.0.0.1', { ...SERVE, 'tailscale-user-login': 'a@b.c\r\nX: y' }), OWNER)), 'a@b.c  X: y');
  assert.equal(clean('x'.repeat(500)).length, 300);
});

const entry = (i: number, port?: number, extra: Partial<AuditEntry> = {}): AuditEntry => ({
  at: new Date(1_700_000_000_000 + i * 1000).toISOString(),
  who: 'local',
  source: 'loopback',
  route: 'POST /api/ports/:port/restart',
  target: port ? { port } : {},
  result: 'ok',
  status: 200,
  ...extra,
});

test('AuditLog: appends JSON lines, newest first, filters by port and limit', async () => {
  const log = new AuditLog(join(tmp(), 'state', 'audit.jsonl'));
  assert.deepEqual(await log.query(), [], 'no file yet');
  for (let i = 0; i < 6; i++) await log.append(entry(i, i % 2 ? 3000 : 4000));
  await log.append(entry(6, undefined, { route: 'POST /api/cleanup', target: { ports: [5000, 3000] } }));
  const all = await log.query();
  assert.equal(all.length, 7);
  assert.equal(all[0].route, 'POST /api/cleanup', 'newest first');
  assert.deepEqual((await log.query({ port: 3000 })).map((e) => e.at.slice(17, 19)), ['26', '25', '23', '21'], 'by target.port and in target.ports');
  assert.equal((await log.query({ limit: 2 })).length, 2);
  assert.equal(statSync(log.path).mode & 0o777, 0o600);
  assert.ok(readFileSync(log.path, 'utf8').split('\n').filter(Boolean).every((l) => JSON.parse(l).at));
});

test('AuditLog: rotates past maxBytes to .1 (one generation kept) and still reads across both', async () => {
  const log = new AuditLog(join(tmp(), 'audit.jsonl'), 600);
  for (let i = 0; i < 20; i++) await log.append(entry(i, 4000 + i));
  assert.ok(existsSync(`${log.path}.1`));
  assert.ok(statSync(log.path).size <= 600 && statSync(`${log.path}.1`).size <= 600, 'both files stay bounded');
  const got = await log.query({ limit: 100 });
  assert.equal(got[0].target.port, 4019);
  assert.ok(got.length < 20 && got.length >= 4, `older generations are dropped (${got.length} kept)`);
  for (let i = 1; i < got.length; i++) assert.ok(got[i - 1].at > got[i].at, 'newest first across the two files');
  assert.equal((await log.query({ port: 4018 }))[0].target.port, 4018);
});

test('paths: audit.jsonl in the profile state dir, PORTBOARD_AUDIT overrides', () => {
  assert.equal(resolvePaths({}, '/home/x').audit, '/home/x/.local/state/portboard/audit.jsonl');
  assert.equal(resolvePaths({ PORTBOARD_PORT: '8808' }, '/home/x').audit, '/home/x/.local/state/portboard/previews/8808/audit.jsonl');
  assert.equal(resolvePaths({ PORTBOARD_STATE_DIR: '/s' }, '/home/x').audit, '/s/audit.jsonl');
  assert.equal(resolvePaths({ PORTBOARD_AUDIT: '/a.jsonl' }, '/home/x').audit, '/a.jsonl');
});

// ---- the dashboard router: owner check + audit on every write ----

function request(method: string, remoteAddress: string, headers: Record<string, string> = {}, body?: string) {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as any;
  r.method = method;
  r.headers = headers;
  r.socket = { remoteAddress };
  return r;
}

/** The fake tailnet: the serve fixture's XFF address is the owner's MacBook, 100.64.0.9 a server. */
const DEVICES: Record<string, Device> = {
  '100.101.102.103': { addr: '100.101.102.103', name: 'dev-mac', id: 'nMacStable1CNTRL' },
  '100.64.0.9': { addr: '100.64.0.9', name: 'docker-vm', id: 'nDockerStbl1CNTRL' },
};

function context(dir = tmp(), allow: WriteDevices | null = null) {
  const audit = new AuditLog(join(dir, 'audit.jsonl'));
  // Anything but owner/device/writeDevices/audit throws: a denied write never reaches its handler.
  const fake = { owner: async () => OWNER, device: async (addr: string) => DEVICES[addr] ?? { addr }, writeDevices: async () => allow, audit };
  const ctx = new Proxy(fake as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : assert.fail(`handler touched ctx.${String(k)}`)),
  }) as unknown as ServerContext;
  return { ctx, audit };
}

const concrete = (path: string) => path.replace(':port', '8080').replace(':device', 'mac');

test('appRouter: every write route in the registry refuses a non-owner before its handler, and records it', async () => {
  const writes = REGISTRY.routes.filter((r) => r.method !== 'GET');
  const { ctx, audit } = context();
  const route = appRouter(REGISTRY.routes, ctx);
  const denied = [
    request('POST', '100.64.0.9', { 'x-portboard': '1', 'tailscale-user-login': OWNER }),
    request('POST', '127.0.0.1', { 'x-portboard': '1', ...SERVE, 'tailscale-user-login': 'guest@example.com' }),
    request('POST', '127.0.0.1', { 'x-portboard': '1', ...SERVE }),
  ];
  for (const r of writes) {
    for (const make of denied) {
      const q = request(make.method, make.socket.remoteAddress, make.headers, '{"label":"x"}');
      const out = await route(q, new URL(`http://x${concrete(r.path)}`), ctx);
      assert.equal(out?.status, 403, `${r.method} ${r.path}`);
      assert.equal((out?.body as { error: string }).error, 'owner only');
    }
  }
  const log = await audit.query({ limit: 1000 });
  assert.equal(log.length, writes.length * denied.length, 'one denied line per attempt');
  assert.ok(log.every((e) => e.result === 'denied' && e.status === 403));
  assert.ok(log.every((e) => !('fields' in e.target)), 'a denied body is never read');
  assert.deepEqual(new Set(log.map((e) => e.who)), new Set(['100.64.0.9', 'guest@example.com', '(사용자 없음)']));
});

test('appRouter: owner via serve and a local hook write; missing X-Portboard is denied and recorded; reads are not recorded', async () => {
  const ran: unknown[] = [];
  const routes: Route[] = [
    { method: 'GET', path: '/api/thing', handler: async () => ({ status: 200, body: 'read' }) },
    { method: 'POST', path: '/api/ports/:port/poke', write: true, body: { limit: 1024 }, handler: async ({ body }) => (ran.push(body), { status: 200, body: { message: 'poked' } }) },
    { method: 'POST', path: '/api/start', write: true, body: { limit: 1024 }, handler: async () => ({ status: 409, body: { ok: false, port: 4321, message: 'busy\nnow' } }) },
  ];
  const { ctx, audit } = context();
  const route = appRouter(routes, ctx);
  const at = (q: any, path: string) => route(q, new URL(`http://x${path}`), ctx);

  assert.deepEqual(await at(request('POST', '127.0.0.1', { 'x-portboard': '1', ...SERVE, 'tailscale-user-login': OWNER }, '{"pinned":true,"label":"secret"}'), '/api/ports/8080/poke'), { status: 200, body: { message: 'poked' } });
  assert.deepEqual(await at(request('POST', '127.0.0.1', { 'x-portboard': '1' }, '{}'), '/api/ports/9090/poke'), { status: 200, body: { message: 'poked' } });
  assert.equal((await at(request('POST', '127.0.0.1', {}), '/api/ports/8080/poke'))?.status, 403);
  assert.equal((await at(request('POST', '127.0.0.1', { 'x-portboard': '1' }, '{"path":"/w/app"}'), '/api/start'))?.status, 409);
  assert.equal((await at(request('POST', '127.0.0.1', { 'x-portboard': '1' }, '{not json'), '/api/ports/1/poke'))?.status, 400);
  assert.equal((await at(request('GET', '100.64.0.9'), '/api/thing'))?.status, 200);
  assert.equal(ran.length, 2);

  // Writes and denials live in two files (M2) and are merged by time; within one millisecond their order is open.
  const all = await audit.query();
  const [bad, start, local, serve] = all.filter((e) => e.result !== 'denied');
  const [nohdr] = all.filter((e) => e.result === 'denied');
  assert.deepEqual(
    { ...serve, at: '' },
    { at: '', who: OWNER, source: 'serve', route: 'POST /api/ports/:port/poke', target: { port: 8080, pinned: true, fields: ['label'] }, result: 'ok', status: 200, detail: 'poked', device: { addr: '100.101.102.103', name: 'dev-mac', id: 'nMacStable1CNTRL' } },
  );
  assert.deepEqual([local.who, local.source, local.target, local.result, local.device], ['local', 'loopback', { port: 9090 }, 'ok', undefined]);
  assert.deepEqual([nohdr.result, nohdr.status, nohdr.detail], ['denied', 403, 'missing X-Portboard header']);
  assert.deepEqual([start.target, start.result, start.detail], [{ path: '/w/app', port: 4321 }, 'error', 'busy now'], 'port from the answer, message cleaned');
  assert.deepEqual([bad.result, bad.status, bad.target], ['error', 400, { port: 1 }]);
  assert.equal((await audit.query({ limit: 100 })).length, 5, 'the GET left no line');
  assert.ok(!readFileSync(audit.path, 'utf8').includes('secret'), 'free text never reaches the log');
});

test('appRouter: GET /api/whoami tells the dashboard whether it may write', async () => {
  const { ctx } = context();
  const route = appRouter(REGISTRY.routes, ctx);
  const who = async (q: any) => (await route(q, new URL('http://x/api/whoami'), ctx))?.body as Record<string, unknown>;
  assert.deepEqual(await who(request('GET', '127.0.0.1', { ...SERVE, 'tailscale-user-login': OWNER })), { login: OWNER, source: 'serve', owner: true, canWrite: true, device: DEVICES['100.101.102.103'] });
  assert.deepEqual(await who(request('GET', '127.0.0.1')), { login: null, source: 'loopback', owner: true, canWrite: true });
  const direct = await who(request('GET', '100.64.0.9'));
  assert.equal(direct.canWrite, false);
  assert.match(String(direct.reason), /직접/);
  assert.deepEqual(direct.device, DEVICES['100.64.0.9'], 'a direct caller is identified by its socket address');
});

test('appRouter: GET /api/audit checks its query and filters by port', async () => {
  const { ctx, audit } = context();
  await audit.append(entry(1, 3000));
  await audit.append(entry(2, 4000));
  const route = appRouter(REGISTRY.routes, ctx);
  const at = async (qs: string) => route(request('GET', '127.0.0.1'), new URL(`http://x/api/audit${qs}`), ctx);
  assert.equal(((await at(''))?.body as { entries: unknown[] }).entries.length, 2);
  assert.deepEqual(((await at('?port=3000'))?.body as { entries: AuditEntry[] }).entries.map((e) => e.target.port), [3000]);
  assert.equal((await at('?port=0'))?.status, 400);
  assert.equal((await at('?limit=9999'))?.status, 400);
});

test('appRouter: GET /api/audit is the owner\'s only (#7); other reads stay open to the tailnet', async () => {
  const { ctx, audit } = context();
  await audit.append(entry(1, 3000));
  const route = appRouter(REGISTRY.routes, ctx);
  const get = (path: string, q: ReturnType<typeof request>) => route(q, new URL(`http://x${path}`), ctx);
  const callers: [string, ReturnType<typeof request>, boolean][] = [
    ['loopback (a local process)', request('GET', '127.0.0.1'), true],
    ['serve, the owner', request('GET', '127.0.0.1', { ...SERVE, 'tailscale-user-login': OWNER }), true],
    ['serve, another user', request('GET', '127.0.0.1', { ...SERVE, 'tailscale-user-login': 'guest@example.com' }), false],
    ['serve, a tagged node', request('GET', '127.0.0.1', SERVE), false],
    ['funnel', request('GET', '127.0.0.1', { ...SERVE, 'tailscale-funnel-request': '?1', 'tailscale-user-login': OWNER }), false],
    ['direct tailnet IP', request('GET', '100.64.0.9'), false],
    ['direct, spoofed owner login', request('GET', '100.64.0.9', { ...SERVE, 'tailscale-user-login': OWNER }), false],
  ];
  for (const [name, q, owner] of callers) {
    const r = await get('/api/audit?port=3000', q);
    if (owner) {
      assert.equal(r?.status, 200, name);
      assert.equal((r?.body as { entries: unknown[] }).entries.length, 1, name);
    } else {
      assert.equal(r?.status, 403, name);
      const body = r?.body as { error: string; reason: string; entries?: unknown };
      assert.equal(body.error, 'owner only', name);
      assert.match(body.reason, /[가-힣]/, `${name}: a Korean reason`);
      assert.equal(body.entries, undefined, `${name}: no entries`);
    }
  }
  // A non-owner still reads whoami (to learn it can't write); the audit route's owner check is its own.
  const who = await get('/api/whoami', request('GET', '100.64.0.9'));
  assert.equal(who?.status, 200);
  assert.equal((who?.body as { canWrite: boolean }).canWrite, false);
});

test('dashboard: the 기록 lists say "owner only" on a 403 instead of a load failure, in both locales', () => {
  const lib = readFileSync(`${ROOT}public/lib/audit.js`, 'utf8');
  assert.match(lib, /res\.status === 403\) return \{ ownerOnly: true \}/);
  for (const page of ['public/features/audit.js', 'public/service.js']) {
    const src = readFileSync(`${ROOT}${page}`, 'utf8');
    assert.match(src, /loadAudit\(`\/api\/audit\?/, page);
    assert.doesNotMatch(src, /tryJSON\(`\/api\/audit/, page);
  }
  for (const loc of ['en', 'ko']) {
    const msgs = JSON.parse(readFileSync(`${ROOT}public/i18n/${loc}.json`, 'utf8'));
    assert.equal(typeof msgs['audit.ownerOnly'], 'string', loc);
  }
});

test('server.ts routes through appRouter (the owner check and the audit log), never the bare router', () => {
  const src = readFileSync(`${ROOT}src/server.ts`, 'utf8');
  assert.match(src, /appRouter\(REGISTRY\.routes, ctx\)/);
  assert.doesNotMatch(src, /createRouter\(/);
});

// ---- MCP ----

test('mcp: write tool calls go into the audit log as source mcp; read-only ones do not; no log without one', async () => {
  const log = new AuditLog(join(tmp(), 'audit.jsonl'));
  const core = { releasePort: async () => ({ ok: true }), reservations: async () => [], reservePort: async () => ({ ok: false, error: 'taken' }) } as any;
  await callTool('release_port', { port: 4100 }, core, log);
  await callTool('reserve_port', { owner: 'pb', port: 4101, note: 'my note' }, core, log);
  await callTool('list_reservations', {}, core, log);
  await callTool('release_port', { port: 4102 }, core);
  const got = await log.query();
  assert.deepEqual(got.map((e) => [e.route, e.who, e.source, e.target.port, e.result]), [
    ['mcp reserve_port', 'local', 'mcp', 4101, 'error'],
    ['mcp release_port', 'local', 'mcp', 4100, 'ok'],
  ]);
  assert.deepEqual(got[0].target.fields, ['note']);
});

test('access feature (#29/#30): after remote-connector (then the 설정 tab modules), two read routes, the 최근 기록 script on the dashboard, no tools', () => {
  assert.deepEqual(FEATURES.map((x) => x.name).slice(-4), ['remote-connector', 'access', 'write-devices', 'settings']);
  const f = FEATURES.find((x) => x.name === 'access')!;
  assert.deepEqual(f.routes!.map((r) => `${r.method} ${r.path}`), ['GET /api/whoami', 'GET /api/audit']);
  assert.equal(f.tools, undefined);
  assert.deepEqual(f.ui, [{ pages: ['index.html'], script: 'features/audit.js' }]);
});
