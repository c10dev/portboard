// Minimal single-user OAuth 2.1 authorization server for the remote MCP endpoint.
//
//   discovery   RFC 9728 protected resource metadata, RFC 8414 authorization server metadata
//   clients     Client ID Metadata Documents (CIMD, https client_id on claude.ai / claude.com / chatgpt.com)
//               or Dynamic Client Registration (RFC 7591), both public clients (token_endpoint_auth_method none)
//   grants      authorization_code with PKCE S256 only, refresh_token with rotation
//   consent     the owner types a one-time approval code made on the dashboard's 설정 tab (tailnet only), or on the
//               server with `node src/remote.ts approve`
//
// Redirect URIs must also match an allowlist, so a client registered by a stranger can't send a code anywhere else.

import { createHash } from 'node:crypto';
import { currentLocale, t } from '../core/i18n.ts';

export const SCOPE = 'portboard:read';

/** Exact redirect URIs the two hosted clients use, and the per-connection ChatGPT prefix. */
const REDIRECT_EXACT = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
]);
const REDIRECT_PREFIX = [/^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,200}$/];

/** Hosts whose https URLs we fetch as client metadata documents. */
export const CIMD_HOSTS = new Set(['claude.ai', 'claude.com', 'chatgpt.com']);

export interface RedirectOptions {
  allowLoopback: boolean;
  extraPrefixes: readonly string[];
}

export function redirectAllowed(uri: string, opts: RedirectOptions): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (REDIRECT_EXACT.has(uri)) return true;
  if (REDIRECT_PREFIX.some((re) => re.test(uri))) return true;
  if (opts.allowLoopback && u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return true;
  return opts.extraPrefixes.some((p) => underPrefix(u, p));
}

/**
 * Same origin and the prefix's path up to a "/" boundary: "https://x.example/cb" admits https://x.example/cb and
 * https://x.example/cb/…, not https://x.example.evil/… or https://x.example/cbx.
 */
function underPrefix(u: URL, prefix: string): boolean {
  let p: URL;
  try {
    p = new URL(prefix);
  } catch {
    return false;
  }
  if (p.origin !== u.origin || p.search || p.hash || p.username || p.password) return false;
  const dir = p.pathname.endsWith('/') ? p.pathname : `${p.pathname}/`;
  return u.pathname === p.pathname || u.pathname.startsWith(dir);
}

export interface ClientInfo {
  id: string;
  name: string;
  redirectUris: string[];
  kind: 'dcr' | 'cimd';
}

const CIMD_MAX_BYTES = 16 * 1024;

/** Reads at most `limit` bytes of a response body; null when it is longer. */
async function readCapped(res: Response, limit: number): Promise<string | null> {
  if (Number(res.headers.get('content-length') ?? 0) > limit) return null;
  if (!res.body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > limit) return null; // leaving the loop cancels the stream
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Fetches and checks a client metadata document. Only https URLs on CIMD_HOSTS with a path and no query, port,
 * credentials or fragment; no redirects; 16 KB read at most; 5 s.
 */
export async function fetchClientMetadata(clientId: string, fetchImpl: typeof fetch = fetch): Promise<ClientInfo | string> {
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    return 'client_id is not a URL';
  }
  if (u.protocol !== 'https:' || !CIMD_HOSTS.has(u.hostname) || u.port || u.username || u.password) return `client metadata host not allowed: ${u.hostname}`;
  if (u.hash || u.search || u.pathname === '/' || clientId.length > 300) return 'client metadata URL must be a plain https path';
  let res: Response;
  try {
    res = await fetchImpl(u, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
  } catch {
    return 'client metadata document unreachable';
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return `client metadata document: HTTP ${res.status}`;
  }
  let body: string | null;
  try {
    body = await readCapped(res, CIMD_MAX_BYTES);
  } catch {
    return 'client metadata document unreachable';
  }
  if (body === null) return 'client metadata document too large';
  let doc: any;
  try {
    doc = JSON.parse(body);
  } catch {
    return 'client metadata document is not JSON';
  }
  if (doc?.client_id !== clientId) return 'client metadata client_id does not match its URL';
  const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((x: unknown) => typeof x === 'string') : [];
  if (!uris.length) return 'client metadata has no redirect_uris';
  return { id: clientId, name: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 80) : u.hostname, redirectUris: uris, kind: 'cimd' };
}

export function pkceOk(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  return createHash('sha256').update(verifier).digest('base64url') === challenge;
}

export function protectedResourceMetadata(base: string) {
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Portboard (read-only)',
  };
}

export function authServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/** The resource a client may name: the /mcp URL (what the user pastes), tolerated with a trailing slash or as the bare base. */
export function resourceMatches(asked: string | null | undefined, base: string): boolean {
  if (!asked) return true;
  return [`${base}/mcp`, `${base}/mcp/`, base, `${base}/`].includes(asked);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface ConsentPage {
  clientName: string;
  redirectUri: string;
  host: string;
  params: Record<string, string>;
  error?: string;
  /** Where the code is made: the dashboard's 설정 tab (settingsPageUrl), when the dashboard's address is known */
  settingsUrl?: string | null;
}

/**
 * The 설정 tab's 원격 커넥터 section on the dashboard's https address (tailscale serve, tailnet only), or null. Only an
 * https URL is linked: it is read from `tailscale serve status` or PORTBOARD_DASHBOARD_URL, never from the request.
 */
export function settingsPageUrl(dashboard: string | null | undefined): string | null {
  if (!dashboard) return null;
  try {
    const u = new URL(dashboard);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return `${u.origin}/settings.html#remote`;
  } catch {
    return null;
  }
}

export function consentHtml(p: ConsentPage): string {
  const hidden = Object.entries(p.params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n      ');
  const redirectHost = (() => {
    try {
      return new URL(p.redirectUri).host;
    } catch {
      return p.redirectUri;
    }
  })();
  return `<!doctype html>
<html lang="${currentLocale()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${t('oauth.title')}</title>
<style>
  :root { color-scheme: light dark; --bg: #fafaf9; --fg: #1c1917; --muted: #57534e; --line: #d6d3d1; --accent: #0f766e; --err: #b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1c1917; --fg: #f5f5f4; --muted: #a8a29e; --line: #44403c; --accent: #2dd4bf; --err: #f87171; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif; }
  main { max-width: 30rem; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  p, li { color: var(--muted); }
  b, code { color: var(--fg); }
  ul { padding-left: 1.2rem; }
  label { display: block; margin: 1.25rem 0 .4rem; font-weight: 600; }
  input[name=approval_code] { width: 100%; box-sizing: border-box; font: 1.3rem ui-monospace, monospace; letter-spacing: .15em; padding: .55rem .7rem; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--fg); text-transform: uppercase; }
  .row { display: flex; gap: .6rem; margin-top: 1rem; }
  button { flex: 1; padding: .6rem; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--fg); font: inherit; cursor: pointer; }
  button[value=approve] { background: var(--accent); border-color: var(--accent); color: var(--bg); font-weight: 600; }
  .err { color: var(--err); font-weight: 600; }
  .hint { font-size: .9rem; }
  .hint a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>${t('oauth.title')}</h1>
  <p>${t('oauth.lead', { client: esc(p.clientName), redirect: esc(redirectHost), host: esc(p.host) })}</p>
  <p>${t('oauth.warn')}</p>
  <ul>
    <li>${t('oauth.shared')}</li>
    <li>${t('oauth.notShared')}</li>
  </ul>
  <form method="post" action="authorize" autocomplete="off">
      ${hidden}
    <label for="code">${t('oauth.code')}</label>
    <input id="code" name="approval_code" inputmode="text" maxlength="12" placeholder="XXXX-XXXX" autofocus>
    <p class="hint">${t('oauth.hint', { where: p.settingsUrl ? `<a href="${esc(p.settingsUrl)}" target="_blank" rel="noopener">${t('oauth.where')}</a>` : t('oauth.where') })}</p>
    ${p.error ? `<p class="err">${esc(p.error)}</p>` : ''}
    <div class="row">
      <button type="submit" name="decision" value="deny">${t('oauth.deny')}</button>
      <button type="submit" name="decision" value="approve">${t('oauth.approve')}</button>
    </div>
  </form>
</main>
</body>
</html>`;
}

export function errorHtml(message: string): string {
  return `<!doctype html><html lang="${currentLocale()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Portboard</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem}</style></head>
<body><h1>${t('oauth.errorTitle')}</h1><p>${esc(message)}</p></body></html>`;
}
