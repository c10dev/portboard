// 기록: the audit log (c10dev/portboard#30). One JSON line per write — through the dashboard's REST routes (allowed or
// denied) and the stdio MCP server's write tools — in <state dir>/audit.jsonl, so the dashboard and the MCP process
// (which share the production state dir) append to the same file.
//
// Bounded: when the file passes maxBytes it becomes audit.jsonl.1 (the previous .1 is dropped) and a new file starts,
// so at most about 2 × maxBytes stays on disk. A one-line appendFile is atomic enough between the two processes; a
// rotation racing another process's append can lose that one line, which is acceptable for this log.
//
// What a line holds: when, who (Tailscale login, "local", or the direct caller's address), source, the route pattern
// or MCP tool, the target identifiers (port, ports, device, path, repo, …) picked by an allowlist, the result and its
// status. Never a request body as is, never a header beyond the caller's login: free text (labels, names, notes)
// shows only as a field name in `fields`. Serve and direct callers also carry the device: its tailnet address and,
// when `tailscale whois` knew it, the node name and stable ID (security review v1.0, M1).
//
// Denied requests can't push the record of real writes out (security review v1.0, M2): they go to their own capped
// file, audit-denied.jsonl (+ .1), and repeats are coalesced. The first denial of a kind — same who, source, route,
// reason and device address — is written at once; identical ones within the next minute are only counted, and one
// line with `count` (and `since`, the first of them) is written when the minute is over. A flood of denials therefore
// writes about one line per minute per kind, into a file that never rotates audit.jsonl. The counting lives in the
// server process; the stdio MCP server never writes denials.

import { readFile, rename, stat } from 'node:fs/promises';
import type { Caller, Device, Source } from './access.ts';
import { appendPrivate } from './atomic.ts';

export type Result = 'ok' | 'denied' | 'error';

export type TargetValue = string | number | boolean | (string | number)[];
export type Target = Record<string, TargetValue>;

/** The device a serve or direct write came from */
export interface AuditDevice {
  /** tailnet address (serve: X-Forwarded-For; direct: the socket) */
  addr: string;
  /** MagicDNS short name, when tailscale whois knew it */
  name?: string;
  /** stable node ID */
  id?: string;
}

export interface AuditEntry {
  at: string;
  who: string;
  source: Source;
  /** "POST /api/ports/:port/restart", or "mcp restart_service" */
  route: string;
  target: Target;
  result: Result;
  /** HTTP status (REST only) */
  status?: number;
  /** The answer's short message or error, cut to 200 characters */
  detail?: string;
  /** serve and direct: which device */
  device?: AuditDevice;
  /** A coalesced denial line: how many identical denials it stands for (the first one has its own line) */
  count?: number;
  /** With count: when the first of those came (`at` is the last) */
  since?: string;
}

/** A caller's device for the audit line: identifiers only, cleaned. */
export function deviceOf(d: Device | undefined): AuditDevice | undefined {
  if (!d?.addr) return undefined;
  return { addr: clean(d.addr, 60), ...(d.name ? { name: clean(d.name, 80) } : {}), ...(d.id ? { id: clean(d.id, 64) } : {}) };
}

/** Body/argument keys whose values are identifiers and may be logged (anything else: only its name, in `fields`). */
const ID_KEYS: Record<string, 'int' | 'ints' | 'str' | 'strs' | 'bool'> = {
  port: 'int',
  ports: 'ints',
  path: 'str',
  paths: 'strs',
  writeDevices: 'strs',
  repo: 'str',
  owner: 'str',
  key: 'str',
  script: 'str',
  mode: 'str',
  autoStop: 'str',
  session_id: 'str',
  on: 'bool',
  pinned: 'bool',
  hidden: 'bool',
  alert: 'bool',
  enabled: 'bool',
  connections: 'bool',
  neighbors: 'bool',
};
const MAX_LIST = 20;

/** No control characters, at most `max` characters: header and body text is the caller's. */
export function clean(s: unknown, max = 300): string {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .slice(0, max);
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535;

/** The identifiers of a write: route params plus allowlisted body/argument keys, sanitized. */
export function targetOf(params: { port?: number; device?: string } | null, body: unknown): Target {
  const t: Target = {};
  if (params?.port !== undefined && isInt(params.port) && params.port > 0) t.port = params.port;
  if (params?.device) t.device = clean(params.device, 80);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return t;
  const b = body as Record<string, unknown>;
  const fields: string[] = [];
  for (const [k, v] of Object.entries(b).slice(0, 40)) {
    const kind = ID_KEYS[k];
    const name = k === 'session_id' ? 'session' : k;
    if (kind === 'int' && (isInt(v) || (typeof v === 'string' && /^\d{1,5}$/.test(v)))) t[name] ??= Number(v);
    else if (kind === 'ints' && Array.isArray(v)) {
      t[name] = v.filter(isInt).slice(0, MAX_LIST);
      if (v.length > MAX_LIST) t[`${name}Count`] = v.length;
    } else if (kind === 'str' && typeof v === 'string') t[name] = clean(v);
    else if (kind === 'strs' && Array.isArray(v)) {
      t[name] = v.filter((x) => typeof x === 'string').slice(0, MAX_LIST).map((x) => clean(x));
      if (v.length > MAX_LIST) t[`${name}Count`] = v.length;
    } else if (kind === 'bool' && typeof v === 'boolean') t[name] = v;
    else fields.push(clean(k, 40));
  }
  if (fields.length) t.fields = fields;
  return t;
}

/** "who" for a caller: login through serve, "local" on this machine, the address of a direct caller. */
export function whoOf(c: Caller): string {
  if (c.login) return clean(c.login, 200);
  if (c.source === 'direct') return clean(c.addr ?? 'unknown', 60);
  if (c.source === 'serve') return '(사용자 없음)';
  return 'local';
}

export interface Query {
  port?: number;
  limit?: number;
}

export interface AuditOptions {
  /** audit.jsonl rotates past this (default 1 MB) */
  maxBytes?: number;
  /** Where denials go (default: audit-denied.jsonl next to the log) */
  deniedPath?: string;
  /** audit-denied.jsonl rotates past this (default 256 KB) */
  deniedMaxBytes?: number;
  /** The coalescing window for identical denials (default 1 minute) */
  windowMs?: number;
  /** Distinct kinds of denial counted at once; past this the oldest is written out early (default 1000) */
  maxPending?: number;
  now?: () => number;
}

interface Pending {
  /** the latest coalesced denial */
  last: AuditEntry | null;
  count: number;
  since: string | null;
  /** when this window closes */
  until: number;
}

const matchesPort = (e: AuditEntry, port: number) => e.target?.port === port || (Array.isArray(e.target?.ports) && e.target.ports.includes(port));

/** The default denied file: audit.jsonl → audit-denied.jsonl */
export const deniedPathOf = (path: string): string => (path.endsWith('.jsonl') ? `${path.slice(0, -'.jsonl'.length)}-denied.jsonl` : `${path}-denied`);

export class AuditLog {
  path: string;
  maxBytes: number;
  deniedPath: string;
  deniedMaxBytes: number;
  windowMs: number;
  maxPending: number;
  private now: () => number;
  private pending = new Map<string, Pending>();
  private timer: NodeJS.Timeout | null = null;

  /** `opts` as a number is maxBytes (the old signature). */
  constructor(path: string, opts: number | AuditOptions = {}) {
    const o = typeof opts === 'number' ? { maxBytes: opts } : opts;
    this.path = path;
    this.maxBytes = o.maxBytes ?? 1_000_000;
    this.deniedPath = o.deniedPath ?? deniedPathOf(path);
    this.deniedMaxBytes = o.deniedMaxBytes ?? 256_000;
    this.windowMs = o.windowMs ?? 60_000;
    this.maxPending = o.maxPending ?? 1_000;
    this.now = o.now ?? Date.now;
  }

  async append(e: AuditEntry): Promise<void> {
    if (e.result !== 'denied') return this.write(this.path, this.maxBytes, e);
    await this.flush(false);
    const key = JSON.stringify([e.who, e.source, e.route, e.detail ?? '', e.device?.addr ?? '']);
    const t = this.now();
    const p = this.pending.get(key);
    if (p && t < p.until) {
      p.count++;
      p.since ??= e.at;
      p.last = e;
      return;
    }
    // A new kind, or its quiet window ran out: this one is written now, repeats in the next minute are counted.
    this.pending.delete(key);
    if (this.pending.size >= this.maxPending) {
      const [oldest] = this.pending.keys();
      await this.closeWindow(oldest, true);
    }
    this.pending.set(key, { last: null, count: 0, since: null, until: t + this.windowMs });
    this.arm();
    return this.write(this.deniedPath, this.deniedMaxBytes, e);
  }

  /**
   * Write the counted denials whose minute is over (`all`: every one, for shutdown and tests). A kind that is still
   * being repeated starts a new window, so a steady flood writes one line per minute.
   */
  async flush(all = true): Promise<void> {
    const t = this.now();
    for (const [key, p] of [...this.pending]) if (all || t >= p.until) await this.closeWindow(key, all);
    if (!this.pending.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async closeWindow(key: string, drop: boolean): Promise<void> {
    const p = this.pending.get(key);
    if (!p) return;
    if (!p.count || !p.last) {
      this.pending.delete(key);
      return;
    }
    const line: AuditEntry = { ...p.last, count: p.count, ...(p.since ? { since: p.since } : {}) };
    if (drop) this.pending.delete(key);
    else this.pending.set(key, { last: null, count: 0, since: null, until: this.now() + this.windowMs });
    await this.write(this.deniedPath, this.deniedMaxBytes, line);
  }

  /** A timer that writes finished windows while nothing else is logged (unref'd: never keeps the process alive). */
  private arm(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush(false).catch((err) => console.error(`[portboard] audit: ${err instanceof Error ? err.message : String(err)}`));
    }, Math.max(1_000, Math.floor(this.windowMs / 2)));
    this.timer.unref();
  }

  private async write(file: string, max: number, e: AuditEntry): Promise<void> {
    const line = `${JSON.stringify(e)}\n`;
    try {
      if ((await stat(file)).size + Buffer.byteLength(line) > max) await rename(file, `${file}.1`);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
    await appendPrivate(file, line);
  }

  /**
   * Newest first, writes and denials together. `port` keeps entries whose target is that port or lists it in
   * `ports`. Finished denial windows are written first, so their counts show.
   */
  async query(q: Query = {}): Promise<AuditEntry[]> {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 1000);
    await this.flush(false).catch(() => {});
    const out: AuditEntry[] = [];
    for (const files of [[this.path, `${this.path}.1`], [this.deniedPath, `${this.deniedPath}.1`]]) {
      let n = 0;
      for (const file of files) {
        const lines = (await readFile(file, 'utf8').catch(() => '')).split('\n');
        for (let i = lines.length - 1; i >= 0 && n < limit; i--) {
          if (!lines[i]) continue;
          let e: AuditEntry;
          try {
            e = JSON.parse(lines[i]);
          } catch {
            continue;
          }
          if (q.port !== undefined && !matchesPort(e, q.port)) continue;
          out.push(e);
          n++;
        }
        if (n >= limit) break;
      }
    }
    // Two newest-first lists, merged by time (stable: equal times keep file order)
    return out
      .map((e, i) => ({ e, i }))
      .sort((a, b) => (a.e.at < b.e.at ? 1 : a.e.at > b.e.at ? -1 : a.i - b.i))
      .slice(0, limit)
      .map((x) => x.e);
  }
}

/** Never let a failing log stop a write; say so on stderr once per failure. */
export async function record(log: AuditLog | null | undefined, e: AuditEntry): Promise<void> {
  if (!log) return;
  try {
    await log.append(e);
  } catch (err) {
    console.error(`[portboard] audit: ${err instanceof Error ? err.message : String(err)}`);
  }
}
