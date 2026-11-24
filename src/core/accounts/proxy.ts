// Accounts proxy (docs/accounts.md#proxy): a loopback HTTP listener that sends Claude Code's requests to Anthropic with the
// OAuth token of one added Claude account, and Codex's requests to chatgpt.com with the token of one added ChatGPT/Codex
// account, and sends the same request to the next account of that provider when a limit is reached.
// Claude Code reaches it with ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN (the proxy key). Codex reaches it with a
// `model_provider` whose `base_url` ends in /codex and whose `env_key` holds the proxy key.
//
//   - It binds 127.0.0.1 only (PROXY_HOST, a constant: no setting or variable changes it) and is never published with
//     `tailscale serve`. The Host header must be 127.0.0.1:<port> or localhost:<port>, and a request with an Origin is refused.
//   - The caller sends the proxy key (accounts-proxy.key, 0600) as `Authorization: Bearer` or `x-api-key`. The key and the
//     client's cookies never go upstream; the account's token goes upstream and nowhere else.
//   - Only POST /v1/messages, POST /v1/messages/count_tokens (Claude) and POST /codex/responses (Codex) are sent on
//     (PROXY_REQUESTS). Other paths are counted. WebSocket upgrades are not sent on.
//   - The request body goes upstream as the bytes it came in; the answer streams back. A switch happens only before the first
//     byte of an answer reaches the caller (pool.ts decides which answers move on). The one exception is the GPT lane
//     (docs/accounts.md#gpt-lane, gpt.ts): a /v1/messages request whose model the owner listed in `accounts.proxy.gpt` is
//     converted to a Responses request and sent to the Codex address with a Codex account, and its answer is converted back.
//   - With `accounts.proxy.desktop.enabled` the listener also takes HTTP CONNECT (intercept.ts, docs/accounts.md#desktop-route): only
//     the Anthropic API host is decrypted (a /v1/messages request for a GPT lane model goes to the lane, everything else is relayed
//     to Anthropic unchanged with the session's own login), and every other host is a plain tunnel. Proxy key required.
//   - The dashboard process opens the listener from the `accounts-proxy` job (src/features/accounts.ts); the stdio MCP server never does.
//
// No token, key, header value, body or query string is written to a log, an event or an answer.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { writePrivate } from '../atomic.ts';
import { PATHS } from '../paths.ts';
import { SITE, SITE_DEFAULTS } from '../site.ts';
import { clipText, ConvertError, fromResponse, mergeThread, ResponsesToMessages, routeModel, sessionIdOf, ThreadStore, toolNames, toResponsesRequest, type GptConfig, type StoredThread, type ToolNames } from './gpt.ts';
import type { HomesOptions } from './homes.ts';
import { DesktopRoute, INTERCEPT_HOST, loadOrMakeCert, refuseSocket, type RouteDeps } from './intercept.ts';
import { Pool, verdictOf, type ProxyEvent, type ProxyProvider } from './pool.ts';
import { appendUsage, MODEL_CLIP, num as count, type UsageLine } from './usage.ts';

// The URLs, the beta flag and the version header of the upstream requests live in this block and nowhere else. The shape
// follows opencodex commit 9e0e298e (MIT): src/server/index.ts:416-417 (the path and query are kept) and
// src/server/responses/core-auth.ts (the Codex address). No code is copied. A Codex request goes to
// `origin + upstreamPath` (+ its query) when it came in on one of `paths`.
export const PROXY_REQUESTS = {
  claude: {
    origin: 'https://api.anthropic.com',
    paths: ['/v1/messages', '/v1/messages/count_tokens'] as readonly string[],
    oauthBeta: 'oauth-2025-04-20',
    defaultVersion: '2023-06-01',
  },
  codex: {
    origin: 'https://chatgpt.com',
    upstreamPath: '/backend-api/codex/responses',
    paths: ['/codex/responses'] as readonly string[],
  },
};

/** The one address the listener binds */
export const PROXY_HOST = '127.0.0.1';
const MAX_CONNECTIONS = 32;
/** The desktop route: CONNECT sockets open at once (every HTTPS connection of a session and its tool commands is one) */
const MAX_TUNNELS = 512;
const HEADERS_TIMEOUT_MS = 10_000;
/** After each answer on a decrypted connection, the next request's complete headers must arrive within this long (idle time included) */
const INNER_IDLE_MS = 60_000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const UPSTREAM_HEADERS_MS = 60_000;
/** Claude Code, the account's token and the retries: at most this many accounts serve one request (three switches) */
const MAX_ACCOUNTS = 4;
const MAX_PATHS = 20;
const PATH_CLIP = 80;
const SHOWN_EVENTS = 20;
/** The usage log reads at most this much of a JSON answer; a larger one is logged without token counts */
const MAX_OBSERVE_BYTES = 1024 * 1024;
/** `close` waits this long for the usage lines of requests that were cut */
const CLOSE_WAIT_MS = 2000;
/** The usage log's SSE buffer: a line (or an event) longer than this many characters (`string.length`, UTF-16 units, not bytes) is dropped */
const MAX_SSE_BUFFER = 64 * 1024;
/** Codex's `response.completed` holds the whole Response (every output item), so its SSE event can pass 64 KiB: Codex gets the JSON limit */
const MAX_CODEX_SSE_BUFFER = MAX_OBSERVE_BYTES;
/** The GPT lane reads the body of an upstream error for this long at most */
const ERROR_BODY_MS = 10_000;

/** `unknown`: the settings say on, but this process never opened or closed the proxy (the stdio MCP server): the dashboard's may be listening */
export type ProxyState = 'off' | 'listening' | 'port in use' | 'error' | 'unknown';

export interface ProxyConfig {
  enabled: boolean;
  port: number;
  /** the desktop route (accounts.proxy.desktop.enabled); absent is off */
  desktop?: boolean;
}

export interface ProxyReport {
  /** accounts.enabled and accounts.proxy.enabled; false in a preview */
  enabled: boolean;
  state: ProxyState;
  port: number;
  /** listening only */
  url: string | null;
  current: { claude: string | null; codex: string | null };
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
  /** the usage log file (tests); default PATHS.accountsUsage */
  usagePath?: string;
  /** tests: replace the usage log's writer */
  appendUsage?: (line: UsageLine, path: string) => Promise<void>;
  /** tests: the GPT lane's settings; default SITE.accounts.proxy.gpt (used only when accounts.enabled and accounts.proxy.enabled are on too) */
  gpt?: () => GptConfig;
  /** tests: a shorter wait for the body of an upstream error on the GPT lane (default 10 seconds) */
  errorBodyMs?: number;
  /** tests: the desktop route's certificate and key files; default PATHS.accountsProxyCert and PATHS.accountsProxyCertKey */
  certPath?: string;
  certKeyPath?: string;
  /** tests: a shorter wait for the request headers of a decrypted connection, and a shorter idle wait between its requests */
  interceptHeadersMs?: number;
  interceptIdleMs?: number;
  /** tests: fewer plain requests (and decrypted lane requests) at once (default 32) */
  maxPlainRequests?: number;
  /** tests: fewer CONNECT sockets at once (default 512) */
  maxTunnels?: number;
  /** tests: where the relay of decrypted Anthropic requests goes (default: the Anthropic API host, port 443); `ca` is the certificate it must show */
  interceptUpstream?: { host: string; port: number; ca?: string };
}

/** The token counts one answer carried; null where it carried none */
interface Tokens {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}
const NO_TOKENS = (): Tokens => ({ input: null, output: null, cacheRead: null, cacheWrite: null });
const objectOf = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The four counts of a Codex `usage` object. `input` includes the cached tokens (OpenAI's rule); a missing or non-numeric field is null. */
function codexTokens(u: Record<string, unknown> | null): Tokens {
  const details = objectOf(u?.input_tokens_details);
  return { input: count(u?.input_tokens), output: count(u?.output_tokens), cacheRead: count(details?.cached_tokens), cacheWrite: count(details?.cache_write_tokens) };
}

/** The `model` of a request body: a string clipped to 128 characters, else null. Nothing else of the body is kept. */
function modelOf(body: Buffer): string | null {
  try {
    const model = objectOf(JSON.parse(body.toString('utf8')))?.model;
    return typeof model === 'string' ? model.slice(0, MODEL_CLIP) : null;
  } catch {
    return null;
  }
}

/**
 * Reads the token counts out of an answer as it streams by. It passes every chunk on as it came (the bytes do not change)
 * and keeps a copy only to read: a JSON answer whole (up to MAX_OBSERVE_BYTES), an SSE answer line by line. It never throws.
 */
export class UsageObserver extends Transform {
  private tokens = NO_TOKENS();
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private over = false;
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private data: string[] = [];
  private dataSize = 0;
  private skipping = false;
  /** true while the rest of a line that passed the cap is being dropped */
  private discarding = false;

  private readonly sse: boolean;
  private readonly countOnly: boolean;
  private readonly provider: ProxyProvider;
  private readonly maxBuffer: number;

  constructor(sse: boolean, countOnly: boolean, provider: ProxyProvider = 'claude') {
    super();
    this.sse = sse;
    this.countOnly = countOnly;
    this.provider = provider;
    this.maxBuffer = provider === 'codex' ? MAX_CODEX_SSE_BUFFER : MAX_SSE_BUFFER;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    try {
      this.see(chunk);
    } catch {
      // reading is best effort; the bytes still go on
    }
    cb(null, chunk);
  }

  private see(chunk: Buffer): void {
    if (!this.sse) {
      if (this.over) return;
      this.size += chunk.length;
      if (this.size > MAX_OBSERVE_BYTES) {
        this.over = true;
        this.chunks.length = 0;
        return;
      }
      this.chunks.push(chunk);
      return;
    }
    // `pending` never holds a newline: only the newly decoded text is searched, so a long line costs O(n) in all
    const text = this.decoder.write(chunk);
    let from = 0;
    while (from < text.length) {
      const nl = text.indexOf('\n', from);
      if (this.discarding) {
        // the rest of an over-long line is dropped up to its newline
        if (nl < 0) return;
        this.discarding = false;
        from = nl + 1;
        continue;
      }
      if (nl < 0) {
        this.pending += text.slice(from);
        if (this.pending.length > this.maxBuffer) {
          this.pending = '';
          this.discarding = true;
        }
        return;
      }
      this.line((this.pending + text.slice(from, nl)).replace(/\r$/, ''));
      this.pending = '';
      from = nl + 1;
    }
  }

  private line(l: string): void {
    if (l === '') return this.event();
    if (!l.startsWith('data:')) return;
    const v = l.slice(5).replace(/^ /, '');
    if (this.skipping) return;
    // the joining character counts too, so a run of empty `data:` lines is bounded like any other
    this.dataSize += v.length + 1;
    if (this.dataSize > this.maxBuffer) {
      // too long: this event is dropped, and nothing more of it is kept up to the blank line that ends it
      this.data = [];
      this.dataSize = 0;
      this.skipping = true;
      return;
    }
    this.data.push(v);
  }

  private event(): void {
    if (this.skipping) {
      this.skipping = false;
      return;
    }
    if (!this.data.length) return;
    const text = this.data.join('\n');
    this.data = [];
    this.dataSize = 0;
    // Codex: a plain substring check first, so an event that cannot carry the usage is never parsed
    if (this.provider === 'codex' && !text.includes('"response.completed"') && !text.includes('"response.incomplete"')) return;
    let ev: Record<string, unknown> | null;
    try {
      ev = objectOf(JSON.parse(text));
    } catch {
      return;
    }
    if (!ev) return;
    if (this.provider === 'codex') {
      // only the two events that end a Codex response carry its usage
      if (ev.type === 'response.completed' || ev.type === 'response.incomplete') this.tokens = codexTokens(objectOf(objectOf(ev.response)?.usage));
      return;
    }
    if (ev.type === 'message_start') {
      const u = objectOf(objectOf(ev.message)?.usage);
      if (!u) return;
      this.tokens.input = count(u.input_tokens);
      this.tokens.cacheRead = count(u.cache_read_input_tokens);
      this.tokens.cacheWrite = count(u.cache_creation_input_tokens);
      const out = count(u.output_tokens);
      if (out !== null) this.tokens.output = out;
    } else if (ev.type === 'message_delta') {
      // the last value wins
      const out = count(objectOf(ev.usage)?.output_tokens);
      if (out !== null) this.tokens.output = out;
    }
  }

  /** The characters held for a half-read line or event (tests: it stays within the provider's cap, MAX_SSE_BUFFER or MAX_CODEX_SSE_BUFFER, plus one line) */
  heldSize(): number {
    return this.pending.length + this.dataSize;
  }

  /** What was seen so far: call it once the stream ended, broke off or the caller left */
  result(): Tokens {
    try {
      if (this.sse) {
        this.pending += this.decoder.end();
        for (const l of this.pending.split('\n')) this.line(l.replace(/\r$/, ''));
        this.pending = '';
        this.event();
      } else if (!this.over && this.chunks.length) {
        const body = objectOf(JSON.parse(Buffer.concat(this.chunks).toString('utf8')));
        if (this.provider === 'codex') this.tokens = codexTokens(objectOf(body?.usage));
        else if (this.countOnly) this.tokens.input = count(body?.input_tokens);
        else {
          const u = objectOf(body?.usage);
          this.tokens.input = count(u?.input_tokens);
          this.tokens.output = count(u?.output_tokens);
          this.tokens.cacheRead = count(u?.cache_read_input_tokens);
          this.tokens.cacheWrite = count(u?.cache_creation_input_tokens);
        }
        this.chunks.length = 0;
      }
    } catch {
      // not the shape we read: the counts stay as they are
    }
    return { ...this.tokens };
  }
}

/** What differs on the GPT lane: the upstream headers and what is done with the answer (the account switching is `forward`'s) */
interface Lane {
  headers(pick: { token: string; accountId: string | null }): Record<string, string>;
  pass(response: Response, account: string): Promise<void>;
}

/** What `forward` knows about the request when it writes the usage line */
interface Seen {
  provider: ProxyProvider;
  model: string | null;
  /** the path is /v1/messages/count_tokens */
  countOnly: boolean;
  started: number;
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

/** The error body of the Codex paths: the shape of an OpenAI error, with the same closed words as the Claude paths */
const codexBody = (message: string) => ({ error: { type: 'proxy_error', code: message, message } });
type ErrorKind = 'auth' | 'denied' | 'noAccount' | 'upstream' | 'tooLarge';
const errorBody = (provider: ProxyProvider, kind: ErrorKind) => (provider === 'codex' ? codexBody(BODIES[kind].error.message) : BODIES[kind]);

const HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer'];
const DROP_REQUEST = new Set([...HOP, 'host', 'content-length', 'authorization', 'x-api-key', 'cookie', 'origin', 'referer', 'accept-encoding', 'expect']);
const DROP_RESPONSE = new Set([...HOP, 'set-cookie', 'content-encoding', 'content-length']);

const digest = (s: string) => createHash('sha256').update(s).digest();
const KEY_SHAPE = /^pbp-[0-9a-f]{32}$/;

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

/** The request headers that go upstream: the client's, minus the listed ones, plus the account's token (Codex: and its account id) */
function upstreamHeaders(from: IncomingMessage['headers'], provider: ProxyProvider, token: string, accountId: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined || DROP_REQUEST.has(k) || k.startsWith('proxy-')) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  out.authorization = `Bearer ${token}`;
  out['accept-encoding'] = 'identity';
  if (provider === 'codex') {
    // the client's own headers (originator, session-id, x-codex-*, user-agent) go on; nothing else is made up
    delete out['chatgpt-account-id'];
    delete out['anthropic-beta'];
    delete out['anthropic-version'];
    if (accountId) out['chatgpt-account-id'] = accountId;
    return out;
  }
  const beta = PROXY_REQUESTS.claude.oauthBeta;
  const have = (out['anthropic-beta'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!have.includes(beta)) out['anthropic-beta'] = [...have, beta].join(',');
  if (!out['anthropic-version']) out['anthropic-version'] = PROXY_REQUESTS.claude.defaultVersion;
  return out;
}

/** The provider a path belongs to (the query is not read); null for a path of neither. The method is not read: an error body follows the path. */
function providerOfPath(req: IncomingMessage): ProxyProvider | null {
  const url = req.url ?? '';
  const path = url.indexOf('?') < 0 ? url : url.slice(0, url.indexOf('?'));
  if (PROXY_REQUESTS.codex.paths.includes(path)) return 'codex';
  return PROXY_REQUESTS.claude.paths.includes(path) ? 'claude' : null;
}

/** The provider and the full upstream address of a request the proxy sends on, with its query as it came; null for anything else */
function upstreamTarget(req: IncomingMessage): { provider: ProxyProvider; url: string } | null {
  const url = req.url ?? '';
  const provider = providerOfPath(req);
  if (req.method !== 'POST' || !url.startsWith('/') || !provider) return null;
  const q = url.indexOf('?');
  if (provider === 'codex') return { provider, url: PROXY_REQUESTS.codex.origin + PROXY_REQUESTS.codex.upstreamPath + (q < 0 ? '' : url.slice(q)) };
  return { provider, url: PROXY_REQUESTS.claude.origin + url };
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

/**
 * The upstream call when no `fetch` is injected. Node's fetch adds headers of its own (`accept`, `accept-language`,
 * `sec-fetch-mode`), and the proxy must not invent headers, so this sends exactly the headers it is given and nothing
 * more. It answers with what the proxy reads from a fetch answer: `status`, `headers` and `body` (a web stream). It does not
 * follow a redirect and ends the request when the signal aborts.
 */
export function upstreamRequest(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const target = new URL(String(url));
  const send = target.protocol === 'http:' ? httpRequest : httpsRequest;
  const signal = init?.signal ?? undefined;
  const body = init?.body as Buffer | undefined;
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
    if (body) headers['content-length'] = String(body.length);
    const req = send(target, { method: init?.method ?? 'GET', headers });
    const onAbort = () => req.destroy(new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.once('error', reject);
    req.once('response', (res) => {
      req.off('error', reject);
      res.once('close', () => signal?.removeEventListener('abort', onAbort));
      // an abort after the headers ends the stream with an error, which the proxy's pipeline handles
      req.on('error', () => res.destroy());
      const h = new Headers();
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) h.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
      resolve({ status: res.statusCode ?? 502, headers: h, body: Readable.toWeb(res) } as unknown as Response);
    });
    req.end(body);
  });
}

export class AccountsProxy {
  readonly pool: Pool;
  private server: Server | null = null;
  private state: ProxyState = 'off';
  private cfg: ProxyConfig = { enabled: false, port: SITE_DEFAULTS.accounts.proxy.port };
  /** `sync` ran in this process */
  private synced = false;
  /** the port the open listener was asked for (0 asks for any) */
  private openedFor = 0;
  private bound = 0;
  private keyHash: Buffer | null = null;
  private requests = 0;
  private readonly unproxied = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();
  /** the requests being handled and the usage writes started, which `close` waits for (2 seconds at most) */
  private readonly busy = new Set<Promise<unknown>>();
  /** the desktop route of the open listener, and the pair it answers with (null while the route is off) */
  private route: DesktopRoute | null = null;
  private certs: { cert: string; key: string } | null = null;
  /** non-CONNECT requests open now (counted only while the route is on) */
  private readonly plain = new Set<ServerResponse>();
  /** the GPT lane's threads (docs/accounts.md#gpt-lane): memory only, one store for this proxy */
  private readonly threads = new ThreadStore();

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
    // a process that never synced says what the settings say, and does not claim to know the listener's state
    const cfg = this.synced ? this.cfg : proxyConfig();
    const port = listening ? this.bound : cfg.port;
    return {
      enabled: cfg.enabled,
      state: !this.synced && cfg.enabled ? 'unknown' : this.state,
      port,
      url: listening ? `http://${PROXY_HOST}:${port}` : null,
      current: { ...this.pool.current },
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
      this.synced = true;
      // the job runs this every minute: threads past their time go
      this.threads.sweep();
      if (!cfg.enabled) {
        await this.stop();
        this.state = 'off';
        return;
      }
      if (this.server && this.openedFor === cfg.port) {
        // the same rules as at open: a key file that others can read, or that is not a key, closes the listener; an edited key applies now
        try {
          await this.readKey(false);
        } catch {
          await this.stop();
          this.setKeyHash(null);
          this.setState('error', 'the key file cannot be used');
          return;
        }
        // the same for the route's certificate: one that went loose, odd or out of date closes the listener
        try {
          await this.applyRoute();
        } catch {
          await this.stop();
          this.setState('error', 'the desktop route certificate cannot be used');
        }
        return;
      }
      await this.stop();
      await this.open(cfg.port);
    });
  }

  /** Close the listener (shutdown) */
  close(): Promise<void> {
    return this.enqueue(async () => {
      await this.stop();
      this.threads.clear();
      this.state = 'off';
      // the streams that `stop` cut write their line when their handler ends: wait for those and for the writes, 2 seconds at most
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_WAIT_MS);
      });
      const drained = (async () => {
        while (this.busy.size) await Promise.allSettled([...this.busy]);
      })();
      await Promise.race([drained, limit]);
      clearTimeout(timer);
    });
  }

  private track(p: Promise<unknown>): void {
    this.busy.add(p);
    void p.finally(() => this.busy.delete(p));
  }

  private async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.route?.closeAll();
    this.route = null;
    this.certs = null;
    this.plain.clear();
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
    try {
      this.certs = this.cfg.desktop ? await this.loadCert() : null;
    } catch {
      return this.setState('error', 'the desktop route certificate cannot be used');
    }
    const server = createServer((req, res) => {
      if (this.route) {
        // with the route on, a session's tunnels fill the connection limit: ordinary requests have a limit of their own
        if (!this.admit(res)) return;
      }
      this.track(
        this.handle(req, res).catch(() => {
          if (!res.headersSent) sendJson(res, 502, errorBody(providerOfPath(req) ?? 'claude', 'upstream'));
          else res.destroy();
        }),
      );
    });
    server.maxConnections = MAX_CONNECTIONS;
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.requestTimeout = 0;
    // registered always, so a CONNECT is answered (403 while the route is off) and not left open
    server.on('connect', (req, socket, head) => {
      if (this.server === server && this.route) this.route.connect(req, socket as Socket, head);
      else {
        socket.on('error', () => {});
        refuseSocket(socket as Socket, '403 Forbidden');
      }
    });
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
      server.close();
      server.closeAllConnections();
      this.setState('error', `listener failed on ${PROXY_HOST}:${port}`);
    });
    this.server = server;
    this.openedFor = port;
    this.bound = (server.address() as { port: number }).port;
    this.state = 'listening';
    this.applyRouteSync(server);
  }

  /** Read or make the route's certificate and key (throws `certificate unusable`) */
  private loadCert(): Promise<{ cert: string; key: string }> {
    return loadOrMakeCert({ certPath: this.o.certPath ?? PATHS.accountsProxyCert, keyPath: this.o.certKeyPath ?? PATHS.accountsProxyCertKey, now: () => this.pool.now() });
  }

  /** Make the listener match the route setting: build or drop the route, the certificate and the connection limit */
  private async applyRoute(): Promise<void> {
    const server = this.server;
    if (!server) return;
    if (!this.cfg.desktop) {
      this.route?.closeAll();
      this.route = null;
      this.certs = null;
      server.maxConnections = MAX_CONNECTIONS;
      return;
    }
    this.certs = await this.loadCert();
    if (this.server === server) this.applyRouteSync(server);
  }

  private applyRouteSync(server: Server): void {
    if (!this.cfg.desktop || !this.certs) return;
    if (!this.route) {
      const deps: RouteDeps = {
        enabled: () => this.server === server && this.cfg.desktop === true && this.certs !== null,
        boundPort: () => this.bound,
        authorize: (secret) => (this.keyHash !== null && timingSafeEqual(digest(secret), this.keyHash) ? this.keyHash : null),
        counted: () => void this.requests++,
        cert: () => this.certs,
        maxTunnels: this.o.maxTunnels ?? MAX_TUNNELS,
        upstream: this.o.interceptUpstream ?? { host: INTERCEPT_HOST, port: 443 },
        headersTimeoutMs: this.o.interceptHeadersMs ?? HEADERS_TIMEOUT_MS,
        idleMs: this.o.interceptIdleMs ?? INNER_IDLE_MS,
        lane: (req, res) => this.innerLane(req, res),
        track: (p) => this.track(p),
      };
      this.route = new DesktopRoute(deps);
    }
    server.maxConnections = MAX_CONNECTIONS + (this.o.maxTunnels ?? MAX_TUNNELS);
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
    this.setKeyHash(digest(key));
    return key;
  }

  private async writeKey(path: string): Promise<string> {
    const key = `pbp-${randomBytes(16).toString('hex')}`;
    await writePrivate(path, `${key}\n`);
    this.setKeyHash(digest(key));
    return key;
  }

  /** The key hash in use. A new one closes every CONNECT socket that was accepted with the old one. */
  private setKeyHash(hash: Buffer | null): void {
    const changed = this.keyHash === null || hash === null || !this.keyHash.equals(hash);
    this.keyHash = hash;
    if (changed) this.route?.revoke(hash);
  }

  /** Room for one more plain request (or decrypted lane request)? The open ones are in a set. False after answering 503. */
  private admit(res: ServerResponse): boolean {
    if (this.plain.size >= (this.o.maxPlainRequests ?? MAX_CONNECTIONS)) {
      sendJson(res, 503, { type: 'error', error: { type: 'api_error', message: 'too many requests' } });
      return false;
    }
    this.plain.add(res);
    res.once('close', () => void this.plain.delete(res));
    return true;
  }

  /** The absolute path of the key file */
  keyFile(): string {
    return this.o.keyPath ?? PATHS.accountsProxyKey;
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
    const host = String(req.headers.host ?? '').toLowerCase();
    const shape = providerOfPath(req) ?? 'claude';
    if ((host !== `${PROXY_HOST}:${this.bound}` && host !== `localhost:${this.bound}`) || req.headers.origin !== undefined) {
      return sendJson(res, 403, errorBody(shape, 'denied'));
    }
    if (!this.authorized(req)) return sendJson(res, 401, errorBody(shape, 'auth'));
    // only a caller that passed both checks counts (a port probe or an unauthenticated call does not)
    this.requests++;
    const target = upstreamTarget(req);
    if (!target) {
      const path = shownPath(req);
      if (this.unproxied.has(path) || this.unproxied.size < MAX_PATHS) this.unproxied.set(path, (this.unproxied.get(path) ?? 0) + 1);
      return sendJson(res, 404, BODIES.notFound);
    }
    const body = await readBody(req, this.o.maxBodyBytes ?? MAX_BODY_BYTES);
    if (body === null) return;
    if (body === 'too large') {
      sendJson(res, 413, errorBody(target.provider, 'tooLarge'), { connection: 'close' });
      req.resume();
      return;
    }
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    const countOnly = target.url.split('?')[0].endsWith('/count_tokens');
    // the GPT lane parses the body once: the result gives the model name of the usage line and the route
    const lane = target.provider === 'claude' && this.gptConfig().enabled;
    let parsed: unknown = null;
    if (lane) {
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        // not JSON: not routed
      }
    }
    const asked = objectOf(parsed)?.model;
    const seen: Seen = { provider: target.provider, model: lane ? (typeof asked === 'string' ? asked.slice(0, MODEL_CLIP) : null) : modelOf(body), countOnly, started: this.pool.now() };
    const upstreamModel = lane ? routeModel(asked, this.gptConfig()) : null;
    if (upstreamModel) return this.forwardGpt(req.headers, parsed, upstreamModel, countOnly, body, res, abort, seen);
    await this.forward(target.provider, req.headers, target.url, body, res, abort, seen);
  }

  /**
   * A decrypted request of the desktop route (intercept.ts asks): the lane takes a `POST /v1/messages*` for a model it lists, and
   * the body is read for that. Anything else is not the lane's: with the lane off nothing is read and the request streams on.
   */
  private async innerLane(req: IncomingMessage, res: ServerResponse): Promise<{ taken: true } | { taken: false; body: Buffer | null }> {
    const url = req.url ?? '';
    const path = url.indexOf('?') < 0 ? url : url.slice(0, url.indexOf('?'));
    const cfg = this.gptConfig();
    if (req.method !== 'POST' || !PROXY_REQUESTS.claude.paths.includes(path) || !cfg.enabled) return { taken: false, body: null };
    const body = await readBody(req, this.o.maxBodyBytes ?? MAX_BODY_BYTES);
    if (body === null) return { taken: true };
    if (body === 'too large') {
      sendJson(res, 413, errorBody('claude', 'tooLarge'), { connection: 'close' });
      req.resume();
      return { taken: true };
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      // not JSON: not routed
    }
    const asked = objectOf(parsed)?.model;
    const upstreamModel = routeModel(asked, cfg);
    if (!upstreamModel) return { taken: false, body };
    if (!this.admit(res)) return { taken: true };
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    const countOnly = path.endsWith('/count_tokens');
    const seen: Seen = { provider: 'claude', model: typeof asked === 'string' ? asked.slice(0, MODEL_CLIP) : null, countOnly, started: this.pool.now() };
    await this.forwardGpt(req.headers, parsed, upstreamModel, countOnly, body, res, abort, seen);
    return { taken: true };
  }

  /** The GPT lane's settings: the test hook, or portboard.json (the lane is open only while the proxy itself is) */
  private gptConfig(): GptConfig {
    if (this.o.gpt) return this.o.gpt();
    const a = SITE.accounts;
    return { enabled: a.enabled && a.proxy.enabled && a.proxy.gpt.enabled, models: a.proxy.gpt.models };
  }

  /** The GPT lane: convert, ask a Codex account (the same switching as `forward`), convert the answer back */
  private async forwardGpt(from: IncomingMessage['headers'], parsed: unknown, upstreamModel: string, countOnly: boolean, raw: Buffer, res: ServerResponse, abort: AbortController, seen: Seen): Promise<void> {
    if (countOnly) return sendJson(res, 200, { input_tokens: Math.ceil(raw.length / 4) });
    // a request with `thread` (through the desktop route) may carry only the new turn: the stored history is put back in front of it
    let effective = parsed;
    const body = objectOf(parsed);
    const thread = objectOf(body?.thread);
    let previous: string | null = null;
    let before: StoredThread | null = null;
    if (body && thread) {
      if (thread.type === 'continue') {
        previous = String(thread.previous_message_id);
        const prev = this.threads.get(previous);
        before = prev;
        if (!prev) return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'thread not found: the proxy keeps GPT lane threads in memory only; start a new conversation' } });
        effective = mergeThread(body, prev);
      }
    }
    const names = toolNames();
    // chatgpt.com caches a prompt per session: the same id goes up as `session-id` and `prompt_cache_key`; no other client header does
    const sessionId = sessionIdOf(from['x-claude-code-session-id'], parsed);
    let converted: Buffer;
    try {
      converted = Buffer.from(JSON.stringify(toResponsesRequest(effective, upstreamModel, names, sessionId)));
    } catch (err) {
      if (err instanceof ConvertError) return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: err.message } });
      throw err;
    }
    const wantStream = objectOf(parsed)?.stream === true;
    const requestedModel = String(objectOf(parsed)?.model ?? '').slice(0, MODEL_CLIP);
    // after a whole answer: the history up to and including it is kept under the id the client received
    const sent = objectOf(effective);
    // a conversation keeps its latest entry and the one before it: the entry before that goes first, then the new one is put
    const keep =
      body && thread && sent
        ? (id: string, content: unknown) => {
            if (before?.parent) this.threads.delete(before.parent);
            this.threads.put(id, {
              system: sent.system,
              tools: Array.isArray(sent.tools) ? sent.tools : null,
              messages: [...(Array.isArray(sent.messages) ? sent.messages : []), { role: 'assistant', content }],
              parent: previous !== id ? previous : null,
            });
          }
        : null;
    const lane: Lane = {
      headers: (pick) => ({
        authorization: `Bearer ${pick.token}`,
        ...(pick.accountId ? { 'chatgpt-account-id': pick.accountId } : {}),
        ...(sessionId ? { 'session-id': sessionId } : {}),
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'accept-encoding': 'identity',
      }),
      pass: (response, account) => this.passGpt(response, res, seen, account, wantStream, requestedModel, names, keep),
    };
    // the usage line names the GPT model that answered, as a Codex line (docs/accounts.md#usage-log)
    seen.provider = 'codex';
    seen.model = upstreamModel;
    await this.forward('codex', {}, PROXY_REQUESTS.codex.origin + PROXY_REQUESTS.codex.upstreamPath, converted, res, abort, seen, lane);
  }

  /** Write one usage line; nothing here changes the answer, and a failed write is dropped */
  private record(seen: Seen, account: string, status: number, tokens: Tokens): void {
    try {
      const line: UsageLine = { at: new Date(seen.started).toISOString(), provider: seen.provider, account, model: seen.model, status, ...tokens, ms: Math.max(0, this.pool.now() - seen.started) };
      this.track(Promise.resolve((this.o.appendUsage ?? appendUsage)(line, this.o.usagePath ?? PATHS.accountsUsage)).catch(() => {}));
    } catch {
      // the log is best effort
    }
  }

  /** Try the accounts in turn; hand the first answer that is not a switch to the caller */
  private async forward(provider: ProxyProvider, from: IncomingMessage['headers'], url: string, body: Buffer, res: ServerResponse, abort: AbortController, seen: Seen, lane?: Lane): Promise<void> {
    const pool = this.pool;
    const used = new Set<string>();
    /** the account asked last */
    let lastId: string | null = null;
    // the last answer that asked for a switch: it is given to the caller as it is when no account is left (its body is still unread)
    let held: { response: Response; id: string } | null = null;
    for (let n = 0; n < MAX_ACCOUNTS && !abort.signal.aborted; n++) {
      const pick = await pool.next(provider, used);
      if (!pick) break;
      lastId = pick.id;
      if (held) {
        await held.response.body?.cancel().catch(() => {});
        pool.switched(provider, held.id, pick.id, held.response.status);
        held = null;
      }
      let response: Response;
      const timer = setTimeout(() => abort.abort(), this.o.upstreamHeadersMs ?? UPSTREAM_HEADERS_MS);
      try {
        response = await (this.o.fetch ?? upstreamRequest)(url, {
          method: 'POST',
          headers: lane ? lane.headers(pick) : upstreamHeaders(from, provider, pick.token, pick.accountId),
          body: body as unknown as BodyInit,
          redirect: 'manual',
          signal: abort.signal,
        });
      } catch {
        // the caller left, the wait for the headers ran out, or the network failed: nothing was sent to the caller yet
        if (!res.destroyed && !res.headersSent) sendJson(res, 502, errorBody(lane ? 'claude' : provider, 'upstream'));
        this.record(seen, pick.id, 0, NO_TOKENS());
        return;
      } finally {
        clearTimeout(timer);
      }
      const verdict = verdictOf(provider, response.status, response.headers, pool.now());
      if (!verdict) {
        if (response.status < 400) pool.current[provider] = pick.id;
        return lane ? lane.pass(response, pick.id) : this.pass(response, res, seen, pick.id);
      }
      pool.rest(provider, pick.id, verdict.restMs, response.status);
      held = { response, id: pick.id };
    }
    if (abort.signal.aborted) {
      // the caller left (or the wait ran out) between two accounts: no answer reached the caller
      if (lastId) this.record(seen, lastId, 0, NO_TOKENS());
      return void held?.response.body?.cancel().catch(() => {});
    }
    if (held) return lane ? lane.pass(held.response, held.id) : this.pass(held.response, res, seen, held.id);
    // no account was left to ask: nothing to log (docs/accounts.md#usage-log)
    pool.noteNoAccount(provider);
    sendJson(res, 503, errorBody(lane ? 'claude' : provider, 'noAccount'));
  }

  /** Status and headers first, then the body as a stream; a caller that leaves ends the upstream request (the signal) */
  private async pass(response: Response, res: ServerResponse, seen: Seen, account: string): Promise<void> {
    const headers: Record<string, string> = {};
    for (const [k, v] of response.headers) if (!DROP_RESPONSE.has(k) && !k.startsWith('proxy-')) headers[k] = v;
    // an observer between the answer and the caller reads the token counts; it passes every byte on as it came
    const observer = new UsageObserver((response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream'), seen.countOnly, seen.provider);
    try {
      res.writeHead(response.status, headers);
      res.flushHeaders();
      if (!response.body) return void res.end();
      try {
        const source = Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream);
        await pipeline(source, observer, res);
      } catch {
        // upstream broke off or the caller left: the connection is closed, nothing more to say
        res.destroy();
      }
    } finally {
      // once, however the answer ended, with the counts seen so far
      this.record(seen, account, response.status, observer.result());
    }
  }

  /**
   * The GPT lane's answer. An error status is answered in the Anthropic error shape: a closed text for 401 and 403 (OpenAI's own
   * text is never passed on there), else the upstream text after `clipText` scrubbed it. A stream is converted as it comes; the usage counts are read before the conversion, on the
   * OpenAI-shaped stream with the Codex rules. When the client asked for no stream, the whole upstream stream is read and the
   * final Response becomes one Message.
   */
  private async passGpt(response: Response, res: ServerResponse, seen: Seen, account: string, wantStream: boolean, requestedModel: string, names: ToolNames, keep: ((id: string, content: unknown) => void) | null): Promise<void> {
    const observer = new UsageObserver(true, false, 'codex');
    const status = response.status;
    let counted = true;
    const source = (): Readable => (response.body ? Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream) : Readable.from([]));
    try {
      // chatgpt.com answers its stream with no content-type at all (seen 2026-11-24): only a named type that is not a stream is refused
      const type = response.headers.get('content-type');
      const sse = type === null || type.trim() === '' || type.toLowerCase().includes('text/event-stream');
      if (response.status >= 400) {
        counted = false;
        const extra: Record<string, string> = {};
        const retry = response.headers.get('retry-after');
        if (retry !== null) extra['retry-after'] = retry;
        const detail = await readErrorText(source(), this.o.errorBodyMs ?? ERROR_BODY_MS);
        return sendJson(res, response.status, gptErrorBody(response.status, detail), extra);
      }
      if (response.status >= 300 || !sse) {
        // a redirect, or an answer that is not a stream: nothing to convert
        counted = false;
        void response.body?.cancel().catch(() => {});
        return sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: `codex: unexpected answer ${response.status}` } });
      }
      const translator = new ResponsesToMessages(requestedModel, names);
      if (wantStream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.flushHeaders();
        // the thread is kept the moment the client has the whole answer (its `message_stop`), not when the upstream body ends.
        // The id is the one `message_start` carried; a failed answer has no `message_stop`.
        let kept = false;
        const tap = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            if (!kept && keep && chunk.toString('utf8', 0, 20) === 'event: message_stop\n') {
              kept = true;
              const done = translator.finalResponse();
              const id = translator.messageId();
              if (done !== null && id !== null && translator.failure() === null) keep(id, fromResponse(done, requestedModel, names, id).content);
            }
            cb(null, chunk);
          },
        });
        try {
          await pipeline(source(), observer, translator, tap, res);
        } catch {
          // upstream broke off or the caller left: the connection is closed, nothing more to say
          res.destroy();
        }
        return;
      }
      let size = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          cb(size > MAX_BODY_BYTES ? new Error('answer too large') : null, size > MAX_BODY_BYTES ? undefined : chunk);
        },
      });
      try {
        await pipeline(source(), limit, observer, translator, new Writable({ write: (_c, _e, cb) => cb() }));
      } catch {
        // the stream broke off or was too large after its headers: the line keeps the upstream status
        if (!res.destroyed && !res.headersSent) sendJson(res, 502, BODIES.upstream);
        return;
      }
      if (res.destroyed) return;
      const failure = translator.failure();
      const final = translator.finalResponse();
      if (failure) return sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: failure } });
      if (final === null) return sendJson(res, 502, BODIES.upstream);
      const message = fromResponse(final, requestedModel, names);
      sendJson(res, 200, message);
      if (keep) keep(String(message.id), message.content);
    } finally {
      this.record(seen, account, status, counted ? observer.result() : NO_TOKENS());
    }
  }
}

/** The error body of the GPT lane: the Anthropic shape; a 401 or 403 says a closed text, as OpenAI's own text may echo a token */
function gptErrorBody(status: number, detail: string | null): { type: 'error'; error: { type: string; message: string } } {
  const type = status === 400 || status === 422 ? 'invalid_request_error' : status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 404 ? 'not_found_error' : status === 413 ? 'request_too_large' : status === 429 ? 'rate_limit_error' : 'api_error';
  const message = status === 401 ? 'codex account token refused' : status === 403 ? 'chatgpt.com refused the request' : `codex: ${clipText(detail)}`;
  return { type: 'error', error: { type, message } };
}

/** The text of an upstream error answer (`detail` or `error.message`, a string) out of at most 1 MiB; null when there is none */
async function readErrorText(body: Readable, waitMs: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    body.destroy();
  }, waitMs);
  try {
    for await (const c of body) {
      chunks.push(c as Buffer);
      size += (c as Buffer).length;
      if (size > MAX_OBSERVE_BYTES) break;
    }
  } catch {
    // a broken body has no text
  }
  clearTimeout(timer);
  body.destroy();
  if (late) return null;
  try {
    const j = objectOf(JSON.parse(Buffer.concat(chunks).subarray(0, MAX_OBSERVE_BYTES).toString('utf8')));
    if (typeof j?.detail === 'string') return j.detail;
    const m = objectOf(j?.error)?.message;
    return typeof m === 'string' ? m : null;
  } catch {
    return null;
  }
}

/** The proxy this process runs (the dashboard's `accounts-proxy` job drives it) */
export const accountsProxy = new AccountsProxy();

/** The two flags and the port, without the preview rule: a preview's expose_port still must not touch the production proxy port */
const flags = (): ProxyConfig => ({ enabled: SITE.accounts.enabled && SITE.accounts.proxy.enabled, port: SITE.accounts.proxy.port, desktop: SITE.accounts.proxy.desktop.enabled });
const settings = (): ProxyConfig => ({ ...flags(), enabled: flags().enabled && PATHS.profile !== 'preview' });
let configFn: (() => ProxyConfig) | null = null;

/** What the settings say: on only when accounts.enabled and accounts.proxy.enabled are both true, and never in a preview */
export const proxyConfig = (): ProxyConfig => (configFn ?? settings)();

/** For tests: replace the settings */
export function setProxyConfigForTest(fn: (() => ProxyConfig) | null): void {
  configFn = fn;
}

/** The port a proxy that production runs uses when nothing says otherwise */
const DEFAULT_PORT = SITE_DEFAULTS.accounts.proxy.port;

/**
 * True when `port` is the proxy's port in the settings of a proxy that is on (expose_port refuses it). A preview reads its
 * own copy of portboard.json, made once, so it can miss a proxy that production turned on later: there the preview's
 * configured port and the default port count whatever the flags say. A replaced config (the test hook) is used as it is.
 */
export function proxyHoldsPort(port: number): boolean {
  if (configFn) {
    const cfg = configFn();
    return cfg.enabled && port === cfg.port;
  }
  const cfg = flags();
  if (PATHS.profile === 'preview') return port === cfg.port || port === DEFAULT_PORT;
  return cfg.enabled && port === cfg.port;
}
