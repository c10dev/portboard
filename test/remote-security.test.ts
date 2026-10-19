// Regression tests for docs/remote-mcp/SECURITY-REVIEW.md. Each test names the finding it covers (S1…).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteHandler, type RemoteDeps } from '../src/remote/http.ts';
import { clientAddress, viaFunnel } from '../src/remote/guard.ts';
import { fetchClientMetadata, redirectAllowed } from '../src/remote/oauth.ts';
import { scrubText } from '../src/remote/redact.ts';
import { Store, sha256 } from '../src/remote/store.ts';
import type { RemoteCore } from '../src/remote/tools.ts';

const dirs: string[] = [];
const servers: Server[] = [];
after(async () => {
  for (const s of servers) s.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'portboard-sec-'));
  dirs.push(d);
  return d;
};

const core: RemoteCore = {
  snapshot: async () => ({ at: 'now', host: { hostname: 'box', user: 'me' }, tailscale: { available: false } as any, ports: [] }),
  devices: async () => ({ at: 'now', pool: { available: false } as any, devices: [], proxmox: { configured: false, ok: false, hosts: [] } }),
  freePorts: async () => [3000],
  usage: async () => ({ at: 'now', observingSince: 'then', cards: [], local: { connections: 0, uses: [] }, byPort: {}, idleServices: 0 }) as any,
};

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A handler on port 0 with its own store, log and fake CIMD fetch. */
async function start(over: Partial<RemoteDeps> = {}, initial?: object) {
  const dir = await tmp();
  const store = new Store(join(dir, 'remote.json'));
  if (initial) await writeFile(store.path, JSON.stringify(initial), { mode: 0o600 });
  const logs: string[] = [];
  const fetchCalls: string[] = [];
  const fetchImpl = (async (url: URL | string) => {
    fetchCalls.push(String(url));
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  const server = createServer(
    createRemoteHandler({ core, store, hosts: new Set(['127.0.0.1', 'box.tail0000.ts.net']), log: (e, f) => logs.push(`${e} ${JSON.stringify(f)}`), fetchImpl, ...over }),
  );
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port as number;
  const call = (method: string, path: string, opts: { headers?: Record<string, string>; body?: string | object } = {}): Promise<Res> => {
    const body = typeof opts.body === 'object' ? JSON.stringify(opts.body) : opts.body;
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) };
    if (typeof opts.body === 'object' && !headers['content-type']) headers['content-type'] = 'application/json';
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  };
  return { store, logs, fetchCalls, call, base: `http://127.0.0.1:${port}` };
}

const funnel = (ip: string) => ({ 'tailscale-funnel-request': '?1', 'x-forwarded-for': ip });
const formBody = (o: Record<string, string>) => ({ 'content-type': 'application/x-www-form-urlencoded', body: new URLSearchParams(o).toString() });
const tokenCall = (h: Awaited<ReturnType<typeof start>>, o: Record<string, string>, headers: Record<string, string> = {}) => {
  const { body, ...ct } = formBody(o);
  return h.call('POST', '/token', { headers: { ...ct, ...headers }, body });
};

/** DCR + approval + code exchange from a loopback redirect, as in remote-http.test.ts. */
async function grant(h: Awaited<ReturnType<typeof start>>) {
  const redirect = 'http://127.0.0.1:33418/cb';
  const reg = JSON.parse((await h.call('POST', '/register', { body: { client_name: 't', redirect_uris: [redirect] } })).body);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = { response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256' };
  const { code: approval } = await h.store.newApprovalCode();
  const { body, ...ct } = formBody({ ...params, approval_code: approval, decision: 'approve' });
  const ok = await h.call('POST', '/authorize', { headers: ct, body });
  assert.equal(ok.status, 302, ok.body);
  const code = new URL(String(ok.headers.location)).searchParams.get('code')!;
  return { clientId: reg.client_id as string, code, verifier, redirect };
}

// ---- S1: valid credentials are never refused by the failure limiter ----

test('S1: a valid access or refresh token works from an address that is over the failure limit', async () => {
  const h = await start({ publicUrl: 'https://box.tail0000.ts.net:8443' }); // same issuer for loopback and Funnel requests
  const { clientId, code, verifier } = await grant(h);
  const egress = funnel('160.79.104.10'); // a shared egress address: someone else's connector failed from it
  const t = JSON.parse((await tokenCall(h, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId })).body);
  for (let i = 0; i < 21; i++) await tokenCall(h, { grant_type: 'authorization_code', code: `bogus${i}`, code_verifier: verifier, client_id: clientId }, egress);
  const bad = await tokenCall(h, { grant_type: 'authorization_code', code: 'bogus', code_verifier: verifier, client_id: clientId }, egress);
  assert.equal(bad.status, 429, 'failures from that address are still limited');
  const mcp = await h.call('POST', '/mcp', { headers: { ...egress, authorization: `Bearer ${t.access_token}` }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  assert.equal(mcp.status, 200, mcp.body);
  const badMcp = await h.call('POST', '/mcp', { headers: { ...egress, authorization: 'Bearer guess' }, body: {} });
  assert.equal(badMcp.status, 429);
  const refreshed = await tokenCall(h, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId }, egress);
  assert.equal(refreshed.status, 200, refreshed.body);
});

// ---- S2: Tailscale-Funnel-Request only from loopback ----

test('S2: Tailscale-Funnel-Request and X-Forwarded-For are ignored unless the socket is loopback', () => {
  const req = (remoteAddress: string) => ({ headers: funnel('198.51.100.9'), socket: { remoteAddress } }) as unknown as IncomingMessage;
  assert.equal(viaFunnel(req('127.0.0.1')), true);
  assert.equal(clientAddress(req('::ffff:127.0.0.1')), 'funnel:198.51.100.9');
  assert.equal(viaFunnel(req('100.64.0.9')), false, 'a tailnet peer on the tailnet listener');
  assert.equal(clientAddress(req('100.64.0.9')), '100.64.0.9');
});

// ---- S3: unauthenticated work is limited ----

test('S3: /register is limited per address, successful registrations included', async () => {
  const h = await start();
  const reg = () => h.call('POST', '/register', { headers: funnel('198.51.100.60'), body: { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] } });
  for (let i = 0; i < 10; i++) assert.equal((await reg()).status, 201);
  const r = await reg();
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers['retry-after']) > 0);
  const other = await h.call('POST', '/register', { headers: funnel('198.51.100.61'), body: { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] } });
  assert.equal(other.status, 201);
  assert.equal(Object.keys((await h.store.read()).clients).length, 11);
});

test('S3: unknown CIMD client_ids count as failures; the address stops causing fetches', async () => {
  const h = await start();
  const p = { response_type: 'code', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' };
  let last = 0;
  for (let i = 0; i < 25; i++) {
    last = (await h.call('GET', `/authorize?${new URLSearchParams({ ...p, client_id: `https://claude.ai/x${i}` })}`, { headers: funnel('198.51.100.70') })).status;
  }
  assert.equal(last, 429);
  assert.equal(h.fetchCalls.length, 20, 'no fetch once the address is blocked');
  assert.ok(h.logs.some((l) => l.startsWith('auth-fail') && l.includes('/authorize')));
});

test('S3: CIMD fetches are capped for everyone together', async () => {
  const h = await start();
  const p = { response_type: 'code', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' };
  for (let i = 0; i < 70; i++) {
    await h.call('GET', `/authorize?${new URLSearchParams({ ...p, client_id: `https://claude.ai/y${i}` })}`, { headers: funnel(`198.51.100.${100 + Math.floor(i / 10)}`) });
  }
  assert.equal(h.fetchCalls.length, 60);
});

test('S3: CIMD client_id with a query, credentials or no path is refused without a fetch; bodies are read with a cap', async () => {
  let fetched = 0;
  const f = (async () => {
    fetched++;
    return new Response('x');
  }) as unknown as typeof fetch;
  for (const id of ['https://claude.ai/a?b=1', 'https://u:p@claude.ai/a', 'https://claude.ai/', `https://claude.ai/${'a'.repeat(400)}`]) {
    assert.equal(typeof (await fetchClientMetadata(id, f)), 'string', id);
  }
  assert.equal(fetched, 0);

  // 1 MB stream with no Content-Length: refused after 16 KB, not buffered whole
  let pulled = 0;
  const huge = (async () =>
    new Response(
      new ReadableStream({
        pull(c) {
          pulled++;
          c.enqueue(new Uint8Array(4096).fill(32));
          if (pulled >= 256) c.close();
        },
      }),
    )) as unknown as typeof fetch;
  assert.equal(await fetchClientMetadata('https://claude.ai/big', huge), 'client metadata document too large');
  assert.ok(pulled < 20, `read ${pulled} chunks`);
});

// ---- S4: cross-process writes ----

test('S4: two Store instances (server and CLI) on one file do not lose each other\'s writes', async () => {
  const dir = await tmp();
  const a = new Store(join(dir, 'remote.json'));
  const b = new Store(join(dir, 'remote.json'));
  await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).registerClient(`c${i}`, ['http://127.0.0.1:1/cb'])));
  assert.equal(Object.keys((await a.read()).clients).length, 30);
  assert.deepEqual((await readdir(dir)).sort(), ['remote.json'], 'no lock or temp files left behind');
});

test('S4: revoke from the CLI is not undone by a server write in flight', async () => {
  const dir = await tmp();
  const server = new Store(join(dir, 'remote.json'));
  const cli = new Store(join(dir, 'remote.json'));
  await server.issueTokens({ id: 'c', name: 'c' }, 'r', 's');
  // A server update that is slow between its read and its write (the window a concurrent revoke used to fall into).
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = server.update(async () => {
    await gate;
  });
  const revoke = cli.revoke();
  setTimeout(release, 50);
  await Promise.all([slow, revoke]);
  assert.equal(Object.keys((await cli.read()).tokens).length, 0);
});

test('S4: a stale lock left by a crashed writer is broken', async () => {
  const dir = await tmp();
  const s = new Store(join(dir, 'remote.json'));
  await writeFile(`${s.path}.lock`, '1');
  const old = new Date(Date.now() - 60_000);
  const { utimes } = await import('node:fs/promises');
  await utimes(`${s.path}.lock`, old, old);
  await s.registerClient('x', ['http://127.0.0.1:1/cb']);
  assert.equal(Object.keys((await s.read()).clients).length, 1);
});

// ---- S5: approval code per address (also covered in remote-http.test.ts) ----

// ---- S6: refresh-token reuse ----

test('S6: replaying a rotated refresh token after the grace period revokes the whole authorization', async () => {
  let t = 1_000_000;
  const dir = await tmp();
  const s = new Store(join(dir, 'remote.json'), () => t);
  const first = await s.issueTokens({ id: 'c', name: 'c' }, 'r', 'sc');
  const old = await s.takeRefreshToken(first.refresh);
  assert.ok(old && old !== 'reused');
  const second = await s.issueTokens({ id: 'c', name: 'c' }, 'r', 'sc', old.family);
  const other = await s.issueTokens({ id: 'c', name: 'c' }, 'r', 'sc'); // a separate authorization of the same client

  t += 5_000;
  assert.equal(await s.takeRefreshToken(first.refresh), null, 'inside the grace period: refused, nothing revoked');
  assert.ok(await s.verifyAccessToken(second.access));

  t += 10_000;
  assert.equal(await s.takeRefreshToken(first.refresh), 'reused');
  assert.equal(await s.verifyAccessToken(second.access), null, 'the new access token is revoked');
  assert.equal(await s.takeRefreshToken(second.refresh), null, 'and the new refresh token');
  assert.ok(await s.verifyAccessToken(other.access), 'other authorizations are untouched');
  assert.equal(await s.verifyAccessToken(first.access), null, 'and the access token the authorization started with');
});

test('S6: /token answers a replayed refresh token with invalid_grant and logs it', async () => {
  const h = await start();
  const { clientId, code, verifier } = await grant(h);
  const first = JSON.parse((await tokenCall(h, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId })).body);
  const second = JSON.parse((await tokenCall(h, { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId })).body);
  assert.ok(second.access_token);
  // Age the rotated token past the grace period on disk.
  await h.store.update((s) => {
    for (const r of Object.values(s.tokens)) if (r.kind === 'used') r.usedAt = (r.usedAt ?? 0) - 60_000;
  });
  const replay = await tokenCall(h, { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
  assert.equal(JSON.parse(replay.body).error, 'invalid_grant');
  assert.ok(h.logs.some((l) => l.startsWith('refresh-reuse')));
  const mcp = await h.call('POST', '/mcp', { headers: { authorization: `Bearer ${second.access_token}` }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  assert.equal(mcp.status, 401);
});

// ---- S7: client_id required at /token ----

test('S7: /token requires client_id for both grants', async () => {
  const h = await start();
  const { clientId, code, verifier } = await grant(h);
  const noId = await tokenCall(h, { grant_type: 'authorization_code', code, code_verifier: verifier });
  assert.equal(JSON.parse(noId.body).error, 'invalid_grant');
  const g = await grant(h);
  const t = JSON.parse((await tokenCall(h, { grant_type: 'authorization_code', code: g.code, code_verifier: g.verifier, client_id: g.clientId })).body);
  const r = await tokenCall(h, { grant_type: 'refresh_token', refresh_token: t.refresh_token });
  assert.equal(JSON.parse(r.body).error, 'invalid_grant');
  const ok = await tokenCall(h, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId });
  assert.equal(JSON.parse(ok.body).error, 'invalid_grant', 'the code was spent by the attempt without client_id');
});

// ---- S8: prototype keys as client_id ----

test('S8: client_id naming an Object.prototype key is an unknown client, not a 500', async () => {
  const h = await start();
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const r = await h.call('GET', `/authorize?${new URLSearchParams({ client_id: id, response_type: 'code' })}`);
    assert.equal(r.status, 400, id);
    assert.match(r.body, /unknown client_id/);
  }
});

// ---- S9: extraRedirectPrefixes boundary ----

test('S9: extraRedirectPrefixes match by origin and path segment, not by string prefix', () => {
  const opts = { allowLoopback: false, extraPrefixes: ['https://mcp.example.com/cb'] };
  assert.equal(redirectAllowed('https://mcp.example.com/cb', opts), true);
  assert.equal(redirectAllowed('https://mcp.example.com/cb/x?y=1', opts), true);
  assert.equal(redirectAllowed('https://mcp.example.com.evil.net/cb', opts), false);
  assert.equal(redirectAllowed('https://mcp.example.com/cbx', opts), false);
  assert.equal(redirectAllowed('https://mcp.example.com:8443/cb', opts), false);
  assert.equal(redirectAllowed('https://evil.net/cb', { allowLoopback: false, extraPrefixes: ['https://evil'] }), false);
});

// ---- S10: hand-edited config values ----

test('S10: only a literal true loosens redaction; non-array allowedOrigins is ignored', async () => {
  const device = {
    id: 'mac', name: 'mac', dnsName: 'mac.tail0000.ts.net', os: 'macOS', self: false, online: true, lastSeen: null,
    tailscaleIps: ['100.64.1.2'], lanIps: ['192.168.1.20'], routes: [], path: { type: 'direct', endpoint: '203.0.113.5:41641' },
    virt: null, pool: null, ports: null,
  };
  const withDevice: RemoteCore = { ...core, devices: async () => ({ ...(await core.devices()), devices: [device as any] }) };
  const h = await start({ core: withDevice }, { policy: { showAddresses: 'false', showProcesses: 1 }, allowedOrigins: 'https://evil.example.com', clients: {}, tokens: {} });
  const { clientId, code, verifier } = await grant(h);
  const t = JSON.parse((await tokenCall(h, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId })).body);
  const origin = await h.call('GET', '/.well-known/oauth-authorization-server', { headers: { origin: 'https://evil.example' } });
  assert.equal(origin.status, 403, 'a string is not a list (substring match)');
  const r = await h.call('POST', '/mcp', {
    headers: { authorization: `Bearer ${t.access_token}` },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_devices', arguments: {} } },
  });
  assert.equal(r.status, 200);
  const out = JSON.parse(r.body).result.content[0].text;
  assert.match(out, /routesSubnets/);
  assert.doesNotMatch(out, /tailscaleIps|100\.64\.1\.2|192\.168|203\.0\.113|endpoint/);
});

// ---- S11: issuer pinned at start ----

test('S11: the issuer read at start stays when remote.json loses publicUrl at runtime', async () => {
  const h = await start({ publicUrl: 'https://box.tail0000.ts.net:8443' });
  const meta = JSON.parse((await h.call('GET', '/.well-known/oauth-authorization-server', { headers: { host: 'box.tail0000.ts.net' } })).body);
  assert.equal(meta.issuer, 'https://box.tail0000.ts.net:8443');
});

// ---- S12: file and folder permissions, temp file ----

test('S12: ensurePrivate tightens the folder too; writes never follow a planted temp-file link', async () => {
  const dir = join(await tmp(), 'portboard');
  await mkdir(dir, { mode: 0o775 });
  await chmod(dir, 0o775);
  const s = new Store(join(dir, 'remote.json'));
  await s.registerClient('x', ['http://127.0.0.1:1/cb']);
  await chmod(s.path, 0o644);
  assert.equal(await s.ensurePrivate(), true);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(s.path)).mode & 0o777, 0o600);
  // The old temp name was remote.json.<pid>.tmp: a link planted there no longer receives the state.
  const victim = join(await tmp(), 'victim');
  await writeFile(victim, 'untouched');
  await symlink(victim, `${s.path}.${process.pid}.tmp`);
  await s.registerClient('y', ['http://127.0.0.1:1/cb']);
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(victim, 'utf8'), 'untouched');
});

// ---- S13: log line size ----

test('S13: tool names are truncated in the call log', async () => {
  const h = await start();
  const { clientId, code, verifier } = await grant(h);
  const t = JSON.parse((await tokenCall(h, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId })).body);
  await h.call('POST', '/mcp', { headers: { authorization: `Bearer ${t.access_token}` }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x'.repeat(5000) } } });
  const line = h.logs.find((l) => l.startsWith('call'))!;
  assert.ok(line.length < 200, line.slice(0, 100));
});

// ---- S14: paths outside /home ----

test('S14: scrubText replaces absolute system paths but leaves URL paths alone', () => {
  assert.equal(scrubText('Index of /srv/files/private'), 'Index of [path]');
  assert.equal(scrubText('serve → /var/www/html (nothing listening)'), 'serve → [path] (nothing listening)');
  assert.equal(scrubText('app (/opt/app/bin)'), 'app ([path])');
  assert.equal(scrubText('https://box.tail0000.ts.net:8443/srv/x'), 'https://box.tail0000.ts.net:8443/srv/x');
  assert.equal(scrubText('a/opt/b'), 'a/opt/b');
});

test('hashes only: no plain token in the lock-protected file after S6 rotation', async () => {
  const dir = await tmp();
  const s = new Store(join(dir, 'remote.json'));
  const t = await s.issueTokens({ id: 'c', name: 'c' }, 'r', 's');
  await s.takeRefreshToken(t.refresh);
  const raw = JSON.stringify(await s.read());
  assert.equal(raw.includes(t.refresh), false);
  assert.ok(raw.includes(sha256(t.refresh)));
});
