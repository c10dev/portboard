// Claude Code sessions that told us they ended (c10dev/portboard#43): the plugin's SessionEnd hook POSTs
// /api/claude/session-end, and the session id lands here. owners.ts then makes that session's servers cleanup
// candidates at once ("session-ended-hook") instead of waiting for its heuristics.
//
//   <stateDir>/claude-sessions.json   (override with PORTBOARD_CLAUDE_SESSIONS)
//
// A file, not memory: the stdio MCP server and the digest compute owners in their own processes and read it too.
// Bounded: the newest 200 entries, none older than 7 days.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from './paths.ts';
import { writePrivate } from './atomic.ts';

export interface EndedSession {
  id: string;
  /** The session's working directory as the hook reported it */
  cwd: string;
  /** SessionEnd's reason: clear, logout, prompt_input_exit, other, … (free text, ≤ 64 chars) */
  reason: string;
  /** When the hook reported it (ISO) */
  at: string;
}

export const MAX_ENDED = 200;
export const ENDED_TTL_MS = 7 * 24 * 60 * 60_000;
/**
 * A session whose transcript moved this long after its SessionEnd came back (the desktop app resumes the same id in a
 * new process): the record no longer counts.
 */
export const RESUME_GRACE_MS = 60_000;

export const endedPath = (): string => process.env.PORTBOARD_CLAUDE_SESSIONS ?? join(PATHS.stateDir, 'claude-sessions.json');

/** Newest first, at most MAX_ENDED, none older than ENDED_TTL_MS, one entry per id (the newest). */
export function prune(list: EndedSession[], now: number): EndedSession[] {
  const seen = new Set<string>();
  const out: EndedSession[] = [];
  for (const e of [...list].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
    const t = Date.parse(e.at);
    if (!Number.isFinite(t) || now - t > ENDED_TTL_MS || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
    if (out.length >= MAX_ENDED) break;
  }
  return out;
}

function parse(raw: unknown): EndedSession[] {
  const list = (raw as { ended?: unknown } | null)?.ended;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (e): e is EndedSession => !!e && typeof e.id === 'string' && typeof e.cwd === 'string' && typeof e.reason === 'string' && typeof e.at === 'string',
  );
}

// Keyed by inode and size as well as mtime: every write is an atomic rename (a new inode), and on filesystems with
// coarse timestamps two writes can share an mtime.
let cache: { path: string; key: string; list: EndedSession[] } | null = null;

export async function loadEnded(path = endedPath(), now = Date.now()): Promise<EndedSession[]> {
  const st = await stat(path).catch(() => null);
  if (!st) return [];
  const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
  if (!cache || cache.path !== path || cache.key !== key) {
    let list: EndedSession[] = [];
    try {
      list = parse(JSON.parse(await readFile(path, 'utf8')));
    } catch {
      // a broken file reads as empty; the next record rewrites it
    }
    cache = { path, key, list };
  }
  return prune(cache.list, now);
}

let queue: Promise<unknown> = Promise.resolve();

/** Adds (or refreshes) one session; returns the stored list. Writes are serialised and atomic. */
export function recordEnded(entry: Omit<EndedSession, 'at'>, now = Date.now(), path = endedPath()): Promise<EndedSession[]> {
  const job = queue.then(async () => {
    const list = prune([{ ...entry, at: new Date(now).toISOString() }, ...(await loadEnded(path, now))], now);
    await writePrivate(path, `${JSON.stringify({ ended: list }, null, 2)}\n`);
    return list;
  });
  queue = job.catch(() => {});
  return job;
}

export type EndedLookup = (id: string) => EndedSession | null;

export function lookupOf(list: EndedSession[]): EndedLookup {
  const byId = new Map(list.map((e) => [e.id, e]));
  return (id) => byId.get(id) ?? null;
}

/** The record still counts: the session's transcript hasn't moved since (beyond the grace). */
export function stillEnded(e: EndedSession, lastActive: string | null): boolean {
  if (!lastActive) return true;
  return Date.parse(lastActive) <= Date.parse(e.at) + RESUME_GRACE_MS;
}
