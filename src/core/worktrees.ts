// Worktree hygiene across repositories (c10dev/portboard#36): every git worktree of the repos under ~/projects, with
// branch, merge/PR state, uncommitted changes, last commit, size and whether anything runs in it; and the ones that
// can safely go.
//
// "Can go" means all of: a linked worktree (never the main checkout), not locked, no tracked or untracked changes, no
// process with its working directory inside, and its branch is merged — by ancestry into the default branch, or by a
// merged PR whose head is exactly the worktree's HEAD (squash merges aren't ancestors). A worktree whose directory is
// already gone is "prunable" (`git worktree prune`).
//
// Removal is `git worktree remove <path>` without --force (git itself refuses on changes), after re-checking. Branches
// are never deleted.
//
// Scan cost (c10dev/portboard#44): the background scan is incremental. Facts that can't change for a given commit
// (commit date, "A is an ancestor of B") are cached by sha; `git status` only runs when a worktree's signature — HEAD,
// the index, an lstat of every tracked file and the mtime of every directory holding one, plus the ignore/config
// files — changed since the last status, or the last live status is older than STATUS_TTL_MS; `du` runs when HEAD
// changed, the size is older than SIZE_TTL_MS, or older than SIZE_CHANGED_TTL_MS and the files changed. Repos without linked worktrees cost nothing. A full scan (?refresh)
// trusts no cache, and removal re-checks everything live.

import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { GIT_NO_HOOKS, run as execRun, type RunResult } from './exec.ts';
import { readCwd, scanProcs } from './proc.ts';
import { SITE } from './site.ts';
import { t } from './i18n.ts';

/** How scans spawn subprocesses; tests pass a counting or fake one. */
export type Runner = (cmd: string, args: string[], timeoutMs?: number) => Promise<RunResult>;

export interface WorktreeInfo {
  path: string;
  /** ~-shortened, for display */
  short: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  main: boolean;
  locked: boolean;
  /** The directory is gone (git calls it prunable) */
  prunable: boolean;
  /** Changed or untracked files (count); null when unknown */
  changes: number | null;
  lastCommit: string | null;
  sizeKb: number | null;
  /** Merged into the default branch by ancestry; null when unknown or not applicable */
  mergedByAncestry: boolean | null;
  pr: { number: number; state: 'OPEN' | 'MERGED' | 'CLOSED'; headMatches: boolean } | null;
  /** pids whose working directory is inside the worktree */
  inUse: number[];
  /** Why it can't be removed (empty: it can) */
  keep: string[];
  removable: boolean;
}

export interface RepoInfo {
  name: string;
  path: string;
  short: string;
  remote: string | null;
  defaultBranch: string | null;
  worktrees: WorktreeInfo[];
  prsKnown: boolean;
  error: string | null;
}

export interface WorktreesDoc {
  at: string | null;
  scanning: boolean;
  tookMs: number | null;
  repos: RepoInfo[];
  totals: { repos: number; worktrees: number; removable: number; prunable: number; removableKb: number };
  /** What the last scan cost: its mode and the subprocesses it started per command */
  scan?: { mode: ScanMode; spawns: Record<string, number> };
}

/** incremental: reuse the cache (background job); full: trust nothing, rebuild the cache (?refresh); live: trust nothing, keep nothing (removal) */
export type ScanMode = 'incremental' | 'full' | 'live';

const HOME = homedir();
const short = (p: string) => (p === HOME || p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p);

// ---- parsing (pure) ----

export interface PorcelainEntry {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

export function parsePorcelain(text: string): PorcelainEntry[] {
  const out: PorcelainEntry[] = [];
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split('\n').filter(Boolean);
    const path = lines.find((l) => l.startsWith('worktree '))?.slice(9);
    if (!path) continue;
    const head = lines.find((l) => l.startsWith('HEAD '))?.slice(5) ?? null;
    const branchRef = lines.find((l) => l.startsWith('branch '))?.slice(7) ?? null;
    out.push({
      path,
      head,
      branch: branchRef ? branchRef.replace(/^refs\/heads\//, '') : null,
      detached: lines.includes('detached'),
      locked: lines.some((l) => l === 'locked' || l.startsWith('locked ')),
      prunable: lines.some((l) => l === 'prunable' || l.startsWith('prunable ')),
    });
  }
  return out;
}

/** "owner/name" from a GitHub remote URL, or null */
export function githubRepo(url: string): string | null {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export function keepReasons(w: Omit<WorktreeInfo, 'keep' | 'removable'>): string[] {
  const keep: string[] = [];
  if (w.main) keep.push(t('worktrees.keep.main'));
  if (w.prunable) return keep.length ? keep : []; // gone already: handled by prune, not remove
  if (w.locked) keep.push(t('worktrees.keep.locked'));
  if (w.changes === null) keep.push(t('worktrees.keep.changesUnknown'));
  else if (w.changes > 0) keep.push(t('worktrees.keep.changes', { n: w.changes }));
  if (w.inUse.length) keep.push(t('worktrees.keep.inUse', { n: w.inUse.length }));
  const merged = w.mergedByAncestry === true || (w.pr?.state === 'MERGED' && w.pr.headMatches);
  if (!merged) {
    if (w.pr?.state === 'MERGED' && !w.pr.headMatches) keep.push(t('worktrees.keep.extraCommits'));
    else if (w.pr?.state === 'OPEN') keep.push(t('worktrees.keep.prOpen', { number: w.pr.number }));
    else if (w.pr?.state === 'CLOSED') keep.push(t('worktrees.keep.prClosed', { number: w.pr.number }));
    else keep.push(w.detached ? t('worktrees.keep.detached') : t('worktrees.keep.notMerged'));
  }
  return keep;
}

/**
 * The paths tracked by a git index file (version 2 or 3), or null when only git itself should read it: version 4,
 * a required extension (split index `link`, sparse directories `sdir`), submodule or sparse-directory entries, a
 * non-SHA-1 layout, or anything that doesn't add up exactly.
 */
export function indexPaths(buf: Buffer): string[] | null {
  if (buf.length < 32 || buf.toString('latin1', 0, 4) !== 'DIRC') return null;
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) return null;
  const count = buf.readUInt32BE(8);
  const end = buf.length - 20; // SHA-1 checksum
  const paths: string[] = [];
  let off = 12;
  for (let i = 0; i < count; i++) {
    if (off + 62 > end) return null;
    const type = buf.readUInt32BE(off + 24) & 0o170000;
    if (type === 0o160000 || type === 0o040000) return null;
    const extended = (buf.readUInt16BE(off + 60) & 0x4000) !== 0;
    if (extended && version < 3) return null;
    const nameAt = off + 62 + (extended ? 2 : 0);
    const nul = buf.indexOf(0, nameAt);
    if (nul < 0 || nul >= end) return null;
    paths.push(buf.toString('utf8', nameAt, nul));
    off += (nameAt - off + (nul - nameAt) + 8) & ~7; // NUL-padded to a multiple of 8
  }
  while (off < end) {
    if (off + 8 > end) return null;
    const first = buf[off];
    if (first < 0x41 || first > 0x5a) return null; // lowercase signature: required, we don't know it
    off += 8 + buf.readUInt32BE(off + 4);
  }
  return off === end ? paths : null;
}

/**
 * Tracked paths as cached between scans: one buffer of NUL-terminated UTF-8 paths (NUL can't occur in a git path)
 * instead of ~150 k strings. Off the JS heap, so it doesn't count toward the live size V8 sizes its heap by (about 4×
 * live while a scan allocates): as strings, this cache alone lifted the heap to ~150 MB during every scan.
 */
export function packPaths(paths: string[]): Buffer {
  return Buffer.from(paths.map((p) => `${p}\0`).join(''));
}

/** The paths packPaths packed, decoded as they are iterated (iterable more than once) */
export function unpackPaths(packed: Buffer): Iterable<string> {
  return {
    *[Symbol.iterator]() {
      for (let at = 0, nul = packed.indexOf(0); nul !== -1; at = nul + 1, nul = packed.indexOf(0, at)) yield packed.toString('utf8', at, nul);
    },
  };
}

// ---- scanning ----

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

/** Working directories of every process we can see, as real paths (a deleted one is left out). */
export async function processCwds(): Promise<Map<number, string>> {
  const rows = await scanProcs(async (pid) => {
    const cwd = await readCwd(pid);
    return cwd && !cwd.deleted ? ([pid, cwd.path] as const) : null;
  });
  return new Map(rows);
}

export function pidsInside(dir: string, cwds: Map<number, string>): number[] {
  const pids: number[] = [];
  for (const [pid, cwd] of cwds) if (cwd === dir || cwd.startsWith(`${dir}/`)) pids.push(pid);
  return pids;
}

/** roots: PORTBOARD_REPOS_ROOT (comma list), else portboard.json's reposRoot, else ~/projects (site.ts) */
export async function discoverRepos(roots = SITE.reposRoots): Promise<string[]> {
  const repos: string[] = [];
  for (const root of roots) {
    for (const name of await readdir(root).catch(() => [] as string[])) {
      const dir = join(root, name);
      const st = await stat(join(dir, '.git')).catch(() => null);
      if (st?.isDirectory()) repos.push(dir);
    }
  }
  return repos.sort();
}

type PrMap = Map<string, { number: number; state: 'OPEN' | 'MERGED' | 'CLOSED'; headOid: string }>;

async function prsFor(gh: string, run: Runner): Promise<PrMap | null> {
  const r = await run('gh', ['pr', 'list', '--repo', gh, '--state', 'all', '--limit', '1000', '--json', 'number,headRefName,headRefOid,state'], 30_000);
  if (!r.ok) return null;
  const map: PrMap = new Map();
  try {
    // Newest first: the first PR for a branch name wins
    for (const p of JSON.parse(r.stdout) as { number: number; headRefName: string; headRefOid: string; state: 'OPEN' | 'MERGED' | 'CLOSED' }[]) {
      if (!map.has(p.headRefName)) map.set(p.headRefName, { number: p.number, state: p.state, headOid: p.headRefOid });
    }
  } catch {
    return null;
  }
  return map;
}

// ---- scan cache (#44) ----

/** A worktree whose signature didn't change still gets a live `git status` once its last one is this old */
export const STATUS_TTL_MS = 6 * 3600_000;
/** A worktree whose HEAD didn't change still gets a new `du` once its size is this old */
export const SIZE_TTL_MS = 24 * 3600_000;
/** …and once this old when its files changed (status signature differs) */
export const SIZE_CHANGED_TTL_MS = 3600_000;
/** At most this many TTL refreshes of each kind per incremental scan, oldest first, so they don't all land in one scan */
export const TTL_REFRESH_CAP = { status: 12, size: 20 };
/** A worktree signature with a timestamp this recent isn't trusted yet (see treeSignature) */
export const RACY_MS = 2_000;
/** More default-branch ancestry checks than this in one repo: one `git rev-list <tip>` instead of a merge-base each */
const ANCESTRY_BATCH_MIN = 4;

interface WorktreeCache {
  /** lstat signature of the index file, and the tracked paths read from it (null: only git should read it) */
  indexSig?: string;
  paths?: Buffer | null;
  /** The signature taken just before the last live `git status`, its result and when it ran */
  sig?: string;
  changes?: number;
  liveAt?: number;
  sizeKb?: number;
  sizeHead?: string | null;
  sizeAt?: number;
}

interface RepoCache {
  /** lstat signature of what `remote get-url` / `symbolic-ref origin/HEAD` / main|master read */
  metaSig: string | null;
  remote: string | null;
  defaultBranch: string | null;
  /** commit sha → committer date (%cI) */
  commits: Map<string, string>;
  /** "ancestor descendant" → definitive `merge-base --is-ancestor` result */
  ancestry: Map<string, boolean>;
  worktrees: Map<string, WorktreeCache>;
}

export interface ScanCache {
  repos: Map<string, RepoCache>;
}

export const newScanCache = (): ScanCache => ({ repos: new Map() });
const defaultCache = newScanCache();

const statSig = (s: BigIntStats) => `${s.mode}.${s.ino}.${s.size}.${s.mtimeNs}.${s.ctimeNs}`;
const lstatSig = (p: string) => lstat(p, { bigint: true }).then(statSig, () => '-');

/** Global git config and ignore files (core.excludesFile pointing elsewhere is covered by the status TTL) */
function globalSignature(): Promise<string> {
  const xdg = process.env.XDG_CONFIG_HOME || join(HOME, '.config');
  return Promise.all([join(HOME, '.gitconfig'), join(xdg, 'git', 'config'), join(xdg, 'git', 'ignore')].map(lstatSig)).then((s) => s.join('|'));
}

/** lstat calls in flight per worktree signature */
const LSTAT_BATCH = 256;

function take<T>(it: Iterator<T>, n: number): T[] {
  const out: T[] = [];
  while (out.length < n) {
    const r = it.next();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

/**
 * What `git status` of a worktree depends on, as one hash: an lstat of every tracked path (edits, deletes, type
 * changes) and of the root and every directory holding a tracked file (new untracked files and renames change the
 * directory's mtime), of `files` (index, ignore and config files), plus `extra` (HEAD). `racy`: something changed
 * within `racyMs` before the snapshot, where a second change in the same clock tick could leave the same timestamps
 * (git's "racy clean" problem), so the signature must not be trusted yet.
 */
export async function treeSignature(dir: string, paths: Iterable<string>, files: string[], extra: string, racyMs = RACY_MS): Promise<{ sig: string; racy: boolean }> {
  const dirs = new Set<string>();
  for (const p of paths) for (let i = p.lastIndexOf('/'); i > 0 && !dirs.has(p.slice(0, i)); i = p.lastIndexOf('/', i - 1)) dirs.add(p.slice(0, i));
  // Joined one batch at a time: the whole list (every tracked path of every worktree, joined) would outlive many
  // young-generation GCs and be promoted, growing the old space by ~100 MB per scan of ~150 k paths
  function* targets(): Generator<string> {
    yield* files;
    yield dir;
    for (const d of dirs) yield join(dir, d);
    for (const p of paths) yield join(dir, p);
  }
  const since = BigInt(Date.now() - racyMs) * 1_000_000n;
  let racy = false;
  const h = createHash('sha1').update(extra);
  const it = targets();
  for (let batch = take(it, LSTAT_BATCH); batch.length; batch = take(it, LSTAT_BATCH)) {
    const stats = await Promise.all(batch.map((p) => lstat(p, { bigint: true }).catch(() => null)));
    for (let k = 0; k < stats.length; k++) {
      const st = stats[k];
      if (st && (st.mtimeNs >= since || st.ctimeNs >= since)) racy = true;
      h.update(`${batch[k]}\0${st ? statSig(st) : '-'}\n`);
    }
  }
  return { sig: h.digest('hex'), racy };
}

/** The worktree's own git directory (index, HEAD): .git of the main checkout, .git/worktrees/<id> of a linked one */
async function adminDir(repo: string, wt: string): Promise<string | null> {
  if (wt === repo) return join(repo, '.git');
  const text = await readFile(join(wt, '.git'), 'utf8').catch(() => null);
  const m = text ? /^gitdir: (.+)$/m.exec(text) : null;
  return m ? resolve(wt, m[1].trim()) : null;
}

/** Worktrees whose status / size TTL ran out, oldest first, capped */
function dueRefreshes(cache: ScanCache, now: number): { status: Set<string>; size: Set<string> } {
  const status: [number, string][] = [];
  const size: [number, string][] = [];
  for (const rc of cache.repos.values()) {
    for (const [p, w] of rc.worktrees) {
      if (w.liveAt !== undefined && now - w.liveAt >= STATUS_TTL_MS) status.push([w.liveAt, p]);
      if (w.sizeAt !== undefined && now - w.sizeAt >= SIZE_TTL_MS) size.push([w.sizeAt, p]);
    }
  }
  const pick = (xs: [number, string][], n: number) => new Set(xs.sort((a, b) => a[0] - b[0]).slice(0, n).map((x) => x[1]));
  return { status: pick(status, TTL_REFRESH_CAP.status), size: pick(size, TTL_REFRESH_CAP.size) };
}

interface ScanCtx {
  run: Runner;
  mode: ScanMode;
  withSize: boolean;
  cwds: Map<number, string>;
  now: number;
  racyMs: number;
  globalSig: string;
  due: { status: Set<string>; size: Set<string> };
}

const timedOut = (r: RunResult) => !r.ok && /timed out after/.test(r.stderr);

async function scanRepo(repo: string, ctx: ScanCtx, prev: RepoCache | undefined): Promise<{ info: RepoInfo; next: RepoCache }> {
  const git = (args: string[], cwd = repo) => ctx.run('git', ['-C', cwd, ...args], 15_000);
  const common = join(repo, '.git');
  const info: RepoInfo = { name: repo.split('/').pop()!, path: repo, short: short(repo), remote: null, defaultBranch: null, worktrees: [], prsKnown: false, error: null };
  const next: RepoCache = { metaSig: null, remote: null, defaultBranch: null, commits: new Map(), ancestry: new Map(), worktrees: new Map() };
  // Without linked worktrees a repo can't be listed (only its main checkout, nothing prunable): no git at all
  if (!(await readdir(join(common, 'worktrees')).catch(() => [] as string[])).length) return { info, next };

  const listP = git(['worktree', 'list', '--porcelain']);
  const metaSig = (await Promise.all(['config', 'packed-refs', 'refs/remotes/origin/HEAD', 'refs/heads', 'refs/heads/main', 'refs/heads/master'].map((f) => lstatSig(join(common, f))))).join('|');
  if (prev && prev.metaSig === metaSig) {
    info.remote = prev.remote;
    info.defaultBranch = prev.defaultBranch;
    next.metaSig = metaSig;
  } else {
    const [remoteR, defR] = await Promise.all([git(['remote', 'get-url', 'origin']), git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])]);
    info.remote = remoteR.ok ? remoteR.stdout.trim() : null;
    info.defaultBranch = defR.ok ? defR.stdout.trim() : null;
    let flaky = timedOut(remoteR) || timedOut(defR);
    if (!info.defaultBranch) {
      for (const b of ['main', 'master']) {
        if (info.defaultBranch) break;
        const r = await git(['rev-parse', '--verify', '--quiet', b]);
        if (r.ok) info.defaultBranch = b;
        flaky ||= timedOut(r);
      }
    }
    next.metaSig = flaky ? null : metaSig;
  }
  next.remote = info.remote;
  next.defaultBranch = info.defaultBranch;

  const listR = await listP;
  if (!listR.ok) {
    info.error = listR.stderr.trim().slice(0, 200);
    return { info, next };
  }
  const entries = parsePorcelain(listR.stdout);
  const gh = info.remote ? githubRepo(info.remote) : null;
  const prsP = gh && entries.length > 1 ? prsFor(gh, ctx.run) : Promise.resolve(null);
  const live = entries.filter((e) => !e.prunable);

  // Commit dates: by sha, the misses in one `git log --no-walk`
  const heads = [...new Set(live.map((e) => e.head).filter((h): h is string => !!h && !/^0+$/.test(h)))];
  const missing: string[] = [];
  for (const h of heads) {
    const d = prev?.commits.get(h);
    if (d) next.commits.set(h, d);
    else missing.push(h);
  }
  if (missing.length) {
    const r = await git(['log', '--no-walk=unsorted', '--format=%H %cI', ...missing]);
    if (r.ok) {
      const want = new Set(missing);
      for (const line of r.stdout.split('\n')) {
        const [h, d] = line.split(' ');
        if (h && d && want.has(h)) next.commits.set(h, d);
      }
    }
  }

  // Ancestry is a fact about two commits: cache definitive answers by sha pair
  const isAncestor = async (a: string, b: string): Promise<boolean | null> => {
    const key = `${a} ${b}`;
    const known = next.ancestry.get(key) ?? prev?.ancestry.get(key);
    if (known !== undefined) {
      next.ancestry.set(key, known);
      return known;
    }
    const r = await git(['merge-base', '--is-ancestor', a, b]);
    if (r.ok || r.stderr.trim() === 'exit 1') next.ancestry.set(key, r.ok);
    return r.ok ? true : /exit 1/.test(r.stderr) ? false : null;
  };
  const linked = live.filter((e) => e.path !== repo && e.head);
  let tip: string | null = null;
  if (info.defaultBranch && linked.length) {
    const r = await git(['rev-parse', '--verify', '--quiet', `${info.defaultBranch}^{commit}`]);
    tip = r.ok ? r.stdout.trim() || null : null;
  }
  if (tip) {
    const unknown = [...new Set(linked.map((e) => e.head!))].filter((h) => !prev?.ancestry.has(`${h} ${tip}`));
    if (unknown.length >= ANCESTRY_BATCH_MIN) {
      const r = await ctx.run('git', ['-C', repo, 'rev-list', tip], 30_000);
      if (r.ok) {
        const reachable = new Set(r.stdout.split('\n'));
        for (const h of unknown) next.ancestry.set(`${h} ${tip}`, reachable.has(h));
      }
    }
  }

  const repoFiles = [join(common, 'info', 'exclude'), join(common, 'config')];
  const statusOf = async (e: PorcelainEntry, pw: WorktreeCache | undefined, nw: WorktreeCache): Promise<number | null> => {
    let sig: string | null = null;
    let racy = false;
    if (ctx.mode !== 'live') {
      const admin = await adminDir(repo, e.path);
      if (admin) {
        const indexSig = await lstatSig(join(admin, 'index'));
        let paths = pw && pw.indexSig === indexSig ? pw.paths : undefined;
        if (paths === undefined) paths = indexSig === '-' ? null : await readFile(join(admin, 'index')).then((b) => { const p = indexPaths(b); return p && packPaths(p); }, () => null);
        nw.indexSig = indexSig;
        nw.paths = paths;
        // Taken before `git status`: a change during it makes the next scan look again
        if (paths) {
          const t = await treeSignature(e.path, unpackPaths(paths), [...repoFiles, join(admin, 'index'), join(admin, 'config.worktree')], `${ctx.globalSig}|${e.head}|${e.branch}`, ctx.racyMs);
          sig = t.sig;
          racy = t.racy;
        }
      }
      if (sig && !racy && pw?.sig === sig && pw.changes !== undefined && !ctx.due.status.has(e.path)) {
        Object.assign(nw, { sig, changes: pw.changes, liveAt: pw.liveAt });
        return pw.changes;
      }
    }
    // --no-optional-locks: same output, but status doesn't rewrite the index (a write in the scanned repo);
    // GIT_NO_HOOKS: a worktree's core.fsmonitor must not run a program from portboard.service (I4)
    const st = await git(['--no-optional-locks', ...GIT_NO_HOOKS, 'status', '--porcelain'], e.path);
    const n = st.ok ? st.stdout.split('\n').filter(Boolean).length : null;
    if (sig && !racy && n !== null) Object.assign(nw, { sig, changes: n, liveAt: ctx.now });
    return n;
  };

  const prs = await prsP;
  info.prsKnown = !!prs;
  info.worktrees = await pool(entries, 6, async (e): Promise<WorktreeInfo> => {
    const main = e.path === repo;
    const pw = prev?.worktrees.get(e.path);
    const nw: WorktreeCache = {};
    let changes: number | null = null;
    let lastCommit: string | null = null;
    let mergedByAncestry: boolean | null = null;
    let sizeKb: number | null = null;
    if (!e.prunable) {
      changes = await statusOf(e, pw, nw);
      lastCommit = (e.head && next.commits.get(e.head)) || null;
      if (!lastCommit) {
        const lc = await git(['log', '-1', '--format=%cI'], e.path);
        lastCommit = lc.ok ? lc.stdout.trim() || null : null;
      }
      if (!main && info.defaultBranch && e.head) {
        if (tip) mergedByAncestry = await isAncestor(e.head, tip);
        else {
          const anc = await git(['merge-base', '--is-ancestor', e.head, info.defaultBranch]);
          mergedByAncestry = anc.ok ? true : /exit 1/.test(anc.stderr) ? false : null;
        }
      }
      if (ctx.withSize) {
        const touched = nw.sig === undefined || nw.sig !== pw?.sig;
        const stale = ctx.due.size.has(e.path) || (touched && ctx.now - (pw?.sizeAt ?? 0) >= SIZE_CHANGED_TTL_MS);
        if (pw?.sizeKb !== undefined && pw.sizeHead === e.head && !stale) {
          sizeKb = pw.sizeKb;
          Object.assign(nw, { sizeKb, sizeHead: pw.sizeHead, sizeAt: pw.sizeAt });
        } else {
          const du = await ctx.run('du', ['-sk', e.path], 60_000);
          sizeKb = du.ok ? Number(du.stdout.split(/\s/)[0]) || null : null;
          if (sizeKb !== null) Object.assign(nw, { sizeKb, sizeHead: e.head, sizeAt: ctx.now });
        }
      } else if (pw?.sizeKb !== undefined) Object.assign(nw, { sizeKb: pw.sizeKb, sizeHead: pw.sizeHead, sizeAt: pw.sizeAt });
    }
    next.worktrees.set(e.path, nw);
    const prRec = e.branch && prs ? prs.get(e.branch) : undefined;
    // The PR's head may be newer than this worktree (pushed from elsewhere, or GitHub's "update branch"): still fully
    // merged when the worktree's HEAD is part of the PR head's history. Needs the PR head commit locally; unknown → keep.
    let headMatches = !!prRec && !!e.head && prRec.headOid === e.head;
    if (prRec && e.head && !headMatches && !e.prunable) headMatches = (await isAncestor(e.head, prRec.headOid)) === true;
    const base = {
      path: e.path,
      short: short(e.path),
      head: e.head,
      branch: e.branch,
      detached: e.detached,
      main,
      locked: e.locked,
      prunable: e.prunable,
      changes,
      lastCommit,
      sizeKb,
      mergedByAncestry,
      pr: prRec ? { number: prRec.number, state: prRec.state, headMatches } : null,
      inUse: e.prunable ? [] : pidsInside(e.path, ctx.cwds),
    };
    const keep = keepReasons(base);
    return { ...base, keep, removable: !main && !e.prunable && keep.length === 0 };
  });
  return { info, next };
}

export interface ScanOptions {
  repos?: string[];
  withSize?: boolean;
  /** Default 'full' */
  mode?: ScanMode;
  cache?: ScanCache;
  run?: Runner;
  /** Clock for the TTLs (tests) */
  now?: number;
  /** See RACY_MS (tests) */
  racyMs?: number;
}

export async function scanWorktrees(opts: ScanOptions = {}): Promise<WorktreesDoc> {
  const t0 = Date.now();
  const mode = opts.mode ?? 'full';
  const cache = opts.cache ?? defaultCache;
  const now = opts.now ?? Date.now();
  const runner = opts.run ?? execRun;
  const spawns: Record<string, number> = {};
  const counted: Runner = (cmd, args, timeoutMs) => {
    spawns[cmd] = (spawns[cmd] ?? 0) + 1;
    return runner(cmd, args, timeoutMs);
  };
  const [repos, cwds, globalSig] = await Promise.all([opts.repos ? Promise.resolve(opts.repos) : discoverRepos(), processCwds(), globalSignature()]);
  const ctx: ScanCtx = {
    run: counted,
    mode,
    withSize: opts.withSize ?? true,
    cwds,
    now,
    racyMs: opts.racyMs ?? RACY_MS,
    globalSig,
    due: mode === 'incremental' ? dueRefreshes(cache, now) : { status: new Set(), size: new Set() },
  };
  const results = await pool(repos, 3, (r) => scanRepo(r, ctx, mode === 'incremental' ? cache.repos.get(r) : undefined));
  if (mode !== 'live') {
    // Only what this scan saw stays: removed worktrees, old heads and old tips drop out
    if (!opts.repos) for (const r of [...cache.repos.keys()]) if (!repos.includes(r)) cache.repos.delete(r);
    repos.forEach((r, i) => cache.repos.set(r, results[i].next));
  }
  const scanned = results.map((x) => x.info);
  const withWt = scanned.filter((r) => r.worktrees.length > 1 || r.worktrees.some((w) => w.prunable));
  const all = withWt.flatMap((r) => r.worktrees.filter((w) => !w.main));
  return {
    at: new Date().toISOString(),
    scanning: false,
    tookMs: Date.now() - t0,
    repos: withWt,
    totals: {
      repos: withWt.length,
      worktrees: all.length,
      removable: all.filter((w) => w.removable).length,
      prunable: all.filter((w) => w.prunable).length,
      removableKb: all.filter((w) => w.removable).reduce((a, w) => a + (w.sizeKb ?? 0), 0),
    },
    scan: { mode, spawns },
  };
}

// ---- actions ----

export interface RemoveResult {
  path: string;
  ok: boolean;
  message: string;
}

/** Re-scan the repo live (no cache), then `git worktree remove` (no --force) each requested path that is still removable. */
export async function removeWorktrees(repo: string, paths: string[], opts: { run?: Runner } = {}): Promise<RemoveResult[]> {
  const run = opts.run ?? execRun;
  const fresh = await scanWorktrees({ repos: [repo], withSize: false, mode: 'live', run });
  const r = fresh.repos.find((x) => x.path === repo);
  const out: RemoveResult[] = [];
  for (const p of [...new Set(paths)]) {
    const w = r?.worktrees.find((x) => x.path === p);
    if (!w) {
      out.push({ path: p, ok: false, message: t('worktrees.remove.notHere') });
      continue;
    }
    if (!w.removable) {
      out.push({ path: p, ok: false, message: t('worktrees.remove.blocked', { reasons: w.keep.join(', ') || t('worktrees.remove.unmet') }) });
      continue;
    }
    // remove runs `git status` in the worktree first: same options as the scan's (I4)
    const res = await run('git', ['-C', repo, ...GIT_NO_HOOKS, 'worktree', 'remove', p], 60_000);
    out.push({ path: p, ok: res.ok, message: res.ok ? t('worktrees.remove.done') : res.stderr.trim().slice(0, 300) });
  }
  return out;
}

/** `git worktree prune` for a repo (only drops records of worktrees whose directory is already gone). */
export async function pruneWorktrees(repo: string): Promise<{ ok: boolean; message: string }> {
  const res = await execRun('git', ['-C', repo, 'worktree', 'prune', '--verbose'], 30_000);
  return { ok: res.ok, message: (res.ok ? res.stdout || res.stderr || t('worktrees.prune.nothing') : res.stderr).trim().slice(0, 500) };
}
