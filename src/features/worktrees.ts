// Worktree hygiene across repositories (c10dev/portboard#36). Scans every repo under ~/projects in the background (git
// worktree list, status, merge/PR state, size, processes inside) and offers removal of the ones that can safely go.
// The 15-minute scan is incremental (#44: cached by sha and file signatures); ?refresh is a full scan, at most one
// forced per minute (docs/security-review/v1.0.md L1).
//
//   GET  /api/worktrees                    the last scan (scanning: true while one runs); ?refresh starts a full one
//                                          (refresh: started | running | throttled, with a note unless started)
//   POST /api/worktrees/remove {repo, paths}  `git worktree remove` (no --force) each still-removable path (X-Portboard)
//   POST /api/worktrees/prune {repo}         `git worktree prune` (records of deleted directories only)
//   MCP  list_worktrees (read; also remote, redacted, from the saved scan), remove_worktrees (write, local only)
//   file worktrees-state.json in the state dir: every scan's result, for the processes that don't scan themselves
//        (the remote server; the stdio server before its own first scan)
//
// Removal deletes the worktree directory (its branch stays). The dashboard asks per batch; the MCP tool tells the
// model to ask the user first.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverRepos, pruneWorktrees, removeWorktrees, scanWorktrees, type RemoveResult, type WorktreesDoc } from '../core/worktrees.ts';
import { gate, type GateState } from '../core/throttle.ts';
import { writePrivate } from '../core/atomic.ts';
import { PATHS, type Paths } from '../core/paths.ts';
import { text, type Core } from '../mcp/kit.ts';
import { redactWorktrees } from '../remote/redact.ts';
import { ok, reply } from './router.ts';
import type { FeatureModule, Tool } from './types.ts';

declare module '../mcp/kit.ts' {
  interface Core {
    worktrees(): Promise<WorktreesDoc>;
    removeWorktrees(repo: string, paths: string[]): Promise<RemoveResult[]>;
  }
}

const EMPTY: WorktreesDoc = { at: null, scanning: false, tookMs: null, repos: [], totals: { repos: 0, worktrees: 0, removable: 0, prunable: 0, removableKb: 0 } };

/** A forced full scan (?refresh, MCP refresh: true) is accepted at most once per this long (L1) */
export const FULL_MIN_MS = 60_000;

export interface WorktreesRefresher {
  /**
   * One scan at a time; callers during a scan share it. The background job scans incrementally (c10dev/portboard#44).
   * `full` trusts no cache: asked for during an incremental scan, it runs right after it. A forced full scan is
   * accepted at most once per FULL_MIN_MS (docs/security-review/v1.0.md L1); one asked for while a full scan runs
   * shares it, one asked for too soon gets the running or last scan. `state` says which happened.
   * `fresh` (after a removal or prune): an incremental scan that starts after this call — queued behind a running scan,
   * which may have read the repo before the change, and shared with one already queued. The dashboard then waits for it
   * instead of forcing a full scan per batch.
   */
  refresh(opts?: { full?: boolean; fresh?: boolean }): { state: GateState; done: Promise<WorktreesDoc> };
  current(): WorktreesDoc;
  /** What a forced refresh's answer says when it didn't start one (null when it did) */
  note(state: GateState): string | null;
}

export function createWorktreesRefresher(o: { scan?: typeof scanWorktrees; now?(): number; fullMinMs?: number } = {}): WorktreesRefresher {
  const scan = o.scan ?? scanWorktrees;
  const fullGate = gate({ minMs: o.fullMinMs ?? FULL_MIN_MS, now: o.now });
  let last: WorktreesDoc = EMPTY;
  let inflight: Promise<WorktreesDoc> | null = null;
  let inflightFull = false;
  /** The last scan in the queue has begun (a scan asked for now would not see a change made now) */
  let tailStarted = false;

  function start(full: boolean): Promise<WorktreesDoc> {
    const p: Promise<WorktreesDoc> = (inflight ?? Promise.resolve(last))
      .catch(() => last)
      .then(() => {
        if (inflight === p) tailStarted = true;
        return scan({ mode: full ? 'full' : 'incremental' });
      })
      .then((d) => (last = d))
      .catch(() => last)
      .finally(() => {
        if (inflight === p) {
          inflight = null;
          inflightFull = false;
        }
      });
    inflight = p;
    inflightFull = full;
    tailStarted = false;
    return p;
  }

  return {
    refresh(opts = {}) {
      if (opts.full !== true && opts.fresh === true && inflight && tailStarted) return { state: 'started', done: start(false) };
      if (opts.full !== true) return { state: inflight ? 'running' : 'started', done: inflight ?? start(false) };
      const state = fullGate.ask(inflightFull);
      if (state !== 'started') return { state, done: inflight ?? Promise.resolve(last) };
      return { state, done: start(true) };
    },
    current: () => ({ ...last, scanning: !!inflight }),
    note: (state) => fullGate.note(state, 'A full worktree scan'),
  };
}

/** Every scan's result, in the state dir: what the remote server's list_worktrees reads (it never scans) */
export const WORKTREES_STATE = 'worktrees-state.json';
export const savedPath = (paths: Paths = PATHS) => join(paths.stateDir, WORKTREES_STATE);
/** The stdio server takes a saved scan this young instead of scanning itself (the server scans every 15 minutes) */
export const SAVED_FRESH_MS = 60 * 60_000;

/** The last saved scan, or null when there is none or it doesn't read as one */
export async function loadSavedWorktrees(path = savedPath()): Promise<WorktreesDoc | null> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    if (typeof raw?.at !== 'string' || !Array.isArray(raw.repos) || !raw.totals || typeof raw.totals !== 'object') return null;
    return { ...(raw as WorktreesDoc), scanning: false };
  } catch {
    return null;
  }
}

/** A scan that also saves its result (a failed write is logged, never the scan's failure) */
async function scanAndSave(opts: Parameters<typeof scanWorktrees>[0]): Promise<WorktreesDoc> {
  const doc = await scanWorktrees(opts);
  await writePrivate(savedPath(), `${JSON.stringify(doc)}\n`).catch((err) => console.error(`[portboard] worktrees state: ${(err as Error).message}`));
  return doc;
}

const refresher = createWorktreesRefresher({ scan: scanAndSave });

/** The background (incremental) scan, a forced full one, or one after a change (see WorktreesRefresher.refresh) */
export function refreshWorktrees(opts: { full?: boolean; fresh?: boolean } = {}): Promise<WorktreesDoc> {
  return refresher.refresh(opts).done;
}

export function currentWorktrees(): WorktreesDoc {
  return refresher.current();
}

async function checkRepo(repo: unknown): Promise<string | null> {
  if (typeof repo !== 'string') return null;
  return (await discoverRepos()).includes(repo) ? repo : null;
}

function checkPaths(paths: unknown): string[] | null {
  if (!Array.isArray(paths) || !paths.length || paths.length > 200) return null;
  return paths.every((p) => typeof p === 'string' && p.startsWith('/') && !p.includes('\0')) ? (paths as string[]) : null;
}

async function remove(repo: string, paths: string[]): Promise<RemoveResult[]> {
  const results = await removeWorktrees(repo, paths);
  void refreshWorktrees({ fresh: true });
  return results;
}

const listTool: Tool = {
  def: {
    name: 'list_worktrees',
    title: 'Git worktrees and which can go',
    description:
      'Every git worktree of the repositories under ~/projects: branch, PR state, uncommitted changes, last commit, size, ' +
      'processes running inside, and whether it can be removed safely (merged — by ancestry or by a merged PR containing ' +
      'its HEAD — with no changes, no process inside, not locked). Optional repo filter (name). Results come from the ' +
      'last background scan (refresh: true waits for a new one).',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name, e.g. webapp' },
        refresh: { type: 'boolean', description: 'Scan now instead of using the last scan' },
        removable_only: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async call(args, core) {
    const a = (args ?? {}) as { repo?: unknown; refresh?: unknown; removable_only?: unknown };
    let note: string | null = null;
    let doc: WorktreesDoc;
    if (a.refresh === true) {
      const r = refresher.refresh({ full: true });
      note = refresher.note(r.state);
      doc = await r.done;
    } else doc = await core.worktrees();
    const repos = doc.repos
      .filter((r) => (typeof a.repo === 'string' ? r.name === a.repo : true))
      .map((r) => ({
        repo: r.name,
        path: r.path,
        worktrees: r.worktrees
          .filter((w) => !w.main && (a.removable_only === true ? w.removable : true))
          .map((w) => ({ path: w.path, branch: w.branch, pr: w.pr, changes: w.changes, lastCommit: w.lastCommit, sizeMb: w.sizeKb ? Math.round(w.sizeKb / 1024) : null, inUse: w.inUse.length, ...(w.claude ? { claude: true } : {}), removable: w.removable, keep: w.keep })),
      }));
    return text({ at: doc.at, ...(note ? { note } : {}), totals: doc.totals, repos });
  },
  remote: {
    description:
      'Git worktrees of the repositories on the Portboard server: per repository its name, then per worktree the branch, ' +
      'state (merged, unmerged, locked, missing), PR number and state, whether it has uncommitted changes, size, whether ' +
      'a process runs inside, and whether it could be removed safely, with the reasons to keep it. Counts in totals. ' +
      'From the last background scan (at; the server scans every 15 minutes). Paths, commit messages and processes are ' +
      'left out on purpose. Read-only: nothing here removes anything.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name, e.g. webapp' },
        removable_only: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    async call(args, core, policy) {
      const a = (args ?? {}) as { repo?: unknown; removable_only?: unknown; refresh?: unknown };
      if (a.refresh !== undefined) return text('refresh is not available remotely: results come from the last background scan', true);
      if (a.repo !== undefined && typeof a.repo !== 'string') return text('repo must be a repository name', true);
      if (a.removable_only !== undefined && typeof a.removable_only !== 'boolean') return text('removable_only must be true or false', true);
      if (!core.worktrees) return text('list_worktrees is not available here', true);
      const doc = await core.worktrees();
      if (!doc) return text({ at: null, note: 'No worktree scan saved yet: the Portboard server scans every 15 minutes.', repos: [] });
      return text(redactWorktrees(doc, { repo: a.repo as string | undefined, removableOnly: a.removable_only === true }, policy));
    },
  },
};

const removeTool: Tool = {
  def: {
    name: 'remove_worktrees',
    title: 'Remove git worktrees',
    description:
      'Remove worktrees with `git worktree remove` (never --force; branches are kept). Each path is re-checked and only ' +
      'removed if it is still removable (see list_worktrees). This deletes the worktree directories: ask the user first.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Main repository path, as list_worktrees reports it' },
        paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 200 },
      },
      required: ['repo', 'paths'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async call(args, core) {
    const a = (args ?? {}) as { repo?: unknown; paths?: unknown };
    const repo = await checkRepo(a.repo);
    const paths = checkPaths(a.paths);
    if (!repo) return text('repo must be one of the repositories list_worktrees reports (its main path)', true);
    if (!paths) return text('paths must be 1–200 absolute worktree paths', true);
    const results = await core.removeWorktrees(repo, paths);
    return text({ results }, results.some((r) => !r.ok));
  },
};

export const worktreesFeature: FeatureModule = {
  name: 'worktrees',
  order: 1400,
  routes: [
    {
      method: 'GET',
      path: '/api/worktrees',
      async handler({ url }) {
        if (!url.searchParams.has('refresh')) return ok(currentWorktrees());
        const r = refresher.refresh({ full: true });
        void r.done;
        const note = refresher.note(r.state);
        return ok({ ...currentWorktrees(), refresh: r.state, ...(note ? { note } : {}) });
      },
    },
    {
      method: 'POST',
      path: '/api/worktrees/remove',
      write: true,
      body: { limit: 64 * 1024 },
      async handler({ body }) {
        const repo = await checkRepo(body?.repo);
        const paths = checkPaths(body?.paths);
        if (!repo) return reply(400, { error: 'unknown repo' });
        if (!paths) return reply(400, { error: 'paths must be 1–200 absolute paths' });
        const results = await remove(repo, paths);
        return reply(results.every((r) => r.ok) ? 200 : 409, { results });
      },
    },
    {
      method: 'POST',
      path: '/api/worktrees/prune',
      write: true,
      body: { limit: 4096 },
      async handler({ body }) {
        const repo = await checkRepo(body?.repo);
        if (!repo) return reply(400, { error: 'unknown repo' });
        const r = await pruneWorktrees(repo);
        void refreshWorktrees({ fresh: true });
        return reply(r.ok ? 200 : 409, r);
      },
    },
  ],
  tools: [listTool, removeTool],
  mcpCore: () => ({
    // The scan this process made, else the server's saved one while it is recent, else a scan of its own
    worktrees: async () => {
      const cur = refresher.current();
      if (cur.at) return cur;
      const saved = await loadSavedWorktrees();
      return saved && Date.now() - Date.parse(saved.at!) < SAVED_FRESH_MS ? saved : refreshWorktrees();
    },
    removeWorktrees: remove,
  }),
  jobs: [{ name: 'worktrees-scan', everyMs: 15 * 60_000, runAtStart: true, heavy: true, run: () => refreshWorktrees() }],
};
