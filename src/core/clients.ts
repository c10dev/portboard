// Who a LAN client is: IP → MAC (`ip neigh`, same L2 segment only) → vendor (local IEEE OUI list), plus names the
// user gives devices. Names live in their own file so that an older Portboard rewriting prefs.json can't drop them:
//   ~/.config/portboard/clients.json   (override with PORTBOARD_CLIENTS)   {"names": {"mac:50:81:40:0a:0b:01": "회사 노트북"}}

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from './paths.ts';
import { run, runShared } from './exec.ts';
import { writePrivate } from './atomic.ts';

export interface Neighbor {
  mac: string;
  state: string;
  /** Interface the entry is on (ens18, docker0, br-…) */
  dev?: string;
}

/** `ip neigh` lines: `192.168.1.7 dev ens18 lladdr 04:7c:16:0a:0b:03 REACHABLE` (FAILED/INCOMPLETE have no lladdr) */
export function parseNeigh(text: string): Map<string, Neighbor> {
  const out = new Map<string, Neighbor>();
  for (const line of text.split('\n')) {
    const m = /^(\S+)\s.*\blladdr\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})\b\s*(\S*)/i.exec(line.trim());
    const dev = /\bdev\s+(\S+)/.exec(line)?.[1];
    if (m) out.set(m[1].toLowerCase(), { mac: m[2].toLowerCase(), state: m[3] || '', ...(dev ? { dev } : {}) });
  }
  return out;
}

export async function neighbors(): Promise<Map<string, Neighbor>> {
  const r = await runShared('ip', ['neigh', 'show']);
  return r.ok ? parseNeigh(r.stdout) : new Map();
}

/** The IEEE MA-L list as shipped in ieee-data: `50-81-40   (hex)\t\tHP Inc.` */
export function parseOui(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/^([0-9A-F]{2})-([0-9A-F]{2})-([0-9A-F]{2})\s+\(hex\)\s+(.+?)\s*$/gim)) {
    out.set(`${m[1]}${m[2]}${m[3]}`.toUpperCase(), m[4]);
  }
  return out;
}

const OUI_PATH = process.env.PORTBOARD_OUI ?? '/usr/share/ieee-data/oui.txt';
let ouiCache: Promise<Map<string, string>> | null = null;

/** Loaded once per process, only when a vendor is first needed. Empty when the list isn't installed. */
export function ouiTable(): Promise<Map<string, string>> {
  ouiCache ??= readFile(OUI_PATH, 'utf8').then(parseOui, () => new Map());
  return ouiCache;
}

/** Locally administered bit: phones and laptops use random per-network MACs, which say nothing about the vendor. */
export function isRandomMac(mac: string): boolean {
  const first = parseInt(mac.slice(0, 2), 16);
  return Number.isFinite(first) && (first & 0x02) !== 0;
}

export function vendorOf(mac: string, oui: Map<string, string>): string | null {
  if (isRandomMac(mac)) return null;
  return oui.get(mac.replace(/[^0-9a-f]/gi, '').slice(0, 6).toUpperCase()) ?? null;
}

const SHORT: [RegExp, string][] = [
  [/^Micro-Star/i, 'MSI'],
  [/^Hewlett[ -]Packard|^HP Inc/i, 'HP'],
  [/^ASUSTek/i, 'ASUS'],
  [/^GIGA-BYTE/i, 'GIGABYTE'],
  [/^Proxmox/i, 'Proxmox VM'],
  [/^Samsung/i, 'Samsung'],
  [/^Apple/i, 'Apple'],
  [/^Intel Corporate/i, 'Intel'],
  [/^Raspberry Pi/i, 'Raspberry Pi'],
  [/^Synology/i, 'Synology'],
  [/^Realtek/i, 'Realtek'],
];

/** "Micro-Star INTL CO., LTD." → "MSI", "Foo Technologies Co., Ltd." → "Foo" */
export function shortVendor(org: string): string {
  for (const [re, name] of SHORT) if (re.test(org)) return name;
  const cut = org
    .replace(/[,.]?\s+(Co\.?,?\s*)?(Ltd|Inc|Corp|Corporation|LLC|GmbH|AG|S\.?A|B\.?V|Limited|INTL|International|Technology|Technologies|Electronics)\b.*$/i, '')
    .trim();
  return cut.split(/\s+/).slice(0, 2).join(' ') || org;
}

/** proxmox: a LAN container named after its Proxmox guest (usage.ts), when nothing better than a vendor guess exists */
/** funnel: the fixed name of the Tailscale Funnel pseudo-device (the public internet) */
export type NameSource = 'user' | 'tailscale' | 'pool' | 'proxmox' | 'vendor' | 'ip' | 'funnel';

/** Name priority: user name > Tailscale name > compute-pool host name > vendor guess > the address itself. */
export function resolveName(n: {
  user?: string | null;
  tailscale?: string | null;
  pool?: string | null;
  vendor?: string | null;
  randomMac?: boolean;
  ip: string;
}): { name: string; source: NameSource } {
  if (n.user) return { name: n.user, source: 'user' };
  if (n.tailscale) return { name: n.tailscale, source: 'tailscale' };
  if (n.pool) return { name: n.pool, source: 'pool' };
  if (n.vendor) {
    const v = shortVendor(n.vendor);
    return { name: /\bVM$/.test(v) ? v : `${v} 기기`, source: 'vendor' };
  }
  if (n.randomMac) return { name: '개인 Wi-Fi 주소 기기', source: 'ip' };
  return { name: n.ip, source: 'ip' };
}

/** Key a user name by MAC when we know it (survives DHCP changes), else by IP. */
export function nameKey(ip: string, mac: string | null): string {
  return mac && !isRandomMac(mac) ? `mac:${mac.toLowerCase()}` : `ip:${ip.toLowerCase()}`;
}

/** A LAN address as the 기기 tab names it: user name (by MAC, else IP) > MAC vendor > 개인 Wi-Fi 주소 > the address */
export function lanIdentity(ip: string, mac: string | null, names: Record<string, string>, oui: Map<string, string>) {
  const vendor = mac ? vendorOf(mac, oui) : null;
  const key = nameKey(ip, mac);
  const randomMac = !!mac && isRandomMac(mac);
  return { ...resolveName({ user: names[key], vendor, randomMac, ip }), vendor, mac, randomMac, key };
}

// ---- user-given names ----

export const CLIENTS_PATH = PATHS.clients;

export async function loadNames(path = CLIENTS_PATH): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return raw && typeof raw.names === 'object' && raw.names ? raw.names : {};
  } catch {
    return {};
  }
}

const KEY = /^(mac:[0-9a-f]{2}(:[0-9a-f]{2}){5}|ip:[0-9a-f.:]{2,45})$/;

/** Validates a POST body {key, name}; returns an error message or null. */
export function checkName(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be an object';
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'key' && k !== 'name') return `unknown field: ${k}`;
  if (typeof b.key !== 'string' || !KEY.test(b.key)) return 'key must be mac:xx:xx:xx:xx:xx:xx or ip:<address>';
  if (b.name !== null && typeof b.name !== 'string') return 'name must be a string or null';
  if (typeof b.name === 'string' && b.name.trim().length > 40) return 'name is longer than 40 characters';
  return null;
}

let queue: Promise<unknown> = Promise.resolve();

/** Empty or null clears the name. Writes atomically, one at a time. */
export function setName(key: string, name: string | null, path = CLIENTS_PATH): Promise<Record<string, string>> {
  const job = queue.then(async () => {
    const names = await loadNames(path);
    const v = name?.trim();
    if (v) names[key] = v;
    else delete names[key];
    await writePrivate(path, `${JSON.stringify({ names }, null, 2)}\n`);
    return names;
  });
  queue = job.catch(() => {});
  return job;
}
