// Which Claude Code sessions run on this machine, summed up for machine_status and the agent's /agent/v1/status
// (docs/multi-host.md): per session its project, the worktree it runs in (repo@branch), how idle it is, CPU and MB.
//
//   Linux   the memory sampler's sessions (src/core/memory/): the dashboard's last sample in memory-state.json while
//           it is fresh, else one read of /proc (no CPU on that first read, so idle comes from the transcript alone).
//           The session id comes from a descendant's environ (only CLAUDE_CODE_SESSION_ID is ever kept).
//   macOS   `ps -axo pid=,ppid=,lstart=,command=` through the same classify(), cwds from lsof, and the session id from
//           the transcript: the newest <id>.jsonl in ~/.claude/projects/<cwd with every non-alphanumeric as ->.
//
// Helper CLIs (--no-session-persistence forks the app starts next to a session) are left out. Titles and transcript
// contents never leave this module; ids are cut to 8 characters (enough to tell sessions apart).

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run, type RunResult } from './exec.ts';
import { PATHS } from './paths.ts';
import { transcriptMtime } from './owners.ts';
import { parseLsofCwd } from './platform/procs.ts';
import { platform } from './platform/index.ts';
import { classify, versionCmp } from './memory/classify.ts';
import { createSampler } from './memory/sampler.ts';
import { DEFAULT_THRESHOLDS, IDLE_CPU_PCT, projectName, type SessionRow } from './memory/sample.ts';
import { loadState, MEMORY_STATE, VIEW_STALE_MS } from './memory/state.ts';

export interface SessionBrief {
  /** the first 8 characters of CLAUDE_CODE_SESSION_ID (or of the transcript's name on macOS) */
  id: string | null;
  /** the folder under projects/, or <repo>/<worktree> (memory's projectName) */
  project: string | null;
  /** repo@branch of the worktree its cwd is in, when that is a scanned worktree */
  worktree: string | null;
  idleMin: number | null;
  /** % of one core since the previous sample; null when there is none */
  cpuPct: number | null;
  mb: number | null;
  startedAt: string | null;
  idle: boolean;
}

export interface ClaudeSummary {
  /** the newest CLI version running */
  cliVersion: string | null;
  sessions: SessionBrief[];
  active: number;
  idle: number;
  /** proc: Linux /proc; ps: macOS ps + lsof; transcripts: only transcript times; github: the cloud's estimate from claude/* branches */
  source: 'proc' | 'ps' | 'transcripts' | 'github';
}

/** One CLI as the readers see it, before it is matched to a worktree */
export interface CliRow {
  id: string | null;
  cwd: string | null;
  version: string | null;
  idleMin: number | null;
  cpuPct: number | null;
  mb: number | null;
  startedAt: string | null;
  helper: boolean;
  /** the sampler's verdict (transcript quiet and CPU low); null when it couldn't tell */
  idle: boolean | null;
}

/** A session is idle when the sampler says so, or (no CPU reading) when its transcript has been quiet for idleMin */
export function isIdle(r: Pick<CliRow, 'idle' | 'idleMin' | 'cpuPct'>, idleMin = DEFAULT_THRESHOLDS.idleMin): boolean {
  if (r.idle !== null) return r.idle;
  if (r.idleMin === null) return false;
  return r.idleMin >= idleMin && (r.cpuPct === null || r.cpuPct < IDLE_CPU_PCT);
}

/** Sessions → the summary; `worktreeOf` maps a cwd to repo@branch (src/core/worktrees.ts worktreeOwnerOf). Pure. */
export function summarize(rows: CliRow[], source: ClaudeSummary['source'], worktreeOf: (cwd: string) => string | null = () => null, idleMin = DEFAULT_THRESHOLDS.idleMin): ClaudeSummary {
  const sessions: SessionBrief[] = rows
    .filter((r) => !r.helper)
    .map((r) => ({
      id: r.id ? r.id.slice(0, 8) : null,
      project: r.cwd ? projectName(r.cwd) : null,
      worktree: r.cwd ? worktreeOf(r.cwd) : null,
      idleMin: r.idleMin,
      cpuPct: r.cpuPct,
      mb: r.mb,
      startedAt: r.startedAt,
      idle: isIdle(r, idleMin),
    }));
  const versions = rows.map((r) => r.version).filter((v): v is string => !!v);
  const cliVersion = versions.length ? versions.reduce((a, b) => (versionCmp(a, b) >= 0 ? a : b)) : null;
  const idle = sessions.filter((s) => s.idle).length;
  return { cliVersion, sessions, active: sessions.length - idle, idle, source };
}

/** The memory sampler's session rows as CliRows */
export function fromSessionRows(rows: Pick<SessionRow, 'id' | 'cwd' | 'version' | 'idleMin' | 'cpuPct' | 'mb' | 'startedAt' | 'helper' | 'idle'>[]): CliRow[] {
  return rows.map((r) => ({ id: r.id, cwd: r.cwd ?? null, version: r.version, idleMin: r.idleMin, cpuPct: r.cpuPct, mb: r.mb, startedAt: r.startedAt, helper: r.helper, idle: r.idle }));
}

// ---- macOS: ps + lsof + transcripts ----

export interface PsRow {
  pid: number;
  ppid: number;
  startedAt: string | null;
  argv: string[];
}

/** `ps -axo pid=,ppid=,lstart=,command=` (lstart: "Wed Oct 22 05:00:00 2026") → rows. Pure. */
export function parsePsTree(text: string): PsRow[] {
  const out: PsRow[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const started = Date.parse(m[3].replace(/\s+/g, ' '));
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), startedAt: Number.isFinite(started) ? new Date(started).toISOString() : null, argv: m[4].split(/\s+/) });
  }
  return out;
}

/** The CLIs that aren't inside another CLI's tree (a nested `claude -p` belongs to its outer session). Pure. */
export function topClis(rows: PsRow[]): (PsRow & { version: string | null })[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const clis = new Map<number, string | null>();
  for (const r of rows) {
    const k = classify(r.argv);
    if (k.kind === 'cli') clis.set(r.pid, k.version);
  }
  return rows
    .filter((r) => {
      if (!clis.has(r.pid)) return false;
      for (let q = byPid.get(r.ppid), n = 0; q && n < 64; q = byPid.get(q.ppid), n++) if (clis.has(q.pid)) return false;
      return true;
    })
    .map((r) => ({ ...r, version: clis.get(r.pid) ?? null }));
}

/** ~/.claude/projects/<dir> for a cwd: every character that isn't a letter or a digit becomes - */
export const projectDirOf = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

const MIN = 60_000;

/** The newest transcripts in a project dir, newest first (id = file name without .jsonl) */
async function transcripts(dir: string): Promise<{ id: string; mtimeMs: number }[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.jsonl'));
  const out = await Promise.all(names.map((f) => stat(join(dir, f)).then((st) => ({ id: f.slice(0, -6), mtimeMs: st.mtimeMs }), () => null)));
  return out.filter((x): x is { id: string; mtimeMs: number } => !!x).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

type Exec = (cmd: string, args: string[], timeoutMs?: number) => Promise<RunResult>;

/** macOS (and any system without /proc): the CLIs from ps, their cwds from lsof, ids and idle time from transcripts */
export async function psSessions(o: { exec?: Exec; home?: string; now?: number } = {}): Promise<CliRow[]> {
  const exec = o.exec ?? run;
  const home = o.home ?? homedir();
  const now = o.now ?? Date.now();
  const ps = await exec('ps', ['-axo', 'pid=,ppid=,lstart=,command='], 5_000);
  if (!ps.ok) return [];
  const clis = topClis(parsePsTree(ps.stdout));
  if (!clis.length) return [];
  const lsof = await exec('lsof', ['-a', '-p', clis.map((c) => c.pid).join(','), '-d', 'cwd', '-F', 'pn'], 5_000);
  const cwds = parseLsofCwd(lsof.stdout);
  // several sessions in one cwd: each takes the newest transcript not taken yet
  const taken = new Set<string>();
  const rows: CliRow[] = [];
  for (const c of clis) {
    const cwd = cwds.get(c.pid) ?? null;
    let id: string | null = null;
    let idleMin: number | null = null;
    if (cwd) {
      const t = (await transcripts(join(home, '.claude', 'projects', projectDirOf(cwd)))).find((x) => !taken.has(x.id));
      if (t) {
        taken.add(t.id);
        id = t.id;
        idleMin = Math.max(0, Math.floor((now - t.mtimeMs) / MIN));
      }
    }
    rows.push({ id, cwd, version: c.version, idleMin, cpuPct: null, mb: null, startedAt: c.startedAt, helper: c.argv.includes('--no-session-persistence'), idle: null });
  }
  return rows;
}

// ---- this machine ----

const sampler = createSampler({ lastActive: transcriptMtime });

/** Linux: the dashboard's fresh sample, else one /proc read of our own */
async function procSessions(statePath: string, now: number): Promise<CliRow[]> {
  const f = await loadState(statePath);
  if (f.view && now - Date.parse(f.view.at) < VIEW_STALE_MS) return fromSessionRows(f.view.sessions);
  return fromSessionRows((await sampler.sample([], DEFAULT_THRESHOLDS, now)).sessions);
}

/** This machine's sessions, matched to worktrees by `worktreeOf`; null when they can't be read here */
export async function localClaude(worktreeOf: (cwd: string) => string | null = () => null, o: { statePath?: string; now?: number } = {}): Promise<ClaudeSummary | null> {
  const now = o.now ?? Date.now();
  try {
    if (platform().procfs) return summarize(await procSessions(o.statePath ?? join(PATHS.stateDir, MEMORY_STATE), now), 'proc', worktreeOf);
    return summarize(await psSessions({ now }), 'ps', worktreeOf);
  } catch {
    return null;
  }
}
