// Remote MCP over Streamable HTTP (stateless: no Mcp-Session-Id, no server-initiated stream) plus the OAuth
// endpoints in ./oauth.ts. A request handler factory so tests can run it on port 0 with a fake core and store.
//
//   POST /mcp                                   JSON-RPC (single message or batch), Bearer token required
//   GET|DELETE /mcp                             401 without a valid token (starts OAuth discovery), else 405 (no SSE, no sessions)
//   GET  /.well-known/oauth-protected-resource[/mcp]
//   GET  /.well-known/oauth-authorization-server, /.well-known/openid-configuration
//   POST /register                              RFC 7591
//   GET|POST /authorize                         consent page with the one-time approval code
//   POST /token                                 authorization_code (PKCE S256) | refresh_token

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { PROTOCOL_VERSIONS } from '../mcp/rpc.ts';
import { STRICT, type RedactPolicy } from './redact.ts';
import { handleRemoteMessage, type RemoteCore } from './tools.ts';
import { clientAddress, FailureLimiter, hostAllowed, originAllowed, stderrLogger, viaFunnel, type Logger } from './guard.ts';
import {
  authServerMetadata,
  consentHtml,
  errorHtml,
  fetchClientMetadata,
  pkceOk,
  protectedResourceMetadata,
  redirectAllowed,
  resourceMatches,
  SCOPE,
  type ClientInfo,
} from './oauth.ts';
import type { RemoteState, Store } from './store.ts';
import { t } from '../core/i18n.ts';

export interface RemoteDeps {
  core: RemoteCore;
  store: Store;
  /** Host names this server answers to (lower case, no port) */
  hosts: ReadonlySet<string>;
  /** The issuer read from remote.json at start. Pinned: deleting or editing the file at runtime can't move it. */
  publicUrl?: string;
  /** The dashboard's 설정 tab (oauth.ts settingsPageUrl), linked under the consent page's code field */
  settingsUrl?: string | null;
  log?: Logger;
  now?: () => number;
  fetchImpl?: typeof fetch;
  toolTimeoutMs?: number;
}

const MCP_BODY_LIMIT = 64 * 1024;
const FORM_BODY_LIMIT = 8 * 1024;
const CODE_TTL_MS = 60_000;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) return reject(new HttpError(413, 'body too large'));
    let size = 0;
    let over = false;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      if (over) return; // drain the rest so the 413 can be sent; the connection closes after it
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        reject(new HttpError(413, 'body too large'));
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** application/x-www-form-urlencoded or JSON → flat string map */
async function readParams(req: IncomingMessage): Promise<Record<string, string>> {
  const body = await readBody(req, FORM_BODY_LIMIT);
  const type = String(req.headers['content-type'] ?? '');
  if (type.includes('application/json')) {
    let o: any;
    try {
      o = JSON.parse(body || '{}');
    } catch {
      throw new HttpError(400, 'invalid JSON');
    }
    return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  }
  return Object.fromEntries(new URLSearchParams(body));
}

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  // same-origin, not no-referrer: under no-referrer a browser sends `Origin: null` with the consent page's form POST,
  // and originAllowed() refuses that (claude.ai's first real approval failed with "origin not allowed"). same-origin
  // still sends no referrer (with the OAuth query string) to any other site.
  'referrer-policy': 'same-origin',
};

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string, formTarget?: string) {
  const formAction = ["'self'", formTarget].filter(Boolean).join(' ');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    ...SECURITY_HEADERS,
    'x-frame-options': 'DENY',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
  });
  res.end(body);
}

function redirect(res: ServerResponse, to: string) {
  res.writeHead(302, { location: to, ...SECURITY_HEADERS });
  res.end();
}

interface AuthCode {
  client: ClientInfo;
  redirectUri: string;
  challenge: string;
  resource: string;
  scope: string;
  expiresAt: number;
}

export function createRemoteHandler(deps: RemoteDeps) {
  const log = deps.log ?? stderrLogger;
  const now = deps.now ?? Date.now;
  // Failures per address (bad token, code, PKCE, approval code, unknown client…). Never blocks a valid credential:
  // claude.ai and ChatGPT call from shared egress addresses, so anyone could otherwise get the owner's connector
  // locked out by making their own connector fail from the same address.
  const limiter = new FailureLimiter(20, 10 * 60_000, now);
  // Wrong approval codes per address: one address can't burn the owner's pending code on its own.
  const approvalLimiter = new FailureLimiter(5, 10 * 60_000, now);
  // Unauthenticated work that writes the file or fetches from the internet: per address and for everyone together.
  const registerLimiter = new FailureLimiter(10, 10 * 60_000, now);
  const registerGlobal = new FailureLimiter(30, 60 * 60_000, now);
  const cimdGlobal = new FailureLimiter(60, 10 * 60_000, now);
  const codes = new Map<string, AuthCode>();
  const cimdCache = new Map<string, { at: number; value: ClientInfo | string }>();
  const toolTimeoutMs = deps.toolTimeoutMs ?? 20_000;

  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const baseUrl = (req: IncomingMessage, s: RemoteState) => {
    const pinned = deps.publicUrl ?? s.publicUrl;
    return pinned ? pinned.replace(/\/+$/, '') : `${viaFunnel(req) ? 'https' : 'http'}://${req.headers.host}`;
  };
  // Only a literal true loosens redaction ("false" or 1 in a hand-edited file stays strict).
  const policyOf = (s: RemoteState): RedactPolicy => ({
    showAddresses: s.policy?.showAddresses === true || STRICT.showAddresses,
    showProcesses: s.policy?.showProcesses === true || STRICT.showProcesses,
  });
  const redirectOpts = (s: RemoteState) => ({ allowLoopback: s.allowLoopbackRedirects !== false, extraPrefixes: strings(s.extraRedirectPrefixes) });

  async function resolveClient(id: string, s: RemoteState): Promise<ClientInfo | string> {
    if (Object.hasOwn(s.clients, id)) {
      const dcr = s.clients[id];
      return { id, name: dcr.name, redirectUris: strings(dcr.redirectUris), kind: 'dcr' };
    }
    if (!id.startsWith('https://')) return 'unknown client_id';
    const hit = cimdCache.get(id);
    if (hit && now() - hit.at < (typeof hit.value === 'string' ? 60_000 : 10 * 60_000)) return hit.value;
    if (cimdGlobal.blocked('all')) return 'too many client metadata lookups; try again in a few minutes';
    cimdGlobal.hit('all');
    const value = await fetchClientMetadata(id, deps.fetchImpl);
    cimdCache.set(id, { at: now(), value });
    if (cimdCache.size > 100) cimdCache.delete(cimdCache.keys().next().value!);
    return value;
  }

  function authFail(req: IncomingMessage, path: string, reason: string, extra: Record<string, string> = {}) {
    const ip = clientAddress(req);
    limiter.fail(ip);
    log('auth-fail', { ip, path, reason, ...extra });
  }

  function tooMany(res: ServerResponse, wait: number) {
    return json(res, 429, { error: 'too many failed attempts' }, { 'retry-after': String(wait) });
  }

  // ---- /mcp ----

  async function mcp(req: IncomingMessage, res: ServerResponse, s: RemoteState) {
    const base = baseUrl(req, s);

    // Authentication comes before the method check: a client's first, unauthenticated request may be a GET (an SSE
    // probe), and it has to get the 401 + WWW-Authenticate that starts OAuth discovery, not a 405.
    const challenge = (error?: string) =>
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"${error ? `, error="${error}"` : ''}`;
    const auth = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''));
    if (!auth) return json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': challenge() });
    const token = await deps.store.verifyAccessToken(auth[1]);
    if (!token || token.resource !== `${base}/mcp`) {
      const wait = limiter.blocked(clientAddress(req));
      if (wait) return tooMany(res, wait);
      authFail(req, '/mcp', token ? 'audience' : 'invalid-token');
      return json(res, 401, { error: 'invalid_token' }, { 'www-authenticate': challenge('invalid_token') });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only (stateless server: no SSE stream, no sessions)' }, { allow: 'POST' });

    if (!String(req.headers['content-type'] ?? '').includes('application/json')) return json(res, 415, { error: 'content-type must be application/json' });
    const version = req.headers['mcp-protocol-version'];
    if (typeof version === 'string' && !PROTOCOL_VERSIONS.includes(version)) {
      return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `unsupported MCP-Protocol-Version: ${version}` } });
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, MCP_BODY_LIMIT));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    const batch = Array.isArray(body);
    const messages = batch ? (body as unknown[]) : [body];
    if (!messages.length || messages.length > 20) return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });

    const policy = policyOf(s);
    const replies = await Promise.all(
      messages.map((m: any) => {
        if (m?.method === 'tools/call') log('call', { client: token.clientName, tool: String(m.params?.name ?? '').slice(0, 64) });
        if (m?.method === 'resources/read') log('read', { client: token.clientName, uri: String(m.params?.uri ?? '').slice(0, 64) });
        if (m?.method === 'prompts/get') log('prompt', { client: token.clientName, prompt: String(m.params?.name ?? '').slice(0, 64) });
        let timer: NodeJS.Timeout;
        const timeout = new Promise<any>((resolve) => {
          timer = setTimeout(() => resolve({ jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32603, message: 'timed out' } }), toolTimeoutMs);
        });
        return Promise.race([handleRemoteMessage(m, deps.core, policy), timeout]).finally(() => clearTimeout(timer));
      }),
    );
    const out = replies.filter((r) => r !== null);
    if (!out.length) {
      res.writeHead(202, SECURITY_HEADERS);
      return res.end();
    }
    const payload = JSON.stringify(batch ? out : out[0]);
    const accept = String(req.headers.accept ?? '');
    if (accept.includes('text/event-stream') && !accept.includes('application/json') && !accept.includes('*/*')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', ...SECURITY_HEADERS });
      return res.end(`event: message\ndata: ${payload}\n\n`);
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
    res.end(payload);
  }

  // ---- OAuth ----

  async function register(req: IncomingMessage, res: ServerResponse, s: RemoteState) {
    const ip = clientAddress(req);
    const wait = Math.max(limiter.blocked(ip), registerLimiter.blocked(ip), registerGlobal.blocked('all'));
    if (wait) return json(res, 429, { error: 'too many registrations' }, { 'retry-after': String(wait) });
    let body: any;
    try {
      body = JSON.parse(await readBody(req, FORM_BODY_LIMIT));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      return json(res, 400, { error: 'invalid_client_metadata', error_description: 'body must be JSON' });
    }
    const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
    if (!uris.length || uris.length > 10 || !uris.every((u: unknown) => typeof u === 'string')) {
      return json(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be a non-empty list' });
    }
    const bad = uris.find((u: string) => !redirectAllowed(u, redirectOpts(s)));
    if (bad) {
      authFail(req, '/register', 'redirect-not-allowed', { redirect: bad.slice(0, 120) });
      return json(res, 400, { error: 'invalid_redirect_uri', error_description: `redirect_uri not allowed: ${bad}` });
    }
    const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : 'MCP client';
    registerLimiter.hit(ip);
    registerGlobal.hit('all');
    const id = await deps.store.registerClient(name, uris);
    log('register', { ip, client: name });
    return json(res, 201, {
      client_id: id,
      client_id_issued_at: Math.floor(now() / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: SCOPE,
    });
  }

  /** Checks shared by GET and POST /authorize. Errors before the redirect URI is trusted are shown, not redirected. */
  async function authorizeRequest(p: Record<string, string>, s: RemoteState, base: string) {
    if (!p.client_id) return { page: 'client_id is missing' } as const;
    const client = await resolveClient(p.client_id, s);
    if (typeof client === 'string') return { page: client } as const;
    const redirectUri = p.redirect_uri || (client.redirectUris.length === 1 ? client.redirectUris[0] : '');
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) return { page: 'redirect_uri is not registered for this client' } as const;
    if (!redirectAllowed(redirectUri, redirectOpts(s))) return { page: 'redirect_uri is not on the allowlist' } as const;

    const back = (error: string, description: string) => {
      const u = new URL(redirectUri);
      u.searchParams.set('error', error);
      u.searchParams.set('error_description', description);
      if (p.state) u.searchParams.set('state', p.state);
      u.searchParams.set('iss', base);
      return { redirect: u.toString() } as const;
    };
    if (p.response_type !== 'code') return back('unsupported_response_type', 'response_type must be code');
    if (!p.code_challenge || p.code_challenge_method !== 'S256') return back('invalid_request', 'PKCE with S256 is required');
    if (!resourceMatches(p.resource, base)) return back('invalid_target', `resource must be ${base}/mcp`);
    return { client, redirectUri } as const;
  }

  async function authorize(req: IncomingMessage, res: ServerResponse, s: RemoteState) {
    const base = baseUrl(req, s);
    const ip = clientAddress(req);
    const blocked = limiter.blocked(ip);
    if (blocked) return html(res, 429, errorHtml(t('remoteHttp.tooMany', { n: Math.ceil(blocked / 60) })));
    const p = req.method === 'POST' ? await readParams(req) : Object.fromEntries(new URL(req.url ?? '/', 'http://x').searchParams);
    const checked = await authorizeRequest(p, s, base);
    if ('page' in checked) {
      // Counted: each unknown https client_id is a fetch to claude.ai / chatgpt.com on the requester's behalf.
      authFail(req, '/authorize', 'rejected', { detail: (checked.page ?? '').slice(0, 120) });
      return html(res, 400, errorHtml(checked.page ?? 'invalid request'));
    }
    if ('redirect' in checked) return redirect(res, checked.redirect);
    const { client, redirectUri } = checked;

    const params: Record<string, string> = {};
    for (const k of ['response_type', 'client_id', 'redirect_uri', 'state', 'scope', 'code_challenge', 'code_challenge_method', 'resource']) {
      if (p[k]) params[k] = p[k];
    }
    params.redirect_uri = redirectUri;
    const host = new URL(base).hostname;
    const target = new URL(redirectUri).origin;
    const page = (status: number, error?: string) => html(res, status, consentHtml({ clientName: client.name, redirectUri, host, params, error, settingsUrl: deps.settingsUrl }), target);

    if (req.method !== 'POST') return page(200);

    const back = (q: Record<string, string>) => {
      const u = new URL(redirectUri);
      for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
      if (p.state) u.searchParams.set('state', p.state);
      u.searchParams.set('iss', base);
      return redirect(res, u.toString());
    };
    if (p.decision === 'deny') {
      log('authorize-denied', { ip, client: client.name });
      return back({ error: 'access_denied', error_description: 'the owner denied access' });
    }

    const wait = approvalLimiter.blocked(ip);
    if (wait) return page(429, t('remoteHttp.tooMany', { n: Math.ceil(wait / 60) }));
    const verdict = await deps.store.consumeApprovalCode(p.approval_code ?? '');
    if (verdict !== 'ok') {
      approvalLimiter.fail(ip);
      authFail(req, '/authorize', verdict === 'none' ? 'no-pending-code' : 'wrong-code', { client: client.name });
      return page(401, verdict === 'none' ? t('remoteHttp.noCode') : t('remoteHttp.wrongCode'));
    }

    const code = randomBytes(32).toString('base64url');
    for (const [k, v] of codes) if (v.expiresAt <= now()) codes.delete(k);
    codes.set(code, {
      client,
      redirectUri,
      challenge: p.code_challenge,
      resource: `${base}/mcp`,
      scope: SCOPE,
      expiresAt: now() + CODE_TTL_MS,
    });
    log('authorize-approved', { ip, client: client.name, kind: client.kind });
    return back({ code });
  }

  async function token(req: IncomingMessage, res: ServerResponse, s: RemoteState) {
    const base = baseUrl(req, s);
    const p = await readParams(req);
    const err = (status: number, error: string, description: string, reason?: string) => {
      if (reason) {
        // A failure from an address over the limit gets 429; a valid code or refresh token always works.
        const wait = limiter.blocked(clientAddress(req));
        if (wait) return tooMany(res, wait);
        authFail(req, '/token', reason);
      }
      return json(res, status, { error, error_description: description }, { pragma: 'no-cache' });
    };
    const issue = async (client: { id: string; name: string }, resource: string, family?: string) => {
      const t = await deps.store.issueTokens(client, resource, SCOPE, family);
      return json(
        res,
        200,
        { access_token: t.access, token_type: 'Bearer', expires_in: t.expiresIn, refresh_token: t.refresh, scope: t.scope },
        { pragma: 'no-cache' },
      );
    };

    if (p.grant_type === 'authorization_code') {
      const entry = p.code ? codes.get(p.code) : undefined;
      if (p.code) codes.delete(p.code); // single use, even when the rest fails
      if (!entry || entry.expiresAt <= now()) return err(400, 'invalid_grant', 'code is invalid or expired', 'bad-code');
      // Public clients must identify themselves (OAuth 2.1 §3.2.2); the code is bound to one client.
      if (p.client_id !== entry.client.id) return err(400, 'invalid_grant', 'client_id is missing or the code was issued to another client', 'client-mismatch');
      if (p.redirect_uri && p.redirect_uri !== entry.redirectUri) return err(400, 'invalid_grant', 'redirect_uri does not match', 'redirect-mismatch');
      if (!pkceOk(p.code_verifier ?? '', entry.challenge)) return err(400, 'invalid_grant', 'PKCE verification failed', 'pkce');
      if (!resourceMatches(p.resource, base)) return err(400, 'invalid_target', `resource must be ${base}/mcp`, 'resource');
      log('token', { client: entry.client.name, grant: 'authorization_code' });
      return issue({ id: entry.client.id, name: entry.client.name }, entry.resource);
    }

    if (p.grant_type === 'refresh_token') {
      const old = p.refresh_token ? await deps.store.takeRefreshToken(p.refresh_token) : null;
      if (old === 'reused') {
        log('refresh-reuse', { ip: clientAddress(req) });
        return err(400, 'invalid_grant', 'refresh token was already used; this authorization is revoked', 'refresh-reuse');
      }
      if (!old) return err(400, 'invalid_grant', 'refresh token is invalid or expired', 'bad-refresh');
      if (p.client_id !== old.clientId) return err(400, 'invalid_grant', 'client_id is missing or the refresh token was issued to another client', 'client-mismatch');
      log('token', { client: old.clientName, grant: 'refresh_token' });
      return issue({ id: old.clientId, name: old.clientName }, old.resource, old.family);
    }

    return err(400, 'unsupported_grant_type', 'use authorization_code or refresh_token');
  }

  // ---- routing ----

  // PORTBOARD_REMOTE_TRACE=1: one line per request (method, path, Host, Origin, User-Agent, status, ms) to debug a client
  // that can't connect. Never the Authorization header, query string or body.
  const trace = process.env.PORTBOARD_REMOTE_TRACE === '1';

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    if (trace) {
      const t0 = Date.now();
      res.once('finish', () => {
        const h = (k: string) => String(req.headers[k] ?? '-').slice(0, 80);
        console.error(`[portboard-remote] trace ${req.method} ${new URL(req.url ?? '/', 'http://x').pathname} ${res.statusCode} ${Date.now() - t0}ms host=${h('host')} origin=${h('origin')} ua=${h('user-agent')} from=${clientAddress(req)}`);
      });
    }
    try {
      if (!hostAllowed(req, deps.hosts)) return json(res, 421, { error: 'unknown host' });
      const s = await deps.store.read();
      if (!originAllowed(req, deps.hosts, strings(s.allowedOrigins))) {
        log('origin-rejected', { ip: clientAddress(req), origin: String(req.headers.origin).slice(0, 120) });
        return json(res, 403, { error: 'origin not allowed' });
      }
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const base = baseUrl(req, s);

      if (path === '/mcp') return await mcp(req, res, s);
      if (req.method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
        return json(res, 200, protectedResourceMetadata(base));
      }
      if (req.method === 'GET' && (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration')) {
        return json(res, 200, authServerMetadata(base));
      }
      if (path === '/register') return req.method === 'POST' ? await register(req, res, s) : json(res, 405, { error: 'use POST' }, { allow: 'POST' });
      if (path === '/authorize') {
        return req.method === 'GET' || req.method === 'POST' ? await authorize(req, res, s) : json(res, 405, { error: 'use GET or POST' });
      }
      if (path === '/token') return req.method === 'POST' ? await token(req, res, s) : json(res, 405, { error: 'use POST' }, { allow: 'POST' });
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message }, err.status === 413 ? { connection: 'close' } : {});
      log('error', { message: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    }
  };
}
