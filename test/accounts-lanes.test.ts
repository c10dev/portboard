// Settings for the GPT lane and the desktop route (docs/accounts.md#settings, src/core/accounts/lanes.ts, proxy.ts and
// src/features/accounts.ts, public/features/accounts.js): the lanes file, the lanes route, the key route's certFile, the report's
// `lanes` and `activity`, and the controls on the fake DOM. HOME, the config files and the proxy key are mkdtemp paths, the
// upstream is a fake fetch and the listener is a real one on 127.0.0.1 port 0. No real host is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { FakeDocument } from './fixtures/fake-dom.ts';
import { L } from './fixtures/locale.ts';

// Safety net first (src/ is imported dynamically, after these lines).
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'pb-lanes-'));
const realFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error('test reached the real fetch: inject one');
}) as typeof fetch;
process.env.HOME = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, 'claude-dir');
process.env.CODEX_HOME = join(FAKE_HOME, 'codex-dir');
for (const k of Object.keys(process.env)) if (k.startsWith('PORTBOARD_') && k !== 'PORTBOARD_LOCALE') delete process.env[k];
const CFG = join(FAKE_HOME, 'cfg');
const FILE = join(FAKE_HOME, 'accounts.json');
const HOMES = join(FAKE_HOME, 'account-homes');
const KEY_FILE = join(CFG, 'accounts-proxy.key');
const CERT_FILE = join(CFG, 'accounts-proxy-cert.pem');
const LANES_FILE = join(CFG, 'accounts-lanes.json');
process.env.PORTBOARD_ACCOUNTS = FILE;
process.env.PORTBOARD_ACCOUNT_HOMES = HOMES;
process.env.PORTBOARD_ACCOUNTS_PROXY_KEY = KEY_FILE;
process.env.PORTBOARD_ACCOUNTS_PROXY_CERT = CERT_FILE;
process.env.PORTBOARD_ACCOUNTS_PROXY_CERT_KEY = join(CFG, 'accounts-proxy-cert.key');
process.env.PORTBOARD_ACCOUNTS_LANES = LANES_FILE;

const { AccountsProxy, PROXY_HOST, setProxyConfigForTest } = await import('../src/core/accounts/proxy.ts');
const { readLanes, writeLanes } = await import('../src/core/accounts/lanes.ts');
const { resetRefreshForTest } = await import('../src/core/accounts/refresh.ts');
const { upsertAccount } = await import('../src/core/accounts/store.ts');
const { clearQuotaCache } = await import('../src/core/accounts/quota.ts');
const { PATHS } = await import('../src/core/paths.ts');
const { accountsConfig } = await import('../src/core/site.ts');
const { accountsFeature, setAccountsEnabledForTest, setAccountsOptionsForTest } = await import('../src/features/accounts.ts');
const { appRouter } = await import('../src/features/router.ts');
const { REGISTRY } = await import('../src/features/registry.ts');
const { TAILSCALE_POLICY } = await import('../src/core/access.ts');
const { AuditLog } = await import('../src/core/audit.ts');
type ServerContext = import('../src/features/context.ts').ServerContext;
type Proxy = InstanceType<typeof AccountsProxy>;

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const FIX = join(import.meta.dirname, 'fixtures', 'accounts-gpt');
const OWNER = 'owner@example.com';
const CLAUDE_TOKEN = 'sk-ant-oat01-TESTTOKENCLAUDE0123456789';
const CODEX_TOKEN = 'TESTTOKENCODEX0123456789';
const REFRESH = 'sk-ant-ort01-TESTREFRESH0123456789';
const MARKERS = ['TESTTOKEN', 'TESTREFRESH'];
const iso = (ms: number) => new Date(ms).toISOString();
const modeOf = (p: string) => statSync(p).mode & 0o777;

// ---- the lanes file ----

const site = (gpt: unknown, desktop: unknown) => ({ accounts: accountsConfig({ enabled: true, proxy: { enabled: true, gpt, desktop } }) });
const own = (name: string) => join(mkdtempSync(join(FAKE_HOME, 'f-')), name);

test('lanes file: no file is portboard.json for both keys; a key in the file wins for that key only', async () => {
  const path = own('lanes.json');
  const cfg = site({ enabled: true, models: { 'claude-opus-5-5': 'gpt-6-astra' } }, { enabled: true });
  const none = await readLanes({ path, site: cfg });
  assert.deepEqual(none, { gpt: { enabled: true, models: { 'claude-opus-5-5': 'gpt-6-astra' } }, desktop: { enabled: true }, source: { gpt: 'config', desktop: 'config' } });
  assert.equal('unreadable' in none, false);
  writeFileSync(path, JSON.stringify({ desktop: { enabled: false } }), { mode: 0o600 });
  const one = await readLanes({ path, site: cfg });
  assert.deepEqual([one.gpt.enabled, one.desktop.enabled, one.source], [true, false, { gpt: 'config', desktop: 'file' }]);
  writeFileSync(path, JSON.stringify({ gpt: { enabled: false, models: { 'claude-haiku-5-5': 'gpt-6-astra', bad: 'no spaces here', 'x y': 'gpt-6' } } }), { mode: 0o600 });
  const two = await readLanes({ path, site: cfg });
  assert.deepEqual(two.gpt, { enabled: false, models: { 'claude-haiku-5-5': 'gpt-6-astra' } }, 'the same rules as portboard.json: a bad entry is dropped');
  assert.deepEqual([two.desktop.enabled, two.source], [true, { gpt: 'file', desktop: 'config' }]);
});

test('lanes file: models keep 32 entries at most, and enabled is true only for true', async () => {
  const path = own('lanes.json');
  const models = Object.fromEntries(Array.from({ length: 40 }, (_v, i) => [`claude-m-${i}`, 'gpt-6']));
  writeFileSync(path, JSON.stringify({ gpt: { enabled: 'true', models }, desktop: { enabled: 1 } }), { mode: 0o600 });
  const r = await readLanes({ path, site: site({}, {}) });
  assert.equal(Object.keys(r.gpt.models).length, 32);
  assert.deepEqual([r.gpt.enabled, r.desktop.enabled], [false, false]);
});

test('lanes file: a loose mode, not JSON, not an object, or not a regular file is not used (portboard.json for both keys) and says so', async () => {
  const cfg = site({ enabled: true, models: {} }, { enabled: true });
  const good = JSON.stringify({ gpt: { enabled: false, models: {} }, desktop: { enabled: false } });
  for (const mode of [0o644, 0o640, 0o604, 0o660, 0o606]) {
    const path = own('lanes.json');
    writeFileSync(path, good, { mode: 0o600 });
    chmodSync(path, mode);
    const r = await readLanes({ path, site: cfg });
    assert.deepEqual([r.unreadable, r.gpt.enabled, r.desktop.enabled, r.source], [true, true, true, { gpt: 'config', desktop: 'config' }], mode.toString(8));
  }
  for (const text of ['{nope', '[]', '"x"', 'null']) {
    const path = own('lanes.json');
    writeFileSync(path, text, { mode: 0o600 });
    const r = await readLanes({ path, site: cfg });
    assert.deepEqual([r.unreadable, r.desktop.enabled], [true, true], text);
  }
  const dir = own('dir');
  mkdirSync(dir, { mode: 0o700 });
  assert.equal((await readLanes({ path: dir, site: cfg })).unreadable, true);
});

test('lanes file: writeLanes writes the whole object with mode 0600 and readLanes reads it back', async () => {
  const path = own('lanes.json');
  await writeLanes({ gpt: { enabled: true, models: { 'claude-haiku-5-5': 'gpt-6-astra' } }, desktop: { enabled: false } }, { path });
  assert.equal(modeOf(path), 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { gpt: { enabled: true, models: { 'claude-haiku-5-5': 'gpt-6-astra' } }, desktop: { enabled: false } });
  const r = await readLanes({ path, site: site({}, {}) });
  assert.deepEqual([r.gpt.enabled, r.desktop.enabled, r.source], [true, false, { gpt: 'file', desktop: 'file' }]);
  assert.equal(PATHS.accountsLanes, LANES_FILE, 'PORTBOARD_ACCOUNTS_LANES moves it');
  assert.deepEqual(readdirSync(join(path, '..')), ['lanes.json'], 'no temporary file is left');
});

// ---- the proxy under test ----

interface Up {
  url: string;
  headers: Record<string, string>;
}
const ups: Up[] = [];
const fake = (async (url: string | URL | Request, init?: RequestInit) => {
  ups.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers as Record<string, string>)) });
  if (String(url).startsWith('https://chatgpt.com/')) return new Response(readFileSync(join(FIX, 'stream-text-captured.sse')), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  return new Response(JSON.stringify({ type: 'message' }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
const homesOpts = () => ({ fetch: fake, now: () => Date.now(), accountsPath: FILE, accountHomes: HOMES, home: FAKE_HOME, env: { CLAUDE_CONFIG_DIR: join(FAKE_HOME, 'c'), CODEX_HOME: join(FAKE_HOME, 'x') }, platform: 'linux' });

let proxy: Proxy;
let key = '';
const logged: string[] = [];
const outputs: string[] = [];
const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
const AUDIT_DIR = mkdtempSync(join(FAKE_HOME, 'audit-'));
const audit = new AuditLog(join(AUDIT_DIR, 'audit.jsonl'));
const auditText = () => readdirSync(AUDIT_DIR).map((f) => readFileSync(join(AUDIT_DIR, f), 'utf8')).join('\n');
const sockets: Socket[] = [];

const claude = () =>
  upsertAccount({ provider: 'claude', alias: 'cl', identity: 'uuid-lanes-1', email: 'a@example.com', plan: 'max', tier: 'default_claude_max_5x', subscriptionType: 'max', tokens: { access: CLAUDE_TOKEN, refresh: REFRESH, idToken: null, expiresAt: iso(Date.now() + 100 * 3600_000) } }, { path: FILE, now: () => Date.now() });
const codex = () =>
  upsertAccount({ provider: 'codex', alias: 'cx', identity: 'cx-lanes-1', email: 'c@example.com', plan: 'plus', tokens: { access: CODEX_TOKEN, refresh: REFRESH, idToken: 'TESTTOKENIDTOKEN', expiresAt: iso(Date.now() + 100 * 3600_000) } }, { path: FILE, now: () => Date.now() });

test.beforeEach(async () => {
  resetRefreshForTest();
  clearQuotaCache();
  rmSync(FILE, { force: true });
  rmSync(HOMES, { recursive: true, force: true });
  rmSync(CFG, { recursive: true, force: true });
  ups.length = 0;
  logged.length = 0;
  outputs.length = 0;
  for (const k of Object.keys(saved) as (keyof typeof saved)[]) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
  setAccountsEnabledForTest(() => true);
  proxy = new AccountsProxy({ ...homesOpts(), keyPath: KEY_FILE });
  setAccountsOptionsForTest(() => ({ ...homesOpts(), proxy }));
  setProxyConfigForTest(() => ({ enabled: true, port: 0 }));
  await proxy.sync({ enabled: true, port: 0 });
  key = await proxy.key();
});
test.afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await proxy.close();
  Object.assign(console, saved);
  setAccountsEnabledForTest(null);
  setAccountsOptionsForTest(null);
  setProxyConfigForTest(null);
  for (const o of [...outputs, ...logged, auditText(), JSON.stringify(proxy.report())]) {
    for (const m of MARKERS) assert.ok(!o.includes(m), `output holds ${m}`);
    assert.ok(!o.includes(key), 'output holds the proxy key');
  }
});

const AUDIT_CTX = { owner: async () => OWNER, policy: async () => TAILSCALE_POLICY, device: async (addr: string) => ({ addr }), writeDevices: async () => null, ts: { available: true }, audit };
const context = () => new Proxy(AUDIT_CTX as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : assert.fail(`handler touched ctx.${String(k)}`)) }) as unknown as ServerContext;
function fakeReq(addr: string, headers: Record<string, string>, body?: unknown) {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]) as any;
  r.method = 'POST';
  r.headers = headers;
  r.socket = { remoteAddress: addr };
  return r;
}
async function route(path: string, body: unknown, headers: Record<string, string> = { 'x-portboard': '1' }, addr = '127.0.0.1') {
  const ctx = context();
  const out = await appRouter(REGISTRY.routes, ctx)(fakeReq(addr, headers, body), new URL(`http://x${path}`), ctx);
  assert.ok(out);
  outputs.push(JSON.stringify(out!.body).replace(/"key":"pbp-[0-9a-f]{32}"/, '"key":"KEY"'));
  return out!;
}
const lanesRoute = (body: unknown, headers?: Record<string, string>, addr?: string) => route('/api/accounts/proxy/lanes', body, headers, addr);
const keyRoute = (body: unknown = {}) => route('/api/accounts/proxy/key', body);
const SERVE = { 'x-forwarded-for': '100.101.102.103', 'x-forwarded-host': 'devbox.example.ts.net', 'x-forwarded-proto': 'https' };
const fileJson = () => JSON.parse(readFileSync(LANES_FILE, 'utf8'));

function viaProxy(body: unknown, path = '/v1/messages'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: PROXY_HOST, port: proxy.report().port, path, method: 'POST', agent: false, headers: { authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
const claudeBody = (model: string) => ({ ...JSON.parse(readFileSync(join(FIX, 'request-text.json'), 'utf8')), model });
/** Send a CONNECT line to the listener; resolves with the status line, the socket stays open */
function connectApi(auth: string | null = key): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host: PROXY_HOST, port: proxy.report().port }, () => {
      const head = auth === null ? '' : `Proxy-Authorization: Basic ${Buffer.from(`pb:${auth}`).toString('base64')}\r\n`;
      sock.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n${head}\r\n`);
    });
    sockets.push(sock);
    sock.on('error', () => {});
    sock.once('data', (d) => resolve(d.toString('latin1').split('\r\n')[0]));
    sock.once('close', () => resolve('closed'));
    sock.once('timeout', () => reject(new Error('no answer')));
  });
}

// ---- the lanes route ----

test('lanes route: not the owner, no X-Portboard, and the wrong shape of caller are 403 and write nothing', async () => {
  for (const [headers, addr] of [
    [{ 'x-portboard': '1' }, '100.64.0.9'],
    [{ 'x-portboard': '1', ...SERVE, 'tailscale-user-login': 'guest@example.com' }, '127.0.0.1'],
    [{ 'x-portboard': '1', ...SERVE }, '127.0.0.1'],
    [{}, '127.0.0.1'],
  ] as [Record<string, string>, string][]) {
    const r = await lanesRoute({ desktop: { enabled: true } }, headers, addr);
    assert.equal(r.status, 403, JSON.stringify(headers));
  }
  assert.throws(() => statSync(LANES_FILE));
  const r = (accountsFeature.routes ?? []).find((x) => x.path === '/api/accounts/proxy/lanes');
  assert.ok(r && r.method === 'POST' && r.write === true && 'body' in r && r.body?.limit === 16384);
});

test('lanes route: accounts off and proxy off are 404 with their own texts', async () => {
  setAccountsEnabledForTest(() => false);
  assert.deepEqual([(await lanesRoute({})).status, (await lanesRoute({})).body], [404, { error: 'accounts disabled' }]);
  setAccountsEnabledForTest(() => true);
  setProxyConfigForTest(() => ({ enabled: false, port: 0 }));
  const off = await lanesRoute({ desktop: { enabled: true } });
  assert.deepEqual([off.status, off.body], [404, { error: 'accounts proxy disabled' }]);
  assert.throws(() => statSync(LANES_FILE), 'nothing is written');
});

test('lanes route: each invalid shape is 400 "invalid lanes" without the input, and writes nothing', async () => {
  const SECRET = 'SECRETINPUTVALUE';
  const many = Object.fromEntries(Array.from({ length: 33 }, (_v, i) => [`claude-m-${i}`, 'gpt-6']));
  const bad: unknown[] = [
    null,
    [],
    '"x"',
    { unknownkey: true },
    { gpt: { [SECRET]: true } },
    { desktop: { [SECRET]: true } },
    { desktop: { enabled: 'yes' } },
    { desktop: { enabled: 1 } },
    { desktop: true },
    { gpt: { enabled: 'true' } },
    { gpt: { models: [] } },
    { gpt: { models: 'x' } },
    { gpt: { models: many } },
    { gpt: { models: { 'bad name': 'gpt-6' } } },
    { gpt: { models: { '': 'gpt-6' } } },
    { gpt: { models: { [`${SECRET}${'x'.repeat(130)}`]: 'gpt-6' } } },
    { gpt: { models: { 'claude-a': `bad ${SECRET}` } } },
    { gpt: { models: { 'claude-a': '' } } },
    { gpt: { models: { 'claude-a': 5 } } },
    { gpt: { models: { 'claude-a': '-gpt' } } },
    { gpt: { models: JSON.parse('{"__proto__":"gpt-6"}') } },
  ];
  for (const b of bad) {
    const r = await lanesRoute(b);
    assert.deepEqual([r.status, r.body], [400, { error: 'invalid lanes' }], JSON.stringify(b)?.slice(0, 80));
  }
  // a body over 16 KiB is refused before the handler
  const big = await lanesRoute(JSON.stringify({ gpt: { models: { a: 'x'.repeat(17000) } } }));
  assert.ok(big.status >= 400 && big.status !== 500);
  assert.throws(() => statSync(LANES_FILE));
  assert.ok(![...outputs, auditText()].some((o) => o.includes(SECRET)), 'the input is not echoed or logged');
});

test('lanes route: the body merges over the lanes in effect; models sent replace the whole map; the file is 0600 and holds both keys', async () => {
  setProxyConfigForTest(() => ({ enabled: true, port: 0, desktop: true }));
  const first = await lanesRoute({ gpt: { enabled: true, models: { 'claude-haiku-5-5': 'gpt-6-astra', 'claude-opus-5-5': 'gpt-6' } } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { lanes: { gpt: { enabled: true, models: { 'claude-haiku-5-5': 'gpt-6-astra', 'claude-opus-5-5': 'gpt-6' } }, desktop: { enabled: true } }, source: { gpt: 'file', desktop: 'file' } });
  assert.equal(modeOf(LANES_FILE), 0o600);
  assert.deepEqual(fileJson(), { gpt: { enabled: true, models: { 'claude-haiku-5-5': 'gpt-6-astra', 'claude-opus-5-5': 'gpt-6' } }, desktop: { enabled: true } }, 'the desktop value of portboard.json (here: on) is written with it');
  // a field not sent keeps its value
  const second = await lanesRoute({ desktop: { enabled: false } });
  assert.deepEqual((second.body as any).lanes, { gpt: { enabled: true, models: { 'claude-haiku-5-5': 'gpt-6-astra', 'claude-opus-5-5': 'gpt-6' } }, desktop: { enabled: false } });
  // models sent replace the map; enabled is kept
  const third = await lanesRoute({ gpt: { models: { 'claude-sonnet-5-5': 'gpt-6-astra' } } });
  assert.deepEqual((third.body as any).lanes.gpt, { enabled: true, models: { 'claude-sonnet-5-5': 'gpt-6-astra' } });
  assert.deepEqual((await lanesRoute({ gpt: { models: {} } }).then((r) => r.body as any)).lanes.gpt, { enabled: true, models: {} });
  assert.deepEqual((await lanesRoute({}).then((r) => r.body as any)).lanes.desktop, { enabled: false }, 'an empty body changes nothing');
  const fields = new Set((await audit.query({ limit: 1000 })).filter((x) => x.route === 'POST /api/accounts/proxy/lanes').flatMap((x) => [...(x.target.fields ?? [])]));
  assert.ok(fields.has('gpt') && fields.has('desktop'), 'the audit line holds the key names');
  assert.ok(!auditText().includes('gpt-6-astra') && !auditText().includes('claude-haiku-5-5'), 'and no value');
});

test('lanes route: a lanes file that cannot be read is replaced by a good one made from the values in effect; a write that fails is 500', async () => {
  mkdirSync(CFG, { recursive: true });
  writeFileSync(LANES_FILE, JSON.stringify({ desktop: { enabled: true } }), { mode: 0o600 });
  chmodSync(LANES_FILE, 0o644);
  const r = await lanesRoute({ gpt: { enabled: true } });
  assert.equal(r.status, 200);
  assert.deepEqual((r.body as any).lanes, { gpt: { enabled: true, models: {} }, desktop: { enabled: false } }, 'the loose file was not used');
  assert.equal(modeOf(LANES_FILE), 0o600);
  // the config folder is a file: the write fails with a closed text
  rmSync(CFG, { recursive: true, force: true });
  writeFileSync(CFG, 'not a folder');
  const bad = await lanesRoute({ desktop: { enabled: true } });
  assert.deepEqual([bad.status, bad.body], [500, { error: 'lanes not written' }]);
  rmSync(CFG, { force: true });
});

test('lanes route: the proxy uses the new models at once, and the desktop route accepts a CONNECT once it is on', async () => {
  await claude();
  await codex();
  // lane off: a request for a Claude name goes to Anthropic
  assert.equal(await viaProxy(claudeBody('claude-opus-5-5')), 200);
  assert.equal(ups.at(-1)?.url.startsWith('https://api.anthropic.com/'), true);
  // the route turns the lane on with a mapping: the next request is converted and goes to chatgpt.com
  assert.equal((await lanesRoute({ gpt: { enabled: true, models: { 'claude-opus-5-5': 'gpt-6-astra' } } })).status, 200);
  assert.equal(await viaProxy(claudeBody('claude-opus-5-5')), 200);
  assert.equal(ups.at(-1)?.url, 'https://chatgpt.com/backend-api/codex/responses');
  // a model that is not listed still goes to Anthropic
  assert.equal(await viaProxy(claudeBody('claude-other-5')), 200);
  assert.equal(ups.at(-1)?.url.startsWith('https://api.anthropic.com/'), true);
  // a new map applies at once
  await lanesRoute({ gpt: { models: { 'claude-other-5': 'gpt-6' } } });
  assert.equal(await viaProxy(claudeBody('claude-opus-5-5')), 200);
  assert.equal(ups.at(-1)?.url.startsWith('https://api.anthropic.com/'), true);
  assert.equal(await viaProxy(claudeBody('claude-other-5')), 200);
  assert.equal(ups.at(-1)?.url, 'https://chatgpt.com/backend-api/codex/responses');
  // off again
  await lanesRoute({ gpt: { enabled: false } });
  assert.equal(await viaProxy(claudeBody('claude-other-5')), 200);
  assert.equal(ups.at(-1)?.url.startsWith('https://api.anthropic.com/'), true);
  // the desktop route: refused while off, accepted once the route turned it on, refused again after it is turned off
  assert.match(await connectApi(), /^HTTP\/1\.1 403/);
  assert.equal((await lanesRoute({ desktop: { enabled: true } })).status, 200);
  assert.match(await connectApi(), /^HTTP\/1\.1 200/);
  assert.equal((await lanesRoute({ desktop: { enabled: false } })).status, 200);
  assert.match(await connectApi(), /^HTTP\/1\.1 403/);
});

test('the accounts-proxy job reads the lanes file each run (an edited file applies within a minute)', async () => {
  const job = accountsFeature.jobs?.find((j) => j.name === 'accounts-proxy');
  assert.ok(job);
  mkdirSync(CFG, { recursive: true });
  writeFileSync(LANES_FILE, JSON.stringify({ gpt: { enabled: true, models: { 'claude-a-5': 'gpt-6' } }, desktop: { enabled: true } }), { mode: 0o600 });
  await job.run({} as never);
  assert.deepEqual(proxy.report().lanes, { gpt: { enabled: true, models: { 'claude-a-5': 'gpt-6' } }, desktop: { enabled: true }, source: { gpt: 'file', desktop: 'file' }, unreadable: false });
  chmodSync(LANES_FILE, 0o644);
  await job.run({} as never);
  const r = proxy.report().lanes;
  assert.deepEqual([r.unreadable, r.gpt.enabled, r.desktop.enabled, r.source], [true, false, false, { gpt: 'config', desktop: 'config' }]);
});

test('lanes route: the largest valid map (32 names and model ids of 128 characters) is accepted', async () => {
  const models = Object.fromEntries(Array.from({ length: 32 }, (_v, i) => [`${'n'.repeat(120)}${String(i).padStart(8, '0')}`, 'g'.repeat(128)]));
  const size = Buffer.byteLength(JSON.stringify({ gpt: { models } }));
  assert.ok(size > 8192 && size < 16384, `${size} bytes`);
  const r = await lanesRoute({ gpt: { models } });
  assert.equal(r.status, 200);
  assert.equal(Object.keys(fileJson().gpt.models).length, 32);
});

test('lanes route: the desktop route turned on with a certificate that cannot be used is undone: 500, the file still says off, the proxy is listening', async () => {
  mkdirSync(CFG, { recursive: true });
  writeFileSync(CERT_FILE, 'not a certificate', { mode: 0o600 });
  await lanesRoute({ gpt: { enabled: true } });
  const r = await lanesRoute({ desktop: { enabled: true } });
  assert.deepEqual([r.status, r.body], [500, { error: 'desktop route certificate unusable' }]);
  assert.deepEqual(fileJson(), { gpt: { enabled: true, models: {} }, desktop: { enabled: false } });
  assert.equal(proxy.report().state, 'listening');
  assert.equal(proxy.report().lanes.desktop.enabled, false);
  assert.equal((await keyRoute()).status, 200, 'the proxy still answers');
  // a good certificate: the same request works
  rmSync(CERT_FILE);
  assert.equal((await lanesRoute({ desktop: { enabled: true } })).status, 200);
  assert.equal(proxy.report().state, 'listening');
});

test('lanes route: two posts at once both apply, and each answer holds at least its own change', async () => {
  const [a, b] = await Promise.all([lanesRoute({ gpt: { enabled: true } }), lanesRoute({ desktop: { enabled: true } })]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal((a.body as any).lanes.gpt.enabled, true);
  assert.equal((b.body as any).lanes.desktop.enabled, true);
  assert.deepEqual(fileJson(), { gpt: { enabled: true, models: {} }, desktop: { enabled: true } });
  const r = proxy.report().lanes;
  assert.deepEqual([r.gpt.enabled, r.desktop.enabled], [true, true]);
});

test('report: a process that never synced reads the lanes from the file (GET /api/accounts)', async () => {
  mkdirSync(CFG, { recursive: true });
  writeFileSync(LANES_FILE, JSON.stringify({ gpt: { enabled: true, models: { 'claude-a-5': 'gpt-6' } }, desktop: { enabled: true } }), { mode: 0o600 });
  const never = new AccountsProxy({ ...homesOpts(), keyPath: KEY_FILE });
  setAccountsOptionsForTest(() => ({ ...homesOpts(), proxy: never }));
  const ctx = context();
  const req = fakeReq('127.0.0.1', { 'x-portboard': '1' });
  req.method = 'GET';
  const out = await appRouter(REGISTRY.routes, ctx)(req, new URL('http://x/api/accounts'), ctx);
  assert.equal(out!.status, 200);
  const p = (out!.body as any).proxy;
  assert.equal(p.state, 'unknown');
  assert.deepEqual(p.lanes, { gpt: { enabled: true, models: { 'claude-a-5': 'gpt-6' } }, desktop: { enabled: true }, source: { gpt: 'file', desktop: 'file' }, unreadable: false });
  // the tool reads the same
  const tool = accountsFeature.tools?.find((t) => t.def.name === 'list_accounts');
  const text = (await tool!.call({} as never, {} as never)) as { content: { text: string }[] };
  assert.deepEqual(JSON.parse(text.content[0].text).proxy.lanes.source, { gpt: 'file', desktop: 'file' });
});

// ---- the key route and the report ----

test('key route: answers certFile, the path of the desktop route certificate, whether or not the file exists yet', async () => {
  const r = await keyRoute();
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body as object), ['key', 'keyFile', 'certFile']);
  assert.equal((r.body as { certFile: string }).certFile, CERT_FILE);
  assert.throws(() => statSync(CERT_FILE), 'not made until the route is on');
  const own = new AccountsProxy({ ...homesOpts(), keyPath: KEY_FILE, certPath: join(FAKE_HOME, 'other-cert.pem') });
  assert.equal(own.certFile(), join(FAKE_HOME, 'other-cert.pem'));
  // owner only, like keyFile
  assert.equal((await route('/api/accounts/proxy/key', {}, { 'x-portboard': '1' }, '100.64.0.9')).status, 403);
});

test('report: lanes and activity; the counters move on a lane request and on a CONNECT; no key, token or host in it', async () => {
  const idle = proxy.report();
  assert.deepEqual(idle.lanes, { gpt: { enabled: false, models: {} }, desktop: { enabled: false }, source: { gpt: 'config', desktop: 'config' }, unreadable: false });
  assert.deepEqual(idle.activity, { gpt: { requests: 0, lastAt: null }, desktop: { connects: 0, open: 0, lastAt: null } });
  await codex();
  await lanesRoute({ gpt: { enabled: true, models: { 'claude-opus-5-5': 'gpt-6-astra' } }, desktop: { enabled: true } });
  assert.equal(await viaProxy(claudeBody('claude-opus-5-5')), 200);
  assert.equal(await viaProxy(claudeBody('claude-opus-5-5'), '/v1/messages/count_tokens'), 200);
  assert.match(await connectApi(), /^HTTP\/1\.1 200/);
  assert.match(await connectApi('wrong-key'), /^HTTP\/1\.1 407/);
  const r = proxy.report();
  assert.equal(r.activity.gpt.requests, 1, 'a converted request counts; the count_tokens estimate does not');
  assert.equal(r.activity.desktop.connects, 1, 'only an authorized CONNECT counts');
  assert.equal(r.activity.desktop.open, 1);
  for (const at of [r.activity.gpt.lastAt, r.activity.desktop.lastAt]) assert.ok(at && !Number.isNaN(Date.parse(at)));
  assert.deepEqual(r.lanes, { gpt: { enabled: true, models: { 'claude-opus-5-5': 'gpt-6-astra' } }, desktop: { enabled: true }, source: { gpt: 'file', desktop: 'file' }, unreadable: false });
  const text = JSON.stringify(r);
  for (const bad of [key, CODEX_TOKEN, 'api.anthropic.com', 'cx-lanes']) assert.ok(!text.includes(bad), bad);
  // the report of a proxy that never synced says what portboard.json says
  const fresh = new AccountsProxy({ ...homesOpts(), keyPath: KEY_FILE });
  assert.deepEqual(fresh.report().activity, idle.activity);
});

// ---- the page ----

const doc = new FakeDocument();
const win = { ClipboardItem: class { data: Record<string, Promise<Blob>>; constructor(d: Record<string, Promise<Blob>>) { this.data = d; } } };
// the fake DOM has no input.select()
(doc.createElement('input') as any).constructor.prototype.select = () => {};
const clip = { writes: [] as string[], mode: 'item' as 'item' | 'text' | 'none' };
Object.assign(globalThis, { document: doc, window: win, ClipboardItem: win.ClipboardItem });
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    clipboard: {
      write: async (items: { data: Record<string, Promise<Blob>> }[]) => {
        if (clip.mode !== 'item') throw new Error('blocked');
        clip.writes.push(await (await items[0].data['text/plain']).text());
      },
      writeText: async (text: string) => {
        if (clip.mode === 'none') throw new Error('blocked');
        clip.writes.push(text);
      },
    },
  },
});

const UI_KEY = 'pbp-0123456789abcdef0123456789abcdef';
const UI_CERT = '/home/example/.config/portboard/accounts-proxy-cert.pem';
const UI_KEY_FILE = '/home/example/.config/portboard/accounts-proxy.key';
const SEEN = '2026-11-24T09:00:00.000Z';
const proxyReport = (over: Record<string, unknown> = {}) => ({
  enabled: true, state: 'listening', port: 8795, url: 'http://127.0.0.1:8795', current: { claude: null, codex: null }, resting: [], events: [], counts: { requests: 3, switches: 1 }, unproxied: [],
  lanes: { gpt: { enabled: false, models: { 'claude-haiku-5-5': 'gpt-6-astra' } }, desktop: { enabled: true }, source: { gpt: 'file', desktop: 'file' }, unreadable: false },
  activity: { gpt: { requests: 2, lastAt: SEEN }, desktop: { connects: 5, open: 1, lastAt: null } },
  ...over,
});
const posts: { path: string; body: any }[] = [];
let current: ReturnType<typeof proxyReport> = proxyReport();
let lanesAnswer: { status: number; body: unknown } = { status: 200, body: { lanes: {}, source: {} } };
const uiFetch = (async (path: string, init?: RequestInit) => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (init?.method === 'POST') {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    posts.push({ path: String(path), body });
    if (path === 'api/accounts/proxy/lanes') return reply(lanesAnswer.status, lanesAnswer.body);
    if (path === 'api/accounts/proxy/key') return reply(200, { key: UI_KEY, keyFile: UI_KEY_FILE, certFile: UI_CERT });
    return reply(404, { error: 'unexpected' });
  }
  return reply(200, { at: SEEN, accounts: [], proxy: current });
}) as unknown as typeof fetch;

const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const buttons = () => doc.querySelectorAll('button');
const button = (label: string) => {
  const b = buttons().find((x) => x.textContent === label);
  assert.ok(b, `a button "${label}"`);
  return b!;
};
const switchOf = (label: string) => {
  const i = doc.querySelectorAll('input').find((x) => x.getAttribute('role') === 'switch' && x.getAttribute('aria-label') === label);
  assert.ok(i, `a switch "${label}"`);
  return i!;
};
const names = {
  claude: L('Claude 이름', 'Claude name'),
  gpt: L('GPT 모델', 'GPT model'),
  save: L('저장', 'Save'),
  add: L('추가', 'Add'),
  remove: L('삭제', 'Remove'),
  copy: L('데스크톱 설정 복사', 'Copy desktop settings'),
  lanesGpt: L('GPT 경로', 'GPT lane'),
  lanesDesktop: L('데스크톱 경로', 'Desktop route'),
};
const modelRows = () => doc.querySelectorAll('div').filter((d) => d.dataset.lane === 'model');
const field = (row: any, label: string) => row.querySelectorAll('input').find((i: any) => i.getAttribute('aria-label') === label);
const everything = () => [doc.body.textContent, ...doc.querySelectorAll('input').map((i) => i.value)].join('\n');
const alerts = () => doc.querySelectorAll('span').filter((s) => s.getAttribute('role') === 'alert' && s.textContent !== '').map((s) => s.textContent).join('|');

/** Remove every row and save: the draft is clean again (the module keeps it between tests) */
async function clean() {
  for (const r of modelRows()) r.querySelectorAll('button').find((b: any) => b.textContent === names.remove)!.click();
  button(names.save).click();
  await tick();
}

async function show(report = proxyReport()) {
  current = report;
  posts.length = 0;
  clip.writes.length = 0;
  clip.mode = 'item';
  lanesAnswer = { status: 200, body: { lanes: {}, source: {} } };
  doc.dispatchEvent({ type: 'settings:refresh' });
  await tick();
}

test('page: the lanes controls are drawn, set up from the report, in the order the spec gives', async () => {
  globalThis.fetch = uiFetch;
  const body = doc.createElement('div');
  body.id = 'accountsBody';
  doc.body.append(body);
  await import('../public/features/accounts.js');
  doc.dispatchEvent({ type: 'settings:mount' });
  await tick();
  assert.equal(switchOf(names.lanesGpt).checked, false);
  assert.equal(switchOf(names.lanesDesktop).checked, true);
  assert.equal(modelRows().length, 1);
  assert.equal(field(modelRows()[0], names.claude).value, 'claude-haiku-5-5');
  assert.equal(field(modelRows()[0], names.claude).getAttribute('placeholder'), 'claude-haiku-5-5');
  assert.equal(field(modelRows()[0], names.gpt).value, 'gpt-6-astra');
  assert.equal(field(modelRows()[0], names.gpt).getAttribute('placeholder'), 'gpt-6-astra');
  assert.equal(button(names.copy).disabled, false, 'listening and the desktop route is on');
  const text = doc.body.textContent;
  const at = (s: string) => text.indexOf(s);
  const order = [L('Claude 명령 복사', 'Copy Claude command'), names.lanesGpt, names.lanesDesktop, L('모델 매핑', 'Model mapping'), names.copy, L('최근 기록', 'Recent events')].map(at);
  assert.ok(order.every((n) => n >= 0) && [...order].sort((a, b) => a - b).join() === order.join(), `order ${order}`);
  // every switch and the buttons are write controls
  for (const el of [switchOf(names.lanesGpt), button(names.save), button(names.add), button(names.copy), button(names.remove)]) assert.equal(el.dataset.write, '1');
  // a link to the desktop route section of the guide
  assert.ok(doc.querySelectorAll('a').some((a) => /accounts\.md#desktop-route$/.test(a.href)));
});

test('page: the status line, with "–" for a time that is null and the latest time otherwise', async () => {
  const when = new Date(SEEN).toLocaleString(L('ko', 'en'));
  await show();
  assert.ok(doc.body.textContent.includes(L(`GPT 요청 2개 · 데스크톱 연결 5개, 지금 1개 · 마지막 ${when}`, `GPT requests 2 · desktop connections 5, 1 open now · last ${when}`)));
  await show(proxyReport({ activity: { gpt: { requests: 0, lastAt: null }, desktop: { connects: 0, open: 0, lastAt: null } } }));
  assert.ok(doc.body.textContent.includes(L('GPT 요청 0개 · 데스크톱 연결 0개, 지금 0개 · 마지막 –', 'GPT requests 0 · desktop connections 0, 0 open now · last –')));
});

test('page: a switch posts its own body at once and the block is drawn again; on an error it goes back and says why', async () => {
  await show();
  const gpt = switchOf(names.lanesGpt);
  gpt.checked = true;
  gpt.dispatch('change');
  await tick();
  assert.deepEqual(posts, [{ path: 'api/accounts/proxy/lanes', body: { gpt: { enabled: true } } }]);
  assert.equal(doc.querySelectorAll('input').filter((i) => i.getAttribute('role') === 'switch').length, 2, 'drawn again');
  await show();
  const desktop = switchOf(names.lanesDesktop);
  desktop.checked = false;
  desktop.dispatch('change');
  await tick();
  assert.deepEqual(posts, [{ path: 'api/accounts/proxy/lanes', body: { desktop: { enabled: false } } }]);
  // an error: back to the old position, enabled again, the error text shown
  await show();
  lanesAnswer = { status: 500, body: { error: 'lanes not written' } };
  const again = switchOf(names.lanesDesktop);
  again.checked = false;
  again.dispatch('change');
  await tick();
  assert.equal(again.checked, true);
  assert.equal(again.disabled, false);
  assert.equal(alerts(), L('설정을 저장하지 못했어요.', 'The settings could not be saved.'));
  lanesAnswer = { status: 400, body: { error: 'invalid lanes' } };
  const gpt2 = switchOf(names.lanesGpt);
  gpt2.checked = true;
  gpt2.dispatch('change');
  await tick();
  assert.equal(gpt2.checked, false);
  assert.equal(alerts(), L('Claude 이름과 GPT 모델의 모양을 확인하세요. 한 줄에 둘 다 있어야 하고, 최대 32줄이에요.', 'Check the Claude name and the GPT model. Each line needs both, and there can be 32 lines at most.'));
});

test('page: the mapping adds, removes and saves rows; empty rows are skipped; models are the non-empty rows', async () => {
  await show();
  button(names.add).click();
  assert.equal(modelRows().length, 2);
  const [, added] = modelRows();
  field(added, names.claude).value = ' claude-opus-5-5 ';
  field(added, names.gpt).value = 'gpt-6';
  button(names.add).click();
  assert.equal(modelRows().length, 3, 'an empty row stays empty and is skipped');
  button(names.save).click();
  await tick();
  assert.deepEqual(posts, [{ path: 'api/accounts/proxy/lanes', body: { gpt: { models: { 'claude-haiku-5-5': 'gpt-6-astra', 'claude-opus-5-5': 'gpt-6' } } } }]);
  // remove the first row and save: only the new one is left
  await show();
  button(names.add).click();
  const rows = modelRows();
  field(rows[1], names.claude).value = 'claude-opus-5-5';
  field(rows[1], names.gpt).value = 'gpt-6';
  rows[0].querySelectorAll('button').find((b: any) => b.textContent === names.remove)!.click();
  assert.equal(modelRows().length, 1);
  button(names.save).click();
  await tick();
  assert.deepEqual(posts, [{ path: 'api/accounts/proxy/lanes', body: { gpt: { models: { 'claude-opus-5-5': 'gpt-6' } } } }]);
  // every row removed: an empty map is saved (it empties the list)
  await show();
  modelRows()[0].querySelectorAll('button').find((b: any) => b.textContent === names.remove)!.click();
  button(names.save).click();
  await tick();
  assert.deepEqual(posts[0].body, { gpt: { models: {} } });
});

test('page: a bad row is not posted and the buttons show why', async () => {
  const invalid = L('Claude 이름과 GPT 모델의 모양을 확인하세요. 한 줄에 둘 다 있어야 하고, 최대 32줄이에요.', 'Check the Claude name and the GPT model. Each line needs both, and there can be 32 lines at most.');
  const bad: [string, string][] = [['has space', 'gpt-6'], ['claude-a', 'bad model'], ['claude-a', ''], ['', 'gpt-6'], ['claude-a', '-gpt'], ['claude-a', 'g'.repeat(129)], ['c'.repeat(129), 'gpt-6'], ['__proto__', 'gpt-6'], ['클로드', 'gpt-6']];
  for (const [name, model] of bad) {
    await show();
    button(names.add).click();
    field(modelRows()[1], names.claude).value = name;
    field(modelRows()[1], names.gpt).value = model;
    button(names.save).click();
    await tick();
    assert.deepEqual(posts, [], `${name} / ${model}`);
    assert.ok(doc.body.textContent.includes(invalid), `${name} / ${model}`);
    await clean();
  }
  // more than 32 rows
  await show(proxyReport({ lanes: { gpt: { enabled: true, models: {} }, desktop: { enabled: false }, source: { gpt: 'file', desktop: 'file' }, unreadable: false } }));
  for (let i = 0; i < 33; i++) {
    button(names.add).click();
    const r = modelRows().at(-1)!;
    field(r, names.claude).value = `claude-m-${i}`;
    field(r, names.gpt).value = 'gpt-6';
  }
  button(names.save).click();
  await tick();
  assert.deepEqual(posts, []);
  await clean();
  // a server error on a good map is shown, and the rows stay
  await show();
  lanesAnswer = { status: 400, body: { error: 'invalid lanes' } };
  button(names.save).click();
  await tick();
  assert.equal(posts.length, 1);
  assert.equal(alerts(), invalid);
  assert.equal(modelRows().length, 1);
});

test('page: unsaved rows survive a redraw (a switch posts only its own body); Save posts them and clears the note', async () => {
  const unsaved = L('저장하지 않은 변경이 있어요.', 'Unsaved changes.');
  await show();
  const note = () => doc.querySelectorAll('span').find((x) => x.textContent === unsaved)!;
  assert.equal(note().hidden, true);
  button(names.add).click();
  assert.equal(note().hidden, false);
  const typed = field(modelRows()[1], names.claude);
  typed.value = 'claude-opus-5-5';
  typed.dispatch('input');
  const model = field(modelRows()[1], names.gpt);
  model.value = 'gpt-6';
  model.dispatch('input');
  posts.length = 0;
  const sw = switchOf(names.lanesGpt);
  sw.checked = true;
  sw.dispatch('change');
  await tick();
  assert.deepEqual(posts, [{ path: 'api/accounts/proxy/lanes', body: { gpt: { enabled: true } } }]);
  // the block was drawn again from the report: the draft rows are still there
  assert.equal(modelRows().length, 2);
  assert.deepEqual([field(modelRows()[1], names.claude).value, field(modelRows()[1], names.gpt).value], ['claude-opus-5-5', 'gpt-6']);
  assert.equal(note().hidden, false);
  // a settings:refresh keeps them too
  doc.dispatchEvent({ type: 'settings:refresh' });
  await tick();
  assert.equal(modelRows().length, 2);
  posts.length = 0;
  button(names.save).click();
  await tick();
  assert.deepEqual(posts, [{ path: 'api/accounts/proxy/lanes', body: { gpt: { models: { 'claude-haiku-5-5': 'gpt-6-astra', 'claude-opus-5-5': 'gpt-6' } } } }]);
  assert.equal(note().hidden, true);
  // the report now says what the server has: the rows are the report's again
  current = proxyReport({ lanes: { gpt: { enabled: true, models: { 'claude-opus-5-5': 'gpt-6' } }, desktop: { enabled: true }, source: { gpt: 'file', desktop: 'file' }, unreadable: false } });
  doc.dispatchEvent({ type: 'settings:refresh' });
  await tick();
  assert.equal(modelRows().length, 1);
  assert.equal(field(modelRows()[0], names.claude).value, 'claude-opus-5-5');
});

test('page: the three copy buttons reset each other: only the last one clicked says copied', async () => {
  const copied = L('복사했어요', 'Copied');
  await show();
  const labels = [L('Claude 명령 복사', 'Copy Claude command'), L('Codex 명령 복사', 'Copy Codex command'), names.copy];
  for (const first of labels) {
    for (const second of labels.filter((l) => l !== first)) {
      await show();
      button(first).click();
      await tick();
      button(second).click();
      await tick();
      const said = buttons().filter((b) => b.textContent === copied);
      assert.equal(said.length, 1, `${first} then ${second}`);
      assert.equal(buttons().filter((b) => labels.includes(b.textContent)).length, 2, 'the other two show their own labels');
    }
  }
});

test('page: "copy desktop settings" puts the JSON with the key on the clipboard (2-space JSON), and is disabled unless listening and the route is on', async () => {
  await show();
  button(names.copy).click();
  await tick();
  assert.deepEqual(posts, [{ path: 'api/accounts/proxy/key', body: {} }]);
  assert.equal(clip.writes.length, 1);
  const block = { env: { HTTPS_PROXY: `http://pb:${UI_KEY}@127.0.0.1:8795`, NODE_EXTRA_CA_CERTS: UI_CERT } };
  assert.equal(clip.writes[0], JSON.stringify(block, null, 2));
  assert.equal(button(L('복사했어요', 'Copied')).textContent, L('복사했어요', 'Copied'));
  assert.ok(!everything().includes(UI_KEY), 'the key is not drawn');
  // route off, or not listening: disabled
  await show(proxyReport({ lanes: { gpt: { enabled: false, models: {} }, desktop: { enabled: false }, source: { gpt: 'file', desktop: 'file' }, unreadable: false } }));
  assert.equal(button(names.copy).disabled, true);
  await show(proxyReport({ state: 'port in use', url: null }));
  assert.equal(button(names.copy).disabled, true);
});

test('page: when the clipboard cannot be used the field shows the block with KEY in the key\'s place and a note with the key file; the key is never drawn', async () => {
  await show();
  clip.mode = 'none';
  button(names.copy).click();
  await tick();
  assert.deepEqual(clip.writes, []);
  const inputs = doc.querySelectorAll('input').filter((i) => i.attrs.has('readonly'));
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].value, JSON.stringify({ env: { HTTPS_PROXY: 'http://pb:KEY@127.0.0.1:8795', NODE_EXTRA_CA_CERTS: UI_CERT } }));
  assert.ok(doc.body.textContent.includes(L(`KEY 자리에 키 파일(${UI_KEY_FILE})의 내용을 넣으세요.`, `Put the contents of the key file (${UI_KEY_FILE}) where it says KEY.`)));
  assert.ok(!everything().includes(UI_KEY));
  // writeText works but write does not: the text goes on the clipboard through the second way
  await show();
  clip.mode = 'text';
  button(names.copy).click();
  await tick();
  assert.equal(clip.writes[0], JSON.stringify({ env: { HTTPS_PROXY: `http://pb:${UI_KEY}@127.0.0.1:8795`, NODE_EXTRA_CA_CERTS: UI_CERT } }, null, 2));
});

test('page: a lanes file that cannot be read shows its warning; a readable one shows none', async () => {
  const warn = L('accounts-lanes.json을 읽을 수 없어 portboard.json 값을 써요. 파일을 본인만 읽게 고치세요.', 'accounts-lanes.json cannot be read, so the portboard.json values are used. Make the file readable by you only.');
  await show();
  assert.ok(!doc.body.textContent.includes(warn));
  await show(proxyReport({ lanes: { gpt: { enabled: false, models: {} }, desktop: { enabled: false }, source: { gpt: 'config', desktop: 'config' }, unreadable: true } }));
  const line = doc.querySelectorAll('p').find((p) => p.textContent === warn);
  assert.ok(line);
  assert.ok(line!.classList.contains('set-state') && line!.classList.contains('warn'));
  // no lanes controls while the proxy is off or its state is not known
  await show(proxyReport({ enabled: false }));
  assert.equal(doc.querySelectorAll('input').filter((i) => i.getAttribute('role') === 'switch').length, 0);
  await show(proxyReport({ state: 'unknown' }));
  assert.equal(doc.querySelectorAll('input').filter((i) => i.getAttribute('role') === 'switch').length, 0);
});

test('page: the page draws no key and no Korean text of its own (source check), and uses the shared controls only', () => {
  const src = read('public/features/accounts.js');
  assert.match(src, /import \{ toggle \} from '\.\.\/lib\/controls\.js';/);
  assert.match(src, /api\/accounts\/proxy\/lanes/);
  const block = src.slice(src.indexOf('function lanesNodes'), src.indexOf('/** The proxy block under the list'));
  assert.match(block, /new ClipboardItem\(\{ 'text\/plain': blob \}\)/);
  assert.match(block, /JSON\.stringify\(block\('KEY'\)\)/);
  assert.doesNotMatch(block, /textContent = (?:key|got\.command)/);
  assert.doesNotMatch(block, /showManual\(got\.command/);
  assert.doesNotMatch(block, /style\s*[=:]|\.style\./, 'no inline style');
});

test('i18n: both catalogs have every accounts.lanes key the page uses, with the same placeholders', () => {
  const ko = JSON.parse(read('public/i18n/ko.json'));
  const en = JSON.parse(read('public/i18n/en.json'));
  const used = [...new Set([...read('public/features/accounts.js').matchAll(/'(accounts\.lanes\.[A-Za-z.]+)'/g)].map((m) => m[1]))];
  assert.ok(used.length >= 17, `${used.length} keys`);
  const holders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  for (const k of used) {
    assert.equal(typeof ko[k], 'string', `ko ${k}`);
    assert.equal(typeof en[k], 'string', `en ${k}`);
    assert.equal(holders(ko[k]), holders(en[k]), k);
  }
  const all = (c: Record<string, string>) => Object.keys(c).filter((k) => k.startsWith('accounts.lanes.')).sort();
  assert.deepEqual(all(ko), all(en));
  assert.deepEqual(all(ko), [...used].sort(), 'no catalog key without a use');
  // the server's closed error texts of the new route map to these keys
  assert.match(read('public/features/accounts.js'), /\^invalid lanes\$/);
  assert.match(read('public/features/accounts.js'), /\^lanes not written\$/);
});

test.after(() => {
  globalThis.fetch = realFetch;
});
