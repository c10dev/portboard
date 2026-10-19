// Smart defaults (c10dev/portboard#33): suggestions to turn on a down alert or accept a name, never applied by
// themselves, and services nobody has used for weeks (#3), never stopped by them. The rules are src/core/suggest.ts;
// this module collects their inputs (the port snapshot, the 기기 cards and 새 기기, systemd-run units, docker inspect,
// the default gateway, the LAN DNS's PTR answers, the usage history and process start times).
//
//   GET  /api/suggestions                  ({at, suggestions, dismissed}: alert-<port>, idle-<port> and name-<key>)
//   POST /api/suggestions/:id/dismiss      (X-Portboard) 무시: kept in prefs.json, not shown again
//   MCP  list_suggestions (local only: names carry LAN addresses)
//   ui   suggestions.js on the 서비스 page (🔔 알림 켜기? and 💤 N일째 안 씀 on the row); the 기기 page imports it
//        (추천 이름 on the card, pre-filled 이름 붙이기)
//
// Accepting goes through the existing writes: POST /api/ports/:port/prefs {alert: true} / set_alert, and
// POST /api/clients/name / name_device. An idle suggestion has nothing to accept: stopping stays the user's call.

import { Resolver } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { TtlMap, ttlCache } from '../core/cache.ts';
import { SELF_UNIT } from '../core/control.ts';
import { run } from '../core/exec.ts';
import { loadHistory, type History } from '../core/history.ts';
import { snapshot, type PortEntry } from '../core/index.ts';
import { loadKnown, pendingView } from '../core/known.ts';
import { CLK_TCK, parseBtime, parseStat } from '../core/memory.ts';
import { transientUnits } from '../core/owners.ts';
import { dismissSuggestion, loadPrefs } from '../core/prefs.ts';
import { unitOf } from '../core/proc.ts';
import {
  alertSuggestions,
  idleSuggestions,
  nameSuggestions,
  parseDefaultRoutes,
  parseDockerInspect,
  rememberPeers,
  report,
  SUGGESTION_ID,
  type ContainerInfo,
  type NameCard,
  type PeerSightings,
  type PendingDevice,
  type SuggestionsReport,
} from '../core/suggest.ts';
import { usage } from '../core/usage.ts';
import { text } from '../mcp/kit.ts';
import { ok, reply } from './router.ts';
import type { FeatureModule } from './types.ts';

declare module '../mcp/kit.ts' {
  interface Core {
    /** Smart defaults: alerts to turn on and names to accept (src/core/suggest.ts) */
    suggestions?(): Promise<SuggestionsReport>;
  }
}

// ---- inputs (each cached: the 서비스 and 기기 pages ask every 30 s) ----

/** The last `docker inspect` answer, for the same set of containers only */
const containerCache = new TtlMap<string, Map<string, ContainerInfo>>({ ttlMs: 60_000, maxEntries: 1 });

async function containers(names: string[]): Promise<Map<string, ContainerInfo>> {
  const key = [...names].sort().join(',');
  if (!names.length) return new Map();
  const hit = containerCache.get(key);
  if (hit) return hit;
  const r = await run('docker', ['inspect', '--format', '{{.Name}}\t{{.State.StartedAt}}\t{{.HostConfig.RestartPolicy.Name}}', ...names], 5_000);
  const value = parseDockerInspect(r.stdout);
  containerCache.set(key, value);
  return value;
}

const gateways = ttlCache(async () => parseDefaultRoutes((await run('ip', ['route', 'show', 'default'], 3_000)).stdout), { ttlMs: 10 * 60_000 });

/** This process's own unit (portboard.service in production, a systemd-run unit in a preview) */
const ownUnit = ttlCache(async () => unitOf(await readFile('/proc/self/cgroup', 'utf8').catch(() => '')), { ttlMs: 3600_000 });

const PTR_TTL = 10 * 60_000;
/** ip → its PTR name (null: none); bounded, the LAN's addresses come and go */
const ptrCache = new TtlMap<string, string | null>({ ttlMs: PTR_TTL, maxEntries: 1024 });

/** The one call hostnames() makes of a resolver (node:dns's Resolver; a fake in test/suggestions-ptr.test.ts) */
export interface PtrResolver {
  reverse(ip: string): Promise<string[]>;
}

function gatewayResolver(servers: string[]): PtrResolver {
  const resolver = new Resolver({ timeout: 1000, tries: 1 });
  resolver.setServers(servers);
  return resolver;
}

/**
 * PTR names for LAN addresses, asked of the default gateway only (the router is the LAN's DNS and DHCP server; a
 * public resolver would be told our LAN addresses for nothing). No answer within a second is "no name", for 10 min.
 */
export async function hostnames(ips: string[], via: string[], resolverFor: (servers: string[]) => PtrResolver = gatewayResolver, now: () => number = Date.now): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ask = ips.filter((ip) => /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(ip));
  if (!ask.length || !via.length) return out;
  const resolver = resolverFor(via);
  await Promise.all(ask.map(async (ip) => {
    const t = now();
    if (ptrCache.has(ip, t)) {
      const name = ptrCache.get(ip, t);
      if (name) out.set(ip, name);
      return;
    }
    const name = await resolver.reverse(ip).then((n) => n[0] ?? null, () => null);
    ptrCache.set(ip, name, PTR_TTL, now());
    if (name) out.set(ip, name);
  }));
  return out;
}

/** Tailnet peer ↔ LAN address matches this process has seen (7 days; the stdio server only sees the current sample) */
let peerSightings: PeerSightings = new Map();

/** When each process started (ms), by pid; a process that is gone or unreadable is left out */
async function processStarts(pids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!pids.length) return out;
  const btime = parseBtime(await readFile('/proc/stat', 'utf8').catch(() => ''));
  if (btime === null) return out;
  await Promise.all(pids.map(async (pid) => {
    const st = parseStat(await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => ''));
    if (st) out.set(pid, (btime + st.startTicks / CLK_TCK) * 1000);
  }));
  return out;
}

export interface SuggestionSources {
  ports: PortEntry[];
  cards: NameCard[];
  pending: PendingDevice[];
  selfLanIps: string[];
  /** The usage history (history.ts); absent: no idle suggestions */
  history?: History;
}

export async function collect(src: SuggestionSources, now = Date.now()): Promise<SuggestionsReport> {
  const units = [...new Set(src.ports.flatMap((p) => p.processes.map((x) => x.unit).filter((u): u is string => !!u)))];
  const names = [...new Set(src.ports.map((p) => p.container).filter((c): c is string => !!c))];
  const pids = [...new Set(src.ports.flatMap((p) => p.processes.map((x) => x.pid)))];
  const [transient, info, gw, own, prefs, started] = await Promise.all([
    transientUnits(units).catch(() => new Set<string>()),
    containers(names).catch(() => new Map<string, ContainerInfo>()),
    gateways().catch(() => [] as string[]),
    ownUnit().catch(() => null),
    loadPrefs(),
    src.history ? processStarts(pids) : Promise.resolve(new Map<number, number>()),
  ]);
  const lanIps = [...src.cards.filter((c) => c.kind === 'lan').flatMap((c) => c.addresses.length ? c.addresses : c.lanIps), ...src.pending.map((p) => p.ip).filter((ip): ip is string => !!ip)];
  const ptr = await hostnames([...new Set(lanIps)], gw);
  const selfUnits = new Set([SELF_UNIT, ...(own ? [own] : [])]);
  const alerts = alertSuggestions(src.ports, { transient, selfUnits, containers: info, now });
  const idle = src.history
    ? idleSuggestions(src.ports, {
      historySince: src.history.startedAt,
      uses: Object.values(src.history.entries),
      started,
      containers: info,
      selfUnits,
      selfPid: process.pid,
      now,
    })
    : [];
  const notPeers = new Set([...src.selfLanIps, ...gw]);
  peerSightings = rememberPeers(peerSightings, src.cards, notPeers, now);
  const named = nameSuggestions(src.cards, src.pending, { notPeers, hostnames: ptr, seen: peerSightings });
  return report([...alerts, ...idle, ...named],new Set(Object.keys(prefs.suggestions?.dismissed ?? {})), now);
}

export const suggestionsFeature: FeatureModule = {
  name: 'suggestions',
  order: 1900,
  routes: [
    {
      method: 'GET',
      path: '/api/suggestions',
      async handler(_r, ctx) {
        const [s, u] = await Promise.all([ctx.snapshot(), ctx.usage()]);
        return ok(await collect({ ports: s.ports, cards: u.cards, pending: u.newDevices.pending, selfLanIps: u.selfLanIps, history: ctx.history.data }));
      },
    },
    {
      // :device is the router's generic id segment; suggestion ids are made to fit it (suggest.ts SUGGESTION_ID)
      method: 'POST',
      path: '/api/suggestions/:device/dismiss',
      write: true,
      async handler({ params }) {
        const id = params.device;
        if (!SUGGESTION_ID.test(id)) return reply(400, { error: 'id must be a suggestion id (alert-<port>, idle-<port> or name-<key>)' });
        await dismissSuggestion(id);
        return ok({ ok: true, id });
      },
    },
  ],
  tools: [
    {
      def: {
        name: 'list_suggestions',
        title: 'Suggested alerts, device names and unused services',
        description:
          'Smart defaults Portboard suggests and never applies by itself. kind "alert": a port that is pinned, runs as an ' +
          'installed systemd unit or in a long-lived docker container (restart policy, or up for a day) and has no down ' +
          'alert yet; one per unit/container (also: its other ports). Turn it on with set_alert {port, on: true}. kind ' +
          '"name": a LAN device without a user-given name and a better name for it, from the tailnet peer whose direct ' +
          'endpoint is that LAN address (source tailscale), the LAN DNS PTR name (hostname) or a device kind from the MAC ' +
          'vendor (vendor, low confidence); accept with name_device {key, name}. kind "idle": a listening service (systemd ' +
          'unit, container or plain process: owner) nobody has connected to for 14 days (days) according to the usage ' +
          'history, with lastUsed/lastDevice (null: no connection in the 30-day history) and idleDays; one per ' +
          'unit/container. Only once the history spans 14 days, and a port it never saw only when its service is that ' +
          'old; pinned, hidden and system ports are left out. It is a cleanup hint for the user to decide on: nothing ' +
          'stops it. Suggestions the user dismissed in the ' +
          'dashboard are left out (dismissed counts them). Portboard itself is never suggested, and systemd-run units never get an alert suggestion.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async call(_args, core) {
        if (!core.suggestions) return text('list_suggestions is not available here', true);
        return text(await core.suggestions());
      },
    },
  ],
  // Same inputs the server uses, read fresh (the stdio process has no caches of its own).
  mcpCore: () => ({
    suggestions: async () => {
      const [s, u, known, history] = await Promise.all([snapshot(), usage(), loadKnown(), loadHistory()]);
      return collect({ ports: s.ports, cards: u.cards, pending: pendingView(known), selfLanIps: u.selfLanIps, history });
    },
  }),
  ui: [{ pages: ['index.html'], script: 'features/suggestions.js' }],
};
