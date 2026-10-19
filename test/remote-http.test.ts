import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteHandler } from '../src/remote/http.ts';
import { Store } from '../src/remote/store.ts';
import type { RemoteCore } from '../src/remote/tools.ts';
import { L } from './fixtures/locale.ts';

let dir: string;
let server: Server;
let port: number;
let store: Store;
let fetchCalls: string[] = [];
const logs: string[] = [];

const core: RemoteCore = {
  snapshot: async () => ({
    at: 'now',
    host: { hostname: 'box', user: 'me' },
    tailscale: { available: true, dnsName: 'box.tail0000.ts.net', hostName: 'box', ips: [] } as any,
    ports: [
      {
        port: 8780, listening: true, scope: 'loopback', addresses: ['127.0.0.1'], owned: true, kind: 'app', container: null,
        processes: [{ pid: 99, cmdline: 'node /home/me/x.js', cwd: '~/x', project: 'x', unit: null, unitDescription: null }],
        name: 'acme', detectedName: 'acme', label: null, pinned: false, hidden: false, visible: true, probe: null, served: null,
        urls: { direct: null, served: 'https://box.tail0000.ts.net:8780/', ssh: 'ssh -N -L 8780:127.0.0.1:8780 me@box' },
        canExpose: false, exposeBlocker: null, control: { type: 'process', pids: [99] }, canRestart: false, canStop: true,
      },
    ],
  }),
  devices: async () => ({ at: 'now', pool: { available: false } as any, devices: [], proxmox: { configured: false, ok: false, hosts: [] } }),
  freePorts: async () => [3000],
  usage: async () => ({ at: 'now', observingSince: 'then', cards: [], local: { connections: 0, uses: [] }, byPort: {}, idleServices: 0 }) as any,
};

// CIMD documents served by a fake fetch
const CIMD: Record<string, unknown> = {
  'https://claude.ai/oauth/test-client': {
    client_id: 'https://claude.ai/oauth/test-client',
    client_name: 'Claude',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    token_endpoint_auth_method: 'none',
  },
  'https://chatgpt.com/oauth/liar.json': { client_id: 'https://chatgpt.com/oauth/other.json', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] },
};
const fakeFetch = (async (url: URL | string) => {
  fetchCalls.push(String(url));
  const doc = CIMD[String(url)];
  return new Response(doc ? JSON.stringify(doc) : 'nope', { status: doc ? 200 : 404 });
}) as typeof fetch;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'portboard-remote-'));
  store = new Store(join(dir, 'remote.json'));
  const handler = createRemoteHandler({
    core,
    store,
    hosts: new Set(['127.0.0.1', 'localhost', 'box.tail0000.ts.net']),
    log: (event, fields) => logs.push(`${event} ${JSON.stringify(fields)}`),
    fetchImpl: fakeFetch,
  });
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
});

after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(method: string, path: string, opts: { headers?: Record<string, string>; body?: string | object } = {}): Promise<Res> {
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
}

const form = (o: Record<string, string>) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});
const base = () => `http://127.0.0.1:${port}`;
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

/** register → consent → code → tokens, as claude.ai / ChatGPT would (with a loopback redirect). */
async function authorizeFlow(redirect = 'http://127.0.0.1:33418/callback') {
  const reg = await call('POST', '/register', { body: { client_name: 'test client', redirect_uris: [redirect] } });
  assert.equal(reg.status, 201, reg.body);
  const clientId = JSON.parse(reg.body).client_id;
  const { verifier, challenge } = pkce();
  const params = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st4te',
    resource: `${base()}/mcp`,
  };
  const page = await call('GET', `/authorize?${new URLSearchParams(params)}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /test client/);
  assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/);
  // a browser posts the form with a real Origin only if the page isn't no-referrer (no-referrer → `Origin: null`)
  assert.equal(page.headers['referrer-policy'], 'same-origin');
  assert.ok(!page.body.includes('no-referrer'), 'a no-referrer <meta> in the page overrides the header');
  const { code: approval } = await store.newApprovalCode();
  const f = form({ ...params, approval_code: approval.toLowerCase(), decision: 'approve' });
  const approved = await call('POST', '/authorize', { ...f, headers: { ...(f as any).headers, origin: base() } });
  assert.equal(approved.status, 302, approved.body);
  const loc = new URL(String(approved.headers.location));
  assert.equal(`${loc.origin}${loc.pathname}`, redirect);
  assert.equal(loc.searchParams.get('state'), 'st4te');
  assert.equal(loc.searchParams.get('iss'), base());
  const code = loc.searchParams.get('code')!;
  const tok = await call('POST', '/token', form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect, resource: `${base()}/mcp` }));
  assert.equal(tok.status, 200, tok.body);
  assert.equal(tok.headers['cache-control'], 'no-store');
  return { clientId, code, verifier, redirect, tokens: JSON.parse(tok.body) as { access_token: string; refresh_token: string; expires_in: number } };
}

const rpc = (token: string, msg: unknown, headers: Record<string, string> = {}) =>
  call('POST', '/mcp', { headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', ...headers }, body: msg as object });

test('discovery: 401 with resource_metadata, then RFC 9728 and RFC 8414 documents', async () => {
  const r = await call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'initialize' } });
  assert.equal(r.status, 401);
  assert.equal(r.headers['www-authenticate'], `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource/mcp", scope="portboard:read"`);

  const prm = JSON.parse((await call('GET', '/.well-known/oauth-protected-resource/mcp')).body);
  assert.equal(prm.resource, `${base()}/mcp`);
  assert.deepEqual(prm.authorization_servers, [base()]);

  for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
    const as = JSON.parse((await call('GET', p)).body);
    assert.equal(as.issuer, base());
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']);
    assert.equal(as.client_id_metadata_document_supported, true);
    assert.equal(as.authorization_response_iss_parameter_supported, true);
  }
});

test('end to end: DCR, approval code, PKCE, MCP calls, refresh rotation', async () => {
  const { clientId, code, verifier, redirect, tokens } = await authorizeFlow();
  assert.equal(tokens.expires_in, 3600);

  // the code is single use
  const again = await call('POST', '/token', form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect }));
  assert.equal(again.status, 400);
  assert.equal(JSON.parse(again.body).error, 'invalid_grant');

  const init = await rpc(tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.status, 200);
  assert.equal(JSON.parse(init.body).result.serverInfo.name, 'portboard-remote');
  assert.equal(init.headers['mcp-session-id'], undefined, 'stateless: no session id');

  const note = await rpc(tokens.access_token, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202);
  assert.equal(note.body, '');

  const list = await rpc(tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-protocol-version': '2025-06-18' });
  assert.deepEqual(JSON.parse(list.body).result.tools.map((t: any) => t.name).sort(), ['free_port', 'list_dev_servers', 'list_devices', 'list_ports', 'list_worktrees', 'memory_usage', 'who_uses_what']);

  const ports = await rpc(tokens.access_token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_ports', arguments: {} } });
  const text = JSON.parse(JSON.parse(ports.body).result.content[0].text);
  assert.equal(text.ports[0].control, 'process');
  assert.doesNotMatch(ports.body, /\/home\/|ssh -N|127\.0\.0\.1|pid/);

  const stop = await rpc(tokens.access_token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'stop_service', arguments: { port: 8780 } } });
  assert.deepEqual(JSON.parse(stop.body).error, { code: -32602, message: 'unknown tool: stop_service' });

  // batch, and SSE framing for clients that only accept event streams
  const batch = await rpc(tokens.access_token, [{ jsonrpc: '2.0', id: 5, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }]);
  assert.deepEqual(JSON.parse(batch.body), [{ jsonrpc: '2.0', id: 5, result: {} }]);
  const sse = await rpc(tokens.access_token, { jsonrpc: '2.0', id: 6, method: 'ping' }, { accept: 'text/event-stream' });
  assert.equal(sse.headers['content-type'], 'text/event-stream');
  assert.equal(sse.body, 'event: message\ndata: {"jsonrpc":"2.0","id":6,"result":{}}\n\n');

  // refresh: new pair, the old refresh token is dead
  const r1 = await call('POST', '/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }));
  assert.equal(r1.status, 200);
  const fresh = JSON.parse(r1.body);
  assert.notEqual(fresh.refresh_token, tokens.refresh_token);
  const r2 = await call('POST', '/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }));
  assert.equal(JSON.parse(r2.body).error, 'invalid_grant');
  assert.equal((await rpc(fresh.access_token, { jsonrpc: '2.0', id: 7, method: 'ping' })).status, 200);

  // secrets on disk are hashes only, file is private
  const raw = JSON.stringify(await store.read());
  for (const s of [tokens.access_token, tokens.refresh_token, fresh.access_token, fresh.refresh_token]) assert.equal(raw.includes(s), false);
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  // and never in the log
  for (const s of [tokens.access_token, fresh.refresh_token, code]) assert.equal(logs.join('\n').includes(s), false);
});

test('token is bound to the resource it was issued for', async () => {
  const { tokens } = await authorizeFlow();
  const other = await call('POST', '/mcp', {
    headers: { host: `localhost:${port}`, authorization: `Bearer ${tokens.access_token}` },
    body: { jsonrpc: '2.0', id: 1, method: 'ping' },
  });
  assert.equal(other.status, 401);
  assert.match(String(other.headers['www-authenticate']), /error="invalid_token"/);
});

test('wrong approval codes are refused, logged, limited per address, and burn the code after twenty tries', async () => {
  const reg = JSON.parse((await call('POST', '/register', { body: { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] } })).body);
  const { challenge } = pkce();
  const params = { response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: challenge, code_challenge_method: 'S256' };
  const from = (ip: string) => ({ host: `127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded', 'tailscale-funnel-request': '?1', 'x-forwarded-for': ip });
  const attempt = (ip: string, approval_code: string) =>
    call('POST', '/authorize', { headers: from(ip), body: new URLSearchParams({ ...params, approval_code, decision: 'approve' }).toString() });
  const { code } = await store.newApprovalCode();
  for (let i = 0; i < 5; i++) assert.equal((await attempt('198.51.100.20', 'AAAA-AAAA')).status, 401);
  assert.equal((await attempt('198.51.100.20', code)).status, 429, 'five wrong tries block that address, not the code');
  for (let i = 0; i < 15; i++) assert.equal((await attempt(`198.51.100.${30 + Math.floor(i / 5)}`, 'AAAA-AAAA')).status, 401);
  const late = await attempt('198.51.100.40', code);
  assert.equal(late.status, 401, 'the right code no longer works after twenty wrong ones from all addresses');
  assert.match(late.body, L(/유효한 승인 코드가 없습니다/, /There(&#39;|')s no valid approval code/));
  assert.ok(logs.some((l) => l.startsWith('auth-fail') && l.includes('wrong-code')));
  assert.equal(logs.join('\n').includes(code), false);

  const denied = await call('POST', '/authorize', form({ ...params, decision: 'deny', state: 's' }));
  assert.equal(denied.status, 302);
  const loc = new URL(String(denied.headers.location));
  assert.equal(loc.searchParams.get('error'), 'access_denied');
  assert.equal(loc.searchParams.get('iss'), base());
});

test('authorize: redirect allowlist, exact redirect match, PKCE S256 and resource are enforced', async () => {
  const evil = await call('POST', '/register', { body: { redirect_uris: ['https://evil.example/cb'] } });
  assert.equal(evil.status, 400);
  assert.equal(JSON.parse(evil.body).error, 'invalid_redirect_uri');

  const reg = JSON.parse((await call('POST', '/register', { body: { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] } })).body);
  const ok = { response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' };

  const wrongRedirect = await call('GET', `/authorize?${new URLSearchParams({ ...ok, redirect_uri: 'https://claude.ai/other' })}`);
  assert.equal(wrongRedirect.status, 400, 'unregistered redirect is shown as an error page, not redirected');
  assert.equal(wrongRedirect.headers.location, undefined);

  const plain = await call('GET', `/authorize?${new URLSearchParams({ ...ok, code_challenge_method: 'plain' })}`);
  assert.equal(plain.status, 302);
  assert.equal(new URL(String(plain.headers.location)).searchParams.get('error'), 'invalid_request');

  const target = await call('GET', `/authorize?${new URLSearchParams({ ...ok, resource: 'https://elsewhere.example/mcp' })}`);
  assert.equal(new URL(String(target.headers.location)).searchParams.get('error'), 'invalid_target');

  const unknown = await call('GET', `/authorize?${new URLSearchParams({ ...ok, client_id: 'pb_nope' })}`);
  assert.equal(unknown.status, 400);
});

test('CIMD: https client_id on an allowed host is fetched and checked; others are not fetched', async () => {
  fetchCalls = [];
  const { challenge } = pkce();
  const p = { response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: 'https://claude.ai/api/mcp/auth_callback' };
  const good = await call('GET', `/authorize?${new URLSearchParams({ ...p, client_id: 'https://claude.ai/oauth/test-client' })}`);
  assert.equal(good.status, 200);
  assert.match(good.body, /<b>Claude<\/b>/);

  const liar = await call('GET', `/authorize?${new URLSearchParams({ ...p, client_id: 'https://chatgpt.com/oauth/liar.json', redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect' })}`);
  assert.equal(liar.status, 400, 'client_id inside the document must equal its URL');

  const foreign = await call('GET', `/authorize?${new URLSearchParams({ ...p, client_id: 'https://evil.example/client.json' })}`);
  assert.equal(foreign.status, 400);
  assert.deepEqual(fetchCalls, ['https://claude.ai/oauth/test-client', 'https://chatgpt.com/oauth/liar.json'], 'no fetch to a host off the list');
});

test('Host and Origin checks (DNS rebinding)', async () => {
  assert.equal((await call('GET', '/.well-known/oauth-authorization-server', { headers: { host: 'evil.example' } })).status, 421);
  assert.equal((await call('GET', '/.well-known/oauth-authorization-server', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('GET', '/.well-known/oauth-authorization-server', { headers: { origin: 'null' } })).status, 403);
  assert.equal((await call('GET', '/.well-known/oauth-authorization-server', { headers: { origin: `http://127.0.0.1:${port}` } })).status, 200);
  assert.equal((await call('GET', '/.well-known/oauth-authorization-server', { headers: { origin: 'https://box.tail0000.ts.net' } })).status, 200);
});

test('Funnel requests: https issuer when no publicUrl is set, client address from X-Forwarded-For', async () => {
  const r = await call('GET', '/.well-known/oauth-protected-resource', { headers: { host: 'box.tail0000.ts.net', 'tailscale-funnel-request': '?1', 'x-forwarded-for': '198.51.100.7' } });
  assert.equal(JSON.parse(r.body).resource, 'https://box.tail0000.ts.net/mcp');
  await call('POST', '/mcp', { headers: { host: 'box.tail0000.ts.net', 'tailscale-funnel-request': '?1', 'x-forwarded-for': '198.51.100.7', authorization: 'Bearer nope' }, body: {} });
  assert.ok(logs.some((l) => l.includes('funnel:198.51.100.7') && l.includes('invalid-token')));
});

test('transport limits: GET /mcp 405, body cap 413, wrong content type 415, unknown protocol version 400', async () => {
  const { tokens } = await authorizeFlow();
  const auth = { authorization: `Bearer ${tokens.access_token}` };
  assert.equal((await call('GET', '/mcp', { headers: auth })).status, 405);
  assert.equal((await call('DELETE', '/mcp', { headers: auth })).status, 405);
  // without a token every method gets the 401 challenge first (claude.ai's first probe can be a GET)
  for (const m of ['GET', 'HEAD', 'DELETE', 'OPTIONS']) {
    const r = await call(m, '/mcp');
    assert.equal(r.status, 401, m);
    assert.match(String(r.headers.get?.('www-authenticate') ?? (r.headers as any)['www-authenticate']), /resource_metadata=/, m);
  }
  const big = await call('POST', '/mcp', { headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(70 * 1024) }) });
  assert.equal(big.status, 413);
  assert.equal((await call('POST', '/mcp', { headers: { ...auth, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await rpc(tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' })).status, 400);
  assert.equal((await call('POST', '/mcp', { headers: { ...auth, 'content-type': 'application/json' }, body: '{nope' })).status, 400);
});

test('repeated bad tokens from one address are rate-limited', async () => {
  const h = { host: 'box.tail0000.ts.net', 'tailscale-funnel-request': '?1', 'x-forwarded-for': '203.0.113.50' };
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await call('POST', '/mcp', { headers: { ...h, authorization: `Bearer guess${i}` }, body: {} })).status;
  assert.equal(last, 429);
  const other = await call('POST', '/mcp', { headers: { ...h, 'x-forwarded-for': '203.0.113.51', authorization: 'Bearer guess' }, body: {} });
  assert.equal(other.status, 401, 'other addresses are not affected');
  const spoofed = await call('POST', '/mcp', { headers: { ...h, 'x-forwarded-for': '1.2.3.4, 203.0.113.50', authorization: 'Bearer guess' }, body: {} });
  assert.equal(spoofed.status, 429, 'a client-supplied X-Forwarded-For prefix does not reset the limit');
});
