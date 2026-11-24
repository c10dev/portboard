// The desktop route of the accounts proxy (docs/accounts.md#desktop-route, src/core/accounts/intercept.ts and proxy.ts): the
// certificate, CONNECT on a real listener (127.0.0.1 port 0), the tunnel, the decrypted api.anthropic.com requests (relayed to a
// local fake with its own test certificate, or sent to the GPT lane with a fake Codex fetch). HOME, the config folders,
// accounts.json, the proxy key and the certificate files are mkdtemp paths. No real endpoint is called and no real ~/.claude
// or ~/.codex is read. Every token, the proxy key and the client's login are checked for in every output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import dns from 'node:dns';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { connect as netConnect, createServer as createNetServer, isIP, type AddressInfo, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect, createServer as createTlsServer, type TLSSocket } from 'node:tls';

// Safety net first (src/ is imported dynamically, after these lines).
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'pb-intercept-'));
globalThis.fetch = (() => {
  throw new Error('test reached the real fetch: inject one');
}) as typeof fetch;
// A name lookup means a socket is about to leave this machine (the relay's real target is api.anthropic.com): refuse every host
// name but localhost (IP literals need no lookup; a numeric form such as 127.1 is resolved by the system without the network), so a slip in a test fails here instead of reaching a real host.
const realLookup = dns.lookup;
(dns as { lookup: unknown }).lookup = ((host: string, ...rest: unknown[]) => {
  if (host !== 'localhost' && isIP(host) === 0 && !/^[0-9.]+$/.test(host)) throw new Error(`test reached a DNS lookup for ${host}: use 127.0.0.1 and interceptUpstream`);
  return (realLookup as (...a: unknown[]) => unknown)(host, ...rest);
}) as typeof dns.lookup;
process.env.HOME = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, 'claude-dir');
process.env.CODEX_HOME = join(FAKE_HOME, 'codex-dir');
for (const k of Object.keys(process.env)) if (k.startsWith('PORTBOARD_') && k !== 'PORTBOARD_LOCALE') delete process.env[k];
const FILE = join(FAKE_HOME, 'accounts.json');
const HOMES = join(FAKE_HOME, 'account-homes');
const CFG = join(FAKE_HOME, 'cfg');
const KEY_FILE = join(CFG, 'accounts-proxy.key');
const CERT_FILE = join(CFG, 'accounts-proxy-cert.pem');
const CERT_KEY_FILE = join(CFG, 'accounts-proxy-cert.key');
process.env.PORTBOARD_ACCOUNTS = FILE;
process.env.PORTBOARD_ACCOUNT_HOMES = HOMES;
process.env.PORTBOARD_ACCOUNTS_PROXY_KEY = KEY_FILE;
process.env.PORTBOARD_ACCOUNTS_PROXY_CERT = CERT_FILE;
process.env.PORTBOARD_ACCOUNTS_PROXY_CERT_KEY = CERT_KEY_FILE;

const { AccountsProxy, PROXY_REQUESTS } = await import('../src/core/accounts/proxy.ts');
const { INTERCEPT_HOST, loadOrMakeCert, makeSelfSignedCert } = await import('../src/core/accounts/intercept.ts');
const { resetRefreshForTest } = await import('../src/core/accounts/refresh.ts');
const { upsertAccount } = await import('../src/core/accounts/store.ts');
const { clearQuotaCache } = await import('../src/core/accounts/quota.ts');
const { PATHS } = await import('../src/core/paths.ts');
const { accountsConfig, SITE_DEFAULTS } = await import('../src/core/site.ts');
type Proxy = InstanceType<typeof AccountsProxy>;
type ProxyOptions = ConstructorParameters<typeof AccountsProxy>[0];
type UsageLine = import('../src/core/accounts/usage.ts').UsageLine;

const DAY = 86_400_000;
const FIX = join(import.meta.dirname, 'fixtures', 'accounts-gpt');
const CX = 'TESTTOKENCODEXA0123456789';
const ACCOUNT_ID = 'cx-account-aaaa';
const CLIENT_AUTH = 'Bearer sk-ant-oat01-CLIENTSECRET0123456789';
const REFRESH = 'sk-ant-ort01-TESTREFRESH0123456789';
const MARKERS = ['TESTTOKEN', 'TESTREFRESH', 'CLIENTSECRET', 'cx-account-'];
const iso = (ms: number) => new Date(ms).toISOString();

const logged: string[] = [];
const outputs: string[] = [];
const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
const cleanups: (() => void | Promise<void>)[] = [];
let proxy: Proxy | null = null;
let key = '';
const usage: UsageLine[] = [];
const codexCalls: { url: string; headers: Record<string, string>; body: Buffer }[] = [];

test.beforeEach(() => {
  resetRefreshForTest();
  clearQuotaCache();
  rmSync(FILE, { force: true });
  rmSync(HOMES, { recursive: true, force: true });
  rmSync(CFG, { recursive: true, force: true });
  logged.length = 0;
  outputs.length = 0;
  usage.length = 0;
  codexCalls.length = 0;
  for (const k of Object.keys(saved) as (keyof typeof saved)[]) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
});
test.afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await proxy?.close();
  Object.assign(console, saved);
  for (const o of [...outputs, ...logged, JSON.stringify(usage), JSON.stringify(proxy?.report() ?? '')]) {
    for (const m of MARKERS) assert.ok(!o.includes(m), `output holds ${m}`);
    if (key) assert.ok(!o.includes(key), 'output holds the proxy key');
  }
  proxy = null;
  key = '';
});

// ---- helpers ----

const codexFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  codexCalls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers as Record<string, string>)), body: Buffer.from((init?.body as Buffer | undefined) ?? Buffer.alloc(0)) });
  return new Response(readFileSync(join(FIX, 'stream-text-captured.sse')), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}) as typeof fetch;

function codexAccount(): void {
  upsertAccount({ provider: 'codex', alias: 'cx', identity: 'cx-ident-1', email: 'c@example.com', plan: 'plus', tokens: { access: CX, refresh: REFRESH, idToken: 'TESTTOKENIDTOKEN', expiresAt: iso(Date.now() + 100 * 3600_000) } }, { path: FILE, now: () => Date.now() });
}

interface Relayed {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}
/** A local HTTPS server with its own certificate for api.anthropic.com: the relay target */
async function startRelay() {
  const pair = makeSelfSignedCert(Date.now());
  const seen: Relayed[] = [];
  const server = createHttpsServer({ cert: pair.cert, key: pair.key }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': 'text/plain', 'x-relay': 'yes' });
      res.write('part-one;');
      setTimeout(() => res.end('part-two'), 30);
    });
  });
  const upgraded: Buffer[] = [];
  server.on('upgrade', (req, socket, head) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: head });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d: Buffer) => {
      upgraded.push(d);
      socket.write(Buffer.concat([Buffer.from('echo:'), d]));
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { seen, upgraded, ca: pair.cert, port: (server.address() as AddressInfo).port };
}

/** A TCP echo server */
async function startEcho(): Promise<{ port: number; server: NetServer }> {
  const sockets = new Set<Socket>();
  const server = createNetServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
    s.pipe(s);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return { port: (server.address() as AddressInfo).port, server };
}

async function start(extra: Partial<ProxyOptions> = {}, desktop = true): Promise<Proxy> {
  const home = { fetch: codexFetch, now: () => Date.now(), accountsPath: FILE, accountHomes: HOMES, home: FAKE_HOME, env: { CLAUDE_CONFIG_DIR: join(FAKE_HOME, 'c'), CODEX_HOME: join(FAKE_HOME, 'x') }, platform: 'linux' };
  proxy = new AccountsProxy({
    ...home,
    keyPath: KEY_FILE,
    certPath: CERT_FILE,
    certKeyPath: CERT_KEY_FILE,
    gpt: () => ({ enabled: true, models: { 'claude-haiku-5-5': 'gpt-6-astra' } }),
    appendUsage: async (line) => void usage.push(line),
    // a test that does not name a relay target must never reach the real api.anthropic.com
    interceptUpstream: { host: '127.0.0.1', port: 1 },
    ...extra,
  });
  await proxy.sync({ enabled: true, port: 0, desktop });
  key = await proxy.key();
  return proxy;
}
const portOf = () => proxy!.report().port;
const basic = (secret: string) => `Basic ${Buffer.from(`pb:${secret}`).toString('base64')}`;

interface Tunnel {
  status: number;
  head: string;
  socket: Socket;
  rest: Buffer;
}
/** Send CONNECT to the proxy and read the answer lines */
function connectVia(target: string, headers: Record<string, string> | null = { 'proxy-authorization': basic(key) }): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: '127.0.0.1', port: portOf() });
    let buf = Buffer.alloc(0);
    socket.on('error', reject);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const at = buf.indexOf('\r\n\r\n');
      if (at < 0) return;
      socket.off('data', onData);
      socket.pause();
      const head = buf.subarray(0, at).toString('latin1');
      outputs.push(head);
      resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0), head, socket, rest: buf.subarray(at + 4) });
    };
    socket.on('data', onData);
    socket.on('close', () => resolve({ status: 0, head: '', socket, rest: Buffer.alloc(0) }));
    const lines = Object.entries(headers ?? {}).map(([k, v]) => `${k}: ${v}\r\n`);
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${lines.join('')}\r\n`);
    cleanups.push(() => void socket.destroy());
  });
}

interface Got {
  status: number;
  headers: IncomingMessage['headers'];
  text: string;
}
/** Intercept: CONNECT api.anthropic.com:443, TLS with the proxy's certificate, then one HTTP request */
async function viaIntercept(method: string, path: string, body: string | Buffer | null, headers: Record<string, string> = {}, tunnel?: Tunnel): Promise<Got> {
  const cert = readFileSync(CERT_FILE, 'utf8');
  const t = tunnel ?? (await connectVia(`${INTERCEPT_HOST}:443`));
  assert.equal(t.status, 200);
  t.socket.resume();
  const tls = tlsConnect({ socket: t.socket, ca: cert, servername: INTERCEPT_HOST });
  await new Promise<void>((resolve, reject) => {
    tls.once('secureConnect', resolve);
    tls.once('error', reject);
  });
  // an agent that hands out the tunnel's TLS socket: the request must never open a connection of its own
  const agent = new HttpsAgent();
  (agent as unknown as { createConnection: () => Socket }).createConnection = () => tls as unknown as Socket;
  const req = httpsRequest({ host: INTERCEPT_HOST, path, method, agent, headers: { authorization: CLIENT_AUTH, 'user-agent': 'claude-cli/2.1.330', ...headers } });
  const answered = new Promise<IncomingMessage>((resolve, reject) => {
    req.on('response', resolve);
    req.on('error', reject);
  });
  req.end(body ?? undefined);
  const res = await answered;
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  outputs.push(text, JSON.stringify(res.headers));
  tls.destroy();
  return { status: res.statusCode ?? 0, headers: res.headers, text };
}

// ---- the certificate ----

test('makeSelfSignedCert: a parseable end-entity certificate for api.anthropic.com, valid about 825 days', () => {
  const now = Date.now();
  const { cert, key: pem } = makeSelfSignedCert(now);
  const x = new X509Certificate(cert);
  assert.equal(x.subjectAltName, 'DNS:api.anthropic.com');
  assert.equal(x.ca, false);
  assert.equal(x.subject, 'CN=api.anthropic.com');
  assert.equal(x.issuer, 'CN=api.anthropic.com');
  assert.ok(x.verify(x.publicKey), 'self-signed');
  assert.ok(x.checkPrivateKey(createPrivateKey(pem)));
  assert.match(x.keyUsage?.join(',') ?? '', /1\.3\.6\.1\.5\.5\.7\.3\.1/);
  const days = (Date.parse(x.validTo) - Date.parse(x.validFrom)) / DAY;
  assert.ok(Math.abs(days - 825) < 0.1, `validity ${days} days`);
  assert.ok(Math.abs(Date.parse(x.validFrom) - (now - 3_600_000)) < 2000, 'starts an hour back');
  assert.ok(!x.serialNumber.startsWith('8') && x.serialNumber.length >= 30, 'a long positive serial');
  assert.match(pem, /^-----BEGIN PRIVATE KEY-----/);
});

test('loadOrMakeCert: makes both files (0600) when missing, reads them back, and refuses loose, half, foreign, odd and expired pairs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-cert-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const certPath = join(dir, 'sub', 'c.pem');
  const keyPath = join(dir, 'sub', 'c.key');
  const made = await loadOrMakeCert({ certPath, keyPath });
  assert.equal(statSync(certPath).mode & 0o777, 0o600);
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  assert.deepEqual(await loadOrMakeCert({ certPath, keyPath }), made, 'a valid pair is read back, not replaced');
  assert.equal(logged.length, 0, 'no warning for a fresh pair');

  chmodSync(certPath, 0o644);
  await assert.rejects(loadOrMakeCert({ certPath, keyPath }), /certificate unusable/, 'a loose certificate');
  chmodSync(certPath, 0o600);
  chmodSync(keyPath, 0o640);
  await assert.rejects(loadOrMakeCert({ certPath, keyPath }), /certificate unusable/, 'a loose key');
  chmodSync(keyPath, 0o600);

  rmSync(keyPath);
  await assert.rejects(loadOrMakeCert({ certPath, keyPath }), /certificate unusable/, 'the key is missing');
  assert.equal(readFileSync(certPath, 'utf8'), made.cert, 'nothing was replaced');
  writeFileSync(keyPath, made.key, { mode: 0o600 });
  rmSync(certPath);
  await assert.rejects(loadOrMakeCert({ certPath, keyPath }), /certificate unusable/, 'the certificate is missing');

  // a key that is not this certificate's
  const other = makeSelfSignedCert(Date.now());
  writeFileSync(certPath, made.cert, { mode: 0o600 });
  writeFileSync(keyPath, other.key, { mode: 0o600 });
  await assert.rejects(loadOrMakeCert({ certPath, keyPath }), /certificate unusable/, 'a pair that does not match');

  // not a certificate
  writeFileSync(certPath, 'not a certificate', { mode: 0o600 });
  writeFileSync(keyPath, made.key, { mode: 0o600 });
  await assert.rejects(loadOrMakeCert({ certPath, keyPath }), /certificate unusable/, 'an odd file');

  // expired
  const old = makeSelfSignedCert(Date.now() - 1000 * DAY);
  writeFileSync(certPath, old.cert, { mode: 0o600 });
  writeFileSync(keyPath, old.key, { mode: 0o600 });
  await assert.rejects(loadOrMakeCert({ certPath, keyPath }), /certificate unusable/, 'an expired certificate');
  assert.equal(readFileSync(certPath, 'utf8'), old.cert, 'an expired pair is not replaced either');

  // 10 days left: kept, one warning
  const near = makeSelfSignedCert(Date.now() - 815 * DAY);
  writeFileSync(certPath, near.cert, { mode: 0o600 });
  writeFileSync(keyPath, near.key, { mode: 0o600 });
  assert.deepEqual(await loadOrMakeCert({ certPath, keyPath }), near);
  assert.deepEqual(await loadOrMakeCert({ certPath, keyPath }), near);
  const warnings = logged.filter((l) => l.includes('the desktop route certificate ends on'));
  assert.equal(warnings.length, 1, 'once per process');
  assert.match(warnings[0], /^\[portboard\] accounts proxy: the desktop route certificate ends on \d{4}-\d\d-\d\d; delete both files to make a new one, then restart the sessions$/);
});

test('a real TLS handshake: the certificate is trusted by name when it is the given CA, and not otherwise', async () => {
  const pair = makeSelfSignedCert(Date.now());
  const server = createTlsServer({ cert: pair.cert, key: pair.key }, (s) => s.end('hi'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => void server.close());
  const port = (server.address() as AddressInfo).port;
  const connectTo = (ca?: string) =>
    new Promise<TLSSocket>((resolve, reject) => {
      const s = tlsConnect({ host: '127.0.0.1', port, servername: INTERCEPT_HOST, ...(ca ? { ca } : {}) });
      s.once('secureConnect', () => resolve(s));
      s.once('error', reject);
    });
  const ok = await connectTo(pair.cert);
  assert.ok(ok.authorized);
  ok.destroy();
  await assert.rejects(connectTo(), /self-signed|unable to verify|SELF_SIGNED/i);
});

test('paths and accountsConfig carry the desktop route', () => {
  assert.equal(PATHS.accountsProxyCert, CERT_FILE);
  assert.equal(PATHS.accountsProxyCertKey, CERT_KEY_FILE);
  assert.deepEqual(SITE_DEFAULTS.accounts.proxy.desktop, { enabled: false });
  assert.deepEqual(accountsConfig(undefined).proxy.desktop, { enabled: false });
  assert.deepEqual(accountsConfig({ proxy: { desktop: { enabled: true } } }).proxy.desktop, { enabled: true });
  for (const desktop of [null, 'on', 5, [], true, { enabled: 'true' }, { enabled: 1 }, {}]) assert.deepEqual(accountsConfig({ proxy: { desktop } }).proxy.desktop, { enabled: false }, JSON.stringify(desktop));
});

// ---- CONNECT ----

test('connect: no key and a wrong key are 407 with Proxy-Authenticate; the right key (Basic, any user, or Bearer) is 200', async () => {
  await start();
  const echo = await startEcho();
  const target = `127.0.0.1:${echo.port}`;
  const none = await connectVia(target, {});
  assert.equal(none.status, 407);
  assert.match(none.head, /Proxy-Authenticate: Basic realm="portboard"/i);
  assert.equal((await connectVia(target, { 'proxy-authorization': basic('pbp-00000000000000000000000000000000') })).status, 407);
  assert.equal((await connectVia(target, { 'proxy-authorization': 'Basic !!!' })).status, 407);
  assert.equal((await connectVia(target, { 'proxy-authorization': `Basic ${Buffer.from(key).toString('base64')}` })).status, 407, 'no colon: no password');
  assert.equal((await connectVia(target, { 'proxy-authorization': basic(key) })).status, 200);
  assert.equal((await connectVia(target, { 'proxy-authorization': `Basic ${Buffer.from(`someone:${key}`).toString('base64')}` })).status, 200, 'any user name');
  assert.equal((await connectVia(target, { 'proxy-authorization': `Bearer ${key}` })).status, 200);
  assert.equal(proxy!.report().counts.requests, 3, 'only an authorized CONNECT counts');
  assert.deepEqual(proxy!.report().unproxied, [], 'no target is recorded');
});

test('connect: the route off is 403, an Origin header is 403, the proxy itself as target is 403, a bad target is 400', async () => {
  await start({}, false);
  const echo = await startEcho();
  assert.equal((await connectVia(`127.0.0.1:${echo.port}`)).status, 403, 'route off');
  assert.equal((await connectVia(`127.0.0.1:${echo.port}`, {})).status, 403, 'route off, no key');
  await proxy!.close();

  await start();
  assert.equal((await connectVia(`127.0.0.1:${echo.port}`, { 'proxy-authorization': basic(key), origin: 'http://evil.example' })).status, 403, 'Origin');
  assert.equal((await connectVia(`127.0.0.1:${portOf()}`)).status, 403, 'the proxy itself');
  assert.equal((await connectVia(`localhost:${portOf()}`)).status, 403, 'localhost: the proxy itself');
  for (const bad of ['nohost', 'host:0', 'host:65536', 'host:abc', 'a b:80', '[::1:80', '-x.example:80', 'host:']) assert.equal((await connectVia(bad)).status, 400, bad);
});

test('connect: a tunnel carries bytes both ways; an unreachable port is 502', async () => {
  await start();
  const echo = await startEcho();
  const t = await connectVia(`127.0.0.1:${echo.port}`);
  assert.equal(t.status, 200);
  assert.match(t.head, /^HTTP\/1\.1 200 Connection Established/);
  t.socket.resume();
  const got = new Promise<string>((resolve) => t.socket.once('data', (d) => resolve(d.toString())));
  t.socket.write('hello tunnel');
  assert.equal(await got, 'hello tunnel');

  const free = createNetServer();
  await new Promise<void>((resolve) => free.listen(0, '127.0.0.1', resolve));
  const closedPort = (free.address() as AddressInfo).port;
  await new Promise<void>((resolve) => free.close(() => resolve()));
  assert.equal((await connectVia(`127.0.0.1:${closedPort}`)).status, 502);
});

test('intercept: GET /api/oauth/profile reaches the relay with the client login and host unchanged; the answer streams back', async () => {
  const relay = await startRelay();
  await start({ interceptUpstream: { host: '127.0.0.1', port: relay.port, ca: relay.ca } });
  const r = await viaIntercept('GET', '/api/oauth/profile?x=1', null, { 'anthropic-beta': 'oauth-2025-04-20', cookie: 'a=b' });
  assert.equal(r.status, 200);
  assert.equal(r.text, 'part-one;part-two');
  assert.equal(r.headers['x-relay'], 'yes');
  assert.equal(relay.seen.length, 1);
  const s = relay.seen[0];
  assert.equal(s.method, 'GET');
  assert.equal(s.url, '/api/oauth/profile?x=1');
  assert.equal(s.headers.authorization, CLIENT_AUTH, 'the session login goes on as it came');
  assert.equal(s.headers.host, 'api.anthropic.com');
  assert.equal(s.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(s.headers.cookie, 'a=b');
  assert.equal(s.headers['proxy-authorization'], undefined, 'the proxy key never goes on');
  assert.equal(usage.length, 0, 'a relayed request is not a usage line');
  assert.equal(proxy!.report().counts.requests, 1, 'the CONNECT counted, the inner request did not');
  assert.equal(codexCalls.length, 0);
  // another Host is misdirected
  const t = await connectVia(`${INTERCEPT_HOST}:443`);
  const wrong = await viaIntercept('GET', '/x', null, { host: 'example.com' }, t);
  assert.equal(wrong.status, 421);
  assert.equal(relay.seen.length, 1);
});

test('intercept: POST /v1/messages with an unmapped model is relayed with the same body bytes; a failed relay is 502 with a closed text', async () => {
  const relay = await startRelay();
  await start({ interceptUpstream: { host: '127.0.0.1', port: relay.port, ca: relay.ca } });
  const body = Buffer.from(`{ "model" : "claude-sonnet-5-5", "messages": [], "pad":"é" }`);
  const r = await viaIntercept('POST', '/v1/messages?beta=true', body, { 'content-type': 'application/json' });
  assert.equal(r.status, 200);
  assert.equal(relay.seen.length, 1);
  assert.equal(relay.seen[0].url, '/v1/messages?beta=true');
  assert.ok(relay.seen[0].body.equals(body), 'same bytes');
  assert.equal(relay.seen[0].headers.authorization, CLIENT_AUTH);
  assert.equal(relay.seen[0].headers['content-length'], String(body.length));
  assert.equal(usage.length, 0);
  assert.equal(codexCalls.length, 0);
  await proxy!.close();

  // the lane off: the body streams, and the relay still gets it
  const relay2 = await startRelay();
  await start({ gpt: () => ({ enabled: false, models: {} }), interceptUpstream: { host: '127.0.0.1', port: relay2.port, ca: relay2.ca } });
  await viaIntercept('POST', '/v1/messages', body, { 'content-type': 'application/json' });
  assert.ok(relay2.seen[0].body.equals(body));
  await proxy!.close();

  // the relay target is down
  const free = createNetServer();
  await new Promise<void>((resolve) => free.listen(0, '127.0.0.1', resolve));
  const closedPort = (free.address() as AddressInfo).port;
  await new Promise<void>((resolve) => free.close(() => resolve()));
  await start({ interceptUpstream: { host: '127.0.0.1', port: closedPort, ca: relay.ca } });
  const down = await viaIntercept('GET', '/api/oauth/profile', null);
  assert.equal(down.status, 502);
  assert.deepEqual(JSON.parse(down.text), { type: 'error', error: { type: 'api_error', message: 'upstream request failed' } });
});

test('intercept: POST /v1/messages with a mapped model goes to the Codex address with the Codex account, never the client login; the client gets Anthropic SSE', async () => {
  const relay = await startRelay();
  codexAccount();
  await start({ interceptUpstream: { host: '127.0.0.1', port: relay.port, ca: relay.ca } });
  assert.ok(PROXY_REQUESTS.codex.origin === 'https://chatgpt.com');
  const request = JSON.parse(readFileSync(join(FIX, 'request-text.json'), 'utf8'));
  const sessionId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  const r = await viaIntercept('POST', '/v1/messages?beta=true', JSON.stringify({ ...request, model: 'claude-haiku-5-5' }), { 'content-type': 'application/json', 'x-claude-code-session-id': sessionId });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/event-stream');
  assert.match(r.text, /^event: message_start/);
  assert.equal(relay.seen.length, 0, 'nothing went to Anthropic');
  assert.equal(codexCalls.length, 1);
  assert.equal(codexCalls[0].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(codexCalls[0].headers.authorization, `Bearer ${CX}`);
  assert.equal(codexCalls[0].headers['session-id'], sessionId, 'the inner request headers give the session id');
  assert.ok(!JSON.stringify(codexCalls[0].headers).includes('CLIENTSECRET'));
  assert.equal(JSON.parse(codexCalls[0].body.toString('utf8')).model, 'gpt-6-astra');
  await until(() => usage.length >= 1);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].provider, 'codex');
  assert.equal(usage[0].model, 'gpt-6-astra');
  // count_tokens on the lane is an estimate and goes nowhere
  const c = await viaIntercept('POST', '/v1/messages/count_tokens', JSON.stringify({ ...request, model: 'claude-haiku-5-5' }), { 'content-type': 'application/json' });
  assert.equal(c.status, 200);
  assert.ok(Number.isInteger(JSON.parse(c.text).input_tokens));
  assert.equal(relay.seen.length, 0);
});

test('intercept: a WebSocket-style upgrade is piped to the relay target', async () => {
  const relay = await startRelay();
  await start({ interceptUpstream: { host: '127.0.0.1', port: relay.port, ca: relay.ca } });
  const t = await connectVia(`${INTERCEPT_HOST}:443`);
  t.socket.resume();
  const tls = tlsConnect({ socket: t.socket, ca: readFileSync(CERT_FILE, 'utf8'), servername: INTERCEPT_HOST });
  await new Promise<void>((resolve, reject) => {
    tls.once('secureConnect', resolve);
    tls.once('error', reject);
  });
  let buf = '';
  let opened: () => void = () => {};
  const upgraded = new Promise<void>((resolve) => (opened = resolve));
  const open = new Promise<void>((resolve) =>
    tls.on('data', (d: Buffer) => {
      buf += d.toString();
      if (buf.includes('\r\n\r\n')) opened();
      if (buf.includes('echo:ping')) resolve();
    }),
  );
  tls.write(`GET /ws HTTP/1.1\r\nHost: api.anthropic.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: ${CLIENT_AUTH}\r\nProxy-Foo: x\r\n\r\n`);
  await upgraded;
  tls.write('ping');
  await open;
  assert.match(buf, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.equal(relay.seen[0].url, '/ws');
  assert.equal(relay.seen[0].headers.authorization, CLIENT_AUTH);
  assert.equal(relay.seen[0].headers['proxy-foo'], undefined);
  assert.equal(relay.upgraded.map(String).join(''), 'ping');
  tls.destroy();
  assert.equal(usage.length, 0);
});

test('close() ends the open tunnels and the decrypted connections', async () => {
  const relay = await startRelay();
  await start({ interceptUpstream: { host: '127.0.0.1', port: relay.port, ca: relay.ca } });
  const echo = await startEcho();
  const plain = await connectVia(`127.0.0.1:${echo.port}`);
  plain.socket.resume();
  const inner = await connectVia(`${INTERCEPT_HOST}:443`);
  inner.socket.resume();
  const tls = tlsConnect({ socket: inner.socket, ca: readFileSync(CERT_FILE, 'utf8'), servername: INTERCEPT_HOST });
  await new Promise<void>((resolve, reject) => {
    tls.once('secureConnect', resolve);
    tls.once('error', reject);
  });
  tls.on('error', () => {});
  const closed = (s: Socket) => (s.destroyed ? Promise.resolve() : new Promise<void>((resolve) => s.once('close', () => resolve())));
  await proxy!.close();
  await Promise.race([Promise.all([closed(plain.socket), closed(inner.socket), closed(tls)]), new Promise((_, reject) => setTimeout(() => reject(new Error('sockets stayed open')), 3000))]);
});

test('connect: more than 32 tunnels work at once; the CONNECT beyond the tunnel limit is 503', async () => {
  await start();
  const echo = await startEcho();
  const tunnels: Tunnel[] = [];
  for (let i = 0; i < 40; i++) tunnels.push(await connectVia(`127.0.0.1:${echo.port}`));
  assert.ok(tunnels.every((t) => t.status === 200), '40 idle tunnels');
  // an ordinary request still works with 40 tunnels open
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: portOf(), path: '/nope', method: 'GET', agent: false, headers: { authorization: `Bearer ${key}` } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 404);
  await proxy!.close();

  await start({ maxTunnels: 3 });
  const held: Tunnel[] = [];
  for (let i = 0; i < 3; i++) held.push(await connectVia(`127.0.0.1:${echo.port}`));
  assert.ok(held.every((t) => t.status === 200));
  assert.equal((await connectVia(`127.0.0.1:${echo.port}`)).status, 503, 'one more than the limit');
  held[0].socket.destroy();
  await until(async () => (await connectVia(`127.0.0.1:${echo.port}`)).status === 200);
});

test('nothing secret is in the output: no proxy key, account token or client login in the console, usage lines or error bodies', async () => {
  const relay = await startRelay();
  codexAccount();
  await start({ interceptUpstream: { host: '127.0.0.1', port: relay.port, ca: relay.ca } });
  const request = JSON.parse(readFileSync(join(FIX, 'request-text.json'), 'utf8'));
  await viaIntercept('POST', '/v1/messages', JSON.stringify({ ...request, model: 'claude-haiku-5-5' }), { 'content-type': 'application/json' });
  await viaIntercept('GET', '/api/oauth/profile', null);
  assert.equal((await connectVia('127.0.0.1:1', { 'proxy-authorization': basic('wrong') })).status, 407);
  assert.equal((await connectVia('bad target')).status, 400);
  await until(() => usage.length >= 1);
  // the afterEach hook searches the outputs, the console and the usage lines
  assert.ok(outputs.length > 0);
  const probe = JSON.stringify(proxy!.report());
  assert.ok(!probe.includes('127.0.0.1:1'), 'no target in the report');
});

test('a bad certificate file closes the route: the state is error', async () => {
  mkdirSync(CFG, { recursive: true });
  const pair = makeSelfSignedCert(Date.now());
  writeFileSync(CERT_FILE, pair.cert, { mode: 0o644 });
  writeFileSync(CERT_KEY_FILE, pair.key, { mode: 0o600 });
  await start();
  assert.equal(proxy!.report().state, 'error');
  assert.match(logged.join('\n'), /accounts proxy: the desktop route certificate cannot be used/);
  await proxy!.close();

  rmSync(CFG, { recursive: true, force: true });
  await start();
  assert.equal(proxy!.report().state, 'listening');
  chmodSync(CERT_KEY_FILE, 0o644);
  await proxy!.sync({ enabled: true, port: 0, desktop: true });
  assert.equal(proxy!.report().state, 'error', 'the sync checks the pair again');
});

// ---- certificates the tool refuses (made with the openssl tool, in the test only) ----

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('loadOrMakeCert: a certificate for another name, a CA, or one with extra names is refused', { skip: !hasOpenssl && 'openssl not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-cert-bad-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const certPath = join(dir, 'c.pem');
  const keyPath = join(dir, 'c.key');
  const build = (...addext: string[]) => {
    const args = ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyPath, '-out', certPath, '-subj', '/CN=api.anthropic.com', '-days', '30'];
    for (const a of addext) args.push('-addext', a);
    execFileSync('openssl', args, { stdio: 'ignore', env: { PATH: process.env.PATH ?? '' } });
    chmodSync(certPath, 0o600);
    chmodSync(keyPath, 0o600);
  };
  build('subjectAltName=DNS:example.com');
  await assert.rejects(loadOrMakeCert({ certPath, keyPath }), /certificate unusable/, 'another name');
  build('subjectAltName=DNS:api.anthropic.com,DNS:example.com');
  await assert.rejects(loadOrMakeCert({ certPath, keyPath }), /certificate unusable/, 'an extra name');
  build('subjectAltName=DNS:api.anthropic.com', 'basicConstraints=critical,CA:TRUE');
  await assert.rejects(loadOrMakeCert({ certPath, keyPath }), /certificate unusable/, 'a CA');
  build('subjectAltName=DNS:api.anthropic.com', 'basicConstraints=critical,CA:FALSE');
  assert.ok((await loadOrMakeCert({ certPath, keyPath })).cert, 'the same shape without those is read');
});

// ---- the key, refused sockets, time limits, limits ----

/** Wait for a condition (polled every 10 ms, 4 seconds at most) */
async function until(cond: () => boolean | Promise<boolean>, what = 'the condition'): Promise<void> {
  const end = Date.now() + 4000;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const closedOf = (s: Socket): Promise<void> => (s.destroyed ? Promise.resolve() : new Promise<void>((resolve) => s.once('close', () => resolve())));
const within = <T>(p: Promise<T>, what: string): Promise<T> => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), 4000))]);

/** An intercepted connection that stays open: CONNECT, then TLS with the proxy's certificate */
async function openIntercept(): Promise<{ tunnel: Tunnel; tls: TLSSocket }> {
  const tunnel = await connectVia(`${INTERCEPT_HOST}:443`);
  assert.equal(tunnel.status, 200);
  tunnel.socket.resume();
  const tls = tlsConnect({ socket: tunnel.socket, ca: readFileSync(CERT_FILE, 'utf8'), servername: INTERCEPT_HOST });
  tls.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    tls.once('secureConnect', resolve);
    tls.once('error', reject);
  });
  return { tunnel, tls };
}

test('a key change closes what the old key opened: intercepted connections, tunnels; the old key gets 407', async () => {
  const relay = await startRelay();
  await start({ interceptUpstream: { host: '127.0.0.1', port: relay.port, ca: relay.ca } });
  const echo = await startEcho();
  const oldKey = key;
  const inner = await openIntercept();
  const idle = await connectVia(`127.0.0.1:${echo.port}`);
  idle.socket.resume();
  await proxy!.key(true);
  await within(Promise.all([closedOf(inner.tls), closedOf(inner.tunnel.socket), closedOf(idle.socket)]), 'the old connections close');
  // a request on the old connection fails
  const agent = new HttpsAgent();
  (agent as unknown as { createConnection: () => Socket }).createConnection = () => inner.tls as unknown as Socket;
  const req = httpsRequest({ host: INTERCEPT_HOST, path: '/api/oauth/profile', method: 'GET', agent });
  const outcome = await Promise.race([
    new Promise<string>((resolve) => {
      req.on('response', () => resolve('answered'));
      req.on('error', () => resolve('failed'));
      req.end();
    }),
    new Promise<string>((resolve) => setTimeout(() => resolve('no answer'), 500)),
  ]);
  assert.notEqual(outcome, 'answered', 'a request on the old connection gets no answer');
  assert.equal(relay.seen.length, 0);
  // the old key opens nothing new, the new one does
  key = await proxy!.key();
  assert.notEqual(key, oldKey);
  assert.equal((await connectVia(`127.0.0.1:${echo.port}`, { 'proxy-authorization': basic(oldKey) })).status, 407);
  assert.equal((await connectVia(`127.0.0.1:${echo.port}`)).status, 200);
  const fresh = await openIntercept();
  fresh.tls.destroy();
  // an edited key file closes them within the next sync, too
  const second = await connectVia(`127.0.0.1:${echo.port}`);
  second.socket.resume();
  writeFileSync(KEY_FILE, `pbp-${'ab'.repeat(16)}\n`, { mode: 0o600 });
  await proxy!.sync({ enabled: true, port: 0, desktop: true });
  await within(closedOf(second.socket), 'a connection of the key before the edit closes');
  key = `pbp-${'ab'.repeat(16)}`;
  assert.equal((await connectVia(`127.0.0.1:${echo.port}`)).status, 200);
  // turning the route off closes every connection
  const third = await connectVia(`127.0.0.1:${echo.port}`);
  third.socket.resume();
  await proxy!.sync({ enabled: true, port: 0, desktop: false });
  await within(closedOf(third.socket), 'the route off closes the connections');
});

test('refused CONNECT sockets are closed by the proxy, whether the sender closes or not', async () => {
  for (const [desktop, extra] of [[false, {}], [true, { maxTunnels: 3 }]] as const) {
    await start(extra, desktop);
    const refused: Tunnel[] = [];
    for (let i = 0; i < 40; i++) refused.push(await connectVia('127.0.0.1:9', desktop ? {} : { 'proxy-authorization': basic(key) }));
    assert.ok(refused.every((t) => t.status === (desktop ? 407 : 403)));
    await within(Promise.all(refused.map((t) => closedOf(t.socket))), 'the refused sockets close');
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: portOf(), path: '/nope', method: 'GET', agent: false, headers: { authorization: `Bearer ${key}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 404, `an ordinary request still answers (route ${desktop ? 'on' : 'off'})`);
    await proxy!.close();
  }
});

test('a tunnel to the proxy itself by another name or form is 403: 0.0.0.0, 127.1, an IPv4-mapped address', async () => {
  await start();
  const port = portOf();
  for (const host of ['0.0.0.0', '127.1', '[::ffff:127.0.0.1]']) assert.equal((await connectVia(`${host}:${port}`)).status, 403, host);
  assert.equal((await connectVia(`127.0.0.1:${port}`)).status, 403);
});

test('a decrypted connection that sends half a request is closed; an idle one is closed after its wait; a request in progress has no limit', async () => {
  const relay = await startRelay();
  await start({ interceptHeadersMs: 150, interceptIdleMs: 200, interceptUpstream: { host: '127.0.0.1', port: relay.port, ca: relay.ca } });
  const half = await openIntercept();
  half.tls.write('GET /api/oauth/pro');
  await within(closedOf(half.tls), 'half a request line is cut off');
  const none = await openIntercept();
  await within(closedOf(none.tls), 'no request at all is cut off');
  // one whole request, then silence: kept for the idle wait, then closed
  const kept = await openIntercept();
  let seen = '';
  kept.tls.on('data', (d: Buffer) => (seen += d.toString()));
  kept.tls.write('GET /api/oauth/profile HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n');
  await until(() => seen.includes('part-two'), 'the answer');
  assert.equal(kept.tls.destroyed, false);
  await within(closedOf(kept.tls), 'an idle connection closes');
});

test('decrypted lane requests share the limit of plain requests; relayed requests do not', async () => {
  const relay = await startRelay();
  codexAccount();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const slow = (async (url: string | URL | Request, init?: RequestInit) => {
    await held;
    return codexFetch(url, init);
  }) as typeof fetch;
  cleanups.push(() => release());
  await start({ fetch: slow, maxPlainRequests: 1, interceptUpstream: { host: '127.0.0.1', port: relay.port, ca: relay.ca } });
  const request = JSON.stringify({ ...JSON.parse(readFileSync(join(FIX, 'request-text.json'), 'utf8')), model: 'claude-haiku-5-5' });
  const first = viaIntercept('POST', '/v1/messages', request, { 'content-type': 'application/json' });
  first.catch(() => {});
  await until(() => (proxy as unknown as { plain: Set<unknown> }).plain.size === 1, 'the first lane request is open');
  const second = await viaIntercept('POST', '/v1/messages', request, { 'content-type': 'application/json' });
  assert.equal(second.status, 503);
  assert.deepEqual(JSON.parse(second.text), { type: 'error', error: { type: 'api_error', message: 'too many requests' } });
  assert.equal((await viaIntercept('GET', '/api/oauth/profile', null)).status, 200, 'a relayed request is not counted');
  release();
  assert.equal((await first).status, 200);
  await until(() => (proxy as unknown as { plain: Set<unknown> }).plain.size === 0, 'the slot is free');
  assert.equal((await viaIntercept('POST', '/v1/messages', request, { 'content-type': 'application/json' })).status, 200);
});

test('the open plain requests are a set: a stop while one hangs does not lower the limit of the next listener', async () => {
  await start({ maxPlainRequests: 2 });
  const open = (): ReturnType<typeof httpRequest> => {
    const req = httpRequest({ host: '127.0.0.1', port: portOf(), path: '/v1/messages', method: 'POST', agent: false, headers: { authorization: `Bearer ${key}`, 'content-length': '100' } });
    req.on('error', () => {});
    req.write('x');
    cleanups.push(() => void req.destroy());
    return req;
  };
  const size = () => (proxy as unknown as { plain: Set<unknown> }).plain.size;
  open();
  open();
  await until(() => size() === 2, 'two requests open');
  await proxy!.sync({ enabled: false, port: 0 });
  await proxy!.sync({ enabled: true, port: 0, desktop: true });
  assert.equal(size(), 0);
  open();
  open();
  await until(() => size() === 2, 'two requests open again');
  const status = await within(
    new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: portOf(), path: '/nope', method: 'GET', agent: false, headers: { authorization: `Bearer ${key}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    }),
    'the third request is answered',
  );
  assert.equal(status, 503);
});
