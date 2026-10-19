// 일간/주간 요약 알림 (c10dev/portboard#34): one short Korean message over a period, sent through the same channel as
// the down alerts (compute-pool's ntfy/webhook). Pure: the feature module (src/features/digest.ts) gathers the inputs
// from the server's stores or the files they write, and owns the timer and the state file.
//
//   settings  prefs.json "digest": {"mode": "off" | "daily" | "weekly", "time": "09:00"}   (KST; weekly = Monday)
//   state     ~/.local/state/portboard/digest-state.json   (armedAt, lastSlot, lastSent, lastAttempt)
//
// What it covers: watched (🔔) ports' uptime and outages in the period, what is down right now, new devices first
// seen in the period (known-devices.json), cleanup candidates now (owners.ts), removable worktrees now, self-watch
// problems now (failing collectors, credentials about to expire), remote connectors that need a look now (커넥터 상태,
// src/remote/health.ts), memory now (src/core/memory.ts: a problem only while memory is short), and the most used
// services (usage history).
// Nothing to report → one line, "이상 없음".
//
// Scheduling: a slot is the configured time in KST (fixed UTC+9, no DST), every day or every Monday. A slot is sent
// once (lastSlot), only if it came after the digest was switched on (armedAt: turning it on at 15:00 doesn't send
// that morning's digest at once), and late by at most CATCHUP_MS when the server was down at the time.

import { outages, stats, type Segment, type Uptime } from './uptime.ts';
import type { Message } from './alerts.ts';
import type { KnownStore } from './known.ts';
import type { History } from './history.ts';
import type { SelfWatchStatus } from './selfwatch.ts';
import { adoptionLine, type Totals } from './adoption.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KST = 9 * HOUR;

export type DigestMode = 'off' | 'daily' | 'weekly';

export interface DigestSettings {
  mode: DigestMode;
  /** "HH:MM" in KST */
  time: string;
}

export const DEFAULT_TIME = '09:00';
export const DEFAULT_SETTINGS: DigestSettings = { mode: 'off', time: DEFAULT_TIME };
export const MODES: DigestMode[] = ['off', 'daily', 'weekly'];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A slot missed while the server was down is still sent this long after its time */
export const CATCHUP_MS = 12 * HOUR;
/** After a send where nothing got through, wait this long before trying the slot again */
export const RETRY_MS = 10 * MIN;

export const isTime = (v: unknown): v is string => typeof v === 'string' && TIME_RE.test(v);
export const isMode = (v: unknown): v is DigestMode => typeof v === 'string' && (MODES as string[]).includes(v);

/** prefs.json "digest" → settings; anything malformed falls back to the default (off, 09:00). */
export function parseSettings(raw: unknown): DigestSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { mode: isMode(r.mode) ? r.mode : 'off', time: isTime(r.time) ? r.time : DEFAULT_TIME };
}

/** Validates a client's {mode?, time?}; returns an error message or null. */
export function checkSettings(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be an object';
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'mode' && k !== 'time') return `unknown field: ${k}`;
  if (b.mode !== undefined && !isMode(b.mode)) return 'mode must be off, daily or weekly';
  if (b.time !== undefined && !isTime(b.time)) return 'time must be HH:MM (24 h, KST)';
  return null;
}

// ---------- schedule ----------

const minutesOf = (time: string) => {
  const m = TIME_RE.exec(time)!;
  return Number(m[1]) * 60 + Number(m[2]);
};

/** The latest slot at or before now (ms), or null when the digest is off. */
export function latestSlot(s: DigestSettings, now: number): number | null {
  if (s.mode === 'off') return null;
  const local = now + KST;
  const midnight = local - (((local % DAY) + DAY) % DAY); // KST midnight, in "local ms"
  let slot = midnight + minutesOf(s.time) * MIN;
  if (slot > local) slot -= DAY;
  if (s.mode === 'weekly') {
    const weekday = new Date(slot).getUTCDay(); // 0 Sunday … 1 Monday, of the KST date
    slot -= ((weekday + 6) % 7) * DAY;
  }
  return slot - KST;
}

/** The next slot after now (ms), or null when off. */
export function nextSlot(s: DigestSettings, now: number): number | null {
  const last = latestSlot(s, now);
  return last === null ? null : last + (s.mode === 'weekly' ? 7 : 1) * DAY;
}

/** The period a slot covers: the day or the week before it. */
export function periodOf(mode: DigestMode, end: number): { from: number; to: number } {
  return { from: end - (mode === 'weekly' ? 7 : 1) * DAY, to: end };
}

export interface DigestState {
  version: 1;
  /** When the job first saw the current settings switched on; slots before it are never sent */
  armedAt: number | null;
  /** mode+time the arming was for: changing either re-arms */
  armedFor: string | null;
  /** The last slot that went out */
  lastSlot: number | null;
  /** The last digest that went out (scheduled or 지금 보내기) */
  lastSent: number | null;
  /** The last scheduled attempt where nothing got through */
  lastAttempt: number | null;
}

export const emptyState = (): DigestState => ({ version: 1, armedAt: null, armedFor: null, lastSlot: null, lastSent: null, lastAttempt: null });

export function parseState(text: string): DigestState {
  try {
    const raw = JSON.parse(text);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      version: 1,
      armedAt: num(raw?.armedAt),
      armedFor: typeof raw?.armedFor === 'string' ? raw.armedFor : null,
      lastSlot: num(raw?.lastSlot),
      lastSent: num(raw?.lastSent),
      lastAttempt: num(raw?.lastAttempt),
    };
  } catch {
    return emptyState();
  }
}

export type Decision = { action: 'none' } | { action: 'arm'; state: DigestState } | { action: 'disarm'; state: DigestState } | { action: 'send'; slot: number };

/** What the job does on one tick. 'send' leaves the state to the caller (lastSlot on success, lastAttempt on failure). */
export function decide(s: DigestSettings, st: DigestState, now: number): Decision {
  if (s.mode === 'off') return st.armedFor === null ? { action: 'none' } : { action: 'disarm', state: { ...st, armedAt: null, armedFor: null } };
  const key = `${s.mode} ${s.time}`;
  if (st.armedFor !== key || st.armedAt === null) return { action: 'arm', state: { ...st, armedAt: now, armedFor: key } };
  const slot = latestSlot(s, now)!;
  if (slot <= st.armedAt || (st.lastSlot !== null && slot <= st.lastSlot)) return { action: 'none' };
  if (now - slot > CATCHUP_MS) return { action: 'none' };
  if (st.lastAttempt !== null && st.lastAttempt >= slot && now - st.lastAttempt < RETRY_MS) return { action: 'none' };
  return { action: 'send', slot };
}

// ---------- the text ----------

export interface WatchedItem {
  kind: 'port' | 'device';
  port?: number;
  name: string;
  /** Down right now (alerts-state.json) */
  down: boolean;
  since: string | null;
}

export interface CleanupItem {
  port: number;
  name: string;
}

/** Each source is null when it couldn't be read: its line is left out, the rest still goes. */
export interface DigestInput {
  watching: WatchedItem[] | null;
  uptime: Uptime | null;
  known: KnownStore | null;
  cleanup: CleanupItem[] | null;
  worktrees: { removable: number; removableKb: number } | null;
  selfwatch: SelfWatchStatus | null;
  history: History | null;
  /** Claude sessions' port use over the period's whole KST days, and the period before (#40); optional source */
  adoption?: { current: Totals; previous: Totals | null } | null;
  /** Remote MCP clients whose 커넥터 상태 isn't 정상 now (remote.json); optional source */
  remote?: { name: string; health: string }[] | null;
  /** 메모리 now (memory-state.json): a problem while the pressure alert is on; optional source */
  memory?: { problem: boolean; text: string } | null;
}

export interface DigestLine {
  /** problem lines decide between a full digest and "이상 없음"; info lines (uptime overall, most used) don't */
  problem: boolean;
  text: string;
}

export interface Digest {
  title: string;
  body: string;
  /** Nothing to report: body is the one "이상 없음" line */
  empty: boolean;
  lines: DigestLine[];
  period: { mode: DigestMode; from: string; to: string };
}

/** "14분", "3시간 20분", "2일 3시간" */
export function korDur(ms: number): string {
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}시간 ${m % 60}분` : `${h}시간`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}일 ${h % 24}시간` : `${d}일`;
}

function kbText(kb: number): string {
  const gb = kb / 1024 ** 2;
  return gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)} GB` : `${Math.max(1, Math.round(kb / 1024))} MB`;
}

const DOW = ['일', '월', '화', '수', '목', '금', '토'];

/** "10/18(일)" in KST */
export function kstDay(t: number): string {
  const d = new Date(t + KST);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${DOW[d.getUTCDay()]})`;
}

/** "a, b, c 외 2" */
function list(names: string[], max = 3): string {
  return names.length > max ? `${names.slice(0, max).join(', ')} 외 ${names.length - max}` : names.join(', ');
}

/** " vite" for a short name; nothing for a command line ("[systemd-run] /usr/bin/python3 -m http.server …") */
const shortName = (name: string) => (name.length <= 20 && !name.includes('/') ? ` ${name}` : '');

const who = (w: { port?: number; name: string }) => (w.port ? `${w.port} ${w.name}` : w.name);

function serviceLines(watching: WatchedItem[], uptime: Uptime, from: number, to: number, now: number): DigestLine[] {
  const out: DigestLine[] = [];
  const ports = watching.filter((w) => w.kind === 'port' && w.port);
  let up = 0;
  let down = 0;
  const hit: { w: WatchedItem; count: number; downMs: number }[] = [];
  for (const w of ports) {
    const segs: Segment[] = uptime.ports[w.port!] ?? [];
    const st = stats(segs, from, to, now);
    up += st.upMs;
    down += st.downMs;
    const count = outages(segs, now, 1000).filter((o) => Date.parse(o.from) < to && (o.to === null ? now : Date.parse(o.to)) > from).length;
    if (st.downMs > 0) hit.push({ w, count: Math.max(1, count), downMs: st.downMs });
  }
  if (ports.length) {
    const pct = up + down ? Math.floor((up / (up + down)) * 1000) / 10 : null;
    out.push({ problem: false, text: `🔔 감시 서비스 ${ports.length}개 · 가동률 ${pct === null ? '기록 없음' : `${pct}%`}` });
  }
  hit.sort((a, b) => b.downMs - a.downMs);
  for (const h of hit.slice(0, 3)) out.push({ problem: true, text: `⚠️ ${who(h.w)}: ${h.count}번, 총 ${korDur(h.downMs)} 중단` });
  if (hit.length > 3) out.push({ problem: true, text: `⚠️ 그 밖에 ${hit.length - 3}개 서비스도 중단` });
  const nowDown = watching.filter((w) => w.down);
  if (nowDown.length) {
    const names = nowDown.map((w) => `${who(w)}${w.since ? ` (${korDur(now - Date.parse(w.since))}째)` : ''}`);
    out.push({ problem: true, text: `🔴 지금 꺼짐: ${list(names, 2)}` });
  }
  return out;
}

function newDeviceLine(known: KnownStore, from: number, to: number): DigestLine | null {
  const fresh = Object.values(known.devices)
    .filter((d) => !d.seeded)
    .map((d) => ({ d, at: Math.min(d.connected ?? Infinity, d.neighbor ?? Infinity, d.firstSeen) }))
    .filter((x) => x.at >= from && x.at < to)
    .sort((a, b) => a.at - b.at);
  if (!fresh.length) return null;
  const pending = fresh.filter((x) => x.d.pending).length;
  return { problem: true, text: `🆕 새 기기 ${fresh.length}대: ${list(fresh.map((x) => x.d.name))}${pending ? ` (확인 안 함 ${pending})` : ''}` };
}

function selfwatchLines(sw: SelfWatchStatus, now: number): DigestLine[] {
  const out: DigestLine[] = [];
  const failing = sw.collectors.filter((c) => c.enabled && (c.view === 'failing' || c.view === 'down'));
  if (failing.length) out.push({ problem: true, text: `🩺 수집 문제: ${list(failing.map((c) => c.label))}` });
  const expiring = sw.expiry.items.filter((i) => i.status === 'soon' || i.status === 'expired');
  if (expiring.length) {
    const names = expiring.map((i) => (i.status === 'expired' || !i.expiresAt ? `${i.name} 만료됨` : `${i.name} ${Math.max(0, Math.ceil((Date.parse(i.expiresAt) - now) / DAY))}일 남음`));
    out.push({ problem: true, text: `🔑 ${list(names, 2)}` });
  }
  return out;
}

/**
 * Minutes of use per service, summed over devices (two devices for an hour = 2 h), over the UTC days the period touches
 * (history keeps whole UTC days: a 09:00 KST daily slot is exactly one), other devices only. Ranked by that, shown as
 * how many devices used it: a device-minute total reads oddly on a phone ("SSH 2일 3시간" in a day).
 */
export function busiest(h: History, from: number, to: number, n = 3): { port: number; service: string; minutes: number; devices: number }[] {
  const first = new Date(from).toISOString().slice(0, 10);
  const last = new Date(to - 1).toISOString().slice(0, 10);
  const byPort = new Map<number, { port: number; service: string; minutes: number; devices: number }>();
  for (const e of Object.values(h.entries)) {
    if (e.device === 'local') continue; // this server's own processes talking to each other
    const minutes = Object.entries(e.days).reduce((a, [d, m]) => (d >= first && d <= last ? a + m : a), 0);
    if (!minutes) continue;
    const cur = byPort.get(e.port) ?? { port: e.port, service: e.service, minutes: 0, devices: 0 };
    cur.minutes += minutes;
    cur.devices += 1;
    byPort.set(e.port, cur);
  }
  return [...byPort.values()].sort((a, b) => b.minutes - a.minutes || a.port - b.port).slice(0, n);
}

export function buildDigest(input: DigestInput, mode: DigestMode, period: { from: number; to: number }, now: number): Digest {
  const { from, to } = period;
  const lines: DigestLine[] = [];
  if (input.watching && input.uptime) lines.push(...serviceLines(input.watching, input.uptime, from, to, now));
  const nd = input.known && newDeviceLine(input.known, from, to);
  if (nd) lines.push(nd);
  if (input.cleanup?.length) lines.push({ problem: true, text: `🧹 정리 후보 서버 ${input.cleanup.length}개: ${list(input.cleanup.map((c) => `${c.port}${shortName(c.name)}`))}` });
  if (input.worktrees?.removable) lines.push({ problem: true, text: `🌿 지워도 되는 worktree ${input.worktrees.removable}개 · ${kbText(input.worktrees.removableKb)}` });
  if (input.selfwatch) lines.push(...selfwatchLines(input.selfwatch, now));
  if (input.memory) lines.push(input.memory);
  if (input.remote?.length) lines.push({ problem: true, text: `🔌 원격 커넥터 확인 필요 ${input.remote.length}개: ${list(input.remote.map((r) => `${r.name || '이름 없음'} ${r.health}`))}` });
  const top = input.history ? busiest(input.history, from, to) : [];
  if (top.length) lines.push({ problem: false, text: `📈 많이 쓴 서비스: ${top.map((t) => `${t.service} (${t.devices}대)`).join(' · ')}` });
  if (input.adoption?.current.sessions) lines.push({ problem: false, text: adoptionLine(input.adoption.current, input.adoption.previous) });

  const weekly = mode === 'weekly';
  const title = weekly ? `Portboard 주간 요약 · ${kstDay(from)}–${kstDay(to - 1)}` : `Portboard 일간 요약 · ${kstDay(to - 1)}`;
  const empty = !lines.some((l) => l.problem);
  const watchedPorts = input.watching?.filter((w) => w.kind === 'port').length ?? 0;
  const body = empty ? (watchedPorts ? `이상 없음 · 감시 서비스 ${watchedPorts}개 모두 정상` : '이상 없음') : lines.map((l) => l.text).join('\n');
  return { title, body, empty, lines, period: { mode: weekly ? 'weekly' : 'daily', from: new Date(from).toISOString(), to: new Date(to).toISOString() } };
}

export function digestMessage(d: Digest): Message {
  return { key: 'digest', kind: 'digest', title: d.title, body: d.body, high: false };
}
