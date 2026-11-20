// Adding an account (docs/accounts.md): the three login flows (Claude PKCE, ChatGPT/Codex and GitHub Copilot device
// codes), accounts.json, the four write routes behind the owner check, and that no secret of a flow leaves the process.
// Every vendor is a fake fetch, the home and the accounts file are mkdtemp folders, and no real endpoint is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

// Safety net first (src/ is imported dynamically, after these lines).
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'pb-login-'));
globalThis.fetch = (() => {
  throw new Error('test reached the real fetch: inject one');
}) as typeof fetch;
process.env.HOME = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, 'claude-dir');
process.env.CODEX_HOME = join(FAKE_HOME, 'codex-dir');
for (const k of Object.keys(process.env)) if (k.startsWith('PORTBOARD_') && k !== 'PORTBOARD_LOCALE') delete process.env[k];
const FILE = join(FAKE_HOME, 'accounts.json');
process.env.PORTBOARD_ACCOUNTS = FILE;

const { cancelLogin, LOGIN_REQUESTS, parsePasted, resetFlowsForTest } = await import('../src/core/accounts/flows.ts');
const { callTool } = await import('../src/mcp/tools.ts');
const { loadAccounts, upsertAccount } = await import('../src/core/accounts/store.ts');
const { clearQuotaCache } = await import('../src/core/accounts/quota.ts');
const { accountsFeature, setAccountsEnabledForTest, setAccountsOptionsForTest } = await import('../src/features/accounts.ts');
const { appRouter } = await import('../src/features/router.ts');
const { REGISTRY } = await import('../src/features/registry.ts');
const { REMOTE_TOOLS } = await import('../src/remote/tools.ts');
const { TAILSCALE_POLICY } = await import('../src/core/access.ts');
const { AuditLog } = await import('../src/core/audit.ts');
type ServerContext = import('../src/features/context.ts').ServerContext;
type Core = import('../src/mcp/kit.ts').Core;

const NOW = Date.parse('2026-11-20T09:00:00Z');
let clock = NOW;
const now = () => clock;
const OWNER = 'owner@example.com';

// ---- fixtures: every secret has a marker word, so a half or a re-encoded copy is found too ----

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload: unknown) => `eyJhbGciOiJub25lIn0.${b64(payload)}.TESTSIGNATURE`;

const CLAUDE_ACCESS = 'sk-ant-oat01-TESTACCESSNEW0123456789';
const CLAUDE_REFRESH = 'sk-ant-ort01-TESTREFRESHNEW0123456789';
const CODEX_ACCESS = jwt({ exp: NOW / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-new-1', chatgpt_plan_type: 'plus' } });
const CODEX_ID = jwt({ email: 'new@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-new-1', chatgpt_plan_type: 'plus' } });
const CODEX_REFRESH = 'TESTREFRESHCODEXNEW0123';
const COPILOT_ACCESS = 'gho_TESTACCESSCOPILOT0123456789';
const DEVICE_AUTH_ID = 'DEVAUTHID-SECRET-0001';
const DEVICE_CODE = 'DEVICECODE-SECRET-0001';
const AUTH_CODE = 'AUTHCODE-SECRET-0001';
const CODE_VERIFIER = 'CODEVERIFIER-SECRET-0001';
const PASTED_CODE = 'PASTEDCODE-SECRET-0001';
const MARKERS = ['TESTACCESS', 'TESTREFRESH', 'TESTSIGNATURE', 'SECRET-0001'];
const NEVER_OUT = [CLAUDE_ACCESS, CLAUDE_REFRESH, CODEX_ACCESS, CODEX_ID, CODEX_REFRESH, COPILOT_ACCESS, DEVICE_AUTH_ID, DEVICE_CODE, AUTH_CODE, CODE_VERIFIER, PASTED_CODE, ...MARKERS];

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect: RequestRedirect | undefined;
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

/** The fake vendors. `answers` maps a URL to what it says now; a URL not listed fails the test. */
const calls: Call[] = [];
let answers: Record<string, () => Response> = {};
const fake = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  calls.push({ url: u, method: String(init?.method), headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? ''), redirect: init?.redirect });
  const a = answers[u];
  if (!a) assert.fail(`unexpected request to ${u}`);
  return a();
}) as typeof fetch;
const callsTo = (url: string) => calls.filter((c) => c.url === url);

const C = LOGIN_REQUESTS;
const claudeOk = () => ({
  [C.claude.tokenUrl]: () => json({ access_token: CLAUDE_ACCESS, refresh_token: CLAUDE_REFRESH, expires_in: 28800, account: { uuid: 'uuid-claude-1', email_address: 'new@example.com' }, organization: { uuid: 'org-1' } }),
  [C.claude.profileUrl]: () => json({ organization: { rate_limit_tier: 'default_claude_max_5x', organization_type: 'claude_max' } }),
});
const codexStart = () => ({ [C.codex.userCodeUrl]: () => json({ device_auth_id: DEVICE_AUTH_ID, user_code: 'ABCD-1234', interval: '5' }) });
const codexOk = () => ({
  ...codexStart(),
  [C.codex.pollUrl]: () => json({ authorization_code: AUTH_CODE, code_verifier: CODE_VERIFIER }),
  [C.codex.tokenUrl]: () => json({ access_token: CODEX_ACCESS, refresh_token: CODEX_REFRESH, expires_in: 3600, id_token: CODEX_ID }),
});
const copilotStart = () => ({ [C.copilot.deviceUrl]: () => json({ device_code: DEVICE_CODE, user_code: 'WXYZ-5678', expires_in: 900, interval: 5, verification_uri: 'https://evil.example/x' }) });
const copilotOk = () => ({
  ...copilotStart(),
  [C.copilot.tokenUrl]: () => json({ access_token: COPILOT_ACCESS, token_type: 'bearer' }),
  [C.copilot.userUrl]: () => json({ id: 424242, email: 'gh@example.com' }),
});

test.beforeEach(() => {
  resetFlowsForTest();
  clearQuotaCache();
  rmSync(FILE, { force: true });
  calls.length = 0;
  answers = {};
  clock = NOW;
  setAccountsEnabledForTest(() => true);
  setAccountsOptionsForTest(() => ({ fetch: fake, now, accountsPath: FILE, home: FAKE_HOME, env: { CLAUDE_CONFIG_DIR: join(FAKE_HOME, 'c'), CODEX_HOME: join(FAKE_HOME, 'x') }, platform: 'linux' }));
});
test.afterEach(() => {
  setAccountsEnabledForTest(null);
  setAccountsOptionsForTest(null);
});

// ---- route harness: the dashboard's own router, an owner on loopback unless a test says otherwise ----

const AUDIT_DIR = mkdtempSync(join(FAKE_HOME, 'audit-'));
const audit = new AuditLog(join(AUDIT_DIR, 'audit.jsonl'));
function context() {
  const fakeCtx = { owner: async () => OWNER, policy: async () => TAILSCALE_POLICY, device: async (addr: string) => ({ addr }), writeDevices: async () => null, ts: { available: true }, audit };
  return new Proxy(fakeCtx as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : assert.fail(`handler touched ctx.${String(k)}`)) }) as unknown as ServerContext;
}
function request(method: string, addr: string, headers: Record<string, string>, body?: unknown) {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  r.method = method;
  r.headers = headers;
  r.socket = { remoteAddress: addr };
  return r;
}
const LOCAL = { 'x-portboard': '1' };
async function send(path: string, body: unknown, headers: Record<string, string> = LOCAL, addr = '127.0.0.1') {
  const ctx = context();
  const out = await appRouter(REGISTRY.routes, ctx)(request('POST', addr, headers, body), new URL(`http://x${path}`), ctx);
  assert.ok(out, path);
  return out!;
}
const start = (provider: string, alias?: string) => send('/api/accounts/login/start', { provider, alias });
const finish = (flowId: unknown, code: unknown) => send('/api/accounts/login/finish', { flowId, code });
const poll = (flowId: unknown) => send('/api/accounts/login/poll', { flowId });
const cancel = (flowId: unknown) => send('/api/accounts/login/cancel', { flowId });
const list = async () => {
  const ctx = context();
  return (await appRouter(REGISTRY.routes, ctx)(request('GET', '127.0.0.1', {}), new URL('http://x/api/accounts'), ctx))!;
};
const stored = async () => {
  const r = await loadAccounts({ path: FILE });
  assert.ok('accounts' in r);
  return r.accounts;
};
const mode = () => statSync(FILE).mode & 0o777;
const body = (r: { body: unknown }) => r.body as Record<string, any>;

/** Everything that left the process in this test: answers, the audit files, console output */
const outputs: string[] = [];
const keep = (r: { body: unknown }) => (outputs.push(JSON.stringify(r.body)), r);
function auditText() {
  return readdirSync(AUDIT_DIR).map((f) => readFileSync(join(AUDIT_DIR, f), 'utf8')).join('\n');
}
function noLeak(where: string, text: string, allow: string[] = []) {
  for (const s of NEVER_OUT) if (!allow.includes(s)) assert.ok(!text.includes(s), `${where} holds ${s.slice(0, 12)}…`);
}

// ---- 1. the three flows write one record, 0600 ----

test('Claude: the PKCE start, a pasted code#state, the exchange, the profile; one record, 0600, and no secret out', async () => {
  const logged: string[] = [];
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const k of Object.keys(saved) as (keyof typeof saved)[]) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
  try {
    answers = claudeOk();
    const s = keep(await start('claude', '  work  '));
    assert.equal(s.status, 200);
    assert.deepEqual(Object.keys(body(s)).sort(), ['authorizeUrl', 'expiresAt', 'flowId', 'kind', 'provider']);
    assert.equal(body(s).kind, 'paste');
    assert.equal(body(s).expiresAt, new Date(NOW + 10 * 60_000).toISOString());
    assert.match(body(s).flowId, /^[0-9a-f]{32}$/);
    assert.equal(calls.length, 0, 'starting asks no vendor');
    const url = new URL(body(s).authorizeUrl);
    assert.equal(`${url.origin}${url.pathname}`, 'https://claude.ai/oauth/authorize');
    const q = Object.fromEntries(url.searchParams);
    assert.deepEqual(
      { ...q, code_challenge: '', state: '' },
      { code: 'true', client_id: C.claude.clientId, response_type: 'code', redirect_uri: 'https://platform.claude.com/oauth/code/callback', scope: 'org:create_api_key user:profile user:inference', code_challenge: '', code_challenge_method: 'S256', state: '' },
    );
    assert.match(q.state, /^[A-Za-z0-9_-]{43}$/);
    assert.match(q.code_challenge, /^[A-Za-z0-9_-]{43}$/);

    const f = keep(await finish(body(s).flowId, `${PASTED_CODE}#${q.state}`));
    assert.equal(f.status, 200);
    assert.deepEqual(Object.keys(body(f)), ['account']);
    const a = body(f).account;
    assert.deepEqual([a.provider, a.source, a.alias, a.email, a.plan, a.status, a.quota], ['claude', 'added', 'work', 'new@example.com', 'default_claude_max_5x', 'ok', null]);
    assert.equal(a.expiresAt, new Date(NOW + 28800_000).toISOString());

    // the exchange: JSON, the verifier that matches the challenge, no redirect followed
    const ex = callsTo(C.claude.tokenUrl)[0];
    const sent = JSON.parse(ex.body);
    assert.deepEqual(
      { ...sent, code_verifier: '' },
      { grant_type: 'authorization_code', client_id: C.claude.clientId, code: PASTED_CODE, state: q.state, redirect_uri: C.claude.redirectUri, code_verifier: '' },
    );
    assert.equal(createHash('sha256').update(sent.code_verifier).digest('base64url'), q.code_challenge);
    assert.equal(ex.method, 'POST');
    assert.equal(ex.redirect, 'manual');
    const pr = callsTo(C.claude.profileUrl)[0];
    assert.equal(pr.method, 'GET');
    assert.equal(pr.redirect, 'error');
    assert.deepEqual(pr.headers, { Authorization: `Bearer ${CLAUDE_ACCESS}`, Accept: 'application/json', 'anthropic-beta': 'oauth-2025-04-20', 'Cache-Control': 'no-cache', 'User-Agent': 'claude-cli/2.1.321 (external, cli)' });
    assert.deepEqual([...new Set(calls.map((c) => new URL(c.url).host))].sort(), ['api.anthropic.com']);

    const recs = await stored();
    assert.equal(recs.length, 1);
    assert.deepEqual(recs[0], {
      id: a.id, provider: 'claude', alias: 'work', identity: 'uuid-claude-1', email: 'new@example.com', plan: 'default_claude_max_5x', addedAt: new Date(NOW).toISOString(),
      tokens: { access: CLAUDE_ACCESS, refresh: CLAUDE_REFRESH, idToken: null, expiresAt: new Date(NOW + 28800_000).toISOString() },
    });
    assert.equal(mode(), 0o600);

    // the list shows it next to the CLI logins, asks for limits with the stored token only
    answers[QUOTA_URL.claude] = () => json({ five_hour: { utilization: 5, resets_at: '2026-11-20T12:00:00Z' } });
    const l = keep(await list());
    const added = body(l).accounts.find((x: any) => x.source === 'added');
    assert.equal(added.id, a.id);
    assert.equal(added.quota.windows[0].usedPct, 5);
    assert.equal(callsTo(QUOTA_URL.claude)[0].headers.Authorization, `Bearer ${CLAUDE_ACCESS}`);

    // a second flow's cancel and an unknown cancel are both fine
    assert.deepEqual(body(keep(await cancel('0'.repeat(32)))), { ok: true });
  } finally {
    Object.assign(console, saved);
  }
  for (const o of outputs.splice(0)) {
    // the authorize URL carries the state by design; nothing else may
    noLeak('an answer', o.replace(/https:\/\/claude\.ai\/oauth\/authorize\?[^"]*/, ''));
  }
  for (const line of logged) noLeak('console', line);
  noLeak('the audit log', auditText());
});

const QUOTA_URL = { claude: 'https://api.anthropic.com/api/oauth/usage', codex: 'https://chatgpt.com/backend-api/wham/usage' };

test('Codex: a device code, a poll once per interval, the exchange; the identity and email come from the token claims', async () => {
  answers = codexOk();
  const s = keep(await start('codex'));
  assert.deepEqual(Object.keys(body(s)).sort(), ['expiresAt', 'flowId', 'interval', 'kind', 'provider', 'userCode', 'verificationUrl']);
  assert.deepEqual([body(s).kind, body(s).userCode, body(s).verificationUrl, body(s).interval], ['device', 'ABCD-1234', 'https://auth.openai.com/codex/device', 5]);
  assert.equal(body(s).expiresAt, new Date(NOW + 15 * 60_000).toISOString());
  assert.deepEqual(JSON.parse(callsTo(C.codex.userCodeUrl)[0].body), { client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });

  // too early: no vendor request
  const early = keep(await poll(body(s).flowId));
  assert.deepEqual(body(early), { state: 'pending', interval: 5 });
  assert.equal(callsTo(C.codex.pollUrl).length, 0);

  clock += 5000;
  const p = keep(await poll(body(s).flowId));
  assert.equal(body(p).state, 'done');
  assert.deepEqual(Object.keys(body(p)).sort(), ['account', 'state']);
  assert.deepEqual(JSON.parse(callsTo(C.codex.pollUrl)[0].body), { device_auth_id: DEVICE_AUTH_ID, user_code: 'ABCD-1234' });
  const tokenCall = callsTo(C.codex.tokenUrl)[0];
  assert.deepEqual(Object.fromEntries(new URLSearchParams(tokenCall.body)), {
    grant_type: 'authorization_code', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', code: AUTH_CODE, code_verifier: CODE_VERIFIER, redirect_uri: 'https://auth.openai.com/deviceauth/callback',
  });
  const a = body(p).account;
  assert.deepEqual([a.provider, a.source, a.email, a.plan, a.alias], ['codex', 'added', 'new@example.com', 'plus', null]);
  const recs = await stored();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].identity, 'acct-new-1');
  assert.deepEqual(recs[0].tokens, { access: CODEX_ACCESS, refresh: CODEX_REFRESH, idToken: CODEX_ID, expiresAt: new Date(NOW + 5000 + 3600_000).toISOString() });
  assert.equal(mode(), 0o600);
  assert.deepEqual([...new Set(calls.map((c) => new URL(c.url).host))], ['auth.openai.com']);
  // the flow is over
  assert.equal((await poll(body(s).flowId)).status, 404);

  // the quota request carries the stored account id
  answers[QUOTA_URL.codex] = () => json({ rate_limit: { primary_window: { used_percent: 1, reset_at: 1763640000, limit_window_seconds: 18000 } } });
  keep(await list());
  assert.equal(callsTo(QUOTA_URL.codex)[0].headers['ChatGPT-Account-Id'], 'acct-new-1');
  for (const o of outputs.splice(0)) noLeak('an answer', o);
  noLeak('the audit log', auditText());
});

test('Codex: the identity falls back to organizations[0].id; no identity at all fails and writes nothing', async () => {
  answers = codexOk();
  answers[C.codex.tokenUrl] = () => json({ access_token: jwt({}), id_token: jwt({ email: 'o@example.com', organizations: [{ id: 'org-fallback' }] }) });
  let s = await start('codex');
  clock += 5000;
  assert.equal(body(await poll(body(s).flowId)).state, 'done');
  assert.equal((await stored())[0].identity, 'org-fallback');

  rmSync(FILE);
  answers[C.codex.tokenUrl] = () => json({ access_token: jwt({}), id_token: jwt({ email: 'o@example.com' }) });
  s = await start('codex');
  clock += 5000;
  const p = await poll(body(s).flowId);
  assert.deepEqual(body(p), { state: 'failed', error: 'login response unusable' });
  assert.throws(() => statSync(FILE), 'nothing was written');
});

test('Copilot: a device code with a verification URL built here, the GitHub user as identity', async () => {
  answers = copilotOk();
  const s = keep(await start('copilot', 'gh'));
  assert.deepEqual(Object.keys(body(s)).sort(), ['expiresAt', 'flowId', 'interval', 'kind', 'provider', 'userCode', 'verificationUrl']);
  assert.equal(body(s).verificationUrl, 'https://github.com/login/device?user_code=WXYZ-5678', 'the answer\'s own address is not used');
  const dev = callsTo(C.copilot.deviceUrl)[0];
  assert.deepEqual(Object.fromEntries(new URLSearchParams(dev.body)), { client_id: 'Iv1.b507a08c87ecfe98', scope: 'read:user' });
  assert.equal(dev.headers.Accept, 'application/json');
  assert.equal(dev.headers['User-Agent'], 'portboard');

  clock += 5000;
  const p = keep(await poll(body(s).flowId));
  assert.equal(body(p).state, 'done');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(callsTo(C.copilot.tokenUrl)[0].body)), {
    client_id: 'Iv1.b507a08c87ecfe98', device_code: DEVICE_CODE, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  const user = callsTo(C.copilot.userUrl)[0];
  assert.deepEqual(user.headers, { Authorization: `Bearer ${COPILOT_ACCESS}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'portboard' });
  assert.equal(user.redirect, 'error');
  const a = body(p).account;
  assert.deepEqual([a.provider, a.source, a.alias, a.email, a.plan, a.quota], ['copilot', 'added', 'gh', 'gh@example.com', null, null]);
  const recs = await stored();
  assert.equal(recs.length, 1);
  assert.deepEqual([recs[0].identity, recs[0].tokens.access, recs[0].tokens.expiresAt], ['424242', COPILOT_ACCESS, null]);
  assert.equal(mode(), 0o600);
  assert.deepEqual([...new Set(calls.map((c) => new URL(c.url).host))].sort(), ['api.github.com', 'github.com']);

  // the list has it and asks no usage endpoint
  const before = calls.length;
  const l = keep(await list());
  assert.equal(body(l).accounts.find((x: any) => x.source === 'added').quota, null);
  assert.equal(calls.length, before);
  for (const o of outputs.splice(0)) noLeak('an answer', o);
  noLeak('the audit log', auditText());
});

test('Copilot: an email without @ is dropped', async () => {
  answers = copilotOk();
  answers[C.copilot.userUrl] = () => json({ id: 7, email: 'no-at-sign' });
  const s = await start('copilot');
  clock += 5000;
  assert.equal(body(await poll(body(s).flowId)).account.email, null);
});

// ---- 2. no secret in any answer or in the audit log ----

test('the audit log keeps the key names of a login request and none of its values', async () => {
  answers = claudeOk();
  const s = await start('claude', 'my-alias');
  const state = new URL(body(s).authorizeUrl).searchParams.get('state')!;
  await finish(body(s).flowId, `${PASTED_CODE}#${state}`);
  await cancel(body(s).flowId);
  const entries = await audit.query({ limit: 1000 });
  const routes = entries.map((e) => e.route);
  for (const r of ['start', 'finish', 'cancel']) assert.ok(routes.includes(`POST /api/accounts/login/${r}`), r);
  const fin = entries.find((e) => e.route === 'POST /api/accounts/login/finish')!;
  assert.deepEqual([...(fin.target.fields ?? [])].sort(), ['code', 'flowId']);
  const text = auditText();
  noLeak('the audit log', text);
  for (const v of [body(s).flowId, state, 'my-alias', body(s).authorizeUrl]) assert.ok(!text.includes(v), `the audit log holds a value: ${v.slice(0, 10)}`);
  assert.ok(text.includes('"fields"') && text.includes('flowId') && text.includes('code'));
});

// ---- 3. refusals ----

test('a state that differs is refused, nothing is written, and the flow is used up', async () => {
  answers = claudeOk();
  const s = await start('claude');
  const r = keep(await finish(body(s).flowId, `${PASTED_CODE}#another-state`));
  assert.deepEqual([r.status, body(r)], [400, { error: 'login state mismatch' }]);
  assert.equal(calls.length, 0, 'no vendor request');
  assert.throws(() => statSync(FILE));
  assert.equal((await finish(body(s).flowId, `${PASTED_CODE}#another-state`)).status, 404);
  noLeak('an answer', outputs.splice(0).join(' '));
});

test('a flow past its life, an unknown flowId and a wrong kind are refused', async () => {
  answers = { ...claudeOk(), ...codexOk() };
  const s = await start('claude');
  const state = new URL(body(s).authorizeUrl).searchParams.get('state')!;
  clock += 10 * 60_000 + 1;
  const late = await finish(body(s).flowId, `${PASTED_CODE}#${state}`);
  assert.deepEqual([late.status, body(late)], [410, { error: 'login flow expired' }]);
  assert.equal(calls.length, 0);
  assert.throws(() => statSync(FILE));

  for (const id of ['f'.repeat(32), '', 5, null, undefined, { a: 1 }]) {
    const f = await finish(id, 'x');
    assert.deepEqual([f.status, body(f)], [404, { error: 'login flow not found' }], String(id));
    assert.deepEqual([(await poll(id)).status, body(await poll(id))], [404, { error: 'login flow not found' }], String(id));
  }

  // a Claude flow is not a device flow, and the other way round
  const c = await start('claude');
  assert.equal((await poll(body(c).flowId)).status, 404);
  const d = await start('codex');
  assert.equal((await finish(body(d).flowId, 'x')).status, 404);

  // a device flow past its life: `expired`, and the vendor is not asked
  clock += 15 * 60_000 + 1;
  const before = callsTo(C.codex.pollUrl).length;
  const p = await poll(body(d).flowId);
  assert.deepEqual([p.status, body(p)], [200, { state: 'expired', error: 'login flow expired' }]);
  assert.equal(callsTo(C.codex.pollUrl).length, before);
  assert.equal((await poll(body(d).flowId)).status, 404, 'and it is gone');
});

test('a bad request body is refused with a fixed text', async () => {
  for (const b of [{}, { provider: 'gemini' }, { provider: 5 }, { provider: ['claude'] }]) {
    const r = await send('/api/accounts/login/start', b);
    assert.deepEqual([r.status, body(r)], [400, { error: 'invalid login request' }], JSON.stringify(b));
  }
  answers = claudeOk();
  const s = await start('claude');
  for (const code of ['', '   ', 5, 'x'.repeat(5000), '#state-only']) {
    const flow = body(await start('claude')).flowId;
    const r = await finish(flow, code);
    assert.ok(r.status === 400 || r.status === 404, `${String(code).slice(0, 10)}: ${r.status}`);
  }
  assert.equal(calls.length, 0);
  assert.ok(body(s).flowId);
});

// ---- 4. device codes ----

test('Codex: 403 and 404 are pending; another status fails; a bad answer fails; each poll waits an interval', async () => {
  answers = codexOk();
  const s = await start('codex');
  const id = body(s).flowId;
  for (const status of [403, 404]) {
    answers[C.codex.pollUrl] = () => json({ error: 'pending' }, status);
    clock += 5000;
    assert.deepEqual(body(await poll(id)), { state: 'pending', interval: 5 }, `HTTP ${status}`);
  }
  assert.equal(callsTo(C.codex.pollUrl).length, 2);
  // a poll one second after the last goes nowhere
  clock += 1000;
  assert.equal(body(await poll(id)).state, 'pending');
  assert.equal(callsTo(C.codex.pollUrl).length, 2, 'too early: no request');
  clock += 4000;
  answers[C.codex.pollUrl] = () => json({}, 400);
  const bad = await poll(id);
  assert.deepEqual([bad.status, body(bad)], [200, { state: 'failed', error: 'login request failed (HTTP 400)' }]);
  assert.equal((await poll(id)).status, 404, 'a failed flow is gone');

  const t = await start('codex');
  clock += 5000;
  answers[C.codex.pollUrl] = () => json({ authorization_code: AUTH_CODE });
  assert.deepEqual(body(await poll(body(t).flowId)), { state: 'failed', error: 'login response unusable' });
});

test('Copilot: pending, slow_down adds 5 seconds, expired_token and access_denied end the flow in their state', async () => {
  answers = copilotOk();
  const s = await start('copilot');
  const id = body(s).flowId;
  answers[C.copilot.tokenUrl] = () => json({ error: 'authorization_pending' });
  clock += 5000;
  assert.deepEqual(body(await poll(id)), { state: 'pending', interval: 5 });
  answers[C.copilot.tokenUrl] = () => json({ error: 'slow_down' });
  clock += 5000;
  assert.deepEqual(body(await poll(id)), { state: 'pending', interval: 10 });
  assert.equal(callsTo(C.copilot.tokenUrl).length, 2);
  clock += 5000; // 5 s after the slow_down: the interval is 10 now
  assert.equal(body(await poll(id)).state, 'pending');
  assert.equal(callsTo(C.copilot.tokenUrl).length, 2, 'earlier than the new interval: no request');
  clock += 5000;
  answers[C.copilot.tokenUrl] = () => json({ error: 'expired_token' });
  assert.deepEqual(body(await poll(id)), { state: 'expired', error: 'login flow expired' });
  assert.equal((await poll(id)).status, 404);

  const d = await start('copilot');
  clock += 5000;
  answers[C.copilot.tokenUrl] = () => json({ error: 'access_denied' });
  assert.deepEqual(body(await poll(body(d).flowId)), { state: 'denied', error: 'login denied' });
  assert.throws(() => statSync(FILE));

  const e = await start('copilot');
  clock += 5000;
  answers[C.copilot.tokenUrl] = () => json({ error: 'incorrect_client_credentials', error_description: `${DEVICE_CODE} nope` });
  const out = keep(await poll(body(e).flowId));
  assert.deepEqual(body(out), { state: 'failed', error: 'login response unusable' });
  noLeak('an answer', outputs.splice(0).join(' '));
});

test('a vendor timeout and a network error are fixed texts that hold nothing from the error', async () => {
  answers = { [C.codex.userCodeUrl]: () => { throw new DOMException('The operation timed out.', 'TimeoutError'); } };
  let r = await start('codex');
  assert.deepEqual([r.status, body(r)], [502, { error: 'login request timed out' }]);
  answers = { [C.codex.userCodeUrl]: () => { throw new TypeError(`fetch failed ${CODEX_ACCESS}`); } };
  r = await start('codex');
  assert.deepEqual([r.status, body(r)], [502, { error: 'login request failed' }]);
  answers = { [C.codex.userCodeUrl]: () => json({}, 503) };
  r = await start('codex');
  assert.deepEqual([r.status, body(r)], [502, { error: 'login request failed (HTTP 503)' }]);
  answers = { [C.codex.userCodeUrl]: () => new Response('not json', { status: 200 }) };
  r = await start('codex');
  assert.deepEqual([r.status, body(r)], [502, { error: 'login response unusable' }]);
  answers = { [C.codex.userCodeUrl]: () => new Response('x'.repeat(600 * 1024), { status: 200 }) };
  r = await start('codex');
  assert.deepEqual([r.status, body(r)], [502, { error: 'login response unusable' }]);
  answers = { [C.codex.userCodeUrl]: () => json({ device_auth_id: 'x' }) };
  assert.equal(body(await start('codex')).error, 'login response unusable');
  assert.equal(await mapStarted(), 0, 'a failed start leaves no flow behind');
});
/** how many Codex flows are open: start until the limit says no */
async function mapStarted() {
  answers = codexStart();
  let n = 0;
  for (; n < 5; n++) if ((await start('codex')).status !== 200) break;
  resetFlowsForTest();
  return 3 - n;
}

test('a failed token exchange adds nothing; a failed profile adds the account without a plan', async () => {
  answers = claudeOk();
  answers[C.claude.tokenUrl] = () => json({ error: 'invalid_grant', detail: PASTED_CODE }, 400);
  let s = await start('claude');
  let state = new URL(body(s).authorizeUrl).searchParams.get('state')!;
  let f = keep(await finish(body(s).flowId, `${PASTED_CODE}#${state}`));
  assert.deepEqual([f.status, body(f)], [502, { error: 'login request failed (HTTP 400)' }]);
  assert.throws(() => statSync(FILE));
  noLeak('an answer', outputs.splice(0).join(' '));

  answers = claudeOk();
  answers[C.claude.profileUrl] = () => json({}, 500);
  s = await start('claude');
  state = new URL(body(s).authorizeUrl).searchParams.get('state')!;
  f = await finish(body(s).flowId, `${PASTED_CODE}#${state}`);
  assert.equal(f.status, 200);
  assert.equal(body(f).account.plan, null);
  assert.equal((await stored()).length, 1);

  // the identity is required: an answer without account.uuid is unusable
  rmSync(FILE);
  answers[C.claude.tokenUrl] = () => json({ access_token: CLAUDE_ACCESS });
  s = await start('claude');
  state = new URL(body(s).authorizeUrl).searchParams.get('state')!;
  f = await finish(body(s).flowId, `${PASTED_CODE}#${state}`);
  assert.deepEqual([f.status, body(f)], [502, { error: 'login response unusable' }]);
  assert.throws(() => statSync(FILE));
});

// ---- 5. the file ----

test('the same identity twice is one record: the tokens and shown values change, the id, the date and the alias stay', async () => {
  answers = claudeOk();
  const run = async (alias: string | undefined, access: string, at: number) => {
    clock = at;
    answers[C.claude.tokenUrl] = () => json({ access_token: access, refresh_token: CLAUDE_REFRESH, expires_in: 100, account: { uuid: 'uuid-claude-1', email_address: 'same@example.com' } });
    const s = await start('claude', alias);
    const state = new URL(body(s).authorizeUrl).searchParams.get('state')!;
    return body(await finish(body(s).flowId, `${PASTED_CODE}#${state}`));
  };
  const first = await run('one', 'sk-ant-oat01-TESTACCESSFIRST', NOW);
  const second = await run(undefined, 'sk-ant-oat01-TESTACCESSSECOND', NOW + 3600_000);
  assert.equal(second.account.id, first.account.id);
  assert.equal(second.account.alias, 'one');
  const recs = await stored();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].tokens.access, 'sk-ant-oat01-TESTACCESSSECOND');
  assert.equal(recs[0].addedAt, new Date(NOW).toISOString());
  const third = await run('renamed', 'sk-ant-oat01-TESTACCESSTHIRD', NOW + 7200_000);
  assert.equal(third.account.alias, 'renamed');
  assert.equal((await stored()).length, 1);

  // the same identity under another provider is another account
  await upsertAccount({ provider: 'codex', alias: null, identity: 'uuid-claude-1', email: null, plan: null, tokens: { access: 'a', refresh: null, idToken: null, expiresAt: null } }, { path: FILE });
  assert.equal((await stored()).length, 2);
});

test('a broken accounts.json is never overwritten: the add fails and the file is as it was', async () => {
  for (const content of ['{not json', '[]', '{"version":2,"accounts":[]}', '{"version":1,"accounts":[{"id":1}]}', '{"version":1}']) {
    rmSync(FILE, { force: true });
    writeFileSync(FILE, content, { mode: 0o600 });
    answers = claudeOk();
    const s = await start('claude');
    const state = new URL(body(s).authorizeUrl).searchParams.get('state')!;
    const f = await finish(body(s).flowId, `${PASTED_CODE}#${state}`);
    assert.deepEqual([f.status, body(f)], [500, { error: 'accounts file unreadable' }], content);
    assert.equal(readFileSync(FILE, 'utf8'), content, 'untouched');
    const l = await list();
    assert.deepEqual(body(l).accounts.filter((a: any) => a.source === 'added').map((a: any) => [a.id, a.status, a.error]), [['added-unreadable', 'unreadable', 'accounts file unreadable']]);
  }
  // a directory where the file should be is unreadable too, not "empty"
  rmSync(FILE);
  const r = await loadAccounts({ path: FAKE_HOME });
  assert.deepEqual(r, { error: 'accounts file unreadable' });
});

test('two adds at once both land', async () => {
  const mk = (id: string) => ({ provider: 'codex' as const, alias: null, identity: id, email: null, plan: null, tokens: { access: `t-${id}`, refresh: null, idToken: null, expiresAt: null } });
  await Promise.all(Array.from({ length: 8 }, (_, i) => upsertAccount(mk(`id-${i}`), { path: FILE })));
  assert.equal((await stored()).length, 8);
  assert.equal(mode(), 0o600);
});

test('long strings are cut: the alias at 40, the email and plan too', async () => {
  const rec = await upsertAccount({ provider: 'claude', alias: `a\u0007${'b'.repeat(60)}`, identity: 'u', email: null, plan: `p${'q'.repeat(60)}`, tokens: { access: 'x', refresh: null, idToken: null, expiresAt: null } }, { path: FILE });
  assert.equal(rec.alias, `a${'b'.repeat(39)}…`);
  assert.equal(rec.plan, `p${'q'.repeat(39)}…`);
  answers = copilotOk();
  const s = await start('copilot', 'z'.repeat(100));
  clock += 5000;
  assert.equal(body(await poll(body(s).flowId)).account.alias, `${'z'.repeat(40)}…`);
});

// ---- 6. the owner check and accounts.enabled ----

const WRITES = ['start', 'finish', 'poll', 'cancel'].map((n) => `/api/accounts/login/${n}`);
const SERVE = { 'x-forwarded-for': '100.101.102.103', 'x-forwarded-host': 'devbox.example.ts.net', 'x-forwarded-proto': 'https' };

test('a caller who is not the owner, or sends no X-Portboard, gets 403 and no vendor is asked', async () => {
  answers = {}; // any request fails the test
  const callers: [string, Record<string, string>, string][] = [
    ['a direct tailnet caller', { 'x-portboard': '1' }, '100.64.0.9'],
    ['a shared-in node, another login', { 'x-portboard': '1', ...SERVE, 'tailscale-user-login': 'guest@example.com' }, '127.0.0.1'],
    ['a tagged node through serve', { 'x-portboard': '1', ...SERVE }, '127.0.0.1'],
    ['the owner without the header', {}, '127.0.0.1'],
    ['the owner through serve without the header', { ...SERVE, 'tailscale-user-login': OWNER }, '127.0.0.1'],
  ];
  for (const path of WRITES) {
    for (const [who, headers, addr] of callers) {
      const r = await send(path, { provider: 'claude', flowId: 'x', code: 'x' }, headers, addr);
      assert.equal(r.status, 403, `${path}: ${who}`);
    }
  }
  assert.equal(calls.length, 0);
  // the owner through serve gets in
  assert.equal((await send('/api/accounts/login/cancel', { flowId: 'x' }, { 'x-portboard': '1', ...SERVE, 'tailscale-user-login': OWNER }, '127.0.0.1')).status, 200);
});

test('accounts.enabled off: all four routes are 404 and nothing is asked or read', async () => {
  setAccountsEnabledForTest(() => false);
  answers = {};
  for (const path of WRITES) {
    const r = await send(path, { provider: 'claude', flowId: 'x', code: 'x' });
    assert.deepEqual([r.status, body(r)], [404, { error: 'accounts disabled' }], path);
  }
  assert.equal(calls.length, 0);
  assert.throws(() => statSync(FILE));
});

test('every login route is a write route with a body limit, and the registry sends them through the owner check', () => {
  const routes = (accountsFeature.routes ?? []).filter((r) => r.path.startsWith('/api/accounts/login/'));
  assert.deepEqual(routes.map((r) => r.path), WRITES);
  for (const r of routes) {
    assert.equal(r.method, 'POST');
    assert.equal(r.write, true);
    assert.deepEqual('body' in r ? r.body : null, { limit: 4096 });
  }
  for (const r of routes) assert.ok(REGISTRY.routes.includes(r), r.path);
});

// ---- 7. limits ----

test('more than three open flows of one provider are refused; another provider and a cancel are not affected', async () => {
  answers = { ...claudeOk(), ...codexOk(), ...copilotOk() };
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push(body(await start('claude')).flowId);
  const four = await start('claude');
  assert.deepEqual([four.status, body(four)], [429, { error: 'too many login flows' }]);
  assert.equal((await start('copilot')).status, 200, 'another provider has its own three');
  assert.deepEqual(body(await cancel(ids[0])), { ok: true });
  assert.equal((await start('claude')).status, 200, 'a cancelled flow gives its place back');

  // a device provider: the fourth is refused before the vendor is asked
  for (let i = 0; i < 3; i++) assert.equal((await start('codex')).status, 200);
  const asked = callsTo(C.codex.userCodeUrl).length;
  const fourth = await start('codex');
  assert.deepEqual([fourth.status, body(fourth)], [429, { error: 'too many login flows' }]);
  assert.equal(callsTo(C.codex.userCodeUrl).length, asked);

  // flows past their life give their place back
  clock += 16 * 60_000;
  assert.equal((await start('codex')).status, 200);
  assert.equal((await start('claude')).status, 200);
});

test('a flow is used once: a second finish with the same flowId is refused', async () => {
  answers = claudeOk();
  const s = await start('claude');
  const state = new URL(body(s).authorizeUrl).searchParams.get('state')!;
  assert.equal((await finish(body(s).flowId, `${PASTED_CODE}#${state}`)).status, 200);
  assert.equal((await finish(body(s).flowId, `${PASTED_CODE}#${state}`)).status, 404);
  assert.equal(callsTo(C.claude.tokenUrl).length, 1);
});

// ---- 8. the pasted text ----

test('parsePasted: code#state, a redirect URL, a query, a fragment; nothing usable is null', () => {
  assert.deepEqual(parsePasted('abc#def'), { code: 'abc', state: 'def' });
  assert.deepEqual(parsePasted('  abc#def \n'), { code: 'abc', state: 'def' });
  assert.deepEqual(parsePasted('abc'), { code: 'abc', state: null });
  assert.deepEqual(parsePasted('abc#'), { code: 'abc', state: null });
  assert.deepEqual(parsePasted('https://platform.claude.com/oauth/code/callback?code=abc&state=def'), { code: 'abc', state: 'def' });
  assert.deepEqual(parsePasted('https://platform.claude.com/oauth/code/callback#code=abc&state=def'), { code: 'abc', state: 'def' });
  assert.deepEqual(parsePasted('https://platform.claude.com/oauth/code/callback?code=abc#state=def'), { code: 'abc', state: 'def' });
  assert.deepEqual(parsePasted('?code=abc&state=def'), { code: 'abc', state: 'def' });
  assert.deepEqual(parsePasted('code=abc&state=def'), { code: 'abc', state: 'def' });
  assert.equal(parsePasted(''), null);
  assert.equal(parsePasted('   '), null);
  assert.equal(parsePasted('#def'), null);
  assert.equal(parsePasted('https://platform.claude.com/oauth/code/callback?state=def'), null);
  assert.equal(parsePasted('https://[bad'), null);
});

test('a pasted redirect URL finishes the flow too', async () => {
  answers = claudeOk();
  const s = await start('claude');
  const state = new URL(body(s).authorizeUrl).searchParams.get('state')!;
  const f = await finish(body(s).flowId, `https://platform.claude.com/oauth/code/callback?code=${PASTED_CODE}&state=${state}`);
  assert.equal(f.status, 200);
  assert.equal(JSON.parse(callsTo(C.claude.tokenUrl)[0].body).code, PASTED_CODE);
});

// ---- 9. nothing new on the remote server ----

test('the remote server offers no login or accounts tool, and the local tool list gained none', () => {
  assert.ok(!REMOTE_TOOLS.some((t) => /account|login/i.test(t.name)));
  assert.ok(![...REGISTRY.remoteCalls.keys()].some((n) => /account|login/i.test(n)));
  const names = REGISTRY.tools.map((t) => t.def.name).filter((n) => /account|login/i.test(n));
  assert.deepEqual(names, ['list_accounts']);
  const ro = REGISTRY.tools.find((t) => t.def.name === 'list_accounts')!.def;
  assert.equal(ro.annotations.readOnlyHint, true);
  assert.ok(!('remote' in (accountsFeature.tools ?? [])[0]) || !(accountsFeature.tools ?? [])[0].remote);
});


// ---- review fixes (#135) ----

const mkdirRO = () => {
  const dir = mkdtempSync(join(FAKE_HOME, 'ro-'));
  chmodSync(dir, 0o500);
  return dir;
};

test('fixed headers: Codex sends only Content-Type, Claude the exchange pair, Copilot Accept, Content-Type and User-Agent', async () => {
  answers = { ...claudeOk(), ...codexOk(), ...copilotOk() };
  const cs = await start('claude');
  await finish(body(cs).flowId, `${PASTED_CODE}#${new URL(body(cs).authorizeUrl).searchParams.get('state')}`);
  assert.deepEqual(callsTo(C.claude.tokenUrl)[0].headers, { Accept: 'application/json', 'Content-Type': 'application/json' });
  rmSync(FILE);
  const x = await start('codex');
  const g = await start('copilot');
  clock += 5000;
  await poll(body(x).flowId);
  await poll(body(g).flowId);
  const json_ = { 'Content-Type': 'application/json' };
  const form_ = { 'Content-Type': 'application/x-www-form-urlencoded' };
  assert.deepEqual(callsTo(C.codex.userCodeUrl)[0].headers, json_);
  assert.deepEqual(callsTo(C.codex.pollUrl)[0].headers, json_);
  assert.deepEqual(callsTo(C.codex.tokenUrl)[0].headers, form_);
  const gh = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'portboard' };
  assert.deepEqual(callsTo(C.copilot.deviceUrl)[0].headers, gh);
  assert.deepEqual(callsTo(C.copilot.tokenUrl)[0].headers, gh);
});

test('a cancel while the vendor is answering stops the save: poll and finish say the flow is not found', async () => {
  answers = codexOk();
  let id = '';
  answers[C.codex.tokenUrl] = () => (cancelLogin(id), json({ access_token: CODEX_ACCESS, id_token: CODEX_ID }));
  const x = await start('codex');
  id = body(x).flowId;
  clock += 5000;
  let r = await poll(id);
  assert.deepEqual([r.status, body(r)], [404, { error: 'login flow not found' }]);
  assert.throws(() => statSync(FILE));

  answers = copilotOk();
  answers[C.copilot.userUrl] = () => (cancelLogin(id), json({ id: 9 }));
  const g = await start('copilot');
  id = body(g).flowId;
  clock += 5000;
  r = await poll(id);
  assert.equal(r.status, 404);
  assert.throws(() => statSync(FILE));

  answers = claudeOk();
  answers[C.claude.profileUrl] = () => (cancelLogin(id), json({}));
  const c = await start('claude');
  id = body(c).flowId;
  r = await finish(id, `${PASTED_CODE}#${new URL(body(c).authorizeUrl).searchParams.get('state')}`);
  assert.deepEqual([r.status, body(r)], [404, { error: 'login flow not found' }]);
  assert.throws(() => statSync(FILE));
});

test('Copilot: a network error, a timeout, a 5xx and a 429 leave the flow open as pending; the next poll can succeed', async () => {
  answers = copilotOk();
  const s = await start('copilot');
  const id = body(s).flowId;
  const down: [string, () => Response][] = [
    ['a network error', () => { throw new TypeError(`fetch failed ${COPILOT_ACCESS}`); }],
    ['a timeout', () => { throw new DOMException('The operation timed out.', 'TimeoutError'); }],
    ['HTTP 502', () => json({}, 502)],
    ['HTTP 429', () => json({}, 429)],
  ];
  let interval = 5;
  for (const [why, a] of down) {
    answers[C.copilot.tokenUrl] = a;
    clock += interval * 1000;
    const r = keep(await poll(id));
    interval += 5;
    assert.deepEqual(body(r), { state: 'pending', interval }, why);
  }
  answers[C.copilot.tokenUrl] = copilotOk()[C.copilot.tokenUrl];
  clock += interval * 1000;
  assert.equal(body(await poll(id)).state, 'done');
  noLeak('an answer', outputs.splice(0).join(' '));
});

test('Copilot: authorization_pending in an HTTP 400 is pending; slow_down takes the larger of +5 and the answer; the flow expires', async () => {
  answers = copilotOk();
  const s = await start('copilot');
  const id = body(s).flowId;
  answers[C.copilot.tokenUrl] = () => json({ error: 'authorization_pending' }, 400);
  clock += 5000;
  assert.deepEqual(body(await poll(id)), { state: 'pending', interval: 5 });
  answers[C.copilot.tokenUrl] = () => json({ error: 'slow_down', interval: 30 }, 400);
  clock += 5000;
  assert.deepEqual(body(await poll(id)), { state: 'pending', interval: 30 });
  answers[C.copilot.tokenUrl] = () => json({ error: 'slow_down', interval: 7 });
  clock += 30_000;
  assert.deepEqual(body(await poll(id)), { state: 'pending', interval: 35 });
  // an unknown error in a 400 ends the flow
  answers[C.copilot.tokenUrl] = () => json({ error: 'unsupported_grant_type' }, 400);
  clock += 35_000;
  assert.deepEqual(body(await poll(id)), { state: 'failed', error: 'login response unusable' });
  assert.equal((await poll(id)).status, 404);
  // a 400 with no error at all is a failed request
  const t = await start('copilot');
  answers[C.copilot.tokenUrl] = () => json({}, 400);
  clock += 5000;
  assert.deepEqual(body(await poll(body(t).flowId)), { state: 'failed', error: 'login request failed (HTTP 400)' });
  // a flow open past its life expires on the next poll
  const u = await start('copilot');
  answers[C.copilot.tokenUrl] = () => json({}, 503);
  clock += 5000;
  assert.equal(body(await poll(body(u).flowId)).state, 'pending');
  clock += 16 * 60_000;
  assert.deepEqual(body(await poll(body(u).flowId)), { state: 'expired', error: 'login flow expired' });
});

test('Codex: a 5xx or 429 on the poll is pending with a longer interval; a failure after the vendor answered is final', async () => {
  answers = codexOk();
  const s = await start('codex');
  const id = body(s).flowId;
  for (const status of [500, 429]) {
    answers[C.codex.pollUrl] = () => json({}, status);
    clock += 60_000;
    assert.equal(body(await poll(id)).state, 'pending', `HTTP ${status}`);
  }
  answers[C.codex.pollUrl] = codexOk()[C.codex.pollUrl];
  answers[C.codex.tokenUrl] = () => json({}, 503);
  clock += 60_000;
  assert.deepEqual(body(await poll(id)), { state: 'failed', error: 'login request failed (HTTP 503)' });
});

test('a user code goes back to the vendor as it came; only the shown value is cut; over 64 characters the start fails', async () => {
  const long = 'U'.repeat(50);
  answers = codexOk();
  answers[C.codex.userCodeUrl] = () => json({ device_auth_id: DEVICE_AUTH_ID, user_code: long, interval: 5 });
  const s = await start('codex');
  assert.equal(body(s).userCode, `${'U'.repeat(40)}…`);
  clock += 5000;
  await poll(body(s).flowId);
  assert.equal(JSON.parse(callsTo(C.codex.pollUrl)[0].body).user_code, long);

  answers[C.codex.userCodeUrl] = () => json({ device_auth_id: DEVICE_AUTH_ID, user_code: 'U'.repeat(65) });
  const bad = await start('codex');
  assert.deepEqual([bad.status, body(bad)], [502, { error: 'login response unusable' }]);
  answers = copilotOk();
  answers[C.copilot.deviceUrl] = () => json({ device_code: DEVICE_CODE, user_code: 'U'.repeat(65) });
  assert.equal(body(await start('copilot')).error, 'login response unusable');
  // 64 is fine
  answers[C.copilot.deviceUrl] = () => json({ device_code: DEVICE_CODE, user_code: 'U'.repeat(64) });
  assert.equal((await start('copilot')).status, 200);
});

test('expires_in is used only when it is finite, above 0 and at most a year; else one hour', async () => {
  for (const [v, secs] of [[1e300, 3600], [0, 3600], [-5, 3600], ['x', 3600], [null, 3600], [31_536_001, 3600], [31_536_000, 31_536_000], [120, 120]] as const) {
    rmSync(FILE, { force: true });
    answers = claudeOk();
    answers[C.claude.tokenUrl] = () => json({ access_token: CLAUDE_ACCESS, expires_in: v, account: { uuid: 'u' } });
    const s = await start('claude');
    const f = await finish(body(s).flowId, `${PASTED_CODE}#${new URL(body(s).authorizeUrl).searchParams.get('state')}`);
    assert.equal(body(f).account.expiresAt, new Date(NOW + secs * 1000).toISOString(), String(v));
  }
  rmSync(FILE);
  answers = codexOk();
  answers[C.codex.tokenUrl] = () => json({ access_token: CODEX_ACCESS, id_token: CODEX_ID, expires_in: 1e300 });
  const x = await start('codex');
  clock += 5000;
  await poll(body(x).flowId);
  assert.equal((await stored())[0].tokens.expiresAt, new Date(clock + 3600_000).toISOString());
});

test('Claude: the account uuid may come from the profile; with neither the exchange is unusable', async () => {
  answers = claudeOk();
  answers[C.claude.tokenUrl] = () => json({ access_token: CLAUDE_ACCESS, refresh_token: CLAUDE_REFRESH, expires_in: 100 });
  answers[C.claude.profileUrl] = () => json({ account: { uuid: 'uuid-from-profile' }, organization: { rate_limit_tier: 'pro' } });
  let s = await start('claude');
  let f = await finish(body(s).flowId, `${PASTED_CODE}#${new URL(body(s).authorizeUrl).searchParams.get('state')}`);
  assert.equal(f.status, 200);
  assert.deepEqual([(await stored())[0].identity, body(f).account.plan], ['uuid-from-profile', 'pro']);

  rmSync(FILE);
  answers[C.claude.profileUrl] = () => json({ organization: {} });
  s = await start('claude');
  f = await finish(body(s).flowId, `${PASTED_CODE}#${new URL(body(s).authorizeUrl).searchParams.get('state')}`);
  assert.deepEqual([f.status, body(f)], [502, { error: 'login response unusable' }]);
  answers[C.claude.profileUrl] = () => json({}, 500);
  s = await start('claude');
  f = await finish(body(s).flowId, `${PASTED_CODE}#${new URL(body(s).authorizeUrl).searchParams.get('state')}`);
  assert.equal(body(f).error, 'login response unusable');
  assert.throws(() => statSync(FILE));
});

test('an accounts.json that group or others can read is unreadable and is not overwritten', async () => {
  await upsertAccount({ provider: 'codex', alias: null, identity: 'i', email: null, plan: null, tokens: { access: 'a', refresh: null, idToken: null, expiresAt: null } }, { path: FILE });
  const before = readFileSync(FILE, 'utf8');
  assert.ok('accounts' in (await loadAccounts({ path: FILE })));
  for (const m of [0o644, 0o640, 0o604, 0o660, 0o666]) {
    chmodSync(FILE, m);
    assert.deepEqual(await loadAccounts({ path: FILE }), { error: 'accounts file unreadable' }, m.toString(8));
  }
  chmodSync(FILE, 0o644);
  answers = claudeOk();
  const s = await start('claude');
  const f = await finish(body(s).flowId, `${PASTED_CODE}#${new URL(body(s).authorizeUrl).searchParams.get('state')}`);
  assert.deepEqual([f.status, body(f)], [500, { error: 'accounts file unreadable' }]);
  assert.equal(readFileSync(FILE, 'utf8'), before);
  assert.deepEqual(body(await list()).accounts.filter((a: any) => a.source === 'added').map((a: any) => a.id), ['added-unreadable']);
  chmodSync(FILE, 0o600);
  assert.ok('accounts' in (await loadAccounts({ path: FILE })));
  // an injected stat that fails for another reason is unreadable too
  assert.deepEqual(await loadAccounts({ path: FILE, stat: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } }), { error: 'accounts file unreadable' });
});

test('list_accounts with an added account holds no token and no marker', async () => {
  answers = { ...claudeOk(), [QUOTA_URL.claude]: () => json({ five_hour: { utilization: 3, resets_at: '2026-11-20T12:00:00Z' } }) };
  const s = await start('claude', 'tool-check');
  await finish(body(s).flowId, `${PASTED_CODE}#${new URL(body(s).authorizeUrl).searchParams.get('state')}`);
  const out = await callTool('list_accounts', {}, {} as Core);
  assert.equal(out.isError, undefined);
  const text = out.content[0].text;
  assert.ok(text.includes('tool-check'));
  assert.ok(text.includes('"source":"added"'));
  noLeak('the tool output', text);
  for (const x of ['uuid-claude-1', CODE_VERIFIER]) assert.ok(!text.includes(x));
});

test('all three flows: nothing secret in console output, answers or the audit log; the PKCE verifier too', async () => {
  const logged: string[] = [];
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const k of Object.keys(saved) as (keyof typeof saved)[]) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
  let verifier = '';
  try {
    answers = { ...claudeOk(), ...codexOk(), ...copilotOk() };
    const cs = keep(await start('claude'));
    keep(await finish(body(cs).flowId, `${PASTED_CODE}#${new URL(body(cs).authorizeUrl).searchParams.get('state')}`));
    verifier = JSON.parse(callsTo(C.claude.tokenUrl)[0].body).code_verifier;
    const x = keep(await start('codex'));
    const g = keep(await start('copilot'));
    clock += 5000;
    keep(await poll(body(x).flowId));
    keep(await poll(body(g).flowId));
    keep(await list());
    answers[C.copilot.tokenUrl] = () => { throw new TypeError(`boom ${COPILOT_ACCESS} ${DEVICE_CODE}`); };
    const h = await start('copilot');
    clock += 5000;
    keep(await poll(body(h).flowId));
  } finally {
    Object.assign(console, saved);
  }
  assert.ok(verifier.length >= 43);
  const text = outputs.splice(0).map((o) => o.replace(/https:\/\/claude\.ai\/oauth\/authorize\?[^"]*/, ''));
  for (const o of [...text, ...logged, auditText()]) {
    noLeak('an output', o);
    assert.ok(!o.includes(verifier), 'the PKCE verifier is out');
  }
});

test('a failed write is its own text, apart from an unreadable file', { skip: process.getuid?.() === 0 }, async () => {
  const dir = mkdirRO();
  try {
    setAccountsOptionsForTest(() => ({ fetch: fake, now, accountsPath: join(dir, 'accounts.json') }));
    answers = { ...claudeOk(), ...codexOk() };
    const s = await start('claude');
    const f = await finish(body(s).flowId, `${PASTED_CODE}#${new URL(body(s).authorizeUrl).searchParams.get('state')}`);
    assert.deepEqual([f.status, body(f)], [500, { error: 'accounts file not written' }]);
    const x = await start('codex');
    clock += 5000;
    assert.deepEqual(body(await poll(body(x).flowId)), { state: 'failed', error: 'accounts file not written' });
    assert.throws(() => statSync(join(dir, 'accounts.json')));
  } finally {
    chmodSync(dir, 0o700);
    mkdirSync(dir, { recursive: true });
  }
});

test('expired flows are swept at the start of every call', async () => {
  answers = { ...claudeOk(), ...codexOk() };
  for (let i = 0; i < 3; i++) await start('claude');
  clock += 11 * 60_000;
  // the old three are gone as this call begins: a cancel, a poll on nothing, a finish on nothing
  assert.deepEqual(body(await cancel('x')), { ok: true });
  for (let i = 0; i < 3; i++) assert.equal((await start('claude')).status, 200);
  clock += 11 * 60_000;
  assert.equal((await poll('x')).status, 404);
  for (let i = 0; i < 3; i++) assert.equal((await start('claude')).status, 200);
  clock += 11 * 60_000;
  assert.equal((await finish('x', 'y')).status, 404);
  for (let i = 0; i < 3; i++) assert.equal((await start('claude')).status, 200);
});
