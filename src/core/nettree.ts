// The network hierarchy behind the 기기 sidebar and the 기기 tab's 구조 view (docs/devices-tab/): which tailnet node
// routes which LAN, which Proxmox host runs which guests, and how the tailnet reaches each LAN machine. Pure: the
// devices (devices.ts), the Proxmox tree (proxmox.ts) and the LAN addresses this server knows in, a tree out.
//
//   tailnet
//   ├─ subnet routers and Proxmox hosts           (kind host)
//   │  ├─ guests: VMs and containers              (kind guest; a guest that routes a subnet carries its LAN group)
//   │  └─ LAN <cidr> · <router>가 라우팅            (kind subnet; on the primary router, members listed once)
//   │     └─ LAN machines in that CIDR            (kind device, reach tailnet | routed | arp)
//   ├─ 직접 연결: the other tailnet devices        (kind group, key direct)
//   └─ 그 밖의 LAN 기기: LAN clients outside every routed subnet   (kind group, key other)
//
// Every device appears once: a guest under its host, a host at the top, a LAN machine in the most specific routed
// subnet that holds it, everything else under 직접 연결. Funnel/ingress peers never get here (devices.ts drops them).

import type { Device } from './devices.ts';
import type { Guest, ProxmoxStatus, PveHost } from './proxmox.ts';

/** How the tailnet reaches a LAN machine: its own Tailscale address, only through the subnet router, or unknown (ARP) */
export type Reach = 'tailnet' | 'routed' | 'arp';
export type RouteRole = 'primary' | 'standby';

/** A LAN address this server knows that may belong to no device */
export interface LanHost {
  ip: string;
  mac: string | null;
  name: string;
  /** client: connected to this server (or named by the user); neighbor: only in this server's ARP table */
  seen: 'client' | 'neighbor';
}

export interface NetNode {
  /** Stable within a tree, for the collapse state: host:<id>, guest:<node>/<vmid>, subnet:<cidr>@<router>, dev:<id>, lan:<ip>, direct, other */
  key: string;
  kind: 'host' | 'guest' | 'subnet' | 'device' | 'group';
  name: string;
  /** What a click opens: a devices.ts id or lan:<ip> (the 기기 tab's card id); null when it has neither */
  device: string | null;
  /** null for subnets and groups */
  online: boolean | null;
  self: boolean;
  os: string | null;
  tailscaleIps: string[];
  lanIps: string[];
  path: Device['path'];
  /** How many listening ports are known for it; null when nobody reports them */
  ports: number | null;
  /** host: it is this Proxmox node */
  proxmox?: { node: string; status: string };
  /** host (or a guest that routes): the subnets it advertises */
  routes?: { cidr: string; role: RouteRole }[];
  guest?: { node: string; vmid: number; type: Guest['type']; status: string; lanOnly: boolean };
  /** subnet: router is the device id advertising it here; primary is the router the tailnet uses (null: none is) */
  subnet?: { cidr: string; router: string; role: RouteRole; primary: string | null; standby: string[] };
  /** device under a subnet */
  reach?: Reach;
  /** device under a subnet: how its LAN address was tied to it (devices.ts lanVia) */
  lanVia?: string;
  children: NetNode[];
}

export interface NetTree {
  roots: NetNode[];
}

export interface NetTreeInput {
  devices: Device[];
  proxmox: ProxmoxStatus | null;
  /** LAN clients and ARP neighbours; the ones that are a device or a guest are dropped here */
  lanHosts: LanHost[];
  /** This server's own LAN addresses (devices.ts leaves the self device's lanIps empty) */
  selfLanIps: string[];
}

/** IPv4 only: is ip inside a.b.c.d/n? */
export function inCidr(ip: string, cidr: string): boolean {
  const [net, bits] = cidr.split('/');
  const n = Number(bits);
  const a = v4(ip);
  const b = v4(net);
  if (a === null || b === null || !Number.isInteger(n) || n < 0 || n > 32) return false;
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

export function v4(s: string): number | null {
  const p = s.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

/** An exit node's default routes are not a LAN */
const isExit = (cidr: string) => cidr === '0.0.0.0/0' || cidr === '::/0';
const prefixLen = (cidr: string) => Number(cidr.split('/')[1] ?? 0);
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const byOnlineName = (a: Device, b: Device) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name);

interface Claim {
  device: Device;
  primary: boolean;
}

export function buildNetTree(inp: NetTreeInput): NetTree {
  const devs = inp.devices;
  const byId = new Map(devs.map((d) => [d.id, d]));
  const lanOf = (d: Device) => (d.self ? uniq([...d.lanIps, ...inp.selfLanIps]) : d.lanIps);
  const portsOf = (d: Device | undefined) => (d?.ports ? d.ports.ports.length : null);

  // ---- who routes what: per CIDR, the primary router and the standbys ----
  const claims = new Map<string, Claim[]>();
  for (const d of devs) {
    const add = (cidr: string, primary: boolean) => {
      if (isExit(cidr)) return;
      const list = claims.get(cidr) ?? [];
      if (!list.some((c) => c.device === d)) list.push({ device: d, primary });
      claims.set(cidr, list);
    };
    for (const r of d.routes) add(r, true);
    for (const r of d.standbyRoutes ?? []) add(r, false);
  }
  /** cidr → the router whose subnet node lists the members (the primary; else the best standby) */
  const owner = new Map<string, { device: Device; role: RouteRole; standby: Device[] }>();
  for (const [cidr, list] of claims) {
    const sorted = [...list].sort((a, b) => Number(b.primary) - Number(a.primary) || byOnlineName(a.device, b.device));
    const top = sorted[0];
    owner.set(cidr, { device: top.device, role: top.primary ? 'primary' : 'standby', standby: sorted.slice(1).map((c) => c.device) });
  }
  const routesOf = (d: Device): { cidr: string; role: RouteRole }[] =>
    [...claims].filter(([, list]) => list.some((c) => c.device === d)).map(([cidr]) => ({ cidr, role: owner.get(cidr)!.device === d ? owner.get(cidr)!.role : 'standby' }));

  const placed = new Set<string>();
  /** LAN addresses already shown (a host's, a guest's): never listed again as a LAN machine */
  const usedIps = new Set<string>();
  const ownerNodes = new Map<string, NetNode>();

  const deviceNode = (d: Device, kind: NetNode['kind'], key: string): NetNode => ({
    key, kind, name: d.name, device: d.id, online: d.online, self: d.self, os: d.os,
    tailscaleIps: d.tailscaleIps, lanIps: lanOf(d), path: d.path, ports: portsOf(d), children: [],
  });

  const subnetNodes = (d: Device): NetNode[] =>
    routesOf(d).map(({ cidr }) => {
      const o = owner.get(cidr)!;
      const mine = o.device === d;
      const node: NetNode = {
        key: `subnet:${cidr}@${d.id}`, kind: 'subnet', name: `LAN ${cidr}`, device: null, online: null, self: false, os: null,
        tailscaleIps: [], lanIps: [], path: null, ports: null,
        subnet: {
          cidr, router: d.id, role: mine ? o.role : 'standby',
          primary: o.role === 'primary' ? o.device.id : null,
          standby: mine ? o.standby.map((s) => s.id) : [],
        },
        children: [],
      };
      if (mine) ownerNodes.set(cidr, node);
      return node;
    });

  const markDevice = (d: Device) => {
    placed.add(d.id);
    for (const ip of lanOf(d)) usedIps.add(ip);
  };

  // ---- hosts: Proxmox nodes, then subnet routers that are neither a Proxmox node nor a guest ----
  const pveHosts = inp.proxmox?.hosts ?? [];
  const hostDevice = (h: PveHost) =>
    (h.device ? byId.get(h.device) : undefined) ?? devs.find((d) => d.id.toLowerCase() === h.node.toLowerCase());
  const guestDevice = (g: Guest) => (g.device && !g.device.startsWith('lan:') ? byId.get(g.device) : undefined);
  const guestDevices = new Set(pveHosts.flatMap((h) => h.guests.filter((g) => !g.template).map(guestDevice)).filter((d): d is Device => !!d));

  const hosts: NetNode[] = [];
  for (const h of pveHosts) {
    const d = hostDevice(h);
    if (d && guestDevices.has(d)) continue; // nested Proxmox: shown as that guest
    const node: NetNode = d
      ? deviceNode(d, 'host', `host:${d.id}`)
      : {
          key: `host:${h.node}`, kind: 'host', name: h.node, device: null, online: h.status === 'online', self: false, os: null,
          tailscaleIps: [], lanIps: h.ip ? [h.ip] : [], path: null, ports: h.ports ? h.ports.ports.length : null, children: [],
        };
    node.proxmox = { node: h.node, status: h.status };
    if (d) {
      markDevice(d);
      if (node.ports == null && h.ports) node.ports = h.ports.ports.length;
    }
    if (h.ip) {
      usedIps.add(h.ip);
      if (!node.lanIps.includes(h.ip)) node.lanIps = [...node.lanIps, h.ip];
    }
    const guests = h.guests.filter((g) => !g.template).sort((a, b) => a.vmid - b.vmid);
    node.children = guests.map((g) => guestNode(h, g));
    if (d) {
      const routes = routesOf(d);
      if (routes.length) node.routes = routes;
      node.children.push(...subnetNodes(d));
    }
    hosts.push(node);
  }

  function guestNode(h: PveHost, g: Guest): NetNode {
    const d = guestDevice(g);
    const lanId = g.device?.startsWith('lan:') ? g.device : null;
    const lanIp = g.lanIp ?? (lanId ? lanId.slice(4) : null) ?? g.ips.find((x) => v4(x) !== null) ?? null;
    const node: NetNode = d
      ? deviceNode(d, 'guest', `guest:${h.node}/${g.vmid}`)
      : {
          key: `guest:${h.node}/${g.vmid}`, kind: 'guest', name: g.name, device: lanId, online: g.status === 'running', self: false,
          os: null, tailscaleIps: [], lanIps: [], path: null, ports: g.ports ? g.ports.ports.length : null, children: [],
        };
    // the Proxmox name is what the host calls it; a tailnet name that differs stays visible on the device's card
    node.name = g.name;
    if (lanIp && !node.lanIps.includes(lanIp)) node.lanIps = [...node.lanIps, lanIp];
    if (node.ports == null && g.ports) node.ports = g.ports.ports.length;
    node.guest = { node: h.node, vmid: g.vmid, type: g.type, status: g.status, lanOnly: !d && !!lanIp };
    for (const ip of node.lanIps) usedIps.add(ip);
    if (d) {
      markDevice(d);
      const routes = routesOf(d);
      if (routes.length) {
        node.routes = routes;
        node.children = subnetNodes(d);
      }
    }
    return node;
  }

  for (const d of [...devs].sort(byOnlineName)) {
    if (placed.has(d.id) || guestDevices.has(d) || !routesOf(d).length) continue;
    const node = deviceNode(d, 'host', `host:${d.id}`);
    node.routes = routesOf(d);
    node.children = subnetNodes(d);
    markDevice(d);
    hosts.push(node);
  }
  hosts.sort((a, b) => Number(b.online) - Number(a.online) || Number(!!b.proxmox) - Number(!!a.proxmox) || a.name.localeCompare(b.name));

  // ---- LAN members: the most specific routed subnet that holds the address ----
  const ownedCidrs = [...ownerNodes.keys()].sort((a, b) => prefixLen(b) - prefixLen(a));
  const subnetFor = (ip: string) => ownedCidrs.find((c) => inCidr(ip, c));
  const members = new Map<string, NetNode[]>();
  const join = (cidr: string, node: NetNode) => members.set(cidr, [...(members.get(cidr) ?? []), node]);

  for (const d of [...devs].sort(byOnlineName)) {
    if (placed.has(d.id)) continue;
    const ip = lanOf(d).find((x) => subnetFor(x));
    if (!ip) continue;
    const node = deviceNode(d, 'device', `dev:${d.id}`);
    node.reach = d.tailscaleIps.length ? 'tailnet' : 'routed';
    if (d.lanVia[ip]) node.lanVia = d.lanVia[ip];
    markDevice(d);
    join(subnetFor(ip)!, node);
  }

  // a device's address is the device's, wherever the device is shown
  for (const d of devs) for (const ip of lanOf(d)) usedIps.add(ip);
  const lanHosts = new Map<string, LanHost>();
  for (const l of inp.lanHosts) {
    if (usedIps.has(l.ip) || v4(l.ip) === null) continue;
    const had = lanHosts.get(l.ip);
    if (!had || (had.seen === 'neighbor' && l.seen === 'client')) lanHosts.set(l.ip, l);
  }
  const other: NetNode[] = [];
  for (const l of lanHosts.values()) {
    const cidr = subnetFor(l.ip);
    if (!cidr && l.seen === 'neighbor') continue; // an ARP entry outside every routed LAN (docker bridges…) is noise
    const node: NetNode = {
      key: `lan:${l.ip}`, kind: 'device', name: l.name, device: `lan:${l.ip}`, online: null, self: false, os: null,
      tailscaleIps: [], lanIps: [l.ip], path: null, ports: null, children: [],
    };
    if (cidr) {
      node.reach = l.seen === 'client' ? 'routed' : 'arp';
      join(cidr, node);
    } else other.push(node);
  }

  const REACH: Record<Reach, number> = { tailnet: 0, routed: 1, arp: 2 };
  const ipNum = (n: NetNode) => v4(n.lanIps[0] ?? '') ?? 0;
  for (const [cidr, node] of ownerNodes) {
    node.children = (members.get(cidr) ?? []).sort((a, b) => REACH[a.reach!] - REACH[b.reach!] || ipNum(a) - ipNum(b));
  }

  // ---- 직접 연결: every device not shown yet; then LAN clients outside every routed subnet ----
  const direct = devs
    .filter((d) => !placed.has(d.id))
    .sort((a, b) => Number(b.self) - Number(a.self) || byOnlineName(a, b))
    .map((d) => deviceNode(d, 'device', `dev:${d.id}`));

  const group = (key: string, name: string, children: NetNode[]): NetNode => ({
    key, kind: 'group', name, device: null, online: null, self: false, os: null, tailscaleIps: [], lanIps: [], path: null, ports: null, children,
  });
  const roots = [...hosts];
  if (direct.length) roots.push(group('direct', '직접 연결', direct));
  if (other.length) roots.push(group('other', '그 밖의 LAN 기기', other.sort((a, b) => ipNum(a) - ipNum(b))));
  return { roots };
}

/** Every node, depth first (tests, counts) */
export function* walk(nodes: NetNode[], depth = 0): Generator<{ node: NetNode; depth: number }> {
  for (const node of nodes) {
    yield { node, depth };
    yield* walk(node.children, depth + 1);
  }
}
