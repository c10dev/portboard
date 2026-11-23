// The accounts proxy's usage log (docs/accounts.md#usage-log): one line per request, the token counts read from the answer
// as it streams by, the summary route. The upstream is a fake fetch; the listener is a real one on 127.0.0.1 port 0.
// HOME, the config folders, accounts.json, the proxy key and the usage log are mkdtemp paths. No real endpoint is called and
// no real ~/.claude or ~/.codex is read. Every token, the proxy key and the request's message text are checked for in every output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

// Safety net first (src/ is imported dynamically, after these lines).
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'pb-usage-'));
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
const USAGE = join(FAKE_HOME, 'cfg', 'accounts-usage.jsonl');
process.env.PORTBOARD_ACCOUNTS = FILE;
process.env.PORTBOARD_ACCOUNT_HOMES = HOMES;
process.env.PORTBOARD_ACCOUNTS_PROXY_KEY = KEY_FILE;
process.env.PORTBOARD_ACCOUNTS_USAGE = USAGE;

const { AccountsProxy, PROXY_HOST, UsageObserver, setProxyConfigForTest } = await import('../src/core/accounts/proxy.ts');
const { appendUsage, summarize } = await import('../src/core/accounts/usage.ts');
const { upsertAccount } = await import('../src/core/accounts/store.ts');
const { resetRefreshForTest } = await import('../src/core/accounts/refresh.ts');
const { clearQuotaCache } = await import('../src/core/accounts/quota.ts');
const { PATHS } = await import('../src/core/paths.ts');
const { accountsFeature, setAccountsEnabledForTest, setAccountsOptionsForTest, setAccountsUsageForTest } = await import('../src/features/accounts.ts');
const { appRouter } = await import('../src/features/router.ts');
const { REGISTRY } = await import('../src/features/registry.ts');
const { TAILSCALE_POLICY } = await import('../src/core/access.ts');
type ServerContext = import('../src/features/context.ts').ServerContext;
type Proxy = InstanceType<typeof AccountsProxy>;
type UsageLine = import('../src/core/accounts/usage.ts').UsageLine;

const NOW = Date.parse('2026-11-23T09:00:00Z');
const DAY = 86_400_000;
let clock = NOW;
const now = () => clock;
const iso = (ms: number) => new Date(ms).toISOString();
const OWNER = 'owner@example.com';
const TOKEN = { A: 'sk-ant-oat01-TESTTOKENA0123456789', B: 'sk-ant-oat01-TESTTOKENB0123456789' };
const REFRESH = 'sk-ant-ort01-TESTREFRESH0123456789';
const MARKERS = ['TESTTOKEN', 'TESTREFRESH'];
const SECRET_TEXT = 'SECRET-MESSAGE-TEXT-9f3a';
const MODEL = 'claude-test-model-1';
const REQUEST = Buffer.from(JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: SECRET_TEXT }] }));
const LINE_KEYS = ['account', 'at', 'cacheRead', 'cacheWrite', 'input', 'model', 'ms', 'output', 'provider', 'status'];

// ---- the fake upstream ----

const ups: { token: string; body: Buffer; signal: AbortSignal }[] = [];
let upstream: (token: string) => Response | Promise<Response> = () => json({});
const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
  const headers = Object.fromEntries(new Headers(init?.headers as Record<string, string>));
  const token = (headers.authorization ?? '').replace(/^Bearer /, '');
  ups.push({ token, body: Buffer.from((init?.body as Buffer | undefined) ?? Buffer.alloc(0)), signal: init?.signal as AbortSignal });
  return upstream(token);
}) as typeof fetch;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const rejected = (reset: number) =>
  new Response(JSON.stringify({ type: 'error' }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-reset': String(reset) },
  });
const sse = (pieces: string[], keepOpen = false) => {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const p of pieces) c.enqueue(enc.encode(p));
        if (!keepOpen) c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
};

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
const portOf = () => proxy.report().port;
const logged: string[] = [];
const outputs: string[] = [];
const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
let seq = 0;
const claude = (access: string) =>
  upsertAccount(
    { provider: 'claude', alias: `acct-${seq}`, identity: `uuid-us-${seq++}`, email: 'a@example.com', plan: 'max', tier: 'default_claude_max_5x', subscriptionType: 'max', tokens: { access, refresh: REFRESH, idToken: null, expiresAt: iso(NOW + 100 * 3600_000) } },
    { path: FILE, now },
  );

test.beforeEach(async () => {
  resetRefreshForTest();
  clearQuotaCache();
  rmSync(FILE, { force: true });
  rmSync(HOMES, { recursive: true, force: true });
  rmSync(join(FAKE_HOME, 'cfg'), { recursive: true, force: true });
  ups.length = 0;
  upstream = () => json({});
  clock = NOW;
  logged.length = 0;
  outputs.length = 0;
  for (const k of Object.keys(saved) as (keyof typeof saved)[]) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
  setAccountsEnabledForTest(() => true);
  proxy = new AccountsProxy({ ...homesOpts(), keyPath: KEY_FILE, usagePath: USAGE });
  setAccountsOptionsForTest(() => ({ ...homesOpts(), proxy }));
  setAccountsUsageForTest(() => ({ path: USAGE, now }));
  setProxyConfigForTest(() => ({ enabled: true, port: 0 }));
  await proxy.sync({ enabled: true, port: 0 });
  key = await proxy.key();
});
test.afterEach(async () => {
  await proxy.close();
  Object.assign(console, saved);
  setAccountsEnabledForTest(null);
  setAccountsOptionsForTest(null);
  setAccountsUsageForTest(null);
  setProxyConfigForTest(null);
  // test 5: no token, no key and no message text in an answer, the usage file or the console
  const file = existsSync(USAGE) ? readFileSync(USAGE, 'utf8') : '';
  for (const o of [...outputs, ...logged, file]) {
    for (const m of [...MARKERS, SECRET_TEXT]) assert.ok(!o.includes(m), `output holds ${m}`);
    if (key) assert.ok(!o.includes(key), 'output holds the proxy key');
  }
});

// ---- the client ----

function open(body: Buffer | string = REQUEST, path = '/v1/messages', port = portOf()) {
  const req = httpRequest({ host: PROXY_HOST, port, path, method: 'POST', headers: { authorization: `Bearer ${key}` }, agent: false });
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req.on('response', resolve);
    req.on('error', reject);
  });
  req.end(body);
  return { req, response };
}
async function call(body: Buffer | string = REQUEST, path = '/v1/messages', port = portOf()) {
  const res = await open(body, path, port).response;
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  const bytes = Buffer.concat(chunks);
  outputs.push(bytes.toString('utf8'), JSON.stringify(res.headers));
  return { status: res.statusCode ?? 0, bytes };
}

/** Wait for an event, not a fixed time: the file has at least `n` lines */
async function lines(n: number): Promise<UsageLine[]> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const text = existsSync(USAGE) ? readFileSync(USAGE, 'utf8') : '';
    const rows = text.split('\n').filter(Boolean);
    if (rows.length >= n || Date.now() > deadline) {
      assert.ok(rows.length >= n, `expected ${n} usage lines, found ${rows.length}`);
      return rows.map((r) => JSON.parse(r) as UsageLine);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---- 1. a JSON answer ----

test('usage 1: a JSON answer is one line, and its four token counts are the answer\'s usage', async () => {
  const a = await claude(TOKEN.A);
  const answer = { type: 'message', usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 } };
  upstream = () => json(answer);
  const r = await call();
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.bytes.toString('utf8')), answer, 'the caller got the answer as it is');
  const [line, ...rest] = await lines(1);
  assert.equal(rest.length, 0);
  assert.deepEqual(Object.keys(line).sort(), LINE_KEYS);
  assert.deepEqual({ ...line, at: 'x', ms: 0 }, { at: 'x', provider: 'claude', account: a.id, model: MODEL, status: 200, input: 11, output: 22, cacheRead: 33, cacheWrite: 44, ms: 0 });
  assert.equal(line.at, iso(NOW));
  assert.ok(typeof line.ms === 'number' && line.ms >= 0);
  assert.ok(ups[0].body.equals(REQUEST), 'the body went upstream as it came');

  // an answer without usage, a body that is not JSON, a model that is long or not a string
  upstream = () => json({ type: 'error' }, 500);
  await call('not json at all');
  upstream = () => json({ usage: { input_tokens: '5', output_tokens: -1 } });
  await call(JSON.stringify({ model: 'm'.repeat(300) }));
  upstream = () => json({});
  await call(JSON.stringify({ model: 7 }));
  const all = await lines(4);
  assert.deepEqual(all[1], { ...all[1], model: null, status: 500, input: null, output: null, cacheRead: null, cacheWrite: null });
  assert.deepEqual([all[2].model, all[2].input, all[2].output], ['m'.repeat(128), null, null], 'a text or a negative number is null');
  assert.equal(all[3].model, null);

  // count_tokens: input only
  upstream = () => json({ input_tokens: 77 });
  await call(REQUEST, '/v1/messages/count_tokens');
  const count = (await lines(5))[4];
  assert.deepEqual([count.input, count.output, count.cacheRead, count.cacheWrite, count.status], [77, null, null, null, 200]);
});

// ---- 2. an SSE answer ----

test('usage 2: an SSE answer with events across chunk borders: input from message_start, output from the last message_delta, the bytes unchanged', async () => {
  await claude(TOKEN.A);
  const events =
    'event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 7, cache_creation_input_tokens: 9 } } }) + '\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hé"}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":15}}\n\n' +
    'event: message_delta\r\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\r\n\r\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const bytes = Buffer.from(events, 'utf8');
  // cut at awkward places: inside a JSON value, inside a line ending and inside the two bytes of the "é"
  const cuts = [30, 95, bytes.indexOf('é') + 1, bytes.indexOf('"output_tokens":15') + 8, bytes.indexOf('\r\n') + 1, bytes.length - 3];
  const pieces: Buffer[] = [];
  let from = 0;
  for (const c of [...cuts].sort((x, y) => x - y)) {
    pieces.push(bytes.subarray(from, c));
    from = c;
  }
  pieces.push(bytes.subarray(from));
  assert.ok(Buffer.concat(pieces).equals(bytes));
  const enc = new Response(new ReadableStream({ start: (c) => { for (const p of pieces) c.enqueue(new Uint8Array(p)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  upstream = () => enc;
  const r = await call();
  assert.ok(r.bytes.equals(bytes), 'the caller got the upstream bytes, byte for byte');
  const [line] = await lines(1);
  assert.deepEqual([line.input, line.output, line.cacheRead, line.cacheWrite, line.status], [100, 42, 7, 9, 200]);
});

// ---- 3. a switch ----

test('usage 3: a request that moved to the next account is one line, on the account that answered', async () => {
  const a = await claude(TOKEN.A);
  const b = await claude(TOKEN.B);
  upstream = (t) => (t === TOKEN.A ? rejected(Math.floor(NOW / 1000) + 3600) : json({ usage: { input_tokens: 3, output_tokens: 4 } }));
  const r = await call();
  assert.equal(r.status, 200);
  assert.deepEqual(ups.map((u) => u.token), [TOKEN.A, TOKEN.B]);
  const rows = await lines(1);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].account, rows[0].status, rows[0].input, rows[0].output], [b.id, 200, 3, 4]);
  assert.notEqual(rows[0].account, a.id);

  // no account is left: the last answer goes on, and it is logged on the account that gave it
  upstream = () => rejected(Math.floor(NOW / 1000) + 3600);
  clock = NOW + 1000;
  rmSync(FILE, { force: true });
  const c = await claude(TOKEN.A);
  const r2 = await call();
  assert.equal(r2.status, 429);
  const rows2 = await lines(2);
  assert.deepEqual([rows2[1].account, rows2[1].status], [c.id, 429]);
});

test('usage 3b: no account at all is a 503 and no line', async () => {
  const r = await call();
  assert.equal(r.status, 503);
  // an event, not a delay: a later request through the same proxy is recorded, and the log then holds that line only
  const a = await claude(TOKEN.A);
  upstream = () => json({ usage: { input_tokens: 1, output_tokens: 2 } });
  assert.equal((await call()).status, 200);
  const rows = await lines(1);
  assert.equal(rows.length, 1, 'the 503 left no line');
  assert.equal(rows[0].account, a.id);
});

// ---- 4. the caller leaves ----

test('usage 4: a caller that leaves in the middle is one line with the counts seen so far', { timeout: 20_000 }, async () => {
  const a = await claude(TOKEN.A);
  const start = 'event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 61, output_tokens: 1 } } }) + '\n\n';
  upstream = () => sse([start], true);
  const { req, response } = open();
  const res = await response;
  await res[Symbol.asyncIterator]().next();
  const signal = ups[0].signal;
  req.destroy();
  res.destroy();
  const rows = await lines(1);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].account, rows[0].status, rows[0].input, rows[0].output], [a.id, 200, 61, 1]);
  assert.equal(signal.aborted, true);

  // the upstream fails before any answer: 502, status 0, no counts
  upstream = () => {
    throw new Error('network down');
  };
  const failed = await call();
  assert.equal(failed.status, 502);
  const all = await lines(2);
  assert.deepEqual([all[1].account, all[1].status, all[1].input, all[1].output, all[1].cacheRead, all[1].cacheWrite], [a.id, 0, null, null, null, null]);
});

// ---- the log is best effort ----

test('a usage write that fails or throws does not change the answer', async () => {
  await claude(TOKEN.A);
  const broken = new AccountsProxy({ ...homesOpts(), keyPath: KEY_FILE, usagePath: USAGE, appendUsage: () => Promise.reject(new Error('disk full')) });
  const thrower = new AccountsProxy({ ...homesOpts(), keyPath: KEY_FILE, usagePath: USAGE, appendUsage: () => { throw new Error('boom'); } });
  upstream = () => json({ usage: { input_tokens: 1, output_tokens: 2 } });
  for (const p of [broken, thrower]) {
    await p.sync({ enabled: true, port: 0 });
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpRequest({ host: PROXY_HOST, port: p.report().port, path: '/v1/messages', method: 'POST', headers: { authorization: `Bearer ${key}` }, agent: false }, resolve);
      req.on('error', reject);
      req.end(REQUEST);
    });
    assert.equal(res.statusCode, 200);
    res.resume();
    await new Promise((r) => res.once('end', r));
    await p.close();
  }
  assert.equal(existsSync(USAGE), false);
  // the writer itself does not throw for a path it cannot use, and says nothing on the console
  await appendUsage({ at: iso(NOW), provider: 'claude', account: 'acc-1', model: null, status: 200, input: null, output: null, cacheRead: null, cacheWrite: null, ms: 1 }, join(FAKE_HOME, 'cfg', 'no', 'such', '\0bad'));
  assert.deepEqual(logged, []);
});

// ---- 5. nothing private ----

/** A GET route call: the same decision as the other owner routes (the audit log's read) */
function fakeGet(addr: string, headers: Record<string, string>) {
  const r = Readable.from([]) as any;
  r.method = 'GET';
  r.headers = headers;
  r.socket = { remoteAddress: addr };
  return r;
}
const ctx = () => new Proxy({ owner: async () => OWNER, policy: async () => TAILSCALE_POLICY } as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : assert.fail(`handler touched ctx.${String(k)}`)) }) as unknown as ServerContext;
async function usageRoute(query = '', headers: Record<string, string> = {}, addr = '127.0.0.1') {
  const c = ctx();
  const out = await appRouter(REGISTRY.routes, c)(fakeGet(addr, headers), new URL(`http://x/api/accounts/usage${query}`), c);
  assert.ok(out);
  outputs.push(JSON.stringify(out!.body));
  return out!;
}
const SERVE = { 'x-forwarded-for': '100.101.102.103', 'x-forwarded-host': 'devbox.example.ts.net', 'x-forwarded-proto': 'https' };

test('usage 5: the file and the route answer hold no account token, no proxy key and no message text', async () => {
  await claude(TOKEN.A);
  upstream = () => json({ usage: { input_tokens: 5, output_tokens: 6 } });
  await call();
  await call(JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: SECRET_TEXT }], system: SECRET_TEXT }));
  await lines(2);
  const text = readFileSync(USAGE, 'utf8');
  for (const bad of [...MARKERS, SECRET_TEXT, key, 'a@example.com', 'authorization', 'bearer']) assert.ok(!text.toLowerCase().includes(bad.toLowerCase()), `the file holds ${bad}`);
  for (const l of text.split('\n').filter(Boolean)) assert.deepEqual(Object.keys(JSON.parse(l)).sort(), LINE_KEYS);
  const r = await usageRoute('?days=7');
  assert.equal(r.status, 200);
  const body = JSON.stringify(r.body);
  for (const bad of [...MARKERS, SECRET_TEXT, key, 'a@example.com']) assert.ok(!body.includes(bad), `the answer holds ${bad}`);
  const s = r.body as Awaited<ReturnType<typeof summarize>>;
  assert.deepEqual(s.totals, { claude: { requests: 2, recorded: 2 }, codex: { requests: 0, recorded: 0 } });
  assert.equal(s.rows.length, 1);
  assert.deepEqual([s.rows[0].day, s.rows[0].model, s.rows[0].requests, s.rows[0].input, s.rows[0].output], ['2026-11-23', MODEL, 2, 10, 12]);
});

// ---- 6. the file ----

const mk = (over: Partial<UsageLine> = {}): UsageLine => ({ at: iso(NOW), provider: 'claude', account: 'acc-aaaaaaaaaaaa', model: 'm1', status: 200, input: 1, output: 2, cacheRead: null, cacheWrite: null, ms: 5, ...over });

test('usage 6: the file is 0600; lines older than 30 days are not counted and are removed once a day; loose or broken input is skipped', async () => {
  const path = join(FAKE_HOME, 'u6', 'usage.jsonl');
  const old = mk({ at: iso(NOW - 31 * DAY), account: 'acc-old' });
  mkdirSync(join(FAKE_HOME, 'u6'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(old)}\nnot json\n{"at":1}\n[]\n${JSON.stringify(mk({ at: iso(NOW - 29 * DAY) }))}\n`, { mode: 0o600 });
  const s30 = await summarize(30, path, new Date(NOW));
  assert.equal(s30.totals.claude.requests, 1, 'the 31-day-old line, and the broken ones, are not counted');
  assert.deepEqual(s30.rows.map((r) => r.account), ['acc-aaaaaaaaaaaa']);
  assert.equal((await summarize(7, path, new Date(NOW))).totals.claude.requests, 0, 'a 29-day-old line is not in 7 days');
  assert.equal((await summarize(99, path, new Date(NOW))).days, 30);

  // the first append of a day rewrites the file without the old lines; the second does not
  await appendUsage(mk(), path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(!readFileSync(path, 'utf8').includes('acc-old'), 'the old line is gone after the daily rewrite');
  assert.ok(!readFileSync(path, 'utf8').includes('not json'));
  writeFileSync(path, readFileSync(path, 'utf8') + `${JSON.stringify(old)}\n`, { mode: 0o600 });
  await appendUsage(mk(), path);
  assert.ok(readFileSync(path, 'utf8').includes('acc-old'), 'no second rewrite on the same day');
  await appendUsage(mk({ at: iso(NOW + DAY) }), path);
  assert.ok(!readFileSync(path, 'utf8').includes('acc-old'), 'the next day rewrites again');
  assert.equal(statSync(path).mode & 0o777, 0o600);

  // a new file is made 0600
  const fresh = join(FAKE_HOME, 'u6', 'fresh', 'usage.jsonl');
  await appendUsage(mk(), fresh);
  assert.equal(statSync(fresh).mode & 0o777, 0o600);

  // grouping and sums: a null count is left out of the sum, and `recorded` needs input and output
  const g = join(FAKE_HOME, 'u6', 'g.jsonl');
  for (const l of [mk({ input: 10, output: 5 }), mk({ input: null, output: null }), mk({ input: 3, output: null, cacheRead: 4 }), mk({ account: 'acc-b' }), mk({ at: iso(NOW - DAY) })]) await appendUsage(l, g);
  const sg = await summarize(7, g, new Date(NOW));
  assert.deepEqual(sg.totals.claude, { requests: 5, recorded: 3 });
  const row = sg.rows.find((r) => r.account === 'acc-aaaaaaaaaaaa' && r.day === '2026-11-23')!;
  assert.deepEqual([row.requests, row.input, row.output, row.cacheRead, row.cacheWrite], [3, 13, 5, 4, null]);

  // a file that group or others can read is neither read nor appended to
  chmodSync(g, 0o644);
  assert.deepEqual((await summarize(7, g, new Date(NOW))).totals.claude, { requests: 0, recorded: 0 });
  const before = readFileSync(g, 'utf8');
  await appendUsage(mk(), g);
  assert.equal(readFileSync(g, 'utf8'), before);
  assert.deepEqual((await summarize(7, join(FAKE_HOME, 'u6', 'missing.jsonl'), new Date(NOW))).rows, []);
  assert.equal(PATHS.accountsUsage, USAGE);
});

// ---- 7. the route ----

test('usage 7: the route is 404 when accounts are off, 403 for a caller that is not the owner, 400 for a bad days', async () => {
  await appendUsage(mk(), USAGE);
  const route = (accountsFeature.routes ?? []).find((x) => x.path === '/api/accounts/usage');
  assert.ok(route && route.method === 'GET' && !('write' in route && route.write));

  setAccountsEnabledForTest(() => false);
  assert.deepEqual([(await usageRoute('')).status, (await usageRoute('')).body], [404, { error: 'accounts disabled' }]);
  setAccountsEnabledForTest(() => true);

  for (const [headers, addr] of [
    [{}, '100.64.0.9'],
    [{ ...SERVE, 'tailscale-user-login': 'guest@example.com' }, '127.0.0.1'],
    [{ ...SERVE }, '127.0.0.1'],
  ] as [Record<string, string>, string][]) {
    const r = await usageRoute('', headers, addr);
    assert.equal(r.status, 403, JSON.stringify(headers));
    assert.equal((r.body as { error: string }).error, 'owner only');
    assert.ok(!JSON.stringify(r.body).includes('acc-'));
  }

  for (const q of ['?days=0', '?days=31', '?days=-1', '?days=1.5', '?days=abc', '?days=', '?days=%207', '?days=007x', '?days=100']) {
    const r = await usageRoute(q);
    assert.deepEqual([q, r.status, r.body], [q, 400, { error: 'invalid days' }]);
  }
  for (const [q, days] of [['', 7], ['?days=1', 1], ['?days=30', 30], ['?days=07', 7]] as [string, number][]) {
    const r = await usageRoute(q);
    assert.equal(r.status, 200, q);
    const b = r.body as { days: number; totals: unknown; rows: unknown[] };
    assert.deepEqual(Object.keys(b), ['days', 'totals', 'rows']);
    assert.equal(b.days, days);
    assert.deepEqual(b.totals, { claude: { requests: 1, recorded: 1 }, codex: { requests: 0, recorded: 0 } });
    assert.equal(b.rows.length, 1);
  }
});

// ---- the Codex lane ----

const CX_ACCOUNT_ID = 'cx-account-leakcheck-7731';
const CX_TOKEN = 'TESTTOKENCODEXUSAGE0123456789';
const cxAccount = () =>
  upsertAccount(
    { provider: 'codex', alias: 'cx-usage', identity: CX_ACCOUNT_ID, email: 'c@example.com', plan: 'plus', tokens: { access: CX_TOKEN, refresh: REFRESH, idToken: 'TESTTOKENIDTOKEN', expiresAt: iso(NOW + 100 * 3600_000) } },
    { path: FILE, now },
  );
const CX_BODY = () => JSON.stringify({ model: 'gpt-test', input: [{ role: 'user', content: SECRET_TEXT }] });
const cxEvent = (v: unknown) => `event: ${(v as { type: string }).type}\ndata: ${JSON.stringify(v)}\n\n`;
/** An SSE answer cut into pieces at the given byte offsets (and, when `cuts` is empty, whole) */
const cutSse = (bytes: Buffer, cuts: number[]) => {
  const pieces: Uint8Array[] = [];
  let from = 0;
  for (const c of [...cuts].sort((x, y) => x - y)) {
    pieces.push(new Uint8Array(bytes.subarray(from, c)));
    from = c;
  }
  pieces.push(new Uint8Array(bytes.subarray(from)));
  return new Response(new ReadableStream({ start: (c) => { for (const p of pieces) c.enqueue(p); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
};
/** The words of a streamed answer: the caller gets them, the usage file and the route must not hold them */
const DELTA_TEXT = 'ANSWER-DELTA-SENTENCE-5c1e';
const CODEX_NULLS = { input: null, output: null, cacheRead: null, cacheWrite: null };

test('usage codex 1: a Codex SSE answer across chunk borders is one line; the four counts are the usage of response.completed; the bytes are unchanged; nothing private is logged', async () => {
  const cx = await cxAccount();
  const usage = { input_tokens: 120, input_tokens_details: { cached_tokens: 80, cache_write_tokens: 5 }, output_tokens: 34, output_tokens_details: { reasoning_tokens: 9 }, total_tokens: 154 };
  const bytes = Buffer.from(
    cxEvent({ type: 'response.created', response: { id: 'resp_1', usage: { input_tokens: 1, output_tokens: 2 } } }) +
      cxEvent({ type: 'response.output_text.delta', delta: `${DELTA_TEXT} hé` }) +
      cxEvent({ type: 'response.output_text.delta', delta: ' more text', usage: { input_tokens: 3, output_tokens: 4 } }) +
      cxEvent({ type: 'response.completed', response: { id: 'resp_1', usage } }),
    'utf8',
  );
  // cut inside a JSON value, inside a line, inside the two bytes of the "é" and inside the last event
  const cuts = [25, bytes.indexOf('"delta"') + 4, bytes.indexOf('é') + 1, bytes.indexOf('response.completed') + 6, bytes.indexOf('"input_tokens":120') + 10, bytes.length - 2];
  upstream = () => cutSse(bytes, cuts);
  const r = await call(CX_BODY(), '/codex/responses');
  assert.equal(r.status, 200);
  assert.ok(r.bytes.equals(bytes), 'the caller got the upstream bytes, byte for byte');
  const rows = await lines(1);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), LINE_KEYS);
  assert.deepEqual({ ...rows[0], ms: 0 }, { at: iso(NOW), provider: 'codex', account: cx.id, model: 'gpt-test', status: 200, input: 120, output: 34, cacheRead: 80, cacheWrite: 5, ms: 0 });
  const text = readFileSync(USAGE, 'utf8');
  const summary = JSON.stringify((await usageRoute('?days=7')).body);
  for (const o of [text, summary]) for (const bad of [CX_TOKEN, CX_ACCOUNT_ID, key, SECRET_TEXT, 'TESTTOKEN', DELTA_TEXT, 'more text']) assert.ok(!o.includes(bad), `holds ${bad}`);
  const s = JSON.parse(summary) as Awaited<ReturnType<typeof summarize>>;
  assert.deepEqual(s.totals, { claude: { requests: 0, recorded: 0 }, codex: { requests: 1, recorded: 1 } });
  assert.deepEqual([s.rows[0].provider, s.rows[0].input, s.rows[0].output, s.rows[0].cacheRead, s.rows[0].cacheWrite], ['codex', 120, 34, 80, 5]);
});

test('usage codex 2: the usage of response.incomplete is read too', async () => {
  await cxAccount();
  const bytes = Buffer.from(
    cxEvent({ type: 'response.created', response: {} }) +
      cxEvent({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 10 }, output_tokens: 7 } } }),
    'utf8',
  );
  upstream = () => cutSse(bytes, [40, bytes.length - 9]);
  const r = await call(CX_BODY(), '/codex/responses');
  assert.ok(r.bytes.equals(bytes));
  const [line] = await lines(1);
  assert.deepEqual([line.input, line.output, line.cacheRead, line.cacheWrite], [50, 7, 10, null]);
});

test('usage codex 3: a missing cache_write_tokens or input_tokens_details is null, and so is a count that is not a number', async () => {
  await cxAccount();
  const answer = (usage: unknown) => cutSse(Buffer.from(cxEvent({ type: 'response.completed', response: { usage } }), 'utf8'), []);
  upstream = () => answer({ input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 3 });
  await call(CX_BODY(), '/codex/responses');
  upstream = () => answer({ input_tokens: 10, output_tokens: 3 });
  await call(CX_BODY(), '/codex/responses');
  upstream = () => answer({ input_tokens: '10', input_tokens_details: { cached_tokens: -1, cache_write_tokens: null }, output_tokens: 3 });
  await call(CX_BODY(), '/codex/responses');
  upstream = () => answer(undefined);
  await call(CX_BODY(), '/codex/responses');
  const rows = await lines(4);
  const four = (l: UsageLine) => [l.input, l.output, l.cacheRead, l.cacheWrite];
  assert.deepEqual(four(rows[0]), [10, 3, 4, null]);
  assert.deepEqual(four(rows[1]), [10, 3, null, null]);
  assert.deepEqual(four(rows[2]), [null, 3, null, null]);
  assert.deepEqual(four(rows[3]), [null, null, null, null]);
});

test('usage codex 4: a Codex JSON answer is read from its top-level usage; one over 1 MiB is not counted', async () => {
  await cxAccount();
  const answer = { id: 'resp_2', usage: { input_tokens: 21, input_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 }, output_tokens: 8 }, nested: { usage: { input_tokens: 999, output_tokens: 999 } } };
  upstream = () => json(answer);
  const r = await call(CX_BODY(), '/codex/responses');
  assert.deepEqual(JSON.parse(r.bytes.toString('utf8')), answer, 'the caller got the answer as it is');
  upstream = () => new Response(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 2 }, pad: 'D'.repeat(1_200_000) }), { status: 200, headers: { 'content-type': 'application/json' } });
  await call(CX_BODY(), '/codex/responses');
  const rows = await lines(2);
  assert.deepEqual([rows[0].input, rows[0].output, rows[0].cacheRead, rows[0].cacheWrite, rows[0].provider], [21, 8, 6, 2, 'codex']);
  assert.deepEqual([rows[1].status, rows[1].input, rows[1].output, rows[1].cacheRead, rows[1].cacheWrite], [200, null, null, null, null]);
});

test('usage codex 5: a caller that leaves before response.completed is one line with four null counts', { timeout: 20_000 }, async () => {
  const cx = await cxAccount();
  const start = cxEvent({ type: 'response.created', response: { usage: { input_tokens: 61, output_tokens: 1 } } }) + cxEvent({ type: 'response.output_text.delta', delta: 'partial' });
  upstream = () => sse([start], true);
  const { req, response } = open(CX_BODY(), '/codex/responses');
  const res = await response;
  await res[Symbol.asyncIterator]().next();
  const signal = ups[0].signal;
  req.destroy();
  res.destroy();
  const rows = await lines(1);
  assert.equal(rows.length, 1);
  assert.deepEqual({ account: rows[0].account, status: rows[0].status, ...CODEX_NULLS, ...Object.fromEntries(Object.keys(CODEX_NULLS).map((k) => [k, rows[0][k as keyof UsageLine]])) }, { account: cx.id, status: 200, ...CODEX_NULLS });
  assert.equal(signal.aborted, true);
});

test('usage codex 6: totals.codex.recorded is the number of Codex requests with both input and output', async () => {
  await cxAccount();
  const done = (usage: unknown) => cutSse(Buffer.from(cxEvent({ type: 'response.completed', response: { usage } }), 'utf8'), []);
  for (const u of [{ input_tokens: 5, output_tokens: 6 }, { input_tokens: 7 }, { output_tokens: 2 }, { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 1 } }]) {
    upstream = () => done(u);
    await call(CX_BODY(), '/codex/responses');
  }
  upstream = () => json({ id: 'no usage here' });
  await call(CX_BODY(), '/codex/responses');
  await lines(5);
  const s = (await usageRoute('?days=7')).body as Awaited<ReturnType<typeof summarize>>;
  assert.deepEqual(s.totals, { claude: { requests: 0, recorded: 0 }, codex: { requests: 5, recorded: 2 } });
  assert.deepEqual([s.rows[0].requests, s.rows[0].input, s.rows[0].output, s.rows[0].cacheRead], [5, 13, 9, 1]);
});

test('usage codex 7: a response.completed of 300 KiB is read; one over 1 MiB is dropped (null counts) and its bytes reach the caller unchanged', async () => {
  await cxAccount();
  const completed = (text: string) =>
    cxEvent({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 90, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 3 }, output_tokens: 12 } } });
  const big = Buffer.from(cxEvent({ type: 'response.created', response: {} }) + completed('E'.repeat(300 * 1024)), 'utf8');
  const cuts = [100, 70_000, 150_000, 299_000, big.length - 5];
  upstream = () => cutSse(big, cuts);
  const r1 = await call(CX_BODY(), '/codex/responses');
  assert.ok(r1.bytes.equals(big), 'the caller got the upstream bytes');
  const huge = Buffer.from(completed('F'.repeat(1_100_000)), 'utf8');
  upstream = () => cutSse(huge, [200_000, 900_000]);
  const r2 = await call(CX_BODY(), '/codex/responses');
  assert.ok(r2.bytes.equals(huge), 'the caller got the upstream bytes of the long event');
  const rows = await lines(2);
  assert.deepEqual([rows[0].input, rows[0].output, rows[0].cacheRead, rows[0].cacheWrite], [90, 12, 30, 3]);
  assert.deepEqual([rows[1].status, rows[1].input, rows[1].output, rows[1].cacheRead, rows[1].cacheWrite], [200, null, null, null, null]);
  const text = readFileSync(USAGE, 'utf8');
  assert.ok(!text.includes('EEEE') && !text.includes('FFFF'), 'no answer text in the file');
});

test('observer: a Codex observer keeps at most about 1 MiB of one event, and Claude keeps 64 KiB', async () => {
  const run = async (provider: 'claude' | 'codex') => {
    const o = new UsageObserver(true, false, provider);
    o.resume();
    let worst = 0;
    const line = `data: {"type":"x","pad":"${'G'.repeat(3 * 1024 * 1024)}"}\n\n`;
    for (let i = 0; i < line.length; i += 16 * 1024) {
      await new Promise<void>((resolve) => o.write(line.slice(i, i + 16 * 1024), () => resolve()));
      worst = Math.max(worst, o.heldSize());
    }
    o.end();
    return worst;
  };
  assert.ok((await run('claude')) <= MAX_SSE + 16 * 1024);
  assert.ok((await run('codex')) <= 1024 * 1024 + 16 * 1024);
});

// ---- review fixes ----

const enc = new TextEncoder();
const MAX_SSE = 64 * 1024;
const EMPTY = { claude: { requests: 0, recorded: 0 }, codex: { requests: 0, recorded: 0 } };

test('observer: empty data lines, a long line and a long event keep the held size bounded, and the next events are still read', async () => {
  // several MiB of empty `data:` lines, with no blank line between them
  const o = new UsageObserver(true, false);
  o.resume();
  const chunk = Buffer.from('data:\n'.repeat(4096));
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    await new Promise<void>((resolve) => o.write(chunk, () => resolve()));
    worst = Math.max(worst, o.heldSize());
  }
  assert.ok(worst <= MAX_SSE + 16, `held ${worst}`);
  // the blank line ends the dropped event; the next event is read
  o.write('\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n');
  // a line of 70 KiB in 16 KiB pieces, then a message_delta
  const line = `data: {"type":"x","pad":"${'A'.repeat(70 * 1024)}"}\n\n`;
  for (let i = 0; i < line.length; i += 16 * 1024) {
    await new Promise<void>((resolve) => o.write(line.slice(i, i + 16 * 1024), () => resolve()));
    assert.ok(o.heldSize() <= MAX_SSE + 16 * 1024, 'held while a long line arrives');
  }
  o.write('data: {"type":"message_delta","usage":{"output_tokens":9}}\n\n');
  o.end();
  await new Promise((r) => o.once('end', r));
  const t = o.result();
  assert.deepEqual([t.input, t.output], [10, 9]);
});

test('usage: an SSE answer of empty data lines reaches the caller unchanged, and a 70 KiB line is dropped but the next message_delta is read', async () => {
  await claude(TOKEN.A);
  const empties = 'data:\n'.repeat(200_000);
  upstream = () => sse([empties]);
  const r = await call();
  assert.ok(r.bytes.equals(Buffer.from(empties)), 'the bytes are the upstream bytes');
  const big =
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n' +
    `data: {"type":"x","pad":"${'B'.repeat(70 * 1024)}"}\n\n` +
    'data: {"type":"message_delta","usage":{"output_tokens":9}}\n\n';
  upstream = () => sse([big.slice(0, 20_000), big.slice(20_000, 60_000), big.slice(60_000)]);
  const r2 = await call();
  assert.ok(r2.bytes.equals(Buffer.from(big)));
  const rows = await lines(2);
  assert.deepEqual([rows[0].input, rows[0].output, rows[1].input, rows[1].output], [null, null, 10, 9]);
});

test('usage: a JSON answer over 1 MiB is logged without counts and reaches the caller whole', async () => {
  await claude(TOKEN.A);
  const answer = JSON.stringify({ usage: { input_tokens: 1, output_tokens: 2 }, pad: 'C'.repeat(1_200_000) });
  upstream = () => new Response(answer, { status: 200, headers: { 'content-type': 'application/json' } });
  const r = await call();
  assert.equal(r.bytes.toString('utf8'), answer);
  const [line] = await lines(1);
  assert.deepEqual([line.status, line.input, line.output, line.cacheRead, line.cacheWrite], [200, null, null, null, null]);
});

test('usage: an unreadable log file is `unavailable`, a missing one is an empty log', async () => {
  const missing = (await usageRoute('?days=7')).body as { unavailable?: boolean; totals: unknown };
  assert.ok(!missing.unavailable);
  assert.deepEqual(missing.totals, EMPTY);
  await appendUsage(mk(), USAGE);
  assert.ok(!((await usageRoute('?days=7')).body as { unavailable?: boolean }).unavailable, 'a readable file is not unavailable');
  chmodSync(USAGE, 0o644);
  const loose = (await usageRoute('?days=7')).body as { unavailable?: boolean; totals: unknown; rows: unknown[] };
  assert.equal(loose.unavailable, true);
  assert.deepEqual([loose.totals, loose.rows], [EMPTY, []]);
  // not a regular file
  rmSync(USAGE, { force: true });
  mkdirSync(USAGE);
  assert.equal(((await usageRoute('?days=7')).body as { unavailable?: boolean }).unavailable, true);
  rmSync(USAGE, { recursive: true });
});

test('usage: the daily rewrite moves forward only, and a failed rewrite is tried again with the next line', async () => {
  const dir = join(FAKE_HOME, 'u9');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'usage.jsonl');
  const d1 = NOW;
  const d2 = NOW + DAY;
  const planted = () => writeFileSync(path, readFileSync(path, 'utf8') + `${JSON.stringify(mk({ at: iso(d1 - 31 * DAY), account: 'acc-old' }))}\n`, { mode: 0o600 });
  const has = () => readFileSync(path, 'utf8').includes('acc-old');
  await appendUsage(mk({ at: iso(d1) }), path);
  planted();
  await appendUsage(mk({ at: iso(d2) }), path);
  assert.equal(has(), false, 'a later day rewrites');
  planted();
  // lines that alternate around midnight: the earlier day never starts another rewrite
  await appendUsage(mk({ at: iso(d1) }), path);
  await appendUsage(mk({ at: iso(d2) }), path);
  await appendUsage(mk({ at: iso(d1 - DAY) }), path);
  assert.equal(has(), true, 'no second rewrite for the same or an earlier day');
  await appendUsage(mk({ at: iso(d2 + DAY) }), path);
  assert.equal(has(), false);

  // a failed rewrite is not marked as done (a folder that cannot be written needs a user other than root)
  if (process.getuid?.() === 0) return;
  const dir2 = join(FAKE_HOME, 'u9b');
  mkdirSync(dir2, { recursive: true });
  const p2 = join(dir2, 'usage.jsonl');
  writeFileSync(p2, `${JSON.stringify(mk({ at: iso(d1 - 31 * DAY), account: 'acc-old' }))}\n`, { mode: 0o600 });
  chmodSync(dir2, 0o500);
  try {
    await appendUsage(mk({ at: iso(d1) }), p2);
    assert.ok(readFileSync(p2, 'utf8').includes('acc-old'), 'the rewrite failed, the old line is still there');
  } finally {
    chmodSync(dir2, 0o700);
  }
  await appendUsage(mk({ at: iso(d1) }), p2);
  assert.ok(!readFileSync(p2, 'utf8').includes('acc-old'), 'the next line rewrites again');
});

test('usage: close() waits for the line of a stream it cuts off', { timeout: 20_000 }, async () => {
  const a = await claude(TOKEN.A);
  const start = 'event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 31, output_tokens: 1 } } }) + '\n\n';
  upstream = () => sse([start], true);
  const { req, response } = open();
  response.catch(() => {});
  const res = await response;
  res.on('error', () => {});
  await res[Symbol.asyncIterator]().next();
  assert.equal(existsSync(USAGE), false, 'the stream is still open and has no line yet');
  await proxy.close();
  // no waiting for the file: it is there when close() has returned
  const rows = readFileSync(USAGE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as UsageLine);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].account, rows[0].status, rows[0].input], [a.id, 200, 31]);
  req.destroy();
  res.destroy();
});

test('usage: a header timeout, an upstream that breaks after its headers and a caller that leaves between two accounts are one line each', { timeout: 20_000 }, async () => {
  const a = await claude(TOKEN.A);
  // the wait for the headers runs out: 502 and status 0
  const slow = new AccountsProxy({
    ...homesOpts(),
    fetch: ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch,
    keyPath: KEY_FILE,
    usagePath: USAGE,
    upstreamHeadersMs: 30,
  });
  await slow.sync({ enabled: true, port: 0 });
  const r = await call(REQUEST, '/v1/messages', slow.report().port);
  assert.equal(r.status, 502);
  await slow.close();
  let rows = await lines(1);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].account, rows[0].status, rows[0].input, rows[0].output], [a.id, 0, null, null]);

  // the upstream breaks after its headers: the status it gave and the counts seen so far
  const start = 'event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 44, output_tokens: 2 } } }) + '\n\n';
  upstream = () =>
    new Response(new ReadableStream({ start: (c) => { c.enqueue(enc.encode(start)); setTimeout(() => c.error(new Error('broke')), 20); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const broken = open();
  broken.response.then((res) => { res.on('error', () => {}); res.resume(); }, () => {});
  rows = await lines(2);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[1].account, rows[1].status, rows[1].input, rows[1].output], [a.id, 200, 44, 2]);
  broken.req.destroy();

  // the caller leaves while the first account answers a rejected limit: status 0, no second account is asked
  const b = await claude(TOKEN.B);
  const gone = open();
  gone.response.catch(() => {});
  const before = ups.length;
  upstream = async () => {
    gone.req.destroy();
    const signal = ups[ups.length - 1].signal;
    await new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true })));
    return rejected(Math.floor(NOW / 1000) + 3600);
  };
  rows = await lines(3);
  assert.equal(rows.length, 3);
  assert.equal(ups.length, before + 1, 'only one account was asked');
  assert.equal(rows[2].status, 0);
  assert.ok([a.id, b.id].includes(rows[2].account));
  assert.deepEqual([rows[2].input, rows[2].output], [null, null]);
});
