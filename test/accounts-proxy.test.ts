// The accounts proxy (docs/accounts.md#proxy, src/core/accounts/proxy.ts and pool.ts): the loopback listener, the key, the
// paths, the headers, the stream, the switch to the next account on a rejected shared limit, the rest of an account, the
// tokens, the report and the key route. The upstream is a fake fetch; the listener is a real one on 127.0.0.1 port 0.
// HOME, the config folders, accounts.json, the account folders and the proxy key are mkdtemp paths. No real endpoint is
// called and no real ~/.claude or ~/.codex is read. Every token and the proxy key are checked for in every output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

// Safety net first (src/ is imported dynamically, after these lines).
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'pb-proxy-'));
globalThis.fetch = (() => {
  throw new Error('test reached the real fetch: inject one');
}) as typeof fetch;
process.env.HOME = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, 'claude-dir');
process.env.CODEX_HOME = join(FAKE_HOME, 'codex-dir');
for (const k of Object.keys(process.env)) if (k.startsWith('PORTBOARD_') && k !== 'PORTBOARD_LOCALE') delete process.env[k];
const FILE = join(FAKE_HOME, 'accounts.json');
const HOMES = join(FAKE_HOME, 'account-homes');
const KEY_FILE = join(FAKE_HOME, 'cfg', 'accounts-proxy.key');
process.env.PORTBOARD_ACCOUNTS = FILE;
process.env.PORTBOARD_ACCOUNT_HOMES = HOMES;
process.env.PORTBOARD_ACCOUNTS_PROXY_KEY = KEY_FILE;

const { AccountsProxy, PROXY_HOST, PROXY_REQUESTS, proxyHoldsPort, setProxyConfigForTest, upstreamRequest } = await import('../src/core/accounts/proxy.ts');
const { verdictOf, DEFAULT_REST_MS, MAX_REST_MS } = await import('../src/core/accounts/pool.ts');
const { LOGIN_REQUESTS } = await import('../src/core/accounts/flows.ts');
const { refreshAccount, resetRefreshForTest } = await import('../src/core/accounts/refresh.ts');
const { useAccount } = await import('../src/core/accounts/homes.ts');
const { loadAccounts, updateAccount, upsertAccount } = await import('../src/core/accounts/store.ts');
const { accountsReport } = await import('../src/core/accounts/view.ts');
const { clearQuotaCache } = await import('../src/core/accounts/quota.ts');
const { PATHS, resolvePaths } = await import('../src/core/paths.ts');
const { accountsConfig, SITE_DEFAULTS } = await import('../src/core/site.ts');
const { accountsFeature, setAccountsEnabledForTest, setAccountsOptionsForTest } = await import('../src/features/accounts.ts');
const { isEnabled } = await import('../src/features/jobs.ts');
const { appRouter } = await import('../src/features/router.ts');
const { REGISTRY } = await import('../src/features/registry.ts');
const { callTool } = await import('../src/mcp/tools.ts');
const { TAILSCALE_POLICY } = await import('../src/core/access.ts');
const { AuditLog } = await import('../src/core/audit.ts');
const { snapshot } = await import('../src/core/index.ts');
type ServerContext = import('../src/features/context.ts').ServerContext;
type Core = import('../src/mcp/kit.ts').Core;
type Proxy = InstanceType<typeof AccountsProxy>;

const NOW = Date.parse('2026-11-23T09:00:00Z');
let clock = NOW;
const now = () => clock;
const iso = (ms: number) => new Date(ms).toISOString();
const OWNER = 'owner@example.com';
const TOKEN = { A: 'sk-ant-oat01-TESTTOKENA0123456789', B: 'sk-ant-oat01-TESTTOKENB0123456789', C: 'sk-ant-oat01-TESTTOKENC0123456789', D: 'sk-ant-oat01-TESTTOKEND0123456789', E: 'sk-ant-oat01-TESTTOKENE0123456789' };
const REFRESH = 'sk-ant-ort01-TESTREFRESH0123456789';
const TOKEN_NEW = 'sk-ant-oat01-TESTTOKENNEW0123456789';
const TOKEN_FOLDER = 'sk-ant-oat01-TESTTOKENFOLDER0123456789';
const TOKEN_LOCAL = 'sk-ant-oat01-TESTTOKENLOCAL0123456789';
const MARKERS = ['TESTTOKEN', 'TESTREFRESH'];

// ---- the fake upstream ----

interface Up {
  url: string;
  token: string;
  headers: Record<string, string>;
  body: Buffer;
  signal: AbortSignal;
  redirect: RequestRedirect | undefined;
}
const ups: Up[] = [];
/** The answer of the fake upstream for one request; the default is a 200 that names the token it got */
let upstream: (u: Up) => Response | Promise<Response> = (u) => ok(nameOf(u.token));
const ok = (marker: string) => new Response(JSON.stringify({ type: 'message', marker }), { status: 200, headers: { 'content-type': 'application/json', 'x-answer-from': marker } });
const fake = (async (url: string | URL | Request, init?: RequestInit) => {
  const headers = Object.fromEntries(new Headers(init?.headers as Record<string, string>));
  const u: Up = {
    url: String(url),
    token: (headers.authorization ?? '').replace(/^Bearer /, ''),
    headers,
    body: Buffer.from((init?.body as Buffer | undefined) ?? Buffer.alloc(0)),
    signal: init?.signal as AbortSignal,
    redirect: init?.redirect,
  };
  ups.push(u);
  return upstream(u);
}) as typeof fetch;
const nameOf = (token: string) => Object.entries(TOKEN).find(([, v]) => v === token)?.[0] ?? '?';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const rejected = (marker: string, reset: number, window: '5h' | '7d' = '5h', extra: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: 'error', marker }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-status': 'rejected',
      [`anthropic-ratelimit-unified-${window}-status`]: 'rejected',
      [`anthropic-ratelimit-unified-${window}-reset`]: String(reset),
      'x-answer-from': marker,
      ...extra,
    },
  });

// ---- the proxy under test ----

const homesOpts = () => ({
  fetch: fake,
  now,
  accountsPath: FILE,
  accountHomes: HOMES,
  home: FAKE_HOME,
  env: { CLAUDE_CONFIG_DIR: join(FAKE_HOME, 'c'), CODEX_HOME: join(FAKE_HOME, 'x') },
  platform: 'linux',
});
let proxy: Proxy;
let key = '';
const proxyOf = (extra: Record<string, unknown> = {}): Proxy => new AccountsProxy({ ...homesOpts(), keyPath: KEY_FILE, ...extra });
const portOf = () => proxy.report().port;

const logged: string[] = [];
const outputs: string[] = [];
const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
const AUDIT_DIR = mkdtempSync(join(FAKE_HOME, 'audit-'));
const audit = new AuditLog(join(AUDIT_DIR, 'audit.jsonl'));
const auditText = () => readdirSync(AUDIT_DIR).map((f) => readFileSync(join(AUDIT_DIR, f), 'utf8')).join('\n');

test.beforeEach(async () => {
  resetRefreshForTest();
  clearQuotaCache();
  rmSync(FILE, { force: true });
  rmSync(HOMES, { recursive: true, force: true });
  rmSync(join(FAKE_HOME, 'cfg'), { recursive: true, force: true });
  ups.length = 0;
  upstream = (u) => ok(nameOf(u.token));
  clock = NOW;
  logged.length = 0;
  outputs.length = 0;
  for (const k of Object.keys(saved) as (keyof typeof saved)[]) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
  setAccountsEnabledForTest(() => true);
  proxy = proxyOf();
  setAccountsOptionsForTest(() => ({ ...homesOpts(), proxy }));
  setProxyConfigForTest(() => ({ enabled: true, port: 0 }));
  await proxy.sync({ enabled: true, port: 0 });
  key = await proxy.key();
});
test.afterEach(async () => {
  await proxy.close();
  Object.assign(console, saved);
  setAccountsEnabledForTest(null);
  setAccountsOptionsForTest(null);
  setProxyConfigForTest(null);
  // test 11: no token and no key in an answer, the report, the audit file or the console
  for (const o of [...outputs, ...logged, auditText()]) {
    for (const m of MARKERS) assert.ok(!o.includes(m), `output holds ${m}`);
    if (key) assert.ok(!o.includes(key), 'output holds the proxy key');
  }
});

// ---- records ----

let seq = 0;
type Tokens = { access: string; refresh: string | null; idToken: string | null; expiresAt: string | null };
const claude = (access: string, extra: Record<string, unknown> = {}, tokens: Partial<Tokens> = {}) =>
  upsertAccount(
    { provider: 'claude', alias: `acct-${seq}`, identity: `uuid-px-${seq++}`, email: 'a@example.com', plan: 'max', tier: 'default_claude_max_5x', subscriptionType: 'max', tokens: { access, refresh: REFRESH, idToken: null, expiresAt: iso(NOW + 100 * 3600_000), ...tokens }, ...extra },
    { path: FILE, now },
  );
const stored = async () => {
  const r = await loadAccounts({ path: FILE });
  assert.ok('accounts' in r);
  return r;
};
const claudeFile = (id: string) => join(HOMES, id, '.credentials.json');
const rewriteFolder = (id: string, access: string, expiresAt: number) => {
  const doc = JSON.parse(readFileSync(claudeFile(id), 'utf8'));
  doc.claudeAiOauth.accessToken = access;
  doc.claudeAiOauth.expiresAt = expiresAt;
  writeFileSync(claudeFile(id), JSON.stringify(doc));
};

// ---- the client ----

interface Got {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text: string;
  json: any;
}
interface CallOpts {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  auth?: 'bearer' | 'api-key' | 'none';
  key?: string;
}
function open(o: CallOpts = {}, port = portOf()) {
  const method = o.method ?? 'POST';
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  const k = o.key ?? key;
  if ((o.auth ?? 'bearer') === 'bearer') headers.authorization = `Bearer ${k}`;
  else if (o.auth === 'api-key') headers['x-api-key'] = k;
  const req = httpRequest({ host: PROXY_HOST, port, path: o.path ?? '/v1/messages', method, headers, agent: false });
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req.on('response', resolve);
    req.on('error', reject);
  });
  req.end(o.body ?? '{"model":"x","messages":[]}');
  return { req, response };
}
async function call(o: CallOpts = {}, port = portOf()): Promise<Got> {
  const { response } = open(o, port);
  const res = await response;
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const text = body.toString('utf8');
  outputs.push(text, JSON.stringify(res.headers));
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.statusCode ?? 0, headers: res.headers, body, text, json: parsed };
}
const report = () => {
  const r = proxy.report();
  outputs.push(JSON.stringify(r));
  return r;
};

// ---- 1. off ----

test('off: no listener and state off when accounts.proxy.enabled is missing, accounts.enabled is off, or this is a preview', async () => {
  // the settings: both flags, and a port from 1024 to 65535
  assert.deepEqual(accountsConfig(undefined), { enabled: false, proxy: { enabled: false, port: 8795 } });
  assert.deepEqual(accountsConfig({ enabled: true }).proxy, { enabled: false, port: 8795 });
  assert.deepEqual(accountsConfig({ enabled: true, proxy: { enabled: 'true' } }).proxy, { enabled: false, port: 8795 }, 'only true turns it on');
  assert.deepEqual(accountsConfig({ proxy: { enabled: true, port: 8801 } }), { enabled: false, proxy: { enabled: true, port: 8801 } });
  for (const port of [1023, 65536, 8801.5, '8801', null, 0, -1]) assert.equal(accountsConfig({ proxy: { port } }).proxy.port, 8795, String(port));
  assert.deepEqual(SITE_DEFAULTS.accounts, { enabled: false, proxy: { enabled: false, port: 8795 } });

  const job = (accountsFeature.jobs ?? []).find((j) => j.name === 'accounts-proxy');
  assert.ok(job && job.runAtStart === true && job.everyMs === 60_000);
  assert.ok(REGISTRY.jobs.includes(job));
  const run = () => job.run({} as ServerContext);
  const off = new AccountsProxy({ ...homesOpts(), keyPath: KEY_FILE });
  setAccountsOptionsForTest(() => ({ ...homesOpts(), proxy: off }));

  setProxyConfigForTest(() => ({ enabled: false, port: 0 }));
  await run();
  assert.equal(off.report().state, 'off');
  assert.equal(off.boundPort(), 0);

  setProxyConfigForTest(() => ({ enabled: true, port: 0 }));
  setAccountsEnabledForTest(() => false);
  await run();
  assert.equal(off.report().state, 'off', 'accounts.enabled off');
  assert.equal(off.boundPort(), 0);
  assert.equal(off.report().enabled, false);

  // a preview: the job is not enabled, whatever the settings say
  assert.equal(isEnabled(job, resolvePaths({ PORTBOARD_PORT: '8808' }, '/home/x')), false);
  assert.equal(isEnabled(job, resolvePaths({}, '/home/x')), true);
  assert.equal(off.report().state, 'off');

  // on: both flags, a production process
  setAccountsEnabledForTest(() => true);
  await run();
  const r = off.report();
  assert.deepEqual([r.enabled, r.state, r.url], [true, 'listening', `http://127.0.0.1:${r.port}`]);
  // the settings go off again: the listener closes
  setProxyConfigForTest(() => ({ enabled: false, port: 0 }));
  await run();
  assert.equal(off.report().state, 'off');
  assert.equal(off.boundPort(), 0);
  await off.close();
});

test('the listener binds 127.0.0.1 only and the address is a constant', async () => {
  // another loopback address does not reach it
  const outcome = await new Promise<string>((resolve) => {
    const sock = connect({ host: '127.0.0.2', port: portOf() });
    sock.once('connect', () => resolve('connected'));
    sock.once('error', () => resolve('refused'));
  });
  assert.equal(outcome, 'refused');
  assert.equal(PROXY_HOST, '127.0.0.1');
  const src = readFileSync(new URL('../src/core/accounts/proxy.ts', import.meta.url), 'utf8');
  assert.equal(src.match(/\.listen\(/g)?.length, 1);
  assert.match(src, /server\.listen\(port, PROXY_HOST,/);
  // the upstream URL is in one block, and nowhere else in src/
  assert.equal(src.match(/api\.anthropic\.com/g)?.length, 1);
  assert.equal(PROXY_REQUESTS.claude.origin, 'https://api.anthropic.com');
});

test('the port in use is a state, not a crash; the next run opens it when the port is free', async () => {
  const taken = new AccountsProxy({ ...homesOpts(), keyPath: KEY_FILE });
  const other = new AccountsProxy({ ...homesOpts(), keyPath: KEY_FILE });
  await taken.sync({ enabled: true, port: 0 });
  const port = taken.report().port;
  await other.sync({ enabled: true, port });
  assert.equal(other.report().state, 'port in use');
  assert.equal(other.report().url, null);
  assert.equal(logged.filter((l) => l.includes('accounts proxy')).length, 1, 'one console line');
  assert.match(logged.find((l) => l.includes('accounts proxy')) ?? '', new RegExp(`^\\[portboard\\] accounts proxy: port in use on 127\\.0\\.0\\.1:${port}$`));
  await other.sync({ enabled: true, port });
  assert.equal(logged.filter((l) => l.includes('accounts proxy')).length, 1, 'the same state is not said again');
  await taken.close();
  await other.sync({ enabled: true, port });
  assert.equal(other.report().state, 'listening');
  assert.equal(other.report().port, port);
  // a new port closes the old listener and opens the new one
  await other.sync({ enabled: true, port: 0 });
  assert.equal(other.report().state, 'listening');
  await other.close();
});

// ---- 2. admission ----

test('admission: no key and a wrong key are 401; an Origin and another Host are 403; the right key works as Bearer and as x-api-key; the key never goes upstream', async () => {
  await claude(TOKEN.A);
  const wrong = `pbp-${'0'.repeat(32)}`;
  const denied = { type: 'error', error: { type: 'authentication_error', message: 'proxy key required' } };
  for (const o of [{ auth: 'none' as const }, { key: wrong }, { key: 'x' }, { auth: 'api-key' as const, key: wrong }, { headers: { authorization: 'Basic abc' }, auth: 'none' as const }]) {
    const r = await call(o);
    assert.deepEqual([r.status, r.json], [401, denied]);
  }
  const forbidden = { type: 'error', error: { type: 'permission_error', message: 'not allowed' } };
  const withOrigin = await call({ headers: { origin: 'https://example.com' } });
  assert.deepEqual([withOrigin.status, withOrigin.json], [403, forbidden]);
  for (const host of ['evil.example', `127.0.0.1:${portOf() + 1}`, '127.0.0.1', `evil.example:${portOf()}`, `127.0.0.1.evil.example:${portOf()}`]) {
    const r = await call({ headers: { host } });
    assert.deepEqual([r.status, r.json], [403, forbidden], host);
  }
  assert.equal(ups.length, 0, 'nothing reached the vendor');
  for (const o of [{ auth: 'bearer' as const }, { auth: 'api-key' as const }, { headers: { host: `localhost:${portOf()}` } }]) {
    const r = await call(o);
    assert.equal(r.status, 200, JSON.stringify(o));
  }
  assert.equal(ups.length, 3);
  for (const u of ups) {
    assert.equal(u.token, TOKEN.A);
    assert.ok(!JSON.stringify(u.headers).includes(key), 'the proxy key is not in the upstream request');
    assert.ok(!u.body.toString().includes(key));
  }
});

// ---- 3. paths ----

test('paths: only POST /v1/messages and /v1/messages/count_tokens go on; other paths and methods are 404 "not proxied" and are counted without their query', async () => {
  await claude(TOKEN.A);
  const notFound = { type: 'error', error: { type: 'not_found_error', message: 'not proxied' } };
  for (const o of [{ method: 'GET', path: '/v1/messages' }, { method: 'POST', path: '/v1/models' }, { method: 'POST', path: '/v1/models?secret=QUERYVALUE' }, { method: 'PUT', path: '/v1/messages' }, { method: 'POST', path: '/v1/messages/' }, { method: 'POST', path: '/v1/messages/batches' }, { method: 'POST', path: '/' }]) {
    const r = await call(o);
    assert.deepEqual([r.status, r.json], [404, notFound], `${o.method} ${o.path}`);
  }
  assert.equal(ups.length, 0);
  const r = report();
  assert.deepEqual(Object.fromEntries(r.unproxied.map((x) => [x.path, x.count])), { '/': 1, '/v1/messages': 2, '/v1/messages/': 1, '/v1/messages/batches': 1, '/v1/models': 2 });
  assert.ok(!JSON.stringify(r).includes('QUERYVALUE'));
  assert.equal(r.counts.requests, 7);
  // the paths are clipped to 80 characters and at most 20 are kept
  await call({ path: `/${'a'.repeat(200)}` });
  assert.ok(proxy.report().unproxied.every((x) => x.path.length <= 80));
  for (let i = 0; i < 30; i++) await call({ path: `/x/${i}` });
  assert.equal(proxy.report().unproxied.length, 20);
  // the two paths go on, with their query
  assert.equal((await call({ path: '/v1/messages?beta=true' })).status, 200);
  assert.equal((await call({ path: '/v1/messages/count_tokens' })).status, 200);
  assert.deepEqual(ups.map((u) => u.url), ['https://api.anthropic.com/v1/messages?beta=true', 'https://api.anthropic.com/v1/messages/count_tokens']);
});

test('a body over the limit is 413 and nothing goes upstream', async () => {
  await claude(TOKEN.A);
  const small = proxyOf({ maxBodyBytes: 1024 });
  await small.sync({ enabled: true, port: 0 });
  const k = await small.key();
  const r = await call({ key: k, body: Buffer.alloc(4096, 97) }, small.report().port);
  assert.equal(r.status, 413);
  assert.equal(ups.length, 0);
  const fits = await call({ key: k, body: Buffer.alloc(1024, 97) }, small.report().port);
  assert.equal(fits.status, 200);
  await small.close();
});

// ---- 4. headers ----

test('headers: the account token, oauth-2025-04-20 once, no cookie or x-api-key, the body bytes as they came, the client\'s other headers', async () => {
  await claude(TOKEN.A);
  const bytes = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0xfe, 0x00, 0x80, 0x7d, 0x0a]);
  const r = await call({
    body: bytes,
    path: '/v1/messages?beta=true',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'claude-cli/9.9.9 (external, cli)',
      'x-app': 'cli',
      'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
      cookie: 'session=COOKIEVALUE',
      referer: 'https://example.com/',
      'accept-encoding': 'gzip, br',
      'x-api-key': key,
      'proxy-authorization': 'Basic abc',
      'x-stainless-lang': 'js',
    },
  });
  assert.equal(r.status, 200);
  const [u] = ups;
  assert.equal(u.headers.authorization, `Bearer ${TOKEN.A}`);
  assert.equal(u.headers['anthropic-beta'], 'claude-code-20250219,interleaved-thinking-2025-05-14,oauth-2025-04-20');
  assert.equal(u.headers['anthropic-beta'].split(',').filter((x) => x === 'oauth-2025-04-20').length, 1);
  assert.equal(u.headers['anthropic-version'], '2023-06-01');
  assert.equal(u.headers['accept-encoding'], 'identity');
  for (const gone of ['cookie', 'x-api-key', 'referer', 'origin', 'proxy-authorization', 'connection', 'host', 'content-length']) assert.ok(!(gone in u.headers), gone);
  assert.equal(u.headers['user-agent'], 'claude-cli/9.9.9 (external, cli)');
  assert.equal(u.headers['x-app'], 'cli');
  assert.equal(u.headers['x-stainless-lang'], 'js');
  assert.equal(u.headers['content-type'], 'application/json');
  assert.ok(u.body.equals(bytes), 'the body bytes are the same');
  assert.equal(u.redirect, 'manual');
  assert.equal(u.url, 'https://api.anthropic.com/v1/messages?beta=true');
  // a client value that has the flag keeps it once; a client version is kept
  await call({ headers: { 'anthropic-beta': 'oauth-2025-04-20, other-beta', 'anthropic-version': '2024-01-01' } });
  assert.equal(ups[1].headers['anthropic-beta'], 'oauth-2025-04-20, other-beta');
  assert.equal(ups[1].headers['anthropic-version'], '2024-01-01');
  // no beta from the client: just the flag
  await call();
  assert.equal(ups[2].headers['anthropic-beta'], 'oauth-2025-04-20');
});

test('the answer: status and headers go on; hop-by-hop, set-cookie, content-encoding and content-length do not; a 3xx goes on as it is', async () => {
  await claude(TOKEN.A);
  upstream = () =>
    new Response('{"ok":true}', {
      status: 302,
      headers: { location: 'https://example.com/elsewhere', 'content-type': 'application/json', 'set-cookie': 'a=b', 'x-request-id': 'req_123', 'proxy-authenticate': 'x', 'content-encoding': 'identity' },
    });
  const r = await call();
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, 'https://example.com/elsewhere');
  assert.equal(r.headers['x-request-id'], 'req_123');
  assert.equal(r.headers['set-cookie'], undefined);
  assert.equal(r.headers['proxy-authenticate'], undefined);
  assert.equal(r.headers['content-encoding'], undefined);
  assert.equal(r.text, '{"ok":true}');
  assert.equal(ups.length, 1, 'a redirect is not followed and does not move to another account');
});

// ---- 5. stream ----

test('stream: the SSE pieces reach the client in order as they come, and a client that leaves aborts the upstream request', { timeout: 20_000 }, async () => {
  await claude(TOKEN.A);
  const enc = new TextEncoder();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  upstream = () =>
    new Response(
      new ReadableStream({
        async start(c) {
          c.enqueue(enc.encode('event: a\ndata: 1\n\n'));
          await gate;
          c.enqueue(enc.encode('event: b\ndata: 2\n\n'));
          c.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  const { response } = open();
  const res = await response;
  assert.equal(res.headers['content-type'], 'text/event-stream');
  const it = res[Symbol.asyncIterator]();
  assert.equal(String((await it.next()).value), 'event: a\ndata: 1\n\n', 'the first piece arrives while the upstream is still open');
  release();
  assert.equal(String((await it.next()).value), 'event: b\ndata: 2\n\n');
  assert.equal((await it.next()).done, true);

  // the client leaves in the middle of a stream that never ends
  upstream = () => new Response(new ReadableStream({ start: (c) => void c.enqueue(enc.encode('data: first\n\n')) }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const second = open();
  const res2 = await second.response;
  await res2[Symbol.asyncIterator]().next();
  const signal = ups[1].signal;
  assert.equal(signal.aborted, false);
  const aborted = new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true })));
  second.req.destroy();
  res2.destroy();
  await aborted;
  assert.equal(signal.aborted, true);
});

// ---- 6. the switch ----

test('switch: a 429 with a rejected shared limit sends the same body to the next account; the client gets its 200; the rest ends at the reset; current moves', async () => {
  const a = await claude(TOKEN.A);
  const b = await claude(TOKEN.B);
  const reset = Math.floor(NOW / 1000) + 3600;
  upstream = (u) => (u.token === TOKEN.A ? rejected('A-BODY', reset) : ok('B-BODY'));
  const bytes = Buffer.from('{"model":"x","messages":[{"role":"user","content":"hi é"}]}');
  const r = await call({ body: bytes });
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-answer-from'], 'B-BODY');
  assert.equal(r.json.marker, 'B-BODY');
  assert.deepEqual(ups.map((u) => u.token), [TOKEN.A, TOKEN.B]);
  assert.ok(ups[0].body.equals(bytes) && ups[1].body.equals(bytes), 'the same body goes to both');
  const rep = report();
  assert.deepEqual(rep.resting, [{ id: a.id, until: iso(reset * 1000) }]);
  const sw = rep.events.filter((e) => e.kind === 'switch');
  assert.equal(sw.length, 1);
  assert.deepEqual(sw[0], { at: iso(NOW), provider: 'claude', kind: 'switch', from: a.id, to: b.id, status: 429, restUntil: null });
  assert.deepEqual(rep.events.filter((e) => e.kind === 'rest').map((e) => [e.from, e.status, e.restUntil]), [[a.id, 429, iso(reset * 1000)]]);
  assert.deepEqual(rep.counts, { requests: 1, switches: 1 });
  assert.equal(rep.current.claude, b.id);
  // the next request starts with B (current), not with A
  await call();
  assert.deepEqual(ups.slice(2).map((u) => u.token), [TOKEN.B]);
  // after the reset A may be used again, but B stays first while it answers well
  clock = reset * 1000 + 1;
  assert.deepEqual(proxy.report().resting, []);
  await call();
  assert.deepEqual(ups.slice(3).map((u) => u.token), [TOKEN.B]);
  // "use this account" does not move `current`'s meaning: the pool never changes store.active
  assert.deepEqual((await stored()).active, {});
});

test('switch: the 7-day window names the later reset; the order is current, then the account in use, then the file order', async () => {
  const a = await claude(TOKEN.A);
  const b = await claude(TOKEN.B);
  const c = await claude(TOKEN.C);
  // C is the one "use this account" chose: it goes first when nothing is current
  await updateAccount(c.id, (x, active) => ((active.claude = c.id), x), { path: FILE });
  const reset5 = Math.floor(NOW / 1000) + 600;
  const reset7 = Math.floor(NOW / 1000) + 7200;
  upstream = (u) =>
    u.token === TOKEN.C
      ? new Response('{}', { status: 429, headers: { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-reset': String(reset5), 'anthropic-ratelimit-unified-7d-status': 'rejected', 'anthropic-ratelimit-unified-7d-reset': String(reset7) } })
      : ok(nameOf(u.token));
  const r = await call();
  assert.equal(r.status, 200);
  assert.deepEqual(ups.map((u) => u.token), [TOKEN.C, TOKEN.A], 'C first, then the file order');
  assert.deepEqual(proxy.report().resting, [{ id: c.id, until: iso(reset7 * 1000) }], 'the later reset of the rejected windows');
  assert.equal(proxy.report().current.claude, a.id);
  void b;
});

test('rest time: retry-after first, then the later reset of a rejected window, then 60 s; 0 or less is 60 s, more than 6 hours is 6 hours', () => {
  const t = NOW;
  const h = (o: Record<string, string>) => new Headers(o);
  const sec = Math.floor(t / 1000);
  const rej = { 'anthropic-ratelimit-unified-status': 'rejected' };
  const ms = (status: number, o: Record<string, string>) => {
    const v = verdictOf(status, h(o), t);
    return v && v.kind === 'limit' ? v.restMs : v;
  };
  assert.equal(ms(429, { ...rej, 'retry-after': '120' }), 120_000);
  assert.equal(ms(429, { ...rej, 'retry-after': '120', 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-reset': String(sec + 999) }), 120_000, 'retry-after wins');
  assert.equal(ms(429, { ...rej, 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-reset': String(sec + 300), 'anthropic-ratelimit-unified-7d-status': 'allowed', 'anthropic-ratelimit-unified-7d-reset': String(sec + 9999) }), 300_000, 'only a rejected window counts');
  assert.equal(ms(429, { ...rej }), DEFAULT_REST_MS);
  assert.equal(ms(429, { ...rej, 'retry-after': '0' }), DEFAULT_REST_MS);
  assert.equal(ms(429, { ...rej, 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-reset': String(sec - 50) }), DEFAULT_REST_MS, 'a reset in the past');
  assert.equal(ms(429, { ...rej, 'retry-after': '999999' }), MAX_REST_MS);
  assert.equal(ms(429, { 'anthropic-ratelimit-unified-7d-status': 'rejected', 'anthropic-ratelimit-unified-7d-reset': String(sec + 100000) }), MAX_REST_MS);
  assert.equal(ms(429, { 'anthropic-ratelimit-unified-status': 'allowed', 'retry-after': '5' }), null);
  assert.equal(ms(429, { 'retry-after': '30' }), null, 'retry-after alone is a short limit: no switch');
  for (const status of [200, 400, 403, 500, 502, 503, 529]) assert.equal(ms(status, { ...rej, 'retry-after': '30' }), null, String(status));
  assert.deepEqual(verdictOf(401, h({}), t), { kind: 'unauthorized', restMs: 600_000 });
});

// ---- 7. no switch ----

test('no switch: a 429 with only retry-after, a 529, a 403 and a 500 go to the client as they are and no other account is asked', async () => {
  const a = await claude(TOKEN.A);
  await claude(TOKEN.B);
  const cases: [number, Record<string, string>][] = [
    [429, { 'retry-after': '30' }],
    [429, { 'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-5h-status': 'allowed' }],
    [529, { 'content-type': 'application/json' }],
    [403, {}],
    [500, {}],
  ];
  for (const [status, headers] of cases) {
    ups.length = 0;
    upstream = () => new Response(JSON.stringify({ type: 'error', marker: `S${status}` }), { status, headers: { 'content-type': 'application/json', ...headers } });
    const r = await call();
    assert.equal(r.status, status);
    assert.equal(r.json.marker, `S${status}`);
    assert.deepEqual(ups.map((u) => u.token), [TOKEN.A], `${status}: one request`);
    if (headers['retry-after']) assert.equal(r.headers['retry-after'], '30');
  }
  const rep = report();
  assert.deepEqual(rep.resting, []);
  assert.deepEqual(rep.events, []);
  assert.equal(rep.counts.switches, 0);
  assert.equal(rep.current.claude, null, 'only an answer below 400 makes an account current');
  void a;
});

// ---- 8. all blocked ----

test('all blocked: the last 429 goes to the client as it is; no account at all is 503 "no usable account"; at most three switches', async () => {
  const a = await claude(TOKEN.A);
  const b = await claude(TOKEN.B);
  const reset = Math.floor(NOW / 1000) + 1800;
  upstream = (u) => rejected(u.token === TOKEN.A ? 'A-BODY' : 'B-BODY', reset);
  const r = await call();
  assert.equal(r.status, 429);
  assert.equal(r.json.marker, 'B-BODY', 'the last answer, body and headers');
  assert.equal(r.headers['x-answer-from'], 'B-BODY');
  assert.equal(r.headers['anthropic-ratelimit-unified-5h-reset'], String(reset));
  assert.deepEqual(ups.map((u) => u.token), [TOKEN.A, TOKEN.B]);
  assert.deepEqual(proxy.report().resting.map((x) => x.id).sort(), [a.id, b.id].sort());
  // both rest now: nothing is sent, and there is no answer to pass on
  ups.length = 0;
  const none = await call();
  assert.deepEqual([none.status, none.json], [503, { type: 'error', error: { type: 'api_error', message: 'no usable account' } }]);
  assert.equal(ups.length, 0);
  assert.equal(proxy.report().events[0].kind, 'no usable account');
  // five accounts, all rejected: four are asked, three switches
  clock = reset * 1000 + 1;
  await claude(TOKEN.C);
  await claude(TOKEN.D);
  await claude(TOKEN.E);
  ups.length = 0;
  const before = proxy.report().counts.switches;
  upstream = (u) => rejected(`BODY-${nameOf(u.token)}`, Math.floor(clock / 1000) + 1800);
  const r5 = await call();
  assert.equal(r5.status, 429);
  assert.equal(ups.length, 4, 'at most four accounts per request');
  assert.equal(proxy.report().counts.switches - before, 3, 'at most three switches');
  assert.equal(r5.json.marker, `BODY-${nameOf(ups[3].token)}`);
  // no account in the file at all
  rmSync(FILE);
  ups.length = 0;
  const empty = await call();
  assert.equal(empty.status, 503);
  assert.equal(ups.length, 0);
});

// ---- 9. tokens ----

test('tokens: a folder account is read from its login file and never refreshed; an expired one is left out with an event; no refresh request is sent', async () => {
  const folder = await claude(TOKEN.A);
  const plain = await claude(TOKEN.B);
  await useAccount(folder.id, homesOpts());
  rewriteFolder(folder.id, TOKEN_FOLDER, NOW + 3600_000);
  upstream = (u) => ok(nameOf(u.token));
  assert.equal((await call()).status, 200);
  assert.deepEqual(ups.map((u) => u.token), [TOKEN_FOLDER], 'the folder file is the original of the token, not the record');
  // the file says the token ends in 30 s: inside the 60 s margin
  ups.length = 0;
  rewriteFolder(folder.id, TOKEN_FOLDER, NOW + 30_000);
  assert.equal((await call()).status, 200);
  assert.deepEqual(ups.map((u) => u.token), [TOKEN.B], 'the expired folder account is skipped, the next one serves');
  assert.ok(ups.every((u) => !u.url.includes('/oauth/')), 'no refresh request');
  const ev = report().events.find((e) => e.kind === 'token expired');
  assert.deepEqual(ev, { at: iso(NOW), provider: 'claude', kind: 'token expired', from: null, to: folder.id, status: null, restUntil: null });
  assert.equal(proxy.report().current.claude, plain.id);
  // only the folder account, expired: no usable account, still no refresh request
  rmSync(FILE);
  await claude(TOKEN.C);
  const only = (await stored()).accounts[0];
  await useAccount(only.id, homesOpts());
  rewriteFolder(only.id, TOKEN_FOLDER, NOW - 1000);
  ups.length = 0;
  const r = await call();
  assert.equal(r.status, 503);
  assert.equal(ups.length, 0);
});

test('tokens: an account without a folder that expires within 60 s is refreshed once, and the new token is used; a failed refresh leaves it out', async () => {
  const soon = await claude(TOKEN.A, {}, { expiresAt: iso(NOW + 30_000) });
  const refreshUrl = LOGIN_REQUESTS.claude.tokenUrl;
  const refreshes: string[] = [];
  upstream = (u) => {
    if (u.url === refreshUrl) {
      refreshes.push(u.token);
      return json({ access_token: TOKEN_NEW, refresh_token: REFRESH, expires_in: 3600 });
    }
    return ok(nameOf(u.token));
  };
  assert.equal((await call()).status, 200);
  assert.equal(refreshes.length, 1, 'one refresh');
  assert.deepEqual(ups.filter((u) => u.url !== refreshUrl).map((u) => u.token), [TOKEN_NEW]);
  assert.equal((await stored()).accounts[0].tokens.access, TOKEN_NEW, 'saved in the record');
  // the token is fresh now: no second refresh
  await call();
  assert.equal(refreshes.length, 1);
  // a refresh the vendor refuses marks the account (the refresh path's rule) and leaves it out for the request
  await claude(TOKEN.B, {}, { expiresAt: iso(NOW + 100 * 3600_000) });
  clock = NOW + 7200_000;
  upstream = (u) => (u.url === refreshUrl ? json({ error: 'invalid_grant' }, 400) : ok(nameOf(u.token)));
  ups.length = 0;
  const r = await call();
  assert.equal(r.status, 200);
  assert.deepEqual(ups.filter((u) => u.url !== refreshUrl).map((u) => u.token), [TOKEN.B], 'the refused account is left out');
  assert.equal(ups.filter((u) => u.url === refreshUrl).length, 1);
  assert.equal((await stored()).accounts.find((x) => x.id === soon.id)?.needsReauth, true, 'the refresh path marks it, as it does everywhere');
});

test('tokens: refreshAccount without skewMs waits for the expiry; with skewMs it asks early (the proxy only)', async () => {
  const a = await claude(TOKEN.A, {}, { expiresAt: iso(NOW + 30_000) });
  const urls: string[] = [];
  upstream = (u) => (urls.push(u.url), json({ access_token: TOKEN_NEW, expires_in: 3600 }));
  const o = { ...homesOpts() };
  const plain = await refreshAccount(a.id, o);
  assert.equal(plain.state, 'done');
  assert.equal(urls.length, 0, 'not expired yet: no request');
  const early = await refreshAccount(a.id, { ...o, skewMs: 60_000 });
  assert.equal(early.state, 'done');
  assert.equal(urls.length, 1);
  assert.ok(early.state === 'done' && early.account.tokens.access === TOKEN_NEW);
});

test('tokens: a needsReauth account, Copilot, Codex and the CLI login are never used', async () => {
  const reauth = await claude(TOKEN.A, { needsReauth: true });
  await upsertAccount({ provider: 'copilot', alias: null, identity: '42', email: null, plan: null, tokens: { access: 'gho_TESTTOKENCOPILOT', refresh: null, idToken: null, expiresAt: null } }, { path: FILE, now });
  await upsertAccount({ provider: 'codex', alias: null, identity: 'acct-px', email: null, plan: null, tokens: { access: 'TESTTOKENCODEX', refresh: 'TESTREFRESHCODEX', idToken: 'TESTTOKENIDTOKEN', expiresAt: iso(NOW + 3600_000) } }, { path: FILE, now });
  mkdirSync(join(FAKE_HOME, '.claude'), { recursive: true });
  writeFileSync(join(FAKE_HOME, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: TOKEN_LOCAL, refreshToken: REFRESH, expiresAt: NOW + 3600_000 } }));
  const r = await call();
  assert.equal(r.status, 503);
  assert.equal(ups.length, 0);
  assert.ok(!(await stored()).accounts.some((x) => x.id === reauth.id && x.needsReauth !== true));
  // a usable account next to them is the one that serves
  await claude(TOKEN.B);
  assert.equal((await call()).status, 200);
  assert.deepEqual(ups.map((u) => u.token), [TOKEN.B]);
});

// ---- 10. 401 ----

test('401: the account rests 10 minutes and the request goes to the next account; needsReauth is not saved', async () => {
  const a = await claude(TOKEN.A);
  const b = await claude(TOKEN.B);
  upstream = (u) => (u.token === TOKEN.A ? json({ type: 'error', error: { type: 'authentication_error' } }, 401) : ok('B-BODY'));
  const r = await call();
  assert.equal(r.status, 200);
  assert.equal(r.json.marker, 'B-BODY');
  assert.deepEqual(ups.map((u) => u.token), [TOKEN.A, TOKEN.B]);
  const rep = report();
  assert.deepEqual(rep.resting, [{ id: a.id, until: iso(NOW + 600_000) }]);
  assert.deepEqual(rep.events.filter((e) => e.kind === 'switch').map((e) => [e.from, e.to, e.status]), [[a.id, b.id, 401]]);
  assert.equal((await stored()).accounts.find((x) => x.id === a.id)?.needsReauth, undefined);
  // while it rests it is not asked; after 10 minutes it is a candidate again (B is current and still first)
  ups.length = 0;
  await call();
  assert.deepEqual(ups.map((u) => u.token), [TOKEN.B]);
  // every account answers 401: the last 401 goes to the client
  upstream = () => json({ type: 'error', marker: 'LAST-401' }, 401);
  clock = NOW + 601_000;
  ups.length = 0;
  const all = await call();
  assert.equal(all.status, 401);
  assert.equal(all.json.marker, 'LAST-401');
  assert.equal((await stored()).accounts.every((x) => x.needsReauth === undefined), true);
});

test('a network failure or a slow upstream is a closed 502, and no other account is asked', async () => {
  await claude(TOKEN.A);
  await claude(TOKEN.B);
  upstream = () => {
    throw new TypeError('fetch failed: ECONNRESET SECRETDETAIL');
  };
  const r = await call();
  assert.deepEqual([r.status, r.json], [502, { type: 'error', error: { type: 'api_error', message: 'upstream request failed' } }]);
  assert.ok(!r.text.includes('SECRETDETAIL'));
  assert.equal(ups.length, 1);
  // the wait for the headers runs out
  const slow = proxyOf({ upstreamHeadersMs: 50 });
  await slow.sync({ enabled: true, port: 0 });
  upstream = (u) => new Promise<Response>((_, reject) => u.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  ups.length = 0;
  const t = await call({ key: await slow.key() }, slow.report().port);
  assert.equal(t.status, 502);
  assert.equal(ups.length, 1);
  await slow.close();
});

// ---- 11. secrets ----

test('secrets: the report, list_accounts, the events, the console and the audit hold no token and no key; the key file is 0600; a loose key file is an error', async () => {
  const a = await claude(TOKEN.A);
  await claude(TOKEN.B);
  upstream = (u) => (u.token === TOKEN.A ? rejected('A-BODY', Math.floor(NOW / 1000) + 600) : ok('B'));
  for (let i = 0; i < 3; i++) await call();
  await call({ method: 'GET', path: '/v1/models?x=TESTTOKENQUERY' });
  outputs.push(JSON.stringify(await accountsReport({ ...homesOpts(), proxy })));
  outputs.push((await callTool('list_accounts', {}, {} as Core)).content[0].text);
  const rep = report();
  assert.deepEqual(Object.keys(rep).sort(), ['counts', 'current', 'enabled', 'events', 'port', 'resting', 'state', 'unproxied', 'url']);
  assert.ok(JSON.stringify(rep).includes(a.id), 'account ids are the only account text');
  // the key file
  assert.match(key, /^pbp-[0-9a-f]{32}$/);
  assert.equal(readFileSync(KEY_FILE, 'utf8').trim(), key);
  assert.equal(statSync(KEY_FILE).mode & 0o777, 0o600);
  assert.equal(PATHS.accountsProxyKey, KEY_FILE);
  // a file other users may read is not read: the state is error, and the line names no key
  const loose = proxyOf();
  chmodSync(KEY_FILE, 0o644);
  await loose.sync({ enabled: true, port: 0 });
  assert.equal(loose.report().state, 'error');
  assert.equal(loose.boundPort(), 0);
  await assert.rejects(() => loose.key(), /proxy key unusable/);
  for (const l of logged) assert.ok(!l.includes(key));
  // a file that is not a key
  chmodSync(KEY_FILE, 0o600);
  writeFileSync(KEY_FILE, 'not a key\n', { mode: 0o600 });
  await loose.sync({ enabled: true, port: 0 });
  assert.equal(loose.report().state, 'error');
  // the file is fixed: the next run opens it
  writeFileSync(KEY_FILE, `${key}\n`, { mode: 0o600 });
  await loose.sync({ enabled: true, port: 0 });
  assert.equal(loose.report().state, 'listening');
  await loose.close();
});

// ---- 12. the key route ----

const AUDIT_CTX = { owner: async () => OWNER, policy: async () => TAILSCALE_POLICY, device: async (addr: string) => ({ addr }), writeDevices: async () => null, ts: { available: true }, audit };
const context = () => new Proxy(AUDIT_CTX as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : assert.fail(`handler touched ctx.${String(k)}`)) }) as unknown as ServerContext;
function fakeReq(addr: string, headers: Record<string, string>, body?: unknown) {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  r.method = 'POST';
  r.headers = headers;
  r.socket = { remoteAddress: addr };
  return r;
}
async function keyRoute(body: unknown, headers: Record<string, string> = { 'x-portboard': '1' }, addr = '127.0.0.1') {
  const ctx = context();
  const out = await appRouter(REGISTRY.routes, ctx)(fakeReq(addr, headers, body), new URL('http://x/api/accounts/proxy/key'), ctx);
  assert.ok(out);
  outputs.push(JSON.stringify(out!.body).replace(/"key":"pbp-[0-9a-f]{32}"/, '"key":"KEY"'));
  return out!;
}
const SERVE = { 'x-forwarded-for': '100.101.102.103', 'x-forwarded-host': 'devbox.example.ts.net', 'x-forwarded-proto': 'https' };

test('key route: not the owner is 403, off is 404, the owner gets the key, rotate makes the old key 401', async () => {
  await claude(TOKEN.A);
  // not the owner, or no X-Portboard
  for (const [headers, addr] of [
    [{ 'x-portboard': '1' }, '100.64.0.9'],
    [{ 'x-portboard': '1', ...SERVE, 'tailscale-user-login': 'guest@example.com' }, '127.0.0.1'],
    [{ 'x-portboard': '1', ...SERVE }, '127.0.0.1'],
    [{}, '127.0.0.1'],
  ] as [Record<string, string>, string][]) {
    const r = await keyRoute({}, headers, addr);
    assert.equal(r.status, 403, JSON.stringify(headers));
    assert.ok(!JSON.stringify(r.body).includes(key));
  }
  // the owner
  const r = await keyRoute({});
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body as object), ['key', 'keyFile']);
  assert.equal((r.body as { keyFile: string }).keyFile, KEY_FILE);
  assert.equal((r.body as { key: string }).key, key);
  assert.equal((await keyRoute(undefined)).status, 200, 'no body at all');
  assert.equal(((await keyRoute({ rotate: 'true' })).body as { key: string }).key, key, 'only true rotates');
  // the write route is declared the way the registry needs
  const route = (accountsFeature.routes ?? []).find((x) => x.path === '/api/accounts/proxy/key');
  assert.ok(route && route.method === 'POST' && route.write === true && 'body' in route && route.body?.limit === 4096);
  // rotate: a new key, the old one is 401, the new one works
  const old = key;
  const rot = await keyRoute({ rotate: true });
  assert.equal(rot.status, 200);
  const fresh = (rot.body as { key: string }).key;
  assert.match(fresh, /^pbp-[0-9a-f]{32}$/);
  assert.notEqual(fresh, old);
  assert.equal(readFileSync(KEY_FILE, 'utf8').trim(), fresh);
  assert.equal(statSync(KEY_FILE).mode & 0o777, 0o600);
  assert.equal((await call({ key: old })).status, 401);
  assert.equal((await call({ key: fresh })).status, 200);
  assert.equal((await keyRoute({})).status, 200);
  assert.equal(((await keyRoute({})).body as { key: string }).key, fresh);
  // the audit line holds the key name and no key
  const entries = await audit.query({ limit: 1000 });
  const mine = entries.filter((x) => x.route === 'POST /api/accounts/proxy/key');
  assert.ok(mine.length > 0);
  assert.deepEqual([...new Set(mine.flatMap((x) => [...(x.target.fields ?? [])]))], ['rotate']);
  for (const k of [old, fresh]) assert.ok(!auditText().includes(k));
  key = fresh;
  // off: 404, whatever the owner asks, and nothing is written
  setProxyConfigForTest(() => ({ enabled: false, port: 0 }));
  const off = await keyRoute({ rotate: true });
  assert.deepEqual([off.status, off.body], [404, { error: 'accounts proxy disabled' }]);
  assert.equal(readFileSync(KEY_FILE, 'utf8').trim(), fresh);
  setProxyConfigForTest(() => ({ enabled: true, port: 0 }));
  setAccountsEnabledForTest(() => false);
  assert.equal((await keyRoute({})).status, 404);
  setAccountsEnabledForTest(() => true);
  // a key file that cannot be used: a closed 500
  chmodSync(KEY_FILE, 0o644);
  const bad = await keyRoute({});
  assert.deepEqual([bad.status, bad.body], [500, { error: 'proxy key unusable' }]);
  chmodSync(KEY_FILE, 0o600);
});

test('the key is made when the proxy is first turned on, not before', async () => {
  rmSync(join(FAKE_HOME, 'cfg'), { recursive: true, force: true });
  const p = proxyOf();
  assert.ok(!existsSync(KEY_FILE));
  await p.sync({ enabled: false, port: 0 });
  assert.ok(!existsSync(KEY_FILE), 'off: no key file');
  await p.sync({ enabled: true, port: 0 });
  assert.ok(existsSync(KEY_FILE));
  assert.equal(statSync(KEY_FILE).mode & 0o777, 0o600);
  await p.close();
});

// ---- 13. expose_port ----

test('exposeBlocker: the proxy port is canExpose false with its own text, in the snapshot of list_ports', async (t) => {
  // proxyHoldsPort: the port in the settings of a proxy that is on
  setProxyConfigForTest(() => ({ enabled: true, port: 8795 }));
  assert.equal(proxyHoldsPort(8795), true);
  assert.equal(proxyHoldsPort(8796), false);
  setProxyConfigForTest(() => ({ enabled: false, port: 8795 }));
  assert.equal(proxyHoldsPort(8795), false, 'off: not blocked');

  // the snapshot, with `ss` and `tailscale` replaced by shims on PATH (the real ones are not run)
  const shims = mkdtempSync(join(FAKE_HOME, 'shims-'));
  const port = 8795;
  writeFileSync(join(shims, 'ss'), `#!/bin/sh\necho 'LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:*'\necho 'LISTEN 0 511 127.0.0.1:8796 0.0.0.0:*'\n`, { mode: 0o755 });
  writeFileSync(join(shims, 'tailscale'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = shims;
  t.after(() => void (process.env.PATH = path));
  setProxyConfigForTest(() => ({ enabled: true, port }));
  const snap = await snapshot();
  const mine = snap.ports.find((p) => p.port === port);
  const other = snap.ports.find((p) => p.port === 8796);
  assert.ok(mine && other, 'both shim ports are listed');
  assert.deepEqual([mine.canExpose, mine.exposeBlocker], [false, 'account proxy is loopback only']);
  assert.notEqual(other.exposeBlocker, 'account proxy is loopback only');
  setProxyConfigForTest(() => ({ enabled: false, port }));
  const off = (await snapshot()).ports.find((p) => p.port === port);
  assert.notEqual(off?.exposeBlocker, 'account proxy is loopback only');
});

// ---- the page and the docs ----

test('the page: the proxy block, the copy button for the command and the key button are write buttons; the key is not drawn (source check)', () => {
  const src = readFileSync(new URL('../public/features/accounts.js', import.meta.url), 'utf8');
  assert.match(src, /api\/accounts\/proxy\/key/);
  assert.match(src, /ANTHROPIC_BASE_URL=/);
  assert.match(src, /ANTHROPIC_AUTH_TOKEN=/);
  assert.match(src, /rotate: true/);
  const block = src.slice(src.indexOf('function proxyBlock'));
  assert.match(block, /write: true/);
  assert.doesNotMatch(block, /textContent = (?:key|r\.key)/, 'the key is never put on the page');
  // the clipboard write is made inside the click, with a promise of the text; a text field is the last resort
  assert.match(block, /new ClipboardItem\(\{ 'text\/plain': blob \}\)/);
  assert.match(block, /navigator\.clipboard\?\.write/);
  assert.match(block, /readonly: true/);
  // the drawn fallback holds no key: its value is built from the key file path and `$(cat`
  const by = block.slice(block.indexOf('byHand:'));
  assert.match(by.split('\n')[0], /\$\(cat \$\{shellQuote\(keyFile\)\}\)/);
  assert.doesNotMatch(by.split('\n')[0], /\$\{key\}/);
  assert.match(block, /showManual\(got\.byHand\)/);
  assert.doesNotMatch(block, /showManual\(got\.command\)/);
  assert.match(block, /const \{ key, keyFile \} = await postOrThrow/);
  assert.match(block, /disabled: !listening && p\.state !== 'error'/);
});

// ---- review follow-ups ----

test('counts.requests: only a caller that passed the Host, Origin and key checks is counted', async () => {
  await claude(TOKEN.A);
  await call({ auth: 'none' });
  await call({ key: 'wrong' });
  await call({ headers: { origin: 'https://example.com' } });
  await call({ headers: { host: 'evil.example' } });
  // a port probe: connect and leave
  await new Promise<void>((resolve) => {
    const sock = connect({ host: PROXY_HOST, port: portOf() }, () => sock.end());
    sock.once('close', () => resolve());
  });
  assert.equal(proxy.report().counts.requests, 0);
  await call();
  await call({ method: 'GET', path: '/v1/models' });
  assert.equal(proxy.report().counts.requests, 2);
});

test('an error after the listener opened closes that listener, and the next sync opens the port again', async () => {
  const p = proxyOf();
  await p.sync({ enabled: true, port: 0 });
  const port = p.report().port;
  (p as unknown as { server: { emit(e: string, err: Error): boolean } }).server.emit('error', new Error('boom'));
  assert.equal(p.report().state, 'error');
  assert.equal(p.boundPort(), 0);
  // the old listener is closed: the port is free to bind again
  await p.sync({ enabled: true, port });
  assert.equal(p.report().state, 'listening');
  assert.equal(p.report().port, port);
  assert.equal((await call({ key: await p.key() }, port)).status, 503, 'it answers (no account here)');
  await p.close();
});

test('proxyHoldsPort follows the two flags in a preview too; a replaced config (the test hook) is used as it is', () => {
  setProxyConfigForTest(() => ({ enabled: true, port: 8795 }));
  assert.equal(proxyHoldsPort(8795), true);
  setProxyConfigForTest(() => ({ enabled: false, port: 8795 }));
  assert.equal(proxyHoldsPort(8795), false);
  // a preview process with both flags on: no proxy of its own, but the production proxy port is still refused
  const dir = mkdtempSync(join(FAKE_HOME, 'preview-'));
  writeFileSync(join(dir, 'portboard.json'), JSON.stringify({ accounts: { enabled: true, proxy: { enabled: true, port: 8795 } } }));
  const code = `const m = await import(${JSON.stringify(new URL('../src/core/accounts/proxy.ts', import.meta.url).href)});
    console.log(JSON.stringify([m.proxyConfig().enabled, m.proxyHoldsPort(8795), m.proxyHoldsPort(8796)]));`;
  const out = (port: string) =>
    JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { PATH: process.env.PATH ?? '', HOME: dir, PORTBOARD_PORT: port, PORTBOARD_SITE: join(dir, 'portboard.json') }, encoding: 'utf8' }));
  assert.deepEqual(out('8808'), [false, true, false], 'preview: the proxy is off here, the port is still held');
  assert.deepEqual(out('8790'), [true, true, false], 'production');
  // a preview whose copy of portboard.json has the flags off (production turned the proxy on later), and a port of its own
  writeFileSync(join(dir, 'portboard.json'), JSON.stringify({ accounts: { proxy: { port: 8801 } } }));
  const code2 = `const m = await import(${JSON.stringify(new URL('../src/core/accounts/proxy.ts', import.meta.url).href)});
    console.log(JSON.stringify([m.proxyConfig().enabled, m.proxyHoldsPort(8801), m.proxyHoldsPort(8795), m.proxyHoldsPort(8796)]));`;
  const out2 = (port: string) =>
    JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code2], { env: { PATH: process.env.PATH ?? '', HOME: dir, PORTBOARD_PORT: port, PORTBOARD_SITE: join(dir, 'portboard.json') }, encoding: 'utf8' }));
  assert.deepEqual(out2('8808'), [false, true, true, false], 'preview, flags off: its own port and the default are held');
  assert.deepEqual(out2('8790'), [false, false, false, false], 'production, flags off: nothing is held');
});

test('a process that never synced reports the settings and state unknown while they are on', async () => {
  const idle = new AccountsProxy({ ...homesOpts(), keyPath: KEY_FILE });
  setProxyConfigForTest(() => ({ enabled: true, port: 8801 }));
  let r = idle.report();
  assert.deepEqual([r.enabled, r.state, r.port, r.url], [true, 'unknown', 8801, null]);
  r = (await accountsReport({ ...homesOpts(), proxy: idle })).proxy;
  assert.equal(r.state, 'unknown');
  setProxyConfigForTest(() => ({ enabled: false, port: 8801 }));
  r = idle.report();
  assert.deepEqual([r.enabled, r.state], [false, 'off']);
  // after a sync the state is the listener's own
  setProxyConfigForTest(() => ({ enabled: true, port: 0 }));
  await idle.sync({ enabled: true, port: 0 });
  assert.equal(idle.report().state, 'listening');
  await idle.close();
  assert.equal(idle.report().state, 'off');
});

test('no usable account is written at most once a minute', async () => {
  const count = () => proxy.report().events.filter((e) => e.kind === 'no usable account').length;
  assert.equal((await call()).status, 503);
  assert.equal((await call()).status, 503);
  assert.equal(count(), 1);
  clock = NOW + 59_000;
  await call();
  assert.equal(count(), 1);
  clock = NOW + 61_000;
  await call();
  assert.equal(count(), 2);
});

// ---- second review round ----

test('sync re-reads the key file: a loose or odd file closes the listener, an edited key applies at once', async () => {
  const p = proxyOf();
  await p.sync({ enabled: true, port: 0 });
  const port = p.report().port;
  const old = await p.key();
  const fresh = `pbp-${'ab'.repeat(16)}`;
  writeFileSync(KEY_FILE, `${fresh}\n`, { mode: 0o600 });
  await p.sync({ enabled: true, port });
  assert.equal(p.report().state, 'listening');
  assert.equal((await call({ key: old }, port)).status, 401, 'the old key is refused');
  assert.equal((await call({ key: fresh }, port)).status, 503, 'the edited key is accepted (no account here)');
  chmodSync(KEY_FILE, 0o644);
  await p.sync({ enabled: true, port });
  assert.equal(p.report().state, 'error');
  assert.equal(p.boundPort(), 0, 'the listener is closed');
  assert.match(logged.join('\n'), /accounts proxy: the key file cannot be used/);
  for (const l of logged) assert.ok(!l.includes(fresh) && !l.includes(old));
  chmodSync(KEY_FILE, 0o600);
  writeFileSync(KEY_FILE, 'junk\n', { mode: 0o600 });
  await p.sync({ enabled: true, port });
  assert.equal(p.report().state, 'error');
  writeFileSync(KEY_FILE, `${old}\n`, { mode: 0o600 });
  await p.sync({ enabled: true, port });
  assert.equal(p.report().state, 'listening');
  await p.close();
});

test('an Expect header is not sent upstream', async () => {
  await claude(TOKEN.A);
  const r = await call({ headers: { expect: '100-continue' } });
  assert.equal(r.status, 200);
  assert.ok(!('expect' in ups[0].headers));
});

test('upstreamRequest: only the given headers go out, a stream arrives in order, an abort ends the request, a redirect is not followed', { timeout: 20_000 }, async () => {
  const seen: { headers: IncomingHttpHeaders; body: string; method: string }[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString(), method: req.method ?? '' });
      if (req.url === '/redirect') return void res.writeHead(302, { location: '/elsewhere', 'set-cookie': ['a=1', 'b=2'] }).end();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('one\n');
      if (req.url === '/hang') return;
      void gate.then(() => res.end('two\n'));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const sent = { authorization: 'Bearer X', 'x-custom': 'yes', 'content-type': 'application/json' };
    const ac = new AbortController();
    const res = await upstreamRequest(`${base}/stream?q=1`, { method: 'POST', headers: sent, body: Buffer.from('{"a":1}') as unknown as BodyInit, redirect: 'manual', signal: ac.signal });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body!.getReader();
    assert.equal(Buffer.from((await reader.read()).value!).toString(), 'one\n', 'the first piece while the server is still open');
    release();
    assert.equal(Buffer.from((await reader.read()).value!).toString(), 'two\n');
    assert.equal((await reader.read()).done, true);
    const [got] = seen;
    assert.equal(got.method, 'POST');
    assert.equal(got.body, '{"a":1}');
    for (const [k, v] of Object.entries(sent)) assert.equal(got.headers[k], v);
    for (const k of ['accept', 'accept-language', 'sec-fetch-mode', 'user-agent', 'accept-encoding']) assert.ok(!(k in got.headers), `${k} is not added`);
    // a redirect is the answer, not followed
    const red = await upstreamRequest(`${base}/redirect`, { method: 'POST', headers: sent, body: Buffer.alloc(0) as unknown as BodyInit });
    assert.equal(red.status, 302);
    assert.equal(red.headers.get('location'), '/elsewhere');
    assert.equal(seen.length, 2);
    // an abort after the headers ends the stream with an error
    const hang = await upstreamRequest(`${base}/hang`, { method: 'POST', headers: sent, body: Buffer.alloc(0) as unknown as BodyInit, signal: ac.signal });
    const r2 = hang.body!.getReader();
    await r2.read();
    ac.abort();
    await assert.rejects(() => r2.read());
    // an abort before the call
    await assert.rejects(() => upstreamRequest(`${base}/stream`, { method: 'POST', headers: sent, signal: ac.signal }));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('change key in the error state: rotate reopens the proxy with the new key', async () => {
  await claude(TOKEN.A);
  const p = proxyOf();
  setAccountsOptionsForTest(() => ({ ...homesOpts(), proxy: p }));
  chmodSync(KEY_FILE, 0o644);
  await p.sync({ enabled: true, port: 0 });
  assert.equal(p.report().state, 'error');
  const r = await keyRoute({ rotate: true });
  assert.equal(r.status, 200);
  const fresh = (r.body as { key: string }).key;
  assert.equal(p.report().state, 'listening');
  assert.equal(statSync(KEY_FILE).mode & 0o777, 0o600);
  assert.equal((await call({ key: fresh }, p.report().port)).status, 200);
  await p.close();
});
