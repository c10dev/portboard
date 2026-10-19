// compute-pool host status (this server, desktop, mac): CPU, memory, disk, rotation state, running jobs.
// Reads `cpool monitor`'s GET /api/hosts on loopback (versioned contract, see compute-pool's README). An older
// monitor without it answers 404; then fall back to /api/state plus hosts.json for the addresses.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reportHealth } from './health.ts';
import { PATHS } from './paths.ts';
import { SITE } from './site.ts';

export interface PoolHost {
  name: string;
  kind: string; // local | ssh | agent
  /** IPs or host names without ports: ssh target / Windows side, an agent's connecting address */
  addresses: string[];
  /** ok, degraded, wsl-down, host-down, auth, agent-away, agent-busy, or unknown */
  state: string;
  inRotation: boolean;
  since?: number;
  checkedAt?: number;
  detail?: string;
  slots: number;
  busy: number;
  cores?: number;
  load1?: number;
  cpuPct?: number;
  memTotalMb?: number;
  memAvailMb?: number;
  diskFreePct?: number;
  runners?: { active: number; total: number };
  agent?: { connected: boolean; available: boolean; why?: string };
  last24h?: { runs: number; failed: number; runMin: number; avgWaitSec: number };
  /**
   * Listening TCP sockets on that host (ssh hosts: the monitor's probe; agent hosts: the worker's heartbeat), with
   * listeningAt (ms) when the host read them. Both undefined when the host did not report ports (the local host,
   * an older monitor or worker, a host that is down); with listeningAt an empty list means none.
   */
  listening?: ListenPort[];
  listeningAt?: number;
}

export interface ListenPort {
  port: number;
  /** without brackets or zone: 0.0.0.0, ::, * (all interfaces), 127.0.0.1, ::1, a LAN or Tailscale IP */
  address: string;
  /** the owning command, when the host could name it */
  process?: string;
}

export interface PoolStatus {
  available: boolean;
  /** Which endpoint answered: hosts (v1 contract) or state (older monitor) */
  source: 'hosts' | 'state' | null;
  url: string;
  healthAt: number | null;
  hosts: PoolHost[];
  error?: string;
}

// PORTBOARD_POOL_URL, else portboard.json's poolUrl, else http://127.0.0.1:7720 (site.ts)
const BASE = SITE.poolUrl;
const POOL_DIR = PATHS.poolDir;
const TTL = 10_000;

let cache: { at: number; value: Promise<PoolStatus> } | null = null;

export function poolStatus(): Promise<PoolStatus> {
  if (cache && Date.now() - cache.at < TTL) return cache.value;
  const value = fetchPool();
  cache = { at: Date.now(), value };
  void value.then((s) => reportHealth('pool', { ok: s.available, error: s.error }));
  return value;
}

async function fetchPool(): Promise<PoolStatus> {
  const empty = (error: string): PoolStatus => ({ available: false, source: null, url: BASE, healthAt: null, hosts: [], error });
  try {
    const res = await fetch(`${BASE}/api/hosts`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return fromHostsDoc(await res.json());
    if (res.status !== 404) return empty(`GET /api/hosts → HTTP ${res.status}`);
    const st = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1500) });
    if (!st.ok) return empty(`GET /api/state → HTTP ${st.status}`);
    const hostsJson = await readFile(join(POOL_DIR, 'hosts.json'), 'utf8').catch(() => '{}');
    return fromStateDoc(await st.json(), hostsJson);
  } catch (err) {
    return empty(`compute-pool monitor not reachable at ${BASE} (${(err as Error).message})`);
  }
}

export function fromHostsDoc(doc: any): PoolStatus {
  if (doc?.version !== 1 || !Array.isArray(doc.hosts)) {
    return { available: false, source: null, url: BASE, healthAt: null, hosts: [], error: `unsupported /api/hosts version ${doc?.version}` };
  }
  return {
    available: true,
    source: 'hosts',
    url: BASE,
    healthAt: typeof doc.healthAt === 'number' ? doc.healthAt : null,
    hosts: doc.hosts.map((h: any): PoolHost => ({ ...h, addresses: Array.isArray(h.addresses) ? h.addresses : [], ...listeningOf(h) })),
  };
}

/** listening/listeningAt as the monitor sent them, or both undefined when absent or malformed. */
export function listeningOf(h: any): { listening?: ListenPort[]; listeningAt?: number } {
  if (typeof h?.listeningAt !== 'number' || !Array.isArray(h.listening)) return { listening: undefined, listeningAt: undefined };
  const listening = h.listening
    .filter((p: any) => Number.isInteger(p?.port) && p.port > 0 && p.port < 65536 && typeof p.address === 'string')
    .map((p: any): ListenPort => (typeof p.process === 'string' && p.process ? { port: p.port, address: p.address, process: p.process } : { port: p.port, address: p.address }));
  return { listening, listeningAt: h.listeningAt };
}

/** Older monitors: /api/state's hosts[].health, addresses from hosts.json's ssh / windows entries. */
export function fromStateDoc(state: any, hostsJson: string): PoolStatus {
  let cfg: any[] = [];
  try {
    cfg = JSON.parse(hostsJson)?.hosts ?? [];
  } catch {
    // no addresses then
  }
  const addressesOf = (name: string) => {
    const c = cfg.find((x) => x?.name === name);
    return [...new Set([c?.ssh?.host, c?.windows?.host].filter((a): a is string => typeof a === 'string' && !!a))];
  };
  const hosts = (Array.isArray(state?.hosts) ? state.hosts : []).map((h: any): PoolHost => {
    const hh = h.health ?? null;
    const runners = Array.isArray(hh?.runners) ? hh.runners : null;
    return {
      name: h.name,
      kind: h.kind,
      addresses: addressesOf(h.name),
      state: hh?.state ?? 'unknown',
      inRotation: !!hh?.inRotation,
      since: hh?.since,
      checkedAt: hh?.checkedAt,
      detail: hh?.detail,
      slots: h.slots ?? 0,
      busy: Array.isArray(h.holders) ? h.holders.length : 0,
      cores: hh?.cores,
      load1: hh?.load1,
      cpuPct: hh?.cpuPct,
      memTotalMb: hh?.memTotalMb,
      memAvailMb: hh?.memAvailMb,
      diskFreePct: hh?.diskFreePct,
      runners: runners ? { active: runners.filter((r: any) => r.active).length, total: runners.length } : undefined,
      last24h: h.last24h,
    };
  });
  return { available: true, source: 'state', url: BASE, healthAt: typeof state?.healthAt === 'number' ? state.healthAt : null, hosts };
}
