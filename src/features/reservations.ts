// Port reservations (c10dev/portboard#27). A project or worktree keeps its port across restarts; free_port never
// offers someone else's reserved port.
//
//   GET  /api/reservations                       reservations with what listens on each port now
//   POST /api/reservations {owner, port?, note?}  reserve (without port: the owner's existing one, else a free one)
//   POST /api/reservations/:port/release
//   MCP  list_reservations (read), reserve_port, release_port (local only)

import { freePorts, snapshot, type Snapshot } from '../core/index.ts';
import { loadReservations, normalizeOwner, release, reserve, type ReleaseResult, type Reservation, type ReserveResult } from '../core/reservations.ts';
import { parseOptionalInt, parsePort, text, type Core } from '../mcp/kit.ts';
import { ok, reply } from './router.ts';
import type { FeatureModule, Tool } from './types.ts';

export interface ReservationStatus extends Reservation {
  /** What listens on the port now: name, project/worktree of the process, and whether it looks like the owner's */
  listening: { name: string; project: string | null; matchesOwner: boolean | null } | null;
}

declare module '../mcp/kit.ts' {
  interface Core {
    reservations(): Promise<ReservationStatus[]>;
    reservePort(owner: string, port?: number, note?: string): Promise<ReserveResult>;
    releasePort(port: number, owner: string): Promise<ReleaseResult>;
  }
}

/** A loose match: the owner text mentions the listening process's project folder (repo or worktree name). */
export function matchesOwner(owner: string, project: string | null): boolean | null {
  if (!project) return null;
  const o = owner.toLowerCase();
  const parts = project.toLowerCase().split('/').filter(Boolean);
  return parts.some((p) => p.length > 2 && (o.includes(p) || p.includes(o.split('@')[0])));
}

export async function reservationStatus(snap: Snapshot): Promise<ReservationStatus[]> {
  const list = await loadReservations();
  return list.map((r) => {
    const p = snap.ports.find((x) => x.port === r.port && x.listening);
    const project = p?.processes[0]?.project ?? null;
    return { ...r, listening: p ? { name: p.name, project, matchesOwner: matchesOwner(r.owner, project) } : null };
  });
}

const pickOne = async () => (await freePorts(1))[0];

async function doReserve(ownerRaw: unknown, portRaw: unknown, noteRaw: unknown): Promise<ReserveResult | { ok: false; error: string; status: number }> {
  const owner = normalizeOwner(ownerRaw);
  if (!owner) return { ok: false, error: 'owner must be 1–120 characters (a repo name, repo@branch or worktree path)', status: 400 };
  let port: number | undefined;
  if (portRaw !== undefined && portRaw !== null) {
    const p = parsePort({ port: portRaw });
    if (!p.ok || p.value < 1024) return { ok: false, error: 'port must be an integer 1024–65535', status: 400 };
    port = p.value;
  }
  const note = typeof noteRaw === 'string' ? noteRaw.trim() || undefined : undefined;
  return reserve(owner, port, note, pickOne);
}

const listTool: Tool = {
  def: {
    name: 'list_reservations',
    title: 'Reserved ports',
    description: 'Ports reserved for a project or worktree (owner, note, since when) and what is listening on each right now.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async call(_args, core) {
    return text({ reservations: await core.reservations() });
  },
};

const reserveTool: Tool = {
  def: {
    name: 'reserve_port',
    title: 'Reserve a port for a project',
    description:
      'Give a project or worktree a stable port: without `port`, returns the owner\'s existing reservation or reserves ' +
      'a free one. Afterwards free_port with `for: <owner>` returns it first and never offers it to anyone else. Use ' +
      'it when starting a dev server that should keep its port across restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repo name, repo@branch or worktree path' },
        port: { type: 'integer', minimum: 1024, maximum: 65535 },
        note: { type: 'string' },
      },
      required: ['owner'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async call(args, core) {
    const a = (args ?? {}) as { owner?: unknown; port?: unknown; note?: unknown };
    const owner = normalizeOwner(a.owner);
    if (!owner) return text('owner must be 1–120 characters', true);
    const port = a.port === undefined ? undefined : parsePort({ port: a.port });
    if (port && (!port.ok || port.value < 1024)) return text('port must be an integer 1024–65535', true);
    const r = await core.reservePort(owner, port?.ok ? port.value : undefined, typeof a.note === 'string' ? a.note : undefined);
    return text(r, !r.ok);
  },
};

const releaseTool: Tool = {
  def: {
    name: 'release_port',
    title: 'Release a reserved port',
    description:
      'Remove your reservation of a port so free_port may offer it again. `owner` must be the owner it was reserved ' +
      'for (see list_reservations); another owner\'s reservation stays. Does not stop anything.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        owner: { type: 'string', description: 'The owner the port was reserved for, exactly as list_reservations shows it' },
      },
      required: ['port', 'owner'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async call(args, core) {
    const p = parsePort(args);
    if (!p.ok) return text(p.error, true);
    const owner = normalizeOwner((args as { owner?: unknown } | undefined)?.owner);
    if (!owner) return text('owner must be 1–120 characters', true);
    const r = await core.releasePort(p.value, owner);
    if (r.heldBy) return text(`${p.value} is reserved for ${r.heldBy}, not ${owner}`, true);
    return text(r, !r.ok);
  },
};

export const reservationsFeature: FeatureModule = {
  name: 'reservations',
  order: 1500,
  routes: [
    {
      method: 'GET',
      path: '/api/reservations',
      async handler(_r, ctx) {
        return ok({ reservations: await reservationStatus(await ctx.snapshot()) });
      },
    },
    {
      method: 'POST',
      path: '/api/reservations',
      write: true,
      body: { limit: 4096 },
      async handler({ body }) {
        const r = await doReserve(body?.owner, body?.port, body?.note);
        if (!r.ok) return reply('status' in r ? r.status : 409, { error: r.error });
        return reply(r.existing ? 200 : 201, r);
      },
    },
    {
      method: 'POST',
      path: '/api/reservations/:port/release',
      write: true,
      async handler({ params }) {
        const r = await release(params.port, null);
        return reply(r.ok ? 200 : 404, r.ok ? r : { error: `${params.port} is not reserved` });
      },
    },
  ],
  tools: [listTool, reserveTool, releaseTool],
  mcpCore: () => ({
    reservations: async () => reservationStatus(await snapshot()),
    reservePort: async (owner: string, port?: number, note?: string) => {
      const r = await doReserve(owner, port, note);
      return r.ok ? r : { ok: false as const, error: r.error };
    },
    releasePort: (port: number, owner: string) => release(port, owner),
  }),
};
