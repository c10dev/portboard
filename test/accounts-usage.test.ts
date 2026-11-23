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

const { AccountsProxy, PROXY_HOST, setProxyConfigForTest } = await import('../src/core/accounts/proxy.ts');
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

function open(body: Buffer | string = REQUEST, path = '/v1/messages') {
  const req = httpRequest({ host: PROXY_HOST, port: portOf(), path, method: 'POST', headers: { authorization: `Bearer ${key}` }, agent: false });
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req.on('response', resolve);
    req.on('error', reject);
  });
  req.end(body);
  return { req, response };
}
async function call(body: Buffer | string = REQUEST, path = '/v1/messages') {
  const res = await open(body, path).response;
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

test('usage codex: one Codex request is one line with provider codex and no token counts; the caller gets the upstream bytes; nothing private is logged', async () => {
  const ACCOUNT_ID = 'cx-account-leakcheck-7731';
  const CX_TOKEN = 'TESTTOKENCODEXUSAGE0123456789';
  const cx = await upsertAccount(
    { provider: 'codex', alias: 'cx-usage', identity: ACCOUNT_ID, email: 'c@example.com', plan: 'plus', tokens: { access: CX_TOKEN, refresh: REFRESH, idToken: 'TESTTOKENIDTOKEN', expiresAt: iso(NOW + 100 * 3600_000) } },
    { path: FILE, now },
  );
  // an answer that looks like Codex's stream, with usage numbers the log must not read, cut at an awkward place
  const bytes = Buffer.from('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 6 } } }) + '\n\n', 'utf8');
  const answer = new Response(new ReadableStream({ start: (c) => { c.enqueue(new Uint8Array(bytes.subarray(0, 20))); c.enqueue(new Uint8Array(bytes.subarray(20))); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  upstream = () => answer;
  const r = await call(JSON.stringify({ model: 'gpt-test', input: [{ role: 'user', content: SECRET_TEXT }] }), '/codex/responses');
  assert.equal(r.status, 200);
  assert.ok(r.bytes.equals(bytes), 'the caller got the upstream bytes, byte for byte');
  const rows = await lines(1);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), LINE_KEYS);
  assert.deepEqual({ ...rows[0], ms: 0 }, { at: iso(NOW), provider: 'codex', account: cx.id, model: 'gpt-test', status: 200, input: null, output: null, cacheRead: null, cacheWrite: null, ms: 0 });
  const text = readFileSync(USAGE, 'utf8');
  const summary = JSON.stringify((await usageRoute('?days=7')).body);
  for (const o of [text, summary]) for (const bad of [CX_TOKEN, ACCOUNT_ID, key, SECRET_TEXT, 'TESTTOKEN']) assert.ok(!o.includes(bad), `holds ${bad}`);
  const s = JSON.parse(summary) as Awaited<ReturnType<typeof summarize>>;
  assert.deepEqual(s.totals, { claude: { requests: 0, recorded: 0 }, codex: { requests: 1, recorded: 0 } });
  assert.deepEqual([s.rows[0].provider, s.rows[0].input, s.rows[0].output], ['codex', null, null]);
});
