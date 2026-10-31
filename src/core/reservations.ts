// Port reservations (c10dev/portboard#27): a stable port per project or worktree, so a dev server restarted tomorrow
// gets the same port and free_port never hands it to someone else.
//
//   ~/.config/portboard/reservations.json   { version: 1, reservations: [{ port, owner, note?, createdAt }] }
//
// An owner is free text, normally a repo name ("shop-web") or repo@branch / a worktree path. A port has at most one
// owner; an owner may hold several ports.

import { readFile } from 'node:fs/promises';
import { PATHS } from './paths.ts';
import { writePrivate } from './atomic.ts';

export interface Reservation {
  port: number;
  owner: string;
  note?: string;
  createdAt: string;
}

interface File {
  version: 1;
  reservations: Reservation[];
}

export const OWNER_MAX = 120;

export function normalizeOwner(owner: unknown): string | null {
  if (typeof owner !== 'string') return null;
  const o = owner.trim().replace(/\s+/g, ' ');
  return o && o.length <= OWNER_MAX ? o : null;
}

/**
 * The reservations in the file. A missing file is an empty list. A file that cannot be read or parsed throws:
 * an empty list would let free_port offer reserved ports, and the next write would replace the file.
 */
export async function loadReservations(path = PATHS.reservations): Promise<Reservation[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`cannot read reservations.json (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  let raw: Partial<File> | null;
  try {
    raw = JSON.parse(text) as Partial<File> | null;
  } catch (e) {
    throw new Error(`cannot parse reservations.json: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.reservations)) throw new Error('reservations.json has no reservations list');
  return raw.reservations.filter((r): r is Reservation => Number.isInteger(r?.port) && typeof r?.owner === 'string');
}

let queue: Promise<unknown> = Promise.resolve();

async function update<T>(fn: (list: Reservation[]) => { list: Reservation[]; result: T }, path = PATHS.reservations): Promise<T> {
  const job = queue.then(async () => {
    const { list, result } = fn(await loadReservations(path));
    const body: File = { version: 1, reservations: [...list].sort((a, b) => a.port - b.port) };
    await writePrivate(path, `${JSON.stringify(body, null, 2)}\n`);
    return result;
  });
  queue = job.catch(() => {});
  return job;
}

export type ReserveResult = { ok: true; reservation: Reservation; existing: boolean } | { ok: false; error: string };

/**
 * Reserve `port` for `owner`, or, without a port, return the owner's existing reservation or the first free port
 * (`pick`, which already avoids listening, served and reserved ports).
 */
export async function reserve(owner: string, port: number | undefined, note: string | undefined, pick: () => Promise<number | undefined>, path = PATHS.reservations): Promise<ReserveResult> {
  const chosen = port ?? ((await loadReservations(path)).find((r) => r.owner === owner)?.port ?? (await pick()));
  if (!chosen) return { ok: false, error: 'no free port found' };
  return update<ReserveResult>((list) => {
    const held = list.find((r) => r.port === chosen);
    if (held && held.owner !== owner) return { list, result: { ok: false, error: `${chosen} is reserved for ${held.owner}` } };
    if (held) return { list, result: { ok: true, reservation: held, existing: true } };
    const r: Reservation = { port: chosen, owner, ...(note ? { note: note.slice(0, 200) } : {}), createdAt: new Date().toISOString() };
    return { list: [...list, r], result: { ok: true, reservation: r, existing: false } };
  }, path);
}

export interface ReleaseResult {
  ok: boolean;
  released: Reservation | null;
  /** Set when `owner` was given and the port is reserved for someone else: nothing was released */
  heldBy?: string;
}

/**
 * Remove the reservation of `port`. With `owner`, only that owner's reservation goes; another owner's stays and
 * comes back as `heldBy`. Without it (the dashboard's button, a person), any reservation of the port goes.
 */
export async function release(port: number, owner: string | null, path = PATHS.reservations): Promise<ReleaseResult> {
  return update<ReleaseResult>((list) => {
    const r = list.find((x) => x.port === port) ?? null;
    if (r && owner !== null && r.owner !== owner) return { list, result: { ok: false, released: null, heldBy: r.owner } };
    return { list: list.filter((x) => x.port !== port), result: { ok: !!r, released: r } };
  }, path);
}

/** Ports free_port must not offer (reserved for someone other than `forOwner`), and the owner's own ports first. */
export function reservedFor(list: Reservation[], forOwner?: string | null): { blocked: Set<number>; own: number[] } {
  const blocked = new Set<number>();
  const own: number[] = [];
  for (const r of list) {
    if (forOwner && r.owner === forOwner) own.push(r.port);
    else blocked.add(r.port);
  }
  return { blocked, own: own.sort((a, b) => a - b) };
}
