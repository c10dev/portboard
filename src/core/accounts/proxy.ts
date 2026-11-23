// Accounts proxy (docs/accounts.md#proxy): a loopback HTTP listener that sends Claude Code's requests to Anthropic with the
// OAuth token of one added Claude account, and sends the same request to the next account when a shared limit is rejected.
// Claude Code reaches it with ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN (the proxy key).
//
//   - It binds 127.0.0.1 only (PROXY_HOST, a constant: no setting or variable changes it) and is never published with
//     `tailscale serve`. The Host header must be 127.0.0.1:<port> or localhost:<port>, and a request with an Origin is refused.
//   - The caller sends the proxy key (accounts-proxy.key, 0600) as `Authorization: Bearer` or `x-api-key`. The key and the
//     client's cookies never go upstream; the account's token goes upstream and nowhere else.
//   - Only POST /v1/messages and POST /v1/messages/count_tokens are sent on (PROXY_REQUESTS). Other paths are counted.
//   - The request body goes upstream as the bytes it came in; the answer streams back. A switch happens only before the first
//     byte of an answer reaches the caller (pool.ts decides which answers move on).
//   - The dashboard process opens the listener from the `accounts-proxy` job (src/features/accounts.ts); the stdio MCP server never does.
//
// No token, key, header value, body or query string is written to a log, an event or an answer.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { writePrivate } from '../atomic.ts';
import { PATHS } from '../paths.ts';
import { SITE, SITE_DEFAULTS } from '../site.ts';
import type { HomesOptions } from './homes.ts';
import { Pool, verdictOf, type ProxyEvent } from './pool.ts';

// The URL, the beta flag and the version header of the upstream request live in this block and nowhere else. The shape
// follows opencodex commit 9e0e298e (MIT): src/server/index.ts:416-417 (the path and query are kept). No code is copied.
export const PROXY_REQUESTS = {
  claude: {
    origin: 'https://api.anthropic.com',
    paths: ['/v1/messages', '/v1/messages/count_tokens'] as readonly string[],
    oauthBeta: 'oauth-2025-04-20',
    defaultVersion: '2023-06-01',
  },
};

/** The one address the listener binds */
export const PROXY_HOST = '127.0.0.1';
const MAX_CONNECTIONS = 32;
const HEADERS_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const UPSTREAM_HEADERS_MS = 60_000;
/** Claude Code, the account's token and the retries: at most this many accounts serve one request (three switches) */
const MAX_ACCOUNTS = 4;
const MAX_PATHS = 20;
const PATH_CLIP = 80;
const SHOWN_EVENTS = 20;

export type ProxyState = 'off' | 'listening' | 'port in use' | 'error';

export interface ProxyConfig {
  enabled: boolean;
  port: number;
}

export interface ProxyReport {
  /** accounts.enabled and accounts.proxy.enabled; false in a preview */
  enabled: boolean;
  state: ProxyState;
  port: number;
  /** listening only */
  url: string | null;
  current: { claude: string | null };
  resting: { id: string; until: string }[];
  /** newest first, 20 */
  events: ProxyEvent[];
  counts: { requests: number; switches: number };
  unproxied: { path: string; count: number }[];
}

export interface ProxyOptions extends HomesOptions {
  /** the proxy key file (tests); default PATHS.accountsProxyKey */
  keyPath?: string;
  /** tests: a smaller body limit */
  maxBodyBytes?: number;
  /** tests: a shorter wait for the upstream headers */
  upstreamHeadersMs?: number;
}

/** The closed texts of an answer: nothing of the request is in them */
const BODIES = {
  auth: { type: 'error', error: { type: 'authentication_error', message: 'proxy key required' } },
  denied: { type: 'error', error: { type: 'permission_error', message: 'not allowed' } },
  notFound: { type: 'error', error: { type: 'not_found_error', message: 'not proxied' } },
  noAccount: { type: 'error', error: { type: 'api_error', message: 'no usable account' } },
  upstream: { type: 'error', error: { type: 'api_error', message: 'upstream request failed' } },
  tooLarge: { type: 'error', error: { type: 'invalid_request_error', message: 'request too large' } },
} as const;

const HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer'];
const DROP_REQUEST = new Set([...HOP, 'host', 'content-length', 'authorization', 'x-api-key', 'cookie', 'origin', 'referer', 'accept-encoding']);
const DROP_RESPONSE = new Set([...HOP, 'set-cookie', 'content-encoding', 'content-length']);

const digest = (s: string) => createHash('sha256').update(s).digest();
const KEY_SHAPE = /^pbp-[0-9a-f]{32}$/;

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

/** The request headers that go upstream: the client's, minus the listed ones, plus the account's token */
function upstreamHeaders(from: IncomingMessage['headers'], token: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined || DROP_REQUEST.has(k) || k.startsWith('proxy-')) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  out.authorization = `Bearer ${token}`;
  out['accept-encoding'] = 'identity';
  const beta = PROXY_REQUESTS.claude.oauthBeta;
  const have = (out['anthropic-beta'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!have.includes(beta)) out['anthropic-beta'] = [...have, beta].join(',');
  if (!out['anthropic-version']) out['anthropic-version'] = PROXY_REQUESTS.claude.defaultVersion;
  return out;
}

/** The path of a request that is one the proxy sends on, with its query as it came; null for anything else */
function upstreamTarget(req: IncomingMessage): string | null {
  const url = req.url ?? '';
  if (req.method !== 'POST' || !url.startsWith('/')) return null;
  const q = url.indexOf('?');
  return PROXY_REQUESTS.claude.paths.includes(q < 0 ? url : url.slice(0, q)) ? url : null;
}

/** A path as a person reads it: no query, printable ASCII, 80 characters */
function shownPath(req: IncomingMessage): string {
  const url = req.url ?? '';
  const q = url.indexOf('?');
  return (q < 0 ? url : url.slice(0, q)).replace(/[^\x20-\x7e]/g, '?').slice(0, PATH_CLIP);
}

/** The body bytes as they came, or 'too large', or null when the caller left */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | 'too large' | null> {
  return new Promise((resolve) => {
    if (Number(req.headers['content-length']) > max) return resolve('too large');
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const end = (v: Buffer | 'too large' | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > max) return end('too large');
      chunks.push(c);
    });
    req.on('end', () => end(Buffer.concat(chunks)));
    req.on('error', () => end(null));
    req.on('close', () => end(null));
  });
}

export class AccountsProxy {
  readonly pool: Pool;
  private server: Server | null = null;
  private state: ProxyState = 'off';
  private cfg: ProxyConfig = { enabled: false, port: SITE_DEFAULTS.accounts.proxy.port };
  /** the port the open listener was asked for (0 asks for any) */
  private openedFor = 0;
  private bound = 0;
  private keyHash: Buffer | null = null;
  private requests = 0;
  private readonly unproxied = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();

  private readonly o: ProxyOptions;

  constructor(o: ProxyOptions = {}) {
    this.o = o;
    this.pool = new Pool(o);
  }

  /** The port of the open listener, or 0 */
  boundPort(): number {
    return this.server ? this.bound : 0;
  }

  report(): ProxyReport {
    const listening = this.state === 'listening';
    const port = listening ? this.bound : this.cfg.port;
    return {
      enabled: this.cfg.enabled,
      state: this.state,
      port,
      url: listening ? `http://${PROXY_HOST}:${port}` : null,
      current: { claude: this.pool.current },
      resting: this.pool.restingNow(),
      events: this.pool.recent(SHOWN_EVENTS),
      counts: { requests: this.requests, switches: this.pool.switches },
      unproxied: [...this.unproxied].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count),
    };
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const job = this.chain.then(run, run);
    this.chain = job.catch(() => {});
    return job;
  }

  /** Make the listener match the settings: open it, close it, or reopen it on a new port */
  sync(cfg: ProxyConfig): Promise<void> {
    return this.enqueue(async () => {
      this.cfg = cfg;
      if (!cfg.enabled) {
        await this.stop();
        this.state = 'off';
        return;
      }
      if (this.server && this.openedFor === cfg.port) return;
      await this.stop();
      await this.open(cfg.port);
    });
  }

  /** Close the listener (shutdown) */
  close(): Promise<void> {
    return this.enqueue(async () => {
      await this.stop();
      this.state = 'off';
    });
  }

  private async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections();
    });
  }

  private setState(next: ProxyState, why?: string): void {
    if (this.state !== next && why) console.error(`[portboard] accounts proxy: ${why}`);
    this.state = next;
  }

  private async open(port: number): Promise<void> {
    try {
      await this.readKey(true);
    } catch {
      return this.setState('error', 'the key file cannot be used');
    }
    const server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 502, BODIES.upstream);
        else res.destroy();
      });
    });
    server.maxConnections = MAX_CONNECTIONS;
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.requestTimeout = 0;
    const failed = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      server.once('error', resolve);
      server.listen(port, PROXY_HOST, () => {
        server.off('error', resolve);
        resolve(null);
      });
    });
    if (failed) {
      server.close();
      const inUse = failed.code === 'EADDRINUSE';
      return this.setState(inUse ? 'port in use' : 'error', `${inUse ? 'port in use' : 'cannot listen'} on ${PROXY_HOST}:${port}`);
    }
    // an error after the listener opened: say so once, and the next job run opens it again
    server.on('error', () => {
      if (this.server === server) this.server = null;
      this.setState('error', `listener failed on ${PROXY_HOST}:${port}`);
    });
    this.server = server;
    this.openedFor = port;
    this.bound = (server.address() as { port: number }).port;
    this.state = 'listening';
  }

  // ---- the key ----

  /** Read the key file, or make it when it is not there (0600). A file other users may touch, or an odd one, throws. */
  private async readKey(create: boolean): Promise<string> {
    const path = this.o.keyPath ?? PATHS.accountsProxyKey;
    let st;
    try {
      st = await stat(path);
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== 'ENOENT' || !create) throw new Error('proxy key unusable');
      return this.writeKey(path);
    }
    if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Error('proxy key unusable');
    const key = (await readFile(path, 'utf8')).trim();
    if (!KEY_SHAPE.test(key)) throw new Error('proxy key unusable');
    this.keyHash = digest(key);
    return key;
  }

  private async writeKey(path: string): Promise<string> {
    const key = `pbp-${randomBytes(16).toString('hex')}`;
    await writePrivate(path, `${key}\n`);
    this.keyHash = digest(key);
    return key;
  }

  /** The proxy key (made on first use); `rotate` writes a new one first, so the old one stops working. Throws `proxy key unusable`. */
  key(rotate = false): Promise<string> {
    return this.enqueue(() => (rotate ? this.writeKey(this.o.keyPath ?? PATHS.accountsProxyKey) : this.readKey(true)));
  }

  private authorized(req: IncomingMessage): boolean {
    if (!this.keyHash) return false;
    const auth = req.headers.authorization;
    const bearer = typeof auth === 'string' && /^bearer /i.test(auth) ? auth.slice(7).trim() : null;
    const apiKey = req.headers['x-api-key'];
    return [bearer, typeof apiKey === 'string' ? apiKey : null].some((v) => v !== null && timingSafeEqual(digest(v), this.keyHash!));
  }

  // ---- one request ----

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requests++;
    const host = String(req.headers.host ?? '').toLowerCase();
    if ((host !== `${PROXY_HOST}:${this.bound}` && host !== `localhost:${this.bound}`) || req.headers.origin !== undefined) {
      return sendJson(res, 403, BODIES.denied);
    }
    if (!this.authorized(req)) return sendJson(res, 401, BODIES.auth);
    const target = upstreamTarget(req);
    if (!target) {
      const path = shownPath(req);
      if (this.unproxied.has(path) || this.unproxied.size < MAX_PATHS) this.unproxied.set(path, (this.unproxied.get(path) ?? 0) + 1);
      return sendJson(res, 404, BODIES.notFound);
    }
    const body = await readBody(req, this.o.maxBodyBytes ?? MAX_BODY_BYTES);
    if (body === null) return;
    if (body === 'too large') {
      sendJson(res, 413, BODIES.tooLarge, { connection: 'close' });
      req.resume();
      return;
    }
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    await this.forward(req.headers, PROXY_REQUESTS.claude.origin + target, body, res, abort);
  }

  /** Try the accounts in turn; hand the first answer that is not a switch to the caller */
  private async forward(from: IncomingMessage['headers'], url: string, body: Buffer, res: ServerResponse, abort: AbortController): Promise<void> {
    const pool = this.pool;
    const used = new Set<string>();
    // the last answer that asked for a switch: it is given to the caller as it is when no account is left (its body is still unread)
    let held: { response: Response; id: string } | null = null;
    for (let n = 0; n < MAX_ACCOUNTS && !abort.signal.aborted; n++) {
      const pick = await pool.next(used);
      if (!pick) break;
      if (held) {
        await held.response.body?.cancel().catch(() => {});
        pool.switched(held.id, pick.id, held.response.status);
        held = null;
      }
      let response: Response;
      const timer = setTimeout(() => abort.abort(), this.o.upstreamHeadersMs ?? UPSTREAM_HEADERS_MS);
      try {
        response = await (this.o.fetch ?? fetch)(url, {
          method: 'POST',
          headers: upstreamHeaders(from, pick.token),
          body: body as unknown as BodyInit,
          redirect: 'manual',
          signal: abort.signal,
        });
      } catch {
        // the caller left, the wait for the headers ran out, or the network failed: nothing was sent to the caller yet
        if (!res.destroyed && !res.headersSent) sendJson(res, 502, BODIES.upstream);
        return;
      } finally {
        clearTimeout(timer);
      }
      const verdict = verdictOf(response.status, response.headers, pool.now());
      if (!verdict) {
        if (response.status < 400) pool.current = pick.id;
        return this.pass(response, res);
      }
      pool.rest(pick.id, verdict.restMs, response.status);
      held = { response, id: pick.id };
    }
    if (abort.signal.aborted) return void held?.response.body?.cancel().catch(() => {});
    if (held) return this.pass(held.response, res);
    pool.note({ kind: 'no usable account', status: 503 });
    sendJson(res, 503, BODIES.noAccount);
  }

  /** Status and headers first, then the body as a stream; a caller that leaves ends the upstream request (the signal) */
  private async pass(response: Response, res: ServerResponse): Promise<void> {
    const headers: Record<string, string> = {};
    for (const [k, v] of response.headers) if (!DROP_RESPONSE.has(k) && !k.startsWith('proxy-')) headers[k] = v;
    res.writeHead(response.status, headers);
    res.flushHeaders();
    if (!response.body) return void res.end();
    try {
      await pipeline(Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream), res);
    } catch {
      // upstream broke off or the caller left: the connection is closed, nothing more to say
      res.destroy();
    }
  }
}

/** The proxy this process runs (the dashboard's `accounts-proxy` job drives it) */
export const accountsProxy = new AccountsProxy();

const settings = (): ProxyConfig => ({
  enabled: SITE.accounts.enabled && SITE.accounts.proxy.enabled && PATHS.profile !== 'preview',
  port: SITE.accounts.proxy.port,
});
let configFn: () => ProxyConfig = settings;

/** What the settings say: on only when accounts.enabled and accounts.proxy.enabled are both true, and never in a preview */
export const proxyConfig = (): ProxyConfig => configFn();

/** For tests: replace the settings */
export function setProxyConfigForTest(fn: (() => ProxyConfig) | null): void {
  configFn = fn ?? settings;
}

/** True when `port` is the proxy's port in the settings of a proxy that is on (expose_port refuses it) */
export function proxyHoldsPort(port: number): boolean {
  const cfg = proxyConfig();
  return cfg.enabled && port === cfg.port;
}
