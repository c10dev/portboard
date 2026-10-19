// The board's side of `portboard agent` (c10dev/portboard#10): read every agent portboard.json lists (`agents`:
// name, URL, optional token), keep each one's last good answer, and hand them to devices.ts, which puts them on the
// tailnet device of that name (or on a card of their own) ahead of compute-pool's ports.
//
//   GET <url>/agent/v1/info and /agent/v1/ports, both at once, at most every ttlMs (devices() asks on demand)
//   a failure backs that agent off: 15 s, 30 s, 1 min … up to 5 min; its last good ports stay, marked stale
//   errors are fixed codes (unreachable, timeout, auth, http, bad-answer), never the agent's text
//
// The token goes only in the Authorization header of these two requests; it is never in a status or a log line.

import { ttlCache } from './cache.ts';
import { listeningOf, type ListenPort } from './pool.ts';
import { SITE, type AgentTarget } from './site.ts';
import type { AgentInfo } from '../agent/server.ts';

export type AgentError = 'unreachable' | 'timeout' | 'auth' | 'http' | 'bad-answer';

/** One agent as the board last saw it (no token) */
export interface AgentStatus {
  name: string;
  url: string;
  ok: boolean;
  /** not read yet */
  pending: boolean;
  error: AgentError | null;
  checkedAt: number | null;
  lastOk: number | null;
  failures: number;
  /** while backing off: when it is tried again */
  nextAt: number | null;
  /** the agent's version, host and load from its last good answer */
  info: AgentInfo | null;
}

export interface AgentRead extends AgentStatus {
  /** its last good listening sockets (at: ms when the agent took its snapshot) */
  ports: { at: number; listening: ListenPort[] } | null;
}

export interface AgentsOptions {
  targets?: () => AgentTarget[];
  fetch?: typeof fetch;
  now?: () => number;
  /** results are reused this long (default 10 s) */
  ttlMs?: number;
  /** per request (default 4 s) */
  timeoutMs?: number;
  /** first back-off after a failure, doubled per failure (default 15 s) */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** answers larger than this are refused (default 4 MB) */
  maxBytes?: number;
}

class ReadError extends Error {
  code: AgentError;
  constructor(code: AgentError) {
    super(code);
    this.code = code;
  }
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** /agent/v1/info, checked field by field (numbers or null); anything else is bad-answer */
export function checkInfo(v: unknown): AgentInfo | null {
  if (!isObj(v) || v.schema !== 1 || typeof v.host !== 'string' || !v.host || !isObj(v.load)) return null;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const l = v.load;
  return {
    schema: 1,
    version: typeof v.version === 'string' ? v.version.slice(0, 40) : '?',
    host: v.host.slice(0, 80),
    dnsName: typeof v.dnsName === 'string' && /^[\w.-]{1,253}$/.test(v.dnsName) ? v.dnsName : null,
    at: num(v.at) ?? 0,
    load: { cores: num(l.cores) ?? 0, load1: num(l.load1) ?? 0, memTotalMb: num(l.memTotalMb), memAvailMb: num(l.memAvailMb), diskFreePct: num(l.diskFreePct), uptimeSec: num(l.uptimeSec) ?? 0 },
  };
}

/** /agent/v1/ports → the listening sockets (sanitized like compute-pool's), or null */
export function checkPorts(v: unknown): { at: number; listening: ListenPort[] } | null {
  if (!isObj(v) || v.schema !== 1 || typeof v.at !== 'number' || !Array.isArray(v.listening)) return null;
  const { listening } = listeningOf({ listening: v.listening, listeningAt: v.at });
  return listening ? { at: v.at, listening: listening.map((p) => (p.process ? { ...p, process: p.process.slice(0, 64) } : p)) } : null;
}

export class AgentsCollector {
  private readonly o: Required<Omit<AgentsOptions, 'targets' | 'fetch' | 'now'>>;
  private readonly targets: () => AgentTarget[];
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly states = new Map<string, AgentRead>();
  private readonly cached: (() => Promise<AgentRead[]>) & { clear(): void };

  constructor(opts: AgentsOptions = {}) {
    this.targets = opts.targets ?? (() => SITE.agents);
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
    this.o = {
      ttlMs: opts.ttlMs ?? 10_000,
      timeoutMs: opts.timeoutMs ?? 4_000,
      backoffMs: opts.backoffMs ?? 15_000,
      maxBackoffMs: opts.maxBackoffMs ?? 300_000,
      maxBytes: opts.maxBytes ?? 4 * 1024 * 1024,
    };
    this.cached = ttlCache(() => this.poll(), { ttlMs: this.o.ttlMs, now: this.now });
  }

  /** Every listed agent, read now unless read within ttlMs or backing off. Never rejects. */
  get(): Promise<AgentRead[]> {
    return this.targets().length ? this.cached() : Promise.resolve([]);
  }

  /** Read again on the next get() (새로고침), back-offs included */
  refresh(): void {
    for (const s of this.states.values()) s.nextAt = null;
    this.cached.clear();
  }

  private async poll(): Promise<AgentRead[]> {
    const targets = this.targets();
    for (const name of this.states.keys()) if (!targets.some((t) => t.name === name)) this.states.delete(name);
    return Promise.all(targets.map((t) => this.one(t)));
  }

  private async one(t: AgentTarget): Promise<AgentRead> {
    let s = this.states.get(t.name);
    if (!s || s.url !== t.url) {
      s = { name: t.name, url: t.url, ok: false, pending: true, error: null, checkedAt: null, lastOk: null, failures: 0, nextAt: null, info: null, ports: null };
      this.states.set(t.name, s);
    }
    const now = this.now();
    if (s.nextAt !== null && now < s.nextAt) return { ...s };
    try {
      const [info, ports] = await Promise.all([this.read(t, 'info', checkInfo), this.read(t, 'ports', checkPorts)]);
      Object.assign(s, { ok: true, pending: false, error: null, checkedAt: this.now(), lastOk: this.now(), failures: 0, nextAt: null, info, ports });
    } catch (err) {
      const code = err instanceof ReadError ? err.code : 'unreachable';
      const failures = s.failures + 1;
      const wait = Math.min(this.o.backoffMs * 2 ** (failures - 1), this.o.maxBackoffMs);
      Object.assign(s, { ok: false, pending: false, error: code, checkedAt: this.now(), failures, nextAt: this.now() + wait });
    }
    return { ...s };
  }

  private async read<T>(t: AgentTarget, what: 'info' | 'ports', check: (v: unknown) => T | null): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(`${t.url}/agent/v1/${what}`, {
        headers: { accept: 'application/json', 'user-agent': 'portboard-board', ...(t.token ? { authorization: `Bearer ${t.token}` } : {}) },
        redirect: 'error',
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      throw new ReadError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable');
    }
    if (res.status === 401 || res.status === 403) throw new ReadError('auth');
    if (!res.ok) throw new ReadError('http');
    if (Number(res.headers.get('content-length') ?? 0) > this.o.maxBytes) throw new ReadError('bad-answer');
    let body: unknown;
    try {
      const text = await res.text();
      if (text.length > this.o.maxBytes) throw new Error('too large');
      body = JSON.parse(text);
    } catch {
      throw new ReadError('bad-answer');
    }
    const v = check(body);
    if (v === null) throw new ReadError('bad-answer');
    return v;
  }
}

/** Without the ports: what the UI and the remote connector see of an agent */
export function agentStatus(r: AgentRead): AgentStatus {
  const { ports: _ports, ...status } = r;
  return status;
}

let shared: AgentsCollector | null = null;

/** The process-wide collector (devices.ts and the refresh button share it) */
export function agents(): AgentsCollector {
  shared ??= new AgentsCollector();
  return shared;
}
