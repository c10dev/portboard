// Service detail: everything about one port (service.html#<port>): owner, who uses it now and before, uptime, the
// alerts sent. Works for a watched port that is down.
//
//   GET /api/ports/:port/detail
//   MCP service_detail (and the portboard://port/{port} resource, through detailReport)

import { readEvents, defaultChecker } from '../core/alerts.ts';
import { serviceDetail, type ServiceDetail } from '../core/detail.ts';
import { loadHistory, withHistory } from '../core/history.ts';
import { snapshot } from '../core/index.ts';
import { detail as uptimeDetail, loadUptime } from '../core/uptime.ts';
import { usage } from '../core/usage.ts';
import { PORT_ARG, parsePort, text } from '../mcp/kit.ts';
import { toSummary } from '../mcp/views.ts';
import { ok, reply } from './router.ts';
import type { FeatureModule } from './types.ts';

declare module '../mcp/kit.ts' {
  interface Core {
    /** Everything about one port (src/core/detail.ts); null when nothing is known about it */
    serviceDetail?(port: number): Promise<ServiceDetail | null>;
  }
}

/** service_detail: the page's data without the bar arrays, process command lines kept to the controlling part. */
export function detailReport(d: ServiceDetail) {
  const e = d.entry;
  const proc = e?.processes[0];
  return {
    at: d.at,
    port: d.port,
    name: d.name,
    listening: d.listening,
    service: e
      ? {
          ...toSummary(e),
          detectedName: e.detectedName,
          container: e.container,
          composeProject: e.composeProject,
          unit: proc?.unit ?? null,
          project: proc?.project ?? null,
          ...(e.group ? { group: { name: e.group.name, ports: e.group.ports, role: e.role } } : {}),
          httpTitle: e.probe?.title ?? null,
        }
      : null,
    usingNow: d.usingNow,
    lastUsed: d.lastUsed,
    historySince: d.historySince,
    alert: d.watched,
    alertState: d.watch ? { down: d.watch.down, since: d.watch.since, alerted: d.watch.alerted, quietUntil: d.watch.quietUntil } : null,
    uptime: d.uptime
      ? {
          pct24h: d.uptime.pct24h, pct7d: d.uptime.pct7d, pct30d: d.uptime.pct30d,
          checkedSince: d.uptime.since, lastCheck: d.uptime.lastCheck,
          /** Last 30 checks, oldest first: u up, d down, q quiet after a Portboard restart/stop, - not checked */
          recentChecks: d.uptime.checks,
          outages: d.uptime.outages,
        }
      : null,
    alertsSent: d.events,
  };
}

export const serviceDetailFeature: FeatureModule = {
  name: 'service-detail',
  routes: [
    {
      method: 'GET',
      path: '/api/ports/:port/detail',
      async handler({ params: { port } }, ctx) {
        const [snap, u, st, events] = await Promise.all([ctx.snapshot(), ctx.usage().catch(() => null), ctx.alerts.status(), readEvents(`port:${port}`)]);
        const now = Date.now();
        const d = serviceDetail({
          port, now, ports: snap.ports, usage: u, history: ctx.history.data,
          watch: st.watching.find((w) => w.key === `port:${port}`) ?? null,
          uptime: uptimeDetail(ctx.uptime.data, port, now),
          events,
        });
        return d ? ok(d) : reply(404, { error: `nothing is known about port ${port}` });
      },
    },
  ],
  tools: [
    {
      def: {
        name: 'service_detail',
        title: 'One service in detail',
        description:
          'Everything Portboard knows about one port: what owns it (name, systemd unit / container / compose group, bind ' +
          'scope, URLs, what restart_service / stop_service would act on), who is connected right now, every device that ' +
          'used it with when it was last seen and minutes in use over 7 and 30 days, and, for ports with a down alert ' +
          '(set_alert), uptime % over 24 h / 7 d / 30 d from the 30 s checks, recent outages and the alerts that were sent. ' +
          'Works for a watched port that is down (nothing listening). Use it before stopping something, or for "is X ' +
          'flaky?" / "who uses X?".',
        inputSchema: PORT_ARG,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async call(args, core) {
        const p = parsePort(args);
        if (!p.ok) return text(p.error, true);
        if (!core.serviceDetail) return text('service_detail is not available here', true);
        const d = await core.serviceDetail(p.value);
        if (!d) return text(`nothing is known about port ${p.value}: not listening, not watched, no usage history`, true);
        return text(detailReport(d));
      },
    },
  ],
  // From the files the server writes: alert state, uptime.json, alerts.jsonl. This checker is never started.
  mcpCore: () => ({
    serviceDetail: async (port: number) => {
      const [snap, u, h, st, up, events] = await Promise.all([
        snapshot(), usage().catch(() => null), loadHistory(), defaultChecker(async () => []).status(), loadUptime(), readEvents(`port:${port}`),
      ]);
      const now = Date.now();
      return serviceDetail({
        port, now, ports: snap.ports, usage: u ? withHistory(u, h, now) : null, history: h,
        watch: st.watching.find((w) => w.key === `port:${port}`) ?? null,
        uptime: uptimeDetail(up, port, now),
        events,
      });
    },
  }),
};
