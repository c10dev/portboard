// 세션 종료 정리 (c10dev/portboard#43): the Claude Code plugin's SessionEnd hook (claude-plugin/hooks/session-end.ts)
// tells Portboard a session ended, so the servers it started become cleanup candidates at once ("session-ended-hook",
// src/core/owners.ts) and, when the user opted in, are stopped.
//
//   POST /api/claude/session-end {session_id, cwd, reason}   X-Portboard + loopback only (never via tailscale serve)
//   POST /api/claude/session-start {session_id, cwd, source}  the same; a start after an end cancels that end
//   GET  /api/claude/sessions                                recent ended sessions, the autoStop setting, last auto-stop
//   POST /api/claude/settings {autoStop}                     'off' (default) | 'scratchpad' | 'all'
//
// Auto-stop goes through the existing cleanup path (cleanupPorts: re-check, SIGTERM / `systemctl --user stop`), so it
// never reaches installed systemd services, docker, pinned ports, other users' processes or Portboard. With
// 'scratchpad' only servers running from a Claude scratchpad, or transient pb-sd-/pb-dev- units, of that session are
// stopped. Reason `clear` (/clear: the Claude process keeps running) never auto-stops. Reservations are left alone.

import { readFile, readlink } from 'node:fs/promises';
import { snapshot as liveSnapshot, type Snapshot } from '../core/index.ts';
import { loadEnded, recordEnded, recordStarted, type EndedSession, type StartedSession } from '../core/claude-sessions.ts';
import { AUTO_STOP, loadPrefs, setClaudeCleanup, type AutoStop } from '../core/prefs.ts';
import { PATHS } from '../core/paths.ts';
import { localOnly } from '../core/access.ts';
import { cleanupPorts, ownersOf, type OwnedPort, type OwnersDoc } from './owners.ts';
import { ok, reply } from './router.ts';
import type { FeatureModule } from './types.ts';

// A local process talking to us directly, never one proxied by tailscale serve/funnel (src/core/access.ts, shared with
// the owner check of every write).
export { localOnly };

export interface SessionEndInput {
  id: string;
  cwd: string;
  reason: string;
}

/** The hook's JSON (extra fields such as transcript_path are ignored), or what is wrong with it. */
export function checkSessionEnd(body: unknown): SessionEndInput | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be an object';
  const b = body as Record<string, unknown>;
  if (typeof b.session_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(b.session_id)) return 'session_id must be a session id';
  if (b.cwd !== undefined && (typeof b.cwd !== 'string' || b.cwd.length > 4096)) return 'cwd must be a path';
  if (b.reason !== undefined && (typeof b.reason !== 'string' || !/^[A-Za-z0-9_-]{0,64}$/.test(b.reason))) return 'reason must be a short word';
  return { id: b.session_id, cwd: (b.cwd as string | undefined) ?? '', reason: (b.reason as string | undefined) || 'other' };
}

/** SessionStart's JSON: the same id and cwd rules as SessionEnd, `source` instead of `reason` */
export function checkSessionStart(body: unknown): Omit<StartedSession, 'at'> | string {
  const e = checkSessionEnd(body && typeof body === 'object' && !Array.isArray(body) ? { ...body, reason: (body as Record<string, unknown>).source } : body);
  if (typeof e === 'string') return e === 'reason must be a short word' ? 'source must be a short word' : e;
  return { id: e.id, cwd: e.cwd, source: e.reason };
}

const TRANSIENT_OURS = /^pb-(sd|dev)-/;

/**
 * Which of `doc`'s servers the auto-stop may stop for this ended session: candidates for the hook reason, owned by that
 * session, and — with 'scratchpad' — running from its scratchpad or as a pb-sd-/pb-dev- transient unit.
 */
export function autoStopTargets(doc: OwnersDoc, sessionId: string, mode: AutoStop, reason: string): OwnedPort[] {
  if (mode === 'off' || reason === 'clear') return [];
  return doc.ports.filter((row) => {
    if (row.owner.session?.id !== sessionId || !row.reasons.includes('session-ended-hook')) return false;
    if (row.port === PATHS.port) return false;
    return mode === 'all' || row.owner.scratchpad || (row.unit !== null && TRANSIENT_OURS.test(row.unit));
  });
}

/** A Portboard (a preview from a worktree or scratchpad looks like any other process to production). */
async function isPortboard(pid: number): Promise<boolean> {
  const [cmd, cwd] = await Promise.all([readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => ''), readlink(`/proc/${pid}/cwd`).catch(() => '')]);
  return /\bsrc\/(server|remote|mcp)\.ts\b/.test(cmd) && /portboard/i.test(`${cmd}\0${cwd}`);
}

export interface AutoStopRun {
  session: string;
  reason: string;
  mode: AutoStop;
  at: string;
  results: { port: number; ok: boolean; message: string }[];
}

let lastRun: AutoStopRun | null = null;

export interface AutoStopDeps {
  snapshot(): Promise<Snapshot>;
  mode(): Promise<AutoStop>;
  owners(snap: Snapshot): Promise<OwnersDoc>;
  cleanup(ports: number[], snap: Snapshot): Promise<AutoStopRun['results']>;
  isPortboard(pid: number): Promise<boolean>;
}

const liveDeps: AutoStopDeps = {
  snapshot: () => liveSnapshot(),
  mode: async () => (await loadPrefs()).claudeCleanup?.autoStop ?? 'off',
  owners: (snap) => ownersOf(snap),
  cleanup: (ports, snap) => cleanupPorts(ports, snap),
  isPortboard,
};

/** Stops what the setting allows for one ended session (nothing with 'off'); the run is kept for GET /api/claude/sessions. */
export async function autoStop(e: SessionEndInput, deps: AutoStopDeps = liveDeps): Promise<AutoStopRun> {
  const mode = await deps.mode();
  const run: AutoStopRun = { session: e.id, reason: e.reason, mode, at: new Date().toISOString(), results: [] };
  if (mode !== 'off' && e.reason !== 'clear') {
    const snap = await deps.snapshot();
    const targets = [];
    for (const row of autoStopTargets(await deps.owners(snap), e.id, mode, e.reason)) if (!(await deps.isPortboard(row.pid))) targets.push(row.port);
    if (targets.length) run.results = await deps.cleanup(targets, snap);
  }
  lastRun = run;
  return run;
}

const short = (e: EndedSession) => ({ id: e.id, reason: e.reason, at: e.at, cwd: e.cwd });

export const claudeSessionFeature: FeatureModule = {
  name: 'claude-session',
  order: 2200,
  routes: [
    {
      method: 'POST',
      path: '/api/claude/session-end',
      write: true,
      body: { limit: 8192 },
      async handler({ body, req }, ctx) {
        if (!localOnly(req)) return reply(403, { error: 'loopback only' });
        const e = checkSessionEnd(body);
        if (typeof e === 'string') return reply(400, { error: e });
        await recordEnded(e);
        ctx.invalidate('snapshot');
        const mode = (await loadPrefs()).claudeCleanup?.autoStop ?? 'off';
        // The hook waits 500 ms at most: answer now, stop in the background.
        if (mode !== 'off' && e.reason !== 'clear') {
          autoStop(e, { ...liveDeps, snapshot: () => ctx.snapshot(true) })
            .catch((err) => console.error(`[portboard] session-end auto-stop: ${err?.message ?? err}`))
            .finally(() => ctx.invalidate('snapshot'));
        }
        return ok({ recorded: true, autoStop: e.reason === 'clear' ? 'off' : mode });
      },
    },
    {
      method: 'POST',
      path: '/api/claude/session-start',
      write: true,
      body: { limit: 8192 },
      async handler({ body, req }) {
        if (!localOnly(req)) return reply(403, { error: 'loopback only' });
        const e = checkSessionStart(body);
        if (typeof e === 'string') return reply(400, { error: e });
        await recordStarted(e);
        return ok({ recorded: true });
      },
    },
    {
      method: 'GET',
      path: '/api/claude/sessions',
      async handler() {
        const [ended, prefs] = await Promise.all([loadEnded(), loadPrefs()]);
        return ok({ ended: ended.slice(0, 20).map(short), settings: { autoStop: prefs.claudeCleanup?.autoStop ?? 'off' }, lastAutoStop: lastRun });
      },
    },
    {
      method: 'POST',
      path: '/api/claude/settings',
      write: true,
      body: { limit: 1024 },
      async handler({ body }) {
        const v = (body as { autoStop?: unknown } | null)?.autoStop;
        if (!AUTO_STOP.includes(v as AutoStop)) return reply(400, { error: `autoStop must be one of ${AUTO_STOP.join(', ')}` });
        return ok({ settings: await setClaudeCleanup(v as AutoStop) });
      },
    },
  ],
};
