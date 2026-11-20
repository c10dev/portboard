// Accounts, read-only (docs/accounts.md): the two login files, the usage requests, the cache, the allowlisted answer,
// the owner-only route, the local-only tool. Every file is a fixture in a fake home, every fetch is a fake, and the
// real ~/.claude, ~/.codex and usage endpoints are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

// Safety net first: nothing below may reach the network, the real home or a real config path. src/ is imported
// dynamically (a static import would run before these lines).
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'pb-accounts-'));
globalThis.fetch = (() => {
  throw new Error('test reached the real fetch: inject one');
}) as typeof fetch;
process.env.HOME = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, 'claude-dir');
process.env.CODEX_HOME = join(FAKE_HOME, 'codex-dir');
for (const k of Object.keys(process.env)) if (k.startsWith('PORTBOARD_') && k !== 'PORTBOARD_LOCALE') delete process.env[k];

const { detectLogins, decodeJwtPayload } = await import('../src/core/accounts/detect.ts');
const { clearQuotaCache, fetchQuota, QUOTA_REQUESTS } = await import('../src/core/accounts/quota.ts');
const { accountsReport } = await import('../src/core/accounts/view.ts');
const { accountsFeature, setAccountsEnabledForTest, setAccountsOptionsForTest } = await import('../src/features/accounts.ts');
const { appRouter } = await import('../src/features/router.ts');
const { REGISTRY } = await import('../src/features/registry.ts');
const { REMOTE_TOOLS } = await import('../src/remote/tools.ts');
const { callTool } = await import('../src/mcp/tools.ts');
const { TAILSCALE_POLICY } = await import('../src/core/access.ts');
const { AuditLog } = await import('../src/core/audit.ts');
const { L } = await import('./fixtures/locale.ts');
type ServerContext = import('../src/features/context.ts').ServerContext;
type Core = import('../src/mcp/kit.ts').Core;

const NOW = Date.parse('2026-11-20T09:00:00Z');
const now = () => NOW;
const OWNER = 'owner@example.com';

// ---- fixtures ----

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload: unknown) => `eyJhbGciOiJub25lIn0.${b64(payload)}.TESTSIGNATURE`;

const CLAUDE_ACCESS = 'sk-ant-oat01-TESTACCESS0123456789abcdef';
const CLAUDE_REFRESH = 'sk-ant-ort01-TESTREFRESH0123456789abcdef';
const CODEX_ACCESS = jwt({ exp: NOW / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } });
const CODEX_ID = jwt({ email: 'user@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } });
const CODEX_REFRESH = 'TESTREFRESHCODEX0123456789abcdef';
const CODEX_ACCOUNT = 'acct-test-0001';
const SECRETS = [CLAUDE_ACCESS, CLAUDE_REFRESH, CODEX_ACCESS, CODEX_ID, CODEX_REFRESH, CODEX_ACCOUNT];

const claudeFile = (over: Record<string, unknown> = {}) => ({
  claudeAiOauth: {
    accessToken: CLAUDE_ACCESS,
    refreshToken: CLAUDE_REFRESH,
    expiresAt: NOW + 6 * 3600_000,
    refreshTokenExpiresAt: NOW + 30 * 86_400_000,
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_5x',
    scopes: ['user:inference'],
    ...over,
  },
  mcpOAuth: { server: { accessToken: 'MCPSECRETTOKEN' } },
});
const codexFile = (over: Record<string, unknown> = {}) => ({
  OPENAI_API_KEY: null,
  tokens: { access_token: CODEX_ACCESS, id_token: CODEX_ID, refresh_token: CODEX_REFRESH, account_id: CODEX_ACCOUNT, ...over },
  last_refresh: '2026-11-19T00:00:00Z',
});

/** A fake home with the given files (a string is written as it is, an object as JSON). Returns the injected options. */
function home(files: { claude?: unknown; codex?: unknown }) {
  const dir = mkdtempSync(join(FAKE_HOME, 'h-'));
  const claudeDir = join(dir, '.claude');
  const codexDir = join(dir, '.codex');
  const put = (d: string, name: string, v: unknown) => {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, name), typeof v === 'string' ? v : JSON.stringify(v));
  };
  if (files.claude !== undefined) put(claudeDir, '.credentials.json', files.claude);
  if (files.codex !== undefined) put(codexDir, 'auth.json', files.codex);
  return { home: dir, env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir } };
}

const CLAUDE_BODY = { five_hour: { utilization: 42.5, resets_at: '2026-11-20T12:00:00Z' }, seven_day: { utilization: 10, resets_at: '2026-11-25T00:00:00Z' }, seven_day_opus: null };
const CLAUDE_NEW_BODY = {
  limits: [
    { kind: 'session', percent: '7', resets_at: 1763640000 },
    { kind: 'weekly_all', percent: 55, resets_at: 1764000000000 },
    { kind: 'weekly_scoped', percent: 3, resets_at: null, scope: { model: { display_name: 'Opus' } } },
  ],
  five_hour: { utilization: 99, resets_at: null },
};
const CODEX_BODY = {
  email: 'user@example.com',
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 12, reset_at: 1763640000, limit_window_seconds: 18000 },
    secondary_window: { used_percent: '40', reset_at: 1764000000, limit_window_seconds: 604800 },
    tertiary_window: null,
  },
};

interface Call {
  url: string;
  headers: Record<string, string>;
}
/** A fake fetch: `answer(url)` is a Response, or a function that throws */
function fakeFetch(answer: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    return answer(String(url));
  }) as typeof fetch;
  return { fetch: f, calls };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const byHost = (url: string) => (url.includes('anthropic') ? json(CLAUDE_BODY) : json(CODEX_BODY));

test.beforeEach(() => {
  clearQuotaCache();
  setAccountsEnabledForTest(null);
  setAccountsOptionsForTest(null);
});

// ---- route and tool harness ----

function request(addr: string, headers: Record<string, string> = {}) {
  const r = Readable.from([]) as any;
  r.method = 'GET';
  r.headers = headers;
  r.socket = { remoteAddress: addr };
  return r;
}
function context() {
  const audit = new AuditLog(join(mkdtempSync(join(FAKE_HOME, 'a-')), 'audit.jsonl'));
  const fake = { owner: async () => OWNER, policy: async () => TAILSCALE_POLICY, device: async (addr: string) => ({ addr }), writeDevices: async () => null, ts: { available: true }, audit };
  return new Proxy(fake as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : assert.fail(`handler touched ctx.${String(k)}`)) }) as unknown as ServerContext;
}
const SERVE = { 'x-forwarded-for': '100.101.102.103', 'x-forwarded-host': 'devbox.example.ts.net', 'x-forwarded-proto': 'https' };
const get = (addr: string, headers: Record<string, string> = {}) => {
  const ctx = context();
  return appRouter(REGISTRY.routes, ctx)(request(addr, headers), new URL('http://x/api/accounts'), ctx);
};

// ---- 1. no token leaves the process ----

test('no token string is in the route answer, the tool output or an error path; the request carries the access token', async () => {
  const h = home({ claude: claudeFile(), codex: codexFile() });
  const ok = fakeFetch(byHost);
  setAccountsEnabledForTest(() => true);
  setAccountsOptionsForTest(() => ({ ...h, fetch: ok.fetch, now }));

  const route = await get('127.0.0.1');
  assert.equal(route?.status, 200);
  const tool = await callTool('list_accounts', {}, {} as Core);
  assert.equal(tool.isError, undefined);
  const outputs = [JSON.stringify(route?.body), tool.content[0].text];

  // the request is right: each access token goes out as a bearer token, to its own host only
  const claudeCall = ok.calls.find((c) => c.url === QUOTA_REQUESTS.claude.url);
  const codexCall = ok.calls.find((c) => c.url === QUOTA_REQUESTS.codex.url);
  assert.equal(claudeCall?.headers.Authorization, `Bearer ${CLAUDE_ACCESS}`);
  assert.equal(codexCall?.headers.Authorization, `Bearer ${CODEX_ACCESS}`);
  assert.equal(codexCall?.headers['ChatGPT-Account-Id'], CODEX_ACCOUNT);
  assert.deepEqual(ok.calls.map((c) => new URL(c.url).host).sort(), ['api.anthropic.com', 'chatgpt.com']);

  // error paths: 401, 500 and a timeout
  const timeout = () => {
    throw new DOMException('The operation timed out.', 'TimeoutError');
  };
  for (const answer of [() => json({ error: CLAUDE_ACCESS }, 401), () => new Response(`${CLAUDE_ACCESS} ${CODEX_ID}`, { status: 500 }), timeout]) {
    clearQuotaCache();
    const bad = fakeFetch(answer);
    outputs.push(JSON.stringify(await accountsReport({ ...h, fetch: bad.fetch, now })));
    setAccountsOptionsForTest(() => ({ ...h, fetch: bad.fetch, now }));
    clearQuotaCache();
    outputs.push(JSON.stringify((await get('127.0.0.1'))?.body), (await callTool('list_accounts', {}, {} as Core)).content[0].text);
  }
  for (const out of outputs) for (const s of SECRETS) assert.ok(!out.includes(s), `leaks ${s.slice(0, 14)}…`);
  for (const out of outputs) assert.ok(!out.includes('MCPSECRETTOKEN'));
});

test('the view is an allowlist: only the named fields, no account id', async () => {
  const h = home({ claude: claudeFile(), codex: codexFile() });
  const r = await accountsReport({ ...h, fetch: fakeFetch(byHost).fetch, now });
  for (const a of r.accounts) {
    assert.deepEqual(Object.keys(a).sort(), ['email', 'error', 'expiresAt', 'id', 'needsReauth', 'plan', 'provider', 'quota', 'source', 'status', 'tier']);
    assert.equal(a.source, 'local-cli');
  }
  assert.deepEqual(Object.keys(r).sort(), ['accounts', 'at']);
  assert.match(r.accounts[1].id, /^codex-[0-9a-f]{12}$/);
  assert.equal(r.at, new Date(NOW).toISOString());
});

// ---- 2. off by default ----

test('accounts.enabled off: the route is 404 and the tool says so, and no file is read', async () => {
  const failRead = async () => assert.fail('a login file was read while accounts are disabled');
  setAccountsOptionsForTest(() => ({ readFile: failRead, fetch: (() => assert.fail('fetch while disabled')) as typeof fetch }));
  setAccountsEnabledForTest(() => false);
  const r = await get('127.0.0.1');
  assert.equal(r?.status, 404);
  assert.deepEqual(r?.body, { error: 'accounts disabled' });
  const t = await callTool('list_accounts', {}, {} as Core);
  assert.equal(t.isError, true);
  assert.match(t.content[0].text, /accounts disabled/);
});

// ---- 3. owner only ----

test('a non-owner gets 403 owner only and no file is read', async () => {
  setAccountsEnabledForTest(() => true);
  setAccountsOptionsForTest(() => ({ readFile: async () => assert.fail('a login file was read for a non-owner'), fetch: (() => assert.fail('fetch for a non-owner')) as typeof fetch }));
  for (const [addr, headers, why] of [
    ['100.64.0.9', {}, 'a direct tailnet caller'],
    ['127.0.0.1', { ...SERVE, 'tailscale-user-login': 'guest@example.com' }, 'a node shared in, another login'],
    ['127.0.0.1', SERVE, 'a tagged node through serve'],
  ] as const) {
    const r = await get(addr, headers);
    assert.equal(r?.status, 403, why);
    assert.equal((r?.body as { error?: string }).error, 'owner only', why);
  }
  // the owner through serve gets in (reads fail test, so give it a home)
  const h = home({});
  setAccountsOptionsForTest(() => ({ ...h, fetch: (() => assert.fail('no login, no request')) as typeof fetch, now }));
  assert.equal((await get('127.0.0.1', { ...SERVE, 'tailscale-user-login': OWNER }))?.status, 200);
});

// ---- 4. states and errors, none of which throw ----

test('no file → none; broken JSON, wrong types, a missing key → unreadable; neither asks for limits', async () => {
  const none = fakeFetch(byHost);
  const empty = await detectLogins(home({}));
  assert.deepEqual(empty.map((l) => [l.provider, l.status]), [['claude', 'none'], ['codex', 'none']]);
  const r = await accountsReport({ ...home({}), fetch: none.fetch, now });
  assert.deepEqual(r.accounts.map((a) => [a.status, a.quota, a.error]), [['none', null, null], ['none', null, null]]);

  const bad = [
    home({ claude: '{not json', codex: '' }),
    home({ claude: { claudeAiOauth: { accessToken: 5, expiresAt: 'x' } }, codex: { tokens: { access_token: 7 } } }),
    home({ claude: { other: 1 }, codex: { tokens: {} } }),
    home({ claude: [], codex: 'null' }),
  ];
  for (const h of bad) {
    const rep = await accountsReport({ ...h, fetch: none.fetch, now });
    assert.deepEqual(rep.accounts.map((a) => a.status), ['unreadable', 'unreadable']);
    assert.ok(rep.accounts.every((a) => a.error === 'credentials file unreadable' && a.quota === null));
  }
  // not ENOENT: a read that fails for another reason is unreadable, not none
  const denied = await detectLogins({ ...home({}), readFile: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } });
  assert.deepEqual(denied.map((l) => l.status), ['unreadable', 'unreadable']);
  assert.equal(none.calls.length, 0);
});

test('401 → expired, 500 → an error, a timeout → an error; none of them throws', async () => {
  const h = home({ claude: claudeFile(), codex: undefined });
  const run = async (answer: () => Response) => {
    clearQuotaCache();
    return (await accountsReport({ ...h, fetch: fakeFetch(answer).fetch, now })).accounts[0];
  };
  const a401 = await run(() => json({}, 401));
  assert.equal(a401.status, 'expired');
  assert.equal(a401.error, 'quota request refused (HTTP 401)');
  assert.equal((await run(() => json({}, 403))).error, 'quota request refused (HTTP 403)');
  const a500 = await run(() => json({}, 500));
  assert.equal(a500.status, 'ok');
  assert.equal(a500.error, 'quota request failed (HTTP 500)');
  assert.equal((await run(() => json({}, 429))).error, 'quota rate limited');
  assert.equal((await run(() => new Response('not json', { status: 200 }))).error, 'quota response unusable');
  assert.equal((await run(() => json([1, 2]))).error, 'quota response unusable');
  assert.equal((await run(() => new Response('x'.repeat(600 * 1024), { status: 200 }))).error, 'quota response too large');
  const timeout = await accountsReport({ ...h, now, fetch: (async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }) as typeof fetch });
  assert.equal(timeout.accounts[0].error, 'quota request timed out');
  const down = await accountsReport({ ...h, now, fetch: (async () => { throw new TypeError(`fetch failed ${CLAUDE_ACCESS}`); }) as typeof fetch });
  assert.equal(down.accounts[0].error, 'quota request failed');
});

test('an expired refresh token → needsReauth; an expired access token → expired, with no request', async () => {
  const reauth = home({ claude: claudeFile({ refreshTokenExpiresAt: NOW - 1000 }) });
  const a = (await accountsReport({ ...reauth, fetch: fakeFetch(byHost).fetch, now })).accounts[0];
  assert.equal(a.needsReauth, true);
  assert.equal(a.status, 'ok');
  assert.equal((await accountsReport({ ...home({ claude: claudeFile() }), fetch: fakeFetch(byHost).fetch, now })).accounts[0].needsReauth, false);

  clearQuotaCache();
  const lapsed = fakeFetch(byHost);
  const old = home({ claude: claudeFile({ expiresAt: NOW - 60_000 }), codex: codexFile({ access_token: jwt({ exp: NOW / 1000 - 60 }) }) });
  const r = await accountsReport({ ...old, fetch: lapsed.fetch, now });
  assert.deepEqual(r.accounts.map((x) => [x.status, x.error]), [['expired', 'access token expired'], ['expired', 'access token expired']]);
  assert.equal(lapsed.calls.length, 0);
});

// ---- 5. cache ----

test('the cache: a second call within 5 minutes asks nothing; a failure after that returns the first value as stale', async () => {
  const [login] = await detectLogins(home({ claude: claudeFile() }));
  const f = fakeFetch(() => json(CLAUDE_BODY));
  const first = await fetchQuota(login, { fetch: f.fetch, now: () => NOW });
  const again = await fetchQuota(login, { fetch: f.fetch, now: () => NOW + 4 * 60_000 });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(again.quota, first.quota);
  assert.equal(first.quota?.stale, false);

  const failing = fakeFetch(() => json({}, 500));
  const later = await fetchQuota(login, { fetch: failing.fetch, now: () => NOW + 6 * 60_000 });
  assert.equal(failing.calls.length, 1);
  assert.equal(later.error, 'quota request failed (HTTP 500)');
  assert.equal(later.quota?.stale, true);
  assert.deepEqual(later.quota?.windows, first.quota?.windows);
  assert.equal(later.quota?.fetchedAt, first.quota?.fetchedAt);

  clearQuotaCache();
  const none = await fetchQuota(login, { fetch: failing.fetch, now: () => NOW });
  assert.equal(none.quota, null);
});

// ---- 6. never remote ----

test('list_accounts is not on the remote server', () => {
  assert.ok(!REMOTE_TOOLS.some((t) => t.name === 'list_accounts'));
  assert.ok(!REGISTRY.remoteCalls.has('list_accounts'));
  assert.ok(!(accountsFeature.tools ?? []).some((t) => 'remote' in t && t.remote));
  const def = REGISTRY.tools.find((t) => t.def.name === 'list_accounts')?.def;
  assert.deepEqual(def?.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  assert.equal(accountsFeature.order, 2575);
  assert.ok(accountsFeature.routes?.every((r) => r.method === 'GET'));
});

// ---- 7. response parsing ----

test('Claude usage, old and new shapes; Codex usage; plan and email precedence', async () => {
  const claude = home({ claude: claudeFile() });
  const iso = (ms: number) => new Date(ms).toISOString();

  const old = (await accountsReport({ ...claude, fetch: fakeFetch(() => json(CLAUDE_BODY)).fetch, now })).accounts[0];
  assert.deepEqual(old.quota?.windows, [
    { name: '5h', usedPct: 42.5, resetsAt: '2026-11-20T12:00:00.000Z' },
    { name: 'weekly', usedPct: 10, resetsAt: '2026-11-25T00:00:00.000Z' },
  ]);
  assert.equal(old.plan, 'max');
  assert.equal(old.tier, 'default_claude_max_5x');

  clearQuotaCache();
  const fresh = (await accountsReport({ ...claude, fetch: fakeFetch(() => json(CLAUDE_NEW_BODY)).fetch, now })).accounts[0];
  assert.deepEqual(fresh.quota?.windows, [
    { name: '5h', usedPct: 7, resetsAt: iso(1763640000 * 1000) },
    { name: 'weekly', usedPct: 55, resetsAt: iso(1764000000000) },
    { name: 'weekly-opus', usedPct: 3, resetsAt: null },
  ]);

  clearQuotaCache();
  const codex = home({ codex: codexFile() });
  const [, c] = (await accountsReport({ ...codex, fetch: fakeFetch(() => json(CODEX_BODY)).fetch, now })).accounts;
  assert.deepEqual(c.quota?.windows, [
    { name: '5h', usedPct: 12, resetsAt: iso(1763640000 * 1000) },
    { name: 'weekly', usedPct: 40, resetsAt: iso(1764000000 * 1000) },
  ]);
  assert.equal(c.plan, 'plus', 'the response wins over the id_token claim');
  assert.equal(c.email, 'user@example.com');

  // without plan_type and email in the answer, the id_token claims show
  clearQuotaCache();
  const [, claims] = (await accountsReport({ ...codex, fetch: fakeFetch(() => json({ rate_limit: {} })).fetch, now })).accounts;
  assert.equal(claims.plan, 'plus');
  assert.equal(claims.email, 'user@example.com');
  assert.equal(claims.expiresAt, iso(NOW + 3600_000));
});

test('windows: percentages clamp to 0-100, odd values become null, a repeated Codex name gets -2', async () => {
  const [, codex] = await detectLogins(home({ codex: codexFile() }));
  const f = fakeFetch(() => json({ rate_limit: { primary_window: { used_percent: 140, reset_at: 0, limit_window_seconds: 3600 }, secondary_window: { used_percent: 'n/a', reset_at: '2026-11-21T00:00:00Z', limit_window_seconds: 7200 }, tertiary_window: { used_percent: -5, limit_window_seconds: 3_000_000 } } }));
  const r = await fetchQuota(codex, { fetch: f.fetch, now });
  assert.deepEqual(r.quota?.windows, [
    { name: '5h', usedPct: 100, resetsAt: null },
    { name: '5h-2', usedPct: null, resetsAt: '2026-11-21T00:00:00.000Z' },
    { name: 'monthly', usedPct: 0, resetsAt: null },
  ]);
});

test('decodeJwtPayload: the payload, or null; it never throws', () => {
  assert.deepEqual(decodeJwtPayload(jwt({ a: 1 })), { a: 1 });
  for (const bad of ['', 'x', 'a.b', 'a.!!!.c', `a.${b64('text')}.c`, `a.${b64([1])}.c`]) assert.equal(decodeJwtPayload(bad), null, bad);
});

// ---- 8. wording ----

test('the dashboard section is wired and worded in both languages', async () => {
  const en = (await import('../public/i18n/en.json', { with: { type: 'json' } })).default as Record<string, string>;
  const ko = (await import('../public/i18n/ko.json', { with: { type: 'json' } })).default as Record<string, string>;
  const cat = L(ko, en);
  assert.equal(cat['settings.section.accounts'], L('계정', 'Accounts'));
  assert.deepEqual(Object.keys(en).filter((k) => k.startsWith('accounts.')), Object.keys(ko).filter((k) => k.startsWith('accounts.')));
  assert.deepEqual(accountsFeature.ui, [{ pages: ['#settings'], script: 'features/accounts.js' }]);
});
