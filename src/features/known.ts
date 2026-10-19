// 새 기기 (known devices): devices seen for the first time, kept until acknowledged or named, with batched alerts.
// The tracker itself lives in the shared context: every usage sample is also a known-devices observation.
//
//   GET  /api/known-devices                 (pending new devices and the alert settings)
//   POST /api/known-devices/ack  {key: '<key>'|'all'}            (X-Portboard)
//   POST /api/known-devices/settings {connections?, neighbors?}  (X-Portboard)
//   MCP  list_new_devices

import { loadKnown, summary, type NewDevicesSummary } from '../core/known.ts';
import { loadPrefs, newDeviceSettings, setNewDevicePrefs } from '../core/prefs.ts';
import { PATHS } from '../core/paths.ts';
import { text } from '../mcp/kit.ts';
import { ok, reply } from './router.ts';
import type { FeatureModule } from './types.ts';

declare module '../mcp/kit.ts' {
  interface Core {
    /** 새 기기: pending (unacknowledged) new devices and the alert settings (one file read) */
    newDevices?(): Promise<NewDevicesSummary>;
  }
}

const isObject = (body: unknown) => !!body && typeof body === 'object' && !Array.isArray(body);

export const knownFeature: FeatureModule = {
  name: 'known-devices',
  order: 700,
  routes: [
    { method: 'GET', path: '/api/known-devices', handler: async (_r, ctx) => ok(await ctx.known.summary(newDeviceSettings(await loadPrefs()))) },
    {
      method: 'POST',
      path: '/api/known-devices/ack',
      write: true,
      body: { limit: 1024 },
      async handler({ body }, ctx) {
        if (!isObject(body)) return reply(400, { error: 'body must be an object' });
        if (typeof body.key !== 'string' || !/^(all|(ts|mac|ip):[\w.:@-]{1,80})$/.test(body.key)) return reply(400, { error: "key must be a known-device key or 'all'" });
        const n = await ctx.known.acknowledge(body.key);
        ctx.invalidate('usage');
        return ok({ ok: true, acknowledged: n });
      },
    },
    {
      method: 'POST',
      path: '/api/known-devices/settings',
      write: true,
      body: { limit: 1024 },
      async handler({ body }, ctx) {
        if (!isObject(body)) return reply(400, { error: 'body must be an object' });
        for (const k of Object.keys(body)) if (k !== 'connections' && k !== 'neighbors') return reply(400, { error: `unknown field: ${k}` });
        for (const k of ['connections', 'neighbors']) if (body[k] !== undefined && typeof body[k] !== 'boolean') return reply(400, { error: `${k} must be a boolean` });
        const settings = await setNewDevicePrefs(body);
        ctx.invalidate('usage');
        return ok({ ok: true, settings });
      },
    },
  ],
  tools: [
    {
      def: {
        name: 'list_new_devices',
        title: 'New devices not acknowledged yet',
        description:
          'Devices Portboard has seen for the first time and the user has not acknowledged or named yet: a tailnet ' +
          'or LAN device that connected to a service on this server for the first time (scope "connection"), or, when ' +
          'turned on, a MAC new in the neighbour table (scope "neighbor"). Each has name, kind, vendor, LAN ip, the first ' +
          'service it used, since, and nameKey for name_device. Also returns the alert settings and how many devices are known.' +
          ' A LAN device Portboard can name better carries suggestedName {name, source, text} (list_suggestions).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async call(_args, core) {
        if (!core.newDevices) return text('list_new_devices is not available here', true);
        const out = await core.newDevices();
        if (!out.pending.length || !core.suggestions) return text(out);
        // Smart defaults (src/features/suggestions.ts): the name list_suggestions would offer, on the pending entry
        const names = new Map(((await core.suggestions().catch(() => null))?.suggestions ?? []).flatMap((x) => (x.kind === 'name' ? [[x.key, x] as const] : [])));
        return text({
          ...out,
          pending: out.pending.map((p) => {
            const sg = p.nameKey ? names.get(p.nameKey) : undefined;
            return sg ? { ...p, suggestedName: { name: sg.name, source: sg.source, text: sg.text } } : p;
          }),
        });
      },
    },
  ],
  // Reads the file the server keeps; the stdio process never observes or alerts on its own.
  mcpCore: () => ({ newDevices: async () => summary(await loadKnown(), newDeviceSettings(await loadPrefs()), PATHS.alertsOn) }),
  collectors: ['known-devices'],
};
