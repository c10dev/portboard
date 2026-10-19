// 기기 상태 알림 (c10dev/portboard#2): unhealthy states of the other machines that no other alert covers, derived from
// the devices data (/api/devices, src/core/devices.ts) and stepped like the memory-pressure alert (memory.ts).
//
//   failures  a compute-pool host whose jobs failed `failPct` % or more of at least `failMinRuns` runs in the last 24 h
//             (pool.last24h). It is already a 24 h window, so it alerts on the first sample that shows it.
//   guest     a Proxmox guest `running` whose matched tailnet device is offline, for `offlineMin` minutes (counted from
//             the device's lastSeen when Tailscale knows it, else from the first sample that saw it offline)
//   load      a compute-pool host with load1 / cores at `loadPerCore` or more for `loadMin` minutes
//
// Each condition has its own state (stepCondition): one warning once it has held for its sustain, a reminder every
// `reminderHours` while it lasts, one recovery after it has been clear (with a margin, so a value hovering at the
// threshold doesn't flap) for `recoverMin`. A host that leaves compute-pool's rotation is not alerted here: `cpool
// monitor` does that (alerts.ts). Thresholds: devhealth.json in the config dir (read only, docs/config.md).
//
// Pure: no I/O. The feature module (src/features/devhealth.ts) reads the devices, owns the state file and sends.

import type { Message } from './alerts.ts';
import { korDur } from './digest.ts';
import { t } from './i18n.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface DevHealthThresholds {
  /** failures: at least this many runs in 24 h before the rate counts */
  failMinRuns: number;
  /** failures: warn at this share of failed runs (%) */
  failPct: number;
  /** guest: its tailnet device offline this long */
  offlineMin: number;
  /** load: warn at load1 / cores of this */
  loadPerCore: number;
  /** load: it must hold this long */
  loadMin: number;
  /** a condition must be clear this long to recover */
  recoverMin: number;
  /** reminder while it lasts */
  reminderHours: number;
}

export const DEFAULT_THRESHOLDS: DevHealthThresholds = { failMinRuns: 5, failPct: 50, offlineMin: 30, loadPerCore: 2, loadMin: 15, recoverMin: 5, reminderHours: 6 };

const LIMITS: Record<keyof DevHealthThresholds, [number, number]> = {
  failMinRuns: [1, 1000],
  failPct: [1, 100],
  offlineMin: [1, 1440],
  loadPerCore: [0.1, 64],
  loadMin: [1, 1440],
  recoverMin: [1, 120],
  reminderHours: [1, 168],
};

/** Margins a recovery needs past the threshold */
export const RECOVER_MARGIN = { failPct: 10, loadFactor: 0.8 };

/** devhealth.json → thresholds; each missing or out-of-range key keeps its default. */
export function parseThresholds(raw: unknown): DevHealthThresholds {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_THRESHOLDS };
  for (const k of Object.keys(LIMITS) as (keyof DevHealthThresholds)[]) {
    const v = r[k];
    const [lo, hi] = LIMITS[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) out[k] = v;
  }
  return out;
}

// ---------- derivation ----------

/** The parts of /api/devices this reads (src/core/devices.ts Devices) */
export interface HealthInput {
  devices: {
    id: string;
    name: string;
    self: boolean;
    online: boolean;
    lastSeen: string | null;
    pool: { name: string; state: string; cores?: number; load1?: number; last24h?: { runs: number; failed: number } } | null;
  }[];
  proxmox: { hosts: { node: string; guests: { vmid: number; name: string; status: string; template: boolean; device: string | null }[] }[] };
}

export type ConditionKind = 'failures' | 'guest' | 'load';

export type Facts = Record<string, string | number>;

/** One condition as one sample sees it */
export interface Observation {
  key: string;
  kind: ConditionKind;
  name: string;
  /** over the threshold now */
  breach: boolean;
  /** past the threshold with the recovery margin (neither: hovering, nothing changes) */
  clear: boolean;
  /** ms: when the breach is known to have begun (a device's lastSeen), else null */
  since: number | null;
  facts: Facts;
}

/** Pool hosts whose numbers are stale: `cpool monitor` alerts on those itself */
const POOL_AWAY = new Set(['host-down', 'agent-away', 'unknown']);

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Every condition the devices data can show now, breaching or not (a host or guest with no data gives none). */
export function observe(input: HealthInput, now: number, th: DevHealthThresholds): Observation[] {
  const out: Observation[] = [];
  for (const d of input.devices) {
    const p = d.pool;
    if (!p) continue;
    const runs = p.last24h?.runs;
    const failed = p.last24h?.failed;
    if (typeof runs === 'number' && typeof failed === 'number' && runs >= 0) {
      const pct = runs ? Math.round((failed / runs) * 100) : 0;
      const enough = runs >= th.failMinRuns;
      out.push({
        key: `failures:${p.name}`,
        kind: 'failures',
        name: p.name,
        breach: enough && pct >= th.failPct,
        clear: !enough || pct <= th.failPct - RECOVER_MARGIN.failPct,
        since: null,
        facts: { runs, failed, pct },
      });
    }
    if (!POOL_AWAY.has(p.state) && typeof p.load1 === 'number' && typeof p.cores === 'number' && p.cores > 0) {
      const ratio = p.load1 / p.cores;
      out.push({
        key: `load:${p.name}`,
        kind: 'load',
        name: p.name,
        breach: ratio >= th.loadPerCore,
        clear: ratio <= th.loadPerCore * RECOVER_MARGIN.loadFactor,
        since: null,
        facts: { load1: round1(p.load1), cores: p.cores, ratio: round1(ratio) },
      });
    }
  }
  const byId = new Map(input.devices.map((d) => [d.id, d]));
  for (const h of input.proxmox.hosts) {
    for (const g of h.guests) {
      // lan:<ip> has no tailnet state; this server is always online to itself
      const d = g.device && !g.device.startsWith('lan:') ? byId.get(g.device) : undefined;
      if (!d || d.self || g.template) continue;
      const running = g.status === 'running';
      const seen = d.lastSeen ? Date.parse(d.lastSeen) : NaN;
      out.push({
        key: `guest:${h.node}/${g.vmid}`,
        kind: 'guest',
        name: g.name,
        breach: running && !d.online,
        clear: !running || d.online,
        since: running && !d.online && Number.isFinite(seen) && seen <= now ? seen : null,
        facts: { guest: g.name, vmid: g.vmid, node: h.node, device: d.name },
      });
    }
  }
  return out;
}

// ---------- state ----------

export interface ConditionState {
  kind: ConditionKind;
  name: string;
  /** a warning went out and it hasn't recovered yet */
  active: boolean;
  /** ms: when the current breach began */
  breachSince: number | null;
  /** ms: when it began to look clear again (while active) */
  clearSince: number | null;
  /** ms: the last warning or reminder sent */
  lastSent: number | null;
  /** ms: the last sample that saw this condition */
  lastSample: number | null;
  /** the numbers of the last sample (for the messages and the view) */
  facts: Facts;
}

export type DevHealthEvent = 'warn' | 'remind' | 'recover';

const blank = (o: Pick<Observation, 'kind' | 'name' | 'facts'>): ConditionState => ({
  kind: o.kind, name: o.name, active: false, breachSince: null, clearSince: null, lastSent: null, lastSample: null, facts: o.facts,
});

/** How long a breach must hold before the warning */
export function sustainOf(kind: ConditionKind, th: DevHealthThresholds): number {
  if (kind === 'guest') return th.offlineMin * MIN;
  if (kind === 'load') return th.loadMin * MIN;
  return 0;
}

/**
 * One sample of one condition. A breach must last its sustain (samples more than 3 minutes apart break the run: the
 * server was down; a known start such as lastSeen doesn't depend on our samples); while active, a reminder every
 * `reminderHours`; recovery once clear for `recoverMin`.
 */
export function stepCondition(prev: ConditionState | undefined, o: Observation, now: number, th: DevHealthThresholds): { next: ConditionState; event: DevHealthEvent | null } {
  const st: ConditionState = { ...blank(o), ...prev, kind: o.kind, name: o.name, facts: o.facts };
  const gap = st.lastSample !== null && now - st.lastSample > 3 * MIN;
  st.lastSample = now;
  if (!st.active) {
    if (!o.breach) return { next: { ...st, breachSince: null }, event: null };
    if (o.since !== null) st.breachSince = o.since;
    else if (st.breachSince === null || gap) st.breachSince = now;
    if (now - st.breachSince < sustainOf(o.kind, th)) return { next: st, event: null };
    return { next: { ...st, active: true, clearSince: null, lastSent: now }, event: 'warn' };
  }
  if (o.clear) {
    if (st.clearSince === null || gap) st.clearSince = now;
    if (now - st.clearSince >= th.recoverMin * MIN) return { next: { ...blank(o), lastSample: now }, event: 'recover' };
    return { next: st, event: null };
  }
  st.clearSince = null;
  if (st.lastSent === null || now - st.lastSent >= th.reminderHours * HOUR) return { next: { ...st, lastSent: now }, event: 'remind' };
  return { next: st, event: null };
}

export interface DevHealthStateFile {
  version: 1;
  /** ISO time of the last sample, null before the first */
  at: string | null;
  conditions: Record<string, ConditionState>;
}

export const DEVHEALTH_STATE = 'devhealth-state.json';

export const emptyState = (): DevHealthStateFile => ({ version: 1, at: null, conditions: {} });

export function parseState(text: string): DevHealthStateFile {
  try {
    const raw = JSON.parse(text);
    if (raw?.version !== 1 || !raw.conditions || typeof raw.conditions !== 'object') return emptyState();
    const conditions: Record<string, ConditionState> = {};
    for (const [k, v] of Object.entries<any>(raw.conditions)) {
      if (v && typeof v === 'object' && ['failures', 'guest', 'load'].includes(v.kind) && typeof v.name === 'string') conditions[k] = { ...blank({ kind: v.kind, name: v.name, facts: {} }), ...v };
    }
    return { version: 1, at: typeof raw.at === 'string' ? raw.at : null, conditions };
  } catch {
    return emptyState();
  }
}

/** A condition no sample has seen for this long is forgotten (a host or guest that went away), active or not */
export const FORGET_MS = 7 * DAY;

export interface StepEvent {
  key: string;
  event: DevHealthEvent;
  /** for a recovery, the state before the step (its facts and breachSince) */
  cond: ConditionState;
  /** ms: when the breach began */
  since: number | null;
}

/** One sample of every condition; conditions the sample didn't show keep their state until FORGET_MS. */
export function stepAll(prev: DevHealthStateFile, obs: Observation[], now: number, th: DevHealthThresholds): { next: DevHealthStateFile; events: StepEvent[] } {
  const conditions: Record<string, ConditionState> = {};
  const events: StepEvent[] = [];
  const seen = new Set<string>();
  for (const o of obs) {
    seen.add(o.key);
    const before = prev.conditions[o.key];
    const { next, event } = stepCondition(before, o, now, th);
    if (event) {
      const cond = event === 'recover' && before ? before : next;
      events.push({ key: o.key, event, cond, since: cond.breachSince });
    }
    // an idle condition that never breached isn't worth a line in the file
    if (next.active || next.breachSince !== null || next.clearSince !== null) conditions[o.key] = next;
  }
  for (const [k, c] of Object.entries(prev.conditions)) {
    if (!seen.has(k) && c.lastSample !== null && now - c.lastSample < FORGET_MS) conditions[k] = c;
  }
  return { next: { version: 1, at: new Date(now).toISOString(), conditions }, events };
}

// ---------- text ----------

/** Literal keys per kind (test/i18n.test.ts finds them here) */
const TITLE: Record<ConditionKind, string> = { failures: 'devhealthMsg.failures.title', guest: 'devhealthMsg.guest.title', load: 'devhealthMsg.load.title' };
const BODY: Record<ConditionKind, string> = { failures: 'devhealthMsg.failures.body', guest: 'devhealthMsg.guest.body', load: 'devhealthMsg.load.body' };
const SUMMARY: Record<ConditionKind, string> = { failures: 'devhealthMsg.summary.failures', guest: 'devhealthMsg.summary.guest', load: 'devhealthMsg.summary.load' };
const KIND: Record<ConditionKind, string> = { failures: 'devhealthMsg.kind.failures', guest: 'devhealthMsg.kind.guest', load: 'devhealthMsg.kind.load' };

/** "3/9 jobs failed in 24 h (33%)", "load 32 on 10 cores (3.2× per core)", "running, tailnet device nas offline" */
export const summaryText = (c: Pick<ConditionState, 'kind' | 'facts'>): string => t(SUMMARY[c.kind], c.facts);

export const kindText = (kind: ConditionKind): string => t(KIND[kind]);

/** The alert. Names and numbers only, never addresses. `since`: when the breach began. */
export function devhealthMessage(key: string, event: DevHealthEvent, c: ConditionState, since: number | null, now: number): Message {
  const dur = korDur(since !== null ? now - since : 0);
  const params = { ...c.facts, name: c.name, dur };
  if (event === 'recover') {
    const what = kindText(c.kind);
    return { key: `devhealth:${key}`, kind: 'recovered', title: t('devhealthMsg.recovered.title', { name: c.name, what }), body: t('devhealthMsg.recovered.body', { name: c.name, what, dur }), high: false };
  }
  const title = t(TITLE[c.kind], params);
  return {
    key: `devhealth:${key}`,
    kind: 'warning',
    title: event === 'remind' ? t('devhealthMsg.still', { title }) : title,
    body: t(BODY[c.kind], params),
    high: event === 'warn',
  };
}

/** A sample this old is not "now" any more (the server stopped checking) */
export const VIEW_STALE_MS = 5 * MIN;

export interface ConditionView {
  key: string;
  kind: ConditionKind;
  name: string;
  /** alerted and not recovered */
  active: boolean;
  /** ISO: when the current breach began (also before the sustain is over), null when not breaching */
  since: string | null;
  facts: Facts;
  text: string;
}

/** The conditions worth showing: active ones and breaches still within their sustain, active first */
export function conditionsView(f: DevHealthStateFile): ConditionView[] {
  return Object.entries(f.conditions)
    .filter(([, c]) => c.active || c.breachSince !== null)
    .map(([key, c]) => ({ key, kind: c.kind, name: c.name, active: c.active, since: c.breachSince !== null ? new Date(c.breachSince).toISOString() : null, facts: c.facts, text: summaryText(c) }))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.key.localeCompare(b.key));
}

/** The digest's line: only while a condition is alerted */
export function digestLine(f: DevHealthStateFile, now = Date.now()): { problem: boolean; text: string } | null {
  if (!f.at || now - Date.parse(f.at) > VIEW_STALE_MS) return null;
  const active = conditionsView(f).filter((c) => c.active);
  if (!active.length) return null;
  return { problem: true, text: t('devhealthMsg.digest', { list: active.map((c) => `${c.name} ${c.text}`).join(' · ') }) };
}
