// Listening ports of other machines — compute-pool hosts (desktop, mac) as compute-pool reports them, and the Proxmox
// host and its containers as pveports.ts reads them — grouped by port and sorted out by who can reach them: every
// interface or the device's Tailscale IP → reachable over the tailnet (with an http:// link to try); for a machine
// that is not on Tailscale, every interface or its LAN IP → reachable at the LAN address (through the subnet router);
// loopback → only inside that machine; anything else (a docker address) shown as is. This server's own ports stay in
// index.ts, which knows far more about them.

import type { ListenPort, PoolHost } from './pool.ts';

export type HostPortScope = 'all' | 'tailnet' | 'other' | 'loopback';

export interface HostPort {
  port: number;
  /** the widest binding among the port's sockets */
  scope: HostPortScope;
  addresses: string[];
  processes: string[];
  /** reachable from this server's tailnet devices (the device is online on Tailscale, bound to all or its Tailscale IP) */
  tailnet: boolean;
  /** not on the tailnet, but bound to all or the device's LAN IP: reachable at that LAN address (subnet route) */
  lan: boolean;
  /** http://<Tailscale name or LAN IP>:<port> to try (https for 443/8006/8443), unless a well-known non-HTTP port */
  url: string | null;
  /** Only on the desktop's merged list: which side of the machine listens (Windows itself, or inside WSL) */
  side?: 'windows' | 'wsl';
}

export interface HostPorts {
  /** ms: when the host read them (the older side, for a merged Windows + WSL list) */
  at: number;
  ports: HostPort[];
  /** Merged Windows + WSL list: when each side was read (null: that side reported nothing) */
  sides?: { windows: number | null; wsl: number | null };
}

const RANK: Record<HostPortScope, number> = { all: 0, tailnet: 1, other: 2, loopback: 3 };

/** ssh, DNS, mail, SMB, databases, RDP, VNC: no point opening them in a browser */
const NOT_HTTP = new Set([21, 22, 23, 25, 53, 110, 111, 135, 139, 143, 445, 587, 993, 995, 2049, 2222, 3128, 3306, 3389, 5432, 5900, 6379, 22000, 24800, 27017]);
/** Owners whose ports are never a page to open (Tailscale's PeerAPI is HTTP, but not for people) */
const NOT_WEB = new Set(['tailscaled', 'svchost', 'lsass', 'wininit', 'services', 'spoolsv']);
/** HTTPS only: the Proxmox web UI (8006) and the usual TLS ports */
const HTTPS = new Set([443, 8006, 8443]);

export function scopeOf(address: string, tailscaleIps: string[]): HostPortScope {
  const a = address.toLowerCase();
  if (a === '*' || a === '0.0.0.0' || a === '::') return 'all';
  if (tailscaleIps.some((ip) => ip.toLowerCase() === a)) return 'tailnet';
  if (/^127\./.test(a) || a === '::1' || /^::ffff:127\./.test(a)) return 'loopback';
  return 'other';
}

export interface PortsDevice {
  online: boolean;
  dnsName: string | null;
  tailscaleIps: string[];
  /** LAN addresses; used for links only when the device has no Tailscale name */
  lanIps?: string[];
}

/**
 * null when the pool host did not report its ports (an older worker, a host that is down, the local host).
 * No LAN links here: compute-pool reaches its hosts over addresses the user's devices may not route to.
 */
export function hostPorts(pool: PoolHost | null, dev: PortsDevice): HostPorts | null {
  if (!pool || typeof pool.listeningAt !== 'number' || !Array.isArray(pool.listening)) return null;
  return fromListening(pool.listening, pool.listeningAt, { ...dev, lanIps: [] });
}

/** Listening sockets of one machine (at: ms when read) → grouped by port, with reach and a link to try. */
export function fromListening(listening: ListenPort[], at: number, dev: PortsDevice): HostPorts {
  const by = new Map<number, HostPort>();
  for (const l of listening) {
    const scope = scopeOf(l.address, dev.tailscaleIps);
    const p = by.get(l.port) ?? { port: l.port, scope, addresses: [], processes: [], tailnet: false, lan: false, url: null };
    if (RANK[scope] < RANK[p.scope]) p.scope = scope;
    if (!p.addresses.includes(l.address)) p.addresses.push(l.address);
    if (l.process && !p.processes.includes(l.process)) p.processes.push(l.process);
    by.set(l.port, p);
  }
  const ports = [...by.values()].sort((a, b) => a.port - b.port);
  const lanIp = !dev.dnsName ? (dev.lanIps ?? []).find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? null : null;
  for (const p of ports) {
    p.tailnet = dev.online && !!dev.dnsName && (p.scope === 'all' || p.scope === 'tailnet');
    p.lan = !p.tailnet && dev.online && !!lanIp && (p.scope === 'all' || p.addresses.includes(lanIp));
    const host = p.tailnet ? dev.dnsName : p.lan ? lanIp : null;
    const web = !NOT_HTTP.has(p.port) && !(p.processes.length && p.processes.every((n) => NOT_WEB.has(n)));
    p.url = host && web ? `${HTTPS.has(p.port) ? 'https' : 'http'}://${host}:${p.port}` : null;
  }
  return { at, ports };
}
