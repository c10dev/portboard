// Proxmox CPU/memory trends, read-only: the RRD data Proxmox already keeps for each node and guest.
//
//   /nodes/{node}/rrddata?timeframe=hour|day&cf=AVERAGE
//   /nodes/{node}/{qemu|lxc}/{vmid}/rrddata?timeframe=hour|day&cf=AVERAGE
//
// The PVEAuditor role covers both (Sys.Audit on the node, VM.Audit on guests). A call that is refused or fails
// degrades only that node or guest (its entry carries `error`), not the rest. Same token, same pinned TLS and the
// same rule as proxmox.ts: the secret never appears in results or errors. Cached 60 s per timeframe.
//
//   GET /api/proxmox/trends?timeframe=hour   → sparklines on the pve1 card and guest cards (60 points, 1 min)
//   GET /api/proxmox/trends?timeframe=day    → the 24 h view in the detail panel (144 points, 10 min)

import { keyedCache } from './cache.ts';
import { loadConfig, proxmoxStatus, pveGet, PROXMOX_PATH, type ProxmoxConfig, type ProxmoxStatus } from './proxmox.ts';

export type Timeframe = 'hour' | 'day';
export const TIMEFRAMES: Timeframe[] = ['hour', 'day'];
/** Points per series after downsampling */
export const POINTS: Record<Timeframe, number> = { hour: 60, day: 144 };
const TTL = 60_000;

export interface Point {
  /** unix seconds */
  t: number;
  /** fraction of all cores, 0..1 */
  cpu: number | null;
  /** fraction of memory used, 0..1 */
  mem: number | null;
}

export interface Series {
  /** unix seconds of the first bucket */
  start: number;
  /** seconds per bucket */
  step: number;
  /** null where Proxmox has no value (guest stopped, node down, gap) */
  cpu: (number | null)[];
  mem: (number | null)[];
  maxcpu: number | null;
  /** bytes */
  maxmem: number | null;
}

export type Trend = (Series & { error?: undefined }) | { error: string };

export interface Trends {
  configured: boolean;
  /** false when nothing could be read; per-entry errors otherwise */
  ok: boolean;
  error?: string;
  timeframe: Timeframe;
  at: string;
  /** node name → trend */
  nodes: Record<string, Trend>;
  /** "<node>/<vmid>" → trend */
  guests: Record<string, Trend & { name?: string; type?: 'qemu' | 'lxc' }>;
}

// ---------- parsing ----------

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const frac = (a: number | null, b: number | null) => (a !== null && b ? Math.min(1, Math.max(0, a / b)) : null);

/**
 * rrddata rows → points sorted by time. cpu is already a fraction of maxcpu; memory is memused/memtotal on a node
 * and mem/maxmem on a guest (the same numbers the guest list shows). Missing or non-numeric fields are gaps, not 0.
 */
export function parseRrd(data: unknown, kind: 'node' | 'guest'): { points: Point[]; maxcpu: number | null; maxmem: number | null } {
  const rows = (Array.isArray(data) ? data : []).filter((r) => r && typeof r === 'object' && num((r as any).time) !== null) as any[];
  rows.sort((a, b) => a.time - b.time);
  let maxcpu: number | null = null;
  let maxmem: number | null = null;
  const points = rows.map((r): Point => {
    const total = kind === 'node' ? num(r.memtotal) : num(r.maxmem);
    const used = kind === 'node' ? num(r.memused) : num(r.mem);
    maxcpu = num(r.maxcpu) ?? maxcpu;
    maxmem = total ?? maxmem;
    const cpu = num(r.cpu);
    return { t: r.time, cpu: cpu === null ? null : Math.min(1, Math.max(0, cpu)), mem: frac(used, total) };
  });
  return { points, maxcpu, maxmem };
}

const round = (v: number) => Math.round(v * 10_000) / 10_000;

/** Averages consecutive points into at most `buckets` buckets; a bucket with no values stays null. */
export function downsample(points: Point[], buckets: number): Omit<Series, 'maxcpu' | 'maxmem'> {
  if (!points.length) return { start: 0, step: 0, cpu: [], mem: [] };
  const n = points.length;
  const step0 = n > 1 ? (points[n - 1].t - points[0].t) / (n - 1) : 60;
  const size = Math.max(1, Math.ceil(n / Math.max(1, buckets)));
  const cpu: (number | null)[] = [];
  const mem: (number | null)[] = [];
  for (let i = 0; i < n; i += size) {
    const chunk = points.slice(i, i + size);
    for (const [key, out] of [['cpu', cpu], ['mem', mem]] as const) {
      const vals = chunk.map((p) => p[key]).filter((v): v is number => v !== null);
      out.push(vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length) : null);
    }
  }
  return { start: points[0].t, step: Math.round(step0 * size), cpu, mem };
}

export function toSeries(data: unknown, kind: 'node' | 'guest', buckets: number): Series {
  const { points, maxcpu, maxmem } = parseRrd(data, kind);
  return { ...downsample(points, buckets), maxcpu, maxmem };
}

/** A refused call names the permission, never the token. */
export function trendError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/HTTP 403/.test(msg)) return 'the token may not read rrddata (needs Sys.Audit / VM.Audit, which PVEAuditor has)';
  return msg;
}

// ---------- fetching (cached) ----------

export interface TrendSource {
  status(): Promise<ProxmoxStatus>;
  config(): Promise<ProxmoxConfig | null>;
  get(cfg: ProxmoxConfig, path: string): Promise<unknown>;
}

const defaultSource = (path: string): TrendSource => ({
  status: () => proxmoxStatus(path),
  config: async () => (await loadConfig(path)).cfg,
  get: (cfg, p) => pveGet(cfg, p),
});

export async function fetchTrends(timeframe: Timeframe, src: TrendSource, now = Date.now()): Promise<Trends> {
  const base = { timeframe, at: new Date(now).toISOString(), nodes: {}, guests: {} };
  const st = await src.status();
  if (!st.configured || !st.ok) return { ...base, configured: st.configured, ok: false, ...(st.error ? { error: st.error } : {}) };
  const cfg = await src.config();
  if (!cfg) return { ...base, configured: true, ok: false, error: 'proxmox.json could not be read' };
  const q = `rrddata?timeframe=${timeframe}&cf=AVERAGE`;
  const one = async (path: string, kind: 'node' | 'guest'): Promise<Trend> => {
    try {
      return toSeries(await src.get(cfg, path), kind, POINTS[timeframe]);
    } catch (err) {
      return { error: trendError(err) };
    }
  };
  const nodes: Trends['nodes'] = {};
  const guests: Trends['guests'] = {};
  await Promise.all(
    st.hosts.map(async (h) => {
      const node = encodeURIComponent(h.node);
      if (h.status !== 'online') {
        nodes[h.node] = { error: `node is ${h.status}` };
        return;
      }
      await Promise.all([
        one(`/nodes/${node}/${q}`, 'node').then((t) => (nodes[h.node] = t)),
        ...h.guests.map((g) =>
          one(`/nodes/${node}/${g.type}/${g.vmid}/${q}`, 'guest').then((t) => (guests[`${h.node}/${g.vmid}`] = { ...t, name: g.name, type: g.type })),
        ),
      ]);
    }),
  );
  const all = [...Object.values(nodes), ...Object.values(guests)];
  const ok = all.some((t) => !t.error);
  const firstError = all.find((t) => t.error)?.error;
  return { ...base, configured: true, ok, ...(!ok && firstError ? { error: firstError } : {}), nodes, guests };
}

const cache = keyedCache((timeframe: Timeframe, path: string) => fetchTrends(timeframe, defaultSource(path)), { ttlMs: TTL, maxEntries: 8 });

export function proxmoxTrends(timeframe: Timeframe, path = PROXMOX_PATH): Promise<Trends> {
  return cache(timeframe, path);
}

export function resetTrendsCache() {
  cache.clear();
}
