// Start/stop a worktree's dev server (c10dev/portboard#28).
//
//   GET  /api/dev-servers                         running pb-dev-* units, and which known worktrees can be started
//   POST /api/dev-servers/start {path, script?, port?}   (X-Portboard)
//   POST /api/dev-servers/stop  {path}                   (X-Portboard)
//   POST /api/dev-servers/launch-config {path, script?, mode?}   (X-Portboard)
//   MCP  list_dev_servers (also remote, redacted: no paths, units or commands), start_dev_server, stop_dev_server,
//        write_launch_config (local only)
//
// Only worktrees/main checkouts of the repos Portboard scans, only package.json scripts (dev, start, preview, serve).
// The port is the worktree's reservation (owner "<repo>@<branch>"), or a free one that then gets reserved.

import { freePorts } from '../core/index.ts';
import { run } from '../core/exec.ts';
import { devScripts, frameworkOf, hasScript, listDevServers, planStart, startUnit, stopUnit, unitFor, type DevScripts, type DevServer } from '../core/devservers.ts';
import { launchEntry, writeLaunch, type LaunchEntry, type LaunchMode } from '../core/launchjson.ts';
import { loadReservations, reserve } from '../core/reservations.ts';
import { readOnlyRefusal } from '../core/control.ts';
import { platform } from '../core/platform/index.ts';
import { services } from '../core/platform/services.ts';
import { discoverRepos, parsePorcelain } from '../core/worktrees.ts';
import { text, type Core } from '../mcp/kit.ts';
import { redactDevServers } from '../remote/redact.ts';
import { ok, reply } from './router.ts';
import type { FeatureModule, Tool } from './types.ts';
import { t } from '../core/i18n.ts';

export interface KnownDir {
  path: string;
  repo: string;
  branch: string | null;
  owner: string;
}

declare module '../mcp/kit.ts' {
  interface Core {
    devServers(): Promise<DevServersDoc>;
    startDevServer(path: string, script?: string, port?: number): Promise<{ ok: boolean; message: string; port?: number; unit?: string }>;
    stopDevServer(path: string): Promise<{ ok: boolean; message: string }>;
    writeLaunchConfig(path: string, script?: string, mode?: LaunchMode): Promise<LaunchConfigResult>;
  }
}

export interface DevServersDoc {
  running: (DevServer & { owner: string | null })[];
  startable: Record<string, DevScripts & { owner: string }>;
}

/** Every worktree (and main checkout) of the scanned repos, fresh from `git worktree list` (a few ms per repo). */
export async function knownDirs(): Promise<Map<string, KnownDir>> {
  const out = new Map<string, KnownDir>();
  for (const repo of await discoverRepos()) {
    const r = await run('git', ['-C', repo, 'worktree', 'list', '--porcelain'], 10_000);
    if (!r.ok) continue;
    const name = repo.split('/').pop()!;
    for (const e of parsePorcelain(r.stdout)) {
      if (e.prunable) continue;
      out.set(e.path, { path: e.path, repo: name, branch: e.branch, owner: `${name}@${e.branch ?? 'detached'}` });
    }
  }
  return out;
}

export async function devServersDoc(): Promise<DevServersDoc> {
  const [dirs, running] = await Promise.all([knownDirs(), listDevServers()]);
  const startable: DevServersDoc['startable'] = {};
  await Promise.all(
    [...dirs.values()].map(async (d) => {
      const s = await devScripts(d.path);
      if (s.preferred) startable[d.path] = { ...s, owner: d.owner };
    }),
  );
  return { running: running.map((r) => ({ ...r, owner: dirs.get(r.path)?.owner ?? null })), startable };
}

/** Why dev servers can't be started or stopped here (#11): a read-only install (403), no systemd (501); null when they can */
export function devServersRefusal(): { ok: false; status: number; message: string } | null {
  const refused = readOnlyRefusal();
  if (refused) return { ok: false, status: 403, message: refused.message };
  if (services().unavailable) return { ok: false, status: 501, message: t('errors.noDevServers', { os: platform().os }) };
  return null;
}

export async function startDevServer(path: string, scriptArg?: string, portArg?: number, env?: Record<string, string | undefined>): Promise<{ ok: boolean; message: string; port?: number; unit?: string; status?: number }> {
  const refused = devServersRefusal();
  if (refused) return refused;
  const dir = (await knownDirs()).get(path);
  if (!dir) return { ok: false, status: 400, message: t('devservers.unknownDir') };
  const s = await devScripts(path);
  const script = scriptArg ?? s.preferred;
  if (!script || !hasScript(s, script)) return { ok: false, status: 400, message: t('devservers.noScript', { scripts: Object.keys(s.scripts).join(', ') || t('devservers.none') }) };
  const unit = unitFor(path);
  if ((await listDevServers()).some((r) => r.unit === unit && r.active)) return { ok: false, status: 409, message: t('devservers.running') };

  let port = portArg;
  const reservations = await loadReservations();
  if (port !== undefined) {
    const held = reservations.find((r) => r.port === port);
    if (held && held.owner !== dir.owner) return { ok: false, status: 409, message: t('devservers.reserved', { port, owner: held.owner }) };
    if (!(await freePorts(20, port, dir.owner)).includes(port)) return { ok: false, status: 409, message: t('devservers.inUse', { port }) };
  } else {
    port = (await freePorts(1, undefined, dir.owner))[0];
    if (!port) return { ok: false, status: 409, message: t('devservers.noFreePort') };
  }
  const r = await reserve(dir.owner, port, `dev server (${script})`, async () => port);
  if (!r.ok) return { ok: false, status: 409, message: r.error };

  const plan = planStart({ dir: path, label: dir.owner, script, command: s.scripts[script], port, env });
  const started = await startUnit(plan);
  return { ...started, port, unit: plan.unit, status: started.ok ? 200 : 500 };
}

export async function stopDevServer(path: string): Promise<{ ok: boolean; message: string; status?: number }> {
  const refused = devServersRefusal();
  if (refused) return refused;
  const unit = unitFor(path);
  if (!(await listDevServers()).some((r) => r.unit === unit)) return { ok: false, status: 404, message: t('devservers.notRunning') };
  return stopUnit(unit);
}

export interface LaunchConfigResult {
  ok: boolean;
  message: string;
  status?: number;
  path?: string;
  port?: number;
  mode?: LaunchMode;
  changed?: boolean;
  /** The entry, so it can be pasted by hand when the file couldn't be written */
  entry?: LaunchEntry;
}

const LAUNCH_REFUSED = {
  comments: 'devservers.launch.comments',
  invalid: 'devservers.launch.invalid',
  tracked: 'devservers.launch.tracked',
  symlink: 'devservers.launch.symlink',
  io: 'devservers.launch.io',
} as const;

/**
 * Point Claude Code Desktop's preview at the worktree's reserved port: write a "portboard" entry into its
 * .claude/launch.json (src/core/launchjson.ts). Reserves a port for <repo>@<branch> when it has none. Without `mode`,
 * attaches to the dev server Portboard already runs for the worktree, else runs the script itself.
 */
export async function writeLaunchConfig(path: string, scriptArg?: string, modeArg?: LaunchMode): Promise<LaunchConfigResult> {
  const refused = readOnlyRefusal();
  if (refused) return { ok: false, status: 403, message: refused.message };
  const dir = (await knownDirs()).get(path);
  if (!dir) return { ok: false, status: 400, message: t('devservers.unknownDir') };
  const unit = unitFor(path);
  const running = (await listDevServers()).find((r) => r.unit === unit && r.active);
  const mode: LaunchMode = modeArg ?? (running ? 'attach' : 'run');
  const s = await devScripts(path);
  const script = scriptArg ?? s.preferred;
  if (mode === 'run' && (!script || !hasScript(s, script))) return { ok: false, status: 400, message: t('devservers.noScript', { scripts: Object.keys(s.scripts).join(', ') || t('devservers.none') }) };
  if (mode === 'attach' && !running?.port) return { ok: false, status: 409, message: t('devservers.launch.noServer') };

  let port = running?.port ?? undefined;
  if (mode === 'run' || !port) {
    const r = await reserve(dir.owner, undefined, 'Claude Code preview (launch.json)', async () => (await freePorts(1, undefined, dir.owner))[0]);
    if (!r.ok) return { ok: false, status: 409, message: r.error };
    port = r.reservation.port;
  }
  const entry = launchEntry({ mode, port, script: script ?? undefined, fw: script && hasScript(s, script) ? frameworkOf(s.scripts[script]) : 'generic' });
  const w = await writeLaunch(path, entry);
  if (!w.ok) return { ok: false, status: w.reason === 'io' ? 500 : 409, message: t(LAUNCH_REFUSED[w.reason], { message: w.message ?? '' }), path: w.path, port, mode, entry };
  return { ok: true, status: 200, message: t(w.changed ? 'devservers.launch.written' : 'devservers.launch.same', { port, mode }), path: w.path, port, mode, changed: w.changed, entry };
}

const launchTool: Tool = {
  def: {
    name: 'write_launch_config',
    title: "Point Claude Code's preview at the reserved port",
    description:
      "Write a \"portboard\" entry into a worktree's .claude/launch.json, the file Claude Code Desktop's preview reads, " +
      "so the preview runs on the worktree's reserved port (owner <repo>@<branch>; one is reserved if it has none) " +
      'with autoPort off, instead of a different free port each time. mode "attach" (the default when Portboard already ' +
      'runs this worktree\'s dev server) only points the preview at that server; "run" lets the preview start the ' +
      'package.json script itself. Other entries are kept; a file with comments or one tracked by git is left alone and ' +
      'the entry is returned to paste. The file is added to the repo\'s info/exclude so the port is never committed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute worktree path (as list_worktrees reports it)' },
        script: { type: 'string', enum: ['dev', 'start', 'preview', 'serve'] },
        mode: { type: 'string', enum: ['run', 'attach'] },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async call(args, core) {
    const a = (args ?? {}) as { path?: unknown; script?: unknown; mode?: unknown };
    if (typeof a.path !== 'string') return text('path must be a worktree path', true);
    if (a.script !== undefined && typeof a.script !== 'string') return text('script must be a string', true);
    if (a.mode !== undefined && a.mode !== 'run' && a.mode !== 'attach') return text('mode must be run or attach', true);
    const r = await core.writeLaunchConfig(a.path, a.script as string | undefined, a.mode as LaunchMode | undefined);
    return text(r, !r.ok);
  },
};

const startTool: Tool = {
  def: {
    name: 'start_dev_server',
    title: "Start a worktree's dev server",
    description:
      "Start a worktree's package.json dev server (dev, start, preview or serve) as a transient systemd unit on " +
      "loopback, on the worktree's reserved port (owner <repo>@<branch>) or a free one that then gets reserved. Only " +
      'worktrees of the repos Portboard scans (see list_worktrees). Logs: tail_logs on the port. Stop with stop_dev_server.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute worktree path (as list_worktrees reports it)' },
        script: { type: 'string', enum: ['dev', 'start', 'preview', 'serve'] },
        port: { type: 'integer', minimum: 1024, maximum: 65535 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async call(args, core) {
    const a = (args ?? {}) as { path?: unknown; script?: unknown; port?: unknown };
    if (typeof a.path !== 'string') return text('path must be a worktree path', true);
    if (a.script !== undefined && typeof a.script !== 'string') return text('script must be a string', true);
    if (a.port !== undefined && !(Number.isInteger(a.port) && (a.port as number) >= 1024 && (a.port as number) <= 65535)) return text('port must be 1024–65535', true);
    const r = await core.startDevServer(a.path, a.script as string | undefined, a.port as number | undefined);
    return text(r, !r.ok);
  },
};

const stopTool: Tool = {
  def: {
    name: 'stop_dev_server',
    title: "Stop a worktree's dev server",
    description: 'Stop the dev server Portboard started for a worktree (systemctl --user stop). The port stays reserved.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async call(args, core) {
    const a = (args ?? {}) as { path?: unknown };
    if (typeof a.path !== 'string') return text('path must be a worktree path', true);
    const r = await core.stopDevServer(a.path);
    return text(r, !r.ok);
  },
};

const listTool: Tool = {
  def: {
    name: 'list_dev_servers',
    title: 'Dev servers Portboard started',
    description: 'Running pb-dev-* units (worktree, port, since when) and which worktrees have a startable package.json script.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async call(_args, core) {
    const d = await core.devServers();
    return text({ running: d.running, startable: Object.entries(d.startable).map(([path, s]) => ({ path, owner: s.owner, scripts: Object.keys(s.scripts), preferred: s.preferred })) });
  },
  remote: {
    description:
      'Dev servers Portboard started for git worktrees on the Portboard server: for each, its worktree as ' +
      '<repo>@<branch>, whether it is active, its port and since when; plus which worktrees have a package.json script ' +
      'Portboard could start (script names only). Paths and commands are left out on purpose. Read-only.',
    async call(_args, core, policy) {
      if (!core.devServers) return text('list_dev_servers is not available here', true);
      return text(redactDevServers(await core.devServers(), policy));
    },
  },
};

export const devServersFeature: FeatureModule = {
  name: 'dev-servers',
  order: 1600,
  routes: [
    { method: 'GET', path: '/api/dev-servers', handler: async () => ok(await devServersDoc()) },
    {
      method: 'POST',
      path: '/api/dev-servers/start',
      write: true,
      body: { limit: 4096 },
      async handler({ body }, ctx) {
        if (typeof body?.path !== 'string') return reply(400, { error: 'path required' });
        const port = body?.port === undefined || body?.port === null || body?.port === '' ? undefined : Number(body.port);
        if (port !== undefined && !(Number.isInteger(port) && port >= 1024 && port <= 65535)) return reply(400, { error: 'port must be 1024–65535' });
        const r = await startDevServer(body.path, typeof body?.script === 'string' ? body.script : undefined, port);
        ctx.invalidate('snapshot');
        return reply(r.status ?? (r.ok ? 200 : 409), r);
      },
    },
    {
      method: 'POST',
      path: '/api/dev-servers/stop',
      write: true,
      body: { limit: 4096 },
      async handler({ body }, ctx) {
        if (typeof body?.path !== 'string') return reply(400, { error: 'path required' });
        const r = await stopDevServer(body.path);
        ctx.invalidate('snapshot');
        return reply(r.status ?? (r.ok ? 200 : 409), r);
      },
    },
    {
      method: 'POST',
      path: '/api/dev-servers/launch-config',
      write: true,
      body: { limit: 4096 },
      async handler({ body }) {
        if (typeof body?.path !== 'string') return reply(400, { error: 'path required' });
        if (body?.mode !== undefined && body.mode !== 'run' && body.mode !== 'attach') return reply(400, { error: 'mode must be run or attach' });
        const r = await writeLaunchConfig(body.path, typeof body?.script === 'string' ? body.script : undefined, body?.mode);
        return reply(r.status ?? (r.ok ? 200 : 409), r);
      },
    },
  ],
  tools: [listTool, startTool, stopTool, launchTool],
  // The stdio server is a Claude session's child: its CLAUDE_* env tells owners.ts whose unit this is (#43).
  mcpCore: () => ({ devServers: devServersDoc, startDevServer: (path: string, script?: string, port?: number) => startDevServer(path, script, port, process.env), stopDevServer, writeLaunchConfig }),
};
