// 메모리 (src/core/memory.ts): one sample's model and buildSample(), which groups one /proc read (pure). The partition
// (groups) and the per-session trees are described in memory.ts's header.

import { shortPath } from '../proc.ts';
import { t } from '../i18n.ts';
import { classify, MCP_LABELS, versionCmp } from './classify.ts';
import { CLK_TCK, type MemInfo, type Psi, type StatLine } from './parse.ts';

const MIN = 60_000;
export const SAMPLE_EVERY = MIN;
/** A waiting CLI still polls (0.5–1.6 % of a core measured); a running tool call is well above this */
export const IDLE_CPU_PCT = 3;
/** Samples kept for the sparklines (an hour) */
export const HISTORY = 60;

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
