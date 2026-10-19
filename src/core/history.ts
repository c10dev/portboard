// Last-used history: which device used which port, and when. Live connections are forgotten as soon as they
// close, so the server samples usage() about every 30 s and keeps, per (device, port):
//   firstSeen, lastSeen, activeSince (start of the current run of use), samples, minutes per UTC day
// for 30 days, in ~/.local/state/portboard/usage-history.json (override with PORTBOARD_HISTORY).
//
// Writes are atomic (tmp + rename), throttled, and merge with what is on disk first, taking the max of each counter:
// two Portboard processes observing the same machine (production and a preview) can share the file without
// double-counting. Connections that open and close between two samples are not seen.
//
//   HistoryStore.record(samplesOf(usage), now) → withHistory(usage, store.data, now)

import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from './paths.ts';
import type { DeviceCard, Usage, UseRow } from './usage.ts';
import { reportHealth } from './health.ts';
import { writePrivate } from './atomic.ts';
import { t } from './i18n.ts';

export const HISTORY_PATH = PATHS.history;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const RETENTION_MS = 30 * DAY;
/** A pair not seen for longer than this starts a new run of use (activeSince) */
export const ACTIVE_GAP_MS = 5 * MIN;
/** Time credited between two samples is capped at this; a first or isolated sample counts as SAMPLE_MS */
const MAX_STEP_MS = 90_000;
export const SAMPLE_MS = 30_000;
const MAX_ENTRIES = 2000;

export interface HistEntry {
  /** usage card id (Tailscale DNS label, lan:<ip>, pool:<name>…), `local` for this server, `<id>~routed` for subnet-router traffic */
  device: string;
  port: number;
  /** Device and service display names when last seen, so idle rows can show them without the live data */
  name: string;
  service: string;
  kind: string;
  /** clients.json key for naming it (mac:… / ip:…), when it can be named */
  nameKey: string | null;
  firstSeen: number;
  lastSeen: number;
  activeSince: number;
  /** Times seen (one per sample) */
  samples: number;
  /** Most connections seen at once */
  peak: number;
  /** Minutes in use per UTC day, "2026-10-17": 42.5 */
  days: Record<string, number>;
}

export interface History {
  version: 1;
  /** When this history began (first record ever, kept across restarts) */
  startedAt: number | null;
  entries: Record<string, HistEntry>;
}

export interface Sample {
  device: string;
  name: string;
  kind: string;
  nameKey: string | null;
  port: number;
  service: string;
  connections: number;
}

export const emptyHistory = (): History => ({ version: 1, startedAt: null, entries: {} });
const keyOf = (device: string, port: number) => `${device}|${port}`;
export const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/** One sample per (device, port) from a usage() result: routed traffic under `<router>~routed`, this server's processes under `local`. */
export function samplesOf(u: Pick<Usage, 'cards' | 'local'>): Sample[] {
  const out = new Map<string, Sample>();
  const add = (device: string, name: string, kind: string, nameKey: string | null, r: UseRow) => {
    const k = keyOf(device, r.port);
    const s = out.get(k);
    if (s) s.connections += r.connections;
    else out.set(k, { device, name, kind, nameKey, port: r.port, service: r.service, connections: r.connections });
  };
  for (const c of u.cards) {
    for (const r of c.uses) {
      if (r.routed) add(`${c.id}~routed`, t('usageMsg.routed', { name: c.name }), 'routed', null, r);
      else add(c.id, c.name, c.kind, c.nameKey, r);
    }
  }
  for (const r of u.local.uses) add('local', t('common.thisServer'), 'local', null, r);
  return [...out.values()];
}

/** Adds one observation of everything in use right now. Mutates h. */
export function record(h: History, samples: Sample[], now: number): void {
  h.startedAt ??= now;
  const day = dayOf(now);
  for (const s of samples) {
    const k = keyOf(s.device, s.port);
    const e = h.entries[k];
    if (!e) {
      h.entries[k] = {
        device: s.device, port: s.port, name: s.name, service: s.service, kind: s.kind, nameKey: s.nameKey,
        firstSeen: now, lastSeen: now, activeSince: now, samples: 1, peak: s.connections,
        days: { [day]: SAMPLE_MS / MIN },
      };
      continue;
    }
    if (now <= e.lastSeen) continue; // same instant (or a clock step back): nothing new to credit
    const gap = now - e.lastSeen;
    if (gap > ACTIVE_GAP_MS) e.activeSince = now;
    const credit = gap <= MAX_STEP_MS ? gap : SAMPLE_MS;
    e.days[day] = round2((e.days[day] ?? 0) + credit / MIN);
    e.lastSeen = now;
    e.samples++;
    e.peak = Math.max(e.peak, s.connections);
    e.name = s.name;
    e.service = s.service;
    e.kind = s.kind;
    e.nameKey = s.nameKey;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Drops day buckets and pairs older than the retention window, and the oldest pairs past MAX_ENTRIES. Mutates h. */
export function prune(h: History, now: number, retention = RETENTION_MS): void {
  const cutoff = now - retention;
  const oldestDay = dayOf(cutoff);
  for (const [k, e] of Object.entries(h.entries)) {
    if (e.lastSeen < cutoff) {
      delete h.entries[k];
      continue;
    }
    for (const d of Object.keys(e.days)) if (d < oldestDay) delete e.days[d];
    if (e.firstSeen < cutoff) e.firstSeen = cutoff;
    if (e.activeSince < e.firstSeen) e.activeSince = e.firstSeen;
  }
  const keys = Object.keys(h.entries);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => h.entries[b].lastSeen - h.entries[a].lastSeen);
    for (const k of keys.slice(MAX_ENTRIES)) delete h.entries[k];
  }
  if (h.startedAt !== null && h.startedAt < cutoff) h.startedAt = cutoff;
}

/**
 * Two observers of the same machine: per pair the earliest firstSeen, the latest lastSeen (with its activeSince and
 * names), and the larger of each counter. Summing would count the same minutes twice.
 */
export function mergeHistory(a: History, b: History): History {
  const out: History = {
    version: 1,
    startedAt: a.startedAt === null ? b.startedAt : b.startedAt === null ? a.startedAt : Math.min(a.startedAt, b.startedAt),
    entries: {},
  };
  for (const k of new Set([...Object.keys(a.entries), ...Object.keys(b.entries)])) {
    const x = a.entries[k];
    const y = b.entries[k];
    if (!x || !y) {
      out.entries[k] = structuredClone(x ?? y);
      continue;
    }
    const newer = y.lastSeen > x.lastSeen ? y : x;
    const days: Record<string, number> = { ...x.days };
    for (const [d, m] of Object.entries(y.days)) days[d] = Math.max(days[d] ?? 0, m);
    out.entries[k] = {
      ...newer,
      firstSeen: Math.min(x.firstSeen, y.firstSeen),
      lastSeen: newer.lastSeen,
      activeSince: newer.activeSince,
      samples: Math.max(x.samples, y.samples),
      peak: Math.max(x.peak, y.peak),
      days,
    };
  }
  return out;
}

/** Accepts only well-formed entries, so a hand-edited or truncated file can't break the dashboard. */
export function parseHistory(text: string): History {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyHistory();
  }
  const h = emptyHistory();
  if (typeof raw?.startedAt === 'number') h.startedAt = raw.startedAt;
  for (const [k, e] of Object.entries<any>(raw?.entries ?? {})) {
    if (!e || typeof e.device !== 'string' || !Number.isInteger(e.port)) continue;
    if (![e.firstSeen, e.lastSeen, e.activeSince].every((t) => typeof t === 'number' && Number.isFinite(t))) continue;
    const days: Record<string, number> = {};
    for (const [d, m] of Object.entries<any>(e.days ?? {})) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && typeof m === 'number') days[d] = m;
    h.entries[k] = {
      device: e.device, port: e.port,
      name: typeof e.name === 'string' ? e.name : e.device,
      service: typeof e.service === 'string' ? e.service : `:${e.port}`,
      kind: typeof e.kind === 'string' ? e.kind : 'other',
      nameKey: typeof e.nameKey === 'string' ? e.nameKey : null,
      firstSeen: e.firstSeen, lastSeen: e.lastSeen, activeSince: e.activeSince,
      samples: Number.isInteger(e.samples) ? e.samples : 1,
      peak: typeof e.peak === 'number' ? e.peak : 1,
      days,
    };
  }
  return h;
}

export async function loadHistory(path = HISTORY_PATH, now = Date.now()): Promise<History> {
  try {
    const h = parseHistory(await readFile(path, 'utf8'));
    prune(h, now);
    return h;
  } catch {
    return emptyHistory();
  }
}

/** In-memory history for the server process: record() on every usage result, flush() at most every minWriteMs. */
export class HistoryStore {
  data: History = emptyHistory();
  private dirty = false;
  private lastWrite = 0;
  private writing: Promise<void> | null = null;
  readonly path: string;
  readonly minWriteMs: number;

  constructor(path = HISTORY_PATH, minWriteMs = 60_000) {
    this.path = path;
    this.minWriteMs = minWriteMs;
  }

  async open(now = Date.now()): Promise<this> {
    this.data = await loadHistory(this.path, now);
    this.lastWrite = now;
    return this;
  }

  record(samples: Sample[], now = Date.now()): void {
    record(this.data, samples, now);
    this.dirty = true;
    if (now - this.lastWrite >= this.minWriteMs) void this.flush(now).catch((err) => console.error(`[portboard] history: ${err}`));
  }

  /** Reload, merge, prune and write atomically. One write at a time. */
  flush(now = Date.now()): Promise<void> {
    if (!this.dirty) return this.writing ?? Promise.resolve();
    if (this.writing) return this.writing;
    this.dirty = false;
    this.lastWrite = now;
    this.writing = (async () => {
      const disk = await loadHistory(this.path, now);
      const merged = mergeHistory(disk, this.data);
      prune(merged, now);
      this.data = merged;
      await writePrivate(this.path, () => JSON.stringify(merged));
      reportHealth('history', { ok: true });
    })()
      .catch((err) => {
        this.dirty = true;
        reportHealth('history', { ok: false, error: `cannot write usage-history.json (${(err as NodeJS.ErrnoException).code ?? 'error'})` });
        throw err;
      })
      .finally(() => (this.writing = null));
    return this.writing;
  }
}

// ---- views ----

export interface LastUse {
  at: string;
  device: string;
  name: string;
  kind: string;
}

export interface RecentUse {
  port: number;
  service: string;
  /** Minutes in use over the last 7 days (whole UTC days) */
  minutes: number;
  lastSeen: string;
}

export interface DeviceHistory {
  name: string;
  kind: string;
  nameKey: string | null;
  lastSeen: string;
  /** Most used first */
  recent: RecentUse[];
}

export interface HistoryView {
  /** When this history began; nothing before it is known */
  startedAt: string | null;
  /** Per port: who used it last (any device, including this server's own processes) */
  byPort: Record<number, LastUse & { devices7d: number }>;
  byDevice: Record<string, DeviceHistory>;
}

export function historyView(h: History, now: number, windowDays = 7): HistoryView {
  const fromDay = dayOf(now - (windowDays - 1) * DAY);
  const byPort: HistoryView['byPort'] = {};
  const byDevice: HistoryView['byDevice'] = {};
  const weekDevices = new Map<number, Set<string>>();
  for (const e of Object.values(h.entries)) {
    const last: LastUse = { at: iso(e.lastSeen), device: e.device, name: e.name, kind: e.kind };
    const p = byPort[e.port];
    if (!p || e.lastSeen > Date.parse(p.at)) byPort[e.port] = { ...last, devices7d: 0 };
    const minutes = round2(Object.entries(e.days).reduce((a, [d, m]) => (d >= fromDay ? a + m : a), 0));
    if (minutes > 0) {
      const set = weekDevices.get(e.port) ?? new Set();
      set.add(e.device);
      weekDevices.set(e.port, set);
    }
    const d = (byDevice[e.device] ??= { name: e.name, kind: e.kind, nameKey: e.nameKey, lastSeen: last.at, recent: [] });
    if (e.lastSeen >= Date.parse(d.lastSeen)) Object.assign(d, { name: e.name, kind: e.kind, nameKey: e.nameKey ?? d.nameKey, lastSeen: last.at });
    if (minutes > 0) d.recent.push({ port: e.port, service: e.service, minutes, lastSeen: last.at });
  }
  for (const [port, set] of weekDevices) if (byPort[port]) byPort[port].devices7d = set.size;
  for (const d of Object.values(byDevice)) d.recent.sort((a, b) => b.minutes - a.minutes || a.port - b.port);
  return { startedAt: h.startedAt === null ? null : iso(h.startedAt), byPort, byDevice };
}

const iso = (t: number) => new Date(t).toISOString();

export interface UseHistory {
  /** First time this device was seen using this port (within the retention window) */
  firstSeen: string | null;
  /** Start of the current run of use, carried across Portboard restarts */
  activeSince: string | null;
}

export type UsageWithHistory = Omit<Usage, 'cards' | 'local'> & {
  cards: (DeviceCard & { uses: (UseRow & UseHistory)[] })[];
  local: { connections: number; uses: (UseRow & UseHistory)[] };
  history: HistoryView;
};

/**
 * Joins the history into a usage() result. A use row's `since` (when this process first saw the connection) moves
 * back to the persisted activeSince when that is earlier, so a Portboard restart no longer resets "언제부터".
 */
export function withHistory(u: Usage, h: History, now = Date.now()): UsageWithHistory {
  const join = (device: string, r: UseRow): UseRow & UseHistory => {
    const e = h.entries[keyOf(device, r.port)];
    if (!e) return { ...r, firstSeen: null, activeSince: null };
    const active = iso(e.activeSince);
    return { ...r, since: active < r.since ? active : r.since, firstSeen: iso(e.firstSeen), activeSince: active };
  };
  return {
    ...u,
    cards: u.cards.map((c) => ({ ...c, uses: c.uses.map((r) => join(r.routed ? `${c.id}~routed` : c.id, r)) })),
    local: { ...u.local, uses: u.local.uses.map((r) => join('local', r)) },
    history: historyView(h, now),
  };
}
