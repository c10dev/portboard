// "Where should this run?" and "where is this branch checked out?" over the machine list (machines.ts), as pure
// functions (test/recommend.test.ts). Nothing here starts anything: the answer says where, and how a person opens a
// session there.
//
// whereToRun:
//   1. excluded   offline, data older than EXCLUDE_STALE_MS, named in exclude, or missing a need: macos → a mac,
//                 windows → windows or wsl, docker / gpu / dev-server → that capability or tag (dev-server is
//                 dev-servers, which needs systemd; the cloud is kept with a caveat instead)
//   2. score      a weighted sum, 0–1 (weights: DEFAULT_WEIGHTS, portboard.json recommend.weights over them)
//                 locality      the repo@branch is checked out there 1, the repo only 0.5, else 0; the cloud 0.3
//                 conflict      subtracted: an active session or a process already works in that checkout; a
//                               quarter of it when the branch has uncommitted changes on another machine
//                 headroom      mean of 1 − load1/cores and available/total memory (the cloud: CLOUD_HEADROOM)
//                 sessionSlots  1 − active sessions / maxSessions (unknown: half)
//                 fit           long-running on an always-on machine, parallel / isolated in the cloud; a dev
//                               server in the cloud counts against it
//                 mac           added on the Mac (the control seat, negative by default)
//                 prefer        added on the machine asked for
//   3. ties       fresher data first, then list order (this machine, agents in portboard.json order, cloud)
// Every term leaves a reason (why) or a caveat in the server's language.
//
// findWorktree: exact repo (folder name or GitHub owner/name) and branch first, then a substring of repo@branch;
// conflict when one repo@branch is checked out on two machines and one of them has changes or an active session.

import { t } from './i18n.ts';
import type { MachineStatus } from './machines.ts';
import type { SessionBrief } from './claude-status.ts';
import type { WorktreeBrief } from './worktrees.ts';

export const NEEDS = ['dev-server', 'docker', 'gpu', 'macos', 'windows', 'long-running', 'parallel', 'isolated'] as const;
export type Need = (typeof NEEDS)[number];

export const DEFAULT_WEIGHTS = { locality: 0.35, conflict: 0.4, headroom: 0.25, sessionSlots: 0.15, fit: 0.15, mac: -0.1, prefer: 0.2 };
export type Weights = typeof DEFAULT_WEIGHTS;

/** Data this old (or never read) takes a machine out of the running; the cloud has none and stays */
export const EXCLUDE_STALE_MS = 5 * 60_000;
/** The cloud's headroom: unknown, but it takes nothing from these machines */
export const CLOUD_HEADROOM = 0.6;

export function weightsOf(over: Record<string, number> = {}): Weights {
  const w = { ...DEFAULT_WEIGHTS };
  for (const k of Object.keys(w) as (keyof Weights)[]) if (typeof over[k] === 'number' && Number.isFinite(over[k])) w[k] = over[k];
  return w;
}

export interface RunRequest {
  task?: string;
  repo?: string;
  branch?: string;
  needs?: Need[];
  prefer?: string;
  exclude?: string[];
}

export interface Candidate {
  machine: string;
  score: number;
  why: string[];
  caveats: string[];
}

export interface Recommendation extends Candidate {
  how: { via: string; cwd: string | null; steps: string[] };
}

export interface RunAnswer {
  recommendation: Recommendation | null;
  alternatives: Candidate[];
  excluded: { machine: string; reason: string }[];
  dataAge: Record<string, number | null>;
}

const lc = (s: string) => s.toLowerCase();

/** Is this checkout of `repo`: its folder name, or its GitHub owner/name (or just the name part) */
export function sameRepo(w: Pick<WorktreeBrief, 'repo' | 'remote'>, repo: string): boolean {
  const r = lc(repo);
  return lc(w.repo) === r || (!!w.remote && (lc(w.remote) === r || lc(w.remote).endsWith(`/${r}`)));
}

const sessionsIn = (m: MachineStatus, owner: string): SessionBrief[] => (m.claude?.sessions ?? []).filter((s) => s.worktree === owner);

function excludedFor(m: MachineStatus, req: RunRequest, now: number): string | null {
  if ((req.exclude ?? []).some((x) => lc(x) === lc(m.name) || lc(x) === lc(m.id))) return t('machinesMsg.excluded.asked');
  if (!m.online) return t('machinesMsg.excluded.offline');
  if (m.kind !== 'cloud' && (!m.checkedAt || now - Date.parse(m.checkedAt) > EXCLUDE_STALE_MS)) return t('machinesMsg.excluded.stale');
  const has = (c: string) => m.capabilities.includes(c);
  for (const need of req.needs ?? []) {
    const ok =
      need === 'macos' ? m.kind === 'mac'
      : need === 'windows' ? m.kind === 'windows' || m.kind === 'wsl' || has('windows')
      : need === 'dev-server' ? m.kind === 'cloud' || has('dev-servers')
      : need === 'docker' || need === 'gpu' ? has(need)
      : true;
    if (!ok) return t('machinesMsg.excluded.needs', { need });
  }
  return null;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function score(m: MachineStatus, req: RunRequest, all: MachineStatus[], w: Weights): Candidate & { cwd: string | null } {
  const why: string[] = [];
  const caveats: string[] = [];
  let s = 0;
  let cwd: string | null = null;
  const owner = req.repo && req.branch ? `${req.repo}@${req.branch}` : null;

  // locality
  if (req.repo) {
    if (m.kind === 'cloud') {
      s += w.locality * 0.3;
      why.push(t('machinesMsg.why.cloudClone'));
    } else {
      const repoHere = (m.worktrees ?? []).filter((x) => sameRepo(x, req.repo!));
      const exact = req.branch ? repoHere.find((x) => x.branch === req.branch) : undefined;
      if (exact) {
        s += w.locality;
        cwd = exact.path;
        why.push(exact.dirty ? t('machinesMsg.why.worktreeDirty', { owner: exact.owner, n: exact.dirty }) : t('machinesMsg.why.worktreeHere', { owner: exact.owner }));
        if (exact.reservedPort) why.push(t('machinesMsg.why.reservedPort', { port: exact.reservedPort }));
      } else if (repoHere.length) {
        s += w.locality * 0.5;
        cwd = (repoHere.find((x) => x.main) ?? repoHere[0]).path;
        why.push(t('machinesMsg.why.repoHere', { repo: req.repo }));
      } else if (m.worktrees) caveats.push(t('machinesMsg.caveat.noRepo', { repo: req.repo }));
      else caveats.push(t('machinesMsg.caveat.noCheckouts'));
    }
  }

  // conflict
  if (owner && m.kind !== 'cloud') {
    const here = (m.worktrees ?? []).find((x) => sameRepo(x, req.repo!) && x.branch === req.branch);
    const active = (m.claude?.sessions ?? []).filter((x) => !x.idle && here && x.worktree === here.owner);
    if (here && (active.length || here.inUse)) {
      s -= w.conflict;
      caveats.push(active.length ? t('machinesMsg.caveat.sessionHere', { owner: here.owner, n: active.length }) : t('machinesMsg.caveat.inUse', { owner: here.owner }));
    }
  }
  if (owner) {
    for (const o of all) {
      if (o === m || o.kind === 'cloud') continue;
      const there = (o.worktrees ?? []).find((x) => sameRepo(x, req.repo!) && x.branch === req.branch && (x.dirty ?? 0) > 0);
      if (there) {
        s -= w.conflict / 4;
        caveats.push(t('machinesMsg.caveat.dirtyElsewhere', { machine: o.name, n: there.dirty }));
        break;
      }
    }
  }

  // headroom
  if (m.kind === 'cloud') {
    s += w.headroom * CLOUD_HEADROOM;
    why.push(t('machinesMsg.why.cloudFree'));
  } else if (m.load) {
    const cpu = m.load.cores > 0 ? 1 - Math.min(1, m.load.load1 / m.load.cores) : 0.5;
    const mem = m.load.memTotalMb && m.load.memAvailMb !== null ? m.load.memAvailMb / m.load.memTotalMb : 0.5;
    s += w.headroom * ((cpu + mem) / 2);
    why.push(t('machinesMsg.why.load', { load: m.load.load1, cores: m.load.cores }));
    if (cpu < 0.2) caveats.push(t('machinesMsg.caveat.busy'));
  } else s += w.headroom * 0.5;

  // session slots
  if (m.claude && m.maxSessions) {
    s += w.sessionSlots * (1 - Math.min(1, m.claude.active / m.maxSessions));
    why.push(t('machinesMsg.why.sessions', { active: m.claude.active, max: m.maxSessions }));
    if (m.claude.active >= m.maxSessions) caveats.push(t('machinesMsg.caveat.full', { max: m.maxSessions }));
  } else s += w.sessionSlots * (m.kind === 'cloud' ? 1 : 0.5);
  if (m.oldAgent) caveats.push(t('machinesMsg.caveat.oldAgent'));

  // fit
  const needs = req.needs ?? [];
  if (needs.includes('long-running') && m.capabilities.includes('always-on')) {
    s += w.fit;
    why.push(t('machinesMsg.why.alwaysOn'));
  }
  if ((needs.includes('parallel') || needs.includes('isolated')) && m.kind === 'cloud') {
    s += w.fit;
    why.push(t('machinesMsg.why.isolated'));
  }
  if (needs.includes('dev-server')) {
    if (m.kind === 'cloud') {
      s -= w.fit * 0.5;
      caveats.push(t('machinesMsg.caveat.cloudNoTailnet'));
    } else why.push(t('machinesMsg.why.devServer'));
  }
  if (m.kind === 'mac') {
    s += w.mac;
    if (w.mac < 0) caveats.push(t('machinesMsg.caveat.controlSeat'));
  }
  if (req.prefer && (lc(req.prefer) === lc(m.name) || lc(req.prefer) === lc(m.id))) {
    s += w.prefer;
    why.push(t('machinesMsg.why.prefer'));
  }
  return { machine: m.name, score: round2(Math.max(0, Math.min(1, s))), why, caveats, cwd };
}

function howFor(m: MachineStatus, cwd: string | null, needs: Need[]): Recommendation['how'] {
  const via = m.launch.find((l) => l.via === 'local')?.via ?? m.launch[0]?.via ?? 'local';
  const steps: string[] = [];
  if (via === 'local') steps.push(t('machinesMsg.step.local'));
  else if (via === 'desktop-ssh') steps.push(t('machinesMsg.step.desktopSsh', { machine: m.name }));
  else if (via === 'cloud') steps.push(t('machinesMsg.step.cloud'));
  else steps.push(t('machinesMsg.step.remoteControl', { machine: m.name }));
  if (cwd) steps.push(t('machinesMsg.step.cwd', { cwd }));
  if (needs.includes('dev-server') && m.kind !== 'cloud') steps.push(t('machinesMsg.step.devServer'));
  return { via, cwd, steps };
}

export function whereToRun(req: RunRequest, machines: MachineStatus[], o: { weights?: Record<string, number>; now?: number } = {}): Omit<RunAnswer, 'dataAge'> {
  const now = o.now ?? Date.now();
  const w = weightsOf(o.weights);
  const excluded: RunAnswer['excluded'] = [];
  const scored: (Candidate & { cwd: string | null; m: MachineStatus; i: number })[] = [];
  machines.forEach((m, i) => {
    const reason = excludedFor(m, req, now);
    if (reason) excluded.push({ machine: m.name, reason });
    else scored.push({ ...score(m, req, machines, w), m, i });
  });
  const age = (m: MachineStatus) => (m.checkedAt ? now - Date.parse(m.checkedAt) : Infinity);
  scored.sort((a, b) => b.score - a.score || age(a.m) - age(b.m) || a.i - b.i);
  const [best, ...rest] = scored;
  const plain = ({ machine, score, why, caveats }: Candidate) => ({ machine, score, why, caveats });
  return {
    recommendation: best ? { ...plain(best), how: howFor(best.m, best.cwd, req.needs ?? []) } : null,
    alternatives: rest.slice(0, 3).map(plain),
    excluded,
  };
}

export interface WorktreeMatch {
  machine: string;
  owner: string;
  repo: string;
  branch: string | null;
  path: string | null;
  main: boolean;
  dirty: number | null;
  inUse: boolean;
  /** the session working there (an active one first) */
  activeSession: { id: string | null; idleMin: number | null; idle: boolean } | null;
  reservedPort: number | null;
  lastCommit: string | null;
}

export interface FindQuery {
  repo?: string;
  branch?: string;
  query?: string;
  machine?: string;
}

export function findWorktree(q: FindQuery, machines: MachineStatus[]): { matches: WorktreeMatch[]; conflict: string | null } {
  const exact: WorktreeMatch[] = [];
  const partial: WorktreeMatch[] = [];
  const needle = q.query ? lc(q.query) : null;
  for (const m of machines) {
    if (q.machine && lc(q.machine) !== lc(m.name) && lc(q.machine) !== lc(m.id)) continue;
    for (const w of m.worktrees ?? []) {
      const repoOk = !q.repo || sameRepo(w, q.repo);
      const branchOk = !q.branch || w.branch === q.branch;
      const isExact = (q.repo || q.branch) && repoOk && branchOk;
      const isPartial = !isExact && needle !== null && repoOk && lc(`${w.owner} ${w.remote ?? ''}`).includes(needle);
      if (!isExact && !isPartial) continue;
      const sessions = sessionsIn(m, w.owner).sort((a, b) => Number(a.idle) - Number(b.idle));
      const s = sessions[0];
      const row: WorktreeMatch = {
        machine: m.name,
        owner: w.owner,
        repo: w.repo,
        branch: w.branch,
        path: w.path,
        main: w.main,
        dirty: w.dirty,
        inUse: w.inUse,
        activeSession: s ? { id: s.id, idleMin: s.idleMin, idle: s.idle } : null,
        reservedPort: w.reservedPort,
        lastCommit: w.lastCommit,
      };
      (isExact ? exact : partial).push(row);
    }
  }
  const matches = [...exact, ...partial];
  // one repo@branch on two machines, and one side has work in it
  let conflict: string | null = null;
  const byBranch = new Map<string, WorktreeMatch[]>();
  for (const x of matches) {
    if (!x.branch) continue;
    const key = `${lc(x.repo)}@${x.branch}`;
    byBranch.set(key, [...(byBranch.get(key) ?? []), x]);
  }
  for (const [key, rows] of byBranch) {
    const machinesThere = [...new Set(rows.map((r) => r.machine))];
    if (machinesThere.length < 2) continue;
    const busy = rows.filter((r) => (r.dirty ?? 0) > 0 || (r.activeSession && !r.activeSession.idle));
    if (busy.length) {
      conflict = t('machinesMsg.conflict', { owner: key, machines: machinesThere.join(', '), busy: [...new Set(busy.map((r) => r.machine))].join(', ') });
      break;
    }
  }
  return { matches, conflict };
}
