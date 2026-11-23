// The stdio MCP server's thin client talks to the dashboard process instead of loading the feature modules itself
// (src/mcp/thin.mjs, claude-plugin/bin/mcp.mjs; docs/mcp.md).
//
//   GET  /api/mcp/ping   200 { ok, version } only when POST /api/mcp would accept the same caller
//   POST /api/mcp        one JSON-RPC message in, the reply out (204 for a notification) (X-Portboard)
//
// POST /api/mcp is a write route (the router checks X-Portboard, the read-only install and the machine owner, and
// records a refusal) with `auditOk: false`: a successful call is not an audit line, because callTool already records
// each write tool as source "mcp" in ctx.audit. Local processes only (localOnly).

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { localOnly, resolveCaller } from '../core/access.ts';
import { KINDS, ADAPTERS } from '../core/coding-agent-adapters.ts';
import { platform } from '../core/platform/index.ts';
import { VERSION } from '../version.ts';
import type { Request } from '../mcp/rpc.ts';
import type { Core } from '../mcp/kit.ts';
import { reply } from './router.ts';
import { startCodingAgent } from '../core/coding-agents.ts';
import type { FeatureModule } from './types.ts';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const CLAUDE_PID = /^\d{1,10}$/;

let core: Core | null = null;
/**
 * The stdio server's Core (src/mcp.ts), built on first use. Its caches are separate from the dashboard's. The registry
 * and rpc.ts are loaded here, not at the top: they read each other's exports while loading, and this module is one of
 * the registry's own.
 */
async function mcpCore(): Promise<Core> {
  if (core) return core;
  const { REGISTRY } = await import('./registry.ts');
  return (core = Object.assign({}, ...REGISTRY.features.map((f) => f.mcpCore?.() ?? {})) as Core);
}

const PATH_MAX_ENTRIES = 64;
const PATH_MAX_BYTES = 4096;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The session the caller names, as the stdio server's env would: only well-formed values, never the daemon's env. */
function sessionEnv(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const id = one(headers['x-portboard-session']);
  const pid = one(headers['x-portboard-claude-pid']);
  return {
    ...(id !== undefined && SESSION_ID.test(id) ? { CLAUDE_CODE_SESSION_ID: id } : {}),
    ...(pid !== undefined && CLAUDE_PID.test(pid) ? { CLAUDE_PID: pid } : {}),
  };
}

/**
 * The caller's PATH from X-Portboard-Path: where start_coding_agent looks for the CLI, as the stdio server did with the
 * session's own PATH (the dashboard's service PATH has no nvm folder). Absolute entries without control characters, at
 * most 64 entries and 4096 bytes; a header that breaks a limit is dropped whole. It chooses only where to look.
 */
export function callerPath(v: string | string[] | undefined): string | undefined {
  const raw = one(v);
  if (raw === undefined || Buffer.byteLength(raw) > PATH_MAX_BYTES) return undefined;
  const entries = raw.split(':').filter((d) => d.startsWith('/') && !/[\x00-\x1f\x7f]/.test(d));
  return entries.length > 0 && entries.length <= PATH_MAX_ENTRIES ? entries.join(':') : undefined;
}

/**
 * Whether the group with this gid, in the text of /etc/group (`name:password:gid:member,member`), has no supplementary
 * members. A gid that is not in the text is false.
 */
export function groupHasNoMembers(groupFile: string, gid: number): boolean {
  for (const line of groupFile.split('\n')) {
    const [, , id, members] = line.split(':');
    if (id !== undefined && /^\d+$/.test(id) && Number(id) === gid) return (members ?? '').trim() === '';
  }
  return false;
}

/** The default lookup: /etc/group on this host. Unreadable is false (group write is then not accepted). */
function ownPrivateGroup(gid: number): boolean {
  try {
    return groupHasNoMembers(readFileSync('/etc/group', 'utf8'), gid);
  } catch {
    return false;
  }
}

/**
 * Owned by this process's user or root; never writable by others; writable by the group only when it is this
 * process's own primary group and nobody else is a member of it.
 */
function onlyOwnerWrites(path: string, groupIsPrivate: (gid: number) => boolean): boolean {
  try {
    const st = statSync(path);
    if (st.uid !== process.getuid?.() && st.uid !== 0) return false;
    if (st.mode & 0o002) return false;
    if (st.mode & 0o020) return st.gid === process.getgid?.() && groupIsPrivate(st.gid);
    return true;
  } catch {
    return false;
  }
}

/**
 * The entries of a PATH that came from a request header, kept only when whatever coding agent CLI they hold is
 * trusted: the entry's folder, each CLI file found there as resolved (a link's own mode is not looked at), and the
 * resolved file's folder pass `onlyOwnerWrites`. An entry holding no such CLI is dropped too, so the lookup can only
 * land on a trusted file. (The stdio server's PATH, from its own process, is not filtered.)
 * `groupIsPrivate` is injectable so tests do not depend on the host's groups.
 */
export function trustedPath(path: string, groupIsPrivate: (gid: number) => boolean = ownPrivateGroup): string {
  const bins = KINDS.map((k) => ADAPTERS[k].bin);
  return path
    .split(':')
    .filter((dir) => {
      if (!onlyOwnerWrites(dir, groupIsPrivate)) return false;
      for (const bin of bins) {
        const file = join(dir, bin);
        if (!existsSync(file)) continue;
        try {
          const real = realpathSync(file);
          if (!onlyOwnerWrites(real, groupIsPrivate) || !onlyOwnerWrites(dirname(real), groupIsPrivate)) return false;
        } catch {
          return false;
        }
      }
      return true;
    })
    .join(':');
}

export const mcpLocalFeature: FeatureModule = {
  name: 'mcp-local',
  order: 2590,
  routes: [
    {
      // A GET skips the router's checks and audit, so this makes the same checks itself, and writes no audit line.
      method: 'GET',
      path: '/api/mcp/ping',
      async handler({ req }, ctx) {
        if (!localOnly(req)) return reply(403, { error: 'loopback only' });
        if (platform().readOnly) return reply(403, { error: 'read-only' });
        if (!(await resolveCaller(req, ctx)).canWrite) return reply(403, { error: 'owner only' });
        return reply(200, { ok: true, version: VERSION });
      },
    },
    {
      method: 'POST',
      path: '/api/mcp',
      write: true,
      body: { limit: 1_048_576 },
      auditOk: false,
      async handler({ body, req }, ctx) {
        if (!localOnly(req)) return reply(403, { error: 'loopback only' });
        const env = sessionEnv(req.headers);
        const base = await mcpCore();
        // This request's session, not the daemon's process.env, goes to a started dev server's unit.
        // start_dev_server reads only the session keys (its unit has its own PATH); the coding agent run also needs
        // the caller's PATH to find its CLI.
        const headerPath = callerPath(req.headers['x-portboard-path']);
        const agentEnv: Record<string, string> = { ...env, ...(headerPath !== undefined ? { PATH: trustedPath(headerPath) } : {}) };
        const perRequest: Core = {
          ...base,
          startDevServer: (path, script, port) => base.startDevServer(path, script, port, env),
          startCodingAgent: (r) => startCodingAgent(r, agentEnv),
        };
        const { handleMessage } = await import('../mcp/rpc.ts');
        const out = await handleMessage(body as Request, perRequest, ctx.audit);
        return out ? reply(200, out) : { status: 204, body: undefined };
      },
    },
  ],
};
