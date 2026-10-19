// One service (port) in full, for service.html#<port>, GET /api/ports/:port/detail and the service_detail MCP tool:
// what it is (the snapshot entry), who is connected now, who used it before (devices × last seen, from the
// last-used history), its up/down history when watched (uptime.ts) and the alerts sent about it.
//
// Pure: the REST server passes its cached snapshot/usage and the checker's live status, the MCP process passes what
// it reads from disk.

import type { PortEntry } from './index.ts';
import type { WatchStatus } from './alerts.ts';
import type { History, UsageWithHistory } from './history.ts';
import type { UptimeDetail } from './uptime.ts';

const DAY = 24 * 60 * 60_000;

export interface DetailInput {
  port: number;
  now: number;
  ports: PortEntry[];
  usage: UsageWithHistory | null;
  history: History | null;
  /** The checker's status entry for `port:<port>`, when watched */
  watch: WatchStatus | null;
  uptime: UptimeDetail | null;
  events: { t: string; kind: string; title: string; ok: boolean }[];
}

export interface UserNow {
  id: string;
  name: string;
  kind: string;
  /** Subnet router it came through */
  via?: string;
  connections: number;
  /** Start of the current run of use (persisted, so a Portboard restart doesn't reset it) */
  since: string | null;
}

export interface PastUse {
  device: string;
  name: string;
  kind: string;
  firstSeen: string;
  lastSeen: string;
  /** Minutes with at least one connection open, last 7 days / last 30 days (whole UTC days) */
  minutes7d: number;
  minutes30d: number;
  /** Most connections seen at once */
  peak: number;
}

export interface ServiceDetail {
  at: string;
  port: number;
  name: string;
  listening: boolean;
  /** The snapshot entry (owner, scope, URLs, what restart/stop act on); null while nothing listens */
  entry: PortEntry | null;
  usingNow: UserNow[];
  /** Every device the history knows for this port, most recent first */
  lastUsed: PastUse[];
  /** Nothing before this is known */
  historySince: string | null;
  watched: boolean;
  watch: WatchStatus | null;
  uptime: UptimeDetail | null;
  events: DetailInput['events'];
}

const iso = (t: number) => new Date(t).toISOString();
const round1 = (n: number) => Math.round(n * 10) / 10;

/** null when Portboard knows nothing about the port: not listening, not served, not watched, no history. */
export function serviceDetail(i: DetailInput): ServiceDetail | null {
  const entry = i.ports.find((p) => p.port === i.port && p.listening) ?? i.ports.find((p) => p.port === i.port) ?? null;
  const entries = Object.values(i.history?.entries ?? {}).filter((e) => e.port === i.port);
  if (!entry && !i.watch && !entries.length && !i.uptime) return null;

  const fromDay7 = iso(i.now - 6 * DAY).slice(0, 10);
  const fromDay30 = iso(i.now - 29 * DAY).slice(0, 10);
  const sum = (days: Record<string, number>, from: string) => round1(Object.entries(days).reduce((a, [d, m]) => (d >= from ? a + m : a), 0));
  const lastUsed: PastUse[] = entries
    .map((e) => ({
      device: e.device, name: e.name, kind: e.kind, firstSeen: iso(e.firstSeen), lastSeen: iso(e.lastSeen),
      minutes7d: sum(e.days, fromDay7), minutes30d: sum(e.days, fromDay30), peak: e.peak,
    }))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || a.device.localeCompare(b.device));

  const listening = !!entry?.listening;
  const usingNow: UserNow[] = listening
    ? (i.usage?.byPort[i.port] ?? []).map((u) => {
        const rows = u.kind === 'local' ? i.usage!.local.uses : (i.usage!.cards.find((c) => c.id === (u.via ?? u.id))?.uses ?? []);
        const row = rows.find((r) => r.port === i.port && (u.kind === 'routed') === !!r.routed);
        return { id: u.id, name: u.name, kind: u.kind, ...(u.via ? { via: u.via } : {}), connections: u.connections, since: row?.since ?? null };
      })
    : [];

  const name = entry?.listening ? entry.name : (i.watch?.name ?? entry?.name ?? entries.sort((a, b) => b.lastSeen - a.lastSeen)[0]?.service ?? `:${i.port}`);
  return {
    at: iso(i.now),
    port: i.port,
    name,
    listening,
    entry,
    usingNow,
    lastUsed,
    historySince: i.history?.startedAt ? iso(i.history.startedAt) : null,
    watched: !!i.watch || !!entry?.alert,
    watch: i.watch,
    uptime: i.uptime,
    events: i.events,
  };
}
