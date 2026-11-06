// Control: restart / stop whatever owns a port (systemd unit, docker container, process) and read its logs.
// Actions take only a port; the server resolves the owner itself and never accepts unit names or pids.
// A restart or stop from here is not an outage: the down-alert checker stays quiet for 2 minutes (quietly()).
//
//   GET  /api/ports/:port/logs?lines=100   (owner from the shared 2 s snapshot)
//   POST /api/ports/:port/restart | stop   (X-Portboard)
//   MCP  restart_service, stop_service, tail_logs

import { logs, restart, stop, type ActionResult, type Logs } from '../core/index.ts';
import { quietly } from '../core/alerts.ts';
import { classify } from '../core/access.ts';
import { PORT_ARG, parseOptionalInt, parsePort, text, type Core } from '../mcp/kit.ts';
import { reply } from './router.ts';
import type { FeatureModule, Tool } from './types.ts';

declare module '../mcp/kit.ts' {
  interface Core {
    restart(port: number): Promise<ActionResult>;
    stop(port: number): Promise<ActionResult>;
    logs(port: number, lines: number): Promise<Logs>;
  }
}

const quietRestart = quietly(restart);
const quietStop = quietly(stop);

async function act(port: number, fn: (port: number) => Promise<ActionResult>, ctx: { invalidate(w: 'snapshot'): void }) {
  const result = await fn(port);
  ctx.invalidate('snapshot');
  return reply(result.ok ? 200 : 409, result);
}

const actTool = (pick: (core: Core) => (port: number) => Promise<ActionResult>) => async (args: unknown, core: Core) => {
  const p = parsePort(args);
  if (!p.ok) return text(p.error, true);
  const result = await pick(core)(p.value);
  return text(result, !result.ok);
};

const tools: Tool[] = [
  {
    def: {
      name: 'restart_service',
      title: 'Restart what owns a port',
      description:
        'Restart the systemd user unit or docker container that owns a listening port (see control in list_ports). ' +
        'Confirm with the user first unless they asked for it explicitly. ' +
        'Plain processes started from a terminal cannot be restarted this way; restart them where they were started.',
      inputSchema: PORT_ARG,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    call: actTool((core) => core.restart),
  },
  {
    def: {
      name: 'stop_service',
      title: 'Stop what owns a port',
      description:
        'Stop the systemd user unit or docker container that owns a port, or send SIGTERM to the owning process. ' +
        'Confirm with the user first unless they asked for it explicitly. Refuses to stop Portboard itself: its units ' +
        '(portboard-remote.service, portboard-agent.service) and its processes without one, previews included.',
      inputSchema: PORT_ARG,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    call: actTool((core) => core.stop),
  },
  {
    def: {
      name: 'tail_logs',
      title: 'Recent logs for a port',
      description:
        'Last lines of output from whatever owns a port: journalctl for systemd units, docker logs for containers, ' +
        "or the file a plain process writes to. Use it to find out why a service failed or isn't responding.",
      inputSchema: {
        type: 'object',
        properties: {
          port: PORT_ARG.properties.port,
          lines: { type: 'integer', minimum: 1, maximum: 1000, description: 'How many lines (default 100)' },
        },
        required: ['port'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async call(args, core) {
      const p = parsePort(args);
      if (!p.ok) return text(p.error, true);
      const lines = parseOptionalInt(args, 'lines', 1, 1000);
      if (!lines.ok) return text(lines.error, true);
      const result = await core.logs(p.value, lines.value ?? 100);
      return text(result, !result.ok);
    },
  },
];

export const control: FeatureModule = {
  name: 'control',
  order: 200,
  routes: [
    {
      method: 'GET',
      path: '/api/ports/:port/logs',
      async handler({ url, params, req }, ctx) {
        // Service logs often hold tokens and secrets that a dev server prints at start. They are the owner's only, as
        // the audit log is (features/access.ts): the same owner decision as writes, without the device lookup.
        const c = classify(req, await ctx.owner(), await ctx.policy());
        if (!c.owner) return reply(403, { error: 'owner only', reason: c.reason ?? '' });
        // the shared 2 s snapshot, not a new one per request (L1)
        const result = await logs(params.port, Number(url.searchParams.get('lines') ?? 100) || 100, () => ctx.snapshot());
        return reply(result.ok ? 200 : 409, result);
      },
    },
    { method: 'POST', path: '/api/ports/:port/restart', write: true, handler: ({ params }, ctx) => act(params.port, quietRestart, ctx) },
    { method: 'POST', path: '/api/ports/:port/stop', write: true, handler: ({ params }, ctx) => act(params.port, quietStop, ctx) },
  ],
  tools,
  // restart/stop mark the port quiet so the dashboard's down-alert checker (another process) doesn't page about it.
  mcpCore: () => ({ restart: quietRestart, stop: quietStop, logs }),
};
