// Token mode (c10dev/portboard#12): the decision table with the owner token (every caller × every token state ×
// requireTokenOnLoopback), the token itself (shape, hash, constant-time check, the 0600 file), the policy from
// access.json and the env, the router (CSRF still required, audit source `token`, the token never logged), the
// Tailscale-only routes without Tailscale, the Host allowlist for a LAN bind, `portboard token`, and the browser side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  bearerToken,
  classify,
  generateToken,
  hashToken,
  loadAccessPolicy,
  loadTokenHash,
  resolveCaller,
  saveTokenHash,
  TAILSCALE_POLICY,
  tokenMatches,
  type AccessPolicy,
  type Caller,
} from '../src/core/access.ts';
import { AuditLog, whoOf } from '../src/core/audit.ts';
import { hostAllowlist, outsideAddrs } from '../src/core/hosts.ts';
import { appRouter } from '../src/features/router.ts';
import { REGISTRY } from '../src/features/registry.ts';
import { main, parseArgs } from '../src/cli.ts';
import { authHeaders, getInit, loadOwnerToken, OWNER_TOKEN_KEY, saveOwnerToken, writeInit } from '../public/lib/api.js';
import type { ServerContext } from '../src/features/context.ts';
import { L } from './fixtures/locale.ts';

const OWNER = 'owner@example.com';
const tmp = () => mkdtempSync(join(tmpdir(), 'pb-token-'));
const { token: TOKEN, hash: HASH } = generateToken();
const TOKEN_POLICY: AccessPolicy = { mode: 'token', requireTokenOnLoopback: false, tokenHash: HASH };
const STRICT: AccessPolicy = { ...TOKEN_POLICY, requireTokenOnLoopback: true };

const SERVE = { 'x-forwarded-for': '100.101.102.103', 'x-forwarded-host': 'devbox.example.ts.net', 'x-forwarded-proto': 'https' };
const req = (remoteAddress: string | undefined, headers: Record<string, string> = {}) => ({ headers: { ...headers }, socket: { remoteAddress } });

// ---- the decision table ----

/** Who calls, as in test/access.test.ts, without any Authorization header. */
const CALLERS = {
  loopback: { r: () => req('127.0.0.1'), source: 'loopback', tailscaleWrite: true, addr: undefined },
  'loopback ::1': { r: () => req('::1'), source: 'loopback', tailscaleWrite: true, addr: undefined },
  'serve, the owner': { r: () => req('127.0.0.1', { ...SERVE, 'tailscale-user-login': OWNER }), source: 'serve', tailscaleWrite: true, addr: '100.101.102.103' },
  'serve, another user': { r: () => req('127.0.0.1', { ...SERVE, 'tailscale-user-login': 'guest@example.com' }), source: 'serve', tailscaleWrite: false, addr: '100.101.102.103' },
  'serve, a tagged node': { r: () => req('127.0.0.1', SERVE), source: 'serve', tailscaleWrite: false, addr: '100.101.102.103' },
  'local proxy (X-Real-IP, a TLS front for the LAN)': { r: () => req('127.0.0.1', { 'x-real-ip': '192.168.1.50', 'x-forwarded-for': '192.168.1.50' }), source: 'serve', tailscaleWrite: false, addr: '192.168.1.50' },
  'funnel, with the owner login': { r: () => req('127.0.0.1', { ...SERVE, 'tailscale-funnel-request': '?1', 'tailscale-user-login': OWNER }), source: 'serve', tailscaleWrite: false, addr: undefined, funnel: true },
  'direct, LAN': { r: () => req('192.168.1.50'), source: 'direct', tailscaleWrite: false, addr: '192.168.1.50' },
  'direct, tailnet IP': { r: () => req('100.64.0.9'), source: 'direct', tailscaleWrite: false, addr: '100.64.0.9' },
  'direct, IPv6 LAN': { r: () => req('fe80::1'), source: 'direct', tailscaleWrite: false, addr: 'fe80::1' },
  'direct, spoofed serve headers and owner login': { r: () => req('192.168.1.50', { ...SERVE, 'tailscale-user-login': OWNER }), source: 'direct', tailscaleWrite: false, addr: '192.168.1.50' },
  'no socket address': { r: () => req(undefined), source: 'direct', tailscaleWrite: false, addr: 'unknown' },
} as const;

const TOKENS: Record<string, string | undefined> = {
  none: undefined,
  valid: `Bearer ${TOKEN}`,
  'valid, lower-case scheme and extra spaces': `bearer   ${TOKEN} `,
  wrong: `Bearer ${generateToken().token}`,
  'right token, one character off': `Bearer ${TOKEN.slice(0, -1)}${TOKEN.endsWith('A') ? 'B' : 'A'}`,
  'its hash instead of the token': `Bearer ${HASH}`,
  'not a bearer token (Basic)': `Basic ${Buffer.from(`x:${TOKEN}`).toString('base64')}`,
  'bearer, empty': 'Bearer ',
  'bearer, junk characters': 'Bearer <script>',
};

const isValid = (k: string) => k.startsWith('valid');

// The reasons in the language the suite runs in (test/fixtures/locale.ts): npm test is ko, npm run test:en is en
const BAD_TOKEN = L(/토큰이 맞지 않아요/, /owner token is wrong/);
const IN_LOCALE = L(/[가-힣]/, /^[^가-힣]+$/);

test('token mode: every caller × every token state × requireTokenOnLoopback', () => {
  let n = 0;
  for (const policy of [TOKEN_POLICY, STRICT]) {
    for (const [who, c] of Object.entries(CALLERS)) {
      for (const [state, auth] of Object.entries(TOKENS)) {
        const r = c.r();
        if (auth !== undefined) (r.headers as Record<string, string>).authorization = auth;
        const got = classify(r, OWNER, policy);
        const name = `${who} / token ${state} / requireTokenOnLoopback ${policy.requireTokenOnLoopback}`;
        const loopbackSocket = r.socket.remoteAddress === '127.0.0.1' || r.socket.remoteAddress === '::1';
        let want: { canWrite: boolean; source: Caller['source']; reason?: RegExp };
        if ('funnel' in c) want = { canWrite: false, source: 'serve', reason: /Funnel/ };
        else if (auth !== undefined) want = isValid(state) ? { canWrite: true, source: 'token' } : { canWrite: false, source: c.source, reason: BAD_TOKEN };
        else if (policy.requireTokenOnLoopback && loopbackSocket) want = { canWrite: false, source: c.source, reason: /requireTokenOnLoopback/ };
        else if (c.source === 'direct') want = { canWrite: false, source: 'direct', reason: L(/토큰 없이/, /without the owner token/) };
        else want = { canWrite: c.tailscaleWrite, source: c.source };
        assert.equal(got.canWrite, want.canWrite, `${name}: canWrite`);
        assert.equal(got.owner, want.canWrite, `${name}: owner and canWrite go together`);
        assert.equal(got.source, want.source, `${name}: source`);
        if (want.reason) assert.match(got.reason ?? '', want.reason, `${name}: reason`);
        if (!got.canWrite) assert.match(got.reason ?? '', IN_LOCALE, `${name}: a reason in the page's language`);
        if (got.source === 'token') {
          assert.equal(got.login, null, `${name}: a token has no login`);
          assert.equal(got.addr, c.addr === 'unknown' ? 'unknown' : c.addr, `${name}: where it came from`);
        }
        if (policy.requireTokenOnLoopback && loopbackSocket && !got.canWrite) assert.equal(got.login, null, `${name}: a forgeable login is not kept`);
        n++;
      }
    }
  }
  assert.equal(n, 2 * Object.keys(CALLERS).length * Object.keys(TOKENS).length);
});

test('token mode: Funnel never writes, whatever it sends', () => {
  for (const policy of [TOKEN_POLICY, STRICT]) {
    for (const extra of [{}, { authorization: `Bearer ${TOKEN}` }, { authorization: `Bearer ${TOKEN}`, 'tailscale-user-login': OWNER }]) {
      const got = classify(req('127.0.0.1', { 'tailscale-funnel-request': '?1', ...extra }), OWNER, policy);
      assert.equal(got.canWrite, false);
      assert.equal(got.owner, false);
      assert.match(got.reason ?? '', /Funnel/);
    }
  }
});

test('token mode: no token made yet, or a broken file: a token is refused everywhere, the rest as without one', () => {
  const none: AccessPolicy = { ...TOKEN_POLICY, tokenHash: null };
  const broken: AccessPolicy = { ...TOKEN_POLICY, error: 'owner-token.json: mode 600' };
  for (const r of [req('192.168.1.50'), req('127.0.0.1'), req('127.0.0.1', { ...SERVE, 'tailscale-user-login': OWNER })]) {
    const a = classify({ ...r, headers: { ...r.headers, authorization: `Bearer ${TOKEN}` } }, OWNER, none);
    assert.equal(a.canWrite, false);
    assert.match(a.reason ?? '', /portboard token/);
    const b = classify({ ...r, headers: { ...r.headers, authorization: `Bearer ${TOKEN}` } }, OWNER, broken);
    assert.equal(b.canWrite, false);
    assert.match(b.reason ?? '', L(/확인할 수 없어요.*600/, /can't be checked.*600/));
  }
  assert.equal(classify(req('127.0.0.1'), OWNER, none).canWrite, true, 'loopback without a token is still the owner');
  assert.equal(classify(req('127.0.0.1'), OWNER, { ...none, requireTokenOnLoopback: true }).canWrite, false, '…unless it must send one');
});

test('tailscale mode (the default) never reads Authorization: behaviour as before', () => {
  for (const policy of [undefined, TAILSCALE_POLICY]) {
    const lan = classify(req('192.168.1.50', { authorization: `Bearer ${TOKEN}` }), OWNER, policy);
    assert.deepEqual([lan.source, lan.canWrite], ['direct', false]);
    const local = classify(req('127.0.0.1', { authorization: 'Bearer wrong' }), OWNER, policy);
    assert.deepEqual([local.source, local.canWrite], ['loopback', true], 'a wrong token costs nothing where tokens mean nothing');
  }
  // requireTokenOnLoopback without token mode is never set by loadAccessPolicy, and classify ignores it there too
  assert.equal(classify(req('127.0.0.1'), OWNER, { ...TAILSCALE_POLICY, requireTokenOnLoopback: true }).canWrite, true);
});

test('bearerToken: undefined without the header, the token, or "" for anything else', () => {
  assert.equal(bearerToken(req('127.0.0.1')), undefined);
  assert.equal(bearerToken(req('127.0.0.1', { authorization: `Bearer ${TOKEN}` })), TOKEN);
  assert.equal(bearerToken(req('127.0.0.1', { authorization: `BEARER\t${TOKEN}` })), TOKEN);
  for (const v of ['', 'Bearer', 'Bearer ', `Token ${TOKEN}`, `Bearer ${TOKEN} extra`, `Bearer ${'a'.repeat(257)}`, 'Bearer a\nb']) {
    assert.equal(bearerToken(req('127.0.0.1', { authorization: v })), '', JSON.stringify(v));
  }
});

test('tokens: pbt_ and 32 random bytes; only the sha256 is kept; the check is exact', () => {
  const a = generateToken();
  const b = generateToken();
  assert.match(a.token, /^pbt_[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(a.token.slice(4), 'base64url').length, 32);
  assert.notEqual(a.token, b.token);
  assert.equal(a.hash, hashToken(a.token));
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.equal(tokenMatches(a.token, a.hash), true);
  assert.equal(tokenMatches(b.token, a.hash), false);
  assert.equal(tokenMatches(a.hash, a.hash), false, 'the hash is not the token');
  assert.equal(tokenMatches('', a.hash), false);
  assert.equal(tokenMatches(a.token, 'not-a-hash'), false);
  assert.equal(tokenMatches(a.token, a.hash.toUpperCase()), false, 'only the shape saveTokenHash writes');
});

test('owner-token.json: 0600, the hash only; a loose or odd file is an error, a missing one is none', async () => {
  const dir = tmp();
  const file = join(dir, 'sub', 'owner-token.json');
  assert.deepEqual(await loadTokenHash(file), { hash: null });
  await saveTokenHash(file, HASH, new Date('2026-10-19T00:00:00Z'));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(file, 'utf8').includes(TOKEN), 'never the token');
  assert.deepEqual(await loadTokenHash(file), { hash: HASH, created: '2026-10-19T00:00:00.000Z' });
  chmodSync(file, 0o644);
  assert.match((await loadTokenHash(file)).error ?? '', /600/);
  chmodSync(file, 0o640);
  assert.match((await loadTokenHash(file)).error ?? '', /600/, 'readable by the group: refused');
  assert.equal((await loadTokenHash(file)).hash, null);
  writeFileSync(file, '{"sha256":"short"}', { mode: 0o600 });
  chmodSync(file, 0o600);
  assert.equal((await loadTokenHash(file)).hash, null);
  assert.match((await loadTokenHash(file)).error ?? '', /portboard token/);
});

test('loadAccessPolicy: access.json mode and requireTokenOnLoopback, the env on top, failing towards tailscale mode', async () => {
  const dir = tmp();
  const access = join(dir, 'access.json');
  const tokenFile = join(dir, 'owner-token.json');
  const load = (env: Record<string, string> = {}) => loadAccessPolicy(access, tokenFile, env);
  assert.deepEqual(await load(), TAILSCALE_POLICY, 'no file: the default');
  await saveTokenHash(tokenFile, HASH);
  assert.deepEqual(await load(), TAILSCALE_POLICY, 'a token file alone turns nothing on');
  assert.deepEqual(await load({ PORTBOARD_ACCESS_MODE: 'token' }), TOKEN_POLICY);
  assert.deepEqual(await load({ PORTBOARD_ACCESS_MODE: 'token', PORTBOARD_REQUIRE_TOKEN_ON_LOOPBACK: '1' }), STRICT);

  writeFileSync(access, JSON.stringify({ writeDevices: ['dev-mac'], mode: 'token', requireTokenOnLoopback: true }), { mode: 0o600 });
  assert.deepEqual(await load(), STRICT);
  assert.deepEqual(await load({ PORTBOARD_REQUIRE_TOKEN_ON_LOOPBACK: '0' }), STRICT, 'the env can only turn it on');
  assert.deepEqual(await load({ PORTBOARD_ACCESS_MODE: 'tailscale' }), TAILSCALE_POLICY, 'the env mode wins; requireTokenOnLoopback means nothing without tokens');

  writeFileSync(access, JSON.stringify({ mode: 'tokens' }));
  const typo = await load();
  assert.deepEqual([typo.mode, typo.tokenHash], ['tailscale', null], 'a typo never opens anything');
  assert.match(typo.error ?? '', /tokens/);
  writeFileSync(access, JSON.stringify({ mode: 'token', requireTokenOnLoopback: 'yes' }));
  const odd = await load();
  assert.equal(odd.requireTokenOnLoopback, false);
  assert.match(odd.error ?? '', L(/true나 false/, /true or false/));
  assert.equal(classify(req('192.168.1.50', { authorization: `Bearer ${TOKEN}` }), OWNER, odd).canWrite, false, 'an unusable setting refuses the token');

  writeFileSync(access, JSON.stringify({ mode: 'token' }));
  chmodSync(access, 0o664);
  const loose = await load({ PORTBOARD_ACCESS_MODE: 'token' });
  assert.match(loose.error ?? '', /access\.json.*600/);
  assert.equal(classify(req('192.168.1.50', { authorization: `Bearer ${TOKEN}` }), OWNER, loose).canWrite, false);
  chmodSync(access, 0o640);
  const group = await load({ PORTBOARD_ACCESS_MODE: 'token' });
  assert.match(group.error ?? '', /access\.json.*600/, 'readable by the group: refused');
  assert.equal(classify(req('192.168.1.50', { authorization: `Bearer ${TOKEN}` }), OWNER, group).canWrite, false);
  chmodSync(access, 0o600);
  writeFileSync(access, '{torn');
  assert.match((await load({ PORTBOARD_ACCESS_MODE: 'token' })).error ?? '', /JSON/);
});

// ---- the router ----

function request(method: string, remoteAddress: string, headers: Record<string, string> = {}, body?: string) {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as any;
  r.method = method;
  r.headers = headers;
  r.socket = { remoteAddress };
  return r;
}

function context(policy: AccessPolicy, tailscale = true) {
  const audit = new AuditLog(join(tmp(), 'audit.jsonl'));
  const fake = {
    owner: async () => (tailscale ? OWNER : null),
    device: async (addr: string) => ({ addr }),
    writeDevices: async () => null,
    policy: async () => policy,
    ts: { available: tailscale },
    audit,
  };
  // a handler that goes further than the gate fails the test
  const ctx = new Proxy(fake as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : assert.fail(`handler touched ctx.${String(k)}`)) }) as unknown as ServerContext;
  return { ctx, audit };
}

test('router, token mode: the token writes from the LAN as source token; X-Portboard is still required; a wrong one is denied; the token is never logged', async () => {
  const ran: string[] = [];
  const routes = [{ method: 'POST' as const, path: '/api/ports/:port/poke', write: true, body: { limit: 1024 }, handler: async () => (ran.push('poke'), { status: 200, body: { message: 'poked' } }) }];
  const { ctx, audit } = context(TOKEN_POLICY, false);
  const route = appRouter(routes, ctx);
  const at = (q: any) => route(q, new URL('http://x/api/ports/8080/poke'), ctx);
  const auth = { authorization: `Bearer ${TOKEN}` };
  assert.equal((await at(request('POST', '192.168.1.50', { 'x-portboard': '1', ...auth }, '{}')))?.status, 200);
  assert.equal((await at(request('POST', '192.168.1.50', auth, '{}')))?.status, 403, 'CSRF header still required');
  const wrong = await at(request('POST', '192.168.1.50', { 'x-portboard': '1', authorization: `Bearer ${TOKEN}x` }, '{}'));
  assert.equal(wrong?.status, 403);
  assert.match((wrong?.body as { reason: string }).reason, BAD_TOKEN);
  assert.equal((await at(request('POST', '192.168.1.50', { 'x-portboard': '1' }, '{}')))?.status, 403, 'no token from the LAN: read-only');
  assert.equal((await at(request('POST', '127.0.0.1', { 'x-portboard': '1' }, '{}')))?.status, 200, 'loopback without requireTokenOnLoopback');
  assert.deepEqual(ran, ['poke', 'poke']);
  const log = await audit.query({ limit: 50 });
  const ok = log.filter((e) => e.result === 'ok');
  assert.deepEqual(ok.map((e) => [e.source, e.who]).sort(), [['loopback', 'local'], ['token', '192.168.1.50']]);
  assert.equal(log.filter((e) => e.result === 'denied').length, 3);
  for (const f of [audit.path, audit.path.replace(/audit\.jsonl$/, 'audit-denied.jsonl')]) {
    let text = '';
    try {
      text = readFileSync(f, 'utf8');
    } catch {}
    assert.ok(!text.includes(TOKEN) && !text.includes(HASH), `${f}: neither the token nor its hash`);
  }
});

test('router, requireTokenOnLoopback: local processes and serve logins need the token too', async () => {
  const routes = [{ method: 'POST' as const, path: '/api/x', write: true, handler: async () => ({ status: 200, body: {} }) }];
  const { ctx } = context(STRICT);
  const route = appRouter(routes, ctx);
  const at = (q: any) => route(q, new URL('http://x/api/x'), ctx);
  assert.equal((await at(request('POST', '127.0.0.1', { 'x-portboard': '1' })))?.status, 403);
  assert.equal((await at(request('POST', '127.0.0.1', { 'x-portboard': '1', ...SERVE, 'tailscale-user-login': OWNER })))?.status, 403, 'a forgeable login');
  assert.equal((await at(request('POST', '127.0.0.1', { 'x-portboard': '1', authorization: `Bearer ${TOKEN}` })))?.status, 200);
});

test('whoami and the audit log in token mode; whoami says when Tailscale is missing', async () => {
  const { ctx, audit } = context(TOKEN_POLICY, false);
  await audit.append({ at: new Date().toISOString(), who: 'local', source: 'loopback', route: 'POST /api/x', target: { port: 3000 }, result: 'ok', status: 200 });
  const route = appRouter(REGISTRY.routes, ctx);
  const get = async (path: string, addr: string, headers: Record<string, string> = {}) => route(request('GET', addr, headers), new URL(`http://x${path}`), ctx);
  const auth = { authorization: `Bearer ${TOKEN}` };
  assert.deepEqual((await get('/api/whoami', '192.168.1.50', auth))?.body, { login: null, source: 'token', owner: true, canWrite: true, device: { addr: '192.168.1.50' }, mode: 'token', tailscale: false });
  const ro = (await get('/api/whoami', '192.168.1.50'))?.body as Record<string, unknown>;
  assert.deepEqual([ro.canWrite, ro.mode, ro.tailscale], [false, 'token', false]);
  assert.equal((await get('/api/audit', '192.168.1.50', auth))?.status, 200);
  assert.equal((await get('/api/audit', '192.168.1.50'))?.status, 403);
  // the default: neither field
  const def = context(TAILSCALE_POLICY);
  const plain = (await appRouter(REGISTRY.routes, def.ctx)(request('GET', '127.0.0.1'), new URL('http://x/api/whoami'), def.ctx))?.body;
  assert.deepEqual(plain, { login: null, source: 'loopback', owner: true, canWrite: true });
});

test('without Tailscale: expose, unexpose and the write-device allowlist answer 409 before doing anything', async () => {
  const { ctx } = context(TOKEN_POLICY, false);
  const route = appRouter(REGISTRY.routes, ctx);
  for (const path of ['/api/ports/8080/expose', '/api/ports/8080/unexpose', '/api/settings/write-devices']) {
    const out = await route(request('POST', '127.0.0.1', { 'x-portboard': '1' }, '{"writeDevices":["mac"]}'), new URL(`http://x${path}`), ctx);
    assert.equal(out?.status, 409, path);
    assert.match((out?.body as { error: string }).error, L(/Tailscale이 필요한데/, /needs Tailscale/), path);
    assert.equal((out?.body as { message: string }).message, (out?.body as { error: string }).error, `${path}: the port actions read message`);
  }
});

test('resolveCaller: a token caller from a tailnet address is identified; the allowlist limits serve logins only', async () => {
  const asked: string[] = [];
  const deps = {
    owner: async () => OWNER,
    device: async (a: string) => (asked.push(a), { addr: a, name: 'docker-vm' }),
    writeDevices: async () => ({ list: ['dev-mac'] }),
    policy: async () => TOKEN_POLICY,
  };
  const c = await resolveCaller(req('100.64.0.9', { authorization: `Bearer ${TOKEN}` }), deps);
  assert.deepEqual([c.source, c.canWrite, c.device?.name], ['token', true, 'docker-vm']);
  assert.deepEqual(asked, ['100.64.0.9']);
  assert.equal(whoOf(c), '100.64.0.9');
  assert.equal(whoOf(classify(req('127.0.0.1', { authorization: `Bearer ${TOKEN}` }), OWNER, TOKEN_POLICY)), 'local');
});

// ---- binding and the Host check ----

test('Host allowlist: this machine only; a wildcard bind adds its interface addresses, PORTBOARD_ALLOWED_HOSTS adds names', () => {
  const ts = { hostName: null, dnsName: null, ips: [] };
  const interfaces = () => ({ lo: [{ address: '127.0.0.1' }], eth0: [{ address: '192.168.1.10' }, { address: 'fe80::1%eth0' }] }) as any;
  const plain = hostAllowlist({ bindHosts: ['127.0.0.1'], ts, hostname: 'devbox', interfaces });
  assert.deepEqual([...plain].sort(), ['127.0.0.1', 'devbox', 'localhost']);
  const lan = hostAllowlist({ bindHosts: ['127.0.0.1', '192.168.1.10'], ts, hostname: 'devbox', extra: 'devbox.lan, DevBox.Local', interfaces });
  assert.ok(lan.has('192.168.1.10') && lan.has('devbox.lan') && lan.has('devbox.local'));
  assert.ok(!lan.has('evil.example.com'));
  const wild = hostAllowlist({ bindHosts: ['0.0.0.0'], ts, hostname: 'devbox', interfaces });
  assert.ok(wild.has('192.168.1.10') && wild.has('fe80::1'));
  assert.ok(!wild.has('0.0.0.0'), 'the wildcard itself is no host name');
  assert.deepEqual(outsideAddrs(['127.0.0.1', '::1', 'localhost', '100.64.0.1', 'fd7a:115c:a1e0::1', '192.168.1.10', '0.0.0.0']), ['192.168.1.10', '0.0.0.0']);
});

// ---- portboard token ----

test('portboard token: prints the token once on stdout, keeps only its hash (0600), and running it again rotates', async () => {
  assert.equal(parseArgs(['token']).cmd, 'token');
  assert.throws(() => parseArgs(['token', '--show']), /unknown option/);
  const dir = tmp();
  const files = { token: join(dir, 'owner-token.json'), access: join(dir, 'access.json') };
  const run = async (env: Record<string, string> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(['token'], { out: (s) => out.push(s), err: (s) => err.push(s), env, accessFiles: async () => files });
    return { code, out, err: err.join('\n') };
  };
  const first = await run();
  assert.equal(first.code, 0);
  assert.equal(first.out.length, 1, 'stdout is the token alone');
  const tok = first.out[0];
  assert.match(tok, /^pbt_[A-Za-z0-9_-]{43}$/);
  assert.ok(!first.err.includes(tok), 'stderr never repeats it');
  assert.match(first.err, /Token mode is off/);
  assert.equal(statSync(files.token).mode & 0o777, 0o600);
  assert.ok(!readFileSync(files.token, 'utf8').includes(tok));
  const policy = await loadAccessPolicy(files.access, files.token, { PORTBOARD_ACCESS_MODE: 'token' });
  assert.equal(classify(req('192.168.1.50', { authorization: `Bearer ${tok}` }), null, policy).canWrite, true);

  const second = await run({ PORTBOARD_ACCESS_MODE: 'token' });
  assert.match(second.err, /Replaced/);
  assert.doesNotMatch(second.err, /Token mode is off/);
  const after = await loadAccessPolicy(files.access, files.token, { PORTBOARD_ACCESS_MODE: 'token' });
  assert.equal(classify(req('192.168.1.50', { authorization: `Bearer ${tok}` }), null, after).canWrite, false, 'the old token stops working');
  assert.equal(classify(req('192.168.1.50', { authorization: `Bearer ${second.out[0]}` }), null, after).canWrite, true);
});

// ---- the browser side ----

function storage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

test('lib/api.js: the owner token is kept per browser and sent as a header, never in a URL', () => {
  const s = storage();
  assert.equal(loadOwnerToken(s), null);
  assert.deepEqual(authHeaders(s), {});
  assert.deepEqual(writeInit(undefined, s), { method: 'POST', headers: { 'X-Portboard': '1' } });
  assert.equal(saveOwnerToken(` ${TOKEN} `, s), true);
  assert.equal(s.m.get(OWNER_TOKEN_KEY), TOKEN);
  assert.deepEqual(authHeaders(s), { Authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(writeInit({ a: 1 }, s), { method: 'POST', headers: { 'X-Portboard': '1', 'content-type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: '{"a":1}' });
  assert.equal(saveOwnerToken('not a token\n', s), false, 'odd values are not kept');
  assert.equal(s.m.get(OWNER_TOKEN_KEY), TOKEN);
  assert.equal(loadOwnerToken(storage({ [OWNER_TOKEN_KEY]: 'x y' })), null);
  assert.equal(saveOwnerToken('', s), true);
  assert.equal(s.m.has(OWNER_TOKEN_KEY), false);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(loadOwnerToken(blocked), null);
  assert.equal(saveOwnerToken(TOKEN, blocked), false);
  // in node there is no localStorage: reads are plain fetch(path)
  assert.equal(getInit(), undefined);
  const src = readFileSync(new URL('../public/lib/api.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /[?&]token=/, 'no token in a query string');
});

test('settings: the owner token row is not a data-write control, and 쓰기 허용 기기 leaves the menu without Tailscale', () => {
  const src = readFileSync(new URL('../public/features/settings-modal.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function paintOwnerToken'), src.indexOf('async function readOnlyNotes'));
  assert.ok(fn.length > 100);
  assert.doesNotMatch(fn, /data-write|write: '1'|dataset: \{ write/, 'a read-only browser must be able to enter it');
  assert.match(fn, /type: 'password'/);
  assert.match(src, /wd\.hidden = w\?\.tailscale === false/);
  const audit = readFileSync(new URL('../public/lib/audit.js', import.meta.url), 'utf8');
  assert.match(audit, /fetch\(path, getInit\(\)\)/, 'the audit log is read with the token too');
});

test('service logs are the owner\'s only, as the audit log is: a non-owner gets 403 before any snapshot', async () => {
  const at = async (c: ReturnType<typeof context>, addr: string, headers: Record<string, string> = {}) =>
    appRouter(REGISTRY.routes, c.ctx)(request('GET', addr, headers), new URL('http://x/api/ports/9/logs'), c.ctx);
  // the context fails the test when the handler reads ctx.snapshot
  const ts = context(TAILSCALE_POLICY);
  for (const [addr, headers, why] of [
    ['100.64.0.9', {}, 'a direct tailnet caller'],
    ['127.0.0.1', { ...SERVE, 'tailscale-user-login': 'guest@example.com' }, 'a node shared in, logged in as someone else'],
    ['127.0.0.1', SERVE, 'a tagged node through serve'],
  ] as const) {
    const r = await at(ts, addr, headers);
    assert.equal(r?.status, 403, why);
    assert.equal((r?.body as { error?: string }).error, 'owner only', why);
  }
  const tok = context(TOKEN_POLICY, false);
  assert.equal((await at(tok, '192.168.1.50'))?.status, 403, 'token mode without the token');
  // the owner goes on to the snapshot: nothing listens on 9, so 409
  const withSnap = (c: ReturnType<typeof context>) => ({ ...c, ctx: new Proxy(c.ctx as object, { get: (t, k) => (k === 'snapshot' ? async () => ({ ports: [] }) : (t as any)[k]) }) as ServerContext });
  assert.equal((await at(withSnap(ts), '127.0.0.1'))?.status, 409, 'loopback');
  assert.equal((await at(withSnap(ts), '127.0.0.1', { ...SERVE, 'tailscale-user-login': OWNER }))?.status, 409, 'the owner through serve');
  assert.equal((await at(withSnap(tok), '192.168.1.50', { authorization: `Bearer ${TOKEN}` }))?.status, 409, 'the owner token');
});
