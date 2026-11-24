// The desktop route of the accounts proxy (docs/accounts.md#desktop-route): the proxy listener also takes HTTP CONNECT. A
// Claude Code session whose settings.json `env` sets HTTPS_PROXY (with the proxy key) and NODE_EXTRA_CA_CERTS (this file's
// certificate) reaches Portboard even where ANTHROPIC_BASE_URL is forced, as the desktop app's Code tab does.
//
//   - Only api.anthropic.com:443 is decrypted, with a self-signed end-entity certificate (not a CA) for that name alone. The
//     key and the certificate are in the config folder (0600) and are made by node:crypto: no openssl call, no dependency.
//     Portboard never edits settings.json, never installs the certificate anywhere and never replaces a valid pair by itself.
//   - Every other CONNECT target is a plain TCP tunnel: its bytes are not read and its host name is not recorded.
//   - A decrypted /v1/messages request for a model the GPT lane takes goes to the lane (proxy.ts). Every other request is
//     relayed to the real api.anthropic.com unchanged, with the session's own login. It is the session's own request: no
//     account pool, no rewrite, no usage line.
//   - Trust model: the certificate is trusted only by processes that were started with NODE_EXTRA_CA_CERTS pointing at it.
//     CONNECT needs the proxy key, and a request with an Origin header is refused. The listener stays on 127.0.0.1.
//   - Through the route Portboard holds the session's requests in clear text (its claude.ai token too) in memory for the relay
//     and writes none of it anywhere.
//
// No code is copied from other projects. No token, key, header value, body, query string or tunnel host name is written to a
// log, an event or an answer.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { stat, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { connect as tlsConnect, createSecureContext, TLSSocket, type SecureContext } from 'node:tls';
import { writePrivate } from '../atomic.ts';

export const INTERCEPT_HOST = 'api.anthropic.com';
const CERT_DAYS = 825;
const WARN_DAYS = 30;
const DAY_MS = 86_400_000;
const CONNECT_TIMEOUT_MS = 10_000;

// ---- the certificate ----

const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const seq = (...p: Buffer[]) => der(0x30, ...p);
const oid = (dotted: string): Buffer => {
  const a = dotted.split('.').map(Number);
  const out: number[] = [a[0] * 40 + a[1]];
  for (const n of a.slice(2)) {
    const bytes = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) bytes.unshift((v & 0x7f) | 0x80);
    out.push(...bytes);
  }
  return der(0x06, Buffer.from(out));
};
const utcTime = (ms: number): Buffer => der(0x17, Buffer.from(new Date(ms).toISOString().replace(/^\d\d(\d\d)-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)\.\d+Z$/, '$1$2$3$4$5$6Z')));
const name = der(0x30, der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from(INTERCEPT_HOST)))));
const SIG_ALG = seq(oid('1.2.840.10045.4.3.2'));
const extension = (id: string, value: Buffer, critical = false): Buffer => seq(oid(id), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));
const pem = (label: string, body: Buffer): string => `-----BEGIN ${label}-----\n${(body.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`;

/** An X.509 v3 certificate for api.anthropic.com (P-256, end entity, serverAuth), built with node:crypto only (exported for tests) */
export function makeSelfSignedCert(now: number): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const serial = randomBytes(16);
  // a positive, minimal DER integer: the high bit is cleared and the first byte is not zero
  serial[0] = (serial[0] & 0x7f) || 1;
  // the key id is the SHA-1 of the public key bit string: for P-256 these are the last 65 bytes of the SPKI (the point)
  const keyId = createHash('sha1').update(spki.subarray(spki.length - 65)).digest();
  const extensions = seq(
    extension('2.5.29.19', seq(), true),
    extension('2.5.29.15', der(0x03, Buffer.from([0x07, 0x80])), true),
    extension('2.5.29.37', seq(oid('1.3.6.1.5.5.7.3.1'))),
    extension('2.5.29.17', seq(der(0x82, Buffer.from(INTERCEPT_HOST)))),
    extension('2.5.29.14', der(0x04, keyId)),
  );
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), SIG_ALG, name, seq(utcTime(now - 3_600_000), utcTime(now + CERT_DAYS * DAY_MS)), name, spki, der(0xa3, extensions));
  const signature = sign('sha256', tbs, privateKey);
  const cert = seq(tbs, SIG_ALG, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return { cert: pem('CERTIFICATE', cert), key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

const warned = new Set<string>();

async function statOf(path: string) {
  try {
    return await stat(path);
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') return null;
    throw new Error('certificate unusable');
  }
}

/**
 * Read the certificate and key, or make them when both are missing. A loose or odd file, one missing half, a certificate for
 * another name, a pair that does not match and an expired certificate throw `certificate unusable`. A valid pair is never
 * replaced here: running sessions trust only the certificate they read at start. The owner makes a new pair by deleting both.
 */
export async function loadOrMakeCert(o: { certPath: string; keyPath: string; now?: () => number }): Promise<{ cert: string; key: string }> {
  const now = o.now ?? Date.now;
  const [cs, ks] = await Promise.all([statOf(o.certPath), statOf(o.keyPath)]);
  if (!cs && !ks) {
    const made = makeSelfSignedCert(now());
    await writePrivate(o.keyPath, made.key);
    await writePrivate(o.certPath, made.cert);
    return made;
  }
  if (!cs || !ks || !cs.isFile() || !ks.isFile() || (cs.mode & 0o077) !== 0 || (ks.mode & 0o077) !== 0) throw new Error('certificate unusable');
  const [cert, key] = await Promise.all([readFile(o.certPath, 'utf8'), readFile(o.keyPath, 'utf8')]);
  try {
    const x = new X509Certificate(cert);
    const ends = Date.parse(x.validTo);
    const names = x.subjectAltName?.split(',').map((n) => n.trim()) ?? [];
    if (x.ca || names.length === 0 || !names.every((n) => n === `DNS:${INTERCEPT_HOST}`) || !x.verify(x.publicKey) || !x.checkPrivateKey(createPrivateKey(key)) || !(ends > now())) {
      throw new Error('certificate unusable');
    }
    if (ends - now() <= WARN_DAYS * DAY_MS && !warned.has(x.fingerprint256)) {
      warned.add(x.fingerprint256);
      console.error(`[portboard] accounts proxy: the desktop route certificate ends on ${new Date(ends).toISOString().slice(0, 10)}; delete both files to make a new one, then restart the sessions`);
    }
  } catch {
    throw new Error('certificate unusable');
  }
  return { cert, key };
}

// ---- CONNECT ----

/** What the proxy gives the route */
export interface RouteDeps {
  /** the route is on right now */
  enabled(): boolean;
  /** the port the listener is bound to */
  boundPort(): number;
  /** the key hash in use when the secret is the proxy key, else null: a socket is tied to the hash it was accepted with */
  authorize(secret: string): Buffer | null;
  /** an authorized CONNECT arrived */
  counted(): void;
  /** the certificate and key, or null before they are loaded */
  cert(): { cert: string; key: string } | null;
  /** CONNECT sockets open at once, at most */
  maxTunnels: number;
  /** the relay target (tests: a local server) */
  upstream: { host: string; port: number; ca?: string };
  /** a decrypted connection has this long, from its handshake, to send the complete headers of its first request */
  headersTimeoutMs: number;
  /** after each answer, the next request's complete headers must arrive within this long (idle time included) */
  idleMs: number;
  /**
   * The GPT lane for a decrypted request. `taken: true`: it answered (or the caller left). `taken: false`: not for the lane;
   * `body` is the body when it was read (a POST /v1/messages* with the lane on), else null and the request streams on.
   */
  lane(req: IncomingMessage, res: ServerResponse): Promise<{ taken: true } | { taken: false; body: Buffer | null }>;
  /** the proxy waits for this work when it closes */
  track(p: Promise<unknown>): void;
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::|0\.0\.0\.0)$/;
/** a loopback or unspecified address, in any of the forms a socket reports (IPv4-mapped ones too) */
const isLoopback = (addr: string | undefined): boolean => LOOPBACK.test((addr ?? '').toLowerCase().replace(/^::ffff:/, ''));

/** Answer a refused CONNECT and close its socket: the answer is written, then the socket is destroyed once it has flushed (or after a second) */
export function refuseSocket(socket: Socket, status: string, extra = ''): void {
  const timer = setTimeout(() => socket.destroy(), 1000);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
  socket.end(`HTTP/1.1 ${status}\r\n${extra}Content-Length: 0\r\n\r\n`, () => socket.destroy());
}

const HOP = new Set(['connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const skipped = (k: string) => HOP.has(k) || k.startsWith('proxy-');
const DNS_NAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const MISDIRECTED = { type: 'error', error: { type: 'invalid_request_error', message: 'misdirected request' } };
const UPSTREAM = { type: 'error', error: { type: 'api_error', message: 'upstream request failed' } };

/** `host:port` of a CONNECT line; host without the brackets of an IPv6 literal. null for anything else. */
function parseTarget(url: string | undefined): { host: string; port: number } | null {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+):(\d{1,5})$/.exec(url ?? '');
  if (!m) return null;
  const port = Number(m[2]);
  const host = m[1].startsWith('[') ? m[1].slice(1, -1) : m[1];
  if (port < 1 || port > 65535) return null;
  if (m[1].startsWith('[') ? isIP(host) !== 6 : !DNS_NAME.test(host)) return null;
  return { host, port };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export class DesktopRoute {
  private readonly deps: RouteDeps;
  /** every CONNECT socket that was accepted, and the sockets made for them */
  private readonly tunnels = new Set<Socket>();
  private readonly sockets = new Set<Socket>();
  /** every socket made for an accepted CONNECT, with the key hash the CONNECT was authorized with */
  private readonly owned = new Map<Socket, Buffer>();
  /** the timers of a decrypted connection */
  private readonly timers = new Map<Socket, { header?: NodeJS.Timeout; idle?: NodeJS.Timeout; open: number }>();
  private readonly inner: Server;
  private readonly agent: HttpsAgent;
  private context: { cert: string; ctx: SecureContext } | null = null;

  constructor(deps: RouteDeps) {
    this.deps = deps;
    const { upstream } = deps;
    this.agent = new HttpsAgent({ keepAlive: true, ...(upstream.ca ? { ca: upstream.ca } : {}) });
    // one http server for every decrypted connection: it never listens, the route hands it the TLS sockets
    this.inner = createServer((req, res) => {
      this.began(req.socket as Socket, res);
      deps.track(
        this.serve(req, res).catch(() => {
          if (!res.headersSent) sendJson(res, 502, UPSTREAM);
          else res.destroy();
        }),
      );
    });
    // the route's own timers (watch, began) do the header and idle timing. Node's header check needs a listening server, and its
    // keep-alive timer (5 s by default) would end an idle connection long before `idleMs`: both are off here
    this.inner.requestTimeout = 0;
    this.inner.keepAliveTimeout = 0;
    this.inner.on('upgrade', (req, socket, head) => {
      this.clearTimers(socket as Socket);
      this.upgrade(req, socket as Socket, head);
    });
  }

  /** CONNECT sockets open now */
  tunnelCount(): number {
    return this.tunnels.size;
  }

  /** Close every socket that was accepted with another key hash than `hash` (all of them for null): a key change ends what the old key opened */
  revoke(hash: Buffer | null): void {
    for (const [s, h] of [...this.owned]) if (hash === null || !h.equals(hash)) s.destroy();
  }

  private own(s: Socket, hash: Buffer): void {
    this.owned.set(s, hash);
    s.once('close', () => this.owned.delete(s));
  }

  private clearTimers(s: Socket): void {
    const t = this.timers.get(s);
    if (!t) return;
    clearTimeout(t.header);
    clearTimeout(t.idle);
    this.timers.delete(s);
  }

  /** The time limits of a decrypted connection: the first request's headers within `headersTimeoutMs` of the handshake, none while a request or its answer is in progress, and after each answer the next request's complete headers within `idleMs` */
  private watch(tls: Socket): void {
    const t: { header?: NodeJS.Timeout; idle?: NodeJS.Timeout; open: number } = { open: 0 };
    this.timers.set(tls, t);
    t.header = setTimeout(() => tls.destroy(), this.deps.headersTimeoutMs);
    tls.once('close', () => this.clearTimers(tls));
  }

  /** A request began on a decrypted connection: no clock runs until its answer is done */
  private began(tls: Socket, res: ServerResponse): void {
    const t = this.timers.get(tls);
    if (!t) return;
    clearTimeout(t.header);
    clearTimeout(t.idle);
    t.header = undefined;
    t.idle = undefined;
    // pipelined requests overlap: the idle clock starts only when the last open one has its answer
    t.open++;
    res.once('close', () => {
      if (tls.destroyed || this.timers.get(tls) !== t) return;
      t.open = Math.max(0, t.open - 1);
      if (t.open === 0) t.idle = setTimeout(() => tls.destroy(), this.deps.idleMs);
    });
  }

  /** End every tunnel and every decrypted connection */
  closeAll(): void {
    for (const s of [...this.tunnels, ...this.sockets, ...this.owned.keys()]) s.destroy();
    this.tunnels.clear();
    this.sockets.clear();
    this.owned.clear();
    for (const s of [...this.timers.keys()]) this.clearTimers(s);
    this.inner.closeAllConnections();
    this.agent.destroy();
  }

  private refuse(socket: Socket, status: string, extra = ''): void {
    refuseSocket(socket, status, extra);
  }

  /** The key hash the CONNECT was authorized with, or null */
  private authorized(req: IncomingMessage): Buffer | null {
    const auth = req.headers['proxy-authorization'];
    if (typeof auth !== 'string') return null;
    const basic = /^basic +(\S+)$/i.exec(auth.trim());
    if (basic) {
      const text = Buffer.from(basic[1], 'base64').toString('utf8');
      const i = text.indexOf(':');
      return i >= 0 ? this.deps.authorize(text.slice(i + 1)) : null;
    }
    const bearer = /^bearer +(\S+)$/i.exec(auth.trim());
    return bearer ? this.deps.authorize(bearer[1]) : null;
  }

  /** The `connect` event of the listener */
  connect(req: IncomingMessage, socket: Socket, head: Buffer): void {
    socket.on('error', () => {});
    const d = this.deps;
    if (!d.enabled() || req.headers.origin !== undefined) return this.refuse(socket, '403 Forbidden');
    const hash = this.authorized(req);
    if (!hash) return this.refuse(socket, '407 Proxy Authentication Required', 'Proxy-Authenticate: Basic realm="portboard"\r\n');
    d.counted();
    if (this.tunnels.size >= d.maxTunnels) return this.refuse(socket, '503 Service Unavailable');
    const target = parseTarget(req.url);
    if (!target) return this.refuse(socket, '400 Bad Request');
    const own = d.boundPort();
    if (target.port === own && (target.host.toLowerCase() === '127.0.0.1' || target.host.toLowerCase() === 'localhost')) return this.refuse(socket, '403 Forbidden');
    this.tunnels.add(socket);
    socket.once('close', () => this.tunnels.delete(socket));
    this.own(socket, hash);
    if (target.host.toLowerCase() === INTERCEPT_HOST && target.port === 443) return this.intercept(socket, head, hash);
    this.tunnel(socket, head, target, hash);
  }

  private tunnel(socket: Socket, head: Buffer, target: { host: string; port: number }, hash: Buffer): void {
    const up = netConnect({ host: target.host, port: target.port });
    this.sockets.add(up);
    this.own(up, hash);
    let answered = false;
    up.on('close', () => {
      this.sockets.delete(up);
      // before the answer, the refusal closes the client's socket itself
      if (answered) socket.destroy();
    });
    socket.once('close', () => up.destroy());
    const timer = setTimeout(() => up.destroy(new Error('timeout')), CONNECT_TIMEOUT_MS);
    up.on('error', () => {
      clearTimeout(timer);
      if (!answered) this.refuse(socket, '502 Bad Gateway');
      else socket.destroy();
      up.destroy();
    });
    up.once('connect', () => {
      clearTimeout(timer);
      // the address the socket reached, not the name that was asked for, tells whether the target is the proxy itself
      if (up.remotePort === this.deps.boundPort() && isLoopback(up.remoteAddress)) {
        up.destroy();
        return this.refuse(socket, '403 Forbidden');
      }
      answered = true;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    });
  }

  private intercept(socket: Socket, head: Buffer, hash: Buffer): void {
    const pair = this.deps.cert();
    if (!pair) return this.refuse(socket, '502 Bad Gateway');
    try {
      if (this.context?.cert !== pair.cert) this.context = { cert: pair.cert, ctx: createSecureContext({ cert: pair.cert, key: pair.key }) };
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.unshift(head);
      const tls = new TLSSocket(socket, { isServer: true, secureContext: this.context.ctx, ALPNProtocols: ['http/1.1'] });
      // a TLS error (a client that does not trust the certificate) closes the socket and says nothing
      tls.on('error', () => tls.destroy());
      this.sockets.add(tls);
      tls.once('close', () => this.sockets.delete(tls));
      this.own(tls, hash);
      this.watch(tls);
      this.inner.emit('connection', tls);
    } catch {
      socket.destroy();
    }
  }

  // ---- decrypted requests ----

  private misdirected(req: IncomingMessage): boolean {
    const host = String(req.headers.host ?? '').toLowerCase();
    return host !== INTERCEPT_HOST && host !== `${INTERCEPT_HOST}:443`;
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.misdirected(req)) {
      sendJson(res, 421, MISDIRECTED);
      req.resume();
      return;
    }
    const lane = await this.deps.lane(req, res);
    if (lane.taken) return;
    this.relay(req, res, lane.body);
  }

  /** The session's own request to the real api.anthropic.com: its headers go as they came, minus the hop-by-hop ones */
  private relay(req: IncomingMessage, res: ServerResponse, body: Buffer | null): void {
    const { upstream } = this.deps;
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !skipped(k)) headers[k] = v;
    headers.host = INTERCEPT_HOST;
    if (body) headers['content-length'] = String(body.length);
    const up = httpsRequest({ host: upstream.host, port: upstream.port, servername: INTERCEPT_HOST, method: req.method, path: req.url, headers, agent: this.agent, ...(upstream.ca ? { ca: upstream.ca } : {}) }, (answer) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(answer.headers)) if (v !== undefined && !skipped(k)) out[k] = v;
      res.writeHead(answer.statusCode ?? 502, out);
      res.flushHeaders();
      pipeline(answer, res).catch(() => res.destroy());
    });
    up.on('error', () => {
      if (!res.headersSent) sendJson(res, 502, UPSTREAM);
      else res.destroy();
    });
    res.on('close', () => {
      if (!res.writableFinished) up.destroy();
    });
    if (body) up.end(body);
    else req.pipe(up);
  }

  /** A WebSocket-style upgrade: the request goes to the relay target as it came, and the two sockets are piped. No inspection. */
  private upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    socket.on('error', () => {});
    if (this.misdirected(req)) return void socket.end('HTTP/1.1 421 Misdirected Request\r\nContent-Length: 0\r\n\r\n');
    const { upstream } = this.deps;
    const up = tlsConnect({ host: upstream.host, port: upstream.port, servername: INTERCEPT_HOST, ...(upstream.ca ? { ca: upstream.ca } : {}) });
    this.sockets.add(up);
    const hash = this.owned.get(socket);
    if (hash) this.own(up, hash);
    up.on('error', () => socket.destroy());
    up.on('close', () => {
      this.sockets.delete(up);
      socket.destroy();
    });
    socket.once('close', () => up.destroy());
    up.once('secureConnect', () => {
      let text = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) if (!req.rawHeaders[i].toLowerCase().startsWith('proxy-')) text += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      up.write(`${text}\r\n`);
      if (head.length) up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    });
  }
}
