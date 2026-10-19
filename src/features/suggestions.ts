// Smart defaults (c10dev/portboard#33): suggestions to turn on a down alert or accept a name, never applied by
// themselves. The rules are src/core/suggest.ts; this module collects their inputs (the port snapshot, the 기기 cards
// and 새 기기, systemd-run units, docker inspect, the default gateway, the LAN DNS's PTR answers).
//
//   GET  /api/suggestions                  ({at, suggestions, dismissed}: alert-<port> and name-<key> entries)
//   POST /api/suggestions/:id/dismiss      (X-Portboard) 무시: kept in prefs.json, not shown again
//   MCP  list_suggestions (local only: names carry LAN addresses)
//   ui   suggestions.js on the 서비스 page (🔔 알림 켜기? on the row); the 기기 page imports it (추천 이름 on the card,
//        pre-filled 이름 붙이기)
//
// Accepting goes through the existing writes: POST /api/ports/:port/prefs {alert: true} / set_alert, and
// POST /api/clients/name / name_device.

import { Resolver } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { SELF_UNIT } from '../core/control.ts';
import { run } from '../core/exec.ts';
import { snapshot, type PortEntry } from '../core/index.ts';
import { loadKnown, pendingView } from '../core/known.ts';
import { transientUnits } from '../core/owners.ts';
import { dismissSuggestion, loadPrefs } from '../core/prefs.ts';
import { unitOf } from '../core/proc.ts';
import {
  alertSuggestions,
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

function cached<T>(ms: number, load: () => Promise<T>): () => Promise<T> {
  let hit: { at: number; value: Promise<T> } | null = null;
  return () => {
    if (hit && Date.now() - hit.at < ms) return hit.value;
    const value = load();
    hit = { at: Date.now(), value };
    value.catch(() => (hit = null));
    return value;
  };
}

let containerCache: { at: number; key: string; value: Map<string, ContainerInfo> } | null = null;

async function containers(names: string[]): Promise<Map<string, ContainerInfo>> {
  const key = [...names].sort().join(',');
  if (!names.length) return new Map();
  if (containerCache && containerCache.key === key && Date.now() - containerCache.at < 60_000) return containerCache.value;
  const r = await run('docker', ['inspect', '--format', '{{.Name}}\t{{.State.StartedAt}}\t{{.HostConfig.RestartPolicy.Name}}', ...names], 5_000);
  const value = parseDockerInspect(r.stdout);
  containerCache = { at: Date.now(), key, value };
  return value;
}

const gateways = cached(10 * 60_000, async () => parseDefaultRoutes((await run('ip', ['route', 'show', 'default'], 3_000)).stdout));

/** This process's own unit (portboard.service in production, a systemd-run unit in a preview) */
const ownUnit = cached(3600_000, async () => unitOf(await readFile('/proc/self/cgroup', 'utf8').catch(() => '')));

const PTR_TTL = 10 * 60_000;
const ptrCache = new Map<string, { at: number; name: string | null }>();

/**
 * PTR names for LAN addresses, asked of the default gateway only (the router is the LAN's DNS and DHCP server; a
 * public resolver would be told our LAN addresses for nothing). No answer within a second is "no name", for 10 min.
 */
async function hostnames(ips: string[], via: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ask = ips.filter((ip) => /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(ip));
  if (!ask.length || !via.length) return out;
  const resolver = new Resolver({ timeout: 1000, tries: 1 });
  resolver.setServers(via);
  await Promise.all(ask.map(async (ip) => {
    const hit = ptrCache.get(ip);
    if (hit && Date.now() - hit.at < PTR_TTL) {
      if (hit.name) out.set(ip, hit.name);
      return;
    }
    const name = await resolver.reverse(ip).then((n) => n[0] ?? null, () => null);
    ptrCache.set(ip, { at: Date.now(), name });
    if (name) out.set(ip, name);
  }));
  return out;
}

/** Tailnet peer ↔ LAN address matches this process has seen (7 days; the stdio server only sees the current sample) */
let peerSightings: PeerSightings = new Map();

export interface SuggestionSources {
  ports: PortEntry[];
  cards: NameCard[];
  pending: PendingDevice[];
  selfLanIps: string[];
}

export async function collect(src: SuggestionSources, now = Date.now()): Promise<SuggestionsReport> {
  const units = [...new Set(src.ports.flatMap((p) => p.processes.map((x) => x.unit).filter((u): u is string => !!u)))];
  const names = [...new Set(src.ports.map((p) => p.container).filter((c): c is string => !!c))];
  const [transient, info, gw, own, prefs] = await Promise.all([
    transientUnits(units).catch(() => new Set<string>()),
    containers(names).catch(() => new Map<string, ContainerInfo>()),
    gateways().catch(() => [] as string[]),
    ownUnit().catch(() => null),
    loadPrefs(),
  ]);
  const lanIps = [...src.cards.filter((c) => c.kind === 'lan').flatMap((c) => c.addresses.length ? c.addresses : c.lanIps), ...src.pending.map((p) => p.ip).filter((ip): ip is string => !!ip)];
  const ptr = await hostnames([...new Set(lanIps)], gw);
  const alerts = alertSuggestions(src.ports, { transient, selfUnits: new Set([SELF_UNIT, ...(own ? [own] : [])]), containers: info, now });
  const notPeers = new Set([...src.selfLanIps, ...gw]);
  peerSightings = rememberPeers(peerSightings, src.cards, notPeers, now);
  const named = nameSuggestions(src.cards, src.pending, { notPeers, hostnames: ptr, seen: peerSightings });
  return report([...alerts, ...named], new Set(Object.keys(prefs.suggestions?.dismissed ?? {})), now);
}

export const suggestionsFeature: FeatureModule = {
  name: 'suggestions',
  routes: [
    {
      method: 'GET',
      path: '/api/suggestions',
      async handler(_r, ctx) {
        const [s, u] = await Promise.all([ctx.snapshot(), ctx.usage()]);
        return ok(await collect({ ports: s.ports, cards: u.cards, pending: u.newDevices.pending, selfLanIps: u.selfLanIps }));
      },
    },
    {
      // :device is the router's generic id segment; suggestion ids are made to fit it (suggest.ts SUGGESTION_ID)
      method: 'POST',
      path: '/api/suggestions/:device/dismiss',
      write: true,
      async handler({ params }) {
        const id = params.device;
        if (!SUGGESTION_ID.test(id)) return reply(400, { error: 'id must be a suggestion id (alert-<port> or name-<key>)' });
        await dismissSuggestion(id);
        return ok({ ok: true, id });
      },
    },
  ],
  tools: [
    {
      def: {
        name: 'list_suggestions',
        title: 'Suggested alerts and device names',
        description:
          'Smart defaults Portboard suggests and never applies by itself. kind "alert": a port that is pinned, runs as an ' +
          'installed systemd unit or in a long-lived docker container (restart policy, or up for a day) and has no down ' +
          'alert yet; one per unit/container (also: its other ports). Turn it on with set_alert {port, on: true}. kind ' +
          '"name": a LAN device without a user-given name and a better name for it, from the tailnet peer whose direct ' +
          'endpoint is that LAN address (source tailscale), the LAN DNS PTR name (hostname) or a device kind from the MAC ' +
          'vendor (vendor, low confidence); accept with name_device {key, name}. Suggestions the user dismissed in the ' +
          'dashboard are left out (dismissed counts them). Portboard itself and systemd-run units are never suggested.',
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
      const [s, u, known] = await Promise.all([snapshot(), usage(), loadKnown()]);
      return collect({ ports: s.ports, cards: u.cards, pending: pendingView(known), selfLanIps: u.selfLanIps });
    },
  }),
  ui: [{ pages: ['index.html'], script: 'features/suggestions.js' }],
};
