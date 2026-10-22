// Claude Code sessions that told us they ended (c10dev/portboard#43): the plugin's SessionEnd hook POSTs
// /api/claude/session-end, and the session id lands here. owners.ts then makes that session's servers cleanup
// candidates at once ("session-ended-hook") instead of waiting for its heuristics.
//
// And the ones that told us they started: the SessionStart hook POSTs /api/claude/session-start. A start recorded
// after a session's end (the desktop app resumes the same id in a new process) cancels that end at once, without
// waiting for the transcript to move (RESUME_GRACE_MS).
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

export interface StartedSession {
  id: string;
  cwd: string;
  /** SessionStart's source: startup, resume, clear, compact (free text, ≤ 64 chars) */
  source: string;
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
export function prune<T extends { id: string; at: string }>(list: T[], now: number): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of [...list].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
    const t = Date.parse(e.at);
    if (!Number.isFinite(t) || now - t > ENDED_TTL_MS || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
    if (out.length >= MAX_ENDED) break;
  }
  return out;
}

interface SessionsFile {
  ended: EndedSession[];
  started: StartedSession[];
}

const str = (v: unknown): v is string => typeof v === 'string';

function parse(raw: unknown): SessionsFile {
  const r = (raw ?? {}) as { ended?: unknown; started?: unknown };
  const ended = Array.isArray(r.ended) ? r.ended.filter((e): e is EndedSession => !!e && str(e.id) && str(e.cwd) && str(e.reason) && str(e.at)) : [];
  const started = Array.isArray(r.started) ? r.started.filter((e): e is StartedSession => !!e && str(e.id) && str(e.cwd) && str(e.source) && str(e.at)) : [];
  return { ended, started };
}

// Keyed by inode and size as well as mtime: every write is an atomic rename (a new inode), and on filesystems with
// coarse timestamps two writes can share an mtime.
let cache: { path: string; key: string; file: SessionsFile } | null = null;

async function loadFile(path: string, now: number): Promise<SessionsFile> {
  const st = await stat(path).catch(() => null);
  if (!st) return { ended: [], started: [] };
  const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
  if (!cache || cache.path !== path || cache.key !== key) {
    let file: SessionsFile = { ended: [], started: [] };
    try {
      file = parse(JSON.parse(await readFile(path, 'utf8')));
    } catch {
      // a broken file reads as empty; the next record rewrites it
    }
    cache = { path, key, file };
  }
  return { ended: prune(cache.file.ended, now), started: prune(cache.file.started, now) };
}

export async function loadEnded(path = endedPath(), now = Date.now()): Promise<EndedSession[]> {
  return (await loadFile(path, now)).ended;
}

export async function loadStarted(path = endedPath(), now = Date.now()): Promise<StartedSession[]> {
  return (await loadFile(path, now)).started;
}

let queue: Promise<unknown> = Promise.resolve();

function update(fn: (f: SessionsFile, at: string) => SessionsFile, now: number, path: string): Promise<SessionsFile> {
  const job = queue.then(async () => {
    const next = fn(await loadFile(path, now), new Date(now).toISOString());
    const file = { ended: prune(next.ended, now), started: prune(next.started, now) };
    await writePrivate(path, `${JSON.stringify(file, null, 2)}\n`);
    return file;
  });
  queue = job.catch(() => {});
  return job;
}

/** Adds (or refreshes) one ended session; returns the stored ended list. Writes are serialised and atomic. */
export async function recordEnded(entry: Omit<EndedSession, 'at'>, now = Date.now(), path = endedPath()): Promise<EndedSession[]> {
  return (await update((f, at) => ({ ...f, ended: [{ ...entry, at }, ...f.ended] }), now, path)).ended;
}

/** Adds (or refreshes) one started session; returns the stored started list. */
export async function recordStarted(entry: Omit<StartedSession, 'at'>, now = Date.now(), path = endedPath()): Promise<StartedSession[]> {
  return (await update((f, at) => ({ ...f, started: [{ ...entry, at }, ...f.started] }), now, path)).started;
}

export type EndedLookup = (id: string) => EndedSession | null;

/** id → its end record, unless a start was recorded after it (the session came back) */
export function lookupOf(list: EndedSession[], started: StartedSession[] = []): EndedLookup {
  const byId = new Map(list.map((e) => [e.id, e]));
  const startedAt = new Map(started.map((s) => [s.id, Date.parse(s.at)]));
  return (id) => {
    const e = byId.get(id);
    if (!e) return null;
    const back = startedAt.get(id);
    return back !== undefined && back > Date.parse(e.at) ? null : e;
  };
}

/** The record still counts: the session's transcript hasn't moved since (beyond the grace). */
export function stillEnded(e: EndedSession, lastActive: string | null): boolean {
  if (!lastActive) return true;
  return Date.parse(lastActive) <= Date.parse(e.at) + RESUME_GRACE_MS;
}
