// New dev-server notices (src/core/newports.ts): a look at the ports every LOOK_MS, the events for the dashboard's
// toast and the Mac app, and one ntfy/webhook message per look for `notify` events through the down-alert channel.
// Events are made in every profile (a preview's toast works); the message only goes out where alerts may be sent
// (paths.alertsOn: production, or a preview with PORTBOARD_PREVIEW_ALERTS=1; PORTBOARD_ALERTS=off stops it).
//
//   GET /api/new-ports            {latest, events: []}       (where to start)
//   GET /api/new-ports?since=<id> {latest, events: [...]}    (docs/api.md#new-ports)
//   job new-ports (every 15 s, from the shared 2 s snapshot)
//   ui  features/newports.js on every page: the toast with 열기 · tailnet 공개

import { appendPrivate } from '../core/atomic.ts';
import { httpSender, loadChannel, loadQuiet, type Channel, type Sender, type Sent } from '../core/alerts.ts';
import { createNewPorts, LOOK_MS, newPortText, type NewPortEvent, type NewPorts, type NewPortView } from '../core/newports.ts';
import { resolveDashboardUrl } from '../core/site.ts';
import { serveStatus } from '../core/tailscale.ts';
import { ok, reply } from './router.ts';
import type { ServerContext } from './context.ts';
import type { FeatureModule } from './types.ts';

/** This server process's tracker */
export const tracker: NewPorts = createNewPorts();

export interface LookDeps {
  ports(): Promise<NewPortView[]>;
  quiet(): Promise<Record<string, number>>;
  /** false: make events, send nothing */
  alertsOn: boolean;
  channel?(): Promise<Channel | null>;
  send?: Sender;
  dashboard?(): Promise<string | null>;
  logPath?: string;
}

/** One look: new events, and for the `notify` ones one message through the channel. Resolves to the new events. */
export async function look(t: NewPorts, deps: LookDeps): Promise<NewPortEvent[]> {
  const [ports, quiet] = await Promise.all([deps.ports(), deps.quiet().catch(() => ({}))]);
  const added = t.observe(ports, quiet);
  const notify = added.filter((e) => e.action === 'notify');
  if (!notify.length || !deps.alertsOn) return added;
  const c = await (deps.channel ?? (() => loadChannel()))();
  if (!c) return added;
  const m = newPortText(notify, (await deps.dashboard?.().catch(() => null)) ?? null);
  const sent: Sent[] = await (deps.send ?? httpSender())(c, m).catch(() => [{ channel: 'ntfy' as const, ok: false, error: 'send failed' }]);
  const line = { t: new Date().toISOString(), key: m.key, kind: m.kind, title: m.title, body: m.body, sent };
  if (deps.logPath) await appendPrivate(deps.logPath, `${JSON.stringify(line)}\n`).catch(() => {});
  return added;
}

let dashboard: Promise<string | null> | null = null;

function lookDeps(ctx: ServerContext): LookDeps {
  return {
    ports: () => ctx.snapshot().then((s) => s.ports),
    quiet: () => loadQuiet(ctx.paths.quiet),
    alertsOn: ctx.paths.alertsOn,
    // where tailscale serve publishes the dashboard (https 8443), read once: the tap target and the 공개 action
    dashboard: () => (dashboard ??= serveStatus().then((serve) => resolveDashboardUrl(ctx.ts.dnsName, serve, ctx.paths.port)).catch(() => null)),
    logPath: ctx.paths.alertsLog,
  };
}

export const newPortsFeature: FeatureModule = {
  name: 'new-ports',
  order: 2400,
  routes: [
    {
      method: 'GET',
      path: '/api/new-ports',
      async handler({ url }) {
        const raw = url.searchParams.get('since');
        if (raw === null || raw === '') return ok(tracker.feed());
        if (!/^\d{1,16}$/.test(raw)) return reply(400, { error: 'since must be an event id' });
        return ok(tracker.feed(Number(raw)));
      },
    },
  ],
  jobs: [{ name: 'new-ports', everyMs: LOOK_MS, runAtStart: true, run: (ctx) => look(tracker, lookDeps(ctx)) }],
  // the toast, on every page of the shell
  ui: [{ pages: ['index.html', 'devices.html', 'dev.html', 'service.html'], script: 'features/newports.js' }],
};
