// 채택 지표 (c10dev/portboard#40): how Claude Code sessions on this machine handle ports — Portboard MCP calls vs raw
// ss/lsof/kill and servers started on hard-coded ports — from their transcripts (src/core/adoption.ts).
//
//   GET  /api/adoption          ?days=1–7 (default 7): that many KST days ending today, and the same span before;
//                               from the cached scan (scanning: true while one runs); ?refresh starts a scan, at most
//                               one forced per 10 min (refresh: started | running | throttled, with a note unless started)
//   MCP  adoption_stats (read, local only: project names and habits are nothing for the internet)
//   job  adoption-scan: hourly check, rescans when the cache is a day old (so about once a day, and once at start
//        when there is none). Scanning reads hundreds of MB, so no request ever does it.
//   digest  one info line (Claude 세션 포트 사용) over the digest period's whole KST days, from the same cache
//
// Cache: <state dir>/adoption.json (a preview has its own, so it scans once by itself).

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivate } from '../core/atomic.ts';
import { dayMinus, kstDate, parseScan, scanTranscripts, viewOf, type AdoptionView, type Scan, type Totals } from '../core/adoption.ts';
import { PATHS } from '../core/paths.ts';
import { gate, type GateState } from '../core/throttle.ts';
import { text } from '../mcp/kit.ts';
import { ok, reply } from './router.ts';
import type { FeatureModule, Tool } from './types.ts';
import type { McpUse } from '../core/memory.ts';

declare module '../mcp/kit.ts' {
  interface Core {
    /** Claude sessions' port use over `days` days and the days before (refresh: scan now instead of the cache) */
    adoption?(days: number, refresh?: boolean): Promise<AdoptionView & { note?: string }>;
  }
}

/** Days a scan covers: two 7-day windows, plus the day a digest's "whole days before the slot" reaches back */
export const SCAN_DAYS = 15;
export const MAX_DAYS = 7;
/** A forced scan (?refresh, MCP refresh: true) is accepted at most once per this long (L1) */
export const FORCE_MIN_MS = 10 * 60_000;
/** A cache older than this is rescanned by the job */
export const STALE_MS = 24 * 3_600_000;
const DAY = 86_400_000;

export interface AdoptionStore {
  /** The cached scan (memory, else the file), or null */
  load(): Promise<Scan | null>;
  /** Scan now (one at a time; callers during a scan share it) and save */
  refresh(): Promise<Scan | null>;
  /**
   * ?refresh / MCP refresh: true. Like refresh(), but a forced scan is accepted at most once per FORCE_MIN_MS
   * (docs/security-review/v1.0.md L1); sooner, the answer is the running or cached scan and `note` says so.
   */
  forceRefresh(): { state: GateState; note: string | null; done: Promise<Scan | null> };
  /** Rescan when there is no cache or it is older than STALE_MS; returns what it did (tests) */
  refreshIfStale(): Promise<'fresh' | 'scanned'>;
  scanning(): boolean;
}

export function createAdoptionStore(opts: { path: string; root?: string; now?(): number; scan?: typeof scanTranscripts; forceMinMs?: number }): AdoptionStore {
  const now = opts.now ?? Date.now;
  const forceGate = gate({ minMs: opts.forceMinMs ?? FORCE_MIN_MS, now });
  const scan = opts.scan ?? scanTranscripts;
  let last: Scan | null = null;
  let loaded = false;
  let inflight: Promise<Scan | null> | null = null;

  async function load(): Promise<Scan | null> {
    if (!loaded) {
      last = await readFile(opts.path, 'utf8').then(parseScan, () => null);
      loaded = true;
    }
    return last;
  }

  async function save(s: Scan): Promise<void> {
    await writePrivate(opts.path, JSON.stringify(s));
  }

  function refresh(): Promise<Scan | null> {
    inflight ??= scan({ root: opts.root, days: SCAN_DAYS, now: now() })
      .then(async (s) => {
        last = s;
        loaded = true;
        await save(s).catch(() => {});
        return s;
      })
      .catch(() => load())
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return {
    load,
    refresh,
    forceRefresh() {
      const state = forceGate.ask(!!inflight);
      const note = forceGate.note(state, 'A transcript scan');
      return { state, note, done: state === 'throttled' ? load() : refresh() };
    },
    async refreshIfStale() {
      const s = await load();
      const age = s ? now() - Date.parse(s.at) : Infinity;
      if (age < STALE_MS && s && s.to === kstDate(now())) return 'fresh';
      // another process (the stdio MCP server) may have scanned since
      const mtime = await stat(opts.path).then((st) => st.mtimeMs, () => 0);
      if (s && mtime && now() - mtime < STALE_MS && s.to === kstDate(now())) return 'fresh';
      await refresh();
      return 'scanned';
    },
    scanning: () => !!inflight,
  };
}

const store = createAdoptionStore({ path: join(PATHS.stateDir, 'adoption.json') });

/** For the digest: whole KST days before the period's end, as many as the period spans, and the span before. */
export async function adoptionForDigest(period: { from: number; to: number }): Promise<{ current: Totals; previous: Totals | null } | null> {
  const scan = await store.load();
  const days = Math.max(1, Math.min(MAX_DAYS, Math.round((period.to - period.from) / DAY)));
  const v = viewOf(scan, days, false, dayMinus(kstDate(period.to), 1));
  return v.current ? { current: v.current.totals, previous: v.previous?.totals ?? null } : null;
}

/** For the memory view (src/features/memory.ts): MCP calls per server over the last MAX_DAYS days; null before a scan counted them. */
export async function mcpUseForMemory(): Promise<McpUse | null> {
  const c = viewOf(await store.load(), MAX_DAYS).current;
  return c?.mcpServers ? { days: MAX_DAYS, sessions: c.totals.sessions, servers: c.mcpServers } : null;
}

const daysArg = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return MAX_DAYS;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= MAX_DAYS ? n : null;
};

async function view(days: number, refresh = false): Promise<AdoptionView & { note?: string }> {
  if (refresh) {
    const r = store.forceRefresh();
    const v = viewOf(await r.done, days, store.scanning());
    return r.note ? { ...v, note: r.note } : v;
  }
  return viewOf((await store.load()) ?? (await store.refresh()), days, store.scanning());
}

const statsTool: Tool = {
  def: {
    name: 'adoption_stats',
    title: 'Claude sessions’ port habits',
    description:
      "How Claude Code sessions on this machine handled ports, from their transcripts: Portboard MCP calls vs raw port " +
      'inspection (ss -ltn, lsof -i, netstat, fuser), kill-by-port, and servers started on a hard-coded port (PORT=N, ' +
      '--port N, -p N), per day and per project, the most used ports, and Portboard hook nudges shown. Over the last ' +
      '`days` KST days (default 7) and the same span before, for comparison. Counts only; from a daily cached scan ' +
      '(refresh: true rescans, several seconds).',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: MAX_DAYS, description: 'Window in days ending today (KST), default 7' },
        refresh: { type: 'boolean', description: 'Scan the transcripts now instead of using the cached scan' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async call(args, core) {
    const a = (args ?? {}) as { days?: unknown; refresh?: unknown };
    const days = daysArg(a.days);
    if (days === null) return text(`days must be an integer 1–${MAX_DAYS}`, true);
    if (!core.adoption) return text('adoption_stats is not available here', true);
    const v = await core.adoption(days, a.refresh === true);
    const note = v.note;
    if (!v.current) return text({ at: v.at, scanning: v.scanning, message: 'no scan yet', ...(note ? { note } : {}) });
    const c = v.current;
    return text({
      at: v.at,
      ...(note ? { note } : {}),
      window: { from: c.from, to: c.to },
      totals: c.totals,
      previous: v.previous ? { from: v.previous.from, to: v.previous.to, totals: v.previous.totals } : null,
      byDay: c.byDay,
      byProject: c.byProject.slice(0, 15).map(({ dirs: _d, ...p }) => p),
      topPorts: c.topPorts,
      topPrefixes: c.topPrefixes,
      portboardTools: c.mcpTools,
    });
  },
};

export const adoptionFeature: FeatureModule = {
  name: 'adoption',
  order: 2000,
  routes: [
    {
      method: 'GET',
      path: '/api/adoption',
      async handler({ url }) {
        const days = daysArg(url.searchParams.get('days'));
        if (days === null) return reply(400, { error: `days must be 1–${MAX_DAYS}` });
        if (!url.searchParams.has('refresh')) return ok(viewOf(await store.load(), days, store.scanning()));
        const r = store.forceRefresh();
        void r.done;
        return ok({ ...viewOf(await store.load(), days, store.scanning()), refresh: r.state, ...(r.note ? { note: r.note } : {}) });
      },
    },
  ],
  tools: [statsTool],
  mcpCore: () => ({ adoption: (days: number, refresh?: boolean) => view(days, refresh) }),
  jobs: [{ name: 'adoption-scan', everyMs: 3_600_000, runAtStart: true, heavy: true, run: () => store.refreshIfStale() }],
  ui: [{ pages: ['dev.html'], script: 'features/adoption.js' }],
};
