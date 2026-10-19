// `portboard agent` (c10dev/portboard#10): one machine's ports, who uses them and its load, served read-only as JSON to
// the board that aggregates every agent. This module is the pure part — who may read (authorize), what leaves the
// machine (the projections) and the HTTP handler; src/agent.ts binds it.
//
//   GET /agent/v1/info    version, host name, MagicDNS name, load (cores, load1, memory, disk, uptime)
//   GET /agent/v1/ports   listening sockets as the board's host-port lists take them (port, bind address, process
//                         name) and the redacted port list the remote connector gives (names, kinds, HTTP titles, URLs)
//   GET /agent/v1/usage   who uses what on this machine, redacted like the remote connector's who_uses_what
//
// Nothing else: no write route in v1. Per-host writes (restart, stop, expose) are a follow-up and will stay owner-only.
//
// Who may read, in order:
//   1. loopback   a process on this machine (no proxy header: tailscale serve proxies from 127.0.0.1 too)
//   2. token      `Authorization: Bearer <token>` equal to the agent's token (portboard.json agent.token or
//                 PORTBOARD_AGENT_TOKEN). A token that is sent and wrong is refused, never tried as anything else
//   3. tailscale  the caller's tailnet address, through `tailscale whois`, is a node or login on the allowlist
//                 (agent.allow / PORTBOARD_AGENT_ALLOW): a short or full MagicDNS name, a stable node ID, a login
//                 (user@example.com) or an ACL tag (tag:portboard)
// With neither a token nor an allowlist, only loopback reads (fail closed).
//
// What leaves: never pids, command lines, cwd paths, unit descriptions, ssh commands or MACs. Bind addresses keep their
// class (0.0.0.0, ::, loopback, this machine's Tailscale IPs, which the board already knows); a LAN or docker address
// becomes [lan-ip] / [ip] unless agent.showAddresses. Process names are the first word of the command line without
// its path, or the container or unit name.

import { timingSafeEqual, createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename } from 'node:path';
import { deviceAllowed, isTailnetAddr, localOnly, parseWhois, type Device } from '../core/access.ts';
import { keyedCache } from '../core/cache.ts';
import type { RunResult } from '../core/exec.ts';
import type { PortEntry, Snapshot } from '../core/index.ts';
import type { ListenPort } from '../core/pool.ts';
import { classify } from '../core/ss.ts';
import type { Usage } from '../core/usage.ts';
import { redactPorts, redactUsage, scrubText, type RedactPolicy } from '../remote/redact.ts';

export const AGENT_API = '/agent/v1';
/** The version of the JSON the routes answer; the board refuses another */
export const AGENT_SCHEMA = 1;

// ---- who may read ----

/** A tailnet caller as `tailscale whois` knows it: the node (name, stable ID, tags) and the login it runs as */
export interface Identity {
  device: Device;
  /** UserProfile.LoginName; tagged nodes have none worth matching ("tagged-devices") */
  login?: string;
}

/** `tailscale whois --json` → the node and its login. Only names and IDs are kept, never keys or endpoints. */
export function parseIdentity(json: string, addr: string): Identity {
  const device = parseWhois(json, addr);
  try {
    const login = JSON.parse(json)?.UserProfile?.LoginName;
    if (typeof login === 'string' && login.includes('@') && !device.tags?.length) return { device, login: login.slice(0, 200) };
  } catch {
    // device alone
  }
  return { device };
}

/** Does the allowlist name this caller: a node (deviceAllowed), a login (has @) or an ACL tag (tag:…), any case */
export function identityAllowed(who: Identity, allow: readonly string[]): boolean {
  const logins = allow.filter((e) => e.includes('@')).map((e) => e.trim().toLowerCase());
  const tags = allow.filter((e) => e.startsWith('tag:')).map((e) => e.trim().toLowerCase());
  const nodes = allow.filter((e) => !e.includes('@') && !e.startsWith('tag:'));
  if (who.login && logins.includes(who.login.toLowerCase())) return true;
  if (who.device.tags?.some((t) => tags.includes(t.toLowerCase()))) return true;
  return deviceAllowed(who.device, nodes);
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time comparison of a presented bearer token with the configured one */
export function tokenMatches(presented: string, expected: string | null): boolean {
  if (!expected) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

export interface AuthOptions {
  allow: readonly string[];
  token: string | null;
  /** the caller at a tailnet address (cached; addresses outside the tailnet ranges are never looked up) */
  whois: (addr: string) => Promise<Identity>;
  /** a local process may read (default true; tests turn it off to reach the other paths over loopback) */
  trustLoopback?: boolean;
}

export type AuthResult =
  | { ok: true; via: 'loopback' | 'token' | 'tailscale'; who: string }
  | { ok: false; status: 401 | 403; error: string };

interface ReqLike {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string } | null;
}

const header = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
/** ::ffff:100.64.0.1 → 100.64.0.1 */
const plainAddr = (a: string) => a.replace(/^::ffff:(?=\d+\.)/, '');

export async function authorize(req: ReqLike, o: AuthOptions): Promise<AuthResult> {
  if ((o.trustLoopback ?? true) && localOnly(req)) return { ok: true, via: 'loopback', who: 'loopback' };
  const auth = header(req.headers.authorization);
  if (auth !== undefined) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    if (m && tokenMatches(m[1], o.token)) return { ok: true, via: 'token', who: 'token' };
    return { ok: false, status: 401, error: 'bad token' };
  }
  const addr = plainAddr(req.socket?.remoteAddress ?? '');
  if (o.allow.length && isTailnetAddr(addr)) {
    const who = await o.whois(addr).catch((): Identity => ({ device: { addr } }));
    if (identityAllowed(who, o.allow)) return { ok: true, via: 'tailscale', who: who.device.name ?? who.login ?? addr };
  }
  return { ok: false, status: 403, error: 'not allowed' };
}

export interface IdentityResolverOptions {
  run: (args: string[]) => Promise<RunResult>;
  ttlMs?: number;
  missMs?: number;
  now?: () => number;
}

/** address → Identity through `tailscale whois --json`, cached per address like access.ts's deviceResolver */
export function identityResolver(o: IdentityResolverOptions): (addr: string) => Promise<Identity> {
  const cache = keyedCache(
    (addr: string): Promise<Identity> =>
      o.run(['whois', '--json', addr]).then((r) => (r.ok ? parseIdentity(r.stdout, addr) : { device: { addr } }), () => ({ device: { addr } })),
    { ttlMs: o.ttlMs ?? 180_000, maxEntries: 512, shortMs: (w) => (!w.device.name && !w.device.id ? (o.missMs ?? 60_000) : null), now: o.now },
  );
  return (addr: string) => (isTailnetAddr(addr) ? cache(addr) : Promise.resolve({ device: { addr } }));
}

// ---- what leaves the machine ----

export interface HostLoad {
  cores: number;
  load1: number;
  memTotalMb: number | null;
  memAvailMb: number | null;
  diskFreePct: number | null;
  uptimeSec: number;
}

export interface AgentInfo {
  schema: number;
  version: string;
  /** this machine's short host name */
  host: string;
  /** its MagicDNS name, when Tailscale runs */
  dnsName: string | null;
  /** ms */
  at: number;
  load: HostLoad;
}

export interface AgentPorts {
  schema: number;
  /** ms: when the snapshot was taken */
  at: number;
  host: string;
  /** one row per bind address, the shape compute-pool's /api/hosts uses (hostports.ts fromListening reads it) */
  listening: ListenPort[];
  /** the remote connector's list_ports projection, system ports included */
  services: ReturnType<typeof redactPorts>['ports'];
}

/** The name a port's owner goes by, without arguments or a path: container, unit, the command's basename, the system owner */
export function processName(p: Pick<PortEntry, 'container' | 'processes' | 'systemOwner'>): string | null {
  if (p.container) return p.container;
  const proc = p.processes[0];
  if (proc?.unit) return proc.unit.replace(/\.service$/, '');
  const argv0 = proc?.cmdline.trim().split(/\s+/)[0];
  if (argv0) return basename(argv0).slice(0, 64) || null;
  return p.systemOwner ?? null;
}

/** A bind address the board may see: the wildcard, loopback and Tailscale classes as they are, others scrubbed */
export function bindAddress(address: string, policy: RedactPolicy): string {
  const scope = classify(address);
  if (scope !== 'other' || policy.showAddresses) return address;
  return scrubText(address, policy);
}

export function projectPorts(snap: Snapshot, policy: RedactPolicy): AgentPorts {
  const listening: ListenPort[] = [];
  for (const p of snap.ports) {
    if (!p.listening) continue;
    const name = processName(p);
    const proc = name ? scrubText(name, policy) : null;
    for (const a of p.addresses) listening.push(proc ? { port: p.port, address: bindAddress(a, policy), process: proc } : { port: p.port, address: bindAddress(a, policy) });
  }
  return {
    schema: AGENT_SCHEMA,
    at: Date.parse(snap.at) || Date.now(),
    host: scrubText(snap.host.hostname, policy),
    listening,
    services: redactPorts(snap, { include_system: true }, policy).ports,
  };
}

export function projectUsage(u: Usage, policy: RedactPolicy) {
  return { schema: AGENT_SCHEMA, ...redactUsage(u, policy) };
}

// ---- HTTP ----

export interface AgentSources {
  snapshot(): Promise<Snapshot>;
  usage(): Promise<Usage>;
  info(): Promise<AgentInfo>;
}

export interface AgentHandlerOptions {
  sources: AgentSources;
  auth: AuthOptions;
  policy: RedactPolicy;
  /** Host header names this machine answers to (DNS-rebinding guard); null: any */
  hosts: Set<string> | null;
  log?: (line: string) => void;
}

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
} as const;

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { ...HEADERS, ...extra });
  res.end(JSON.stringify(body));
}

function hostOf(req: IncomingMessage): string {
  const raw = (req.headers.host ?? '').toLowerCase();
  return raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.replace(/:\d+$/, '');
}

export function createAgentHandler(o: AgentHandlerOptions) {
  const log = o.log ?? ((line: string) => console.error(`[portboard-agent] ${line}`));
  const routes: Record<string, () => Promise<unknown>> = {
    [`${AGENT_API}/info`]: () => o.sources.info(),
    [`${AGENT_API}/ports`]: async () => projectPorts(await o.sources.snapshot(), o.policy),
    [`${AGENT_API}/usage`]: async () => projectUsage(await o.sources.usage(), o.policy),
  };
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (o.hosts && !o.hosts.has(hostOf(req))) return send(res, 421, { error: 'unknown host' });
      const path = new URL(req.url ?? '/', 'http://x').pathname.replace(/\/+$/, '');
      if (req.method !== 'GET') return send(res, 405, { error: 'read-only' }, { allow: 'GET' });
      const auth = await authorize(req, o.auth);
      if (!auth.ok) return send(res, auth.status, { error: auth.error }, auth.status === 401 ? { 'www-authenticate': 'Bearer' } : {});
      const route = routes[path];
      if (!route) return send(res, 404, { error: 'not found' });
      send(res, 200, await route());
    } catch (err) {
      log(`${req.method} ${(req.url ?? '').split('?')[0]}: ${(err as Error).message}`);
      if (res.headersSent) res.destroy();
      else send(res, 500, { error: 'internal error' });
    }
  };
}
