// Using, removing and refreshing an added account (docs/accounts.md): the account folders (accountHomes), the two write
// routes behind the owner check, the refresh of an account that has no folder, and the six follow-ups of PR #43's review.
// Every vendor is a fake fetch. HOME, the config folders, accounts.json and the account folders are mkdtemp folders.
// No real endpoint is called and no real ~/.claude or ~/.codex is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

// Safety net first (src/ is imported dynamically, after these lines).
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'pb-switch-'));
globalThis.fetch = (() => {
  throw new Error('test reached the real fetch: inject one');
}) as typeof fetch;
process.env.HOME = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, 'claude-dir');
process.env.CODEX_HOME = join(FAKE_HOME, 'codex-dir');
for (const k of Object.keys(process.env)) if (k.startsWith('PORTBOARD_') && k !== 'PORTBOARD_LOCALE') delete process.env[k];
const FILE = join(FAKE_HOME, 'accounts.json');
const HOMES = join(FAKE_HOME, 'account-homes');
process.env.PORTBOARD_ACCOUNTS = FILE;
process.env.PORTBOARD_ACCOUNT_HOMES = HOMES;

const { finishLogin, LOGIN_REQUESTS, pollLogin, resetFlowsForTest, startLogin } = await import('../src/core/accounts/flows.ts');
const { resetRefreshForTest, refreshAccount } = await import('../src/core/accounts/refresh.ts');
const { useAccount } = await import('../src/core/accounts/homes.ts');
const { loadAccounts, updateAccount, upsertAccount } = await import('../src/core/accounts/store.ts');
const { clearQuotaCache, fetchQuota, quotaCacheSize, QUOTA_REQUESTS } = await import('../src/core/accounts/quota.ts');
const { accountsReport } = await import('../src/core/accounts/view.ts');
const { PATHS } = await import('../src/core/paths.ts');
const { accountsFeature, setAccountsEnabledForTest, setAccountsOptionsForTest } = await import('../src/features/accounts.ts');
const { appRouter } = await import('../src/features/router.ts');
const { REGISTRY } = await import('../src/features/registry.ts');
const { callTool } = await import('../src/mcp/tools.ts');
const { TAILSCALE_POLICY } = await import('../src/core/access.ts');
const { AuditLog } = await import('../src/core/audit.ts');
type ServerContext = import('../src/features/context.ts').ServerContext;
type Core = import('../src/mcp/kit.ts').Core;

const NOW = Date.parse('2026-11-20T09:00:00Z');
let clock = NOW;
const now = () => clock;
const iso = (ms: number) => new Date(ms).toISOString();
const OWNER = 'owner@example.com';
const C = LOGIN_REQUESTS;

// ---- fixtures: every secret has a marker word ----

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload: unknown) => `eyJhbGciOiJub25lIn0.${b64(payload)}.TESTSIGNATURE`;
const CLAUDE_ACCESS = 'sk-ant-oat01-TESTACCESSOLD0123456789';
const CLAUDE_REFRESH = 'sk-ant-ort01-TESTREFRESHOLD0123456789';
const CLAUDE_ACCESS_NEW = 'sk-ant-oat01-TESTACCESSNEW0123456789';
const CLAUDE_REFRESH_NEW = 'sk-ant-ort01-TESTREFRESHNEW0123456789';
const CLAUDE_ACCESS_FOLDER = 'sk-ant-oat01-TESTACCESSFOLDER0123456789';
const codexAccess = (exp: number) => jwt({ exp: exp / 1000, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-sw-1', chatgpt_plan_type: 'plus' } });
const CODEX_ACCESS = codexAccess(NOW + 3600_000);
const CODEX_ID = jwt({ email: 'cx@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-sw-1', chatgpt_plan_type: 'plus' } });
const CODEX_ID_NEW = jwt({ email: 'cx2@example.com', marker: 'NEWID', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-sw-1' } });
const CODEX_REFRESH = 'TESTREFRESHCODEXOLD0123';
const CODEX_ACCESS_NEW = codexAccess(NOW + 7200_000);
const MARKERS = ['TESTACCESS', 'TESTREFRESH', 'TESTSIGNATURE'];

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect: RequestRedirect | undefined;
}
const calls: Call[] = [];
let answers: Record<string, () => Response | Promise<Response>> = {};
const fake = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  calls.push({ url: u, method: String(init?.method), headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? ''), redirect: init?.redirect });
  const a = answers[u];
  if (!a) assert.fail(`unexpected request to ${u}`);
  return a();
}) as typeof fetch;
const callsTo = (url: string) => calls.filter((c) => c.url === url);

const CLAUDE_USAGE = { five_hour: { utilization: 42.5, resets_at: '2026-11-20T12:00:00Z' }, seven_day: { utilization: 10, resets_at: '2026-11-25T00:00:00Z' } };
const CODEX_USAGE = { email: 'cx@example.com', plan_type: 'plus', rate_limit: { primary_window: { used_percent: 12, reset_at: 1763640000, limit_window_seconds: 18000 } } };

const options = () => ({
  fetch: fake,
  now,
  accountsPath: FILE,
  accountHomes: HOMES,
  home: FAKE_HOME,
  env: { CLAUDE_CONFIG_DIR: join(FAKE_HOME, 'c'), CODEX_HOME: join(FAKE_HOME, 'x') },
  platform: 'linux',
});

// The default folders: a sentinel file in each, which must stay as it is
const DEFAULT_CLAUDE = join(FAKE_HOME, '.claude', '.credentials.json');
const DEFAULT_CODEX = join(FAKE_HOME, '.codex', 'auth.json');
mkdirSync(join(FAKE_HOME, '.claude'), { recursive: true });
mkdirSync(join(FAKE_HOME, '.codex'), { recursive: true });
writeFileSync(DEFAULT_CLAUDE, '{"sentinel":"claude"}');
writeFileSync(DEFAULT_CODEX, '{"sentinel":"codex"}');
const defaultsIntact = () => {
  assert.equal(readFileSync(DEFAULT_CLAUDE, 'utf8'), '{"sentinel":"claude"}');
  assert.equal(readFileSync(DEFAULT_CODEX, 'utf8'), '{"sentinel":"codex"}');
  assert.deepEqual(readdirSync(join(FAKE_HOME, '.claude')), ['.credentials.json']);
  assert.deepEqual(readdirSync(join(FAKE_HOME, '.codex')), ['auth.json']);
};

/** Everything that left the process in a test: answers, the audit file, console output */
const outputs: string[] = [];
const logged: string[] = [];
const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };

test.beforeEach(() => {
  resetFlowsForTest();
  resetRefreshForTest();
  clearQuotaCache();
  rmSync(FILE, { force: true });
  rmSync(HOMES, { recursive: true, force: true });
  calls.length = 0;
  answers = {};
  clock = NOW;
  outputs.length = 0;
  logged.length = 0;
  for (const k of Object.keys(saved) as (keyof typeof saved)[]) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
  setAccountsEnabledForTest(() => true);
  setAccountsOptionsForTest(options);
});
test.afterEach(() => {
  Object.assign(console, saved);
  setAccountsEnabledForTest(null);
  setAccountsOptionsForTest(null);
  // test 0: no marker in an answer, in the audit file or in the console
  for (const o of [...outputs, ...logged, auditText()]) for (const m of MARKERS) assert.ok(!o.includes(m), `output holds ${m}`);
});

// ---- the route harness ----

const AUDIT_DIR = mkdtempSync(join(FAKE_HOME, 'audit-'));
const audit = new AuditLog(join(AUDIT_DIR, 'audit.jsonl'));
function auditText() {
  return readdirSync(AUDIT_DIR).map((f) => readFileSync(join(AUDIT_DIR, f), 'utf8')).join('\n');
}
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
  outputs.push(JSON.stringify(out!.body));
  return out!;
}
const use = (id: unknown) => send('/api/accounts/use', { id });
const remove = (id: unknown) => send('/api/accounts/remove', { id });
const body = (r: { body: unknown }) => r.body as Record<string, any>;

// ---- records ----

let seq = 0;
type Tokens = { access: string; refresh: string | null; idToken: string | null; expiresAt: string | null };
const claudeAccount = (tokens: Partial<Tokens> = {}, extra: Record<string, unknown> = {}) =>
  upsertAccount(
    { provider: 'claude', alias: 'work', identity: `uuid-sw-${seq++}`, email: 'a@example.com', plan: 'max', tier: 'default_claude_max_5x', subscriptionType: 'max', tokens: { access: CLAUDE_ACCESS, refresh: CLAUDE_REFRESH, idToken: null, expiresAt: iso(NOW + 3600_000), ...tokens }, ...extra },
    { path: FILE, now },
  );
const codexAccount = (tokens: Partial<Tokens> = {}) =>
  upsertAccount(
    { provider: 'codex', alias: 'chat', identity: 'acct-sw-1', email: 'cx@example.com', plan: 'plus', tokens: { access: CODEX_ACCESS, refresh: CODEX_REFRESH, idToken: CODEX_ID, expiresAt: iso(NOW + 3600_000), ...tokens } },
    { path: FILE, now },
  );
const stored = async () => {
  const r = await loadAccounts({ path: FILE });
  assert.ok('accounts' in r);
  return r;
};
const homeFile = (id: string, name: string) => join(HOMES, id, name);
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const perm = (p: string) => statSync(p).mode & 0o777;
const report = async (refresh = true) => (await accountsReport({ ...options(), refresh })).accounts;

// ---- 1. use: the folder, the file, the command, the active mark ----

test('use a Claude account: .credentials.json in its own 0700 folder, the command, the active mark; the default folders stay as they are', async () => {
  const a = await claudeAccount();
  answers = {};
  const r = await use(a.id);
  assert.equal(r.status, 200);
  const dir = join(HOMES, a.id);
  const command = `CLAUDE_CONFIG_DIR='${dir}' claude`;
  assert.equal(body(r).command, command);
  assert.equal(body(r).account.command, command);
  assert.equal(body(r).account.active, true);
  assert.equal(body(r).account.id, a.id);
  assert.deepEqual(readJson(homeFile(a.id, '.credentials.json')), {
    claudeAiOauth: { accessToken: CLAUDE_ACCESS, refreshToken: CLAUDE_REFRESH, expiresAt: NOW + 3600_000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' },
  });
  assert.equal(perm(homeFile(a.id, '.credentials.json')), 0o600);
  assert.equal(perm(dir), 0o700);
  assert.equal(perm(HOMES), 0o700);
  const s = await stored();
  assert.equal(s.active.claude, a.id);
  assert.equal(s.accounts[0].home, true);
  assert.equal(perm(FILE), 0o600);
  assert.equal(calls.length, 0, 'a token that is still valid is not refreshed, and nothing else is asked');
  assert.ok(!JSON.stringify(body(r)).includes(CLAUDE_ACCESS));
  defaultsIntact();
  // PATHS.accountHomes is the env value
  assert.equal(PATHS.accountHomes, HOMES);
});

test('use a Codex account: auth.json in its folder, the command, and the active mark moves to the newest choice', async () => {
  const a = await codexAccount();
  const r = await use(a.id);
  assert.equal(r.status, 200);
  const dir = join(HOMES, a.id);
  assert.equal(body(r).command, `CODEX_HOME='${dir}' codex`);
  assert.deepEqual(readJson(homeFile(a.id, 'auth.json')), {
    auth_mode: 'chatgpt',
    tokens: { id_token: CODEX_ID, access_token: CODEX_ACCESS, refresh_token: CODEX_REFRESH, account_id: 'acct-sw-1' },
    last_refresh: iso(NOW),
  });
  assert.equal(perm(homeFile(a.id, 'auth.json')), 0o600);
  assert.equal(perm(dir), 0o700);
  assert.equal((await stored()).active.codex, a.id);
  // a second Claude account does not move the Codex mark; a second use for the same provider does
  const c1 = await claudeAccount();
  const c2 = await claudeAccount();
  await use(c1.id);
  assert.deepEqual((await stored()).active, { codex: a.id, claude: c1.id });
  await use(c2.id);
  assert.deepEqual((await stored()).active, { codex: a.id, claude: c2.id });
  // the list says which one is in use and gives the command of each folder
  answers = { [QUOTA_REQUESTS.claude.url]: () => json(CLAUDE_USAGE), [QUOTA_REQUESTS.codex.url]: () => json(CODEX_USAGE) };
  const rows = await report();
  const row = (id: string) => rows.find((x) => x.id === id)!;
  assert.deepEqual([row(c1.id).active, row(c2.id).active, row(a.id).active], [false, true, true]);
  assert.equal(row(c1.id).command, `CLAUDE_CONFIG_DIR='${join(HOMES, c1.id)}' claude`);
  assert.deepEqual(rows.filter((x) => x.source === 'local-cli').map((x) => [x.active, x.command]), [[false, null], [false, null]]);
  defaultsIntact();
});

test('use refuses what the CLI cannot use, with a closed text', async () => {
  const gh = await upsertAccount({ provider: 'copilot', alias: null, identity: '42', email: null, plan: null, tokens: { access: 'gho_TESTACCESSX', refresh: null, idToken: null, expiresAt: null } }, { path: FILE, now });
  const noRefresh = await claudeAccount({ refresh: null });
  const noId = await codexAccount({ idToken: null });
  const reauth = await claudeAccount({}, { needsReauth: true });
  for (const [a, text, status] of [
    [gh, 'account cannot be used by the CLI', 400],
    [noRefresh, 'account cannot be used by the CLI', 400],
    [noId, 'account cannot be used by the CLI', 400],
    [reauth, 'account needs sign-in again', 409],
  ] as const) {
    const r = await use(a.id);
    assert.deepEqual([r.status, body(r)], [status, { error: text }], a.id);
  }
  assert.ok(!existsSync(HOMES), 'no folder was made');
  const missing = await use('acc-0123456789ab');
  assert.deepEqual([missing.status, body(missing)], [404, { error: 'account not found' }]);
  for (const bad of ['../x', 'acc-../../x', 5, null, undefined, 'acc-ABCDEF123456', `acc-${'a'.repeat(13)}`]) {
    const r = await use(bad);
    assert.deepEqual([r.status, body(r)], [400, { error: 'invalid login request' }], String(bad));
  }
  assert.equal(calls.length, 0);
});

// ---- 2. an existing file becomes one .bak ----

test('use keeps a file that is there as one <name>.bak (0600); a folder Portboard wrote is not written again over the CLI\'s own refresh', async () => {
  const a = await claudeAccount();
  const dir = join(HOMES, a.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, '.credentials.json'), 'OLD-CONTENT-ONE');
  writeFileSync(join(dir, '.credentials.json.bak'), 'OLDER-BACKUP');
  await use(a.id);
  assert.equal(readFileSync(join(dir, '.credentials.json.bak'), 'utf8'), 'OLD-CONTENT-ONE', 'one backup, the older one is replaced');
  assert.equal(perm(join(dir, '.credentials.json.bak')), 0o600);
  assert.ok(readJson(join(dir, '.credentials.json')).claudeAiOauth.accessToken === CLAUDE_ACCESS);
  assert.deepEqual(readdirSync(dir).sort(), ['.credentials.json', '.credentials.json.bak']);
  // the CLI refreshes the file in the folder; a second use leaves that file alone
  const cli = { claudeAiOauth: { accessToken: CLAUDE_ACCESS_FOLDER, refreshToken: 'sk-ant-ort01-TESTREFRESHFOLDER01', expiresAt: NOW + 9_000_000 } };
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify(cli));
  const again = await use(a.id);
  assert.equal(again.status, 200);
  assert.deepEqual(readJson(join(dir, '.credentials.json')), cli, 'not overwritten');
  assert.equal(readFileSync(join(dir, '.credentials.json.bak'), 'utf8'), 'OLD-CONTENT-ONE');
  defaultsIntact();
});

test('use does not follow a link where the folder or the file belongs', async () => {
  const outside = mkdtempSync(join(FAKE_HOME, 'outside-'));
  writeFileSync(join(outside, 'keep.txt'), 'KEEP');
  const a = await claudeAccount();
  mkdirSync(HOMES, { recursive: true, mode: 0o700 });
  symlinkSync(outside, join(HOMES, a.id));
  const r = await use(a.id);
  assert.deepEqual([r.status, body(r)], [500, { error: 'account home not written' }]);
  assert.deepEqual(readdirSync(outside), ['keep.txt']);
  assert.equal((await stored()).accounts[0].home, undefined);
  assert.deepEqual((await stored()).active, {});
});

// ---- 3. the limits of an account with a folder come from the folder's file ----

test('an account with a folder asks for limits with the token in its folder, and Portboard does not refresh it', async () => {
  const a = await claudeAccount();
  await use(a.id);
  const dir = join(HOMES, a.id);
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE_ACCESS_FOLDER, refreshToken: 'sk-ant-ort01-TESTREFRESHFOLDER01', expiresAt: NOW + 3600_000, subscriptionType: 'max' } }));
  answers = { [QUOTA_REQUESTS.claude.url]: () => json(CLAUDE_USAGE) };
  let row = (await report()).find((x) => x.id === a.id)!;
  assert.equal(row.status, 'ok');
  assert.deepEqual(row.quota?.windows.map((w) => w.name), ['5h', 'weekly']);
  assert.equal(callsTo(QUOTA_REQUESTS.claude.url)[0].headers.Authorization, `Bearer ${CLAUDE_ACCESS_FOLDER}`);

  // the file says expired (the stored copy does not): expired, no request, and no refresh although a refresh token is there
  clearQuotaCache();
  calls.length = 0;
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE_ACCESS_FOLDER, refreshToken: 'sk-ant-ort01-TESTREFRESHFOLDER01', expiresAt: NOW - 1000 } }));
  row = (await report()).find((x) => x.id === a.id)!;
  assert.deepEqual([row.status, row.error], ['expired', 'access token expired']);
  clock += 24 * 3600_000;
  assert.equal(calls.length, 0, 'no usage request, no refresh request');

  // a folder file that is gone or cannot be read: that row is unreadable, and the others are not affected
  rmSync(join(dir, '.credentials.json'));
  row = (await report()).find((x) => x.id === a.id)!;
  assert.deepEqual([row.status, row.error, row.active, typeof row.command], ['unreadable', 'credentials file unreadable', true, 'string']);
  assert.equal(calls.length, 0);
  // the stored copy was never touched
  assert.equal((await stored()).accounts[0].tokens.access, CLAUDE_ACCESS);
});

// ---- 4. refresh ----

const claudeRefreshOk = () => ({ [C.claude.tokenUrl]: () => json({ access_token: CLAUDE_ACCESS_NEW, refresh_token: CLAUDE_REFRESH_NEW, expires_in: 28800 }) });

test('refresh: an expired Claude account without a folder asks the token URL with the pinned request and stores the new tokens', async () => {
  const a = await claudeAccount({ expiresAt: iso(NOW - 1000) });
  answers = { ...claudeRefreshOk(), [QUOTA_REQUESTS.claude.url]: () => json(CLAUDE_USAGE) };
  const row = (await report()).find((x) => x.id === a.id)!;
  const req = callsTo(C.claude.tokenUrl);
  assert.equal(req.length, 1);
  assert.equal(req[0].method, 'POST');
  assert.equal(req[0].redirect, 'manual');
  assert.deepEqual(req[0].headers, C.claude.tokenHeaders());
  assert.deepEqual(JSON.parse(req[0].body), { grant_type: 'refresh_token', client_id: C.claude.clientId, refresh_token: CLAUDE_REFRESH });
  assert.deepEqual((await stored()).accounts[0].tokens, { access: CLAUDE_ACCESS_NEW, refresh: CLAUDE_REFRESH_NEW, idToken: null, expiresAt: iso(NOW + 28800_000) });
  assert.equal(callsTo(QUOTA_REQUESTS.claude.url)[0].headers.Authorization, `Bearer ${CLAUDE_ACCESS_NEW}`);
  assert.deepEqual([row.status, row.needsReauth, row.error], ['ok', false, null]);
  assert.equal(row.expiresAt, iso(NOW + 28800_000));
  // the same identity, id and name stay
  assert.deepEqual([(await stored()).accounts[0].id, (await stored()).accounts[0].alias], [a.id, 'work']);
});

test('refresh: Codex sends the pinned request, replaces the id token, and keeps the old refresh token when none comes back', async () => {
  const a = await codexAccount({ access: codexAccess(NOW - 1000), expiresAt: iso(NOW - 1000) });
  answers = {
    [C.codex.tokenUrl]: () => json({ access_token: CODEX_ACCESS_NEW, id_token: CODEX_ID_NEW, expires_in: 3600 }),
    [QUOTA_REQUESTS.codex.url]: () => json(CODEX_USAGE),
  };
  await report();
  const req = callsTo(C.codex.tokenUrl);
  assert.equal(req.length, 1);
  assert.deepEqual(req[0].headers, C.codex.jsonHeaders());
  assert.deepEqual(JSON.parse(req[0].body), { client_id: C.codex.clientId, grant_type: 'refresh_token', refresh_token: CODEX_REFRESH });
  assert.deepEqual((await stored()).accounts[0].tokens, { access: CODEX_ACCESS_NEW, refresh: CODEX_REFRESH, idToken: CODEX_ID_NEW, expiresAt: iso(NOW + 3600_000) });
  assert.equal(callsTo(QUOTA_REQUESTS.codex.url)[0].headers['ChatGPT-Account-Id'], 'acct-sw-1');
  assert.equal((await stored()).accounts[0].id, a.id);
});

test('refresh: 400 and 401 save needsReauth and stop asking; another failure rests for five minutes and changes nothing', async () => {
  for (const status of [400, 401]) {
    rmSync(FILE, { force: true });
    resetRefreshForTest();
    calls.length = 0;
    const a = await claudeAccount({ expiresAt: iso(NOW - 1000) });
    answers = { [C.claude.tokenUrl]: () => json({ error: 'invalid_grant', error_description: CLAUDE_REFRESH }, status) };
    let row = (await report()).find((x) => x.id === a.id)!;
    assert.deepEqual([row.needsReauth, row.status, row.error], [true, 'expired', 'account needs sign-in again'], `HTTP ${status}`);
    assert.equal((await stored()).accounts[0].needsReauth, true);
    assert.equal(callsTo(C.claude.tokenUrl).length, 1);
    row = (await report()).find((x) => x.id === a.id)!;
    assert.equal(row.needsReauth, true);
    assert.equal(callsTo(C.claude.tokenUrl).length, 1, 'a flagged account is not asked again');
  }
  // a 500, a network error and a 200 with no token: transient
  rmSync(FILE, { force: true });
  resetRefreshForTest();
  calls.length = 0;
  const a = await claudeAccount({ expiresAt: iso(NOW - 1000) });
  const failures: (() => Response)[] = [() => json({}, 500), () => { throw new TypeError(`fetch failed ${CLAUDE_REFRESH}`); }, () => json({ nothing: true })];
  for (const f of failures) {
    resetRefreshForTest();
    answers = { [C.claude.tokenUrl]: f };
    const before = callsTo(C.claude.tokenUrl).length;
    const row = (await report()).find((x) => x.id === a.id)!;
    assert.equal(callsTo(C.claude.tokenUrl).length, before + 1);
    assert.deepEqual([row.needsReauth, row.status], [false, 'expired']);
    assert.equal((await stored()).accounts[0].tokens.access, CLAUDE_ACCESS, 'nothing changed');
    assert.equal((await stored()).accounts[0].needsReauth, undefined);
  }
  // within five minutes of a failure: no new request; after six: one
  const n = callsTo(C.claude.tokenUrl).length;
  await report();
  assert.equal(callsTo(C.claude.tokenUrl).length, n, 'resting');
  clock += 6 * 60_000;
  await report();
  assert.equal(callsTo(C.claude.tokenUrl).length, n + 1);
});

test('refresh: two reports at once send one refresh request; the read-only tool and an account with a folder never refresh', async () => {
  const a = await claudeAccount({ expiresAt: iso(NOW - 1000) });
  let release: (r: Response) => void = () => {};
  answers = {
    [C.claude.tokenUrl]: () => new Promise<Response>((res) => { release = res; }),
    [QUOTA_REQUESTS.claude.url]: () => json(CLAUDE_USAGE),
  };
  const both = Promise.all([report(), report()]);
  while (callsTo(C.claude.tokenUrl).length === 0) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  release(json({ access_token: CLAUDE_ACCESS_NEW, refresh_token: CLAUDE_REFRESH_NEW, expires_in: 3600 }));
  const [x, y] = await both;
  assert.equal(callsTo(C.claude.tokenUrl).length, 1);
  assert.deepEqual([x.find((r) => r.id === a.id)?.status, y.find((r) => r.id === a.id)?.status], ['ok', 'ok']);

  // list_accounts is read-only: an expired account shows as expired and nothing is sent or written
  rmSync(FILE, { force: true });
  resetRefreshForTest();
  calls.length = 0;
  const b = await claudeAccount({ expiresAt: iso(NOW - 1000) });
  const before = readFileSync(FILE, 'utf8');
  const out = await callTool('list_accounts', {}, {} as Core);
  outputs.push(out.content[0].text);
  assert.ok(out.content[0].text.includes(b.id));
  assert.equal(calls.length, 0);
  assert.equal(readFileSync(FILE, 'utf8'), before);
});

test('use refreshes an expired account without a folder first; a refusal is sign-in-again, a failure leaves no folder', async () => {
  const a = await claudeAccount({ expiresAt: iso(NOW - 1000) });
  answers = claudeRefreshOk();
  const r = await use(a.id);
  assert.equal(r.status, 200);
  assert.equal(callsTo(C.claude.tokenUrl).length, 1);
  assert.deepEqual(readJson(homeFile(a.id, '.credentials.json')).claudeAiOauth.accessToken, CLAUDE_ACCESS_NEW);
  assert.equal(readJson(homeFile(a.id, '.credentials.json')).claudeAiOauth.refreshToken, CLAUDE_REFRESH_NEW);
  assert.equal((await stored()).accounts[0].tokens.access, CLAUDE_ACCESS_NEW);
  // a valid account asks nothing; a later report does not refresh an account that has a folder
  clock += 24 * 3600_000;
  calls.length = 0;
  await report();
  assert.equal(callsTo(C.claude.tokenUrl).length, 0);

  rmSync(FILE, { force: true });
  rmSync(HOMES, { recursive: true, force: true });
  const b = await claudeAccount({ expiresAt: iso(clock - 1000) });
  answers = { [C.claude.tokenUrl]: () => json({ error: 'invalid_grant' }, 400) };
  const denied = await use(b.id);
  assert.deepEqual([denied.status, body(denied)], [409, { error: 'account needs sign-in again' }]);
  assert.equal((await stored()).accounts[0].needsReauth, true);
  rmSync(FILE, { force: true });
  const c = await claudeAccount({ expiresAt: iso(clock - 1000) });
  answers = { [C.claude.tokenUrl]: () => json({}, 503) };
  const down = await use(c.id);
  assert.deepEqual([down.status, body(down)], [502, { error: 'login request failed' }]);
  assert.ok(!existsSync(HOMES));
  assert.deepEqual((await stored()).active, {});
});

// ---- 5. remove ----

test('remove: the record, the active mark and the folder go; the other accounts and the default folders stay', async () => {
  const a = await claudeAccount();
  const b = await claudeAccount();
  const x = await codexAccount();
  await use(a.id);
  await use(x.id);
  assert.ok(existsSync(join(HOMES, a.id)));
  const r = await remove(a.id);
  assert.deepEqual([r.status, body(r)], [200, { ok: true }]);
  const s = await stored();
  assert.deepEqual(s.accounts.map((v) => v.id).sort(), [b.id, x.id].sort());
  assert.deepEqual(s.active, { codex: x.id }, 'the removed account was active: the mark is gone');
  assert.ok(!existsSync(join(HOMES, a.id)));
  assert.ok(existsSync(join(HOMES, x.id)));
  // an account that never had a folder
  assert.equal((await remove(b.id)).status, 200);
  assert.equal((await remove(b.id)).status, 404);
  assert.deepEqual(body(await remove(b.id)), { error: 'account not found' });
  defaultsIntact();
});

test('remove: a CLI login cannot be removed, and a bad id is 400', async () => {
  for (const id of ['claude-local', 'codex-local', 'codex-0123456789ab']) {
    const r = await remove(id);
    assert.deepEqual([r.status, body(r)], [400, { error: 'local login cannot be removed' }], id);
    // use says its own closed text for the same ids
    const u = await use(id);
    assert.deepEqual([u.status, body(u)], [400, { error: 'local login cannot be used here' }], id);
  }
  for (const id of ['../x', '../../etc', 'acc-../x', '', 'added-unreadable', 7, { $: 1 }, null]) {
    const r = await remove(id);
    assert.deepEqual([r.status, body(r)], [400, { error: 'invalid login request' }], JSON.stringify(id));
  }
  defaultsIntact();
});

test('remove: a folder that is a link to somewhere else is not followed or deleted; the answer says so and the record stays', async () => {
  const outside = mkdtempSync(join(FAKE_HOME, 'outside-'));
  writeFileSync(join(outside, 'keep.txt'), 'KEEP');
  const a = await claudeAccount();
  mkdirSync(HOMES, { recursive: true, mode: 0o700 });
  symlinkSync(outside, join(HOMES, a.id));
  const r = await remove(a.id);
  assert.deepEqual([r.status, body(r)], [500, { error: 'account home not removed' }]);
  assert.deepEqual(readdirSync(outside), ['keep.txt']);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'KEEP');
  assert.ok(lstatSync(join(HOMES, a.id)).isSymbolicLink(), 'the link itself is left');
  assert.deepEqual((await stored()).accounts.map((x) => x.id), [a.id], 'the record stays: the owner can try again');
  // a file where the folder belongs
  const b = await claudeAccount();
  writeFileSync(join(HOMES, b.id), 'FILE');
  assert.equal(body(await remove(b.id)).error, 'account home not removed');
  assert.equal(readFileSync(join(HOMES, b.id), 'utf8'), 'FILE');
  // the owner fixes the folder; the second try deletes it and then the record
  rmSync(join(HOMES, a.id));
  mkdirSync(join(HOMES, a.id));
  writeFileSync(join(HOMES, a.id, 'x'), 'x');
  assert.deepEqual([(await remove(a.id)).status, existsSync(join(HOMES, a.id))], [200, false]);
  assert.deepEqual((await stored()).accounts.map((x) => x.id), [b.id]);
  assert.deepEqual(readdirSync(outside), ['keep.txt']);
});

test('remove: an unreadable accounts.json is left as it was and no folder is touched', async () => {
  const a = await claudeAccount();
  await use(a.id);
  const text = readFileSync(FILE, 'utf8');
  writeFileSync(FILE, '{not json', { mode: 0o600 });
  const r = await remove(a.id);
  assert.deepEqual([r.status, body(r)], [500, { error: 'accounts file unreadable' }]);
  assert.equal(readFileSync(FILE, 'utf8'), '{not json');
  assert.ok(existsSync(join(HOMES, a.id)));
  writeFileSync(FILE, text, { mode: 0o600 });
});

// ---- 6. the owner check, accounts.enabled, the audit line ----

const WRITES = ['/api/accounts/use', '/api/accounts/remove'];
const SERVE = { 'x-forwarded-for': '100.101.102.103', 'x-forwarded-host': 'devbox.example.ts.net', 'x-forwarded-proto': 'https' };

test('a caller who is not the owner, or sends no X-Portboard, gets 403: no vendor, no folder, no change to accounts.json', async () => {
  const a = await claudeAccount({ expiresAt: iso(NOW - 1000) });
  const before = readFileSync(FILE, 'utf8');
  const callers: [string, Record<string, string>, string][] = [
    ['a direct tailnet caller', { 'x-portboard': '1' }, '100.64.0.9'],
    ['a shared-in node, another login', { 'x-portboard': '1', ...SERVE, 'tailscale-user-login': 'guest@example.com' }, '127.0.0.1'],
    ['a tagged node through serve', { 'x-portboard': '1', ...SERVE }, '127.0.0.1'],
    ['the owner without the header', {}, '127.0.0.1'],
  ];
  for (const path of WRITES) {
    for (const [who, headers, addr] of callers) {
      const r = await send(path, { id: a.id }, headers, addr);
      assert.equal(r.status, 403, `${path}: ${who}`);
    }
  }
  assert.equal(calls.length, 0);
  assert.ok(!existsSync(HOMES));
  assert.equal(readFileSync(FILE, 'utf8'), before);
});

test('accounts.enabled off: use and remove are 404 and nothing is asked, read or written', async () => {
  const a = await claudeAccount();
  const before = readFileSync(FILE, 'utf8');
  setAccountsEnabledForTest(() => false);
  for (const path of WRITES) {
    const r = await send(path, { id: a.id });
    assert.deepEqual([r.status, body(r)], [404, { error: 'accounts disabled' }], path);
  }
  assert.equal(calls.length, 0);
  assert.ok(!existsSync(HOMES));
  assert.equal(readFileSync(FILE, 'utf8'), before);
});

test('both routes are write routes with a body limit that the registry sends through the owner check; the audit line holds the key name and no id or token', async () => {
  const routes = (accountsFeature.routes ?? []).filter((r) => WRITES.includes(r.path));
  assert.deepEqual(routes.map((r) => r.path), WRITES);
  for (const r of routes) {
    assert.equal(r.method, 'POST');
    assert.equal(r.write, true);
    assert.deepEqual('body' in r ? r.body : null, { limit: 4096 });
    assert.ok(REGISTRY.routes.includes(r), r.path);
  }
  const a = await claudeAccount();
  await use(a.id);
  await remove(a.id);
  const entries = await audit.query({ limit: 1000 });
  for (const path of WRITES) {
    const e = entries.find((x) => x.route === `POST ${path}`);
    assert.ok(e, path);
    assert.deepEqual([...(e.target.fields ?? [])], ['id']);
  }
  const text = auditText();
  assert.ok(!text.includes(a.id), 'the id value is not in the audit line');
  assert.ok(!text.includes(HOMES));
  // a body over the limit is refused before the handler
  const big = await send('/api/accounts/use', { id: 'x'.repeat(5000) });
  assert.equal(big.status, 400);
});

// ---- 7. the six follow-ups ----

const copilotStart = (expiresIn = 900) => ({ [C.copilot.deviceUrl]: () => json({ device_code: 'DEVICECODE-SECRET-0001', user_code: 'WXYZ-5678', expires_in: expiresIn, interval: 5 }) });

test('the page cancels the flow when the finish request fails (source check of public/features/accounts.js)', () => {
  const src = readFileSync(new URL('../public/features/accounts.js', import.meta.url), 'utf8');
  const fin = src.slice(src.indexOf("await postOrThrow('api/accounts/login/finish'"));
  const catchBlock = fin.slice(fin.indexOf('catch (err)'), fin.indexOf('return;'));
  assert.match(catchBlock, /endFlow\(true\)/);
  assert.doesNotMatch(catchBlock, /endFlow\(false\)/);
});

test('the accounts page never puts a "null" text above the add-account row: place drops null, undefined and false (source of public/features/accounts.js run with a fake node)', () => {
  const src = readFileSync(new URL('../public/features/accounts.js', import.meta.url), 'utf8');
  const line = src.split('\n').find((l) => l.startsWith('const place = '));
  assert.ok(line, 'place is there');
  const placed: unknown[][] = [];
  const place = new Function('$', `${line}; return place;`)(() => ({ replaceChildren: (...n: unknown[]) => placed.push(n) }));
  const node = { tag: 'p' };
  place(null, node);
  place(undefined, false, node, null);
  place(node);
  assert.deepEqual(placed, [[node], [node], [node]]);
  // choices passes the note as it is (null when there is none): only place filters
  assert.match(src, /function choices\(note\) \{[\s\S]*?place\(\s*note \?\? null,/);
});

test('Copilot: a 5xx or 429 whose error is not one of the four codes is pending; the four codes keep their meaning', async () => {
  answers = copilotStart();
  const s = await startLogin('copilot', undefined, { fetch: fake, now, accountsPath: FILE });
  let interval = 5;
  const pollWith = async (status: number, error: string) => {
    answers[C.copilot.tokenUrl] = () => json({ error }, status);
    clock += 60_000;
    return pollLogin(s.flowId, { fetch: fake, now, accountsPath: FILE });
  };
  for (const [status, error] of [[503, 'server_error'], [502, 'bad_gateway'], [429, 'rate_limited'], [500, 'unsupported_grant_type']] as const) {
    const r = await pollWith(status, error);
    interval += 5;
    assert.deepEqual([r.state, r.interval], ['pending', interval], `${status} ${error}`);
  }
  // an authorization_pending in a 5xx is the vendor's answer: pending, and the interval does not grow
  assert.equal((await pollWith(500, 'authorization_pending')).state, 'pending');
  // a 4xx with an unknown error still ends the flow
  const u = await startLogin('copilot', undefined, { fetch: fake, now, accountsPath: FILE });
  answers[C.copilot.tokenUrl] = () => json({ error: 'unsupported_grant_type' }, 400);
  clock += 60_000;
  assert.deepEqual(await pollLogin(u.flowId, { fetch: fake, now, accountsPath: FILE }), { state: 'failed', error: 'login response unusable' });
  // the two end states
  for (const [error, state] of [['expired_token', 'expired'], ['access_denied', 'denied']] as const) {
    const f = await startLogin('copilot', undefined, { fetch: fake, now, accountsPath: FILE });
    answers[C.copilot.tokenUrl] = () => json({ error }, 503);
    clock += 60_000;
    assert.equal((await pollLogin(f.flowId, { fetch: fake, now, accountsPath: FILE })).state, state, error);
  }
});

test('a Copilot flow lives 900 seconds at most, whatever the vendor says', async () => {
  answers = copilotStart(1800);
  const s = await startLogin('copilot', undefined, { fetch: fake, now, accountsPath: FILE });
  assert.equal(s.expiresAt, iso(NOW + 900_000));
  answers = copilotStart(300);
  const t = await startLogin('copilot', undefined, { fetch: fake, now, accountsPath: FILE });
  assert.equal(t.expiresAt, iso(NOW + 300_000), 'a shorter life from the vendor is kept');
});

test('the docs say what the code does: a transient failure is one before the first vendor answer, and the life is 15 minutes', () => {
  const doc = readFileSync(new URL('../docs/accounts.md', import.meta.url), 'utf8');
  assert.match(doc, /before the vendor's first answer/);
  assert.match(doc, /Copilot flow lives at most 15 minutes|at most 15 minutes/);
  assert.ok(!doc.includes('30 minutes'));
});

test('the usage cache holds 64 entries at most even when many tokens are added at the same time', async () => {
  const mk = (i: number) => ({ provider: 'claude' as const, id: `t${i}`, status: 'ok' as const, email: null, plan: null, tier: null, expiresAt: null, refreshExpiresAt: null, accountId: null, accessToken: `tok-${i}`, error: null });
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  const slow = (async () => {
    await gate;
    return json(CLAUDE_USAGE);
  }) as typeof fetch;
  const jobs = Array.from({ length: 80 }, (_, i) => fetchQuota(mk(i), { fetch: slow, now }));
  release();
  await Promise.all(jobs);
  assert.ok(quotaCacheSize() <= 64, `size ${quotaCacheSize()}`);
  assert.equal(quotaCacheSize(), 64);
});

test('docs/platforms.md names accounts.json (every platform) and account-homes in the accounts row', () => {
  const row = readFileSync(new URL('../docs/platforms.md', import.meta.url), 'utf8').split('\n').find((l) => l.startsWith('| Accounts'));
  assert.ok(row);
  assert.ok(row.includes('accounts.json') && row.includes('account-homes'));
});

test('the non-owner test sends a Codex start, so a request that got through would ask the vendor (source check)', () => {
  const src = readFileSync(new URL('./accounts-login.test.ts', import.meta.url), 'utf8');
  const at = src.indexOf('a caller who is not the owner, or sends no X-Portboard');
  const block = src.slice(at, src.indexOf('accounts.enabled off', at));
  assert.match(block, /provider: 'codex'/);
  assert.doesNotMatch(block, /provider: 'claude'/);
});

// ---- 8. fix round: the file shape, the races, a folder that is gone, the delete order ----

const profile = (org: Record<string, unknown>) => ({
  [C.claude.tokenUrl]: () => json({ access_token: CLAUDE_ACCESS, refresh_token: CLAUDE_REFRESH, expires_in: 28800, account: { uuid: `uuid-fix-${seq++}`, email_address: 'p@example.com' } }),
  [C.claude.profileUrl]: () => json({ organization: org }),
});
async function signIn(org: Record<string, unknown>) {
  answers = profile(org);
  const st = await startLogin('claude', 'p', { fetch: fake, now, accountsPath: FILE });
  const state = new URL(st.authorizeUrl!).searchParams.get('state');
  return finishLogin(st.flowId, `PASTEDCODE#${state}`, { fetch: fake, now, accountsPath: FILE });
}

test("the Claude file holds the profile's own values: rateLimitTier and subscriptionType (max, not the plan text); a key with no value is left out", async () => {
  const a = await signIn({ rate_limit_tier: 'default_claude_max_5x', organization_type: 'claude_max' });
  assert.deepEqual([a.plan, a.tier, a.subscriptionType], ['default_claude_max_5x', 'default_claude_max_5x', 'max']);
  assert.equal((await use(a.id)).status, 200);
  assert.deepEqual(readJson(homeFile(a.id, '.credentials.json')).claudeAiOauth, {
    accessToken: CLAUDE_ACCESS, refreshToken: CLAUDE_REFRESH, expiresAt: NOW + 28800_000, scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x',
  });
  // claude_pro is pro; a value without the claude_ prefix is none; no tier is none
  const pro = await signIn({ organization_type: 'claude_pro' });
  assert.deepEqual([pro.tier ?? null, pro.subscriptionType], [null, 'pro']);
  const team = await signIn({ rate_limit_tier: 'team_tier', organization_type: 'team' });
  await use(pro.id);
  await use(team.id);
  const keys = (id: string) => Object.keys(readJson(homeFile(id, '.credentials.json')).claudeAiOauth).sort();
  assert.deepEqual(keys(pro.id), ['accessToken', 'expiresAt', 'refreshToken', 'scopes', 'subscriptionType']);
  assert.deepEqual(keys(team.id), ['accessToken', 'expiresAt', 'rateLimitTier', 'refreshToken', 'scopes']);
  // an account stored before this change has neither: neither key, and the display plan is not written as subscriptionType
  const old = await claudeAccount({}, { tier: null, subscriptionType: null });
  await use(old.id);
  assert.deepEqual(keys(old.id), ['accessToken', 'expiresAt', 'refreshToken', 'scopes']);
  // a file without the new keys is read
  const text = JSON.parse(readFileSync(FILE, 'utf8'));
  for (const r of text.accounts) {
    delete r.tier;
    delete r.subscriptionType;
  }
  writeFileSync(FILE, JSON.stringify(text), { mode: 0o600 });
  assert.equal((await stored()).accounts.length, 4);
});

test('the page words the expiry of an account with a folder like a CLI login (source check), and the list gives that account a command', async () => {
  const src = readFileSync(new URL('../public/features/accounts.js', import.meta.url), 'utf8');
  assert.match(src, /a\.error === 'access token expired' && !a\.command \? t\('accounts\.error\.expiredAdded'\)/);
  assert.ok(!src.includes('is not refreshed yet'));
  const a = await claudeAccount();
  await use(a.id);
  writeFileSync(homeFile(a.id, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE_ACCESS_FOLDER, refreshToken: 'r', expiresAt: NOW - 1000 } }));
  const row = (await report()).find((x) => x.id === a.id)!;
  assert.deepEqual([row.error, typeof row.command], ['access token expired', 'string']);
  assert.equal(callsTo(C.claude.tokenUrl).length, 0);
});

test('a use waits for a refresh that is running and writes its (rotated) tokens; accounts.json is not refreshed again', async () => {
  const a = await claudeAccount({ expiresAt: iso(NOW - 1000) });
  let release: (r: Response) => void = () => {};
  answers = {
    [C.claude.tokenUrl]: () => new Promise<Response>((res) => { release = res; }),
    [QUOTA_REQUESTS.claude.url]: () => json(CLAUDE_USAGE),
  };
  const listing = report();
  while (callsTo(C.claude.tokenUrl).length === 0) await new Promise((r) => setImmediate(r));
  const using = use(a.id);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(existsSync(HOMES), false, 'the use is still waiting for the refresh');
  release(json({ access_token: CLAUDE_ACCESS_NEW, refresh_token: CLAUDE_REFRESH_NEW, expires_in: 3600 }));
  const [, r] = await Promise.all([listing, using]);
  assert.equal(r.status, 200);
  assert.equal(callsTo(C.claude.tokenUrl).length, 1, 'one refresh in all');
  assert.equal(readJson(homeFile(a.id, '.credentials.json')).claudeAiOauth.refreshToken, CLAUDE_REFRESH_NEW);
  assert.equal(readJson(homeFile(a.id, '.credentials.json')).claudeAiOauth.accessToken, CLAUDE_ACCESS_NEW);
  assert.equal((await stored()).accounts[0].tokens.refresh, CLAUDE_REFRESH_NEW);
  clock += 24 * 3600_000;
  await report();
  assert.equal(callsTo(C.claude.tokenUrl).length, 1, 'an account with a folder is not refreshed');
});

test('a refresh whose answer comes after the account got a folder keeps its new tokens in the record and writes no folder file', async () => {
  const a = await claudeAccount({ expiresAt: iso(NOW - 1000) });
  let release: (r: Response) => void = () => {};
  answers = { [C.claude.tokenUrl]: () => new Promise<Response>((res) => { release = res; }), [QUOTA_REQUESTS.claude.url]: () => json(CLAUDE_USAGE) };
  const listing = report();
  while (callsTo(C.claude.tokenUrl).length === 0) await new Promise((r) => setImmediate(r));
  await updateAccount(a.id, (x) => ({ ...x, home: true }), { path: FILE });
  release(json({ access_token: CLAUDE_ACCESS_NEW, refresh_token: CLAUDE_REFRESH_NEW, expires_in: 3600 }));
  await listing;
  const rec = (await stored()).accounts[0];
  // the vendor spent the old refresh token, so the new ones are kept in the record (a use writes the folder file from it)
  assert.deepEqual([rec.tokens.access, rec.tokens.refresh, rec.home], [CLAUDE_ACCESS_NEW, CLAUDE_REFRESH_NEW, true]);
  assert.equal(existsSync(join(HOMES, a.id)), false);
});

test('a record that was added again keeps its folder: the login file in it is still the original (no refresh, command shown); the next use replaces it and keeps a .bak', async () => {
  const a = await claudeAccount();
  await use(a.id);
  const dir = join(HOMES, a.id);
  const cliFile = JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE_ACCESS_FOLDER, refreshToken: 'sk-ant-ort01-TESTREFRESHFOLDER01', expiresAt: NOW + 3600_000 } });
  writeFileSync(join(dir, '.credentials.json'), cliFile);
  // adding the same account again: same identity, new tokens (already expired here); `home` is cleared
  const again = await upsertAccount(
    { provider: 'claude', alias: null, identity: (await stored()).accounts[0].identity, email: 'a@example.com', plan: 'max', tier: 'default_claude_max_5x', subscriptionType: 'max', tokens: { access: CLAUDE_ACCESS_NEW, refresh: CLAUDE_REFRESH_NEW, idToken: null, expiresAt: iso(NOW - 1000) } },
    { path: FILE, now },
  );
  assert.equal(again.id, a.id);
  assert.equal(again.home, undefined);
  answers = { [QUOTA_REQUESTS.claude.url]: () => json(CLAUDE_USAGE) };
  const row = (await report()).find((x) => x.id === a.id)!;
  assert.equal(callsTo(C.claude.tokenUrl).length, 0, 'not refreshed');
  assert.equal(row.command, `CLAUDE_CONFIG_DIR='${dir}' claude`);
  assert.equal(callsTo(QUOTA_REQUESTS.claude.url)[0].headers.Authorization, `Bearer ${CLAUDE_ACCESS_FOLDER}`);
  // the next use refreshes the expired new login (no folder mark), writes it over the old file and keeps that as .bak
  answers = claudeRefreshOk();
  const r = await use(a.id);
  assert.equal(r.status, 200);
  assert.equal(readFileSync(join(dir, '.credentials.json.bak'), 'utf8'), cliFile);
  assert.equal(readJson(join(dir, '.credentials.json')).claudeAiOauth.refreshToken, CLAUDE_REFRESH_NEW);
  assert.equal((await stored()).accounts[0].home, true);
});

test('use answers with the account read back from the folder file (its expiry, like the list)', async () => {
  const a = await claudeAccount();
  const r = await use(a.id);
  assert.equal(body(r).account.expiresAt, iso(NOW + 3600_000));
  assert.equal(body(r).account.status, 'ok');
  // use again after the CLI refreshed the file: the answer shows the file's expiry
  writeFileSync(homeFile(a.id, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE_ACCESS_FOLDER, refreshToken: 'r', expiresAt: NOW + 20_000_000 } }));
  const again = await use(a.id);
  assert.equal(body(again).account.expiresAt, iso(NOW + 20_000_000));
});

test('an account with a folder whose login file is gone or unreadable is not written back from the old copy: sign in again, and the .bak stays', async () => {
  const a = await claudeAccount();
  await use(a.id);
  const dir = join(HOMES, a.id);
  writeFileSync(join(dir, '.credentials.json.bak'), 'KEEP-BAK');
  for (const [why, act] of [
    ['gone', () => rmSync(join(dir, '.credentials.json'))],
    ['broken', () => writeFileSync(join(dir, '.credentials.json'), '{broken')],
  ] as const) {
    await updateAccount(a.id, (x) => {
      const { needsReauth: _n, ...rest } = x;
      return rest;
    }, { path: FILE });
    act();
    const r = await use(a.id);
    assert.deepEqual([r.status, body(r)], [409, { error: 'account needs sign-in again' }], why);
    assert.equal((await stored()).accounts[0].needsReauth, true, why);
    assert.equal(readFileSync(join(dir, '.credentials.json.bak'), 'utf8'), 'KEEP-BAK');
    assert.ok(!existsSync(join(dir, '.credentials.json')) || readFileSync(join(dir, '.credentials.json'), 'utf8') === '{broken', 'the old copy was not written back');
  }
  assert.equal(calls.length, 0);
});

test('when the file cannot be written the `home` mark is taken back', async () => {
  const a = await claudeAccount();
  mkdirSync(HOMES, { recursive: true, mode: 0o700 });
  writeFileSync(join(HOMES, a.id), 'A FILE WHERE THE FOLDER BELONGS');
  const r = await use(a.id);
  assert.deepEqual([r.status, body(r)], [500, { error: 'account home not written' }]);
  assert.equal((await stored()).accounts[0].home, undefined);
  assert.deepEqual((await stored()).active, {});
});

test('remove deletes the folder first and the record only after: a folder that cannot go leaves the record, and the next try works', async () => {
  const a = await claudeAccount();
  await use(a.id);
  const real = mkdtempSync(join(FAKE_HOME, 'real-'));
  writeFileSync(join(real, 'keep'), 'K');
  // the account's folder is replaced by a link to a folder elsewhere
  rmSync(join(HOMES, a.id), { recursive: true });
  symlinkSync(real, join(HOMES, a.id));
  const r = await remove(a.id);
  assert.deepEqual([r.status, body(r)], [500, { error: 'account home not removed' }]);
  assert.deepEqual((await stored()).accounts.map((x) => x.id), [a.id]);
  assert.equal(readFileSync(join(real, 'keep'), 'utf8'), 'K');
  rmSync(join(HOMES, a.id));
  assert.equal((await remove(a.id)).status, 200, 'no folder at all is fine');
  assert.deepEqual((await stored()).accounts, []);
});

// ---- the follow-ups of PR #45 review ----

test('a use and a remove of the same account at once leave no folder without a record (50 rounds, both orders)', async () => {
  for (let i = 0; i < 50; i++) {
    const a = await claudeAccount();
    await Promise.all(i % 2 ? [use(a.id), remove(a.id)] : [remove(a.id), use(a.id)]);
    assert.deepEqual((await stored()).accounts.filter((x) => x.id === a.id), [], `record gone, round ${i}`);
    assert.equal(existsSync(join(HOMES, a.id)), false, `no orphan folder, round ${i}`);
  }
});

test('a refresh that was running when the use marked the account: the folder file gets the latest refresh token', async () => {
  const a = await claudeAccount({ expiresAt: iso(NOW + 3600_000) });
  let release: (r: Response) => void = () => {};
  answers = { [C.claude.tokenUrl]: () => new Promise<Response>((res) => { release = res; }) };
  let refreshing: Promise<unknown> | null = null;
  // the use reads the clock once after it waited for running refreshes; a refresh that sees an expired token starts then
  const o = {
    ...options(),
    now: () => {
      if (!refreshing) refreshing = refreshAccount(a.id, { ...options(), now: () => NOW + 2 * 3600_000 });
      return NOW;
    },
  };
  const using = useAccount(a.id, o);
  let spins = 0;
  while ((callsTo(C.claude.tokenUrl).length === 0 || !(await stored()).accounts[0].home) && spins++ < 500) await new Promise((r) => setTimeout(r, 5));
  assert.equal(callsTo(C.claude.tokenUrl).length, 1, 'the refresh asked the vendor before the mark');
  assert.equal((await stored()).accounts[0].home, true, 'the use saved the mark and waits');
  release(json({ access_token: CLAUDE_ACCESS_NEW, refresh_token: CLAUDE_REFRESH_NEW, expires_in: 28800 }));
  await Promise.all([using, refreshing]);
  const file = readJson(homeFile(a.id, '.credentials.json')).claudeAiOauth;
  assert.deepEqual([file.accessToken, file.refreshToken], [CLAUDE_ACCESS_NEW, CLAUDE_REFRESH_NEW]);
  assert.equal((await stored()).accounts[0].tokens.refresh, CLAUDE_REFRESH_NEW);
  assert.equal(callsTo(C.claude.tokenUrl).length, 1);
});

test('a folder file that cannot be checked (EACCES, not ENOENT) counts as a folder: the account is not refreshed', { skip: process.getuid?.() === 0 }, async () => {
  const a = await claudeAccount({ expiresAt: iso(NOW - 1000) });
  const dir = join(HOMES, a.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o000);
  try {
    const row = (await report()).find((x) => x.id === a.id)!;
    assert.equal(row.status, 'unreadable');
    assert.equal(calls.length, 0, 'no refresh request, no usage request');
    const rec = (await stored()).accounts[0];
    assert.deepEqual([rec.tokens.refresh, rec.home], [CLAUDE_REFRESH, undefined]);
  } finally {
    chmodSync(dir, 0o700);
  }
});

/** A use that reads the clock once after it waited for running refreshes; a refresh that sees an expired token starts then */
const useWithLateRefresh = (id: string) => {
  let refreshing: Promise<unknown> | null = null;
  const o = {
    ...options(),
    now: () => {
      if (!refreshing) refreshing = refreshAccount(id, { ...options(), now: () => NOW + 2 * 3600_000 });
      return NOW;
    },
  };
  return { using: useAccount(id, o), refreshing: () => refreshing! };
};
const waitFor = async (what: string, ok: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 500 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(await ok(), what);
};

test('a late refresh that the vendor refuses: the use answers sign-in-again, takes the mark back, saves needsReauth and writes no folder file', async () => {
  const a = await claudeAccount({ expiresAt: iso(NOW + 3600_000) });
  let release: (r: Response) => void = () => {};
  answers = { [C.claude.tokenUrl]: () => new Promise<Response>((res) => { release = res; }) };
  const run = useWithLateRefresh(a.id);
  const outcome = run.using.then(() => null, (e: unknown) => e as { text?: string; status?: number });
  await waitFor('the use marked the account while the refresh waits', async () => callsTo(C.claude.tokenUrl).length === 1 && (await stored()).accounts[0].home === true);
  release(json({ error: 'invalid_grant' }, 401));
  const err = await outcome;
  assert.deepEqual([err?.text, err?.status], ['account needs sign-in again', 409]);
  const rec = (await stored()).accounts[0];
  assert.deepEqual([rec.home, rec.needsReauth], [undefined, true]);
  assert.equal(existsSync(join(HOMES, a.id, '.credentials.json')), false);
  assert.equal(rec.tokens.refresh, CLAUDE_REFRESH);
});

test('a use whose record was removed behind its back after it wrote the folder deletes that folder', async () => {
  const a = await claudeAccount({ expiresAt: iso(NOW + 3600_000) });
  let release: (r: Response) => void = () => {};
  answers = { [C.claude.tokenUrl]: () => new Promise<Response>((res) => { release = res; }) };
  const run = useWithLateRefresh(a.id);
  const outcome = run.using.then(() => null, (e: unknown) => e as { text?: string });
  await waitFor('the use marked the account while the refresh waits', async () => callsTo(C.claude.tokenUrl).length === 1 && (await stored()).accounts[0].home === true);
  // a removal outside the use's turn, queued right behind the refresh's save; its first read is held until the use has written the folder
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => { open = r; });
  release(json({ access_token: CLAUDE_ACCESS_NEW, refresh_token: CLAUDE_REFRESH_NEW, expires_in: 28800 }));
  await run.refreshing();
  const removal = updateAccount(a.id, () => null, { path: FILE, stat: async (p) => (await gate, statSync(p)) });
  await waitFor('the use wrote the folder file', () => existsSync(join(HOMES, a.id, '.credentials.json')));
  open();
  await removal;
  assert.equal((await outcome)?.text, 'account not found');
  assert.equal(existsSync(join(HOMES, a.id)), false, 'the folder of a record that is gone is deleted');
});

test('a plain file where the folder belongs (ENOTDIR) is not a folder account: it is refreshed like one without a folder', async () => {
  const a = await claudeAccount({ expiresAt: iso(NOW - 1000) });
  mkdirSync(HOMES, { recursive: true, mode: 0o700 });
  writeFileSync(join(HOMES, a.id), 'A FILE');
  answers = { ...claudeRefreshOk(), [QUOTA_REQUESTS.claude.url]: () => json(CLAUDE_USAGE) };
  const row = (await report()).find((x) => x.id === a.id)!;
  assert.equal(callsTo(C.claude.tokenUrl).length, 1);
  assert.equal(row.status, 'ok');
  assert.equal(row.command, null);
});

test('a use held in its refresh and a remove of the same account: the remove starts only after the use has finished', async () => {
  const a = await claudeAccount({ expiresAt: iso(NOW - 1000) });
  let release: (r: Response) => void = () => {};
  answers = { [C.claude.tokenUrl]: () => new Promise<Response>((res) => { release = res; }) };
  const using = use(a.id);
  await waitFor('the use asked the vendor and holds', () => callsTo(C.claude.tokenUrl).length === 1);
  const removing = remove(a.id);
  // the remove would act at once without the turn; let the store and the folder code run several rounds
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual((await stored()).accounts.map((x) => x.id), [a.id], 'the record stays while the use runs');
  assert.equal(existsSync(HOMES) ? readdirSync(HOMES).length : 0, 0, 'the remove has not touched the folders');
  release(json({ access_token: CLAUDE_ACCESS_NEW, refresh_token: CLAUDE_REFRESH_NEW, expires_in: 28800 }));
  const [u, r] = await Promise.all([using, removing]);
  assert.equal(u.status, 200, 'the use finished first');
  assert.equal(r.status, 200);
  assert.deepEqual((await stored()).accounts, []);
  assert.equal(existsSync(join(HOMES, a.id)), false, 'no folder left for the removed record');
});

test('refresh: the vendor answered and the folder file cannot be checked (EACCES): the new tokens are saved', { skip: process.getuid?.() === 0 }, async () => {
  const a = await claudeAccount({ expiresAt: iso(NOW - 1000) });
  const dir = join(HOMES, a.id);
  answers = {
    [C.claude.tokenUrl]: () => {
      // the folder appears while the vendor answers, so the check before the request found none
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o000);
      return json({ access_token: CLAUDE_ACCESS_NEW, refresh_token: CLAUDE_REFRESH_NEW, expires_in: 28800 });
    },
  };
  try {
    const r = await refreshAccount(a.id, options());
    assert.equal(r.state, 'done');
  } finally {
    chmodSync(dir, 0o700);
  }
  const rec = (await stored()).accounts[0];
  assert.deepEqual([rec.tokens.access, rec.tokens.refresh], [CLAUDE_ACCESS_NEW, CLAUDE_REFRESH_NEW]);
});

test('refresh: the vendor answered and the CLI login file is in the folder: the new tokens are not saved', async () => {
  const a = await claudeAccount({ expiresAt: iso(NOW - 1000) });
  const dir = join(HOMES, a.id);
  answers = {
    [C.claude.tokenUrl]: () => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, '.credentials.json'), '{"claudeAiOauth":{}}');
      return json({ access_token: CLAUDE_ACCESS_NEW, refresh_token: CLAUDE_REFRESH_NEW, expires_in: 28800 });
    },
  };
  const r = await refreshAccount(a.id, options());
  assert.equal(r.state, 'unusable');
  const rec = (await stored()).accounts[0];
  assert.deepEqual([rec.tokens.access, rec.tokens.refresh], [CLAUDE_ACCESS, CLAUDE_REFRESH]);
});

test('remove: a link inside the folder is deleted as a link and the file outside stays', async () => {
  const a = await claudeAccount();
  await use(a.id);
  const outside = mkdtempSync(join(FAKE_HOME, 'outside-'));
  writeFileSync(join(outside, 'keep.txt'), 'KEEP');
  symlinkSync(join(outside, 'keep.txt'), join(HOMES, a.id, 'link-to-file'));
  symlinkSync(outside, join(HOMES, a.id, 'link-to-folder'));
  assert.equal((await remove(a.id)).status, 200);
  assert.equal(existsSync(join(HOMES, a.id)), false);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'KEEP');
});

test('an added Claude account whose plan is the tier text (as the sign-in stores it) shows no tier', async () => {
  const a = await claudeAccount({}, { plan: 'default_claude_max_5x' });
  answers = { [QUOTA_REQUESTS.claude.url]: () => json(CLAUDE_USAGE) };
  const row = (await report()).find((x) => x.id === a.id)!;
  assert.deepEqual([row.plan, row.tier], ['default_claude_max_5x', null]);
  assert.equal((await stored()).accounts[0].tier, 'default_claude_max_5x', 'the stored value stays');
});

test('an added Claude account shows its stored tier; with a folder it shows the rateLimitTier of the folder file', async () => {
  const a = await claudeAccount();
  const old = await claudeAccount({}, { tier: null, subscriptionType: null });
  answers = { [QUOTA_REQUESTS.claude.url]: () => json(CLAUDE_USAGE) };
  let rows = await report();
  assert.equal(rows.find((x) => x.id === a.id)!.tier, 'default_claude_max_5x');
  assert.equal(rows.find((x) => x.id === old.id)!.tier, null);
  await use(a.id);
  const dir = join(HOMES, a.id);
  const folderFile = (extra: Record<string, unknown>) =>
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE_ACCESS_FOLDER, refreshToken: 'sk-ant-ort01-TESTREFRESHFOLDER01', expiresAt: NOW + 3600_000, ...extra } }));
  folderFile({ rateLimitTier: 'folder_tier' });
  clearQuotaCache();
  rows = await report();
  assert.equal(rows.find((x) => x.id === a.id)!.tier, 'folder_tier');
  folderFile({});
  clearQuotaCache();
  rows = await report();
  assert.equal(rows.find((x) => x.id === a.id)!.tier, null, 'the folder file is the original: no tier there is no tier');
});
