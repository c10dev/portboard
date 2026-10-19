// Uptime history for watched (🔔) ports: what the alerts checker saw on each 30 s check, kept as run-length segments.
//
//   ~/.local/state/portboard/uptime.json   (PORTBOARD_UPTIME, or uptime.json under PORTBOARD_STATE_DIR)
//   {"version": 1, "ports": {"8780": [[from, to, "u"], [from, to, "d"], …]}}
//
// A segment is a run of checks with the same result: from = its first check, to = its last check (ms).
// Codes: u up, d nothing listening, h listening but HTTP does not answer, q down inside the 2-minute window after a
// restart/stop from Portboard (not counted either way). A check covers the time until the next one, at most
// MAX_GAP_MS; time nobody checked (Portboard not running, alerts off) is unknown, not down. uptime % = up / (up + down).
//
// Recorded by the server process only (the checker), written atomically at most once a minute and on SIGTERM.
// No merge on write: one checker per state dir, like alerts-state.json. 30-day retention.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from './paths.ts';
import { writePrivate } from './atomic.ts';

export type Code = 'u' | 'd' | 'h' | 'q';
export type Segment = [from: number, to: number, code: Code];

export interface Uptime {
  version: 1;
  ports: Record<string, Segment[]>;
}

export const UPTIME_PATH = PATHS.uptime;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const CHECK_MS = 30_000;
/** Two checks further apart than this leave a gap of unknown between them */
export const MAX_GAP_MS = 3 * CHECK_MS;
export const RETENTION_MS = 30 * DAY;
/** A port that flaps every check for a month would need ~86k; the oldest go first */
export const MAX_SEGMENTS = 5000;
const CODES = new Set<Code>(['u', 'd', 'h', 'q']);

export const emptyUptime = (): Uptime => ({ version: 1, ports: {} });
const isDown = (c: Code) => c === 'd' || c === 'h';

/** One check result for a port. Mutates u. */
export function recordCheck(u: Uptime, port: number, t: number, code: Code): void {
  const segs = (u.ports[port] ??= []);
  const last = segs.at(-1);
  if (last && t <= last[1]) return; // same check twice, or a clock step back
  if (last && last[2] === code && t - last[1] <= MAX_GAP_MS) last[1] = t;
  else segs.push([t, t, code]);
}

/** The alerts checker's port observations → codes. quietUntil: port → ms (quiet.json). */
export function codeOf(o: { ok: boolean; reason?: string }, t: number, quietUntil = 0): Code {
  if (o.ok) return 'u';
  if (t < quietUntil) return 'q';
  return o.reason === 'http' ? 'h' : 'd';
}

/** Drops what is older than the retention window and the oldest segments past MAX_SEGMENTS. Mutates u. */
export function prune(u: Uptime, now: number, retention = RETENTION_MS): void {
  const cutoff = now - retention;
  for (const [port, segs] of Object.entries(u.ports)) {
    let kept = segs.filter((s) => s[1] >= cutoff);
    for (const s of kept) if (s[0] < cutoff) s[0] = cutoff;
    if (kept.length > MAX_SEGMENTS) kept = kept.slice(-MAX_SEGMENTS);
    if (kept.length) u.ports[port] = kept;
    else delete u.ports[port];
  }
}

/** Accepts only well-formed, ordered segments, so a hand-edited or truncated file can't break anything. */
export function parseUptime(text: string): Uptime {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyUptime();
  }
  const u = emptyUptime();
  if (!raw || typeof raw.ports !== 'object' || Array.isArray(raw.ports)) return u;
  for (const [port, segs] of Object.entries<any>(raw.ports)) {
    const n = Number(port);
    if (!Number.isInteger(n) || String(n) !== port || n < 1 || n > 65535 || !Array.isArray(segs)) continue;
    const ok: Segment[] = [];
    for (const s of segs) {
      if (!Array.isArray(s) || s.length !== 3) continue;
      const [from, to, code] = s;
      if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || !CODES.has(code)) continue;
      if (ok.length && from <= ok.at(-1)![1]) continue;
      ok.push([from, to, code]);
    }
    if (ok.length) u.ports[n] = ok;
  }
  return u;
}

export async function loadUptime(path = UPTIME_PATH, now = Date.now()): Promise<Uptime> {
  try {
    const u = parseUptime(await readFile(path, 'utf8'));
    prune(u, now);
    return u;
  } catch {
    return emptyUptime();
  }
}

// ---------- math ----------

/** [start, end, code] spans of observed time: each check counts until the next one, at most MAX_GAP_MS, never past now. */
export function spans(segs: Segment[], now: number): [number, number, Code][] {
  return segs.map((s, i) => {
    const next = segs[i + 1];
    const tail = next && next[0] - s[1] <= MAX_GAP_MS ? next[0] : s[1] + CHECK_MS;
    return [s[0], Math.max(s[1], Math.min(tail, now)), s[2]];
  });
}

export interface Stats {
  /** up / (up + down), 0–100 with two decimals; null when nothing in the window was checked */
  pct: number | null;
  upMs: number;
  downMs: number;
  quietMs: number;
  /** Time in the window that was checked at all */
  coveredMs: number;
}

export function stats(segs: Segment[], from: number, to: number, now = to): Stats {
  let upMs = 0, downMs = 0, quietMs = 0;
  for (const [a, b, code] of spans(segs, now)) {
    const ms = Math.min(b, to) - Math.max(a, from);
    if (ms <= 0) continue;
    if (code === 'u') upMs += ms;
    else if (code === 'q') quietMs += ms;
    else downMs += ms;
  }
  const judged = upMs + downMs;
  return { pct: judged ? Math.floor((upMs / judged) * 10000) / 100 : null, upMs, downMs, quietMs, coveredMs: judged + quietMs };
}

export type SlotState = 'up' | 'down' | 'quiet' | null;

export interface Slot {
  from: number;
  to: number;
  /** Worst thing seen in the slot: any down → down; null when nothing was checked */
  state: SlotState;
  pct: number | null;
  downMs: number;
}

/** `count` slots of `slotMs` ending at `end`, oldest first. */
export function slots(segs: Segment[], end: number, count: number, slotMs: number, now = end): Slot[] {
  const sp = spans(segs, now);
  const out: Slot[] = [];
  for (let i = count; i > 0; i--) {
    const from = end - i * slotMs;
    const to = from + slotMs;
    let up = 0, down = 0, quiet = 0;
    for (const [a, b, code] of sp) {
      const ms = Math.min(b, to) - Math.max(a, from);
      if (ms <= 0) continue;
      if (code === 'u') up += ms;
      else if (code === 'q') quiet += ms;
      else down += ms;
    }
    const state: SlotState = down ? 'down' : up ? 'up' : quiet ? 'quiet' : null;
    out.push({ from, to, state, pct: up + down ? Math.floor((up / (up + down)) * 10000) / 100 : null, downMs: down });
  }
  return out;
}

/**
 * The last `count` checks, one character each (u up, d down, q quiet, - a check that didn't happen), oldest first.
 * Rebuilt from the segments (a run from..to holds one check per CHECK_MS) rather than from time slots: check times
 * drift by a second or so, and slot boundaries would smear one down check into its neighbours.
 */
export function recentChecks(segs: Segment[], now: number, count = 30): string {
  const rev: string[] = [];
  const missed = (ms: number) => (ms > MAX_GAP_MS ? Math.min(count, Math.round(ms / CHECK_MS) - 1) : 0);
  const last = segs.at(-1);
  if (last) rev.push(...'-'.repeat(missed(now - last[1] + CHECK_MS)));
  for (let i = segs.length - 1; i >= 0 && rev.length < count; i--) {
    const [from, to, code] = segs[i];
    const n = Math.min(count, Math.round((to - from) / CHECK_MS) + 1);
    rev.push(...(isDown(code) ? 'd' : code).repeat(n));
    if (i > 0) rev.push(...'-'.repeat(missed(from - segs[i - 1][1])));
  }
  return rev.slice(0, count).reverse().join('').padStart(count, '-');
}

export interface Outage {
  from: string;
  /** null while it is still down */
  to: string | null;
  minutes: number;
  /** 'listen' (nothing listening) or 'http' (no HTTP answer); the last one seen */
  reason: 'listen' | 'http';
}

/**
 * Down periods, newest first. Down segments separated only by quiet time or a short gap are one outage; a gap longer
 * than MAX_GAP_MS ends it (nobody knows what happened in between).
 */
export function outages(segs: Segment[], now: number, limit = 20): Outage[] {
  const out: { from: number; to: number; reason: Code; open: boolean }[] = [];
  let cur: (typeof out)[number] | null = null;
  const sp = spans(segs, now);
  sp.forEach(([a, b, code], i) => {
    const prevEnd = i ? sp[i - 1][1] : -Infinity;
    if (cur && a - prevEnd > 0) cur = null; // unobserved gap
    if (isDown(code)) {
      if (cur) Object.assign(cur, { to: b, reason: code });
      else out.push((cur = { from: a, to: b, reason: code, open: false }));
    } else if (code === 'u') cur = null;
  });
  const last = segs.at(-1);
  const lastOut = out.at(-1);
  if (last && lastOut && isDown(last[2]) && now - last[1] <= MAX_GAP_MS) lastOut.open = true;
  return out
    .reverse()
    .slice(0, limit)
    .map((o) => ({
      from: new Date(o.from).toISOString(),
      to: o.open ? null : new Date(o.to).toISOString(),
      minutes: Math.max(1, Math.round(((o.open ? now : o.to) - o.from) / MIN)),
      reason: o.reason === 'h' ? 'http' : 'listen',
    }));
}

export interface UptimeSummary {
  /** Last 30 checks: u / d / q / - */
  checks: string;
  pct24h: number | null;
  pct7d: number | null;
  /** Checked time in the last 24 h / 7 d, so "100%" over 20 minutes isn't read as a full day */
  covered24hMs: number;
  covered7dMs: number;
  lastCheck: string | null;
}

/** What a 서비스 row shows. null when the port was never checked. */
export function summary(u: Uptime, port: number, now: number): UptimeSummary | null {
  const segs = u.ports[port];
  if (!segs?.length) return null;
  const d1 = stats(segs, now - DAY, now, now);
  const d7 = stats(segs, now - 7 * DAY, now, now);
  return {
    checks: recentChecks(segs, now),
    pct24h: d1.pct,
    pct7d: d7.pct,
    covered24hMs: d1.coveredMs,
    covered7dMs: d7.coveredMs,
    lastCheck: new Date(segs.at(-1)![1]).toISOString(),
  };
}

export interface UptimeDetail extends UptimeSummary {
  pct30d: number | null;
  /** First check still kept */
  since: string;
  /** 48 × 30 min */
  day: { from: string; state: SlotState; pct: number | null }[];
  /** 30 × 24 h, rolling (each slot ends at the current time of day, not at midnight) */
  month: { from: string; state: SlotState; pct: number | null }[];
  outages: Outage[];
}

export function detail(u: Uptime, port: number, now: number): UptimeDetail | null {
  const s = summary(u, port, now);
  if (!s) return null;
  const segs = u.ports[port];
  const view = (x: Slot) => ({ from: new Date(x.from).toISOString(), state: x.state, pct: x.pct });
  return {
    ...s,
    pct30d: stats(segs, now - 30 * DAY, now, now).pct,
    since: new Date(segs[0][0]).toISOString(),
    day: slots(segs, now, 48, 30 * MIN).map(view),
    month: slots(segs, now, 30, DAY).map(view),
    outages: outages(segs, now),
  };
}

// ---------- store ----------

/** In-memory uptime for the server process: record() on every check, flush() at most every minWriteMs. */
export class UptimeStore {
  data: Uptime = emptyUptime();
  private dirty = false;
  private lastWrite = 0;
  private writing: Promise<void> | null = null;
  readonly path: string;
  readonly minWriteMs: number;

  constructor(path = UPTIME_PATH, minWriteMs = 60_000) {
    this.path = path;
    this.minWriteMs = minWriteMs;
  }

  async open(now = Date.now()): Promise<this> {
    this.data = await loadUptime(this.path, now);
    this.lastWrite = now;
    return this;
  }

  /** One check of each watched port (the alerts checker's observations, key `port:<n>`). */
  record(obs: { key: string; ok: boolean; reason?: string }[], now = Date.now(), quiet: Record<string, number> = {}): void {
    for (const o of obs) {
      if (!o.key.startsWith('port:')) continue;
      const port = Number(o.key.slice(5));
      recordCheck(this.data, port, now, codeOf(o, now, quiet[port] ?? 0));
    }
    this.dirty = true;
    if (now - this.lastWrite >= this.minWriteMs) void this.flush(now).catch((err) => console.error(`[portboard] uptime: ${err}`));
  }

  flush(now = Date.now()): Promise<void> {
    if (!this.dirty) return this.writing ?? Promise.resolve();
    if (this.writing) return this.writing;
    this.dirty = false;
    this.lastWrite = now;
    this.writing = (async () => {
      prune(this.data, now);
      await writePrivate(this.path, () => JSON.stringify(this.data));
    })()
      .catch((err) => {
        this.dirty = true;
        throw err;
      })
      .finally(() => (this.writing = null));
    return this.writing;
  }
}
