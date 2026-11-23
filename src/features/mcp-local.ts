// The stdio MCP server's thin client talks to the dashboard process instead of loading the feature modules itself
// (src/mcp/thin.mjs, claude-plugin/bin/mcp.mjs; docs/mcp.md).
//
//   GET  /api/mcp/ping   200 { ok, version } only when POST /api/mcp would accept the same caller
//   POST /api/mcp        one JSON-RPC message in, the reply out (204 for a notification) (X-Portboard)
//
// POST /api/mcp is a write route (the router checks X-Portboard, the read-only install and the machine owner, and
// records a refusal) with `auditOk: false`: a successful call is not an audit line, because callTool already records
// each write tool as source "mcp" in ctx.audit. Local processes only (localOnly).

import { localOnly, resolveCaller } from '../core/access.ts';
import { platform } from '../core/platform/index.ts';
import { VERSION } from '../version.ts';
import type { Request } from '../mcp/rpc.ts';
import type { Core } from '../mcp/kit.ts';
import { reply } from './router.ts';
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

/**
 * The tools of the coding-agents feature module. They start and stop runs of another CLI with the session's own PATH
 * and session, so they run only in the session's process: POST /api/mcp refuses them (docs/security.md).
 */
async function localOnlyTools(): Promise<Set<string>> {
  const { REGISTRY } = await import('./registry.ts');
  return new Set(REGISTRY.features.filter((f) => f.name === 'coding-agents').flatMap((f) => (f.tools ?? []).map((t) => t.def.name)));
}

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
        // Nothing runs for these: 409 tells the thin client to answer in its own process. (A 409 is logged by the
        // router as an `error` line for POST /api/mcp: one per session, since the client then stays local.)
        const msg = body as { method?: unknown; params?: { name?: unknown } } | null;
        if (msg !== null && typeof msg === 'object' && msg.method === 'tools/call' && typeof msg.params?.name === 'string' && (await localOnlyTools()).has(msg.params.name)) {
          return reply(409, { error: 'local only tool' });
        }
        const env = sessionEnv(req.headers);
        const base = await mcpCore();
        // This request's session, not the daemon's process.env, goes to a started dev server's unit.
        const perRequest: Core = { ...base, startDevServer: (path, script, port) => base.startDevServer(path, script, port, env) };
        const { handleMessage } = await import('../mcp/rpc.ts');
        const out = await handleMessage(body as Request, perRequest, ctx.audit);
        return out ? reply(200, out) : { status: 204, body: undefined };
      },
    },
  ],
};
