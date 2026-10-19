// Owners and cleanup (c10dev/portboard#25, #26): which Claude session and git worktree each plain-process server
// belongs to, and which ones are left over (working directory deleted, starting session ended, branch merged).
//
//   GET  /api/owners                 owners of every listening plain process + cleanup candidates
//   POST /api/cleanup {ports: [...]} stop the listed candidates (X-Portboard); each port is re-checked first
//   MCP  list_cleanup_candidates (read), cleanup_servers (write, local only)
//
// Candidates are plain processes and transient systemd units (systemd-run); installed units, docker containers, other
// users' processes and pinned ports never are. Stopping is the existing stop action (SIGTERM or `systemctl --user stop`
// for a transient unit, quiet for the down-alert checker).

import { snapshot, stop, type PortEntry, type Snapshot } from '../core/index.ts';
import { quietly } from '../core/alerts.ts';
import { loadEnded, lookupOf } from '../core/claude-sessions.ts';
import { cleanupReasons, ownerOf, REASON_TEXT, transientUnits, type CleanupReason, type Owner } from '../core/owners.ts';
import { text, type Core } from '../mcp/kit.ts';
import { ok, reply } from './router.ts';
import type { FeatureModule, Tool } from './types.ts';

export interface OwnedPort {
  port: number;
  name: string;
  pid: number;
  /** A transient systemd unit (systemd-run) when the server runs as one */
  unit: string | null;
  owner: Owner;
  reasons: CleanupReason[];
  reasonText: string[];
}

export interface OwnersDoc {
  at: string;
  ports: OwnedPort[];
  /** ports whose reasons are non-empty, in port order */
  candidates: number[];
}

declare module '../mcp/kit.ts' {
  interface Core {
    owners(): Promise<OwnersDoc>;
    cleanup(ports: number[]): Promise<{ port: number; ok: boolean; message: string }[]>;
  }
}

const quietStop = quietly(stop);

/**
 * Servers that can be cleanup candidates: plain processes we own, and transient systemd units (systemd-run, as Claude
 * sessions start previews and test services). Never installed units, containers, other users' processes or Portboard.
 */
export function eligible(p: PortEntry, transient: Set<string> = new Set()): boolean {
  if (!p.listening || !p.owned || p.container || !p.canStop) return false;
  if (p.control?.type === 'process') return true;
  return p.control?.type === 'systemd' && transient.has(p.control.unit);
}

export async function ownersOf(snap: Snapshot, now = Date.now()): Promise<OwnersDoc> {
  const units = snap.ports.flatMap((p) => (p.control?.type === 'systemd' ? [p.control.unit] : []));
  const transient = units.length ? await transientUnits(units, now) : new Set<string>();
  const ended = lookupOf(await loadEnded(undefined, now).catch(() => []));
  const ports: OwnedPort[] = [];
  const seen = new Map<number, Owner | null>();
  for (const p of snap.ports) {
    if (!eligible(p, transient)) continue;
    const pid = p.processes[0]?.pid;
    if (!pid) continue;
    if (!seen.has(pid)) seen.set(pid, await ownerOf(pid));
    const owner = seen.get(pid);
    if (!owner) continue;
    const reasons = p.pinned ? [] : cleanupReasons(owner, now, ended);
    const unit = p.control?.type === 'systemd' ? p.control.unit : null;
    ports.push({ port: p.port, name: p.name, pid, unit, owner, reasons, reasonText: reasons.map((r) => REASON_TEXT[r]) });
  }
  return { at: new Date(now).toISOString(), ports, candidates: ports.filter((x) => x.reasons.length).map((x) => x.port) };
}

export async function cleanupPorts(requested: number[], snap: Snapshot): Promise<{ port: number; ok: boolean; message: string }[]> {
  const doc = await ownersOf(snap);
  const out: { port: number; ok: boolean; message: string }[] = [];
  const stoppedPids = new Set<number>();
  for (const port of [...new Set(requested)]) {
    const row = doc.ports.find((x) => x.port === port);
    if (!row || !row.reasons.length) {
      out.push({ port, ok: false, message: '정리 후보가 아니에요 (다시 확인한 결과)' });
      continue;
    }
    if (stoppedPids.has(row.pid)) {
      out.push({ port, ok: true, message: `같은 프로세스(pid ${row.pid})를 이미 중지했어요` });
      continue;
    }
    const r = await quietStop(port);
    if (r.ok) stoppedPids.add(row.pid);
    out.push({ port, ok: r.ok, message: r.message });
  }
  return out;
}

function parsePorts(args: unknown): number[] | string {
  const raw = (args as { ports?: unknown } | null)?.ports;
  if (!Array.isArray(raw) || !raw.length || raw.length > 50) return 'ports must be a non-empty list (at most 50)';
  const ports = raw.map((x) => (typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : x));
  if (!ports.every((x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 65535)) return 'ports must be integers 1–65535';
  return ports;
}

const listTool: Tool = {
  def: {
    name: 'list_cleanup_candidates',
    title: 'Leftover servers to clean up',
    description:
      'Dev servers on this machine with their owner: the Claude Code session that started them (title, still running or ' +
      'not) and the git worktree/branch they run from. Candidates are servers whose working directory was deleted, ' +
      'whose starting session ended, or whose branch is already merged. Use it before cleanup_servers, and show the ' +
      'user the list.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async call(_args, core) {
    const doc = await core.owners();
    return text({
      candidates: doc.ports
        .filter((x) => x.reasons.length)
        .map((x) => ({ port: x.port, name: x.name, pid: x.pid, reasons: x.reasonText, session: x.owner.session?.title ?? x.owner.session?.id ?? null, worktree: x.owner.worktree ? `${x.owner.worktree.repoName}@${x.owner.worktree.branch}` : null })),
      kept: doc.ports.filter((x) => !x.reasons.length).map((x) => ({ port: x.port, name: x.name, session: x.owner.session?.title ?? null, sessionAlive: x.owner.session?.alive ?? null, worktree: x.owner.worktree ? `${x.owner.worktree.repoName}@${x.owner.worktree.branch}` : null })),
    });
  },
};

const cleanupTool: Tool = {
  def: {
    name: 'cleanup_servers',
    title: 'Stop leftover servers',
    description:
      'Stop (SIGTERM) leftover dev servers by port. Each port is re-checked and only stopped if it is still a cleanup ' +
      'candidate (see list_cleanup_candidates). Ask the user before calling this.',
    inputSchema: {
      type: 'object',
      properties: { ports: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 65535 }, minItems: 1, maxItems: 50 } },
      required: ['ports'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async call(args, core) {
    const ports = parsePorts(args);
    if (typeof ports === 'string') return text(ports, true);
    const results = await core.cleanup(ports);
    return text({ results }, results.some((r) => !r.ok));
  },
};

export const ownersFeature: FeatureModule = {
  name: 'owners',
  routes: [
    {
      method: 'GET',
      path: '/api/owners',
      async handler(_r, ctx) {
        return ok(await ownersOf(await ctx.snapshot()));
      },
    },
    {
      method: 'POST',
      path: '/api/cleanup',
      write: true,
      body: { limit: 4096 },
      async handler({ body }, ctx) {
        const ports = parsePorts(body);
        if (typeof ports === 'string') return reply(400, { error: ports });
        const results = await cleanupPorts(ports, await ctx.snapshot(true));
        ctx.invalidate('snapshot');
        return reply(results.every((r) => r.ok) ? 200 : 409, { results });
      },
    },
  ],
  tools: [listTool, cleanupTool],
  mcpCore: () => ({
    owners: async () => ownersOf(await snapshot()),
    cleanup: async (ports: number[]) => cleanupPorts(ports, await snapshot()),
  }),
  ui: [{ pages: ['index.html'], script: 'features/owners.js' }],
};
