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
//
// Token mode (c10dev/portboard#12), opt-in (`"mode": "token"` in access.json or PORTBOARD_ACCESS_MODE=token), for an
// install without Tailscale or one that wants writes from the LAN: a request that carries `Authorization: Bearer
// <owner token>` writes, from any address, recorded as source `token`. The token is 32 random bytes made by
// `portboard token`; only its sha256 is kept (owner-token.json, 0600). On top of the table above:
//   - Funnel never writes, token or not: checked first.
//   - A token that is sent but wrong (or can't be checked: no token made yet, a broken file) takes write rights away,
//     even from loopback: sending something can lose rights, never gain them without the real token.
//   - requireTokenOnLoopback: a local process needs the token too, and so does serve. On loopback tailscaled's
//     headers can be typed by any local process, so a serve login can't stand in for the token any more.
//   - Without a token, everything else is decided as in tailscale mode (serve with the owner's login still writes).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { keyedCache } from './cache.ts';
import { run, runShared, type RunResult } from './exec.ts';
import { writePrivate } from './atomic.ts';
import { t } from './i18n.ts';

export type Source = 'loopback' | 'serve' | 'direct' | 'mcp' | 'token';

export interface Caller {
  source: Source;
  /** Tailscale login through serve; null for loopback, direct and tagged devices */
  login: string | null;
  /** The owner: loopback, mcp, serve with the owner's login, or the owner token (token mode) */
  owner: boolean;
  canWrite: boolean;
  /** Why not, in Korean for the dashboard (set when canWrite is false; the UI puts "읽기 전용" in front) */
  reason?: string;
  /**
   * direct, and token from another machine: the socket address; serve, and token through a proxy: the X-Forwarded-For
   * address (when it is one IP)
   */
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

/**
 * Who is calling and whether they may write. `owner` is the owner's login, or null when it isn't known. `policy`:
 * token mode's settings (loadAccessPolicy); without one, or in tailscale mode, the Authorization header is never read.
 */
export function classify(req: ReqLike, owner: string | null, policy: AccessPolicy = TAILSCALE_POLICY): Caller {
  return policy.mode === 'token' ? classifyToken(req, owner, policy) : classifyTailscale(req, owner);
}

/** Token mode: the rules in the header comment, on top of tailscale mode's decision. */
function classifyToken(req: ReqLike, owner: string | null, policy: AccessPolicy): Caller {
  const base = classifyTailscale(req, owner);
  const sock = req.socket?.remoteAddress ?? '';
  const loopback = LOOPBACK.has(sock);
  // With the token required on loopback, a serve login there is only text any local process could have typed: not
  // recorded as who it was
  const forgeable = policy.requireTokenOnLoopback && loopback;
  const deny = (reason: string): Caller => ({ ...base, ...(forgeable ? { login: null } : {}), owner: false, canWrite: false, reason });
  // Funnel is the public internet: never a write, whatever it sends (a leaked token must not open the dashboard to it)
  if (loopback && req.headers['tailscale-funnel-request'] !== undefined) return deny(t('access.reason.funnel'));
  const sent = bearerToken(req);
  if (sent !== undefined) {
    const why = tokenProblem(sent, policy);
    if (why) return deny(why);
    // where it came from, for the audit line: the socket, or the address a proxy in front of us gave
    const addr = !loopback ? sock || 'unknown' : localOnly(req) ? null : forwardedAddr(req);
    return { source: 'token', login: null, owner: true, canWrite: true, ...(addr ? { addr } : {}) };
  }
  // serve's login comes over loopback too, and any local process can type it: with the token required there, only
  // the token counts
  if (forgeable) return deny(t('access.reason.tokenRequired'));
  if (base.source === 'direct') return deny(t('access.reason.directToken'));
  return base;
}

/**
 * The token in `Authorization: Bearer <token>`: undefined without an Authorization header, '' when there is one but it
 * isn't a bearer token of a sane shape (that counts as a wrong token).
 */
export function bearerToken(req: ReqLike): string | undefined {
  const v = one(req.headers.authorization);
  if (v === undefined) return undefined;
  const m = /^Bearer[ \t]+([A-Za-z0-9._~+/=-]{1,256})[ \t]*$/i.exec(v);
  return m ? m[1] : '';
}

/** Why `token` doesn't make the caller the owner (a reason for the dashboard), or null when it is the owner token. */
export function tokenProblem(token: string, policy: AccessPolicy): string | null {
  if (policy.error) return t('access.reason.tokenFile', { error: policy.error });
  if (!policy.tokenHash) return t('access.reason.noToken');
  return tokenMatches(token, policy.tokenHash) ? null : t('access.reason.badToken');
}

function classifyTailscale(req: ReqLike, owner: string | null): Caller {
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
  const cache = keyedCache(
    (addr: string): Promise<Device> => exec(['whois', '--json', addr]).then((r) => (r.ok ? parseWhois(r.stdout, addr) : { addr }), () => ({ addr })),
    // a lookup that found nobody (or failed) is asked again sooner, counted from when it answered
    { ttlMs: ttl, maxEntries: max, shortMs: (d) => (!d.name && !d.id ? miss : null), now: opts.now },
  );
  return (addr: string) => (isTailnetAddr(addr) ? cache(addr) : Promise.resolve({ addr }));
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
  /** token mode's settings (loadAccessPolicy); without it, tailscale mode */
  policy?(): Promise<AccessPolicy>;
}

/**
 * classify, plus the device behind a serve, direct or token caller and the write-device allowlist. For writes and
 * /api/whoami. The allowlist limits serve logins only: the owner token is its own credential.
 */
export async function resolveCaller(req: ReqLike, deps: CallerDeps): Promise<Caller> {
  let c = classify(req, await deps.owner(), deps.policy ? await deps.policy() : TAILSCALE_POLICY);
  const addr = c.addr;
  if ((c.source === 'serve' || c.source === 'direct' || c.source === 'token') && addr && isIP(addr)) {
    c = { ...c, device: await deps.device(addr).catch((): Device => ({ addr })) };
  }
  return c.source === 'serve' && c.canWrite ? restrictToDevices(c, await deps.writeDevices()) : c;
}

// ---------- token mode (#12) ----------

export type AccessMode = 'tailscale' | 'token';

/** How writes are decided: access.json's mode and requireTokenOnLoopback (and their env overrides), and the token hash. */
export interface AccessPolicy {
  mode: AccessMode;
  /** token mode only: loopback, and so serve, needs the token too */
  requireTokenOnLoopback: boolean;
  /** sha256 of the owner token, hex; null when `portboard token` hasn't made one */
  tokenHash: string | null;
  /** the mode settings or owner-token.json can't be used: token writes are refused until it's fixed */
  error?: string;
}

/** The default: no token, the Authorization header is never read. */
export const TAILSCALE_POLICY: AccessPolicy = { mode: 'tailscale', requireTokenOnLoopback: false, tokenHash: null };

/** Owner tokens: `pbt_` and 32 random bytes, base64url (47 characters). */
export const TOKEN_PREFIX = 'pbt_';

export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** A new owner token and the hash to keep. The token itself is printed once and never stored. */
export function generateToken(): { token: string; hash: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashToken(token) };
}

/** Constant time: the token is hashed to 32 bytes first, so neither its length nor its content shows in the timing. */
export function tokenMatches(token: string, hash: string): boolean {
  if (!token || !/^[0-9a-f]{64}$/.test(hash)) return false;
  return timingSafeEqual(createHash('sha256').update(token, 'utf8').digest(), Buffer.from(hash, 'hex'));
}

/** Write owner-token.json ({sha256, created}; 0600, atomically). Rotation: the old token stops working at once. */
export async function saveTokenHash(path: string, hash: string, now = new Date()): Promise<void> {
  await writePrivate(path, `${JSON.stringify({ sha256: hash, created: now.toISOString() })}\n`);
}

/** owner-token.json → its hash; null when there is none; error when it can't be used (not 0600, not its shape). */
export async function loadTokenHash(path: string): Promise<{ hash: string | null; created?: string; error?: string }> {
  let text: string;
  try {
    const st = await stat(path);
    if ((st.mode & 0o077) !== 0) return { hash: null, error: t('access.file.mode') };
    text = await readFile(path, 'utf8');
  } catch (err: any) {
    return err?.code === 'ENOENT' ? { hash: null } : { hash: null, error: t('access.file.unreadable') };
  }
  try {
    const v = JSON.parse(text);
    if (v && typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/.test(v.sha256)) {
      return { hash: v.sha256, ...(typeof v.created === 'string' ? { created: v.created.slice(0, 40) } : {}) };
    }
  } catch {}
  return { hash: null, error: t('access.token.badFile') };
}

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test((v ?? '').trim());

/**
 * The access policy: access.json's `mode` ("tailscale", the default, or "token") and `requireTokenOnLoopback`, then
 * PORTBOARD_ACCESS_MODE (replaces mode) and PORTBOARD_REQUIRE_TOKEN_ON_LOOPBACK=1 (can only turn it on), then the
 * token hash (token mode only). Read on every call, like the write-device allowlist, so an edit or a new token applies
 * at once. A mode that is neither is an error and counts as tailscale mode: a typo never opens anything.
 */
export async function loadAccessPolicy(accessPath: string, tokenPath: string, env: Record<string, string | undefined> = process.env): Promise<AccessPolicy> {
  const errors: string[] = [];
  let fileMode: unknown;
  let fileLoopback: unknown;
  try {
    const st = await stat(accessPath);
    if ((st.mode & 0o077) !== 0) errors.push(`access.json: ${t('access.file.mode')}`);
    else {
      const v: unknown = JSON.parse(await readFile(accessPath, 'utf8'));
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        fileMode = (v as Record<string, unknown>).mode;
        fileLoopback = (v as Record<string, unknown>).requireTokenOnLoopback;
      } else errors.push(`access.json: ${t('access.file.notObject')}`);
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') errors.push(`access.json: ${err instanceof SyntaxError ? t('access.file.notJson') : t('access.file.unreadable')}`);
  }
  const raw = env.PORTBOARD_ACCESS_MODE?.trim() || fileMode;
  let mode: AccessMode = 'tailscale';
  if (raw === 'token' || raw === 'tailscale') mode = raw;
  else if (raw !== undefined) errors.push(t('access.token.badMode', { mode: String(raw).slice(0, 40) }));
  if (fileLoopback !== undefined && typeof fileLoopback !== 'boolean') errors.push(t('access.token.badLoopback'));
  const requireTokenOnLoopback = mode === 'token' && (fileLoopback === true || truthy(env.PORTBOARD_REQUIRE_TOKEN_ON_LOOPBACK));
  const tok = mode === 'token' ? await loadTokenHash(tokenPath) : { hash: null };
  if (tok.error) errors.push(`owner-token.json: ${tok.error}`);
  return { mode, requireTokenOnLoopback, tokenHash: tok.hash, ...(errors.length ? { error: errors.join('; ') } : {}) };
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
