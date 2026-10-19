// Claude Code session integration (M9, c10dev/portboard#42): what the plugin's hooks ask Portboard.
//
//   GET /api/claude/port-advice?port=N&cmd=start|kill&cwd=<dir>[&tool=<what>][&session=<id>]
//       who holds or reserved the port, the port to use instead for cwd's repo@branch, and the context text the
//       PreToolUse hook adds ({ text } starts with "[portboard]"). Read-only; fast, because the hook gives up after
//       300 ms: the shared 2 s snapshot (free ports come from it too, no `ss`), reservations cached 2 s, and the cwd's
//       repo@branch cached 10 s per cwd (docs/security-review/v1.0.md L1). Names in `text` are quoted, sanitized
//       data (L4, src/core/portadvice.ts).
//
// The hooks themselves live in claude-plugin/hooks/ (docs/claude-plugin/README.md).

import { homedir } from 'node:os';
import { freePortsFrom, type Snapshot } from '../core/index.ts';
import { run } from '../core/exec.ts';
import { cachedValue, keyedCache } from '../core/throttle.ts';
import { cleanupReasons, ownerOf, REASON_TEXT, transientUnits } from '../core/owners.ts';
import { devScripts, UNIT_PREFIX } from '../core/devservers.ts';
import { loadReservations, type Reservation } from '../core/reservations.ts';
import { discoverRepos } from '../core/worktrees.ts';
import { adviceText, worktreeOfCwd, type AdviceCmd, type AdviceFacts, type Here, type Holder } from '../core/portadvice.ts';
import { eligible } from './owners.ts';
import { ok, reply } from './router.ts';
import type { FeatureModule } from './types.ts';

const HOME = homedir();
const expand = (p: string) => (p === '~' || p.startsWith('~/') ? HOME + p.slice(1) : p);

export async function holderOf(snap: Snapshot, port: number, now = Date.now()): Promise<Holder | null> {
  const p = snap.ports.find((x) => x.port === port && x.listening);
  if (!p) return null;
  const pid = p.processes[0]?.pid ?? null;
  const unit = p.control?.type === 'systemd' ? p.control.unit : (p.processes[0]?.unit ?? null);
  const owner = pid ? await ownerOf(pid) : null;
  const transient = unit && p.control?.type === 'systemd' ? await transientUnits([unit], now) : new Set<string>();
  const cleanable = eligible(p, transient);
  const reasons = cleanable && owner && !p.pinned ? cleanupReasons(owner, now) : [];
  const wt = owner?.worktree ?? null;
  return {
    name: p.name,
    pid,
    unit,
    container: p.container,
    session: owner?.session ? { id: owner.session.id, title: owner.session.title, alive: owner.session.alive } : null,
    worktree: wt ? `${wt.repoName}@${wt.branch ?? 'detached'}` : null,
    worktreePath: wt ? expand(wt.path) : null,
    devServer: !!unit?.startsWith(UNIT_PREFIX),
    cleanupReasons: reasons.map((r) => REASON_TEXT[r]),
    cleanable,
  };
}

export async function hereOf(cwd: string | null, runner: typeof run = run): Promise<Here | null> {
  if (!cwd) return null;
  const wt = await worktreeOfCwd(cwd, runner);
  if (!wt) return null;
  const [repos, scripts] = await Promise.all([discoverRepos(), devScripts(wt.path).catch(() => null)]);
  return { owner: wt.owner, path: wt.path, startable: repos.includes(wt.repoDir) && !!scripts?.preferred };
}

/** How long a cwd's repo@branch is reused, and how many cwds are kept (L1) */
export const HERE_TTL_MS = 10_000;
export const HERE_MAX = 200;

/** hereOf, cached per cwd: a loop of port-advice requests (any cwd) costs at most one git call per cwd per HERE_TTL_MS */
export function cachedHere(o: { run?: typeof run; now?(): number } = {}): (cwd: string | null) => Promise<Here | null> {
  const byCwd = keyedCache((cwd: string) => hereOf(cwd, o.run), { ttlMs: HERE_TTL_MS, max: HERE_MAX, now: o.now });
  return (cwd) => (cwd ? byCwd(cwd) : Promise.resolve(null));
}

export interface AdviceDeps {
  reservations(): Promise<Reservation[]>;
  here(cwd: string | null): Promise<Here | null>;
}

const reservationsCache = cachedValue(() => loadReservations(), { ttlMs: 2_000, freshMinMs: Infinity });
const DEPS: AdviceDeps = { reservations: () => reservationsCache.get(), here: cachedHere() };

export async function portAdvice(
  q: { port: number; cmd: AdviceCmd; cwd: string | null; tool: string | null; session: string | null },
  snap: Snapshot,
  deps: AdviceDeps = DEPS,
): Promise<AdviceFacts & { text: string }> {
  const [holder, reservations, here] = await Promise.all([holderOf(snap, q.port), deps.reservations(), deps.here(q.cwd)]);
  const r = reservations.find((x) => x.port === q.port);
  let suggestion: AdviceFacts['suggestion'] = null;
  if (q.cmd === 'start') {
    // from the same snapshot: no `ss` / `tailscale serve status` per request
    const [s] = freePortsFrom(snap, reservations, 1, undefined, here?.owner ?? null);
    if (s) suggestion = { port: s, reserved: reservations.some((x) => x.port === s && x.owner === here?.owner) };
  }
  const facts: AdviceFacts = {
    port: q.port,
    cmd: q.cmd,
    tool: q.tool,
    session: q.session,
    holder,
    reservation: r ? { owner: r.owner, ...(r.note ? { note: r.note } : {}) } : null,
    here,
    suggestion,
  };
  return { ...facts, text: adviceText(facts) };
}

/** Query parameters, checked: a bad one is a 400, never a guess. */
export function parseAdviceQuery(url: URL): { ok: true; value: Parameters<typeof portAdvice>[0] } | { ok: false; error: string } {
  const sp = url.searchParams;
  const port = Number(sp.get('port'));
  if (!/^\d{1,5}$/.test(sp.get('port') ?? '') || port < 1 || port > 65535) return { ok: false, error: 'port must be 1–65535' };
  const cmd = sp.get('cmd') ?? 'start';
  if (cmd !== 'start' && cmd !== 'kill') return { ok: false, error: 'cmd must be start or kill' };
  const cwd = sp.get('cwd');
  if (cwd !== null && (!cwd.startsWith('/') || cwd.length > 4096 || /[\0\n]/.test(cwd))) return { ok: false, error: 'cwd must be an absolute path' };
  const tool = sp.get('tool')?.slice(0, 60).replace(/[\0-\x1f]/g, '') || null;
  const session = sp.get('session');
  if (session !== null && !/^[0-9a-zA-Z-]{1,64}$/.test(session)) return { ok: false, error: 'session must be a session id' };
  return { ok: true, value: { port, cmd, cwd, tool, session } };
}

export const claudeFeature: FeatureModule = {
  name: 'claude',
  routes: [
    {
      method: 'GET',
      path: '/api/claude/port-advice',
      async handler({ url }, ctx) {
        const q = parseAdviceQuery(url);
        if (!q.ok) return reply(400, { error: q.error });
        return ok(await portAdvice(q.value, await ctx.snapshot()));
      },
    },
  ],
};
