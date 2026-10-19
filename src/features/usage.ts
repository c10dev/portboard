// Usage: who is connected to which port now (topology → usage), the last-used history, and the names given to LAN
// devices. The dashboard samples every 30 s so the history covers the time nobody is looking.
//
//   GET  /api/topology         (raw: who is connected to which port)
//   GET  /api/usage            (one card per device with what it is using, plus last-used history; 기기 tab and 사용 중 chips)
//   POST /api/clients/name     {key: 'mac:…'|'ip:…', name}   (X-Portboard)
//   MCP  who_uses (= list_usage), name_device; remote who_uses_what (redacted, no history)
//   job  usage-sample (PORTBOARD_SAMPLE_MS, default 30 s); history flushed on shutdown

import { checkName, setName } from '../core/clients.ts';
import { historyView, loadHistory, withHistory, type HistoryView, type UsageWithHistory } from '../core/history.ts';
import { usage } from '../core/usage.ts';
import { reportHealth } from '../core/health.ts';
import { parsePort, READ_ONLY_ANNOTATIONS, text } from '../mcp/kit.ts';
import { redactUsage } from '../remote/redact.ts';
import { ok, reply } from './router.ts';
import type { FeatureModule, Tool } from './types.ts';

declare module '../mcp/kit.ts' {
  interface Core {
    /** usage() joined with the last-used history (who is connected now, who used what before) */
    usage(): Promise<UsageWithHistory>;
    /** The persisted last-used history only (cheap: one file read) */
    history(): Promise<HistoryView>;
    /** Same store as POST /api/clients/name: ~/.config/portboard/clients.json */
    setClientName(key: string, name: string | null): Promise<unknown>;
  }
}

const OPTIONAL_PORT = { type: 'integer', minimum: 1, maximum: 65535, description: 'Only this port' };
const USAGE_SCHEMA = { type: 'object', properties: { port: OPTIONAL_PORT }, additionalProperties: false };
const USAGE_DESCRIPTION =
  'Who uses the services on this server: for each port, the devices connected right now (tailnet devices, LAN ' +
  'devices named from their MAC vendor or by the user, this server\'s own processes, and "Funnel" (kind funnel: the ' +
  'public internet through Tailscale Funnel, e.g. claude.ai\'s connector to the remote MCP)) and the last-used history ' +
  '(who used it last and when, and who used it in the last 7 days with minutes in use). Also lists the devices with ' +
  'their key for name_device. History is sampled every 30 s and kept 30 days; connections shorter than that can be missed.';

export interface UsageReport {
  at: string;
  /** Nothing before this is known */
  historySince: string | null;
  ports: {
    port: number;
    service: string;
    group: string | null;
    now: { device: string; id: string; kind: string; connections: number }[];
    lastUsed: { at: string; by: string } | null;
    /** Devices that used it in the last 7 days */
    recent7d: { device: string; id: string; minutes: number; lastSeen: string }[];
  }[];
  devices: {
    id: string;
    name: string;
    kind: string;
    /** Pass to name_device; null for Tailscale devices (named in Tailscale) */
    nameKey: string | null;
    nameSource: string | null;
    online: boolean | null;
    usingNow: number[];
    lastUsed: string | null;
    recent7d: { port: number; service: string; minutes: number }[];
  }[];
}

/** who_uses / list_usage: ports in use now or with history, and the devices behind them. */
export function usageReport(u: UsageWithHistory, port?: number): UsageReport {
  const h = u.history;
  const names = new Map<number, { service: string; group: string | null }>();
  for (const i of u.idle) names.set(i.port, { service: i.service, group: i.group?.name ?? null });
  for (const r of [...u.cards.flatMap((c) => c.uses), ...u.local.uses]) if (!names.has(r.port)) names.set(r.port, { service: r.service, group: null });
  for (const d of Object.values(h.byDevice)) for (const r of d.recent) if (!names.has(r.port)) names.set(r.port, { service: r.service, group: null });

  const portSet = new Set([...Object.keys(u.byPort), ...Object.keys(h.byPort)].map(Number));
  const ports = [...portSet].filter((p) => port === undefined || p === port).sort((a, b) => a - b);
  const recentFor = (p: number) =>
    Object.entries(h.byDevice)
      .flatMap(([id, d]) => d.recent.filter((r) => r.port === p).map((r) => ({ device: d.name, id, minutes: r.minutes, lastSeen: r.lastSeen })))
      .sort((a, b) => b.minutes - a.minutes);

  const devices: UsageReport['devices'] = u.cards.map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    nameKey: c.nameKey,
    nameSource: c.nameSource,
    online: c.kind === 'lan' || c.kind === 'other' || c.kind === 'funnel' ? null : c.online,
    usingNow: [...new Set(c.uses.map((r) => r.port))].sort((a, b) => a - b),
    lastUsed: h.byDevice[c.id]?.lastSeen ?? null,
    recent7d: (h.byDevice[c.id]?.recent ?? []).map(({ port, service, minutes }) => ({ port, service, minutes })),
  }));
  // Devices only the history knows (a LAN machine that isn't connected now)
  for (const [id, d] of Object.entries(h.byDevice)) {
    if (['local', 'serve', 'docker'].includes(id) || id.endsWith('~routed') || devices.some((x) => x.id === id)) continue;
    devices.push({
      id, name: d.name, kind: d.kind, nameKey: d.nameKey, nameSource: null, online: null, usingNow: [],
      lastUsed: d.lastSeen, recent7d: d.recent.map(({ port, service, minutes }) => ({ port, service, minutes })),
    });
  }
  const relevant = port === undefined ? devices : devices.filter((d) => d.usingNow.includes(port) || d.recent7d.some((r) => r.port === port));

  return {
    at: u.at,
    historySince: h.startedAt,
    ports: ports.map((p) => ({
      port: p,
      service: names.get(p)?.service ?? `:${p}`,
      group: names.get(p)?.group ?? null,
      now: (u.byPort[p] ?? []).map((x) => ({ device: x.name, id: x.id, kind: x.kind, connections: x.connections })),
      lastUsed: h.byPort[p] ? { at: h.byPort[p].at, by: h.byPort[p].name } : null,
      recent7d: recentFor(p),
    })),
    devices: relevant,
  };
}

/** name_device: a nameKey as is, or a device id resolved to its nameKey through the live cards or the history. */
export function resolveNameKey(key: string, u: UsageWithHistory): { ok: true; key: string; device: string | null } | { ok: false; error: string } {
  if (/^(mac|ip):/.test(key)) return { ok: true, key, device: null };
  const card = u.cards.find((c) => c.id === key);
  const nameKey = card ? card.nameKey : (u.history.byDevice[key]?.nameKey ?? null);
  if (nameKey) return { ok: true, key: nameKey, device: key };
  if (card?.kind === 'tailnet' || card?.kind === 'self' || card?.kind === 'pool') {
    return { ok: false, error: `${key} is a Tailscale/compute-pool device; its name comes from there and can't be changed here` };
  }
  return { ok: false, error: `unknown device key: ${key} (use a nameKey or id from who_uses)` };
}

async function whoUses(args: unknown, core: { usage(): Promise<UsageWithHistory> }) {
  const a = (args ?? {}) as Record<string, unknown>;
  let port: number | undefined;
  if (a.port !== undefined && a.port !== null) {
    const p = parsePort(a);
    if (!p.ok) return text(p.error, true);
    port = p.value;
  }
  return text(usageReport(await core.usage(), port));
}

const tools: Tool[] = [
  {
    def: {
      name: 'who_uses',
      title: 'Who uses which port',
      description: USAGE_DESCRIPTION,
      inputSchema: USAGE_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    call: whoUses,
  },
  {
    def: {
      name: 'list_usage',
      title: 'Usage now and last used',
      description: `Same as who_uses. ${USAGE_DESCRIPTION}`,
      inputSchema: USAGE_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    call: whoUses,
  },
  {
    def: {
      name: 'name_device',
      title: 'Name a LAN device',
      description:
        'Give a device a name of your own, shown in the dashboard and in who_uses instead of the MAC-vendor guess or ' +
        'IP. key is a device key from who_uses: its nameKey (mac:aa:bb:cc:dd:ee:ff or ip:192.168.1.7) or its id ' +
        '(lan:192.168.1.7). An empty name clears it. Tailscale devices keep their Tailscale name and cannot be named here.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'nameKey or device id from who_uses' },
          name: { type: 'string', maxLength: 40, description: 'New name; empty clears it' },
        },
        required: ['key', 'name'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async call(args, core) {
      const a = (args ?? {}) as Record<string, unknown>;
      if (typeof a.key !== 'string' || !a.key.trim()) return text('key must be a nameKey or device id from who_uses', true);
      if (a.name !== null && typeof a.name !== 'string') return text('name must be a string (empty clears it)', true);
      const r = resolveNameKey(a.key.trim(), await core.usage());
      if (!r.ok) return text(r.error, true);
      const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : null;
      const problem = checkName({ key: r.key, name });
      if (problem) return text(problem, true);
      await core.setClientName(r.key, name);
      return text({ ok: true, key: r.key, ...(r.device ? { device: r.device } : {}), name });
    },
  },
];

export const usageFeature: FeatureModule = {
  name: 'usage',
  order: 400,
  routes: [
    { method: 'GET', path: '/api/topology', handler: async ({ url }, ctx) => ok(await ctx.topology(url.searchParams.has('fresh'))) },
    { method: 'GET', path: '/api/usage', handler: async ({ url }, ctx) => ok(await ctx.usage(url.searchParams.has('fresh'))) },
    {
      method: 'POST',
      path: '/api/clients/name',
      write: true,
      body: { limit: 4096 },
      async handler({ body }, ctx) {
        const problem = checkName(body);
        if (problem) return reply(400, { error: problem });
        await setName(body.key, body.name);
        // Naming a 새 기기 means it was seen: the badge goes too.
        if (body.name?.trim()) await ctx.known.acknowledge(body.key);
        ctx.invalidate('usage');
        return ok({ ok: true, key: body.key, name: body.name?.trim() || null });
      },
    },
  ],
  tools,
  remoteTools: [
    {
      def: {
      name: 'who_uses_what',
      title: 'Who is using which service',
      description:
        'Which devices are connected to which services on the Portboard server right now: one card per device (tailnet ' +
        'devices, LAN devices, this server itself, and Funnel: the public internet through Tailscale Funnel, which ' +
        'includes this connector) with the ports it uses, connection counts and traffic, plus a per-port ' +
        'list of users and how many visible services nobody is using. LAN devices without a name appear as lan-device-<id>, the same id in every call. ' +
        'Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          port: { type: 'integer', minimum: 1, maximum: 65535, description: 'Only this port (optional)' },
        },
        additionalProperties: false,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      },
      async call(args, core, policy) {
        const raw = (args ?? {}) as Record<string, unknown>;
        if (raw.port !== undefined && (!Number.isInteger(raw.port) || (raw.port as number) < 1 || (raw.port as number) > 65535)) {
          return text('port must be an integer between 1 and 65535', true);
        }
        const out = redactUsage(await core.usage(), policy);
        if (raw.port === undefined) return text(out);
        const port = raw.port as number;
        return text({
          at: out.at,
          port,
          users: out.byPort[port] ?? [],
          cards: out.cards.filter((c) => c.uses.some((u) => u.port === port)).map((c) => ({ ...c, uses: c.uses.filter((u) => u.port === port) })),
        });
      },
    },
  ],
  // Reads the history the server records; the stdio process doesn't sample on its own.
  mcpCore: () => ({
    usage: async () => {
      const [u, h] = await Promise.all([usage(), loadHistory()]);
      return withHistory(u, h);
    },
    history: async () => historyView(await loadHistory(), Date.now()),
    setClientName: (key: string, name: string | null) => setName(key, name),
  }),
  jobs: [
    {
      // Last-used history: sample who is connected even when no browser is open.
      name: 'usage-sample',
      everyMs: Number(process.env.PORTBOARD_SAMPLE_MS ?? 30_000),
      runAtStart: true,
      run: (ctx) =>
        ctx.usage().then(
          () => reportHealth('usage', { ok: true }),
          (err) => {
            console.error(`[portboard] usage sample: ${err}`);
            reportHealth('usage', { ok: false, error: String((err as Error)?.message ?? err) });
          },
        ),
    },
  ],
  shutdown: (ctx) => ctx.history.flush().catch((err) => console.error(`[portboard] history: ${err}`)),
  collectors: ['usage', 'history'],
};
