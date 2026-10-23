// Ports: the listening-port snapshot, publishing a port to the tailnet (tailscale serve) and the per-port
// preferences (label, pin, hide, alert flag).
//
//   GET  /api/ports                    (?fresh skips the 2 s cache)
//   POST /api/ports/:port/expose | unexpose                       (X-Portboard; 409 without Tailscale, #12)
//   POST /api/ports/:port/prefs  {label?, pinned?, hidden?, alert?} (X-Portboard)
//   MCP  list_ports (also remote, redacted), expose_port, unexpose_port

import { expose, setPrefs, snapshot, unexpose, type ActionResult, type Snapshot } from '../core/index.ts';
import { checkPatch, type PrefsPatch } from '../core/prefs.ts';
import { PORT_ARG, parsePort, text, type Core } from '../mcp/kit.ts';
import { parseListArgs, summarize } from '../mcp/views.ts';
import { redactPorts } from '../remote/redact.ts';
import { ok, reply, tailscaleRequired } from './router.ts';
import type { ServerContext } from './context.ts';
import type { FeatureModule, Tool } from './types.ts';
import { SITE } from '../core/site.ts';

declare module '../mcp/kit.ts' {
  interface Core {
    snapshot(): Promise<Snapshot>;
    expose(port: number): Promise<ActionResult>;
    unexpose(port: number): Promise<ActionResult>;
  }
}

async function publish(port: number, act: (port: number) => Promise<ActionResult>, ctx: Pick<ServerContext, 'ts' | 'invalidate'>) {
  // tailscale serve: nothing to run without Tailscale (#12)
  const no = tailscaleRequired(ctx);
  if (no) return no;
  const result = await act(port);
  ctx.invalidate('snapshot');
  return reply(result.ok ? 200 : 409, result);
}

/** expose_port / unexpose_port: the same port check and result for both. */
const publishTool = (pick: (core: Core) => (port: number) => Promise<ActionResult>) => async (args: unknown, core: Core) => {
  const p = parsePort(args);
  if (!p.ok) return text(p.error, true);
  const result = await pick(core)(p.value);
  return text(result, !result.ok);
};

const tools: Tool[] = [
  {
    def: {
      name: 'list_ports',
      title: 'List listening ports',
      description:
        'List TCP ports listening on this server: what owns each one, its bind scope (loopback / tailnet / all), ' +
        'whether it speaks HTTP, the tailnet URL to open it, and whether it can be published with expose_port. ' +
        'Also shows who controls it (systemd unit / docker / plain process) and whether restart_service / stop_service ' +
        'can act on it. System ports (sshd, DNS, tailscaled…), ephemeral helper ports (VS Code server…) and ports the ' +
        'user hid are left out unless include_system is true; pinned ports come first. alert=true means the user gets a ' +
        'push notification when that port goes down and when it comes back (see set_alert). This server only: the ' +
        'other compute-pool machines\' ports (desktop, mac) are in list_devices.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Case-insensitive filter on port number, name, container, HTTP title, project or systemd unit',
          },
          include_system: {
            type: 'boolean',
            description: 'Also list system, ephemeral and user-hidden ports (default false)',
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async call(args, core) {
      const a = parseListArgs(args);
      if (!a.ok) return text(a.error, true);
      // History is optional here: list_ports must work even when it can't be read.
      const history = Promise.resolve().then(() => core.history()).catch(() => undefined);
      const [snap, hist] = await Promise.all([core.snapshot(), history]);
      return text(summarize(snap, a.value, hist));
    },
    remote: {
      description:
        `List TCP ports listening on the Portboard server (${SITE.host}): service name, bind scope (loopback / tailnet / all), ` +
        'HTTP status, whether a systemd unit, docker container or plain process owns it, and the URL to open it. ' +
        'URLs are on the owner\'s private Tailscale network and only open from their own devices. System and helper ports ' +
        'are left out unless include_system is true; pinned ports come first. Read-only.',
      async call(args, core, policy) {
        const a = parseListArgs(args);
        if (!a.ok) return text(a.error, true);
        return text(redactPorts(await core.snapshot(), a.value, policy));
      },
    },
  },
  {
    def: {
      name: 'expose_port',
      title: 'Publish port to tailnet',
      description:
        'Publish a loopback-only HTTP port to the Tailscale tailnet with `tailscale serve` ' +
        '(https://<host>.ts.net:<port>, tailnet devices only). Only works when list_ports shows canExpose=true. ' +
        'If Serve is not enabled on the tailnet yet, the result contains enableUrl for the admin to open once.',
      inputSchema: PORT_ARG,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    call: publishTool((core) => core.expose),
  },
  {
    def: {
      name: 'unexpose_port',
      title: 'Remove tailnet publish',
      description:
        'Remove the `tailscale serve` entry for a port previously published with expose_port. ' +
        'Confirm with the user first unless they asked for it explicitly.',
      inputSchema: PORT_ARG,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    call: publishTool((core) => core.unexpose),
  },
];

export const ports: FeatureModule = {
  name: 'ports',
  order: 100,
  routes: [
    { method: 'GET', path: '/api/ports', handler: async ({ url }, ctx) => ok(await ctx.snapshot(url.searchParams.has('fresh'))) },
    { method: 'POST', path: '/api/ports/:port/expose', write: true, handler: ({ params }, ctx) => publish(params.port, expose, ctx) },
    { method: 'POST', path: '/api/ports/:port/unexpose', write: true, handler: ({ params }, ctx) => publish(params.port, unexpose, ctx) },
    {
      method: 'POST',
      path: '/api/ports/:port/prefs',
      write: true,
      body: { limit: 4096 },
      async handler({ params, body }, ctx) {
        const problem = checkPatch(body);
        if (problem) return reply(400, { error: problem });
        const prefs = await setPrefs(params.port, body as PrefsPatch);
        ctx.invalidate('snapshot');
        return ok({ ok: true, prefs });
      },
    },
  ],
  tools,
  mcpCore: () => ({ snapshot, expose, unexpose }),
  // the shell's sidebar on every page: view counts, 고정, 기기 (docs/layout/)
  ui: [{ pages: ['index.html', 'devices.html', 'dev.html', 'service.html'], script: 'features/nav.js' }],
};
