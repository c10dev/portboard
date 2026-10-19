// 설정 tab: 승인 코드 만들기 from the dashboard (POST /api/remote/approval-code), saving the write-device allowlist
// (POST /api/settings/write-devices), the consent page's link to the tab, and GET /api/settings' pieces.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkWriteDevices, loadWriteDevices, resolveCaller, saveWriteDevices, type Device } from '../src/core/access.ts';
import type { AuditEntry } from '../src/core/audit.ts';
import { createRouter } from '../src/features/router.ts';
import { FEATURES, REGISTRY, uiTags } from '../src/features/registry.ts';
import { connectorUrlOf } from '../src/features/remote-connector.ts';
import { addressesOf, DOC_LINKS, parseDeployed, secretsOf } from '../src/features/settings.ts';
import { lockoutReason } from '../src/features/write-devices.ts';
import { assess } from '../src/core/onboarding.ts';
import { dashboardUrl, parseServe } from '../src/core/tailscale.ts';
import { createRemoteHandler } from '../src/remote/http.ts';
import { consentHtml, settingsPageUrl } from '../src/remote/oauth.ts';
import { Store } from '../src/remote/store.ts';
import type { RemoteCore } from '../src/remote/tools.ts';

const OWNER = 'me@example.com';
const MAC: Device = { addr: '100.100.1.2', name: 'dev-mac', id: 'nMac1CNTRL' };
const PHONE: Device = { addr: '100.100.1.3', name: 'iphone', id: 'nPhone1CNTRL' };

let dir: string;
let remoteFile: string;
let accessFile: string;
const audit: AuditEntry[] = [];
const devices = new Map([MAC, PHONE].map((d) => [d.addr, d]));
let allow: Awaited<ReturnType<typeof loadWriteDevices>> = null;

/** The server context the routes and the owner check read: a preview's own remote.json and access.json. */
const ctx = () =>
  ({
    paths: { profile: 'preview', port: 8899, remoteConfig: remoteFile, access: accessFile },
    owner: async () => OWNER,
    device: async (addr: string) => devices.get(addr) ?? { addr },
    writeDevices: async () => allow,
  }) as any;

// The dashboard's router with the real owner check (access.ts) and an audit log the test can read.
const route = createRouter(REGISTRY.routes, { caller: (req) => resolveCaller(req, ctx()), record: async (e) => void audit.push(e) });

type Who = 'loopback' | 'mac' | 'phone' | 'stranger' | 'direct';
function req(method: string, who: Who, body?: unknown, headers: Record<string, string> = { 'x-portboard': '1' }) {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  const viaServe = (d: Device, login = OWNER) => ({ 'x-forwarded-for': d.addr, 'tailscale-user-login': login });
  r.method = method;
  r.headers = {
    ...headers,
    ...(who === 'mac' ? viaServe(MAC) : who === 'phone' ? viaServe(PHONE) : who === 'stranger' ? viaServe(MAC, 'other@example.com') : {}),
  };
  r.socket = { remoteAddress: who === 'direct' ? '100.100.1.2' : '127.0.0.1' };
  return r;
}

async function dash(method: 'GET' | 'POST', path: string, who: Who = 'loopback', body?: unknown, headers?: Record<string, string>) {
  const r = await route(req(method, who, body, headers), new URL(`http://dash${path}`), ctx());
  assert.ok(r, `${method} ${path} is a route`);
  return r as { status: number; body: any };
}

// ---- the remote server, on the same remote.json (as the two processes share it) ----

const core: RemoteCore = {
  snapshot: async () => ({ at: 'now', host: { hostname: 'box', user: 'me' }, tailscale: { available: false } as any, ports: [] }) as any,
  devices: async () => ({ at: 'now', pool: { available: false } as any, devices: [], proxmox: { configured: false, ok: false, hosts: [] } }),
  freePorts: async () => [3000],
  usage: async () => ({ at: 'now', cards: [], local: { connections: 0, uses: [] }, byPort: {}, idleServices: 0 }) as any,
};
let server: Server;
let port: number;
const base = () => `http://127.0.0.1:${port}`;

function call(method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

/** DCR → consent page → approve with `approval` → code → tokens, as a client would (loopback redirect). */
async function connectWith(approval: string) {
  const redirect = 'http://127.0.0.1:33418/callback';
  const reg = await call('POST', '/register', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'test client', redirect_uris: [redirect] }) });
  assert.equal(reg.status, 201, reg.body);
  const clientId = JSON.parse(reg.body).client_id;
  const verifier = randomBytes(32).toString('base64url');
  const params = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 's',
    resource: `${base()}/mcp`,
  };
  const page = await call('GET', `/authorize?${new URLSearchParams(params)}`);
  const approved = await call('POST', '/authorize', {
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base() },
    body: new URLSearchParams({ ...params, approval_code: approval, decision: 'approve' }).toString(),
  });
  if (approved.status !== 302) return { page, approved, tokens: null };
  const code = new URL(String(approved.headers.location)).searchParams.get('code')!;
  const tok = await call('POST', '/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect, resource: `${base()}/mcp` }).toString(),
  });
  assert.equal(tok.status, 200, tok.body);
  return { page, approved, tokens: JSON.parse(tok.body) as { access_token: string } };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'portboard-settings-'));
  remoteFile = join(dir, 'remote.json');
  accessFile = join(dir, 'access.json');
  const handler = createRemoteHandler({
    core,
    store: new Store(remoteFile),
    hosts: new Set(['127.0.0.1', 'localhost']),
    log: () => {},
    settingsUrl: 'https://box.tail0000.ts.net:8443/settings.html#remote',
  });
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
});

after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

/** Runs f with console.error captured (the route logs a line; it must not hold the code). */
async function quiet<T>(f: () => Promise<T>): Promise<{ out: T; logged: string }> {
  const orig = console.error;
  let logged = '';
  console.error = (...a: unknown[]) => void (logged += `${a.join(' ')}\n`);
  try {
    return { out: await f(), logged };
  } finally {
    console.error = orig;
  }
}

// ---------- 승인 코드 만들기 ----------

test('approval code: owner only — without X-Portboard, from another login, from a non-allowed device, direct: 403 and no code', async () => {
  audit.length = 0;
  assert.equal((await dash('POST', '/api/remote/approval-code', 'loopback', undefined, {})).status, 403, 'no X-Portboard');
  assert.equal((await dash('POST', '/api/remote/approval-code', 'stranger')).status, 403, 'not the owner login');
  assert.equal((await dash('POST', '/api/remote/approval-code', 'direct')).status, 403, 'tailnet IP directly: read-only');
  allow = { list: ['iphone'] };
  const r = await dash('POST', '/api/remote/approval-code', 'mac');
  allow = null;
  assert.equal(r.status, 403, 'owner login, but not a write device');
  assert.match(r.body.reason, /쓰기 허용 기기가 아니에요/);
  assert.equal((await new Store(remoteFile).read()).approval ?? null, null, 'no code was made');
  assert.equal(audit.length, 4);
  assert.ok(audit.every((e) => e.route === 'POST /api/remote/approval-code' && e.result === 'denied'));
  // not a thing any MCP server can do, local or remote
  assert.ok(!REGISTRY.tools.some((t) => /approv/i.test(t.def.name)), 'no local tool');
  assert.ok(!REGISTRY.remoteTools.some((t) => /approv/i.test(t.name)), 'no remote tool');
  assert.equal((await call('POST', '/api/remote/approval-code')).status, 404, 'the remote server has no such route');
});

test('approval code: the owner gets a one-time code, audited without it, and the remote server accepts it', async () => {
  audit.length = 0;
  const { out: r, logged } = await quiet(() => dash('POST', '/api/remote/approval-code', 'mac'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.ok(r.body.ttlMs > 9 * 60_000 && r.body.ttlMs <= 10 * 60_000, 'ten minutes');
  assert.equal(r.body.replaced, false);
  // the audit line says who made one, from which device; never the code
  assert.equal(audit.length, 1);
  const e = audit[0];
  assert.deepEqual([e.route, e.result, e.source, e.who, e.device?.name], ['POST /api/remote/approval-code', 'ok', 'serve', OWNER, 'dev-mac']);
  const raw = r.body.code.replace('-', '');
  for (const text of [JSON.stringify(audit), logged]) {
    assert.ok(!text.includes(r.body.code) && !text.includes(raw) && !text.toLowerCase().includes(raw.toLowerCase()), 'the code is in neither the audit log nor the server log');
  }
  assert.match(logged, /approval code created/);
  // stored as a hash only (0600), and the dashboard list says a code is pending until when
  assert.ok(!(await readFile(remoteFile, 'utf8')).includes(raw));
  assert.equal((await stat(remoteFile)).mode & 0o777, 0o600);
  const list = await dash('GET', '/api/remote/clients');
  assert.equal(list.body.pendingApproval, true);
  assert.equal(list.body.approvalExpiresAt, r.body.expiresAt);
  assert.ok(!JSON.stringify(list.body).includes(raw));

  // the consent page links the 설정 tab, and takes the code (any case) once
  const first = await connectWith(r.body.code.toLowerCase());
  assert.match(first.page.body, /href="https:\/\/box\.tail0000\.ts\.net:8443\/settings\.html#remote"[^>]*>코드는 대시보드 설정 탭\(tailnet 전용\)에서 만들 수 있어요/);
  assert.equal(first.approved.status, 302);
  assert.ok(first.tokens?.access_token);
  assert.equal((await dash('GET', '/api/remote/clients')).body.pendingApproval, false, 'single use');
  const again = await connectWith(r.body.code);
  assert.equal(again.approved.status, 401);
  assert.match(again.approved.body, /대시보드 설정 탭에서 새 코드를 만드세요/);
});

test('approval code: a new one replaces the pending one (the old one stops working)', async () => {
  const one = (await quiet(() => dash('POST', '/api/remote/approval-code'))).out.body;
  const two = (await quiet(() => dash('POST', '/api/remote/approval-code'))).out.body;
  assert.equal(two.replaced, true);
  assert.notEqual(one.code, two.code);
  const old = await connectWith(one.code);
  assert.equal(old.approved.status, 401, 'the replaced code is refused');
  assert.match(old.approved.body, /승인 코드가 맞지 않습니다/);
  const ok = await connectWith(two.code);
  assert.equal(ok.approved.status, 302, 'the new one works');
});

// ---------- 쓰기 허용 기기 ----------

test('write devices: checkWriteDevices trims, de-duplicates and refuses empty lists, non-strings and odd names', () => {
  assert.deepEqual(checkWriteDevices([' dev-mac ', 'dev-mac', 'iphone.tail0000.ts.net.', 'nAbC123CNTRL']), ['dev-mac', 'iphone.tail0000.ts.net', 'nAbC123CNTRL']);
  assert.match(checkWriteDevices([]) as string, /적어도 한 대/);
  assert.match(checkWriteDevices(['', ' ']) as string, /적어도 한 대/);
  assert.equal(typeof checkWriteDevices('mac'), 'string');
  assert.equal(typeof checkWriteDevices([1]), 'string');
  assert.match(checkWriteDevices(['a b']) as string, /기기 이름이 아니에요/);
  assert.match(checkWriteDevices(['../x']) as string, /기기 이름이 아니에요/);
  assert.equal(typeof checkWriteDevices(Array.from({ length: 101 }, (_, i) => `d${i}`)), 'string');
});

test('write devices: saving a list without the device in use is refused (409), and nothing is written', async () => {
  await rm(accessFile, { force: true });
  const r = await dash('POST', '/api/settings/write-devices', 'mac', { writeDevices: ['iphone'] });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /지금 쓰는 기기\(dev-mac\(100\.100\.1\.2\)\)가 목록에 없어요/);
  await assert.rejects(stat(accessFile), /ENOENT/);
  // a stable node ID counts as naming the device; so does PORTBOARD_WRITE_DEVICES
  const c = await resolveCaller(req('POST', 'mac'), ctx());
  assert.equal(lockoutReason(c, ['nMac1CNTRL'], []), null);
  assert.equal(lockoutReason(c, ['iphone'], ['dev-mac']), null);
  assert.match(lockoutReason({ ...c, device: { addr: '100.100.9.9' } }, ['iphone'], [])!, /확인하지 못했어요/);
  // loopback is the owner whatever the list says
  assert.equal(lockoutReason(await resolveCaller(req('POST', 'loopback'), ctx()), ['iphone'], []), null);
  // and a non-owner can't even get that far
  assert.equal((await dash('POST', '/api/settings/write-devices', 'stranger', { writeDevices: ['iphone'] })).status, 403);
});

test('write devices: the owner saves a list with the device in use: 0600, atomic, other keys kept, audited, and it applies at once', async () => {
  audit.length = 0;
  await writeFile(accessFile, JSON.stringify({ note: 'kept', writeDevices: ['old-laptop'] }), { mode: 0o600 });
  const r = await dash('POST', '/api/settings/write-devices', 'mac', { writeDevices: ['dev-mac', 'iphone'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(JSON.parse(await readFile(accessFile, 'utf8')), { note: 'kept', writeDevices: ['dev-mac', 'iphone'] });
  assert.equal((await stat(accessFile)).mode & 0o777, 0o600);
  assert.deepEqual(r.body.list, ['dev-mac', 'iphone']);
  assert.deepEqual([r.body.current.name, r.body.source], ['dev-mac', 'serve']);
  assert.deepEqual(audit.map((e) => [e.route, e.result, (e.target as any).writeDevices]), [['POST /api/settings/write-devices', 'ok', ['dev-mac', 'iphone']]]);
  // the guard reads the same file: the phone may now write, a device left out may not
  allow = await loadWriteDevices(accessFile, {});
  assert.equal((await resolveCaller(req('POST', 'phone'), ctx())).canWrite, true);
  devices.set('100.100.1.4', { addr: '100.100.1.4', name: 'nas' });
  const nas = await resolveCaller({ headers: { 'x-forwarded-for': '100.100.1.4', 'tailscale-user-login': OWNER }, socket: { remoteAddress: '127.0.0.1' } }, ctx());
  assert.equal(nas.canWrite, false);
  allow = null;
  // a file that was 0644 comes back 0600
  await writeFile(accessFile, '{}', { mode: 0o644 });
  await saveWriteDevices(accessFile, ['dev-mac']);
  assert.equal((await stat(accessFile)).mode & 0o777, 0o600);
});

test('write devices: a file that is not a JSON object is left alone (409); bad bodies are 400', async () => {
  await writeFile(accessFile, '{ not json', { mode: 0o600 });
  const r = await dash('POST', '/api/settings/write-devices', 'loopback', { writeDevices: ['dev-mac'] });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /JSON이 아니에요/);
  assert.equal(await readFile(accessFile, 'utf8'), '{ not json');
  assert.equal((await dash('POST', '/api/settings/write-devices', 'loopback', { writeDevices: [] })).status, 400);
  assert.equal((await dash('POST', '/api/settings/write-devices', 'loopback', { writeDevices: 'mac' })).status, 400);
  await rm(accessFile, { force: true });
});

test('write devices: GET lists the owner devices with the listed ones and the one in use marked', async () => {
  await writeFile(accessFile, JSON.stringify({ writeDevices: ['iphone', 'nOld9CNTRL'] }), { mode: 0o600 });
  const status = JSON.stringify({
    Self: { ID: 'self', UserID: 1, DNSName: 'box.tail0000.ts.net.' },
    User: { 1: { LoginName: OWNER }, 2: { LoginName: 'other@example.com' } },
    Peer: {
      a: { ID: 'a', UserID: 1, DNSName: 'dev-mac.tail0000.ts.net.', OS: 'macOS' },
      b: { ID: 'b', UserID: 1, DNSName: 'iphone.tail0000.ts.net.', OS: 'iOS' },
      c: { ID: 'c', UserID: 2, DNSName: 'guest.tail0000.ts.net.', OS: 'windows' },
    },
  });
  const { writeDevicesView } = await import('../src/features/write-devices.ts');
  const v = await writeDevicesView(req('GET', 'phone'), ctx(), { tailscaleStatus: async () => status, env: {} });
  assert.deepEqual(v.devices, [
    { name: 'dev-mac', os: 'macOS', listed: false, current: false },
    { name: 'iphone', os: 'iOS', listed: true, current: true },
  ]);
  assert.deepEqual(v.others, ['nOld9CNTRL']);
  assert.deepEqual(v.list, ['iphone', 'nOld9CNTRL']);
  assert.equal(v.current?.name, 'iphone');
  const local = await writeDevicesView(req('GET', 'loopback'), ctx(), { tailscaleStatus: async () => null, env: { PORTBOARD_WRITE_DEVICES: 'a, b' } });
  assert.deepEqual([local.current, local.source, local.devices, local.env], [null, 'loopback', null, ['a', 'b']]);
  await rm(accessFile, { force: true });
});

// ---------- the consent page and the rest of the tab ----------

test('consent page: one line under the code field, linking the 설정 tab on the dashboard https address from serve status', () => {
  const serve = parseServe(JSON.stringify({ Web: { 'box.tail0000.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8790' } } }, 'box.tail0000.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8794' } } } } }));
  const url = settingsPageUrl(dashboardUrl('box.tail0000.ts.net', serve, 8790));
  assert.equal(url, 'https://box.tail0000.ts.net:8443/settings.html#remote');
  assert.equal(settingsPageUrl(null), null);
  assert.equal(settingsPageUrl('http://box:8790'), null, 'only an https address');
  assert.equal(settingsPageUrl('not a url'), null);
  const page = (settingsUrl?: string | null) => consentHtml({ clientName: 'Claude', redirectUri: 'https://claude.ai/api/mcp/auth_callback', host: 'box', params: {}, settingsUrl });
  const linked = page(url);
  const field = linked.indexOf('name="approval_code"');
  const line = linked.indexOf('코드는 대시보드 설정 탭(tailnet 전용)에서 만들 수 있어요');
  assert.ok(field > 0 && line > field, 'right under the code field');
  assert.ok(linked.includes(`<a href="${url}"`));
  const plain = page(null);
  assert.ok(plain.includes('코드는 대시보드 설정 탭(tailnet 전용)에서 만들 수 있어요') && !plain.includes('settings.html'));
});

test('settings: registry — two new modules last, the 설정 page gets every section script, routes are what they say', () => {
  assert.deepEqual(FEATURES.map((f) => f.name).slice(-2), ['write-devices', 'settings']);
  const tags = uiTags('#settings');
  for (const s of ['settings-start', 'remote-connector', 'write-devices', 'digest', 'claude-autostop', 'secrets', 'about']) assert.ok(tags.includes(`features/${s}.js`), s);
  const routes = REGISTRY.routes.filter((r) => r.path.startsWith('/api/settings'));
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path}${r.write ? ' (write)' : ''}`), ['GET /api/settings/write-devices', 'POST /api/settings/write-devices (write)', 'GET /api/settings']);
  const f = FEATURES.find((x) => x.name === 'settings')!;
  assert.ok(!f.tools && !f.remoteTools && !f.jobs);
});

test('settings: deployed.json, the addresses, the docs, and secrets without values', () => {
  const c = 'a'.repeat(40);
  assert.deepEqual(parseDeployed(JSON.stringify({ commit: c, at: '2026-10-18T14:21:16.565Z', restarted: ['portboard'] })), { commit: c, at: '2026-10-18T14:21:16.565Z' });
  assert.equal(parseDeployed('{"commit":"short"}'), null);
  assert.equal(parseDeployed(null), null);
  assert.equal(parseDeployed('nope'), null);

  const serve = parseServe(JSON.stringify({ Web: { 'box.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8790' } } }, 'box.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8794' } } } } }));
  assert.deepEqual(addressesOf('box.ts.net', serve, 'https://box.ts.net'), { dashboard: 'https://box.ts.net:8443', connector: 'https://box.ts.net/mcp', connectorPort: 443, direct: 'http://box.ts.net:8790' });
  assert.deepEqual(addressesOf(null, [], undefined), { dashboard: null, connector: null, connectorPort: null, direct: null });
  assert.equal(connectorUrlOf('https://box.ts.net/'), 'https://box.ts.net/mcp');
  assert.equal(connectorUrlOf('http://box:8794'), null);
  assert.ok(DOC_LINKS.every((d) => d.href.startsWith('https://github.com/c10dev/portboard/blob/main/')));

  const facts: any = {
    alertChannel: ['ntfy'],
    proxmox: { configured: true, error: null, looseMode: false, collector: { view: 'ok', lastError: null }, expiry: { status: 'ok', expiresAt: '2027-01-01T00:00:00.000Z' } },
    pvePorts: { view: 'ok', lastError: null },
    winPorts: { view: 'setup', lastError: 'no-key' },
    macAgent: { present: true, connected: true, state: null },
    menubarSeenAt: null,
    remote: { clients: 1, liveTokens: 2, publicUrl: true, unreadable: false },
    claudeCode: { registered: true },
    usage: { pinned: 0, labels: 0, alerts: 0, deviceAlerts: 0, names: 0 },
    writeDevices: { list: ['mac'], error: null, path: '~/.config/portboard/access.json', ownerDevices: [] },
  };
  const sw: any = {
    expiry: {
      checkedAt: null,
      items: [
        { key: 'proxmox-token', name: 'Proxmox API token', status: 'ok', expiresAt: '2027-01-01T00:00:00.000Z', note: null, runbook: null },
        { key: 'remote:abc', name: 'remote MCP client Claude', status: 'ok', expiresAt: '2026-11-10T00:00:00.000Z', note: null, runbook: null },
        { key: 'remote:def', name: 'remote MCP client ChatGPT', status: 'ok', expiresAt: '2026-11-01T00:00:00.000Z', note: null, runbook: null },
      ],
    },
  };
  const s = secretsOf(assess(facts, Date.parse('2026-10-18T00:00:00Z')).items, sw);
  assert.deepEqual(s.map((x) => [x.key, x.status, x.expiresAt]), [
    ['proxmox', 'ok', '2027-01-01T00:00:00.000Z'],
    ['pve-ssh', 'ok', null],
    ['win-ssh', 'missing', null],
    ['ntfy', 'ok', null],
    ['connector', 'ok', '2026-11-01T00:00:00.000Z'],
  ]);
  assert.ok(s.every((x) => x.runbook.startsWith('https://github.com/c10dev/portboard/blob/main/docs/runbooks/')));
  assert.deepEqual(Object.keys(s[0]).sort(), ['detail', 'expiresAt', 'key', 'runbook', 'status', 'title'], 'nothing but status, detail, date and runbook');
});
