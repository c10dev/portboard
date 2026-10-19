// REST API + static dashboard. Listens on loopback and on this node's Tailscale IP
// (tailnet = only your own devices), so the dashboard itself needs no SSH tunnel.
//
// The routes, background jobs, shutdown work and page scripts come from the feature modules
// (src/features/registry.ts; docs/api.md lists the endpoints). This file only binds, checks the Host header,
// routes, serves public/ and starts the jobs.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tailscaleInfo } from './core/tailscale.ts';
import { loadAccessPolicy } from './core/access.ts';
import { hostAllowlist, outsideAddrs } from './core/hosts.ts';
import { describe, PATHS, seedPreview } from './core/paths.ts';
import { REGISTRY, uiTags } from './features/registry.ts';
import { createServerContext } from './features/context.ts';
import { appRouter, internalError } from './features/router.ts';
import { startJobs } from './features/jobs.ts';
import { noteMenubar } from './core/onboarding.ts';
import { SITE } from './core/site.ts';
import { expandShell } from './core/shell.ts';
import { requestLocale, withLocale } from './core/i18n.ts';

const PORT = Number(process.env.PORTBOARD_PORT ?? 8790);
// A preview (any other port) gets its own config/state dir, seeded once from production's prefs and clients.
await seedPreview();
console.log(describe());
if (SITE.fileError) console.error(`[portboard] ${SITE.file}: ${SITE.fileError}`);
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
};

const ts = await tailscaleInfo();
const tsIPv4 = ts.ips.find((ip) => ip.includes('.'));
const bindHosts = (process.env.PORTBOARD_HOSTS ?? ['127.0.0.1', tsIPv4].filter(Boolean).join(','))
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

// DNS-rebinding guard: only answer to names that actually mean this machine. A wildcard bind (0.0.0.0, ::) adds this
// machine's own interface addresses; PORTBOARD_ALLOWED_HOSTS adds names (devbox.lan) for a LAN install (#12).
const allowedHosts = hostAllowlist({ bindHosts, ts, hostname: hostname(), extra: process.env.PORTBOARD_ALLOWED_HOSTS });

// Who may write (#12): tailscale mode unless access.json or PORTBOARD_ACCESS_MODE says token. Read again on every
// write; this is only what the log says at start.
const policy = await loadAccessPolicy(PATHS.access, PATHS.token);
if (policy.mode === 'token') {
  console.log(`[portboard] access: token mode${policy.requireTokenOnLoopback ? ', token required on loopback too' : ''}; ${policy.tokenHash ? 'owner token set' : 'no owner token yet: run `portboard token`'}`);
} else if (process.env.PORTBOARD_REQUIRE_TOKEN_ON_LOOPBACK) {
  console.error('[portboard] PORTBOARD_REQUIRE_TOKEN_ON_LOOPBACK applies in token mode only (PORTBOARD_ACCESS_MODE=token)');
}
if (policy.error) console.error(`[portboard] access: ${policy.error}`);
const outside = outsideAddrs(bindHosts);
if (outside.length && policy.mode !== 'token') {
  console.error(`[portboard] listening on ${outside.join(', ')} (outside loopback and the tailnet): read-only there; writes from the LAN need token mode (docs/setup.md#without-tailscale)`);
}

const ctx = await createServerContext(PATHS, ts);
// Writes: X-Portboard, then owner only (loopback, or the owner's login through tailscale serve), all in the audit log.
const router = appRouter(REGISTRY.routes, ctx);

// On every answer (security review v1.0, L3): no page may frame the dashboard (clickjacking its write buttons),
// no MIME sniffing, no Referer to the links it opens. Nothing in public/ is meant to be framed.
const SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function hostOk(req: IncomingMessage): boolean {
  const raw = (req.headers.host ?? '').toLowerCase();
  const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.replace(/:\d+$/, '');
  return allowedHosts.has(host);
}

async function serveStatic(path: string, res: ServerResponse) {
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 404, { error: 'not found' });
  try {
    let body: Buffer | string = await readFile(file);
    // The shell's markup (src/core/shell.ts) fills the page's <!--#shell:…--> markers, so the first paint has the bar
    // and sidebar; scripts the features declare (registry ui) go in before </body>, as the pages used to carry them.
    if (file.endsWith('.html')) {
      const tags = uiTags(rel.replace(/^[/\\]+/, ''));
      body = expandShell(body.toString('utf8'), { hostname: hostname() });
      if (tags) body = body.replace('</body>', `${tags}</body>`);
    }
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

// Like the remote server (src/remote.ts): slow or idle clients can't hold sockets open forever, and a cap bounds the
// file descriptors one listener uses. requestTimeout bounds receiving a request, not answering it (a worktree scan
// may take seconds).
const LIMITS = { requestTimeout: 30_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 };
const MAX_CONNECTIONS = 256;

// The text the server writes into an answer (errors, the setup checklist, suggestions) is in the page's language:
// lib/shell-boot.js keeps it in the pb_locale cookie (src/core/i18n.ts). Without one, the server's locale.
const handler = (req: IncomingMessage, res: ServerResponse) => withLocale(requestLocale(req.headers) ?? SITE.locale, () => handle(req, res));

const handle = async (req: IncomingMessage, res: ServerResponse) => {
  try {
    if (!hostOk(req)) return send(res, 421, { error: 'unknown host' });
    // 설정 체크리스트: when the Mac's menu bar plugin last asked (its User-Agent; a write every 10 min at most)
    noteMenubar(req);
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const routed = await router(req, url, ctx);
    if (routed) return send(res, routed.status, routed.body);
    if (req.method === 'GET' && !path.startsWith('/api/')) return serveStatic(path, res);
    send(res, 404, { error: 'not found' });
  } catch (err) {
    // Never the error's text to the client (paths, command output): a generic message and an id; the detail is logged.
    const out = internalError(err, `${req.method} ${(req.url ?? '').split('?')[0]}`);
    if (res.headersSent) res.destroy();
    else send(res, out.status, out.body);
  }
};

// One server per listen address, each with the same limits.
const servers = bindHosts.map(() => {
  const s = createServer(LIMITS, handler);
  s.maxConnections = MAX_CONNECTIONS;
  return s;
});
bindHosts.forEach((host, i) => {
  // Fatal on purpose: at boot the Tailscale IP may not exist yet; systemd restarts us.
  servers[i].on('error', (err) => {
    console.error(`[portboard] ${host}:${PORT} ${err.message}`);
    process.exit(1);
  });
  servers[i].listen(PORT, host, () => console.log(`[portboard] listening on http://${host}:${PORT}`));
});
if (ts.dnsName) console.log(`[portboard] tailnet: http://${ts.dnsName}:${PORT}`);

const started = startJobs(REGISTRY.jobs, ctx);
if (started.length) console.log(`[portboard] jobs: ${started.join(', ')}`);
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    // Each feature flushes what it keeps in memory (history, uptime); one failing doesn't stop the others.
    Promise.all(
      REGISTRY.features.flatMap((f) => (f.shutdown ? [f.shutdown(ctx).catch((err) => console.error(`[portboard] ${f.name}: ${err}`))] : [])),
    ).finally(() => process.exit(0));
  });
}
