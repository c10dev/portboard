// Who may write (c10dev/portboard#29). Pure decisions over a request's socket address and headers, plus where the
// owner's Tailscale login comes from. docs/security.md has the threat model.
//
// Three ways in:
//   loopback  a process on this machine talking to 127.0.0.1:8790 itself (the plugin hooks, scripts, curl): the
//             owner — it runs as the same machine user and could edit the state files directly anyway
//   serve     the dashboard through `tailscale serve` (8443 → 127.0.0.1:8790). tailscaled proxies from loopback, sets
//             X-Forwarded-For/-Host/-Proto and, for a device logged in as a user (not a tagged one, not Funnel),
//             Tailscale-User-Login/-Name — after deleting any copies the client sent. Writes only when the login is
//             the owner's.
//   direct    any other address: a tailnet device on http://<tailnet IP>:8790. Read-only. Its Tailscale-* headers
//             are whatever the client typed, so they are never read.
//
// A loopback request counts as serve when it carries any proxy marker, so a local caller can only lose rights by
// sending one, never gain them.
//
// Which device (security review v1.0, M1): "the owner's login" covers every untagged node logged in as the owner,
// servers included. So serve and direct callers are also identified as a tailnet node with `tailscale whois` on the
// address (serve: X-Forwarded-For, which tailscaled sets; direct: the socket). The device goes into the audit line and
// /api/whoami, and an optional allowlist (writeDevices in access.json, PORTBOARD_WRITE_DEVICES) limits serve writes
// to the listed node names or stable node IDs.

import { isIP } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { run, runShared, type RunResult } from './exec.ts';
import { writePrivate } from './atomic.ts';
import { t } from './i18n.ts';

export type Source = 'loopback' | 'serve' | 'direct' | 'mcp';

export interface Caller {
  source: Source;
  /** Tailscale login through serve; null for loopback, direct and tagged devices */
  login: string | null;
  /** The owner: loopback, mcp, or serve with the owner's login */
  owner: boolean;
  canWrite: boolean;
  /** Why not, in Korean for the dashboard (set when canWrite is false; the UI puts "읽기 전용" in front) */
  reason?: string;
  /** direct: the socket address; serve: the X-Forwarded-For address tailscaled set (when it is one IP) */
  addr?: string;
  /** serve and direct: the tailnet node at `addr`, as far as `tailscale whois` knows it (resolveCaller) */
  device?: Device;
}

/** A tailnet device, from `tailscale whois --json <addr>`. Only addr when whois didn't know it. */
export interface Device {
  addr: string;
  /** MagicDNS short name ("dev-mac") */
  name?: string;
  /** Stable node ID ("nExampleNode1CNTRL") */
  id?: string;
  /** ACL tags of a tagged node */
  tags?: string[];
}

export const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Headers only a proxy in front of us sets (tailscale serve/funnel, or anything else forwarding). */
export const PROXY_MARKERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
  'tailscale-user-login',
  'tailscale-user-name',
  'tailscale-headers-info',
  'tailscale-funnel-request',
  // Other proxies' client-address headers (nginx, Caddy, Cloudflare, Akamai, …): a local reverse proxy that sets only
  // one of these must not make its clients the owner (security review v1.0, L5).
  'x-real-ip',
  'via',
  'true-client-ip',
  'cf-connecting-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'fastly-client-ip',
  'x-original-forwarded-for',
];

interface ReqLike {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string } | null;
}

/**
 * A local process talking to us directly. tailscale serve/funnel proxy tailnet traffic from 127.0.0.1 too, so a request
 * that carries their headers is not local whatever its socket says.
 */
export function localOnly(req: ReqLike): boolean {
  if (!LOOPBACK.has(req.socket?.remoteAddress ?? '')) return false;
  return !PROXY_MARKERS.some((h) => req.headers[h] !== undefined);
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/**
 * tailscaled writes a non-ASCII value as an RFC 2047 encoded word (=?utf-8?q?…?=). Logins are e-mail addresses and
 * GitHub names, so decode only that form, and only for comparing.
 */
export function decodeHeader(v: string): string {
  const m = /^=\?utf-8\?q\?(.*)\?=$/i.exec(v.trim());
  if (!m) return v.trim();
  try {
    return decodeURIComponent(m[1].replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, '%$1'));
  } catch {
    return v.trim();
  }
}

/** Who is calling and whether they may write. `owner` is the owner's login, or null when it isn't known. */
export function classify(req: ReqLike, owner: string | null): Caller {
  const addr = req.socket?.remoteAddress ?? '';
  if (!LOOPBACK.has(addr)) {
    return { source: 'direct', login: null, owner: false, canWrite: false, addr: addr || 'unknown', reason: t('access.reason.direct') };
  }
  if (localOnly(req)) return { source: 'loopback', login: null, owner: true, canWrite: true };
  if (req.headers['tailscale-funnel-request'] !== undefined) {
    return { source: 'serve', login: null, owner: false, canWrite: false, reason: t('access.reason.funnel') };
  }
  const raw = one(req.headers['tailscale-user-login']);
  const login = raw ? decodeHeader(raw).slice(0, 200) : null;
  const fwd = forwardedAddr(req);
  const at = fwd ? { addr: fwd } : {};
  if (!login) {
    // tailscale serve always sets X-Forwarded-For: without it this came through some other proxy
    const reason = fwd ? t('access.reason.tagged') : t('access.reason.noLogin');
    return { source: 'serve', login: null, owner: false, canWrite: false, ...at, reason };
  }
  if (!owner) return { source: 'serve', login, owner: false, canWrite: false, ...at, reason: t('access.reason.noOwner') };
  if (norm(login) !== norm(owner)) return { source: 'serve', login, owner: false, canWrite: false, ...at, reason: t('access.reason.notOwner', { login }) };
  return { source: 'serve', login, owner: true, canWrite: true, ...at };
}

/**
 * The client address tailscale serve put in X-Forwarded-For: exactly one IP (serve sets the header, it doesn't
 * append), else null. Only read on the serve path: on a direct connection the header is the client's own text.
 */
export function forwardedAddr(req: ReqLike): string | null {
  const v = one(req.headers['x-forwarded-for']);
  if (!v) return null;
  const parts = v.split(',').map((x) => x.trim());
  if (parts.length !== 1) return null;
  const ip = parts[0].replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  return isIP(ip) ? ip : null;
}

/** 100.64.0.0/10 (CGNAT, Tailscale's IPv4 range) or fd7a:115c:a1e0::/48 (Tailscale's IPv6 range). */
export function isTailnetAddr(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  return isIP(ip) === 6 && /^fd7a:115c:a1e0:/i.test(ip);
}

/** `tailscale whois --json` → the node's short name, stable ID and tags. Never its keys, endpoints or user profile. */
export function parseWhois(json: string, addr: string): Device {
  try {
    const n = JSON.parse(json)?.Node;
    if (!n || typeof n !== 'object') return { addr };
    const fqdn = typeof n.Name === 'string' ? n.Name.replace(/\.$/, '') : '';
    const short = typeof n.ComputedName === 'string' && n.ComputedName ? n.ComputedName : fqdn.split('.')[0];
    const tags: string[] = Array.isArray(n.Tags) ? n.Tags.filter((t: unknown) => typeof t === 'string').slice(0, 20) : [];
    return {
      addr,
      ...(short ? { name: String(short).slice(0, 80) } : {}),
      ...(typeof n.StableID === 'string' && n.StableID ? { id: n.StableID.slice(0, 64) } : {}),
      ...(tags.length ? { tags } : {}),
    };
  } catch {
    return { addr };
  }
}

export interface ResolverOptions {
  /** runs `tailscale <args>` (default: argv only, no shell, 3 s timeout) */
  run?: (args: string[]) => Promise<RunResult>;
  /** how long a known node is kept (default 3 min) */
  ttlMs?: number;
  /** how long an address whois didn't know is kept (default 1 min) */
  missMs?: number;
  /** addresses kept at most (default 512) */
  max?: number;
  now?: () => number;
}

/**
 * address → Device through `tailscale whois --json`, cached per address. Concurrent lookups of one address share a
 * run, and addresses outside the tailnet ranges are never looked up, so a flood of requests costs at most one
 * subprocess per address per few minutes.
 */
export function deviceResolver(opts: ResolverOptions = {}): (addr: string) => Promise<Device> {
  const exec = opts.run ?? ((args: string[]) => run('tailscale', args, 3_000));
  const ttl = opts.ttlMs ?? 180_000;
  const miss = opts.missMs ?? 60_000;
  const max = opts.max ?? 512;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { until: number; value: Promise<Device> }>();
  return (addr: string) => {
    if (!isTailnetAddr(addr)) return Promise.resolve({ addr });
    const t = now();
    const hit = cache.get(addr);
    if (hit && t < hit.until) return hit.value;
    cache.delete(addr);
    if (cache.size >= max) {
      for (const [k, v] of cache) if (t >= v.until) cache.delete(k);
      for (const k of cache.keys()) {
        if (cache.size < max) break;
        cache.delete(k);
      }
    }
    const entry: { until: number; value: Promise<Device> } = { until: t + ttl, value: Promise.resolve({ addr }) };
    entry.value = exec(['whois', '--json', addr]).then(
      (r) => {
        const d = r.ok ? parseWhois(r.stdout, addr) : { addr };
        if (!d.name && !d.id) entry.until = now() + miss;
        return d;
      },
      () => {
        entry.until = now() + miss;
        return { addr };
      },
    );
    cache.set(addr, entry);
    return entry.value;
  };
}

// ---------- the write-device allowlist (M1) ----------

/** writeDevices from access.json plus PORTBOARD_WRITE_DEVICES. */
export interface WriteDevices {
  /** node names (short or full MagicDNS name) and stable node IDs */
  list: string[];
  /** access.json is there but can't be used (bad JSON or shape, not 0600): serve writes are refused until it's fixed */
  error?: string;
}

/**
 * The allowlist, or null when neither access.json's `writeDevices` nor PORTBOARD_WRITE_DEVICES (comma list) is set:
 * then any device logged in as the owner may write through serve, as before. The two are merged. The file is
 * `{"writeDevices": ["dev-mac", "iphone", "nAbC123CNTRL"]}` with mode 0600; a file group or others can
 * read or write fails closed. Read on every call (only writes and /api/whoami ask), so an edit applies at once.
 */
export async function loadWriteDevices(path: string, env: Record<string, string | undefined> = process.env): Promise<WriteDevices | null> {
  const fromEnv = (env.PORTBOARD_WRITE_DEVICES ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const fail = (error: string): WriteDevices => ({ list: fromEnv, error });
  let text: string;
  try {
    const st = await stat(path);
    if ((st.mode & 0o077) !== 0) return fail(t('access.file.mode'));
    text = await readFile(path, 'utf8');
  } catch (err: any) {
    if (err?.code !== 'ENOENT') return fail(t('access.file.unreadable'));
    return fromEnv.length ? { list: [...new Set(fromEnv)] } : null;
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return fail(t('access.file.notJson'));
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(t('access.file.notObject'));
  const raw = (v as Record<string, unknown>).writeDevices;
  if (raw === undefined) return fromEnv.length ? { list: [...new Set(fromEnv)] } : null;
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) return fail(t('access.file.notList'));
  const list = raw.map((x) => x.trim()).filter(Boolean).slice(0, 100);
  return { list: [...new Set([...list, ...fromEnv])] };
}

/**
 * Whether the allowlist names this device: its stable node ID (exact), or its name — the short MagicDNS name, or the
 * full one ("dev-mac.tail1234.ts.net", trailing dot or not), in any letter case.
 */
export function deviceAllowed(d: Device | undefined, list: string[]): boolean {
  if (!d) return false;
  const name = (d.name ?? '').toLowerCase();
  return list.some((raw) => {
    const e = raw.trim().replace(/\.$/, '');
    if (!e) return false;
    if (d.id && e === d.id) return true;
    return !!name && e.toLowerCase().split('.')[0] === name;
  });
}

/** A node name (short or full MagicDNS) or a stable node ID: what writeDevices may hold. */
export const DEVICE_ENTRY = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
export const MAX_WRITE_DEVICES = 100;

/** Checks a list to save: names or IDs only, trimmed and de-duplicated, at least one. A string is the reason it is refused. */
export function checkWriteDevices(v: unknown): string[] | string {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return t('access.check.notList');
  const list = [...new Set(v.map((x) => x.trim().replace(/\.$/, '')).filter(Boolean))];
  if (!list.length) return t('access.check.empty');
  if (list.length > MAX_WRITE_DEVICES) return t('access.check.tooMany', { n: MAX_WRITE_DEVICES });
  const bad = list.find((x) => !DEVICE_ENTRY.test(x));
  if (bad) return t('access.check.badName', { name: bad.slice(0, 60) });
  return list;
}

/**
 * Replace access.json's writeDevices with `list` (checked by checkWriteDevices), keeping its other keys. Written 0600
 * through a temp file and a rename (atomic.ts). A file that isn't a JSON object is left alone: the owner fixes it by hand.
 */
export async function saveWriteDevices(path: string, list: string[]): Promise<void> {
  let doc: Record<string, unknown> = {};
  let text: string | null = null;
  try {
    text = await readFile(path, 'utf8');
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw new Error(t('access.save.unreadable'));
  }
  if (text !== null && text.trim()) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Error(t('access.save.notJson'));
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(t('access.save.notObject'));
    doc = v as Record<string, unknown>;
  }
  await writePrivate(path, `${JSON.stringify({ ...doc, writeDevices: list })}\n`);
}

/** "dev-mac(100.64.1.2)", or the address alone */
export const deviceLabel = (d: Device | undefined, addr?: string): string => (d?.name ? `${d.name}(${d.addr})` : (d?.addr ?? addr ?? t('access.noAddr')));

/** Through serve with an allowlist set, only the listed devices keep write access. Everything else stays as classified. */
export function restrictToDevices(c: Caller, allow: WriteDevices | null): Caller {
  if (!allow || !c.canWrite || c.source !== 'serve') return c;
  const deny = (reason: string): Caller => ({ ...c, canWrite: false, reason });
  if (allow.error) return deny(t('access.deny.fileError', { error: allow.error }));
  if (!c.device?.name && !c.device?.id) return deny(t('access.deny.unknownDevice', { device: deviceLabel(c.device, c.addr) }));
  if (!deviceAllowed(c.device, allow.list)) return deny(t('access.deny.notListed', { device: deviceLabel(c.device, c.addr) }));
  return c;
}

export interface CallerDeps {
  owner(): Promise<string | null>;
  /** tailscale whois, cached (deviceResolver) */
  device(addr: string): Promise<Device>;
  /** the allowlist (loadWriteDevices), null when it isn't set */
  writeDevices(): Promise<WriteDevices | null>;
}

/** classify, plus the device behind a serve or direct caller and the write-device allowlist. For writes and /api/whoami. */
export async function resolveCaller(req: ReqLike, deps: CallerDeps): Promise<Caller> {
  let c = classify(req, await deps.owner());
  const addr = c.addr;
  if ((c.source === 'serve' || c.source === 'direct') && addr && isIP(addr)) {
    c = { ...c, device: await deps.device(addr).catch((): Device => ({ addr })) };
  }
  return c.source === 'serve' && c.canWrite ? restrictToDevices(c, await deps.writeDevices()) : c;
}

/** The stdio MCP server: a child of a local Claude session, so the owner. */
export const MCP_CALLER: Caller = { source: 'mcp', login: null, owner: true, canWrite: true };

/**
 * `tailscale status --json` → the owner's login: Self.UserID's LoginName. A tagged server has no owning user (its
 * UserID is the "tagged-devices" pseudo-user), so then only PORTBOARD_OWNER_LOGIN can name the owner.
 */
export function ownerFromStatus(json: string): string | null {
  try {
    const s = JSON.parse(json);
    const self = s?.Self;
    if (!self || (Array.isArray(self.Tags) && self.Tags.length)) return null;
    const login = s?.User?.[String(self.UserID)]?.LoginName;
    return typeof login === 'string' && login.includes('@') ? login : null;
  } catch {
    return null;
  }
}

/** PORTBOARD_OWNER_LOGIN, else this node's Tailscale user (cached with the other `tailscale status` callers). */
export async function ownerLogin(env: Record<string, string | undefined> = process.env): Promise<string | null> {
  const set = env.PORTBOARD_OWNER_LOGIN?.trim();
  if (set) return set;
  const r = await runShared('tailscale', ['status', '--json']);
  return r.ok ? ownerFromStatus(r.stdout) : null;
}
