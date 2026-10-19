// Devices: this server and its tailnet peers (tailscale status), joined with compute-pool's host status
// (CPU, memory, disk, rotation) where a pool host can be matched to a device.
//
// Matching, in order: the pool's local host is this server; a pool host whose address is one of a device's
// Tailscale IPs (an agent's connecting address); deviceLinks in prefs.json ({"desktop": "desktop-pc"}) for hosts the
// pool reaches over the LAN, since Tailscale doesn't tell us a peer's LAN address.

import { networkInterfaces } from 'node:os';
import { agents as agentsCollector, agentStatus, type AgentRead, type AgentStatus } from './agents.ts';
import { lanIdentity, loadNames, neighbors, ouiTable } from './clients.ts';
import { run, runShared } from './exec.ts';
import { cachedKeys, probeLater, sameMachine } from './hostkeys.ts';
import { fromListening, hostPorts, type HostPorts, type PortsDevice } from './hostports.ts';
import { poolStatus, type PoolHost, type PoolStatus } from './pool.ts';
import { loadPrefs } from './prefs.ts';
import { buildNetTree, type LanHost, type NetTree } from './nettree.ts';
import { matchGuests, proxmoxStatus, type ProxmoxStatus } from './proxmox.ts';
import { pvePorts, type PvePortsData, type PvePortsStatus } from './pveports.ts';
import { winPorts, type WinPortsData, type WinPortsStatus } from './winports.ts';

export interface Device {
  /** Tailscale DNS label (dev-mac), or pool:<name> for a pool host with no matching device */
  id: string;
  name: string;
  /** Full MagicDNS name (dev-mac.tail1234.ts.net), null for a pool host with no matching device */
  dnsName: string | null;
  os: string | null;
  self: boolean;
  /** Tailscale's view; for a pool-only host, whether the monitor can reach it */
  online: boolean;
  lastSeen: string | null;
  tailscaleIps: string[];
  /** How this server reaches it: direct (with the endpoint) or via a DERP relay; null when idle or unknown */
  path: { type: 'direct'; endpoint: string } | { type: 'relay'; region: string } | null;
  /** LAN addresses of this device: compute-pool ssh targets, a matching SSH host key, or the Proxmox cluster IP */
  lanIps: string[];
  /** How each LAN address was tied to this device */
  lanVia: Record<string, 'compute-pool' | 'ssh-hostkey' | 'proxmox'>;
  /** Subnets this device routes for the tailnet (Tailscale subnet router): the ones it is the primary router for */
  routes: string[];
  /** Approved subnets it advertises but another router serves now (high-availability standby); exit routes left out */
  standbyRoutes: string[];
  /** This server only: running as a VM */
  virt?: SelfVirt;
  pool: PoolHost | null;
  /** How the pool host was matched: self, address or link (prefs.json deviceLinks) */
  poolMatch: 'self' | 'address' | 'link' | null;
  /**
   * Its listening ports: a pool host's as compute-pool reports them, or a Proxmox host's / container's as read over
   * SSH from the host (pveports.ts); null when neither has them (this server: see list_ports)
   */
  ports: HostPorts | null;
  /**
   * Where ports came from; a compute-pool or agent host whose Windows side is also read keeps its source (see
   * ports.sides). 'agent': its `portboard agent` (agents.ts), which wins over compute-pool when both report it.
   */
  portsSource: 'compute-pool' | 'pve-ssh' | 'windows-ssh' | 'agent' | null;
  /** Its `portboard agent`, when portboard.json lists one for it (#10): reachability, version and load */
  agent?: AgentStatus | null;
}

export interface SelfVirt {
  /** systemd-detect-virt: kvm, lxc, none… */
  type: string;
  /** a NIC with Proxmox's default MAC prefix BC:24:11 */
  proxmoxMac: boolean;
  macs: string[];
}

export interface Devices {
  at: string;
  pool: Omit<PoolStatus, 'hosts'>;
  devices: Device[];
  /** Proxmox hosts with their VMs/containers, guests matched to devices; configured=false without a token */
  proxmox: ProxmoxStatus;
  /** The SSH port reader for the Proxmox host (pveports.ts): ok, last ok, error code, and CTs it could not place */
  pvePorts: PvePortsState;
  /** The SSH port reader for the desktop's Windows side (winports.ts) */
  winPorts: WinPortsStatus;
  /** The network hierarchy: routers and Proxmox hosts, their guests and LANs, the rest (nettree.ts) */
  tree: NetTree;
  /** Every agent portboard.json lists, with the device it was put on (#10) */
  agents?: (AgentStatus & { device: string | null })[];
}

export interface PvePortsState extends PvePortsStatus {
  /** vmids of container sections that matched no Proxmox guest (no token, or a CT the API doesn't list) */
  unmatched: number[];
}

interface Peer {
  name: string;
  dnsName: string;
  hostName: string;
  os: string | null;
  self: boolean;
  online: boolean;
  lastSeen: string | null;
  ips: string[];
  curAddr: string;
  relay: string;
  active: boolean;
  routes: string[];
  standbyRoutes: string[];
}

/**
 * Tailscale's own relay nodes are not devices: with Funnel on, the netmap carries a couple dozen shared-in
 * "funnel-ingress-node" peers (ShareeNode, tag:ingress, no DNS name).
 */
export function isInfrastructurePeer(p: any): boolean {
  const tags: unknown[] = Array.isArray(p?.Tags) ? p.Tags : [];
  return tags.includes('tag:ingress') || p?.HostName === 'funnel-ingress-node' || (!!p?.ShareeNode && !p?.DNSName);
}

export function parsePeers(json: string): Peer[] {
  let st: any;
  try {
    st = JSON.parse(json);
  } catch {
    return [];
  }
  const one = (p: any, self: boolean): Peer => {
    const dns = typeof p?.DNSName === 'string' ? p.DNSName.replace(/\.$/, '') : '';
    const seen = typeof p?.LastSeen === 'string' && !p.LastSeen.startsWith('0001-') ? p.LastSeen : null;
    const routes: string[] = Array.isArray(p?.PrimaryRoutes) ? p.PrimaryRoutes.filter((r: unknown) => typeof r === 'string') : [];
    return {
      name: dns.split('.')[0] || p?.HostName || '?',
      dnsName: dns,
      hostName: p?.HostName ?? '',
      os: p?.OS || null,
      self,
      online: self || !!p?.Online,
      lastSeen: seen,
      ips: Array.isArray(p?.TailscaleIPs) ? p.TailscaleIPs : [],
      curAddr: p?.CurAddr ?? '',
      relay: p?.Relay ?? '',
      active: !!p?.Active,
      routes,
      standbyRoutes: standbyRoutes(p, routes),
    };
  };
  const peers = Object.values<any>(st?.Peer ?? {})
    .filter((p) => !isInfrastructurePeer(p))
    .map((p) => one(p, false));
  return st?.Self ? [one(st.Self, true), ...peers] : peers;
}

/**
 * AllowedIPs holds a peer's own addresses and every approved route it advertises; PrimaryRoutes is the subset the
 * control plane picked it as the router for. A subnet in the first and not the second: another router is primary.
 */
function standbyRoutes(p: any, primary: string[]): string[] {
  const own = new Set<string>((Array.isArray(p?.TailscaleIPs) ? p.TailscaleIPs : []).map((ip: string) => `${ip}/${ip.includes(':') ? 128 : 32}`));
  const allowed: unknown[] = Array.isArray(p?.AllowedIPs) ? p.AllowedIPs : [];
  return allowed.filter((r): r is string =>
    typeof r === 'string' && r.includes('/') && !own.has(r) && !primary.includes(r) && r !== '0.0.0.0/0' && r !== '::/0');
}

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export function mergeDevices(peers: Peer[], pool: PoolHost[], links: Record<string, string>): Device[] {
  const devices: Device[] = peers.map((p) => ({
    id: p.name,
    name: p.name,
    dnsName: p.dnsName || null,
    os: p.os,
    self: p.self,
    online: p.online,
    lastSeen: p.online ? null : p.lastSeen,
    tailscaleIps: p.ips,
    path: p.self ? null : p.curAddr ? { type: 'direct', endpoint: p.curAddr } : p.relay && p.active ? { type: 'relay', region: p.relay } : null,
    lanIps: [],
    lanVia: {},
    routes: p.routes,
    standbyRoutes: p.standbyRoutes,
    pool: null,
    poolMatch: null,
    ports: null,
    portsSource: null,
  }));

  for (const h of pool) {
    let d: Device | undefined;
    let how: Device['poolMatch'] = null;
    if (h.kind === 'local') {
      d = devices.find((x) => x.self);
      how = 'self';
    }
    if (!d) {
      d = devices.find((x) => !x.pool && x.tailscaleIps.some((ip) => h.addresses.includes(ip)));
      how = 'address';
    }
    if (!d && links[h.name]) {
      d = devices.find((x) => !x.pool && x.name.toLowerCase() === links[h.name].toLowerCase());
      how = 'link';
    }
    const lan = h.addresses.filter((a) => PRIVATE_V4.test(a));
    if (d) {
      d.pool = h;
      d.poolMatch = how;
      attachLan(d, lan, 'compute-pool');
    } else {
      devices.push({
        id: `pool:${h.name}`,
        name: h.name,
        dnsName: null,
        os: null,
        self: false,
        online: !['host-down', 'agent-away', 'unknown'].includes(h.state),
        lastSeen: null,
        tailscaleIps: h.addresses.filter((a) => /^100\.|^fd7a:/i.test(a)),
        path: null,
        lanIps: lan,
        lanVia: Object.fromEntries(lan.map((ip) => [ip, 'compute-pool' as const])),
        routes: [],
        standbyRoutes: [],
        pool: h,
        poolMatch: null,
        ports: null,
        portsSource: null,
      });
    }
  }

  for (const d of devices) {
    d.ports = hostPorts(d.pool, d);
    d.portsSource = d.ports ? 'compute-pool' : null;
  }

  // self first, then online, then by name
  return devices.sort((a, b) => Number(b.self) - Number(a.self) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

export function attachLan(d: Device, ips: string[], via: Device['lanVia'][string]) {
  for (const ip of ips) {
    if (!d.lanIps.includes(ip)) d.lanIps.push(ip);
    d.lanVia[ip] ??= via;
  }
}

/** LAN IP → device id for every LAN address already tied to a device */
export function lanOwners(list: Device[]): Map<string, string> {
  return new Map(list.flatMap((d) => d.lanIps.map((ip) => [ip, d.id] as [string, string])));
}

let virtCache: Promise<SelfVirt> | null = null;

/** Is this server a VM, and on Proxmox? (systemd-detect-virt + the NIC's MAC prefix; doesn't change while running) */
export function selfVirt(): Promise<SelfVirt> {
  virtCache ??= run('systemd-detect-virt', []).then((r) => {
    const macs = [...new Set(Object.values(networkInterfaces()).flatMap((a) => (a ?? []).filter((x) => !x.internal && x.mac !== '00:00:00:00:00:00').map((x) => x.mac.toUpperCase())))];
    return { type: r.stdout.trim() || 'unknown', proxmoxMac: macs.some((m) => m.startsWith('BC:24:11')), macs };
  });
  return virtCache;
}

/**
 * lanClients: LAN IPs seen connecting to this server; their SSH host keys are compared (in the background) with
 * the online tailnet devices' so 192.168.1.201 can become pve1. Results show up on a later call.
 */
export async function devices(opts: { lanClients?: string[] } = {}): Promise<Devices> {
  const [ts, pool, prefs, neigh, virt, pve, pp, wp, names, oui, ag] = await Promise.all([
    runShared('tailscale', ['status', '--json']),
    poolStatus(),
    loadPrefs(),
    neighbors(),
    selfVirt(),
    proxmoxStatus(),
    pvePorts().get(),
    winPorts().get(),
    loadNames(),
    ouiTable(),
    agentsCollector().get(),
  ]);
  const { hosts, ...poolMeta } = pool;
  const peers = ts.ok ? parsePeers(ts.stdout) : [];
  const list = mergeDevices(peers, hosts, prefs.deviceLinks ?? {});
  // Agents before the SSH readers: a device whose agent reports its ports keeps those (attachPvePorts gives only to
  // devices without ports; attachWinPorts merges the Windows side with them)
  const agentDevices = attachAgents(list, ag);
  const self = list.find((d) => d.self);
  if (self) self.virt = virt;

  // Same machine by SSH host key: LAN clients (and the Proxmox host's LAN address) against online tailnet devices.
  const lanClients = [...new Set([...(opts.lanClients ?? []), ...pve.hosts.flatMap((h) => (h.ip ? [h.ip] : []))])];
  const tailnet = peers.filter((p) => !p.self && p.online).map((p) => ({ name: p.name, ips: p.ips.filter((ip) => ip.includes('.')) }));
  probeLater([
    ...lanClients.map((ip) => ({ ip, tag: neigh.get(ip)?.mac ?? '' })),
    ...tailnet.flatMap((p) => p.ips.map((ip) => ({ ip }))),
  ]);
  for (const [ip, name] of sameMachine(lanClients, tailnet, cachedKeys)) {
    const d = list.find((x) => x.id === name);
    if (d && !lanOwners(list).has(ip)) attachLan(d, [ip], 'ssh-hostkey');
  }

  // Proxmox: the host node is its tailnet device by name; its cluster IP is then one of that device's LAN addresses.
  for (const h of pve.hosts) {
    const d = list.find((x) => x.id.toLowerCase() === h.node.toLowerCase());
    if (d && h.ip && !lanOwners(list).has(h.ip)) attachLan(d, [h.ip], 'proxmox');
  }
  const proxmox = matchGuests(pve, {
    self: { id: self?.id ?? '', macs: virt.macs },
    deviceIds: list.map((d) => d.id),
    neighbors: new Map([...neigh].map(([ip, n]) => [ip, n.mac])),
    lanOwner: lanOwners(list),
  });

  // A guest matched by name whose MAC was also seen on the LAN: that LAN address is the same machine.
  for (const g of proxmox.hosts.flatMap((h) => h.guests)) {
    const d = g.device && !g.device.startsWith('lan:') ? list.find((x) => x.id === g.device) : undefined;
    if (d && g.lanIp && !lanOwners(list).has(g.lanIp)) attachLan(d, [g.lanIp], 'proxmox');
  }

  const attached = attachPvePorts(list, proxmox, pp.data, pp.status.node);
  attachWinPorts(list, wp.data, wp.status.device);

  // The tree's LAN machines: clients seen connecting (and named ones whose MAC is in the ARP table), then the ARP table
  const lanHost = (ip: string, seen: LanHost['seen']): LanHost => {
    const mac = neigh.get(ip)?.mac ?? null;
    return { ip, mac, name: lanIdentity(ip, mac, names, oui).name, seen };
  };
  const named = [...neigh].filter(([ip, n]) => names[`mac:${n.mac}`] || names[`ip:${ip}`]).map(([ip]) => ip);
  const lanHosts = [
    ...[...new Set([...(opts.lanClients ?? []), ...named])].map((ip) => lanHost(ip, 'client')),
    ...[...neigh].filter(([, n]) => !/^(docker|br-|veth|tailscale)/.test(n.dev ?? '')).map(([ip]) => lanHost(ip, 'neighbor')),
  ];
  const tree = buildNetTree({ devices: list, proxmox: attached.proxmox, lanHosts, selfLanIps: selfLanIps() });
  return { at: new Date().toISOString(), pool: poolMeta, devices: list, proxmox: attached.proxmox, pvePorts: { ...pp.status, unmatched: attached.unmatched }, winPorts: wp.status, tree, agents: ag.map((a, i) => ({ ...agentStatus(a), device: agentDevices[i] })) };
}

/** This server's own LAN addresses (as topology.ts: not loopback, Tailscale or container bridges) */
function selfLanIps(): string[] {
  return Object.entries(networkInterfaces())
    .filter(([name]) => !/^(lo|tailscale|docker|br-|veth)/.test(name))
    .flatMap(([, addrs]) => (addrs ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.address));
}

/** Windows processes that forward a WSL port to Windows' localhost (NAT mode); their sockets are the WSL port again */
const WSL_FORWARD = new Set(['wslrelay', 'wslhost']);

/**
 * The desktop's Windows-side sockets (read over SSH) merged with its WSL-side ports (compute-pool) on one card, each
 * port marked windows or wsl. A Windows socket on a port WSL also listens on is that WSL port seen from Windows when
 * wslrelay/wslhost owns it or its owner can't be named (mirrored networking): it is dropped, not listed twice.
 * Mutates the device; returns the number of sockets folded into WSL ports.
 */
export function attachWinPorts(list: Device[], data: WinPortsData | null, deviceId: string): number {
  if (!data) return 0;
  const d = list.find((x) => x.id.toLowerCase() === deviceId.toLowerCase());
  if (!d) return 0;
  const wsl = (d.portsSource === 'compute-pool' || d.portsSource === 'agent') && d.ports ? d.ports : null;
  const wslPorts = new Set(wsl?.ports.map((p) => p.port) ?? []);
  const own = data.sockets.filter((s) => !(wslPorts.has(s.port) && (!s.process || WSL_FORWARD.has(s.process.toLowerCase()))));
  const win = fromListening(own, data.at, d).ports.map((p) => ({ ...p, side: 'windows' as const }));
  const merged = [...win, ...(wsl?.ports ?? []).map((p) => ({ ...p, side: 'wsl' as const }))];
  merged.sort((a, b) => a.port - b.port || a.side.localeCompare(b.side));
  d.ports = { at: Math.min(data.at, wsl?.at ?? data.at), ports: merged, sides: { windows: data.at, wsl: wsl?.at ?? null } };
  d.portsSource ??= 'windows-ssh';
  return data.sockets.length - own.length;
}

/**
 * Proxmox host and container ports (read over SSH) → the Proxmox tree and the matched devices. The host section goes
 * to the node named in pveports.json (pve1) and that tailnet device; each `## ct <vmid>` to that guest and its
 * device (nas by name; jellyfin, which has no Tailscale, by LAN IP — links then use that address). A device
 * that already has compute-pool ports keeps them. Mutates list's devices; returns the tree with ports attached.
 */
export function attachPvePorts(list: Device[], pve: ProxmoxStatus, data: PvePortsData | null, node: string): { proxmox: ProxmoxStatus; unmatched: number[] } {
  if (!data) return { proxmox: pve, unmatched: [] };
  const byId = new Map(list.map((d) => [d.id, d]));
  const reach = (deviceId: string | null, online: boolean, lanIps: string[]): PortsDevice => {
    const d = deviceId ? byId.get(deviceId) : undefined;
    if (d) return d;
    const ip = deviceId?.startsWith('lan:') ? deviceId.slice(4) : null;
    return { online, dnsName: null, tailscaleIps: [], lanIps: ip ? [ip] : lanIps };
  };
  const give = (deviceId: string | null, ports: HostPorts) => {
    const d = deviceId ? byId.get(deviceId) : undefined;
    if (d && !d.ports) {
      d.ports = ports;
      d.portsSource = 'pve-ssh';
    }
  };
  const used = new Set<number>();
  let hostDone = false;
  const hosts = pve.hosts.map((h) => {
    const mine = h.node.toLowerCase() === node.toLowerCase();
    let ports: HostPorts | null = h.ports ?? null;
    if (mine) {
      hostDone = true;
      ports = fromListening(data.host, data.at, reach(h.device, h.status === 'online', h.ip ? [h.ip] : []));
      give(h.device, ports);
    }
    const guests = h.guests.map((g) => {
      const listening = mine && g.type === 'lxc' ? data.cts[g.vmid] : undefined;
      if (!listening) return g;
      used.add(g.vmid);
      const gp = fromListening(listening, data.at, reach(g.device, g.status === 'running', [g.lanIp, ...g.ips].filter((x): x is string => !!x)));
      give(g.device, gp);
      return { ...g, ports: gp };
    });
    return { ...h, ports, guests };
  });
  // No Proxmox tree (no token): the host section still belongs to the tailnet device of that name.
  if (!hostDone) {
    const d = list.find((x) => x.id.toLowerCase() === node.toLowerCase());
    if (d) give(d.id, fromListening(data.host, data.at, d));
  }
  const unmatched = Object.keys(data.cts).map(Number).filter((id) => !used.has(id)).sort((a, b) => a - b);
  return { proxmox: { ...pve, hosts }, unmatched };
}

/** A device a `portboard agent` URL points at by address: its host when that is a Tailscale IP */
function urlTailnetIp(url: string): string | null {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(h) || /^fd7a:115c:a1e0:/i.test(h) ? h : null;
  } catch {
    return null;
  }
}

/**
 * Each agent → its tailnet device, matched by the agent's MagicDNS name, the Tailscale IP in its URL, then its name
 * (portboard.json's, or the host name it reports) against the device's. Its ports replace compute-pool's there (this
 * server keeps its own snapshot); an agent that matches no device gets a card of its own (id agent:<name>). An agent
 * that is down keeps its last good ports (ports.at says how old). Mutates list; returns each agent's device id.
 */
export function attachAgents(list: Device[], reads: AgentRead[]): (string | null)[] {
  return reads.map((a) => {
    const names = [a.name, a.info?.host].filter((x): x is string => !!x).map((x) => x.toLowerCase());
    const dns = a.info?.dnsName?.toLowerCase().replace(/\.$/, '') ?? null;
    const ip = urlTailnetIp(a.url);
    let d =
      (dns ? list.find((x) => x.dnsName?.toLowerCase() === dns) : undefined) ??
      (ip ? list.find((x) => x.tailscaleIps.includes(ip)) : undefined) ??
      list.find((x) => !x.agent && (names.includes(x.id.toLowerCase()) || names.includes(x.name.toLowerCase())));
    if (!d) {
      d = {
        id: `agent:${a.name}`,
        name: a.name,
        dnsName: dns,
        os: null,
        self: false,
        online: a.ok,
        lastSeen: null,
        tailscaleIps: ip ? [ip] : [],
        path: null,
        lanIps: [],
        lanVia: {},
        routes: [],
        standbyRoutes: [],
        pool: null,
        poolMatch: null,
        ports: null,
        portsSource: null,
      };
      list.push(d);
    }
    d.agent = agentStatus(a);
    if (!d.self && a.ports) {
      // links by the device's own Tailscale name, else the agent's; online as Tailscale says, else as the agent answered
      const reach = { online: d.online || a.ok, dnsName: d.dnsName ?? dns, tailscaleIps: d.tailscaleIps };
      d.ports = fromListening(a.ports.listening, a.ports.at, reach);
      d.portsSource = 'agent';
    }
    return d.id;
  });
}
