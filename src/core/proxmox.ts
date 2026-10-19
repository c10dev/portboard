// Proxmox VE, read-only: hosts and their VMs/containers, via an API token with PVEAuditor.
//   ~/.config/portboard/proxmox.json   (override with PORTBOARD_PROXMOX), mode 600:
//   {"url": "https://192.168.1.201:8006", "tokenId": "root@pam!portboard", "secret": "…", "fingerprint": "AA:BB:…"}
//
// The certificate is self-signed, so instead of a CA check the connection is pinned to the SHA-256 fingerprint:
// the TLS handshake finishes and the fingerprint is compared *before* any request (and the token) is written.
// The secret never leaves this module: not in results, errors or logs.

import { readFile, stat } from 'node:fs/promises';
import { request } from 'node:https';
import { connect, type TLSSocket } from 'node:tls';
import { join } from 'node:path';
import { PATHS } from './paths.ts';
import type { HostPorts } from './hostports.ts';
import { reportHealth } from './health.ts';

export const PROXMOX_PATH = PATHS.proxmox;

export interface ProxmoxConfig {
  url: string;
  tokenId: string;
  secret: string;
  fingerprint: string;
}

export interface Guest {
  vmid: number;
  name: string;
  type: 'qemu' | 'lxc';
  node: string;
  status: string;
  template: boolean;
  cpu: number | null;
  maxcpu: number | null;
  mem: number | null;
  maxmem: number | null;
  uptime: number | null;
  /** From the guest config's net* lines, upper-case colon hex */
  macs: string[];
  /** Static addresses from an lxc config (ip=192.168.1.203/24) */
  ips: string[];
  /** Filled by matchGuests: the LAN IP its MAC was seen at (ip neigh) */
  lanIp?: string | null;
  /** Filled by matchGuests: the device id this guest is (self, a tailnet device, lan:<ip>) */
  device: string | null;
  deviceMatch: 'mac' | 'name' | 'ip' | null;
  /** Filled by attachPvePorts (devices.ts): its listening ports, read over SSH from the host (running CTs only) */
  ports?: HostPorts | null;
}

export interface PveHost {
  node: string;
  status: string;
  ip: string | null;
  cpu: number | null;
  maxcpu: number | null;
  mem: number | null;
  maxmem: number | null;
  disk: number | null;
  maxdisk: number | null;
  uptime: number | null;
  /** Filled by matchGuests: the device id of the host (by name, or its cluster IP on the LAN) */
  device: string | null;
  guests: Guest[];
  /** Filled by attachPvePorts (devices.ts): the host's own listening ports, read over SSH */
  ports?: HostPorts | null;
}

export interface ProxmoxStatus {
  /** false: no proxmox.json — not an error, the UI shows how to add one */
  configured: boolean;
  ok: boolean;
  /** Never contains the secret */
  error?: string;
  /** proxmox.json is readable by others */
  looseMode?: boolean;
  url?: string;
  hosts: PveHost[];
}

// ---- config ----

export function checkConfig(raw: unknown): ProxmoxConfig | string {
  if (!raw || typeof raw !== 'object') return 'proxmox.json must be an object';
  const c = raw as Record<string, unknown>;
  for (const k of ['url', 'tokenId', 'secret', 'fingerprint']) if (typeof c[k] !== 'string' || !c[k]) return `proxmox.json: ${k} is missing`;
  let u: URL;
  try {
    u = new URL(c.url as string);
  } catch {
    return 'proxmox.json: url is not a URL';
  }
  if (u.protocol !== 'https:') return 'proxmox.json: url must be https';
  if (!/^[^!\s]+![^\s=]+$/.test(c.tokenId as string)) return 'proxmox.json: tokenId must look like user@realm!name';
  if (normFp(c.fingerprint as string).length !== 64) return 'proxmox.json: fingerprint must be the SHA-256 of the certificate (32 bytes, hex)';
  return { url: u.origin, tokenId: c.tokenId as string, secret: c.secret as string, fingerprint: c.fingerprint as string };
}

export const normFp = (fp: string) => fp.replace(/[^0-9a-f]/gi, '').toUpperCase();

export async function loadConfig(path = PROXMOX_PATH): Promise<{ cfg: ProxmoxConfig | null; error?: string; looseMode?: boolean }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { cfg: null };
  }
  const looseMode = ((await stat(path)).mode & 0o077) !== 0;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { cfg: null, error: 'proxmox.json is not valid JSON', looseMode };
  }
  const c = checkConfig(raw);
  return typeof c === 'string' ? { cfg: null, error: c, looseMode } : { cfg: c, looseMode };
}

// ---- client ----

/** GET <url>/api2/json<path> → data. Errors are generic on purpose (no headers, no secret). */
export function pveGet(cfg: ProxmoxConfig, path: string, timeoutMs = 4000): Promise<any> {
  const u = new URL(cfg.url);
  const port = Number(u.port || 443);
  return new Promise((resolve, reject) => {
    const fail = (msg: string) => reject(new Error(msg));
    const socket: TLSSocket = connect({ host: u.hostname, port, servername: isIp(u.hostname) ? undefined : u.hostname, rejectUnauthorized: false });
    const timer = setTimeout(() => { socket.destroy(); fail(`Proxmox did not answer within ${timeoutMs} ms`); }, timeoutMs);
    socket.once('error', (e) => { clearTimeout(timer); fail(`cannot reach Proxmox at ${cfg.url} (${(e as NodeJS.ErrnoException).code ?? 'error'})`); });
    socket.once('secureConnect', () => {
      const fp = socket.getPeerCertificate()?.fingerprint256 ?? '';
      if (normFp(fp) !== normFp(cfg.fingerprint)) {
        clearTimeout(timer);
        socket.destroy();
        return fail(`certificate fingerprint mismatch at ${cfg.url} — not sending the token`);
      }
      const req = request(
        {
          host: u.hostname, port, method: 'GET', path: `/api2/json${path}`,
          headers: { authorization: `PVEAPIToken=${cfg.tokenId}=${cfg.secret}`, accept: 'application/json' },
          createConnection: () => socket,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            clearTimeout(timer);
            socket.end();
            if (res.statusCode !== 200) return fail(`Proxmox ${path.split('/').slice(0, 3).join('/')} → HTTP ${res.statusCode}${res.statusCode === 401 ? ' (token rejected)' : res.statusCode === 403 ? ' (token lacks PVEAuditor)' : ''}`);
            try {
              resolve(JSON.parse(body).data);
            } catch {
              fail('Proxmox answered with something that is not JSON');
            }
          });
        },
      );
      req.on('error', () => { clearTimeout(timer); fail(`request to Proxmox failed`); });
      req.end();
    });
  });
}

const isIp = (h: string) => /^[\d.]+$/.test(h) || h.includes(':');

// ---- parsing (documented /api2/json shapes) ----

/** /cluster/resources → nodes and guests (templates kept but flagged) */
export function parseResources(data: unknown): { nodes: Omit<PveHost, 'ip' | 'guests' | 'device'>[]; guests: Omit<Guest, 'macs' | 'ips' | 'device' | 'deviceMatch'>[] } {
  const rows = Array.isArray(data) ? data : [];
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const nodes = rows
    .filter((r: any) => r?.type === 'node' && typeof r.node === 'string')
    .map((r: any) => ({ node: r.node, status: String(r.status ?? 'unknown'), cpu: n(r.cpu), maxcpu: n(r.maxcpu), mem: n(r.mem), maxmem: n(r.maxmem), disk: n(r.disk), maxdisk: n(r.maxdisk), uptime: n(r.uptime) }));
  const guests = rows
    .filter((r: any) => (r?.type === 'qemu' || r?.type === 'lxc') && Number.isInteger(r.vmid))
    .map((r: any) => ({
      vmid: r.vmid, name: String(r.name ?? `${r.type} ${r.vmid}`), type: r.type, node: String(r.node ?? ''), status: String(r.status ?? 'unknown'),
      template: !!r.template, cpu: n(r.cpu), maxcpu: n(r.maxcpu), mem: n(r.mem), maxmem: n(r.maxmem), uptime: n(r.uptime),
    }))
    .sort((a, b) => a.vmid - b.vmid);
  return { nodes, guests };
}

/** /cluster/status → node name → IP (a single node without a cluster still reports itself) */
export function parseClusterStatus(data: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of Array.isArray(data) ? data : []) if ((r as any)?.type === 'node' && (r as any).name && (r as any).ip) out.set((r as any).name, (r as any).ip);
  return out;
}

/** /nodes/{node}/status → root filesystem (cluster/resources' disk for a node is the same storage, this is just fresher) */
export function parseNodeStatus(data: any): Partial<PveHost> {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    cpu: n(data?.cpu), maxcpu: n(data?.cpuinfo?.cpus), mem: n(data?.memory?.used), maxmem: n(data?.memory?.total),
    disk: n(data?.rootfs?.used), maxdisk: n(data?.rootfs?.total), uptime: n(data?.uptime),
  };
}

/** net0: "virtio=BC:24:11:0A:0B:02,bridge=vmbr0" (qemu) / "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:…,ip=192.168.1.203/24" (lxc) */
export function parseGuestConfig(cfg: unknown): { macs: string[]; ips: string[] } {
  const macs: string[] = [];
  const ips: string[] = [];
  for (const [k, v] of Object.entries((cfg as Record<string, unknown>) ?? {})) {
    if (!/^net\d+$/.test(k) || typeof v !== 'string') continue;
    for (const part of v.split(',')) {
      const [key, val = ''] = part.split('=');
      if (/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i.test(val) && /^(hwaddr|virtio|e1000|e1000e|rtl8139|vmxnet3|ne2k_pci|i82551|i82557b|i82559er|pcnet)$/i.test(key)) macs.push(val.toUpperCase());
      if ((key === 'ip' || key === 'ip6') && val && !/^(dhcp|auto|manual)$/i.test(val)) ips.push(val.replace(/\/\d+$/, ''));
    }
  }
  return { macs, ips };
}

// ---- status (cached) ----

const TTL = 30_000;
let cache: { at: number; value: Promise<ProxmoxStatus> } | null = null;

export function proxmoxStatus(path = PROXMOX_PATH): Promise<ProxmoxStatus> {
  if (cache && Date.now() - cache.at < TTL) return cache.value;
  const value = fetchStatus(path);
  cache = { at: Date.now(), value };
  // No proxmox.json is not an outage; an invalid one is a setup step (reported, alerted only once it has worked).
  void value.then((s) => reportHealth('proxmox', { ok: s.ok, error: s.configured ? s.error : 'no proxmox.json', enabled: s.configured, setup: !s.ok && s.configured && !s.url }));
  return value;
}

export function resetProxmoxCache() {
  cache = null;
}

async function fetchStatus(path: string): Promise<ProxmoxStatus> {
  const { cfg, error, looseMode } = await loadConfig(path);
  if (!cfg) return { configured: !!error, ok: false, ...(error ? { error } : {}), ...(looseMode ? { looseMode } : {}), hosts: [] };
  const base = { configured: true, url: cfg.url, ...(looseMode ? { looseMode } : {}) };
  try {
    const [resources, cluster] = await Promise.all([pveGet(cfg, '/cluster/resources'), pveGet(cfg, '/cluster/status').catch(() => [])]);
    const { nodes, guests } = parseResources(resources);
    const ips = parseClusterStatus(cluster);
    const hosts: PveHost[] = await Promise.all(
      nodes.map(async (n) => {
        const st = n.status === 'online' ? await pveGet(cfg, `/nodes/${encodeURIComponent(n.node)}/status`).then(parseNodeStatus, () => ({})) : {};
        const mine = guests.filter((g) => g.node === n.node && !g.template);
        const full = await Promise.all(
          mine.map(async (g): Promise<Guest> => {
            const conf = await pveGet(cfg, `/nodes/${encodeURIComponent(n.node)}/${g.type}/${g.vmid}/config`).then(parseGuestConfig, () => ({ macs: [], ips: [] }));
            return { ...g, ...conf, device: null, deviceMatch: null };
          }),
        );
        return { ...n, ...st, ip: ips.get(n.node) ?? null, device: null, guests: full };
      }),
    );
    return { ...base, ok: true, hosts };
  } catch (err) {
    return { ...base, ok: false, error: (err as Error).message, hosts: [] };
  }
}

// ---- guests ↔ devices ----

export interface MatchContext {
  /** this server: its device id and the MACs of its own interfaces */
  self: { id: string; macs: string[] };
  /** device ids (Tailscale DNS labels, pool:…) — matched by exact name */
  deviceIds: string[];
  /** LAN IP → MAC from ip neigh */
  neighbors: Map<string, string>;
  /** LAN IP → device id for addresses already tied to a device (compute-pool, host keys) */
  lanOwner: Map<string, string>;
}

/**
 * Fills host.device and guest.device. A guest is this server when one of its MACs is ours; else the device that
 * already owns the LAN IP its MAC was seen at; else the tailnet device with the same name (its LAN IP, if seen, is
 * then that device's too — the caller attaches it); else lan:<ip> by MAC or by a static IP. Returns a copy.
 */
export function matchGuests(st: ProxmoxStatus, ctx: MatchContext): ProxmoxStatus {
  const byMacIp = new Map<string, string>();
  for (const [ip, mac] of ctx.neighbors) if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) byMacIp.set(mac.toUpperCase(), ip);
  const selfMacs = new Set(ctx.self.macs.map((m) => m.toUpperCase()));
  const ids = new Map(ctx.deviceIds.map((d) => [d.toLowerCase(), d]));
  const deviceForIp = (ip: string) => ctx.lanOwner.get(ip) ?? `lan:${ip}`;

  const hosts = st.hosts.map((h) => {
    const device = ids.get(h.node.toLowerCase()) ?? (h.ip ? ctx.lanOwner.get(h.ip) ?? null : null);
    const guests = h.guests.map((g): Guest => {
      if (g.macs.some((m) => selfMacs.has(m))) return { ...g, lanIp: null, device: ctx.self.id, deviceMatch: 'mac' };
      const lanIp = g.macs.map((m) => byMacIp.get(m)).find(Boolean) ?? null;
      const owner = lanIp ? ctx.lanOwner.get(lanIp) : undefined;
      if (owner) return { ...g, lanIp, device: owner, deviceMatch: 'mac' };
      const byName = ids.get(g.name.toLowerCase());
      if (byName) return { ...g, lanIp, device: byName, deviceMatch: 'name' };
      if (lanIp) return { ...g, lanIp, device: `lan:${lanIp}`, deviceMatch: 'mac' };
      const ip = g.ips.find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x));
      if (ip) return { ...g, lanIp: null, device: deviceForIp(ip), deviceMatch: 'ip' };
      return { ...g, lanIp: null };
    });
    return { ...h, device, guests };
  });
  return { ...st, hosts };
}
