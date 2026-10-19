// Who is using what right now, one card per device: devices.ts (tailnet peers + compute-pool hosts) joined with
// topology.ts connections, and LAN clients named from `ip neigh` + the OUI list + user-given names.
//
//   usage()  → { cards, local, byPort, idleServices }   (GET /api/usage, the 기기 tab and the 사용 중 chips)

import { neighbors, lanIdentity, loadNames, nameKey, ouiTable, resolveName, vendorOf, isRandomMac, type NameSource, type Neighbor } from './clients.ts';
import { inCidr, type NetTree } from './nettree.ts';
import { devices, type Device, type Devices, type PvePortsState, type SelfVirt } from './devices.ts';
import type { WinPortsStatus } from './winports.ts';
import type { PortGroup, PortKind } from './index.ts';
import type { PoolHost } from './pool.ts';
import type { Guest, PveHost } from './proxmox.ts';
import { topology, type Edge, type ServiceNode, type Topology } from './topology.ts';
import { t as tr } from './i18n.ts';

export interface UseRow {
  port: number;
  /** Short display name: user label, or the detected name without "(…)" and " — tagline" */
  service: string;
  fullName: string;
  kind: PortKind;
  url: string | null;
  via: Edge['via'];
  servePort: number | null;
  connections: number;
  bytesSent: number;
  bytesReceived: number;
  rttMs: number | null;
  since: string;
  /** client processes, for this server's own connections */
  processes: string[];
  /**
   * Set when the connection came through this device acting as a Tailscale subnet router: the router rewrites the
   * source to its own LAN address (SNAT), so the device that really connected can't be known from here.
   */
  routed: boolean;
}

/** funnel: Tailscale Funnel traffic, i.e. the public internet (claude.ai's connector…), one card for all of it */
export type CardKind = 'self' | 'tailnet' | 'pool' | 'lan' | 'funnel' | 'other';

export interface DeviceCard {
  /** devices.ts id (Tailscale DNS label or pool:<name>), lan:<ip>, or a topology client id */
  id: string;
  name: string;
  nameSource: NameSource;
  kind: CardKind;
  os: string | null;
  /** IEEE organisation for the LAN MAC */
  vendor: string | null;
  mac: string | null;
  randomMac: boolean;
  /** How it is connected to this server right now */
  networks: ('tailnet' | 'lan' | 'other')[];
  /** Addresses its current connections come from */
  addresses: string[];
  tailscaleIps: string[];
  lanIps: string[];
  online: boolean;
  lastSeen: string | null;
  path: Device['path'];
  pool: PoolHost | null;
  poolMatch: Device['poolMatch'];
  /** Its listening ports (other machines only), from compute-pool or read over SSH from the Proxmox host */
  ports: Device['ports'];
  portsSource: Device['portsSource'];
  /** Set when the user can name this card (POST /api/clients/name) */
  nameKey: string | null;
  lanVia: Device['lanVia'];
  /** Subnets it routes for the tailnet */
  routes: string[];
  /** This server: VM detection */
  virt: SelfVirt | null;
  /** This device is a Proxmox VM/container */
  guestOf: { node: string; hostDevice: string | null; vmid: number; type: Guest['type']; status: string; match: Guest['deviceMatch'] } | null;
  /** This device is a Proxmox host: its status and guests (each guest's device id when it has a card) */
  pveHost: PveHost | null;
  uses: UseRow[];
  connections: number;
  bytes: number;
}

export interface PortUser {
  id: string;
  name: string;
  /** routed: came through this device as a subnet router; the original device is unknown */
  kind: CardKind | 'local' | 'routed';
  /** for routed: the router's card id, its name and the subnets it routes (the chip explains the route) */
  via?: string;
  viaName?: string;
  routes?: string[];
  connections: number;
}

export interface Usage {
  at: string;
  observingSince: string;
  /** Devices using something first (most connections first), then this server, then the rest */
  cards: DeviceCard[];
  /** Connections from processes on this server itself */
  local: { connections: number; uses: UseRow[] };
  byPort: Record<number, PortUser[]>;
  /** Services shown in the port list that nobody is using */
  idleServices: number;
  /** Those services, for listing them grouped (same compose project, unit or process) */
  idle: { port: number; service: string; group: PortGroup | null }[];
  pool: Devices['pool'];
  /** This server's own LAN addresses (what a subnet-routed client connected to) */
  selfLanIps: string[];
  proxmox: { configured: boolean; ok: boolean; error?: string; looseMode?: boolean; hosts: number };
  /** The SSH port reader for the Proxmox host: for the 기기 tab's setup hint */
  pvePorts: PvePortsState | null;
  /** The SSH port reader for the desktop's Windows side: for its setup hint */
  winPorts: WinPortsStatus | null;
  /** The network hierarchy (nettree.ts), for the 기기 tab's 구조 view; node.device is a card id here */
  tree: NetTree | null;
}

/** LAN addresses connected to this server now (devices() lists them in the tree, and probes their SSH host keys) */
export const lanClientsOf = (t: Topology) => t.clients.filter((c) => c.kind === 'lan' && c.address).map((c) => c.address!);

export async function usage(topo?: Topology): Promise<Usage> {
  const t = topo ?? (await topology());
  const lanClients = lanClientsOf(t);
  const [devs, neigh, oui, names] = await Promise.all([devices({ lanClients }), neighbors(), ouiTable(), loadNames()]);
  return buildUsage({ topology: t, devices: devs, neighbors: neigh, oui, names });
}

export interface UsageInput {
  topology: Topology;
  devices: Devices;
  neighbors: Map<string, Neighbor>;
  oui: Map<string, string>;
  names: Record<string, string>;
}

export function buildUsage(inp: UsageInput): Usage {
  const t = inp.topology;
  const svc = new Map(t.services.map((s) => [s.port, s]));
  const cards = new Map<string, DeviceCard>();

  for (const d of inp.devices.devices) {
    const lanUser = d.lanIps.map((ip) => inp.names[nameKey(ip, inp.neighbors.get(ip)?.mac ?? null)]).find(Boolean);
    const pool = d.id.startsWith('pool:');
    const { name, source } = resolveName({ user: lanUser, tailscale: pool ? null : d.name, pool: pool ? d.name : null, ip: d.name });
    cards.set(d.id, {
      id: d.id,
      name,
      nameSource: source,
      kind: d.self ? 'self' : pool ? 'pool' : 'tailnet',
      os: d.os,
      vendor: null,
      mac: null,
      randomMac: false,
      networks: [],
      addresses: [],
      tailscaleIps: d.tailscaleIps,
      lanIps: d.lanIps,
      lanVia: d.lanVia,
      routes: d.routes,
      virt: d.virt ?? null,
      guestOf: null,
      pveHost: null,
      online: d.online,
      lastSeen: d.lastSeen,
      path: d.path,
      pool: d.pool,
      poolMatch: d.poolMatch,
      ports: d.ports,
      portsSource: d.portsSource,
      nameKey: null,
      uses: [],
      connections: 0,
      bytes: 0,
    });
  }
  const pve = inp.devices.proxmox;
  for (const h of pve?.hosts ?? []) {
    const host = h.device ? cards.get(h.device) : undefined;
    if (host) host.pveHost = h;
    for (const g of h.guests) {
      let c = g.device ? cards.get(g.device) : undefined;
      // A container with ports but no Tailscale (jellyfin): its LAN card, even while nothing connects from it.
      if (!c && g.ports && g.device?.startsWith('lan:')) {
        c = lanCard(g.device.slice(4), inp);
        cards.set(c.id, c);
      }
      if (!c) continue;
      c.guestOf = { node: h.node, hostDevice: h.device, vmid: g.vmid, type: g.type, status: g.status, match: g.deviceMatch };
      if (c.kind === 'lan' && (c.nameSource === 'vendor' || c.nameSource === 'ip')) {
        c.name = g.name;
        c.nameSource = 'proxmox';
      }
      if (g.ports && !c.ports) {
        c.ports = g.ports;
        c.portsSource = 'pve-ssh';
      }
    }
  }
  const selfLan = t.self.lanIps;
  const byLanIp = new Map<string, DeviceCard>();
  for (const c of cards.values()) for (const ip of c.lanIps) byLanIp.set(ip, c);

  const local: Usage['local'] = { connections: 0, uses: [] };
  const clients = new Map(t.clients.map((c) => [c.id, c]));

  for (const e of t.edges) {
    const client = clients.get(e.from);
    if (!client) continue;
    if (client.kind === 'local') {
      addUse(local.uses, e, svc.get(e.port));
      local.connections += e.connections;
      continue;
    }
    let card: DeviceCard | undefined;
    let net: DeviceCard['networks'][number] = 'other';
    let routed = false;
    if (client.kind === 'device') {
      card = cards.get(client.id.slice(4));
      net = 'tailnet';
    } else if (client.kind === 'funnel') {
      card = cards.get(client.id) ?? blank(client.id, client.label, 'funnel', 'funnel', {});
      net = 'other';
    } else if (client.kind === 'lan' && client.address) {
      // Same machine as a known device when compute-pool reaches that device at this LAN address.
      card = byLanIp.get(client.address) ?? lanCard(client.address, inp);
      net = 'lan';
      // From the LAN address of a subnet router that routes our own LAN: tailnet traffic it forwarded (SNAT).
      routed = card.routes.some((r) => selfLan.some((ip) => inCidr(ip, r)));
    }
    card ??= otherCard(client, inp);
    if (net === 'lan' && client.address && !card.mac) {
      card.mac = inp.neighbors.get(client.address)?.mac ?? null;
      card.randomMac = !!card.mac && isRandomMac(card.mac);
      card.vendor = card.mac ? vendorOf(card.mac, inp.oui) : null;
    }
    cards.set(card.id, card);
    if (!card.networks.includes(net)) card.networks.push(net);
    if (client.address && !card.addresses.includes(client.address)) card.addresses.push(client.address);
    addUse(card.uses, e, svc.get(e.port), routed);
    card.connections += e.connections;
    card.bytes += e.bytesSent + e.bytesReceived;
  }

  const byPort: Usage['byPort'] = {};
  const push = (port: number, u: PortUser) => {
    const list = (byPort[port] ??= []);
    const same = list.find((x) => x.id === u.id);
    if (same) same.connections += u.connections;
    else list.push(u);
  };
  for (const c of cards.values()) {
    for (const u of c.uses) {
      if (u.routed) push(u.port, { id: `${c.id}~routed`, name: tr('usageMsg.routed', { name: c.name }), kind: 'routed', via: c.id, viaName: c.name, routes: c.routes, connections: u.connections });
      else push(u.port, { id: c.id, name: c.name, kind: c.kind, connections: u.connections });
    }
  }
  for (const u of local.uses) push(u.port, { id: 'local', name: tr('common.thisServer'), kind: 'local', connections: u.connections });
  for (const list of Object.values(byPort)) list.sort((a, b) => Number(a.kind === 'local') - Number(b.kind === 'local') || b.connections - a.connections);

  const used = new Set(t.edges.map((e) => e.port));
  const idle = t.services.filter((s) => s.visible && !used.has(s.port));
  const rank = (c: DeviceCard) => (c.connections ? 0 : c.kind === 'self' ? 1 : 2);
  const sorted = [...cards.values()].sort(
    (a, b) => rank(a) - rank(b) || b.connections - a.connections || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name),
  );
  for (const c of sorted) c.uses.sort((a, b) => b.connections - a.connections || a.port - b.port);
  local.uses.sort((a, b) => b.connections - a.connections || a.port - b.port);

  return {
    at: t.at,
    observingSince: t.observingSince,
    cards: sorted,
    local,
    byPort,
    idleServices: idle.length,
    idle: idle.map((s) => ({ port: s.port, service: s.labeled ? s.name : displayName(s.name), group: s.group ?? null })),
    pool: inp.devices.pool,
    selfLanIps: t.self.lanIps,
    proxmox: {
      configured: pve?.configured ?? false,
      ok: pve?.ok ?? false,
      ...(pve?.error ? { error: pve.error } : {}),
      ...(pve?.looseMode ? { looseMode: true } : {}),
      hosts: pve?.hosts.length ?? 0,
    },
    pvePorts: inp.devices.pvePorts ?? null,
    winPorts: inp.devices.winPorts ?? null,
    tree: inp.devices.tree ?? null,
  };
}

export { inCidr } from './nettree.ts';

function lanCard(ip: string, inp: UsageInput): DeviceCard {
  const { name, source, vendor, mac, randomMac, key } = lanIdentity(ip, inp.neighbors.get(ip)?.mac ?? null, inp.names, inp.oui);
  return blank(`lan:${ip}`, name, source, 'lan', { vendor, mac, randomMac, nameKey: key, lanIps: [ip] });
}

function otherCard(client: Topology['clients'][number], inp: UsageInput): DeviceCard {
  const key = client.address ? nameKey(client.address, null) : null;
  const user = key ? inp.names[key] : null;
  return blank(client.id, user || client.label, user ? 'user' : 'ip', 'other', { nameKey: key });
}

function blank(id: string, name: string, nameSource: NameSource, kind: CardKind, extra: Partial<DeviceCard>): DeviceCard {
  return {
    id, name, nameSource, kind,
    os: null, vendor: null, mac: null, randomMac: false, networks: [], addresses: [], tailscaleIps: [], lanIps: [],
    online: true, lastSeen: null, path: null, pool: null, poolMatch: null, ports: null, portsSource: null, nameKey: null,
    lanVia: {}, routes: [], virt: null, guestOf: null, pveHost: null,
    uses: [], connections: 0, bytes: 0,
    ...extra,
  };
}

function addUse(rows: UseRow[], e: Edge, s: ServiceNode | undefined, routed = false) {
  const row = rows.find((r) => r.port === e.port && r.via === e.via && r.routed === routed);
  if (row) {
    row.connections += e.connections;
    row.bytesSent += e.bytesSent;
    row.bytesReceived += e.bytesReceived;
    if (e.since < row.since) row.since = e.since;
    for (const p of e.processes) if (!row.processes.includes(p)) row.processes.push(p);
    return;
  }
  const full = s?.name ?? `:${e.port}`;
  rows.push({
    port: e.port,
    service: s && !s.labeled ? displayName(full) : full,
    fullName: full,
    kind: s?.kind ?? 'app',
    url: s?.url ?? null,
    via: e.via,
    servePort: e.servePort,
    connections: e.connections,
    bytesSent: e.bytesSent,
    bytesReceived: e.bytesReceived,
    rttMs: e.rttMs,
    since: e.since,
    processes: [...e.processes],
    routed,
  });
}

/** "compute-pool monitor (host health, …)" → "compute-pool monitor"; "Portboard — listening ports…" → "Portboard" */
export function displayName(name: string): string {
  const cut = name.split(/\s+\(|\s+[—–|]\s+|\s+-\s+/)[0].trim();
  return cut || name;
}
