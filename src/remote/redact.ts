// What may leave the tailnet. Every remote tool result is built here by copying named fields into a new object
// (a projection), never by deleting fields from the core objects — a field another branch adds later stays
// local until someone lists it here. A regex scrub over the final text is the second net.
//
// Always dropped: cmdlines, cwd paths, SSH commands, pids, MACs, LAN / Tailscale / public IPs, subnet routes,
// the compute-pool and Proxmox URLs, Proxmox credentials and alert settings (never copied, never in the core types),
// worktree and dev-server paths, commit messages, package.json script commands and systemd unit descriptions.
// Kept: device and service names, ports, states, load numbers and the URLs that only open inside the tailnet.
// Two flags in remote.json loosen this for a private setup: showAddresses (IPs, MACs, routes, endpoints) and
// showProcesses (pids, client process names, and memory_usage's session titles, projects and process names).
// Both default to false.

import { createHmac, randomBytes } from 'node:crypto';
import type { MemoryStatus } from '../core/memory.ts';
import type { Snapshot } from '../core/index.ts';
import type { Devices, Device } from '../core/devices.ts';
import type { NetNode } from '../core/nettree.ts';
import type { PoolHost } from '../core/pool.ts';
import type { PveHost } from '../core/proxmox.ts';
import type { DeviceCard, Usage, UseRow } from '../core/usage.ts';
import type { WorktreeInfo, WorktreesDoc } from '../core/worktrees.ts';
import type { DevServersDoc } from '../features/devservers.ts';
import type { MemoryView } from '../features/memory.ts';
import { summarize, type ListArgs } from '../mcp/views.ts';
import { statusReport } from '../mcp/status.ts';

export interface RedactPolicy {
  showAddresses: boolean;
  showProcesses: boolean;
}

export const STRICT: RedactPolicy = { showAddresses: false, showProcesses: false };

// ---- the final net over every string ----

const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?:\/\d{1,2})?\b/g;
// Full and compressed IPv6 literals (at least two groups and a ::, or eight groups). Skips times like 12:33:32.
const IPV6 = /(?<![\w:])(?:[0-9a-f]{1,4}:){1,7}(?::[0-9a-f]{0,4}){1,7}(?:\/\d{1,3})?(?![\w:])|(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])/gi;
const MAC = /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi;
const HOME_PATH = /(?:\/home\/[^/\s"']+|\/root(?=\/|\b)|~(?=\/))(?:\/[^\s"',)]*)?/g;
// Other absolute paths (a unit description, an HTTP title like "Index of /srv/files", a `tailscale serve` path
// upstream). Not preceded by a host or path character, so URL paths stay.
const SYSTEM_PATH = /(?<![\w.:/~-])\/(?:srv|opt|var|tmp|mnt|media|data|etc|usr|run|snap|proc)\/[^\s"',)]*/g;
// "ssh -N -L …" or "ssh user@host …": the rest of the string is the command
const SSH_CMD = /\bssh\s+(?=-|[^\s@]+@)[^"'\n]*/g;
const PVE_TOKEN = /PVEAPIToken=\S+|[\w.-]+@[\w.-]+![\w.-]+(?:=\S+)?/g;

function ipLabel(ip: string): string {
  const [a, b] = ip.split('.').map(Number);
  if (a === 100 && b >= 64 && b <= 127) return '[tailnet-ip]';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return '[lan-ip]';
  if (a === 127) return '[loopback]';
  return '[ip]';
}

/** Rewrites addresses, MACs, home paths, ssh commands and Proxmox token ids inside one string. */
export function scrubText(s: string, policy: RedactPolicy = STRICT): string {
  let out = s.replace(PVE_TOKEN, '[credential]').replace(HOME_PATH, '[path]').replace(SYSTEM_PATH, '[path]').replace(SSH_CMD, '[ssh command]');
  if (!policy.showAddresses) {
    out = out
      .replace(IPV4, (ip) => ipLabel(ip))
      .replace(IPV6, (ip) => (/^fd7a:115c:a1e0:/i.test(ip) ? '[tailnet-ip]' : '[ip]'))
      .replace(MAC, '[mac]');
  }
  return out;
}

/** Deep copy with scrubText applied to every string (keys included: some maps are keyed by address). */
export function scrubDeep<T>(value: T, policy: RedactPolicy = STRICT): T {
  if (typeof value === 'string') return scrubText(value, policy) as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, policy)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrubText(k, policy), scrubDeep(v, policy)])) as T;
  }
  return value;
}

// ---- ids that are addresses (lan:192.168.1.108) get a stable alias ----

// A keyed hash, so the same address gets the same alias in every response of this process (a client that joins
// list_devices with who_uses_what sees one device, not two), while the alias can't be turned back into the
// address: the key is random per process and never leaves it. A restart changes the aliases.
const ALIAS_KEY = randomBytes(32);

/** `lan:<address>` → `lan-device-<6 hex>`, the same for the same id for as long as this process runs */
export function lanAlias(id: string): string {
  return `lan-device-${createHmac('sha256', ALIAS_KEY).update(id).digest('hex').slice(0, 6)}`;
}

class Aliases {
  private policy: RedactPolicy;
  constructor(policy: RedactPolicy) {
    this.policy = policy;
  }
  id(id: string): string {
    if (this.policy.showAddresses || !/^lan:/.test(id)) return id;
    return lanAlias(id);
  }
}

// ---- list_ports ----

export function redactPorts(snap: Snapshot, args: ListArgs, policy: RedactPolicy = STRICT) {
  const s = summarize(snap, args);
  return scrubDeep(
    {
      host: s.host,
      tailnet: s.tailnet,
      hiddenPorts: s.hiddenPorts,
      ports: s.ports.map((p) => ({
        port: p.port,
        name: p.name,
        listening: p.listening,
        scope: p.scope,
        kind: p.kind,
        label: p.label,
        pinned: p.pinned,
        http: p.http,
        directUrl: p.directUrl,
        servedUrl: p.servedUrl,
        // "process: pid 123" → "process"; unit and container names are fine
        control: p.control && !policy.showProcesses ? p.control.replace(/^process:.*/, 'process') : p.control,
      })),
    },
    policy,
  );
}

// ---- list_devices ----

function pool(p: PoolHost | null, policy: RedactPolicy) {
  if (!p) return null;
  return {
    name: p.name,
    kind: p.kind,
    state: p.state,
    inRotation: p.inRotation,
    slots: p.slots,
    busy: p.busy,
    cores: p.cores ?? null,
    load1: p.load1 ?? null,
    cpuPct: p.cpuPct ?? null,
    memTotalMb: p.memTotalMb ?? null,
    memAvailMb: p.memAvailMb ?? null,
    diskFreePct: p.diskFreePct ?? null,
    runners: p.runners ?? null,
    agent: p.agent ? { connected: p.agent.connected, available: p.agent.available } : null,
    last24h: p.last24h ?? null,
    ...(policy.showAddresses ? { addresses: p.addresses } : {}),
  };
}

/**
 * Another machine's listening ports (compute-pool host, Proxmox host or container): port, reach (scope, tailnet, lan)
 * and the URL — a LAN URL is an address, so only with showAddresses. Bind addresses only with showAddresses, process
 * names only with showProcesses; the raw listening lists are never copied.
 */
function hostPorts(p: Device['ports'] | undefined, policy: RedactPolicy) {
  if (!p) return null;
  return {
    at: p.at,
    ...(p.sides ? { sides: p.sides } : {}),
    ports: p.ports.map((x) => ({
      port: x.port,
      scope: x.scope,
      tailnet: x.tailnet,
      lan: x.lan,
      ...(x.side ? { side: x.side } : {}),
      url: x.tailnet || policy.showAddresses ? x.url : null,
      ...(policy.showAddresses ? { addresses: x.addresses } : {}),
      ...(policy.showProcesses ? { processes: x.processes } : {}),
    })),
  };
}

function path(p: Device['path'], policy: RedactPolicy) {
  if (!p) return null;
  if (p.type === 'relay') return { type: 'relay', region: p.region };
  return policy.showAddresses ? { type: 'direct', endpoint: p.endpoint } : { type: 'direct' };
}

function addresses(d: { tailscaleIps: string[]; lanIps: string[]; routes: string[] }, policy: RedactPolicy) {
  return policy.showAddresses ? { tailscaleIps: d.tailscaleIps, lanIps: d.lanIps, routes: d.routes } : { routesSubnets: d.routes.length > 0 };
}

function pveHost(h: PveHost, ids: Aliases, policy: RedactPolicy) {
  return {
    node: h.node,
    status: h.status,
    device: h.device && ids.id(h.device),
    cpu: h.cpu,
    maxcpu: h.maxcpu,
    mem: h.mem,
    maxmem: h.maxmem,
    disk: h.disk,
    maxdisk: h.maxdisk,
    uptime: h.uptime,
    ports: hostPorts(h.ports, policy),
    guests: h.guests.map((g) => ({
      vmid: g.vmid,
      name: g.name,
      type: g.type,
      status: g.status,
      template: g.template,
      device: g.device && ids.id(g.device),
      cpu: g.cpu,
      maxcpu: g.maxcpu,
      mem: g.mem,
      maxmem: g.maxmem,
      uptime: g.uptime,
      ports: hostPorts(g.ports, policy),
    })),
  };
}

export function redactDevices(d: Devices, policy: RedactPolicy = STRICT) {
  const ids = new Aliases(policy);
  return scrubDeep(
    {
      at: d.at,
      pool: { available: d.pool.available, error: d.pool.error ? 'compute-pool monitor unreachable' : undefined },
      devices: d.devices.map((x) => ({
        id: ids.id(x.id),
        name: x.name,
        os: x.os,
        self: x.self,
        online: x.online,
        lastSeen: x.lastSeen,
        path: path(x.path, policy),
        ...addresses(x, policy),
        virt: x.virt ? { type: x.virt.type, proxmox: x.virt.proxmoxMac } : null,
        pool: pool(x.pool, policy),
        ports: hostPorts(x.ports, policy),
        portsSource: x.portsSource,
        // Its `portboard agent` (#10): state and version only, never the URL (an address) or the load's raw numbers
        ...(x.agent ? { agent: { ok: x.agent.ok, error: x.agent.error, checkedAt: x.agent.checkedAt, lastOk: x.agent.lastOk, version: x.agent.info?.version ?? null } } : {}),
      })),
      proxmox: {
        configured: d.proxmox.configured,
        ok: d.proxmox.ok,
        ...(d.proxmox.error ? { error: 'Proxmox API unreachable or refused the token' } : {}),
        hosts: d.proxmox.hosts.map((h) => pveHost(h, ids, policy)),
      },
      // The SSH port reader: state only (fixed error codes, never ssh's own messages, the key path or the address).
      pvePorts: d.pvePorts
        ? { enabled: d.pvePorts.enabled, node: d.pvePorts.node, ok: d.pvePorts.ok, pending: d.pvePorts.pending, error: d.pvePorts.error, checkedAt: d.pvePorts.checkedAt, lastOk: d.pvePorts.lastOk, unmatched: d.pvePorts.unmatched }
        : null,
      winPorts: d.winPorts
        ? { enabled: d.winPorts.enabled, device: ids.id(d.winPorts.device), ok: d.winPorts.ok, pending: d.winPorts.pending, error: d.winPorts.error, checkedAt: d.winPorts.checkedAt, lastOk: d.winPorts.lastOk }
        : null,
      ...(d.agents?.length
        ? { agents: d.agents.map((a) => ({ name: a.name, device: a.device && ids.id(a.device), ok: a.ok, pending: a.pending, error: a.error, checkedAt: a.checkedAt, lastOk: a.lastOk })) }
        : {}),
      tree: d.tree ? { roots: d.tree.roots.map((n) => netNode(n, ids, policy)) } : null,
    },
    policy,
  );
}

/**
 * The network tree: names, kinds, states and how each machine is reached. Subnets, LAN and Tailscale addresses and
 * endpoints only with showAddresses; the UI's keys (made of addresses) never; lan: ids aliased like the devices'.
 */
function netNode(n: NetNode, ids: Aliases, policy: RedactPolicy): Record<string, unknown> {
  const show = policy.showAddresses;
  return {
    kind: n.kind,
    name: n.kind === 'subnet' && !show ? 'LAN' : n.name,
    device: n.device && ids.id(n.device),
    online: n.online,
    self: n.self,
    os: n.os,
    path: path(n.path, policy),
    ports: n.ports,
    ...(show ? { tailscaleIps: n.tailscaleIps, lanIps: n.lanIps } : {}),
    ...(n.proxmox ? { proxmox: { node: n.proxmox.node, status: n.proxmox.status } } : {}),
    ...(n.routes ? (show ? { routes: n.routes } : { routesSubnets: n.routes.length, standbyFor: n.routes.filter((r) => r.role === 'standby').length }) : {}),
    ...(n.guest ? { guest: { node: n.guest.node, vmid: n.guest.vmid, type: n.guest.type, status: n.guest.status, lanOnly: n.guest.lanOnly } } : {}),
    ...(n.subnet
      ? {
          subnet: {
            ...(show ? { cidr: n.subnet.cidr } : {}),
            router: ids.id(n.subnet.router),
            role: n.subnet.role,
            primary: n.subnet.primary && ids.id(n.subnet.primary),
            standby: n.subnet.standby.map((x) => ids.id(x)),
          },
        }
      : {}),
    ...(n.reach ? { reach: n.reach } : {}),
    ...(n.lanVia ? { lanVia: n.lanVia } : {}),
    children: n.children.map((c) => netNode(c, ids, policy)),
  };
}

// ---- who_uses_what (core/usage.ts) ----

function use(u: UseRow, policy: RedactPolicy) {
  return {
    port: u.port,
    service: u.service,
    kind: u.kind,
    url: u.url,
    via: u.via,
    connections: u.connections,
    bytesSent: u.bytesSent,
    bytesReceived: u.bytesReceived,
    since: u.since,
    routed: u.routed,
    // "curl (3790306)" → "curl"
    ...(policy.showProcesses ? { processes: u.processes } : { processes: [...new Set(u.processes.map((p) => p.replace(/\s*\(\d+\)$/, '')))] }),
  };
}

function card(c: DeviceCard, ids: Aliases, policy: RedactPolicy) {
  return {
    id: ids.id(c.id),
    // A name made from the address is the address; say what it is instead.
    name: c.nameSource === 'ip' && !policy.showAddresses ? (c.kind === 'lan' ? 'LAN device' : 'unnamed device') : c.name,
    kind: c.kind,
    os: c.os,
    networks: c.networks,
    online: c.online,
    lastSeen: c.lastSeen,
    connections: c.connections,
    bytes: c.bytes,
    guestOf: c.guestOf ? { node: c.guestOf.node, vmid: c.guestOf.vmid, type: c.guestOf.type, status: c.guestOf.status } : null,
    pveHost: c.pveHost ? { node: c.pveHost.node, status: c.pveHost.status, guests: c.pveHost.guests.length } : null,
    pool: c.pool ? { state: c.pool.state, busy: c.pool.busy, slots: c.pool.slots } : null,
    ...(policy.showAddresses ? { addresses: c.addresses, tailscaleIps: c.tailscaleIps, lanIps: c.lanIps, mac: c.mac } : {}),
    uses: c.uses.map((u) => use(u, policy)),
  };
}

export function redactUsage(u: Usage, policy: RedactPolicy = STRICT) {
  const ids = new Aliases(policy);
  // Cards first so their aliases are numbered in display order.
  const cards = u.cards.map((c) => card(c, ids, policy));
  const names = new Map(cards.map((c, i) => [u.cards[i].id, c.name]));
  return scrubDeep(
    {
      at: u.at,
      observingSince: u.observingSince,
      cards,
      local: { connections: u.local.connections, uses: u.local.uses.map((x) => use(x, policy)) },
      byPort: Object.fromEntries(
        Object.entries(u.byPort).map(([port, users]) => [
          port,
          users.map((x) => ({
            id: ids.id(x.id),
            name: names.get(x.id) ?? x.name,
            kind: x.kind,
            ...(x.via ? { via: ids.id(x.via) } : {}),
            connections: x.connections,
          })),
        ]),
      ),
      idleServices: u.idleServices,
    },
    policy,
  );
}

// ---- list_worktrees (features/worktrees.ts, from the last scan the server saved) ----

/** merged (by ancestry, or a merged PR containing its HEAD), unmerged, missing (the directory is gone), locked, unknown */
function worktreeState(w: WorktreeInfo): 'merged' | 'unmerged' | 'missing' | 'locked' | 'unknown' {
  if (w.prunable) return 'missing';
  if (w.locked) return 'locked';
  if (w.mergedByAncestry === true || (w.pr?.state === 'MERGED' && w.pr.headMatches)) return 'merged';
  if (w.mergedByAncestry === false || w.pr) return 'unmerged';
  return 'unknown';
}

/**
 * Repo names, branches, states, PR numbers and states, changed yes/no, sizes and why a worktree has to stay (fixed
 * reason texts with counts). Never a path (repo, worktree or ~-short), the last commit's message, the remote URL, the
 * pids inside or a scan's error text; no flag adds them. The main checkout is left out, as in the local tool.
 */
export function redactWorktrees(doc: WorktreesDoc, args: { repo?: string; removableOnly?: boolean } = {}, policy: RedactPolicy = STRICT) {
  return scrubDeep(
    {
      at: doc.at,
      scanning: doc.scanning,
      totals: {
        repos: doc.totals.repos,
        worktrees: doc.totals.worktrees,
        removable: doc.totals.removable,
        missing: doc.totals.prunable,
        removableMb: Math.round(doc.totals.removableKb / 1024),
      },
      repos: doc.repos
        .filter((r) => args.repo === undefined || r.name === args.repo)
        .map((r) => ({
          repo: r.name,
          defaultBranch: r.defaultBranch,
          prsKnown: r.prsKnown,
          scanFailed: r.error !== null,
          worktrees: r.worktrees
            .filter((w) => !w.main && (args.removableOnly ? w.removable : true))
            .map((w) => ({
              branch: w.branch,
              detached: w.detached,
              state: worktreeState(w),
              pr: w.pr ? { number: w.pr.number, state: w.pr.state, headMatches: w.pr.headMatches } : null,
              changed: w.changes === null ? null : w.changes > 0,
              sizeMb: w.sizeKb === null ? null : Math.round(w.sizeKb / 1024),
              inUse: w.inUse.length > 0,
              removable: w.removable,
              keep: [...w.keep],
            })),
        })),
    },
    policy,
  );
}

// ---- list_dev_servers (features/devservers.ts) ----

/**
 * Which worktree (its "<repo>@<branch>" owner, the name reservations use), state, port and since when; which worktrees
 * could be started, with which script names. Never the worktree path, the unit name (made from the path), its
 * description or the scripts' command text; no flag adds them.
 */
export function redactDevServers(doc: DevServersDoc, policy: RedactPolicy = STRICT) {
  return scrubDeep(
    {
      running: doc.running.map((r) => ({ owner: r.owner, active: r.active, state: r.state, port: r.port, since: r.since })),
      startable: Object.values(doc.startable)
        .map((s) => ({ owner: s.owner, scripts: Object.keys(s.scripts), preferred: s.preferred }))
        .sort((a, b) => a.owner.localeCompare(b.owner)),
    },
    policy,
  );
}

// ---- memory_usage (features/memory.ts, from memory-state.json) ----

const gb = (mb: number) => Math.round(mb / 102.4) / 10;

/**
 * Memory, swap, PSI, the pressure state with its thresholds, the groups and totals, and per row only numbers, versions
 * and the service and container names list_ports shows anyway. Session titles and projects, MCP server and other
 * process names, the session a service runs under and the suggestion texts (they name them) only with showProcesses.
 */
export function redactMemory(v: MemoryView, top = 10, policy: RedactPolicy = STRICT) {
  const names = policy.showProcesses;
  const th = v.pressure.thresholds;
  return scrubDeep(
    {
      at: v.at,
      memory: {
        totalGb: gb(v.mem.totalMb),
        usedGb: gb(v.mem.usedMb),
        availableGb: gb(v.mem.availableMb),
        availablePct: v.mem.availablePct,
        swapTotalGb: gb(v.mem.swapTotalMb),
        swapPct: v.mem.swapPct,
        psi: v.psi ? { someAvg60: v.psi.some.avg60, fullAvg60: v.psi.full?.avg60 ?? null } : null,
      },
      pressure: {
        active: v.pressure.active,
        reasons: [...v.pressure.reasons],
        reasonText: [...v.pressure.reasonText],
        thresholds: { availablePct: th.availablePct, psiSome60: th.psiSome60, swapPct: th.swapPct, sustainMin: th.sustainMin },
      },
      groups: v.groups.map((g) => ({ group: g.key, label: g.label, gb: gb(g.mb), processes: g.procs })),
      totals: {
        rssGb: gb(v.rssMb),
        sessions: v.sessions.length,
        idleSessions: v.sessions.filter((x) => x.idle).length,
        staleVersion: v.sessions.filter((x) => x.stale).length,
        newestVersion: v.newestVersion,
        mcpServers: v.mcp.length,
        mcpInstances: v.mcp.reduce((a, m) => a + m.instances, 0),
        mcpGb: gb(v.mcp.reduce((a, m) => a + m.mb, 0)),
        mcpOrphans: v.mcp.reduce((a, m) => a + m.orphans, 0),
        services: v.services.length,
        devServers: v.services.filter((x) => x.dev).length,
        docker: v.docker.length,
      },
      sessions: v.sessions.slice(0, top).map((x) => ({
        ...(names ? { title: x.title, project: x.project } : {}),
        version: x.version,
        stale: x.stale,
        helper: x.helper,
        idle: x.idle,
        idleMin: x.idleMin,
        mb: x.mb,
        mcpMb: x.breakdown.mcp,
        uptimeH: Math.round(x.uptimeSec / 360) / 10,
      })),
      ...(names ? { mcpServers: v.mcp.slice(0, top).map((m) => ({ name: m.label, instances: m.instances, gb: gb(m.mb), sessions: m.sessions, orphans: m.orphans })) } : {}),
      services: v.services.slice(0, top).map((x) => ({ name: x.name, ports: [...x.ports], mb: x.mb, dev: x.dev, unused: x.unused, ...(names ? { session: x.session } : {}) })),
      docker: v.docker.slice(0, top).map((d) => ({ name: d.name, mb: d.mb })),
      ...(names ? { other: v.other.slice(0, top).map((o) => ({ name: o.name, count: o.count, mb: o.mb })) } : {}),
      suggestions: v.suggestions.map((x) => ({ kind: x.kind, mb: x.mb, ...(names ? { text: x.text } : {}) })),
    },
    policy,
  );
}

// ---- portboard://status ----

/** Down state of watched ports and devices, and how many 새 기기 are pending. Names only: no addresses, no channel. */
export interface StatusExtras {
  watching: { kind: 'port' | 'device'; port?: number; name: string; down: boolean; since: string | null }[] | null;
  newDevices: number | null;
  /** memory pressure as numbers and reason codes (memory-state.json); statusReport rebuilds it field by field */
  memory?: MemoryStatus | null;
}

/**
 * The status resource built from the redacted projections above (never from core objects), so device names,
 * ids and service names are the same ones the remote tools show. 새 기기 is a count only: their names can be a MAC
 * vendor or an address. A source that failed is null with no error text.
 */
export function redactStatus(
  i: { at: string; snap: Snapshot | null; devices: Devices | null; usage: Usage | null; extras: StatusExtras | null },
  policy: RedactPolicy = STRICT,
) {
  const w = i.extras?.watching;
  const n = i.extras?.newDevices;
  return scrubDeep(
    statusReport({
      at: i.at,
      ports: i.snap ? redactPorts(i.snap, {}, policy) : null,
      devices: i.devices ? redactDevices(i.devices, policy) : null,
      usage: i.usage ? redactUsage(i.usage, policy) : null,
      watching: Array.isArray(w) ? w.map((x) => ({ kind: x.kind, ...(x.port !== undefined ? { port: x.port } : {}), name: x.name, down: x.down, since: x.since })) : null,
      newDevices: typeof n === 'number' ? n : null,
      ...(i.extras && 'memory' in i.extras ? { memory: i.extras.memory ?? null } : {}),
    }),
    policy,
  );
}
