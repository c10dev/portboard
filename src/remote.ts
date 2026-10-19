// Read-only remote MCP server for claude.ai custom connectors and ChatGPT (Streamable HTTP + OAuth 2.1).
// Listens on loopback and this node's Tailscale IP only; making it public (Tailscale Funnel) is a separate,
// deliberate step — see docs/remote-mcp/README.md.
//
//   node src/remote.ts                 serve on :8794 (PORTBOARD_REMOTE_PORT, PORTBOARD_REMOTE_HOSTS)
//   node src/remote.ts approve         print a one-time approval code (10 min) for the consent page
//   node src/remote.ts status          clients, live tokens, pending code (no secrets)
//   node src/remote.ts revoke [id]     drop every token (or one client's tokens and registration)

import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { freePorts, snapshot, type Snapshot } from './core/index.ts';
import { devices } from './core/devices.ts';
import { defaultChecker } from './core/alerts.ts';
import { loadKnown, pendingView } from './core/known.ts';
import { loadState as loadMemoryState, MEMORY_STATE, statusLine } from './core/memory.ts';
import { serveStatus, tailscaleInfo } from './core/tailscale.ts';
import { resolveDashboardUrl, SITE } from './core/site.ts';
import { topology } from './core/topology.ts';
import { usage, type Usage } from './core/usage.ts';
import { createRemoteHandler } from './remote/http.ts';
import { settingsPageUrl } from './remote/oauth.ts';
import { Store } from './remote/store.ts';
import { describe, PATHS, PRODUCTION_PORT, seedPreview } from './core/paths.ts';
import type { RemoteCore } from './remote/tools.ts';

const store = new Store();
const cmd = process.argv[2] ?? 'serve';

if (cmd === 'approve') {
  const { code, expiresAt } = await store.newApprovalCode();
  await store.ensurePrivate();
  console.log(`approval code: ${code}`);
  console.log(`valid until ${new Date(expiresAt).toLocaleTimeString()}, one use. Type it on the Portboard consent page.`);
  process.exit(0);
}

if (cmd === 'status') {
  const s = await store.read();
  const now = Date.now();
  console.log(`config: ${store.path}`);
  console.log(`public URL: ${s.publicUrl ?? '(not set: derived from the Host header)'}`);
  console.log(`redaction: showAddresses=${!!s.policy?.showAddresses} showProcesses=${!!s.policy?.showProcesses}`);
  console.log(`pending approval code: ${s.approval && s.approval.expiresAt > now ? `yes, ${Math.round((s.approval.expiresAt - now) / 60_000)} min left` : 'no'}`);
  const live = Object.values(s.tokens).filter((t) => t.expiresAt > now);
  const byClient = new Map<string, { name: string; access: number; refresh: number }>();
  for (const t of live) {
    if (t.kind === 'used') continue;
    const e = byClient.get(t.clientId) ?? { name: t.clientName, access: 0, refresh: 0 };
    e[t.kind]++;
    byClient.set(t.clientId, e);
  }
  console.log(`registered clients: ${Object.keys(s.clients).length}`);
  for (const [id, c] of Object.entries(s.clients)) console.log(`  ${id}  ${c.name}  last used ${new Date(c.lastUsedAt).toISOString()}`);
  console.log(`clients with live tokens: ${byClient.size}`);
  for (const [id, e] of byClient) console.log(`  ${id}  ${e.name}  access=${e.access} refresh=${e.refresh}`);
  process.exit(0);
}

if (cmd === 'revoke') {
  const n = await store.revoke(process.argv[3]);
  console.log(`revoked ${n} token(s)${process.argv[3] ? ` and client ${process.argv[3]}` : ''}`);
  process.exit(0);
}

if (cmd !== 'serve') {
  console.error('usage: node src/remote.ts [serve|approve|status|revoke [client_id]]');
  process.exit(2);
}

const PORT = Number(process.env.PORTBOARD_REMOTE_PORT ?? 8794);
// A remote preview (any other port) keeps its own remote.json, so it never shares production's OAuth state.
await seedPreview();
console.error(describe().replace('[portboard]', '[portboard-remote]'));
if (SITE.fileError) console.error(`[portboard-remote] ${SITE.file}: ${SITE.fileError}`);
const ts = await tailscaleInfo();
const tsIPv4 = ts.ips.find((ip) => ip.includes('.'));
const bindHosts = (process.env.PORTBOARD_REMOTE_HOSTS ?? ['127.0.0.1', tsIPv4].filter(Boolean).join(','))
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);
if (bindHosts.some((h) => h === '0.0.0.0' || h === '::')) {
  console.error('[portboard-remote] refusing to bind a wildcard address; publish through Tailscale Funnel instead');
  process.exit(2);
}

const state = await store.read();
if (await store.ensurePrivate()) console.error(`[portboard-remote] ${store.path} or its folder was open to others; set to 600 / 700`);
let publicHost: string | null = null;
if (state.publicUrl) {
  try {
    publicHost = new URL(state.publicUrl).hostname.toLowerCase();
  } catch {
    console.error('[portboard-remote] remote.json publicUrl is not a URL');
    process.exit(2);
  }
}
const hosts = new Set(
  ['localhost', '127.0.0.1', '::1', hostname(), ts.hostName, ts.dnsName, ...ts.ips, ...bindHosts, publicHost]
    .filter((h): h is string => !!h)
    .map((h) => h.toLowerCase()),
);

// Same 2 s caching as the dashboard: a burst of tool calls shares one `ss` + probe run.
const cached = <T>(fn: () => Promise<T>, ttl = 2_000) => {
  let hit: { at: number; value: Promise<T> } | null = null;
  return () => {
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = fn();
    hit = { at: Date.now(), value };
    value.catch(() => (hit = null));
    return value;
  };
};
const getSnapshot = cached<Snapshot>(snapshot);
const getUsage = cached<Usage>(async () => usage(await topology(await getSnapshot())));
// portboard://status only: down state of watched ports/devices (alerts-state.json, prefs.json), the number of
// pending 새 기기 (known-devices.json), and memory pressure as numbers (memory-state.json). The checker is never
// started; the alert channel it can read is never copied.
const statusExtras = cached(async () => {
  const [st, known] = await Promise.all([defaultChecker(async () => []).status().catch(() => null), loadKnown().catch(() => null)]);
  const memory = await loadMemoryState(join(PATHS.stateDir, MEMORY_STATE)).then((f) => statusLine(f), () => null);
  return { watching: st?.watching ?? null, newDevices: known ? pendingView(known).length : null, memory };
});
const core: RemoteCore = { snapshot: getSnapshot, devices: cached(() => devices()), freePorts, usage: getUsage, statusExtras };

// The consent page links the dashboard's 설정 tab, where the owner makes the approval code: the https address
// tailscale serve publishes the dashboard on (8443), or PORTBOARD_DASHBOARD_URL, or portboard.json's dashboardUrl. Tailnet only, which is fine: the
// owner opens it from one of their own devices.
const dashboard = resolveDashboardUrl(ts.dnsName, await serveStatus().catch(() => []), Number(process.env.PORTBOARD_PORT ?? PRODUCTION_PORT));
const settingsUrl = settingsPageUrl(dashboard);
const handler = createRemoteHandler({ core, store, hosts, publicUrl: state.publicUrl, settingsUrl });
const servers = bindHosts.map(() => {
  const s = createServer({ requestTimeout: 30_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 }, handler);
  s.maxHeadersCount = 64;
  s.maxConnections = 256; // Funnel multiplexes everyone onto loopback; a cap keeps slow clients from exhausting fds
  return s;
});
bindHosts.forEach((host, i) => {
  servers[i].on('error', (err) => {
    console.error(`[portboard-remote] ${host}:${PORT} ${err.message}`);
    process.exit(1);
  });
  servers[i].listen(PORT, host, () => console.error(`[portboard-remote] listening on http://${host}:${PORT}/mcp`));
});
if (state.publicUrl) console.error(`[portboard-remote] public URL (issuer): ${state.publicUrl}`);
console.error(`[portboard-remote] approval codes: ${settingsUrl ?? 'the dashboard 설정 tab (its address is unknown: no tailscale serve entry for it)'}`);
