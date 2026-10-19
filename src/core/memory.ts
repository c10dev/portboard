// 메모리: where this server's RAM goes, grouped the way the owner thinks about it (Claude Code sessions, the MCP servers
// every session spawns, services and dev servers, docker containers, the rest), and memory-pressure alerts.
//
//   sources   /proc/meminfo, /proc/pressure/memory, /proc/stat (btime), /proc/<pid>/stat and cmdline for every
//             process, /proc/<pid>/environ of a Claude CLI's descendants (only CLAUDE_CODE_SESSION_ID is kept: the
//             CLI's own environ carries its OAuth token and is never read whole), /proc/<pid>/cwd of each CLI, and
//             /sys/fs/cgroup/system.slice/docker-<id>.scope for containers (no `docker stats`; `docker ps` names them,
//             cached). Nothing is spawned per process.
//   grouping  two views, on purpose different:
//             - groups: a strict partition, every process counted once: docker → MCP instances → services (port
//               owners and their descendants) → claude (the CLIs and their other descendants: tool shells, tests) →
//               other. Their sum is the RSS of all processes (RSS counts shared pages in each process, so it is a
//               little above what `free` calls used).
//             - sessions: each CLI's whole tree (its MCP servers and the servers it started included), with a
//               breakdown. A session's MB therefore also appears under groups.mcp / services.
//   MCP       a server is recognised by command (rea, @playwright/mcp, Portboard's mcp.ts, other *mcp* packages). Each
//             direct child subtree of a CLI that holds one is one instance, wrappers included (npm exec → sh → node).
//   idle      a session is idle when its transcript (~/.claude/projects/*/<id>.jsonl) hasn't been written for
//             `idleMin` and its tree used under IDLE_CPU_PCT of a core since the previous sample; null on the first sample.
//   pressure  stepPressure(): available under `availablePct`, PSI `some avg60` over `psiSome60` or swap over
//             `swapPct`, for `sustainMin` minutes → one warning; a reminder every `reminderHours` while it lasts; one
//             recovery after the condition has been clear (with a margin) for `sustainMin`. Thresholds: memory.json in
//             the config dir (read only, docs/memory/README.md).
//
// Read-only: nothing here stops, signals or changes a process.

import { open, readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { dur, type Message } from './alerts.ts';
import { shortPath } from './proc.ts';
import { t } from './i18n.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** USER_HZ: /proc times are in these ticks on every Linux this runs on */
export const CLK_TCK = 100;
/** /proc/<pid>/stat rss is in pages */
export const PAGE_KB = 4;
export const SAMPLE_EVERY = MIN;
/** A waiting CLI still polls (0.5–1.6 % of a core measured); a running tool call is well above this */
export const IDLE_CPU_PCT = 3;
/** Samples kept for the sparklines (an hour) */
export const HISTORY = 60;

// ---------- /proc parsers ----------

export interface MemInfo {
  totalKb: number;
  freeKb: number;
  availableKb: number;
  buffersKb: number;
  cachedKb: number;
  sReclaimableKb: number;
  shmemKb: number;
  swapTotalKb: number;
  swapFreeKb: number;
}

export function parseMeminfo(text: string): MemInfo {
  const v = new Map<string, number>();
  for (const line of text.split('\n')) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(line);
    if (m) v.set(m[1], Number(m[2]));
  }
  const g = (k: string) => v.get(k) ?? 0;
  return {
    totalKb: g('MemTotal'),
    freeKb: g('MemFree'),
    // Kernels before 3.14 have no MemAvailable: free + page cache is the old estimate
    availableKb: v.get('MemAvailable') ?? g('MemFree') + g('Buffers') + g('Cached'),
    buffersKb: g('Buffers'),
    cachedKb: g('Cached'),
    sReclaimableKb: g('SReclaimable'),
    shmemKb: g('Shmem'),
    swapTotalKb: g('SwapTotal'),
    swapFreeKb: g('SwapFree'),
  };
}

export interface PsiLine {
  avg10: number;
  avg60: number;
  avg300: number;
}

export interface Psi {
  some: PsiLine;
  full: PsiLine | null;
}

/** /proc/pressure/memory; null when the kernel has no PSI */
export function parsePsi(text: string): Psi | null {
  const line = (kind: string): PsiLine | null => {
    const m = new RegExp(`^${kind}\\s+avg10=([\\d.]+)\\s+avg60=([\\d.]+)\\s+avg300=([\\d.]+)`, 'm').exec(text);
    return m ? { avg10: Number(m[1]), avg60: Number(m[2]), avg300: Number(m[3]) } : null;
  };
  const some = line('some');
  return some ? { some, full: line('full') } : null;
}

/** /proc/stat btime: boot time in epoch seconds */
export function parseBtime(text: string): number | null {
  const m = /^btime\s+(\d+)/m.exec(text);
  return m ? Number(m[1]) : null;
}

export interface StatLine {
  pid: number;
  comm: string;
  ppid: number;
  /** utime + stime, ticks */
  cpuTicks: number;
  /** ticks after boot */
  startTicks: number;
  rssKb: number;
}

/** /proc/<pid>/stat. comm may hold spaces and parentheses ("(next-server (v1)"), so the fields start after the last ")". */
export function parseStat(text: string): StatLine | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const f = text.slice(close + 2).trim().split(/\s+/);
  // f[0] is field 3 (state): field n is f[n - 3]
  const n = (i: number) => Number(f[i - 3]);
  if (!Number.isFinite(pid) || f.length < 22) return null;
  return { pid, comm: text.slice(open + 1, close), ppid: n(4), cpuTicks: n(14) + n(15), startTicks: n(22), rssKb: n(24) * PAGE_KB };
}

/** Only the session id: a CLI's environment also holds its OAuth token, which never leaves this function. */
export function sessionIdFromEnviron(raw: string): string | null {
  for (const kv of raw.split('\0')) {
    if (kv.startsWith('CLAUDE_CODE_SESSION_ID=')) {
      const id = kv.slice('CLAUDE_CODE_SESSION_ID='.length);
      return UUID.test(id) ? id : null;
    }
  }
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------- classification ----------

export type Kind = { kind: 'cli'; version: string | null } | { kind: 'mcp'; name: string } | { kind: 'proc' };

/** Display names for the MCP servers Portboard knows; others show their package name */
export const MCP_LABELS: Record<string, string> = {
  rea: 'rea',
  playwright: '@playwright/mcp',
  get portboard() {
    return t('memoryMsg.mcp.portboard');
  },
};

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * What a process is, from its argv: a Claude Code CLI (the desktop app's ~/.claude/remote/ccd-cli/<version>, or a
 * `claude` binary), an MCP server (by command), or anything else. `generic` also accepts other *mcp* packages; only
 * used inside a CLI's tree, where a stdio server lives.
 */
export function classify(argv: string[], generic = false): Kind {
  const a0 = argv[0] ?? '';
  const ccd = /\/\.claude\/remote\/ccd-cli\/(\d+\.\d+\.\d+)[^/]*$/.exec(a0);
  if (ccd) return { kind: 'cli', version: ccd[1] };
  if (base(a0) === 'claude') return { kind: 'cli', version: /\/versions\/(\d+\.\d+\.\d+)/.exec(a0)?.[1] ?? null };
  const node = /(^|\/)(node|bun)$/.test(a0);
  const a1 = argv[1] ?? '';
  if (node && /@anthropic-ai\/claude-code\/cli\.m?js$/.test(a1)) return { kind: 'cli', version: null };
  const head = argv.slice(0, 4);
  // rea: node …/.bin/rea mcp, its sh -c 'rea' mcp, and npm exec rea-agents@x mcp
  if (head.some((x) => /(^|\/)rea$/.test(x) || /^'?rea'?$/.test(x) || /(^|\/)rea-agents(@[\w.-]+)?$/.test(x)) && argv.includes('mcp')) return { kind: 'mcp', name: 'rea' };
  if (head.some((x) => x.includes('@playwright/mcp'))) return { kind: 'mcp', name: 'playwright' };
  if (head.some((x) => /portboard[^ ]*\/(src|bin)\/mcp\.ts$/.test(x) || /claude-plugin\/bin\/mcp\.ts$/.test(x))) return { kind: 'mcp', name: 'portboard' };
  if (!generic) return { kind: 'proc' };
  for (const x of head) {
    if (x === 'mcp' || x.startsWith('-')) continue;
    const pkg = /node_modules\/((?:@[\w.-]+\/)?[\w.-]+)\//.exec(x)?.[1] ?? (/^(?:@[\w.-]+\/)?[\w.-]+(?:@[\w.-]+)?$/.test(x) ? x.replace(/(?!^)@[\w.-]+$/, '') : null);
    if (pkg && /mcp|@modelcontextprotocol\//i.test(pkg)) return { kind: 'mcp', name: pkg };
    if (/(^|\/)mcp-server[\w.-]*$/.test(x) || /(^|\/)[\w.-]+-mcp$/.test(x)) return { kind: 'mcp', name: base(x) };
  }
  return { kind: 'proc' };
}

/** -1, 0, 1 for dotted versions ("2.1.295" < "2.1.299") */
export function versionCmp(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ---------- the sample ----------

export interface Proc extends StatLine {
  /** the first arguments, each cut to 300 chars (enough to classify) */
  argv: string[];
  /** --resume=<uuid> of a CLI, read from the whole argv */
  resume: string | null;
}

export interface Thresholds {
  /** warn below this share of MemAvailable */
  availablePct: number;
  /** warn above this PSI some avg60 */
  psiSome60: number;
  /** warn above this share of swap used */
  swapPct: number;
  /** a condition must hold (or be clear) this long */
  sustainMin: number;
  /** reminder while it lasts */
  reminderHours: number;
  /** a session whose transcript is quiet this long (and CPU near 0) is idle */
  idleMin: number;
  /** a dev server up this long and unused counts as long-idle */
  devIdleHours: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { availablePct: 10, psiSome60: 5, swapPct: 90, sustainMin: 5, reminderHours: 6, idleMin: 60, devIdleHours: 24 };

const LIMITS: Record<keyof Thresholds, [number, number]> = {
  availablePct: [1, 50],
  psiSome60: [0.1, 100],
  swapPct: [1, 100],
  sustainMin: [1, 120],
  reminderHours: [1, 168],
  idleMin: [5, 1440],
  devIdleHours: [1, 720],
};

/** memory.json → thresholds; each missing or out-of-range key keeps its default. */
export function parseThresholds(raw: unknown): Thresholds {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_THRESHOLDS };
  for (const k of Object.keys(LIMITS) as (keyof Thresholds)[]) {
    const v = r[k];
    const [lo, hi] = LIMITS[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) out[k] = v;
  }
  return out;
}

/** A listening service (from the port snapshot): its owning processes and what to call it */
export interface ServiceRef {
  name: string;
  ports: number[];
  pids: number[];
  unit: string | null;
  /** systemd-run unit, or no unit: something a session or a person started by hand */
  dev: boolean;
  /** nobody uses it now (usage.ts idle) */
  unused: boolean;
}

export interface DockerRef {
  id: string;
  name: string;
  mb: number;
  pids: number[];
}

export interface SessionMeta {
  id: string | null;
  title: string | null;
  /** last write to its transcript (ms) */
  lastActive: number | null;
}

export interface SampleInput {
  at: number;
  mem: MemInfo;
  psi: Psi | null;
  /** boot time, epoch seconds */
  btime: number;
  procs: Proc[];
  docker: DockerRef[];
  services: ServiceRef[];
  /** CLI pid → its session */
  sessions: Map<number, SessionMeta>;
  /** CLI pid → its working directory */
  cwds: Map<number, string>;
  /** the previous sample's CPU ticks per tree (key: `${pid}:${startTicks}`), and when it was taken */
  prevCpu: { at: number; ticks: Map<string, number> } | null;
  thresholds: Thresholds;
}

export type GroupKey = 'claude' | 'mcp' | 'services' | 'docker' | 'other';

export const GROUP_LABELS: Record<GroupKey, string> = {
  get claude() {
    return t('memoryMsg.group.claude');
  },
  get mcp() {
    return t('memoryMsg.group.mcp');
  },
  get services() {
    return t('memoryMsg.group.services');
  },
  docker: 'docker',
  get other() {
    return t('memoryMsg.group.other');
  },
};

export interface SessionRow {
  pid: number;
  id: string | null;
  title: string | null;
  project: string | null;
  version: string | null;
  /** older than the newest version running */
  stale: boolean;
  startedAt: string;
  uptimeSec: number;
  lastActive: string | null;
  /** minutes since the transcript was written; null when it wasn't found */
  idleMin: number | null;
  /** the tree's CPU since the previous sample (% of one core); null on the first sample */
  cpuPct: number | null;
  idle: boolean | null;
  /** a helper CLI (--no-session-persistence fork the app starts next to a session) */
  helper: boolean;
  mb: number;
  breakdown: { cli: number; mcp: number; servers: number; tools: number };
  procs: number;
  mcp: string[];
}

export interface McpRow {
  name: string;
  label: string;
  instances: number;
  mb: number;
  /** instances not under any Claude CLI */
  orphans: number;
  /** sessions that run it (out of every CLI running) */
  sessions: number;
  procs: number;
}

export interface ServiceRow {
  name: string;
  ports: number[];
  unit: string | null;
  dev: boolean;
  unused: boolean;
  mb: number;
  startedAt: string | null;
  uptimeSec: number | null;
  /** the Claude session it runs under, when it is in a CLI's tree */
  session: string | null;
}

export interface MemorySample {
  at: string;
  mem: {
    totalMb: number;
    usedMb: number;
    cacheMb: number;
    freeMb: number;
    availableMb: number;
    availablePct: number;
    shmemMb: number;
    swapTotalMb: number;
    swapUsedMb: number;
    swapPct: number;
  };
  psi: Psi | null;
  /** the partition (every process once); rssMb is their sum */
  groups: { key: GroupKey; label: string; mb: number; procs: number }[];
  rssMb: number;
  sessions: SessionRow[];
  newestVersion: string | null;
  mcp: McpRow[];
  services: ServiceRow[];
  docker: { name: string; mb: number }[];
  /** the "other" group by process name */
  other: { name: string; count: number; mb: number }[];
  cpu: { at: number; ticks: Record<string, number> };
}

const mbOf = (kb: number) => Math.round(kb / 1024);
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

/** The memory bar: used (not reclaimable) / reclaimable cache / free; they add up to total. */
export function memView(m: MemInfo) {
  const used = Math.max(0, m.totalKb - m.availableKb);
  const cacheAll = m.buffersKb + m.cachedKb + m.sReclaimableKb - m.shmemKb;
  const cache = Math.max(0, Math.min(cacheAll, m.availableKb - m.freeKb));
  const free = Math.max(0, m.availableKb - cache);
  const swapUsed = Math.max(0, m.swapTotalKb - m.swapFreeKb);
  return {
    totalMb: mbOf(m.totalKb),
    usedMb: mbOf(used),
    cacheMb: mbOf(cache),
    freeMb: mbOf(free),
    availableMb: mbOf(m.availableKb),
    availablePct: pct(m.availableKb, m.totalKb),
    shmemMb: mbOf(m.shmemKb),
    swapTotalMb: mbOf(m.swapTotalKb),
    swapUsedMb: mbOf(swapUsed),
    swapPct: pct(swapUsed, m.swapTotalKb),
  };
}

/**
 * A CLI's working directory as a project: the folder under a projects dir, "<repo>/<worktree>" for
 * worktrees/<repo>-<hash>/<name> and <repo>/.claude/worktrees/<name>, else the ~-short path.
 */
export function projectName(cwd: string): string {
  const m = /\/projects\/(.+)$/.exec(cwd);
  if (!m) return shortPath(cwd);
  const parts = m[1].split('/');
  if (parts[0] === 'worktrees' && parts.length >= 3) return `${parts[1].replace(/-[0-9a-f]{8,}$/, '')}/${parts[2]}`;
  if (parts[1] === '.claude' && parts[2] === 'worktrees' && parts[3]) return `${parts[0]}/${parts[3]}`;
  return parts[0];
}

/** Groups one /proc read (pure: the reader below does the I/O). */
export function buildSample(input: SampleInput): MemorySample {
  const { procs, at, thresholds: th } = input;
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const children = new Map<number, number[]>();
  for (const p of procs) {
    if (!byPid.has(p.ppid)) continue;
    const list = children.get(p.ppid);
    if (list) list.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  const tree = (root: number): number[] => {
    const out: number[] = [];
    const stack = [root];
    while (stack.length) {
      const pid = stack.pop()!;
      out.push(pid);
      for (const c of children.get(pid) ?? []) stack.push(c);
    }
    return out;
  };
  const rss = (pids: Iterable<number>) => {
    let kb = 0;
    for (const pid of pids) kb += byPid.get(pid)?.rssKb ?? 0;
    return kb;
  };
  const kinds = new Map(procs.map((p) => [p.pid, classify(p.argv)]));
  const clis = procs.filter((p) => kinds.get(p.pid)!.kind === 'cli');
  const cliPids = new Set(clis.map((p) => p.pid));
  // A CLI inside another CLI's tree (a nested `claude -p`) stays part of the outer session.
  const topClis = clis.filter((p) => {
    for (let q = byPid.get(p.ppid); q; q = byPid.get(q.ppid)) if (cliPids.has(q.pid)) return false;
    return true;
  });

  // owner: pid → partition group
  const owner = new Map<number, GroupKey>();
  const claim = (pids: number[], key: GroupKey) => {
    for (const pid of pids) if (!owner.has(pid)) owner.set(pid, key);
  };

  // docker first: its processes are root's, nothing else can claim them
  for (const d of input.docker) claim(d.pids.filter((pid) => byPid.has(pid)), 'docker');

  // MCP instances: each direct child subtree of a CLI that holds a recognised server (the deepest command names it),
  // then servers found anywhere else (left behind by a CLI that exited)
  type Instance = { name: string; pids: number[]; cli: number | null };
  const instances: Instance[] = [];
  const inInstance = new Set<number>();
  // a known server anywhere in the subtree wins (the deepest one); else another *mcp* package
  const mcpIn = (pids: number[]): string | null => {
    let known: string | null = null;
    let other: string | null = null;
    for (const pid of pids) {
      const k = kinds.get(pid)!;
      if (k.kind === 'mcp') known = k.name;
      else if (!known) {
        const g = classify(byPid.get(pid)!.argv, true);
        if (g.kind === 'mcp') other ??= g.name;
      }
    }
    return known ?? other;
  };
  for (const cli of clis) {
    for (const child of children.get(cli.pid) ?? []) {
      if (cliPids.has(child)) continue;
      const pids = tree(child).filter((pid) => !cliPids.has(pid));
      const name = mcpIn(pids);
      if (!name) continue;
      instances.push({ name, pids, cli: cli.pid });
      for (const pid of pids) inInstance.add(pid);
    }
  }
  for (const p of procs) {
    if (inInstance.has(p.pid) || owner.has(p.pid)) continue;
    const k = kinds.get(p.pid)!;
    if (k.kind !== 'mcp') continue;
    // the topmost process of the same server (npm exec → sh → node): start the instance there
    let top = p;
    for (let q = byPid.get(p.ppid); q && !cliPids.has(q.pid) && !inInstance.has(q.pid); q = byPid.get(q.ppid)) {
      const kq = kinds.get(q.pid)!;
      if (kq.kind === 'mcp' && kq.name === k.name) top = q;
      else break;
    }
    const pids = tree(top.pid).filter((pid) => !cliPids.has(pid) && !inInstance.has(pid));
    instances.push({ name: k.name, pids, cli: null });
    for (const pid of pids) inInstance.add(pid);
  }
  for (const i of instances) claim(i.pids, 'mcp');

  // services: the processes behind listening ports, with their descendants
  const svcPids = input.services.map((s) => {
    const roots = s.pids.filter((pid) => byPid.has(pid));
    // a listener whose parent listens for the same service (a worker): one tree from the parent
    const top = roots.filter((pid) => !roots.includes(byPid.get(pid)!.ppid));
    return [...new Set(top.flatMap((pid) => tree(pid)))].filter((pid) => !cliPids.has(pid) && !inInstance.has(pid));
  });
  input.services.forEach((_, i) => claim(svcPids[i], 'services'));

  // Claude: every CLI's remaining tree
  for (const cli of clis) claim(tree(cli.pid), 'claude');
  for (const p of procs) if (!owner.has(p.pid)) owner.set(p.pid, 'other');

  // ---- sessions ----
  const versions = clis.map((c) => (kinds.get(c.pid) as { version: string | null }).version).filter((v): v is string => !!v);
  const newest = versions.length ? versions.reduce((a, b) => (versionCmp(a, b) >= 0 ? a : b)) : null;
  const ticks: Record<string, number> = {};
  const elapsedTicks = input.prevCpu ? ((at - input.prevCpu.at) / 1000) * CLK_TCK : 0;
  const startedMs = (p: Proc) => (input.btime + p.startTicks / CLK_TCK) * 1000;
  const sessions: SessionRow[] = topClis.map((cli) => {
    const pids = tree(cli.pid);
    const key = `${cli.pid}:${cli.startTicks}`;
    let cpu = 0;
    for (const pid of pids) cpu += byPid.get(pid)?.cpuTicks ?? 0;
    ticks[key] = cpu;
    const prev = input.prevCpu?.ticks.get(key);
    const cpuPct = prev !== undefined && elapsedTicks > 0 ? Math.max(0, Math.round(((cpu - prev) / elapsedTicks) * 1000) / 10) : null;
    const meta = input.sessions.get(cli.pid) ?? { id: cli.resume, title: null, lastActive: null };
    const idleMin = meta.lastActive !== null ? Math.max(0, Math.floor((at - meta.lastActive) / MIN)) : null;
    const quiet = idleMin === null || idleMin >= th.idleMin;
    const idle = cpuPct === null ? null : quiet && cpuPct < IDLE_CPU_PCT;
    const version = (kinds.get(cli.pid) as { version: string | null }).version;
    const breakdown = { cli: 0, mcp: 0, servers: 0, tools: 0 };
    for (const pid of pids) {
      const kb = byPid.get(pid)?.rssKb ?? 0;
      const g = owner.get(pid);
      if (cliPids.has(pid)) breakdown.cli += kb;
      else if (g === 'mcp') breakdown.mcp += kb;
      else if (g === 'services') breakdown.servers += kb;
      else breakdown.tools += kb;
    }
    const cwd = input.cwds.get(cli.pid) ?? null;
    const started = startedMs(cli);
    return {
      pid: cli.pid,
      id: meta.id,
      title: meta.title,
      project: cwd ? projectName(cwd) : null,
      version,
      stale: !!(version && newest && versionCmp(version, newest) < 0),
      startedAt: new Date(started).toISOString(),
      uptimeSec: Math.max(0, Math.round((at - started) / 1000)),
      lastActive: meta.lastActive !== null ? new Date(meta.lastActive).toISOString() : null,
      idleMin,
      cpuPct,
      idle,
      helper: cli.argv.includes('--no-session-persistence'),
      mb: mbOf(rss(pids)),
      breakdown: { cli: mbOf(breakdown.cli), mcp: mbOf(breakdown.mcp), servers: mbOf(breakdown.servers), tools: mbOf(breakdown.tools) },
      procs: pids.length,
      mcp: [...new Set(instances.filter((i) => i.cli !== null && pids.includes(i.cli)).map((i) => i.name))].sort(),
    };
  });
  sessions.sort((a, b) => b.mb - a.mb || a.pid - b.pid);

  // ---- MCP totals ----
  const mcpMap = new Map<string, McpRow & { clis: Set<number> }>();
  for (const i of instances) {
    const row = mcpMap.get(i.name) ?? { name: i.name, label: MCP_LABELS[i.name] ?? i.name, instances: 0, mb: 0, orphans: 0, sessions: 0, procs: 0, clis: new Set<number>() };
    row.instances++;
    row.mb += rss(i.pids);
    row.procs += i.pids.length;
    if (i.cli === null) row.orphans++;
    else row.clis.add(i.cli);
    mcpMap.set(i.name, row);
  }
  const mcp: McpRow[] = [...mcpMap.values()]
    .map(({ clis: c, ...r }) => ({ ...r, mb: mbOf(r.mb), sessions: c.size }))
    .sort((a, b) => b.mb - a.mb || a.name.localeCompare(b.name));

  // ---- services ----
  const cliOf = (pid: number): number | null => {
    for (let q = byPid.get(pid); q; q = byPid.get(q.ppid)) if (cliPids.has(q.pid)) return q.pid;
    return null;
  };
  const services: ServiceRow[] = input.services
    .map((s, i) => {
      const pids = svcPids[i];
      const first = pids.map((pid) => byPid.get(pid)!).sort((a, b) => a.startTicks - b.startTicks)[0];
      const started = first ? startedMs(first) : null;
      const cli = first ? cliOf(first.pid) : null;
      const sess = cli !== null ? sessions.find((x) => x.pid === cli) : null;
      return {
        name: s.name,
        ports: [...s.ports].sort((a, b) => a - b),
        unit: s.unit,
        dev: s.dev,
        unused: s.unused,
        mb: mbOf(rss(pids)),
        startedAt: started !== null ? new Date(started).toISOString() : null,
        uptimeSec: started !== null ? Math.max(0, Math.round((at - started) / 1000)) : null,
        session: sess ? (sess.title ?? sess.project ?? sess.id?.slice(0, 8) ?? null) : null,
      };
    })
    .filter((s) => s.mb > 0)
    .sort((a, b) => b.mb - a.mb || a.ports[0] - b.ports[0]);

  // ---- partition totals ----
  const groupKb = new Map<GroupKey, { kb: number; procs: number }>();
  let allKb = 0;
  for (const p of procs) {
    const g = owner.get(p.pid)!;
    const cur = groupKb.get(g) ?? { kb: 0, procs: 0 };
    cur.kb += p.rssKb;
    cur.procs++;
    groupKb.set(g, cur);
    allKb += p.rssKb;
  }
  const groups = (Object.keys(GROUP_LABELS) as GroupKey[]).map((key) => ({ key, label: GROUP_LABELS[key], mb: mbOf(groupKb.get(key)?.kb ?? 0), procs: groupKb.get(key)?.procs ?? 0 }));

  const otherMap = new Map<string, { count: number; kb: number }>();
  for (const p of procs) {
    if (owner.get(p.pid) !== 'other' || !p.rssKb) continue;
    const cur = otherMap.get(p.comm) ?? { count: 0, kb: 0 };
    cur.count++;
    cur.kb += p.rssKb;
    otherMap.set(p.comm, cur);
  }
  const other = [...otherMap]
    .map(([name, v]) => ({ name, count: v.count, mb: mbOf(v.kb) }))
    .sort((a, b) => b.mb - a.mb || a.name.localeCompare(b.name))
    .slice(0, 12);

  return {
    at: new Date(at).toISOString(),
    mem: memView(input.mem),
    psi: input.psi,
    groups,
    rssMb: mbOf(allKb),
    sessions,
    newestVersion: newest,
    mcp,
    services,
    docker: input.docker.map((d) => ({ name: d.name, mb: d.mb })).sort((a, b) => b.mb - a.mb),
    other,
    cpu: { at, ticks },
  };
}

// ---------- pressure ----------

export interface PressureState {
  /** a warning went out and it hasn't recovered yet */
  active: boolean;
  /** ms: when the current breach began (the first sample over a threshold) */
  breachSince: number | null;
  /** ms: when it began to look clear again (while active) */
  clearSince: number | null;
  /** ms: the last warning or reminder sent */
  lastSent: number | null;
  /** ms: the last sample this state saw */
  lastSample: number | null;
  reasons: PressureReason[];
}

export type PressureReason = 'available' | 'psi' | 'swap';

export const emptyPressure = (): PressureState => ({ active: false, breachSince: null, clearSince: null, lastSent: null, lastSample: null, reasons: [] });

/** Margins a recovery needs past the threshold, so a value hovering at it doesn't flap */
export const RECOVER_MARGIN = { availablePct: 2, psiFactor: 0.6, swapPct: 5 };

export interface PressureInput {
  availablePct: number;
  swapPct: number;
  swapTotalMb: number;
  psiSome60: number | null;
}

export function pressureReasons(s: PressureInput, th: Thresholds): PressureReason[] {
  const out: PressureReason[] = [];
  if (s.availablePct < th.availablePct) out.push('available');
  if (s.psiSome60 !== null && s.psiSome60 > th.psiSome60) out.push('psi');
  if (s.swapTotalMb > 0 && s.swapPct > th.swapPct) out.push('swap');
  return out;
}

function clearOf(s: PressureInput, th: Thresholds): boolean {
  return (
    s.availablePct >= th.availablePct + RECOVER_MARGIN.availablePct &&
    (s.psiSome60 === null || s.psiSome60 <= th.psiSome60 * RECOVER_MARGIN.psiFactor) &&
    (s.swapTotalMb === 0 || s.swapPct <= th.swapPct - RECOVER_MARGIN.swapPct)
  );
}

export type PressureEvent = 'warn' | 'remind' | 'recover';

/**
 * One sample. A breach must last `sustainMin` (samples more than 3 minutes apart break the run: the server was
 * down); while active, a reminder every `reminderHours`; recovery once clear, with margins, for `sustainMin`.
 */
export function stepPressure(prev: PressureState | undefined, s: PressureInput, now: number, th: Thresholds): { next: PressureState; event: PressureEvent | null } {
  const st: PressureState = { ...emptyPressure(), ...prev };
  const gap = st.lastSample !== null && now - st.lastSample > 3 * MIN;
  st.lastSample = now;
  const reasons = pressureReasons(s, th);
  const sustain = th.sustainMin * MIN;
  if (!st.active) {
    if (!reasons.length) return { next: { ...st, breachSince: null, reasons: [] }, event: null };
    if (st.breachSince === null || gap) st.breachSince = now;
    st.reasons = reasons;
    if (now - st.breachSince < sustain) return { next: st, event: null };
    return { next: { ...st, active: true, clearSince: null, lastSent: now }, event: 'warn' };
  }
  if (reasons.length) st.reasons = reasons;
  if (clearOf(s, th)) {
    if (st.clearSince === null || gap) st.clearSince = now;
    if (now - st.clearSince >= sustain) return { next: { ...emptyPressure(), lastSample: now }, event: 'recover' };
    return { next: st, event: null };
  }
  st.clearSince = null;
  if (st.lastSent === null || now - st.lastSent >= th.reminderHours * HOUR) return { next: { ...st, lastSent: now }, event: 'remind' };
  return { next: st, event: null };
}

export const REASON_TEXT: Record<PressureReason, string> = {
  get available() {
    return t('memoryMsg.reason.available');
  },
  get psi() {
    return t('memoryMsg.reason.psi');
  },
  get swap() {
    return t('memoryMsg.reason.swap');
  },
};

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

/** Who uses the most, for the alert: "Claude CLIs 16.7 GB (73) · rea 7.5 GB ×30 · @playwright/mcp 6.0 GB ×72" */
export function topLine(s: MemorySample): string {
  const cli = s.groups.find((g) => g.key === 'claude');
  const parts = [...(cli && cli.mb ? [`Claude CLIs ${gb(cli.mb)} (${s.sessions.length})`] : []), ...s.mcp.slice(0, 3).map((m) => `${m.label} ${gb(m.mb)} ×${m.instances}`)];
  return parts.join(' · ');
}

/**
 * The alert text (English titles like the other alerts; names and sizes only, no paths). `since`: when the breach
 * began (for a recovery, the state before the step).
 */
export function pressureMessage(event: PressureEvent, s: MemorySample, since: number | null, now: number, host: string): Message {
  const m = s.mem;
  const facts = `available ${gb(m.availableMb)} of ${gb(m.totalMb)} (${m.availablePct}%), swap ${m.swapPct}% used${s.psi ? `, PSI some avg60 ${s.psi.some.avg60}` : ''}`;
  if (event === 'recover') {
    const lasted = since !== null ? ` after ${dur(now - since)}` : '';
    return { key: 'memory:pressure', kind: 'recovered', title: `portboard: ${host} memory is back to normal`, body: `Memory pressure is over${lasted}: ${facts}.`, high: false };
  }
  const idle = s.sessions.filter((x) => x.idle);
  const idleMb = idle.reduce((a, x) => a + x.mb, 0);
  const hint = idle.length ? ` ${idle.length} idle Claude sessions hold ${gb(idleMb)}: archive them in the Claude app.` : '';
  const forText = since !== null ? ` for ${dur(now - since)}` : '';
  return {
    key: 'memory:pressure',
    kind: 'warning',
    title: `portboard: ${host} is low on memory${event === 'remind' ? ' (still)' : ''}`,
    body: `Memory pressure${forText}: ${facts}. Biggest: ${topLine(s)}.${hint}`,
    high: event === 'warn',
  };
}

// ---------- suggestions ----------

export interface Suggestion {
  kind: 'idle-sessions' | 'stale-cli' | 'mcp-unused' | 'dev-idle';
  text: string;
  mb: number;
  /** a page to go to (the existing cleanup flow); never an action */
  href?: string;
  linkText?: string;
}

/** Tool calls per MCP server in the adoption scan's window (null: that scan hasn't counted them yet) */
export interface McpUse {
  days: number;
  /** sessions in the window */
  sessions: number;
  /** server segment of mcp__<server>__tool → calls and sessions that called it */
  servers: Record<string, { calls: number; sessions: number }>;
}

/** Calls to one of our MCP rows: a tool name's server segment that names it (plugin_portboard_portboard → portboard) */
export function useOf(use: McpUse, name: string): { calls: number; sessions: number } {
  const want = name.toLowerCase().replace(/^@[\w.-]+\//, '').replace(/[^a-z0-9]+/g, '');
  let calls = 0;
  let sessions = 0;
  for (const [server, v] of Object.entries(use.servers)) {
    const s = server.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (s === want || s.includes(want) || (want.length > 3 && want.includes(s) && s.length > 3)) {
      calls += v.calls;
      sessions = Math.max(sessions, v.sessions);
    }
  }
  return { calls, sessions };
}

export function suggestions(s: MemorySample, th: Thresholds, use: McpUse | null): Suggestion[] {
  const out: Suggestion[] = [];
  const idle = s.sessions.filter((x) => x.idle);
  if (idle.length) {
    const mb = idle.reduce((a, x) => a + x.mb, 0);
    out.push({ kind: 'idle-sessions', mb, text: t('memoryMsg.suggest.idle', { n: idle.length, size: gb(mb), min: th.idleMin }) });
  }
  const stale = s.sessions.filter((x) => x.stale);
  if (stale.length && s.newestVersion) {
    const mb = stale.reduce((a, x) => a + x.mb, 0);
    const old = [...new Set(stale.map((x) => x.version))].join(', ');
    out.push({ kind: 'stale-cli', mb, text: t('memoryMsg.suggest.staleCli', { versions: old, n: stale.length, size: gb(mb), newest: s.newestVersion }) });
  }
  const cliCount = s.sessions.filter((x) => !x.helper).length;
  for (const m of s.mcp) {
    if (m.instances < 3 || m.sessions < Math.max(3, cliCount / 2)) continue;
    if (!use) {
      out.push({ kind: 'mcp-unused', mb: m.mb, text: t('memoryMsg.suggest.mcpUnchecked', { label: m.label, n: m.instances, size: gb(m.mb) }) });
      continue;
    }
    const u = useOf(use, m.name);
    const share = use.sessions ? u.sessions / use.sessions : 0;
    if (share >= 0.2) continue;
    out.push({
      kind: 'mcp-unused',
      mb: m.mb,
      text: t('memoryMsg.suggest.mcpUnused', { label: m.label, n: m.instances, size: gb(m.mb), days: use.days, sessions: use.sessions, used: u.sessions, calls: u.calls }),
    });
  }
  const devIdle = s.services.filter((x) => x.dev && x.unused && x.uptimeSec !== null && x.uptimeSec >= th.devIdleHours * 3600);
  if (devIdle.length) {
    const mb = devIdle.reduce((a, x) => a + x.mb, 0);
    out.push({
      kind: 'dev-idle',
      mb,
      text: t('memoryMsg.suggest.devIdle', { hours: th.devIdleHours, n: devIdle.length, size: mbText(mb), list: devIdle.slice(0, 4).map((x) => `${x.name} :${x.ports[0]}`).join(', ') }),
      href: './#ownersBanner',
      linkText: t('memoryMsg.suggest.cleanupLink'),
    });
  }
  return out.sort((a, b) => b.mb - a.mb);
}

export const mbText = (mb: number) => (mb >= 1024 ? gb(mb) : `${mb} MB`);

/** The digest's line: only when memory is short or something sizeable can be freed */
export function digestLine(s: MemorySample, st: PressureState | null, sugg: Suggestion[]): { problem: boolean; text: string } | null {
  const m = s.mem;
  const head = t('memoryMsg.digest.head', { available: gb(m.availableMb), total: gb(m.totalMb), pct: m.availablePct, swap: m.swapPct });
  const idle = sugg.find((x) => x.kind === 'idle-sessions');
  const extra = [st?.active ? t('memoryMsg.digest.alerting') : null, idle ? t('memoryMsg.digest.idle', { n: s.sessions.filter((x) => x.idle).length, size: gb(idle.mb) }) : null, s.mcp[0] ? `${s.mcp[0].label} ×${s.mcp[0].instances} ${gb(s.mcp[0].mb)}` : null].filter(Boolean);
  return { problem: !!st?.active, text: [head, ...extra].join(' · ') };
}

// ---------- reader ----------

export interface ReaderOptions {
  /** /proc (tests pass a fixture directory) */
  root?: string;
  /** cgroup v2 system.slice (docker-<id>.scope lives there) */
  cgroupRoot?: string;
  /** container id (12 hex) → name */
  dockerNames?(): Promise<Map<string, string>>;
  /** a session's title (read from its transcript: asked at most every TITLE_TTL per session) */
  title?(id: string): Promise<string | null>;
  /** last write to a session's transcript, ms (a stat: asked every sample) */
  lastActive?(id: string): Promise<number | null>;
}

async function readText(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null);
}

/** Every process's stat and argv. Kernel threads (no argv) are left out. */
export async function readProcs(root = '/proc'): Promise<Proc[]> {
  const pids = (await readdir(root).catch(() => [] as string[])).filter((d) => /^\d+$/.test(d));
  const out: Proc[] = [];
  // a few at a time: hundreds of small reads, no need for hundreds of open files
  const BATCH = 64;
  for (let i = 0; i < pids.length; i += BATCH) {
    const rows = await Promise.all(
      pids.slice(i, i + BATCH).map(async (d) => {
        const [st, cmd] = await Promise.all([readText(join(root, d, 'stat')), readText(join(root, d, 'cmdline'))]);
        if (!st || !cmd) return null;
        const s = parseStat(st);
        if (!s) return null;
        const all = cmd.split('\0').filter(Boolean);
        if (!all.length) return null;
        const resume = all.map((a) => /^--resume=([0-9a-f-]{36})$/.exec(a)?.[1]).find(Boolean) ?? null;
        return { ...s, argv: all.slice(0, 6).map((a) => (a.length > 300 ? a.slice(0, 300) : a)), resume } satisfies Proc;
      }),
    );
    for (const r of rows) if (r) out.push(r);
  }
  return out;
}

/** docker-<id>.scope cgroups: memory.current minus inactive file pages (what `docker stats` shows) */
export async function readDocker(cgroupRoot: string, names: Map<string, string>): Promise<DockerRef[]> {
  const dirs = (await readdir(cgroupRoot).catch(() => [] as string[])).filter((d) => /^docker-[0-9a-f]{64}\.scope$/.test(d));
  return Promise.all(
    dirs.map(async (d) => {
      const id = d.slice(7, 19);
      const [cur, st, procs] = await Promise.all([readText(join(cgroupRoot, d, 'memory.current')), readText(join(cgroupRoot, d, 'memory.stat')), readText(join(cgroupRoot, d, 'cgroup.procs'))]);
      const inactive = Number(/^inactive_file (\d+)/m.exec(st ?? '')?.[1] ?? 0);
      const bytes = Math.max(0, Number(cur ?? 0) - inactive);
      return { id, name: names.get(id) ?? id, mb: Math.round(bytes / 2 ** 20), pids: (procs ?? '').split('\n').filter(Boolean).map(Number) };
    }),
  );
}

const TITLE_MARK = Buffer.from('"customTitle":"');
const TITLE_CHUNK = 1 << 20;
/** One read buffer for every title scan (they run one at a time; a call that finds it taken makes its own) */
let titleBuf: Buffer | null = null;

/**
 * The last customTitle in a transcript, reading only the bytes from `from` on (a transcript only grows), in 1 MB
 * chunks: a 100 MB transcript isn't read again, or held, to see whether its title changed. `size` is where to start
 * next time; a file that shrank (rewritten) is read from the start.
 */
export async function scanTitle(path: string, from = 0, prev: string | null = null): Promise<{ title: string | null; size: number }> {
  const fh = await open(path, 'r').catch(() => null);
  if (!fh) return { title: prev, size: from };
  const buf = titleBuf ?? Buffer.allocUnsafe(TITLE_CHUNK);
  titleBuf = null;
  try {
    const size = (await fh.stat()).size;
    let pos = size < from ? 0 : from;
    let title = size < from ? null : prev;
    // buf[0, keep) is the tail of the previous chunk (a mark or a title cut at its end), read again with the next one
    let keep = 0;
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, keep, Math.min(TITLE_CHUNK - keep, size - pos), pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const len = keep + bytesRead;
      let next = Math.max(0, len - TITLE_MARK.length);
      for (let i = buf.indexOf(TITLE_MARK); i !== -1 && i < len; i = buf.indexOf(TITLE_MARK, i + 1)) {
        if (i + TITLE_MARK.length > len) break;
        const start = i + TITLE_MARK.length;
        let end = start;
        while (end < len && end - start < 4096 && !(buf[end] === 0x22 && buf[end - 1] !== 0x5c)) end++;
        if (end >= len) {
          next = i;
          break;
        }
        try {
          title = JSON.parse(`"${buf.toString('utf8', start, end)}"`);
        } catch {
          // keep the previous one
        }
        next = Math.max(next, end);
      }
      keep = pos < size ? len - next : 0;
      if (keep) buf.copy(buf, 0, next, len);
    }
    return { title, size };
  } finally {
    titleBuf = buf;
    await fh.close().catch(() => {});
  }
}

export interface Sampler {
  /** One sample (services from the port snapshot); keeps CPU ticks for the next idle check */
  sample(services: ServiceRef[], thresholds: Thresholds, now?: number): Promise<MemorySample>;
  /** Resolves when the background title lookups queued so far are done (tests, the first API answer) */
  titlesIdle(): Promise<void>;
}

/**
 * Reads /proc and groups it. Session ids are looked up once per CLI (pid + start time: a process's environment never
 * changes). Titles come from a background queue (the feature passes scanTitle: only appended bytes), one transcript
 * at a time and at most every TITLE_TTL per session: a sample never waits for them. Until a title is in, the row shows
 * its project.
 */
export function createSampler(opts: ReaderOptions = {}): Sampler {
  const root = opts.root ?? '/proc';
  const cgroupRoot = opts.cgroupRoot ?? '/sys/fs/cgroup/system.slice';
  const TITLE_TTL = 10 * MIN;
  const ids = new Map<string, string | null>();
  const cwds = new Map<string, string | null>();
  const titles = new Map<string, { at: number; title: string | null }>();
  let prevCpu: SampleInput['prevCpu'] = null;
  const wanted: string[] = [];
  let worker: Promise<void> = Promise.resolve();
  let working = false;

  function wantTitle(id: string, now: number) {
    if (!opts.title || wanted.includes(id)) return;
    const t = titles.get(id);
    if (t && now - t.at < TITLE_TTL) return;
    wanted.push(id);
    if (working) return;
    working = true;
    worker = (async () => {
      while (wanted.length) {
        const next = wanted[0];
        const title = await opts.title!(next).catch(() => null);
        titles.set(next, { at: Date.now(), title: title ?? titles.get(next)?.title ?? null });
        wanted.shift();
      }
      working = false;
    })();
  }

  async function sessionIdOf(cli: Proc, kids: Map<number, number[]>): Promise<string | null> {
    // BFS over the descendants: the first one with CLAUDE_CODE_SESSION_ID (its MCP servers, its shells)
    const queue = [...(kids.get(cli.pid) ?? [])];
    for (let n = 0; queue.length && n < 12; n++) {
      const pid = queue.shift()!;
      const env = await readText(join(root, String(pid), 'environ'));
      const id = env ? sessionIdFromEnviron(env) : null;
      if (id) return id;
      queue.push(...(kids.get(pid) ?? []));
    }
    return null;
  }

  return {
    async sample(services, thresholds, now = Date.now()) {
      const [procs, meminfo, psiText, statText, names] = await Promise.all([
        readProcs(root),
        readText(join(root, 'meminfo')),
        readText(join(root, 'pressure', 'memory')),
        readText(join(root, 'stat')),
        opts.dockerNames ? opts.dockerNames().catch(() => new Map<string, string>()) : Promise.resolve(new Map<string, string>()),
      ]);
      if (!meminfo) throw new Error('cannot read /proc/meminfo');
      const kids = new Map<number, number[]>();
      for (const p of procs) {
        const l = kids.get(p.ppid);
        if (l) l.push(p.pid);
        else kids.set(p.ppid, [p.pid]);
      }
      const sessions = new Map<number, SessionMeta>();
      const cwdOut = new Map<number, string>();
      const live = new Set<string>();
      for (const cli of procs.filter((p) => classify(p.argv).kind === 'cli')) {
        const key = `${cli.pid}:${cli.startTicks}`;
        live.add(key);
        if (!ids.has(key) || ids.get(key) === null) ids.set(key, (await sessionIdOf(cli, kids)) ?? cli.resume);
        if (!cwds.has(key)) cwds.set(key, await readlink(join(root, String(cli.pid), 'cwd')).catch(() => null));
        const id = ids.get(key) ?? null;
        const cwd = cwds.get(key);
        if (cwd) cwdOut.set(cli.pid, cwd.replace(/ \(deleted\)$/, ''));
        let title: string | null = null;
        let lastActive: number | null = null;
        if (id) {
          wantTitle(id, now);
          title = titles.get(id)?.title ?? null;
          lastActive = opts.lastActive ? await opts.lastActive(id).catch(() => null) : null;
        }
        sessions.set(cli.pid, { id, title, lastActive });
      }
      for (const k of [...ids.keys()]) {
        if (live.has(k)) continue;
        ids.delete(k);
        cwds.delete(k);
      }
      const docker = await readDocker(cgroupRoot, names);
      const s = buildSample({
        at: now,
        mem: parseMeminfo(meminfo),
        psi: psiText ? parsePsi(psiText) : null,
        btime: (statText ? parseBtime(statText) : null) ?? Math.round(now / 1000),
        procs,
        docker,
        services,
        sessions,
        cwds: cwdOut,
        prevCpu,
        thresholds,
      });
      prevCpu = { at: now, ticks: new Map(Object.entries(s.cpu.ticks)) };
      return s;
    },
    titlesIdle: () => worker,
  };
}

// ---------- history ----------

export interface HistoryPoint {
  t: number;
  availablePct: number;
  swapPct: number;
  psi60: number | null;
  claudeMb: number;
  mcpMb: number;
}

export function historyPoint(s: MemorySample): HistoryPoint {
  const g = (k: GroupKey) => s.groups.find((x) => x.key === k)?.mb ?? 0;
  return { t: Date.parse(s.at), availablePct: s.mem.availablePct, swapPct: s.mem.swapPct, psi60: s.psi?.some.avg60 ?? null, claudeMb: g('claude'), mcpMb: g('mcp') };
}

export function pushHistory(h: HistoryPoint[], p: HistoryPoint, max = HISTORY): HistoryPoint[] {
  const next = [...h.filter((x) => x.t < p.t && p.t - x.t <= max * SAMPLE_EVERY * 1.5), p];
  return next.slice(-max);
}

// ---------- state file ----------

/** What the server keeps across restarts (stateDir/memory-state.json), and the last view for other processes */
export interface MemoryStateFile {
  version: 1;
  pressure: PressureState;
  history: HistoryPoint[];
  /** the last sample without its CPU ticks: the stdio MCP server and the remote server read it */
  view: Omit<MemorySample, 'cpu'> | null;
}

/** Its file name in the state dir */
export const MEMORY_STATE = 'memory-state.json';

export const emptyState = (): MemoryStateFile => ({ version: 1, pressure: emptyPressure(), history: [], view: null });

export function parseState(text: string): MemoryStateFile {
  try {
    const raw = JSON.parse(text);
    if (raw?.version !== 1) return emptyState();
    return {
      version: 1,
      pressure: { ...emptyPressure(), ...(raw.pressure && typeof raw.pressure === 'object' ? raw.pressure : {}) },
      history: Array.isArray(raw.history) ? raw.history.filter((h: any) => typeof h?.t === 'number').slice(-HISTORY) : [],
      view: raw.view && typeof raw.view === 'object' && raw.view.mem ? raw.view : null,
    };
  } catch {
    return emptyState();
  }
}

export async function loadState(path: string): Promise<MemoryStateFile> {
  const text = await readText(path);
  return text ? parseState(text) : emptyState();
}

/** A view this old is not "now" any more (the server stopped sampling) */
export const VIEW_STALE_MS = 5 * MIN;

/** portboard://status's memory line: numbers and reason codes only (the remote server shows it too) */
export interface MemoryStatus {
  at: string;
  pressure: boolean;
  reasons: PressureReason[];
  availablePct: number;
  swapPct: number;
  psiSome60: number | null;
}

export function statusLine(f: MemoryStateFile, now = Date.now()): MemoryStatus | null {
  const v = f.view;
  if (!v || now - Date.parse(v.at) > VIEW_STALE_MS) return null;
  return {
    at: v.at,
    pressure: f.pressure.active,
    reasons: f.pressure.active ? f.pressure.reasons : [],
    availablePct: v.mem.availablePct,
    swapPct: v.mem.swapPct,
    psiSome60: v.psi?.some.avg60 ?? null,
  };
}
