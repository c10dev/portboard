// `portboard agent` (c10dev/portboard#10): serve this machine's ports, usage, load and status (Claude Code sessions,
// checkouts: machine_status) read-only to the board on another machine, over the tailnet. The routes, who may read and what leaves are in src/agent/server.ts; docs/multi-host.md has
// the setup.
//
//   node src/agent.ts      serve on :8797 (portboard.json agent.port, PORTBOARD_AGENT_PORT) on loopback and this
//                          node's Tailscale IPv4 (PORTBOARD_AGENT_HOSTS: a comma list instead; never a wildcard)
//
// Readers: portboard.json agent.allow / PORTBOARD_AGENT_ALLOW (Tailscale nodes, logins or tags), or the shared token
// agent.token / PORTBOARD_AGENT_TOKEN. With neither, only loopback can read.

import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { ttlCache } from './core/cache.ts';
import { run } from './core/exec.ts';
import { snapshot, type Snapshot } from './core/index.ts';
import { devices } from './core/devices.ts';
import { hostLoad } from './core/hostload.ts';
import { localStatus } from './core/machines.ts';
import { loadReservations } from './core/reservations.ts';
import { scanWorktrees, type WorktreesDoc } from './core/worktrees.ts';
import { PRODUCTION_PORT } from './core/paths.ts';
import { SITE } from './core/site.ts';
import { tailscaleInfo } from './core/tailscale.ts';
import { topology } from './core/topology.ts';
import { usage, type Usage } from './core/usage.ts';
import { dashboardReader, dashboardSources } from './remote/dashboard.ts';
import { AGENT_SCHEMA, createAgentHandler, identityResolver, type AgentInfo, type StatusParts } from './agent/server.ts';
import { loadSavedWorktrees, SAVED_FRESH_MS } from './features/worktrees.ts';
import { VERSION } from './version.ts';

const log = (line: string) => console.error(`[portboard-agent] ${line}`);
if (process.argv[2] && process.argv[2] !== 'serve') {
  console.error('usage: portboard agent');
  process.exit(2);
}
if (SITE.fileError) log(`${SITE.file}: ${SITE.fileError}`);

const cfg = SITE.agent;
const PORT = Number(process.env.PORTBOARD_AGENT_PORT ?? cfg.port);
const envList = (v: string | undefined) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const allow = [...new Set([...cfg.allow, ...envList(process.env.PORTBOARD_AGENT_ALLOW)])];
const token = process.env.PORTBOARD_AGENT_TOKEN || cfg.token;
const policy = { showAddresses: cfg.showAddresses, showProcesses: false, showPaths: cfg.showPaths };

const ts = await tailscaleInfo();
const tsIPv4 = ts.ips.find((ip) => ip.includes('.'));
const bindHosts = (process.env.PORTBOARD_AGENT_HOSTS ?? ['127.0.0.1', tsIPv4].filter(Boolean).join(','))
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);
if (bindHosts.some((h) => h === '0.0.0.0' || h === '::')) {
  log('refusing to bind a wildcard address: the agent is for the tailnet only');
  process.exit(2);
}
if (!allow.length && !token) log('no agent.allow and no token: only this machine (loopback) can read. docs/multi-host.md');
const hosts = new Set(
  ['localhost', '127.0.0.1', '::1', hostname(), ts.hostName, ts.dnsName, ...ts.ips, ...bindHosts].filter((h): h is string => !!h).map((h) => h.toLowerCase()),
);

// The dashboard's own cached answers when it runs on this machine too (as the remote server does, #5), else computed here.
const fromDashboard = dashboardSources(dashboardReader({ port: Number(process.env.PORTBOARD_PORT ?? PRODUCTION_PORT), log }), {
  snapshot,
  devices: () => devices(),
  usage: async () => usage(await topology(await getSnapshot())),
});
const getSnapshot = ttlCache<Snapshot>(() => fromDashboard.snapshot(), { ttlMs: 2_000 });
const getUsage = ttlCache<Usage>(() => fromDashboard.usage(), { ttlMs: 5_000 });

const getInfo = ttlCache<AgentInfo>(
  async () => ({ schema: AGENT_SCHEMA, version: VERSION, host: ts.hostName ?? hostname().split('.')[0], dnsName: ts.dnsName, at: Date.now(), load: await hostLoad() }),
  { ttlMs: 2_000 },
);

// /status's checkouts: the dashboard's saved scan while it is recent (it scans every 15 minutes), else a scan of our
// own in the background, every 15 minutes, never while a status request waits (the board reads with a 4 s timeout)
let ownScan: WorktreesDoc | null = null;
const scanNow = () =>
  scanWorktrees({ mode: 'incremental', withSize: false }).then(
    (d) => void (ownScan = d),
    (err) => log(`worktree scan: ${(err as Error).message}`),
  );
async function worktreesNow(): Promise<WorktreesDoc | null> {
  const saved = await loadSavedWorktrees();
  if (saved?.at && Date.now() - Date.parse(saved.at) < SAVED_FRESH_MS) return saved;
  return ownScan ?? saved;
}
void scanNow();
setInterval(() => void scanNow(), 15 * 60_000).unref();
const getStatus = ttlCache<StatusParts>(
  () => localStatus({ host: ts.hostName ?? hostname().split('.')[0], snapshot: getSnapshot, worktrees: worktreesNow, reservations: () => loadReservations() }),
  { ttlMs: 10_000 },
);

const handler = createAgentHandler({
  sources: { snapshot: getSnapshot, usage: getUsage, info: getInfo, status: getStatus },
  auth: { allow, token, whois: identityResolver({ run: (args) => run('tailscale', args, 3_000) }) },
  policy,
  hosts,
  log,
});
for (const host of bindHosts) {
  const s = createServer({ requestTimeout: 30_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 }, handler);
  s.maxHeadersCount = 64;
  s.maxConnections = 128;
  s.on('error', (err) => {
    // Fatal on purpose: at boot the Tailscale IP may not exist yet; systemd restarts us.
    log(`${host}:${PORT} ${err.message}`);
    process.exit(1);
  });
  s.listen(PORT, host, () => log(`listening on http://${host}:${PORT}/agent/v1/info`));
}
log(`readers: ${[allow.length ? `tailscale ${allow.join(', ')}` : null, token ? 'bearer token' : null, 'loopback'].filter(Boolean).join(' · ')}`);
