// Who is connected to this server right now: tailnet devices and other clients → listening services.
//
//   topology()  → { self, clients, services, edges } from snapshot() + `tailscale status` + `ss state established`
//
// Read-only. "Since" is when this process first saw a connection (ss has no socket age).

import { readFile, readlink } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { parseEstablished, type Connection } from './conn.ts';
import { SELF_UNIT } from './control.ts';
import { run, runShared } from './exec.ts';
import { snapshot, type PortEntry, type PortGroup, type PortKind, type Snapshot } from './index.ts';
import { classify, type BindScope } from './ss.ts';
import { parsePeers } from './devices.ts';
import { servedUrl } from './tailscale.ts';

export type Peer = ReturnType<typeof parsePeers>[number];

export type ClientKind = 'device' | 'tailnet' | 'local' | 'lan' | 'docker' | 'internet' | 'serve' | 'funnel';

/** The pseudo-client for Tailscale Funnel traffic: the public internet (claude.ai's connector and the like) */
export const FUNNEL_LABEL = 'Funnel (공개, claude.ai 등)';

/** Where connections come from: a tailnet device (dev:<DNS label>), or a pseudo-node for addresses that aren't one. */
export interface ClientNode {
  id: string;
  kind: ClientKind;
  label: string;
  /** The peer address, for lan / tailnet / internet */
  address: string | null;
}

export interface ServiceNode {
  port: number;
  name: string;
  /** name is the user's label rather than a detected one */
  labeled: boolean;
  scope: BindScope | null;
  kind: PortKind;
  visible: boolean;
  owner: string | null;
  project: string | null;
  url: string | null;
  /** loopback connections from a hidden (root) owner into a `tailscale serve` upstream — the proxy's own legs */
  proxyConnections: number;
  /** snapshot() grouping: other ports of the same compose project, unit or process */
  group: PortGroup | null;
}

export interface Edge {
  id: string;
  from: string;
  port: number;
  /** serve: arrived at tailscaled's HTTPS listener and was proxied to this port */
  via: 'direct' | 'serve';
  servePort: number | null;
  connections: number;
  /** server → client */
  bytesSent: number;
  /** client → server */
  bytesReceived: number;
  rttMs: number | null;
  /** client process names, for local clients */
  processes: string[];
  peers: string[];
  since: string;
}

export interface Topology {
  at: string;
  observingSince: string;
  self: {
    hostname: string;
    dnsName: string | null;
    os: string;
    tailscaleIps: string[];
    lanIps: string[];
  };
  /** Only clients that have a connection right now */
  clients: ClientNode[];
  services: ServiceNode[];
  edges: Edge[];
  outboundConnections: number;
}

/** First topology() call; connections already open then are stamped with it ("at least since") */
let startedAt: number | null = null;
const seen = new Map<string, number>();

export async function topology(snap?: Snapshot): Promise<Topology> {
  const [s, ts, est] = await Promise.all([
    snap ?? snapshot(),
    runShared('tailscale', ['status', '--json']),
    run('ss', ['-tnpiH', 'state', 'established']),
  ]);
  const conns = parseEstablished(est.stdout);
  const portboards = await otherPortboards(conns);

  const now = Date.now();
  startedAt ??= now;
  const keys = new Set(conns.map(connKey));
  for (const k of seen.keys()) if (!keys.has(k)) seen.delete(k);
  for (const k of keys) if (!seen.has(k)) seen.set(k, now);

  return buildTopology({
    snapshot: s,
    peers: ts.ok ? parsePeers(ts.stdout) : [],
    conns,
    lanIps: lanAddresses(),
    selfIps: Object.values(networkInterfaces()).flatMap((a) => (a ?? []).map((x) => x.address.replace(/%.*$/, ''))),
    firstSeen: (c) => seen.get(connKey(c)) ?? now,
    startedAt: startedAt ?? now,
    selfPid: process.pid,
    probePids: portboards,
  });
}

/**
 * Other Portboard processes on this machine (a preview, the MCP server) probe every port's HTTP title too.
 * Their connections are not anyone using the service, and would otherwise show up as "이 서버" use in the history.
 */
async function otherPortboards(conns: Connection[]): Promise<number[]> {
  // Node names its main thread MainThread, so ss shows either name; read the cmdline of every client pid (a few dozen).
  const pids = [...new Set(conns.flatMap((c) => c.processes.map((p) => p.pid)))];
  const hits = await Promise.all(
    pids.map(async (pid) => {
      const [cmd, cwd] = await Promise.all([
        readFile(`/proc/${pid}/cmdline`, 'utf8').then((s) => s.split('\0').join(' ')).catch(() => ''),
        readlink(`/proc/${pid}/cwd`).catch(() => ''),
      ]);
      return isPortboard(cmd, cwd) ? pid : null;
    }),
  );
  return hits.filter((p): p is number => p !== null);
}

export function isPortboard(cmdline: string, cwd: string): boolean {
  const m = /(?:^|\s)(\S*?)src\/(server|mcp)\.ts(?:\s|$)/.exec(cmdline);
  if (!m) return false;
  return /portboard/i.test(m[1] || cwd);
}

const connKey = (c: Connection) => `${c.local.address}:${c.local.port}>${c.peer.address}:${c.peer.port}`;

function lanAddresses(): string[] {
  return Object.entries(networkInterfaces())
    .filter(([name]) => !/^(lo|tailscale|docker|br-|veth)/.test(name))
    .flatMap(([, addrs]) => (addrs ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.address));
}

export interface TopologyInput {
  snapshot: Snapshot;
  /** devices.ts parsePeers(): Self first, then peers */
  peers: Peer[];
  conns: Connection[];
  lanIps: string[];
  /** Every address of this host; a connection from one of them is local */
  selfIps: string[];
  firstSeen: (c: Connection) => number;
  startedAt: number;
  selfPid?: number;
  /** Other Portboard processes; their connections are title probes, not use */
  probePids?: number[];
}

const WILDCARD = new Set(['*', '0.0.0.0', '::']);

export function buildTopology(inp: TopologyInput): Topology {
  const { snapshot: snap } = inp;
  const listening = snap.ports.filter((p) => p.listening);
  const byPort = new Map(listening.map((p) => [p.port, p]));
  const dns = snap.tailscale.dnsName;

  // tailscaled's own HTTPS listener port → the local port it proxies to
  const serveFront = new Map<number, number>();
  const serveUpstreams = new Set<number>();
  /** upstream port → its Funnel front port (AllowFunnel in `tailscale serve status`) */
  const funnelFront = new Map<number, number>();
  for (const p of snap.ports) {
    if (p.served?.upstreamPort == null) continue;
    serveFront.set(p.served.httpsPort, p.served.upstreamPort);
    serveUpstreams.add(p.served.upstreamPort);
    if (p.served.funnel) funnelFront.set(p.served.upstreamPort, p.served.httpsPort);
  }

  const devByIp = new Map<string, Peer>();
  for (const d of inp.peers) if (!d.self) for (const ip of d.ips) devByIp.set(ip.toLowerCase(), d);

  const selfIps = new Set([...inp.selfIps, ...snap.tailscale.ips].map((a) => a.toLowerCase()));
  const isLocal = (a: string) => isLoopback(a) || selfIps.has(a.toLowerCase());
  // Portboard's own HTTP title probes (this process or the portboard unit) aren't clients worth drawing.
  const probePids = new Set(
    snap.ports.flatMap((p) => p.processes.filter((x) => x.unit === SELF_UNIT || x.pid === inp.selfPid).map((x) => x.pid)),
  );
  if (inp.selfPid) probePids.add(inp.selfPid);
  for (const pid of inp.probePids ?? []) probePids.add(pid);
  const mirror = new Map(inp.conns.map((c) => [`${c.local.address}:${c.local.port}>${c.peer.address}:${c.peer.port}`, c]));

  const clients = new Map<string, ClientNode>();
  const edges = new Map<string, Edge & { _since: number; _rtts: number[] }>();
  const proxy = new Map<number, number>();
  let outbound = 0;

  for (const c of inp.conns) {
    const svc = byPort.get(c.local.port);
    if (!svc || !bindMatches(svc, c.local.address)) {
      if (!isLocal(c.peer.address)) outbound++;
      continue;
    }

    let port = c.local.port;
    let via: Edge['via'] = 'direct';
    let servePort: number | null = null;
    const upstream = serveFront.get(port);
    if (upstream !== undefined && classify(c.local.address) === 'tailnet' && byPort.has(upstream)) {
      servePort = port;
      port = upstream;
      via = 'serve';
    }

    const peer = c.peer.address;
    let client: ClientNode;
    let processes: string[] = [];
    if (isLocal(peer)) {
      const back = mirror.get(`${peer}:${c.peer.port}>${c.local.address}:${c.local.port}`);
      if (back?.processes.some((p) => probePids.has(p.pid))) continue;
      if (!back?.processes.length && serveUpstreams.has(port)) {
        // tailscaled (root, owner hidden) proxying a serve request. The tailnet side shows up as its own
        // connection to tailscaled's listener; these back legs can't be paired with it, so count them only.
        proxy.set(port, (proxy.get(port) ?? 0) + 1);
        continue;
      }
      client = { id: 'local', kind: 'local', label: '이 서버 (로컬)', address: null };
      processes = back?.processes.map((p) => `${p.name} (${p.pid})`) ?? [];
    } else {
      client = clientFor(peer, devByIp);
    }
    if (!clients.has(client.id)) clients.set(client.id, client);

    const id = `${client.id}>${port}${via === 'serve' ? `@${servePort}` : ''}`;
    let e = edges.get(id);
    if (!e) {
      e = {
        id,
        from: client.id,
        port,
        via,
        servePort,
        connections: 0,
        bytesSent: 0,
        bytesReceived: 0,
        rttMs: null,
        processes: [],
        peers: [],
        since: '',
        _since: Infinity,
        _rtts: [],
      };
      edges.set(id, e);
    }
    e.connections++;
    e.bytesSent += c.bytesSent ?? 0;
    e.bytesReceived += c.bytesReceived ?? 0;
    if (c.rttMs !== null) e._rtts.push(c.rttMs);
    for (const p of processes) if (!e.processes.includes(p)) e.processes.push(p);
    if (e.peers.length < 20) e.peers.push(`${fmtAddr(peer)}:${c.peer.port}`);
    e._since = Math.min(e._since, inp.firstSeen(c));
  }

  // Serve back legs with no tailnet-side connection left: show them, but don't guess the device.
  // On a Funnel port they are the public internet: Funnel requests reach tailscaled without a kernel socket on the
  // front port, so only the back legs are seen. Legs beyond the tailnet-side connections count as Funnel (approximate:
  // tailscaled may keep idle upstream connections open).
  for (const [port, n] of proxy) {
    const paired = [...edges.values()].filter((e) => e.port === port && e.via === 'serve').reduce((a, e) => a + e.connections, 0);
    const funnelPort = funnelFront.get(port);
    const count = funnelPort !== undefined ? n - paired : paired ? 0 : n;
    if (count <= 0) continue;
    const from = funnelPort !== undefined ? 'funnel' : 'serve';
    const id = `${from}>${port}`;
    clients.set(
      from,
      from === 'funnel'
        ? { id: 'funnel', kind: 'funnel', label: FUNNEL_LABEL, address: null }
        : { id: 'serve', kind: 'serve', label: 'tailscale serve · 기기 미확인', address: null },
    );
    edges.set(id, {
      id,
      from,
      port,
      via: 'serve',
      servePort: funnelPort ?? [...serveFront].find(([, up]) => up === port)?.[0] ?? null,
      connections: count,
      bytesSent: 0,
      bytesReceived: 0,
      rttMs: null,
      processes: [],
      peers: [],
      since: '',
      _since: inp.startedAt,
      _rtts: [],
    });
  }

  const edgeList: Edge[] = [...edges.values()]
    .map(({ _since, _rtts, ...e }) => ({
      ...e,
      rttMs: _rtts.length ? Math.round((_rtts.reduce((a, b) => a + b, 0) / _rtts.length) * 10) / 10 : null,
      since: new Date(Math.max(_since, inp.startedAt)).toISOString(),
    }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.port - b.port);


  const services: ServiceNode[] = listening
    .filter((p) => !serveFront.has(p.port) || p.owned) // tailscaled's own HTTPS listener is folded into the upstream
    .map((p) => serviceNode(p, dns, proxy.get(p.port) ?? 0));

  const self = inp.peers.find((p) => p.self);
  return {
    at: snap.at,
    observingSince: new Date(inp.startedAt).toISOString(),
    self: {
      hostname: snap.host.hostname,
      dnsName: dns,
      os: self?.os ?? 'linux',
      tailscaleIps: snap.tailscale.ips,
      lanIps: inp.lanIps,
    },
    clients: [...clients.values()],
    services,
    edges: edgeList,
    outboundConnections: outbound,
  };
}

function bindMatches(p: PortEntry, address: string): boolean {
  return p.addresses.some((a) => WILDCARD.has(a) || a.toLowerCase() === address.toLowerCase());
}

function isLoopback(a: string): boolean {
  return a.startsWith('127.') || a === '::1';
}

function fmtAddr(a: string): string {
  return a.includes(':') ? `[${a}]` : a;
}

function clientFor(ip: string, devByIp: Map<string, Peer>): ClientNode {
  const dev = devByIp.get(ip.toLowerCase());
  if (dev) return { id: `dev:${dev.name}`, kind: 'device', label: dev.name, address: ip };
  if (classify(ip) === 'tailnet') return { id: `ts:${ip}`, kind: 'tailnet', label: `tailnet ${ip} · 미확인 기기`, address: ip };
  const p = ip.split('.').map(Number);
  if (p.length === 4 && p[0] === 172 && (p[1] === 17 || p[1] === 18)) {
    return { id: 'docker', kind: 'docker', label: 'Docker 컨테이너', address: null };
  }
  if (isPrivate(ip)) return { id: `lan:${ip}`, kind: 'lan', label: `LAN ${ip}`, address: ip };
  return { id: `net:${ip}`, kind: 'internet', label: `인터넷 ${ip}`, address: ip };
}

function isPrivate(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length === 4) return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
  const l = ip.toLowerCase();
  return l.startsWith('fe80:') || l.startsWith('fc') || l.startsWith('fd');
}

function serviceNode(p: PortEntry, dns: string | null, proxyConnections: number): ServiceNode {
  const proc = p.processes[0];
  return {
    port: p.port,
    name: p.name,
    labeled: !!p.label,
    scope: p.scope,
    kind: p.kind,
    visible: p.visible,
    owner: p.container ? `docker: ${p.container}` : (proc?.unit ?? proc?.cmdline.split(' ')[0].split('/').pop() ?? null),
    project: proc?.project ?? null,
    url: p.urls.served ?? p.urls.direct ?? (p.served && dns ? servedUrl(dns, p.served.httpsPort) : null),
    proxyConnections,
    group: p.group ?? null,
  };
}
