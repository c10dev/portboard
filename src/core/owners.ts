// Who owns a listening server: which Claude session started it, which git worktree/branch it runs from, and whether
// it is left over (c10dev/portboard#25, #26).
//
// Sources, cheapest first:
//   - /proc/<pid>/environ: CLAUDE_CODE_SESSION_ID and CLAUDE_PID, set for everything a Claude Code session spawns
//   - /proc/<pid>/cwd: a Claude scratchpad (/tmp/claude-<uid>/<project>/<session-uuid>/…), a git worktree, or a
//     directory that was deleted (readlink ends in " (deleted)")
//   - ~/.claude/projects/*/<session>.jsonl: the session's title (last customTitle) and when it was last active
//   - git: branch, whether it is merged into the repo's default branch, uncommitted changes (cached per directory)
//
// Nothing here changes anything; cleanup (stopping a leftover server) goes through the existing stop action.

import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { TtlMap } from './cache.ts';
import { GIT_NO_HOOKS, run } from './exec.ts';
import { services } from './platform/services.ts';
import { stillEnded, type EndedLookup } from './claude-sessions.ts';
import { t } from './i18n.ts';

export interface SessionRef {
  id: string;
  title: string | null;
  /** The Claude process that started it is still running */
  alive: boolean;
  /** Last write to the session's transcript (ISO), when found */
  lastActive: string | null;
  source: 'env' | 'scratchpad';
}

export interface WorktreeRef {
  /** Main repository directory (~-shortened) */
  repo: string;
  repoName: string;
  /** The worktree's own directory (~-shortened) */
  path: string;
  branch: string | null;
  /** Merged into the repo's default branch (origin/HEAD, else main/master); null when unknown */
  merged: boolean | null;
  /** Tracked files changed; null when unknown */
  dirty: boolean | null;
  /** A linked worktree (not the main checkout) */
  linked: boolean;
}

export interface Owner {
  pid: number;
  session: SessionRef | null;
  worktree: WorktreeRef | null;
  scratchpad: boolean;
  /** The working directory was deleted (worktree or scratchpad removed) */
  cwdGone: boolean;
  /** Re-parented to the user's systemd (its starter exited) */
  orphan: boolean;
}

export type CleanupReason = 'cwd-gone' | 'session-ended' | 'branch-merged' | 'session-ended-hook';

export const REASON_TEXT: Record<CleanupReason, string> = {
  get 'cwd-gone'() {
    return t('ownersMsg.reason.cwdGone');
  },
  get 'session-ended'() {
    return t('ownersMsg.reason.sessionEnded');
  },
  get 'branch-merged'() {
    return t('ownersMsg.reason.branchMerged');
  },
  get 'session-ended-hook'() {
    return t('ownersMsg.reason.sessionEndedHook');
  },
};

const HOME = homedir();
const short = (p: string) => (p === HOME || p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p);
const SCRATCH = /^\/tmp\/claude-\d+\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/|$)/;
/** A session whose transcript hasn't moved for this long counts as ended (when its process can't be checked) */
export const SESSION_IDLE_MS = 2 * 60 * 60_000;

export function parseEnviron(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of raw.split('\0')) {
    const i = kv.indexOf('=');
    if (i > 0 && /^(CLAUDE_CODE_SESSION_ID|CLAUDE_PID)$/.test(kv.slice(0, i))) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

export function scratchpadSession(cwd: string): string | null {
  return SCRATCH.exec(cwd)?.[1] ?? null;
}

/** "gitdir: /repo/.git/worktrees/name" → "/repo" */
export function mainRepoFromGitFile(text: string): string | null {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  const i = m[1].indexOf('/.git/worktrees/');
  return i > 0 ? m[1].slice(0, i) : null;
}

/**
 * The reasons a server is a cleanup candidate (empty: keep). Only plain processes are ever candidates. `ended` looks up
 * sessions whose SessionEnd hook fired (claude-sessions.ts, #43): their servers are candidates at once, even while the
 * Claude process is still exiting, unless the session came back since.
 */
export function cleanupReasons(o: Owner, now: number, ended?: EndedLookup): CleanupReason[] {
  const reasons: CleanupReason[] = [];
  if (o.cwdGone) reasons.push('cwd-gone');
  const hook = o.session ? ended?.(o.session.id) : null;
  if (o.session && hook && stillEnded(hook, o.session.lastActive)) reasons.push('session-ended-hook');
  else if (o.session && !o.session.alive) {
    const idle = o.session.lastActive ? now - Date.parse(o.session.lastActive) : Infinity;
    // A session's server without its Claude process: left over when it ran from the session's scratchpad, or when the
    // session has been quiet for a while (a long-running dev server from a finished session).
    if (o.scratchpad || idle > SESSION_IDLE_MS) reasons.push('session-ended');
  }
  // A merged branch's server is still someone's preview while the session that started it is running.
  if (o.worktree?.linked && o.worktree.merged === true && o.worktree.dirty === false && !o.session?.alive) reasons.push('branch-merged');
  return reasons;
}

// ---- lookups (cached) ----

/** session id → its title, valid while the transcript's mtime is unchanged; the 512 most recent sessions */
const titleCache = new TtlMap<string, { mtimeMs: number; title: string | null; path: string }>({ ttlMs: Infinity, maxEntries: 512 });
let sessionIndex: { at: number; files: Map<string, string> } | null = null;

async function sessionFile(id: string): Promise<string | null> {
  if (!sessionIndex || Date.now() - sessionIndex.at > 60_000) {
    const files = new Map<string, string>();
    const root = join(HOME, '.claude', 'projects');
    for (const dir of await readdir(root).catch(() => [] as string[])) {
      for (const f of await readdir(join(root, dir)).catch(() => [] as string[])) {
        if (f.endsWith('.jsonl')) files.set(f.slice(0, -6), join(root, dir, f));
      }
    }
    sessionIndex = { at: Date.now(), files };
  }
  return sessionIndex.files.get(id) ?? null;
}

async function sessionInfo(id: string): Promise<{ title: string | null; lastActive: string | null }> {
  const path = await sessionFile(id);
  if (!path) return { title: null, lastActive: null };
  const st = await stat(path).catch(() => null);
  if (!st) return { title: null, lastActive: null };
  const hit = titleCache.peek(id);
  if (hit && hit.mtimeMs === st.mtimeMs) return { title: hit.title, lastActive: new Date(st.mtimeMs).toISOString() };
  // Titles are short lines; the last one wins. Read only the tail of big transcripts.
  const text = await readFile(path, 'utf8').catch(() => '');
  const tail = text.length > 4_000_000 ? text.slice(-4_000_000) : text;
  let title: string | null = null;
  for (const m of tail.matchAll(/"customTitle":"((?:[^"\\]|\\.)*)"/g)) title = m[1];
  if (title) {
    try {
      title = JSON.parse(`"${title}"`);
    } catch {
      // keep the raw text
    }
  }
  titleCache.set(id, { mtimeMs: st.mtimeMs, title, path });
  return { title, lastActive: new Date(st.mtimeMs).toISOString() };
}

/** A session's transcript (its <id>.jsonl under ~/.claude/projects), or null: for the memory view (src/core/memory.ts). */
export const transcriptPath = (id: string): Promise<string | null> => sessionFile(id);

/** When a session's transcript was last written (ms), or null when it isn't found: one stat, no read. */
export async function transcriptMtime(id: string): Promise<number | null> {
  const path = await sessionFile(id);
  return path ? stat(path).then((st) => st.mtimeMs, () => null) : null;
}

async function isClaudeProcess(pid: number): Promise<boolean> {
  const cmd = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
  return /claude|ccd-cli/i.test(cmd);
}

const GIT_TTL = 5 * 60_000;
/** cwd → its checkout (null: not in one), written once the git calls are done; the 512 most recent cwds */
const gitCache = new TtlMap<string, WorktreeRef | null>({ ttlMs: GIT_TTL, maxEntries: 512 });

async function findGitRoot(dir: string): Promise<{ root: string; gitFile: string | null } | null> {
  let d = dir;
  for (let i = 0; i < 40; i++) {
    const st = await stat(join(d, '.git')).catch(() => null);
    if (st) return { root: d, gitFile: st.isFile() ? await readFile(join(d, '.git'), 'utf8').catch(() => null) : null };
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

async function worktreeOf(cwd: string): Promise<WorktreeRef | null> {
  if (gitCache.has(cwd)) return gitCache.get(cwd) ?? null;
  let value: WorktreeRef | null = null;
  const g = await findGitRoot(cwd);
  if (g) {
    const mainRepo = g.gitFile ? mainRepoFromGitFile(g.gitFile) : g.root;
    // fsmonitor/hooks off: the cwd of any listening process is a checkout we only look at (I4)
    const git = (args: string[]) => run('git', ['-C', g.root, ...GIT_NO_HOOKS, ...args], 5_000);
    const [branchR, defR, dirtyR] = await Promise.all([
      git(['rev-parse', '--abbrev-ref', 'HEAD']),
      git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
      git(['status', '--porcelain', '--untracked-files=no']),
    ]);
    const branch = branchR.ok ? branchR.stdout.trim() || null : null;
    let base = defR.ok ? defR.stdout.trim() : '';
    if (!base) {
      for (const b of ['main', 'master']) if ((await git(['rev-parse', '--verify', '--quiet', b])).ok) (base ||= b);
    }
    let merged: boolean | null = null;
    if (base && branch && branch !== 'HEAD' && branch !== base && branch !== base.replace(/^origin\//, '')) {
      const r = await git(['merge-base', '--is-ancestor', 'HEAD', base]);
      merged = r.ok ? true : /exit 1/.test(r.stderr) ? false : null;
    } else if (branch === base.replace(/^origin\//, '')) merged = false;
    const repo = mainRepo ?? g.root;
    value = {
      repo: short(repo),
      repoName: repo.split('/').pop() ?? repo,
      path: short(g.root),
      branch,
      merged,
      dirty: dirtyR.ok ? dirtyR.stdout.trim().length > 0 : null,
      linked: !!g.gitFile,
    };
  }
  gitCache.set(cwd, value);
  return value;
}

/** Owner of one process; null when the process is gone or not ours. */
export async function ownerOf(pid: number): Promise<Owner | null> {
  const [environ, cwdRaw, status] = await Promise.all([
    readFile(`/proc/${pid}/environ`, 'utf8').catch(() => null),
    readlink(`/proc/${pid}/cwd`).catch(() => null),
    readFile(`/proc/${pid}/status`, 'utf8').catch(() => ''),
  ]);
  if (environ === null && cwdRaw === null) return null;
  const env = parseEnviron(environ ?? '');
  const cwdGone = !!cwdRaw?.endsWith(' (deleted)');
  const cwd = cwdRaw ? cwdRaw.replace(/ \(deleted\)$/, '') : null;
  const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0);
  const parentCmd = ppid ? await readFile(`/proc/${ppid}/cmdline`, 'utf8').catch(() => '') : '';
  const orphan = ppid === 1 || /systemd\u0000--user/.test(parentCmd) || parentCmd.startsWith('/usr/lib/systemd/systemd');

  const scratchId = cwd ? scratchpadSession(cwd) : null;
  const id = env.CLAUDE_CODE_SESSION_ID || scratchId;
  let session: SessionRef | null = null;
  if (id) {
    const info = await sessionInfo(id);
    const claudePid = Number(env.CLAUDE_PID || 0);
    const alive = claudePid > 0 ? await isClaudeProcess(claudePid) : info.lastActive ? Date.now() - Date.parse(info.lastActive) < 10 * 60_000 : false;
    session = { id, title: info.title, alive, lastActive: info.lastActive, source: env.CLAUDE_CODE_SESSION_ID ? 'env' : 'scratchpad' };
  }
  const worktree = cwd && !cwdGone && !scratchId ? await worktreeOf(cwd) : null;
  return { pid, session, worktree, scratchpad: !!scratchId, cwdGone, orphan };
}

// ---- transient units ----

let transientCache: { at: number; units: Map<string, boolean> } = { at: 0, units: new Map() };

/**
 * Units made with `systemd-run` (their FragmentPath is under /run/user/<uid>/systemd/transient/): Claude sessions start
 * previews and test services that way, and nothing re-creates them. Installed services are never transient.
 */
export async function transientUnits(units: string[], now = Date.now()): Promise<Set<string>> {
  if (now - transientCache.at > 60_000) transientCache = { at: now, units: new Map() };
  const missing = [...new Set(units)].filter((u) => !transientCache.units.has(u));
  if (missing.length) {
    const r = await services().show(missing, 'Id,FragmentPath', 5_000);
    for (const block of r.stdout.split('\n\n')) {
      const id = /^Id=(.*)$/m.exec(block)?.[1];
      const frag = /^FragmentPath=(.*)$/m.exec(block)?.[1] ?? '';
      if (id) transientCache.units.set(id, isTransientPath(frag));
    }
    for (const u of missing) if (!transientCache.units.has(u)) transientCache.units.set(u, false);
  }
  return new Set(units.filter((u) => transientCache.units.get(u)));
}

export function isTransientPath(fragmentPath: string): boolean {
  return /^\/run\/user\/\d+\/systemd\/transient\//.test(fragmentPath);
}

