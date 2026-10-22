// Machines: every machine work can run on (this one, the `portboard agent`s portboard.json lists, the cloud when on)
// with load, Claude Code sessions, checkouts and ports, and which one a task should run on (src/core/machines.ts,
// src/core/recommend.ts; docs/multi-host.md "Machines").
//
//   GET /api/machines        the list (?fresh re-reads the agents, at most once a minute)
//   GET /api/where-to-run    ?task, repo, branch, needs (comma list), prefer, exclude (comma list)
//   GET /api/find-worktree   ?repo, branch, query, machine
//   MCP machine_status, find_worktree, where_to_run (read-only, local only: the remote connector doesn't offer them)
//
// Read-only on purpose: nothing here starts a session or a server. where_to_run says where and how a person does it.

import { agents } from '../core/agents.ts';
import { devices, type Devices } from '../core/devices.ts';
import { snapshot } from '../core/index.ts';
import { buildMachines, dataAge, localStatus, type MachineStatus } from '../core/machines.ts';
import { findWorktree, NEEDS, whereToRun, type FindQuery, type Need, type RunRequest } from '../core/recommend.ts';
import { loadReservations } from '../core/reservations.ts';
import { SITE } from '../core/site.ts';
import { gate } from '../core/throttle.ts';
import { ttlCache } from '../core/cache.ts';
import type { WorktreesDoc } from '../core/worktrees.ts';
import type { Snapshot } from '../core/index.ts';
import { text } from '../mcp/kit.ts';
import { ok, reply } from './router.ts';
import type { FeatureModule, Tool } from './types.ts';
import { currentWorktrees, loadSavedWorktrees, refreshWorktrees } from './worktrees.ts';

declare module '../mcp/kit.ts' {
  interface Core {
    /** fresh: re-read the agents now (at most once a minute) */
    machines(fresh?: boolean): Promise<MachineStatus[]>;
  }
}

/** A forced agent re-read (?fresh, fresh: true) is accepted at most once per this long (as worktrees' refresh) */
export const FRESH_MIN_MS = 60_000;
const freshGate = gate({ minMs: FRESH_MIN_MS });

/**
 * This process's scan, else the server's saved one (whatever its age). With neither (no dashboard here), a background
 * scan starts and this answer has no checkouts: machine_status never waits for a scan.
 */
async function worktreesNow(): Promise<WorktreesDoc | null> {
  const cur = currentWorktrees();
  if (cur.at) return cur;
  const saved = await loadSavedWorktrees();
  if (!saved && !cur.scanning) void refreshWorktrees();
  return saved;
}

interface Sources {
  snapshot(): Promise<Snapshot>;
  devices(): Promise<Devices>;
}

async function collect(src: Sources, fresh: boolean): Promise<MachineStatus[]> {
  if (fresh && freshGate.ask(false) === 'started') agents().refresh();
  const [self, devs, reads] = await Promise.all([
    localStatus({ host: SITE.host, snapshot: src.snapshot, worktrees: worktreesNow, reservations: () => loadReservations() }),
    src.devices().catch(() => null),
    agents().get(),
  ]);
  const list = devs?.devices ?? [];
  return buildMachines({ site: SITE, self, selfId: list.find((d) => d.self)?.id ?? null, agents: reads, targets: SITE.agents, devices: list });
}

// The local sessions read is a /proc pass when the dashboard's sample is stale: reuse one list for a few seconds
const stdioMachines = ttlCache((fresh: boolean): Promise<MachineStatus[]> => collect({ snapshot, devices: () => devices() }, fresh), { ttlMs: 5_000 });

const INCLUDE = ['load', 'claude', 'worktrees', 'ports'] as const;
type Include = (typeof INCLUDE)[number];

const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const list = (v: unknown): string[] | null => {
  if (v === undefined || v === null) return [];
  const xs = typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v : null;
  if (!xs || xs.length > 16 || !xs.every((x) => typeof x === 'string')) return null;
  return xs.map((x) => (x as string).trim()).filter(Boolean);
};

export function parseRunRequest(a: Record<string, unknown>): { ok: true; value: RunRequest } | { ok: false; error: string } {
  const needs = list(a.needs);
  if (!needs || needs.some((n) => !(NEEDS as readonly string[]).includes(n))) return { ok: false, error: `needs must be a list of: ${NEEDS.join(', ')}` };
  const exclude = list(a.exclude);
  if (!exclude) return { ok: false, error: 'exclude must be a list of machine names' };
  return { ok: true, value: { task: str(a.task, 500), repo: str(a.repo), branch: str(a.branch), needs: needs as Need[], prefer: str(a.prefer), exclude } };
}

export function parseFindQuery(a: Record<string, unknown>): { ok: true; value: FindQuery } | { ok: false; error: string } {
  const q: FindQuery = { repo: str(a.repo), branch: str(a.branch), query: str(a.query), machine: str(a.machine) };
  if (!q.repo && !q.branch && !q.query) return { ok: false, error: 'give repo, branch or query' };
  return { ok: true, value: q };
}

/** No repo given: the one repo (folder or GitHub name) the task text names as a word, if exactly one does */
export function repoFromTask(task: string | undefined, machines: MachineStatus[]): string | undefined {
  if (!task) return undefined;
  const words = new Set(task.toLowerCase().split(/[^a-z0-9._-]+/).filter(Boolean));
  const repos = new Set<string>();
  for (const m of machines) for (const w of m.worktrees ?? []) if (words.has(w.repo.toLowerCase()) || (w.remote && words.has(w.remote.split('/').pop()!.toLowerCase()))) repos.add(w.repo);
  return repos.size === 1 ? [...repos][0] : undefined;
}

export function answerWhere(req: RunRequest, machines: MachineStatus[], now = Date.now()) {
  const repo = req.repo ?? repoFromTask(req.task, machines);
  const r = whereToRun({ ...req, repo }, machines, { weights: SITE.recommend.weights, now });
  return { ...(repo && !req.repo ? { repo } : {}), ...r, dataAge: dataAge(machines, now), note: 'Portboard does not start anything: open the session yourself (Desktop app SSH, cloud, Remote Control or --teleport).' };
}

/** The list with only the parts asked for (machine: one machine by name or id) */
export function shapeMachines(list: MachineStatus[], o: { machine?: string; include?: Include[] }) {
  const want = new Set<Include>(o.include?.length ? o.include : INCLUDE);
  return list
    .filter((m) => !o.machine || m.name.toLowerCase() === o.machine.toLowerCase() || m.id.toLowerCase() === o.machine.toLowerCase())
    .map((m) => ({
      ...m,
      load: want.has('load') ? m.load : undefined,
      claude: want.has('claude') ? m.claude : undefined,
      worktrees: want.has('worktrees') ? m.worktrees : undefined,
      ports: want.has('ports') ? m.ports : undefined,
    }));
}

const statusTool: Tool = {
  def: {
    name: 'machine_status',
    title: 'Machines: load, Claude sessions, worktrees',
    description:
      'Every machine work can run on: this one, the other machines running `portboard agent` (portboard.json agents), ' +
      'and the cloud when portboard.json machines.cloud.enabled is on. Per machine: kind (linux, mac, windows, wsl, ' +
      'cloud), online, when its data was read (stale after 60 s), load (cores, load1, memory, disk), Claude Code ' +
      'sessions (8-character id, project, repo@branch worktree, idle minutes, CPU, MB; active vs idle), checkouts ' +
      '(repo@branch, dirty file count, in use, Claude Code worktree, reserved port), listening port and dev server ' +
      'counts, capabilities (systemd, dev-servers, docker, macos, tags from portboard.json), maxSessions and how a ' +
      'person opens a session there (launch). The cloud has no readable state (reach none). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        machine: { type: 'string', description: 'One machine by name, e.g. mac' },
        include: { type: 'array', items: { type: 'string', enum: [...INCLUDE] }, description: 'Parts to include (default all)' },
        fresh: { type: 'boolean', description: 'Re-read the agents now (at most once a minute)' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async call(args, core) {
    const a = (args ?? {}) as Record<string, unknown>;
    const include = list(a.include);
    if (!include || include.some((x) => !(INCLUDE as readonly string[]).includes(x))) return text(`include must be a list of: ${INCLUDE.join(', ')}`, true);
    if (a.fresh !== undefined && typeof a.fresh !== 'boolean') return text('fresh must be true or false', true);
    const machines = shapeMachines(await core.machines(a.fresh === true), { machine: str(a.machine), include: include as Include[] });
    if (str(a.machine) && !machines.length) return text(`no machine named ${str(a.machine)}`, true);
    return text({ at: new Date().toISOString(), machines });
  },
};

const findTool: Tool = {
  def: {
    name: 'find_worktree',
    title: 'Where a branch is checked out',
    description:
      'Which machines have a repo or branch checked out (main checkouts and worktrees, from machine_status): per match ' +
      'the machine, repo@branch, path (when that machine shares paths), uncommitted file count, whether a process or a ' +
      'Claude Code session works there, the reserved port and last commit. repo and branch match exactly (repo also by ' +
      'its GitHub owner/name), query is a substring of repo@branch. conflict says when one branch is checked out on ' +
      'two machines and one of them has changes or an active session. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository folder name or GitHub owner/name' },
        branch: { type: 'string' },
        query: { type: 'string', description: 'Part of repo@branch, e.g. map' },
        machine: { type: 'string', description: 'Only this machine' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async call(args, core) {
    const q = parseFindQuery((args ?? {}) as Record<string, unknown>);
    if (!q.ok) return text(q.error, true);
    return text(findWorktree(q.value, await core.machines()));
  },
};

const whereTool: Tool = {
  def: {
    name: 'where_to_run',
    title: 'Which machine to run a task on',
    description:
      'Recommends the machine to run a Claude Code task on, from machine_status: excludes machines that are offline, ' +
      'have no status for 5 minutes or lack a need (macos, windows, docker, gpu, dev-server), then scores where the ' +
      'repo@branch is already checked out, conflicts (a session or process already working in that checkout, ' +
      'uncommitted changes on another machine), CPU and memory headroom, free session slots and fit (long-running → ' +
      'always-on, parallel/isolated → cloud; the Mac, the control seat, scores a little lower). Answers the ' +
      'recommendation with why, caveats and how to open the session (via, cwd, steps), up to 3 alternatives, the ' +
      'excluded machines with reasons and each machine\'s data age in seconds. Without repo, a repo named in task is ' +
      'used. It does NOT start anything: the person opens the session in the Desktop app (SSH, cloud, Remote Control ' +
      'or --teleport).',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What the task is, in a sentence' },
        repo: { type: 'string', description: 'Repository folder name or GitHub owner/name' },
        branch: { type: 'string' },
        needs: { type: 'array', items: { type: 'string', enum: [...NEEDS] } },
        prefer: { type: 'string', description: 'A machine to favour' },
        exclude: { type: 'array', items: { type: 'string' }, description: 'Machines to leave out' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async call(args, core) {
    const r = parseRunRequest((args ?? {}) as Record<string, unknown>);
    if (!r.ok) return text(r.error, true);
    return text(answerWhere(r.value, await core.machines()));
  },
};

const query = (url: URL) => Object.fromEntries([...url.searchParams.entries()].map(([k, v]) => [k, v]));

export const machinesFeature: FeatureModule = {
  name: 'machines',
  order: 350,
  routes: [
    {
      method: 'GET',
      path: '/api/machines',
      async handler({ url }, ctx) {
        const machines = await collect({ snapshot: () => ctx.snapshot(), devices: () => devices() }, url.searchParams.has('fresh'));
        return ok({ at: new Date().toISOString(), machines });
      },
    },
    {
      method: 'GET',
      path: '/api/where-to-run',
      async handler({ url }, ctx) {
        const r = parseRunRequest(query(url));
        if (!r.ok) return reply(400, { error: r.error });
        return ok(answerWhere(r.value, await collect({ snapshot: () => ctx.snapshot(), devices: () => devices() }, false)));
      },
    },
    {
      method: 'GET',
      path: '/api/find-worktree',
      async handler({ url }, ctx) {
        const q = parseFindQuery(query(url));
        if (!q.ok) return reply(400, { error: q.error });
        return ok(findWorktree(q.value, await collect({ snapshot: () => ctx.snapshot(), devices: () => devices() }, false)));
      },
    },
  ],
  tools: [statusTool, findTool, whereTool],
  mcpCore: () => ({
    machines: (fresh = false) => {
      if (fresh) stdioMachines.clear();
      return stdioMachines(fresh);
    },
  }),
};
