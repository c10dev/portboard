// Down alerts: the 30 s checker over watched ports and devices, its channel (compute-pool's ntfy/webhook), and the
// uptime history every check feeds (uptime.json). The checker only runs where alerts may be sent: production, or a
// preview with PORTBOARD_PREVIEW_ALERTS=1 (paths.alertsOn); PORTBOARD_ALERTS=off stops it everywhere. The API
// answers either way.
//
//   GET  /api/alerts             (channel kinds, what is watched, its state and uptime; never the channel itself)
//   POST /api/alerts/test        (X-Portboard)
//   POST /api/devices/:device/alert  {on: boolean}   (X-Portboard)
//   MCP  set_alert
//   job  alerts (the checker); uptime flushed on shutdown

import { defaultChecker, type AlertsStatus, type WatchStatus } from '../core/alerts.ts';
import { setPrefs } from '../core/index.ts';
import { setDeviceAlert } from '../core/prefs.ts';
import { summary as uptimeSummary } from '../core/uptime.ts';
import { PORT_ARG, parsePort, text } from '../mcp/kit.ts';
import { ok, reply } from './router.ts';
import type { ServerContext } from './context.ts';
import type { FeatureModule } from './types.ts';

declare module '../mcp/kit.ts' {
  interface Core {
    /** Turn down/up alerts for a port on or off; resolves to the new flag */
    setAlert?(port: number, on: boolean): Promise<boolean>;
    /** Watched (🔔) ports and devices with their down state, from the files the server writes (portboard://status) */
    alerts?(): Promise<{ watching: WatchStatus[] }>;
  }
}

/** The checker's status with each watched port's recent checks and 24 h / 7 d uptime (the 서비스 rows' bars). */
async function alertsWithUptime(ctx: ServerContext): Promise<AlertsStatus> {
  const st = await ctx.alerts.status();
  const now = Date.now();
  return { ...st, watching: st.watching.map((w) => (w.kind === 'port' ? { ...w, uptime: uptimeSummary(ctx.uptime.data, w.port!, now) } : w)) };
}

export const alertsFeature: FeatureModule = {
  name: 'alerts',
  routes: [
    { method: 'GET', path: '/api/alerts', handler: async (_r, ctx) => ok(await alertsWithUptime(ctx)) },
    {
      method: 'POST',
      path: '/api/alerts/test',
      write: true,
      async handler(_r, ctx) {
        const result = await ctx.alerts.test();
        return reply(result.ok ? 200 : 409, result);
      },
    },
    {
      method: 'POST',
      path: '/api/devices/:device/alert',
      write: true,
      body: { limit: 1024 },
      async handler({ params, body }) {
        if (typeof body?.on !== 'boolean') return reply(400, { error: 'on must be a boolean' });
        await setDeviceAlert(params.device, body.on);
        return ok({ ok: true, id: params.device, alert: body.on });
      },
    },
  ],
  tools: [
    {
      def: {
        name: 'set_alert',
        title: 'Down alert for a port',
        description:
          "Turn on or off the push notification (through compute-pool's ntfy/webhook channel) sent when a port stops " +
          'listening or stops answering HTTP for two checks in a row (30 s apart), and again when it is back. Restarts and ' +
          'stops through restart_service / stop_service do not alert for 2 minutes.',
        inputSchema: {
          type: 'object',
          properties: { port: PORT_ARG.properties.port, on: { type: 'boolean', description: 'true to alert, false to stop' } },
          required: ['port', 'on'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async call(args, core) {
        const p = parsePort(args);
        if (!p.ok) return text(p.error, true);
        const on = (args as Record<string, unknown> | null)?.on;
        if (typeof on !== 'boolean') return text('on must be a boolean', true);
        if (!core.setAlert) return text('set_alert is not available here', true);
        const alert = await core.setAlert(p.value, on);
        return text({ ok: true, port: p.value, alert });
      },
    },
  ],
  mcpCore: () => ({
    setAlert: async (port: number, on: boolean) => !!(await setPrefs(port, { alert: on })).alert,
    // Watched ports and devices with their down state, from the files the server writes (alerts-state.json,
    // prefs.json). This checker is never started.
    alerts: () => defaultChecker(async () => []).status(),
  }),
  jobs: [{ name: 'alerts', enabled: (paths) => paths.alertsOn, start: (ctx) => ctx.alerts.start() }],
  shutdown: (ctx) => ctx.uptime.flush().catch((err) => console.error(`[portboard] uptime: ${err}`)),
  collectors: ['alerts'],
};
