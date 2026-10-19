// This install's site values (c10dev/portboard#37): which host it is, its tailnet, the checkout it runs from, where
// the repos are, the compute-pool monitor, the dashboard and public connector URLs, and the pve/Windows SSH targets.
// Each resolves, per value, in this order:
//
//   1. env        the environment variables that already existed (PORTBOARD_POOL_URL, PORTBOARD_REPOS_ROOT,
//                 PORTBOARD_DASHBOARD_URL); there is no new variable per key
//   2. runtime    what the machine says: `tailscale status --json` (host, tailnet), the git checkout of the running
//                 code (checkout), the OS user, `tailscale serve status --json` (dashboard URL)
//   3. file       ~/.config/portboard/portboard.json (paths.ts; PORTBOARD_SITE moves it; a preview has its own copy),
//                 then portboard.json at the root of the checkout the code runs from (an install that keeps its site
//                 config with the code; the user file wins key by key)
//   4. default    SITE_DEFAULTS below: generic values read from this machine, with the Proxmox and Windows readers off
//
// Two views: SITE is synchronous (env, files, default: no runtime) for text built at import, like MCP tool
// descriptions and the remote server's instructions; site() adds the runtime sources and is what the 설정 tab and the
// setup checklist show. docs/config.md documents every key.
//
// Nothing is logged at import (the stdio MCP server's stdout is JSON-RPC): a bad file is reported in SITE.fileError,
// which server.ts and remote.ts print at start.

import { readFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyedCache } from './cache.ts';
import { run } from './exec.ts';
import { PATHS } from './paths.ts';
import { dashboardUrl, serveStatus, tailscaleInfo, type ServeEntry } from './tailscale.ts';

/** The UI and server text languages (public/i18n/<locale>.json) */
export const LOCALES = ['en', 'ko'] as const;
export type Locale = (typeof LOCALES)[number];
export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

/** "+09:00", "-05:30", "Z" → the offset from UTC in ms; anything else → null. A fixed offset: no DST. */
export function parseUtcOffset(v: unknown): number | null {
  if (v === 'Z') return 0;
  const m = typeof v === 'string' ? /^([+-])(\d{2}):(\d{2})$/.exec(v) : null;
  if (!m) return null;
  const h = Number(m[2]);
  const min = Number(m[3]);
  if (h > 14 || min > 59) return null;
  return (m[1] === '-' ? -1 : 1) * (h * 60 + min) * 60_000;
}

const CODE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** portboard.json next to the code (the checkout root), read under the user's file */
export const CHECKOUT_SITE = join(CODE_ROOT, 'portboard.json');

function osUser(): string | null {
  try {
    return userInfo().username || null;
  } catch {
    return null;
  }
}

/**
 * What Portboard uses when nothing else says: this machine's short host name, no tailnet, the OS user, the checkout
 * the code runs from, and the Proxmox and Windows SSH readers off until portboard.json (or pveports.json /
 * winports.json) names their hosts.
 */
export const SITE_DEFAULTS = {
  host: hostname().split('.')[0] || 'localhost',
  /** '' : not known (no tailscale, no file); dnsName is then the host alone */
  tailnet: '',
  user: osUser() ?? 'user',
  checkout: CODE_ROOT.replace(/\/+$/, ''),
  reposRoot: ['~/projects'],
  poolUrl: 'http://127.0.0.1:7720',
  /** No default: the dashboard URL is whatever `tailscale serve` publishes (https 8443 in setup.md) */
  dashboardUrl: null as string | null,
  /** No default: https://<dnsName>, the address Tailscale Funnel gives this machine */
  publicUrl: null as string | null,
  /** pveports.json's defaults (the Proxmox host and its containers, read over SSH): off until a host is set */
  pve: { host: 'pve', user: 'root', key: '~/.ssh/portboard_ro', node: 'pve', enabled: false },
  /** The language of the text the server writes (alerts, the setup checklist, MCP text) and of the shell it renders */
  locale: 'en' as Locale,
  /** The fixed UTC offset the digest schedule and the adoption days are counted in (the default keeps the original KST) */
  utcOffset: '+09:00',
  /** winports.json's defaults (a desktop's Windows side, read over SSH): off until a host is set */
  windows: { host: 'windows', user: null as string | null, key: '~/.ssh/portboard_ro', device: 'windows', enabled: false },
};

/** portboard.json: every key optional. pve/windows are partial defaults; pveports.json and winports.json still win. */
export interface SiteFile {
  host?: string;
  tailnet?: string;
  user?: string;
  checkout?: string;
  reposRoot?: string | string[];
  poolUrl?: string;
  dashboardUrl?: string;
  publicUrl?: string;
  locale?: string;
  utcOffset?: string;
  pve?: Record<string, unknown>;
  windows?: Record<string, unknown>;
}

/** What the machine said; null/undefined: not asked (SITE) or couldn't tell. */
export interface SiteRuntime {
  /** tailscale status Self.HostName */
  hostName?: string | null;
  /** tailscale status Self.DNSName, trailing dot off: <host>.<tailnet> */
  dnsName?: string | null;
  /** the main checkout of the running code (the parent of git's common dir: a worktree's main checkout) */
  checkout?: string | null;
  user?: string | null;
  /** tailscale serve status; with dashboardPort, gives the dashboard URL */
  serve?: ServeEntry[] | null;
  /** the local port the dashboard listens on (8790) */
  dashboardPort?: number;
}

export type SiteSource = 'env' | 'runtime' | 'file' | 'default';

export interface Site {
  host: string;
  tailnet: string;
  /** <host>.<tailnet>: tailscale's own name when it runs, else built from host and tailnet */
  dnsName: string;
  /** the account Portboard runs as (for `user@host` in commands to copy) */
  user: string;
  /** the main checkout production runs from (deploy/portboard.service) */
  checkout: string;
  /** roots whose direct subfolders are git repos (개발 tab), ~ expanded */
  reposRoots: string[];
  poolUrl: string;
  dashboardUrl: string | null;
  /** the public Funnel URL: portboard.json's publicUrl, else https://<dnsName> */
  publicUrl: string;
  /** 'en' | 'ko': PORTBOARD_LOCALE, else portboard.json's locale, else en */
  locale: Locale;
  /** "+09:00": PORTBOARD_UTC_OFFSET, else portboard.json's utcOffset, else +09:00 */
  utcOffset: string;
  /** utcOffset in ms */
  utcOffsetMs: number;
  pve: typeof SITE_DEFAULTS.pve;
  windows: typeof SITE_DEFAULTS.windows;
  /** where each value came from */
  sources: Record<'host' | 'tailnet' | 'dnsName' | 'user' | 'checkout' | 'reposRoots' | 'poolUrl' | 'dashboardUrl' | 'publicUrl' | 'locale' | 'utcOffset', SiteSource>;
  /** the portboard.json path read (whether or not it exists) */
  file: string;
  /** the file exists and was used */
  fileFound: boolean;
  /** the checkout's portboard.json when it exists and was used (under the user file), else null */
  checkoutFile: string | null;
  /** why the file was ignored (invalid JSON, not an object, a key of the wrong type); null when fine or absent */
  fileError: string | null;
}

type Env = Record<string, string | undefined>;

const STRING_KEYS = ['host', 'tailnet', 'user', 'checkout', 'poolUrl', 'dashboardUrl', 'publicUrl', 'locale', 'utcOffset'] as const;
const OBJECT_KEYS = ['pve', 'windows'] as const;

/** Parses portboard.json. A key of the wrong type is dropped (and reported); the rest still apply. */
export function parseSiteFile(text: string | null): { file: SiteFile; found: boolean; error: string | null } {
  if (text === null) return { file: {}, found: false, error: null };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { file: {}, found: true, error: 'portboard.json is not valid JSON' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { file: {}, found: true, error: 'portboard.json must be an object' };
  const r = raw as Record<string, unknown>;
  const file: SiteFile = {};
  const bad: string[] = [];
  for (const k of STRING_KEYS) {
    if (r[k] === undefined) continue;
    if (typeof r[k] === 'string' && r[k] && (k !== 'locale' || isLocale(r[k])) && (k !== 'utcOffset' || parseUtcOffset(r[k]) !== null)) file[k] = r[k] as string;
    else bad.push(k);
  }
  if (r.reposRoot !== undefined) {
    const v = r.reposRoot;
    if ((typeof v === 'string' && v) || (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string' && x))) file.reposRoot = v as string | string[];
    else bad.push('reposRoot');
  }
  for (const k of OBJECT_KEYS) {
    if (r[k] === undefined) continue;
    if (r[k] && typeof r[k] === 'object' && !Array.isArray(r[k])) file[k] = r[k] as Record<string, unknown>;
    else bad.push(k);
  }
  return { file, found: true, error: bad.length ? `portboard.json: ignored ${bad.join(', ')} (wrong type)` : null };
}

const expand = (p: string, home: string) => (p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p);
const nonEmpty = (v: string | null | undefined): v is string => typeof v === 'string' && v.length > 0;

/** The first of env, runtime, file, default that has a value, and which one it was. */
function pick<T>(env: T | null | undefined, runtime: T | null | undefined, file: T | null | undefined, dflt: T): [T, SiteSource] {
  if (env !== null && env !== undefined && env !== '') return [env, 'env'];
  if (runtime !== null && runtime !== undefined && runtime !== '') return [runtime, 'runtime'];
  if (file !== null && file !== undefined && file !== '') return [file, 'file'];
  return [dflt, 'default'];
}

export interface ResolveInput {
  env?: Env;
  file?: SiteFile;
  /** omitted: no runtime sources (SITE) */
  runtime?: SiteRuntime | null;
  home?: string;
  path?: string;
  found?: boolean;
  fileError?: string | null;
  /** the checkout's portboard.json, under `file` key by key */
  checkoutFile?: SiteFile;
  /** its path, when it was found */
  checkoutPath?: string | null;
}

/** `upper` over `lower`, key by key; pve and windows merge field by field. */
export function mergeSiteFiles(lower: SiteFile, upper: SiteFile): SiteFile {
  const out: SiteFile = { ...lower, ...upper };
  for (const k of OBJECT_KEYS) if (lower[k] || upper[k]) out[k] = { ...lower[k], ...upper[k] };
  return out;
}

/** env, then runtime, then portboard.json, then SITE_DEFAULTS, per value. Pure: every source is passed in. */
export function resolveSite(input: ResolveInput = {}): Site {
  const env = input.env ?? {};
  const f = mergeSiteFiles(input.checkoutFile ?? {}, input.file ?? {});
  const rt = input.runtime ?? {};
  const home = input.home ?? homedir();
  const D = SITE_DEFAULTS;

  const rtDns = nonEmpty(rt.dnsName) ? rt.dnsName.replace(/\.$/, '') : null;
  const rtTailnet = rtDns && rtDns.includes('.') ? rtDns.slice(rtDns.indexOf('.') + 1) : null;
  const [host, hostSrc] = pick(null, rt.hostName, f.host, D.host);
  const [tailnet, tailnetSrc] = pick(null, rtTailnet, f.tailnet, D.tailnet);
  // tailscale's own name when it runs (its HostName and DNS label can differ); else built from the resolved parts
  const dnsName = rtDns ?? (tailnet ? `${host}.${tailnet}` : host);
  const dnsSrc: SiteSource = rtDns ? 'runtime' : hostSrc === 'file' || tailnetSrc === 'file' ? 'file' : 'default';
  const [user, userSrc] = pick(null, rt.user, f.user, D.user);
  const [checkout, checkoutSrc] = pick(null, rt.checkout, f.checkout, D.checkout);
  const fileRoots = typeof f.reposRoot === 'string' ? f.reposRoot.split(',') : f.reposRoot;
  const envRoots = nonEmpty(env.PORTBOARD_REPOS_ROOT) ? env.PORTBOARD_REPOS_ROOT.split(',') : null;
  const [roots, rootsSrc] = pick(envRoots, null, fileRoots, D.reposRoot);
  const [poolUrl, poolSrc] = pick(env.PORTBOARD_POOL_URL, null, f.poolUrl, D.poolUrl);
  const rtDashboard = rt.serve && rt.dashboardPort !== undefined ? dashboardUrl(rtDns, rt.serve, rt.dashboardPort) : null;
  const [dash, dashSrc] = pick<string | null>(env.PORTBOARD_DASHBOARD_URL, rtDashboard, f.dashboardUrl, D.dashboardUrl);
  // Funnel serves this machine at https://<dnsName>; with no tailnet known there is nothing to derive
  const [publicFound, publicSrc] = pick<string | null>(null, null, f.publicUrl, D.publicUrl);
  const publicUrl = publicFound ?? (dnsName.includes('.') ? `https://${dnsName}` : `https://${host}`);
  // an unknown PORTBOARD_LOCALE is ignored (the file or the default applies)
  const [locale, localeSrc] = pick<Locale>(isLocale(env.PORTBOARD_LOCALE) ? env.PORTBOARD_LOCALE : null, null, isLocale(f.locale) ? f.locale : null, D.locale);
  // an unparsable PORTBOARD_UTC_OFFSET is ignored the same way
  const envOffset = parseUtcOffset(env.PORTBOARD_UTC_OFFSET) !== null ? env.PORTBOARD_UTC_OFFSET : null;
  const [utcOffset, utcOffsetSrc] = pick<string>(envOffset, null, f.utcOffset, D.utcOffset);

  return {
    host,
    tailnet,
    dnsName,
    user,
    checkout,
    // env paths are used as given (as before); file and default ones may start with ~
    reposRoots: rootsSrc === 'env' ? roots : roots.map((r) => expand(r.trim(), home)),
    poolUrl,
    dashboardUrl: dash,
    publicUrl,
    locale,
    utcOffset,
    utcOffsetMs: parseUtcOffset(utcOffset) ?? 0,
    // Merged here, validated by pveports.ts / winports.ts with their own files on top
    pve: { ...D.pve, ...(f.pve as Partial<typeof D.pve>) },
    windows: { ...D.windows, ...(f.windows as Partial<typeof D.windows>) },
    sources: {
      host: hostSrc,
      tailnet: tailnetSrc,
      dnsName: dnsSrc,
      user: userSrc,
      checkout: checkoutSrc,
      reposRoots: rootsSrc,
      poolUrl: poolSrc,
      dashboardUrl: dash === null ? 'default' : dashSrc,
      publicUrl: publicSrc,
      locale: localeSrc,
      utcOffset: utcOffsetSrc,
    },
    file: input.path ?? PATHS.site,
    fileFound: input.found ?? false,
    fileError: input.fileError ?? null,
    checkoutFile: input.checkoutPath ?? null,
  };
}

function readSiteFile(path: string) {
  let text: string | null = null;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // absent or unreadable: defaults
  }
  return parseSiteFile(text);
}

/** The checkout's portboard.json: its parsed keys and path when found (a broken one is reported like the user file's). */
function readCheckoutFile(path: string | null): { file: SiteFile; path: string | null; error: string | null } {
  if (!path) return { file: {}, path: null, error: null };
  const r = readSiteFile(path);
  return { file: r.file, path: r.found ? path : null, error: r.error ? `${path}: ${r.error}` : null };
}

/** Synchronous view (env, portboard.json files, defaults), read once at import. checkoutPath null: no checkout file. */
export function loadSite(path = PATHS.site, env: Env = process.env, checkoutPath: string | null = CHECKOUT_SITE): Site {
  const { file, found, error } = readSiteFile(path);
  const c = readCheckoutFile(checkoutPath);
  return resolveSite({ env, file, path, found, fileError: error ?? c.error, checkoutFile: c.file, checkoutPath: c.path });
}

export const SITE: Site = loadSite();

/** The main checkout of the code this process runs: the parent of git's common dir (in a worktree, its main checkout). */
async function checkoutOf(dir = CODE_ROOT): Promise<string | null> {
  const r = await run('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], 3_000).catch(() => null);
  const common = r?.ok ? r.stdout.trim() : '';
  return common.endsWith('/.git') ? dirname(common) : null;
}

/** The runtime sources, each null when it can't be read. dashboardPort: the port whose serve entry is the dashboard. */
export async function siteRuntime(dashboardPort: number = PATHS.port): Promise<SiteRuntime> {
  const [ts, checkout, serve] = await Promise.all([
    tailscaleInfo().catch(() => null),
    checkoutOf(),
    serveStatus().catch((): ServeEntry[] | null => null),
  ]);
  return { hostName: ts?.hostName ?? null, dnsName: ts?.dnsName ?? null, checkout, user: osUser(), serve, dashboardPort };
}

const TTL_MS = 60_000;
/** Per dashboard port (one or two in practice: production and a preview) */
const cache = keyedCache(
  (dashboardPort: number) =>
    siteRuntime(dashboardPort).then((runtime) => {
      const { file, found, error } = readSiteFile(SITE.file);
      const c = readCheckoutFile(CHECKOUT_SITE);
      return resolveSite({ env: process.env, file, runtime, path: SITE.file, found, fileError: error ?? c.error, checkoutFile: c.file, checkoutPath: c.path });
    }),
  { ttlMs: TTL_MS, maxEntries: 8, cacheErrors: true },
);

/** SITE with the runtime sources on top, cached for a minute (serve can change). */
export function site(dashboardPort: number = PATHS.port): Promise<Site> {
  return cache(dashboardPort);
}

/**
 * The dashboard's https address for links: PORTBOARD_DASHBOARD_URL, else the serve entry that proxies to `port`, else
 * portboard.json's dashboardUrl, else null. The callers that already hold the serve list and the DNS name use this.
 */
export function resolveDashboardUrl(dnsName: string | null, serve: ServeEntry[], port: number, env: Env = process.env, file: SiteFile = siteFileNow()): string | null {
  return resolveSite({ env, file, runtime: { dnsName, serve, dashboardPort: port } }).dashboardUrl;
}

/** portboard.json as it is now, over the checkout's (re-read: they are small and the owner may have edited them). */
export function siteFileNow(path = SITE.file, checkoutPath: string | null = CHECKOUT_SITE): SiteFile {
  return mergeSiteFiles(readCheckoutFile(checkoutPath).file, readSiteFile(path).file);
}

/** "~/projects/portboard" for a path under home, else the path itself */
export const tildePath = (p: string, home = homedir()) => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
