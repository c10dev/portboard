// Down/up alerts for chosen ports (and, optionally, tailnet devices), sent through compute-pool's alert channel.
//
//   channel   ~/.local/state/compute-pool/alerts.json  {"ntfy": {"server", "topic"}, "webhook": {"url"}}
//             read on every use, never copied, logged or returned: an ntfy topic works like a password
//   state     ~/.local/state/portboard/alerts-state.json  (so a restart doesn't re-alert)
//   quiet     ~/.local/state/portboard/quiet.json         (ports Portboard itself just stopped or restarted)
//   log       ~/.local/state/portboard/alerts.jsonl       (what was sent; titles only, no channel details)
//
// Every 30 s the server checks each port with `alert: true` in prefs.json and each device in deviceAlerts.
// A port is down when nothing listens on it, or when it is known to speak HTTP and GET / gets no answer;
// two failed checks in a row send one down alert, the first good check after that sends one recovery alert.
// At most one down alert per port per 10 minutes; recovery alerts are never held back.
// compute-pool hosts are not watched here: `cpool monitor` already alerts when they leave rotation.

import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { PATHS } from './paths.ts';
import { parsePeers } from './devices.ts';
import { run, runShared } from './exec.ts';
import { loadPrefs } from './prefs.ts';
import type { UptimeSummary } from './uptime.ts';
import { reportHealth } from './health.ts';
import { appendPrivate, writePrivate } from './atomic.ts';
import { t } from './i18n.ts';

export const CHECK_MS = 30_000;
export const FAILS_TO_ALERT = 2;
export const RATE_MS = 10 * 60_000;
export const QUIET_MS = 2 * 60_000;

export const CHANNEL_PATH = PATHS.alertChannel;
export const STATE_PATH = PATHS.alertsState;
export const QUIET_PATH = PATHS.quiet;
export const LOG_PATH = PATHS.alertsLog;

// ---------- channel ----------

export interface Channel {
  ntfyServer: string;
  ntfyTopic: string | null;
  webhookUrl: string | null;
}

const URL_RE = /^https?:\/\/\S{1,300}$/;
const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Same rules as compute-pool's ParseAlertConfig; null when no usable channel is configured. */
export function parseChannel(raw: string): Channel | null {
  let f: any;
  try {
    f = JSON.parse(raw);
  } catch {
    return null;
  }
  const server = typeof f?.ntfy?.server === 'string' && URL_RE.test(f.ntfy.server) ? f.ntfy.server.replace(/\/+$/, '') : 'https://ntfy.sh';
  const topic = typeof f?.ntfy?.topic === 'string' && TOPIC_RE.test(f.ntfy.topic) ? f.ntfy.topic : null;
  const webhook = typeof f?.webhook?.url === 'string' && URL_RE.test(f.webhook.url) ? f.webhook.url : null;
  return topic || webhook ? { ntfyServer: server, ntfyTopic: topic, webhookUrl: webhook } : null;
}

export async function loadChannel(path = CHANNEL_PATH): Promise<Channel | null> {
  try {
    return parseChannel(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** What the UI and API may know about the channel: which kinds exist, nothing else. */
export function channelKinds(c: Channel | null): ('ntfy' | 'webhook')[] {
  if (!c) return [];
  return [...(c.ntfyTopic ? (['ntfy'] as const) : []), ...(c.webhookUrl ? (['webhook'] as const) : [])];
}

// ---------- messages ----------

export interface Message {
  key: string;
  kind: 'down' | 'recovered' | 'test' | 'new-device' | 'warning' | 'digest' | 'new-port';
  title: string;
  body: string;
  high: boolean;
  /** ntfy only: URL opened when the notification is tapped (src/core/known.ts: the device in the 기기 tab) */
  click?: string;
  /** ntfy only: action buttons (https://docs.ntfy.sh/publish/#action-buttons), e.g. 열기 · tailnet 공개 (src/core/newports.ts) */
  actions?: NtfyAction[];
}

export type NtfyAction =
  | { action: 'view'; label: string; url: string }
  | { action: 'http'; label: string; url: string; method: 'POST'; headers?: Record<string, string>; clear?: boolean };

export interface Sent {
  channel: 'ntfy' | 'webhook';
  ok: boolean;
  error?: string;
}

export type Sender = (c: Channel, m: Message) => Promise<Sent[]>;

/** compute-pool's dur(): "3 min", "1 h 5 min" */
export function dur(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function short(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "8780 uploader" for ports, the device name for devices. Names and port numbers only, never addresses. */
function subject(key: string, name: string): string {
  return key.startsWith('port:') ? `${key.slice(5)} ${name}` : name;
}

export function downText(key: string, name: string, sinceMs: number, reason: string | undefined): Message {
  const who = subject(key, name);
  if (key.startsWith('device:')) {
    return { key, kind: 'down', title: `portboard: ${who} is offline`, body: `${who} has been offline on the tailnet for ${dur(sinceMs)}.`, high: true };
  }
  const why = reason === 'http' ? 'listening, but HTTP does not answer' : 'nothing is listening';
  return { key, kind: 'down', title: `portboard: ${who} is down`, body: `${who} has been down for ${dur(sinceMs)} (${why}).`, high: true };
}

export function upText(key: string, name: string, downMs: number): Message {
  const who = subject(key, name);
  if (key.startsWith('device:')) {
    return { key, kind: 'recovered', title: `portboard: ${who} is back online (offline ${short(downMs)})`, body: `${who} is online again after ${dur(downMs)}.`, high: false };
  }
  return { key, kind: 'recovered', title: `portboard: ${who} is back (down ${short(downMs)})`, body: `${who} is answering again after ${dur(downMs)}.`, high: false };
}

export function testText(host = hostname()): Message {
  return { key: 'test', kind: 'test', title: 'portboard: test alert', body: `Down alerts from Portboard on ${host} reach this channel.`, high: false };
}

/** Error text from a failed post with every trace of the channel removed. */
export function redact(text: string, c: Channel): string {
  let s = text;
  for (const secret of [c.webhookUrl, c.ntfyTopic && `${c.ntfyServer}/${c.ntfyTopic}`, c.ntfyTopic]) {
    if (secret) s = s.split(secret).join('***');
  }
  return s.slice(0, 200);
}

async function post(url: string, body: string, headers: Record<string, string>, c: Channel, f: typeof fetch): Promise<Omit<Sent, 'channel'>> {
  try {
    const res = await f(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel();
    return res.status < 300 ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    const e = err as Error & { cause?: Error };
    return { ok: false, error: redact([e.message, e.cause?.message].filter(Boolean).join(': '), c) };
  }
}

/** Posts like compute-pool's SendAlert. ntfy gets JSON publishing (https://docs.ntfy.sh/publish/#publish-as-json)
 *  instead of Title headers, so Korean labels survive: fetch refuses non-Latin-1 header values. */
export function httpSender(f: typeof fetch = fetch): Sender {
  return async (c, m) => {
    const sent: Sent[] = [];
    if (c.ntfyTopic) {
      const tags = [m.kind === 'recovered' ? 'white_check_mark' : m.kind === 'test' ? 'bell' : m.kind === 'new-device' ? 'new' : m.kind === 'digest' ? 'memo' : m.kind === 'new-port' ? 'rocket' : 'warning'];
      const body = JSON.stringify({ topic: c.ntfyTopic, title: m.title, message: m.body, priority: m.high ? 4 : 3, tags, ...(m.click ? { click: m.click } : {}), ...(m.actions?.length ? { actions: m.actions } : {}) });
      sent.push({ channel: 'ntfy', ...(await post(`${c.ntfyServer}/`, body, { 'content-type': 'application/json' }, c, f)) });
    }
    if (c.webhookUrl) {
      const body = JSON.stringify({ text: `${m.title}\n${m.body}` }); // Slack-compatible
      sent.push({ channel: 'webhook', ...(await post(c.webhookUrl, body, { 'content-type': 'application/json' }, c, f)) });
    }
    return sent;
  };
}

// ---------- state machine ----------

export interface WatchState {
  name: string;
  /** Seen speaking HTTP at least once: from then on a failed GET / counts as down */
  http: boolean;
  down: boolean;
  fails: number;
  /** First failed check of the current outage (ms) */
  since: number | null;
  reason?: string;
  /** A down alert went out for the current outage, so its end gets a recovery alert */
  alerted: boolean;
  lastDownAlert: number | null;
}

export interface Observation {
  key: string;
  name: string;
  ok: boolean;
  http?: boolean;
  /** 'listen' (nothing listening), 'http' (no HTTP answer) or 'offline' */
  reason?: string;
}

export function step(prev: WatchState | undefined, o: Observation, now: number, quietUntil = 0): { next: WatchState; message: Message | null } {
  const s: WatchState = prev
    ? { ...prev, name: o.name, http: prev.http || !!o.http }
    : { name: o.name, http: !!o.http, down: false, fails: 0, since: null, alerted: false, lastDownAlert: null };

  if (o.ok) {
    const message = s.down && s.alerted && s.since !== null ? upText(o.key, s.name, now - s.since) : null;
    return { next: { ...s, down: false, fails: 0, since: null, reason: undefined, alerted: false }, message };
  }

  // Portboard stopped or restarted it a moment ago: not an outage (yet). Failures count from scratch once the window
  // ends, but the downtime in the alert still starts when it went away.
  if (now < quietUntil && !s.down) return { next: { ...s, fails: 0, since: s.since ?? now, reason: o.reason }, message: null };

  s.fails += 1;
  s.since ??= now;
  s.reason = o.reason;
  if (s.fails >= FAILS_TO_ALERT) s.down = true;
  if (s.down && !s.alerted && (s.lastDownAlert === null || now - s.lastDownAlert >= RATE_MS)) {
    s.alerted = true;
    s.lastDownAlert = now;
    return { next: s, message: downText(o.key, s.name, now - s.since, s.reason) };
  }
  return { next: s, message: null };
}

// ---------- quiet windows (portboard-initiated stop / restart) ----------

let quietQueue: Promise<unknown> = Promise.resolve();

export async function loadQuiet(path = QUIET_PATH): Promise<Record<string, number>> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** Written to a file, not memory: the MCP server is a separate process from the checker. */
export function markQuiet(port: number, until: number | null, path = QUIET_PATH, now = Date.now()): Promise<void> {
  const job = quietQueue.then(async () => {
    const q = await loadQuiet(path);
    for (const [k, t] of Object.entries(q)) if (typeof t !== 'number' || t <= now) delete q[k];
    if (until === null) delete q[port];
    else q[port] = until;
    await writeJson(path, q);
  });
  quietQueue = job.catch(() => {});
  return job;
}

/** Wraps restart/stop so the checker stays quiet about the port for QUIET_MS. */
export function quietly<T extends { ok: boolean }>(fn: (port: number) => Promise<T>, path = QUIET_PATH): (port: number) => Promise<T> {
  return async (port) => {
    await markQuiet(port, Date.now() + QUIET_MS, path).catch(() => {});
    const result = await fn(port);
    if (!result.ok) await markQuiet(port, null, path).catch(() => {});
    return result;
  };
}

// ---------- checker ----------

/** The slice of a snapshot port entry the checker needs */
export interface PortView {
  port: number;
  listening: boolean;
  name: string;
  scope: string | null;
  addresses: string[];
  probe: { http: boolean } | null;
}

export interface CheckerDeps {
  ports(): Promise<PortView[]>;
  /** Tailnet devices by id (Tailscale DNS label); only called when a device is watched */
  devices(): Promise<{ id: string; name: string; online: boolean }[]>;
  watched(): Promise<{ ports: Record<string, { label?: string }>; devices: string[] }>;
  channel?(): Promise<Channel | null>;
  send?: Sender;
  /** Does GET / on host:port get any HTTP answer */
  httpOk?(host: string, port: number): Promise<boolean>;
  now?(): number;
  /** Every check's port observations (also without a channel), for the uptime history; quiet = quiet.json */
  record?(obs: Observation[], now: number, quiet: Record<string, number>): void;
  statePath?: string;
  quietPath?: string;
  logPath?: string;
}

export interface WatchStatus {
  key: string;
  kind: 'port' | 'device';
  port?: number;
  id?: string;
  name: string;
  down: boolean;
  since: string | null;
  alerted: boolean;
  quietUntil: string | null;
  /** Ports only, added by the server from uptime.ts: recent checks and 24 h / 7 d uptime */
  uptime?: UptimeSummary | null;
}

export interface AlertsStatus {
  channel: { configured: boolean; kinds: ('ntfy' | 'webhook')[] };
  checkEverySec: number;
  lastCheck: string | null;
  watching: WatchStatus[];
  recent: { t: string; title: string; ok: boolean }[];
}

export async function httpAnswers(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

function probeHost(p: PortView): string {
  return p.scope === 'loopback' || p.scope === 'all' || !p.scope ? '127.0.0.1' : (p.addresses.find((a) => a !== '*') ?? '127.0.0.1');
}

export function createChecker(deps: CheckerDeps) {
  const now = deps.now ?? Date.now;
  const statePath = deps.statePath ?? STATE_PATH;
  const quietPath = deps.quietPath ?? QUIET_PATH;
  const logPath = deps.logPath ?? LOG_PATH;
  const channel = deps.channel ?? (() => loadChannel());
  const send = deps.send ?? httpSender();
  const httpOk = deps.httpOk ?? httpAnswers;
  let state: Record<string, WatchState> | null = null;
  let lastCheck: number | null = null;
  let running: Promise<void> | null = null;

  async function loadState(): Promise<Record<string, WatchState>> {
    if (state) return state;
    try {
      const raw = JSON.parse(await readFile(statePath, 'utf8'));
      state = raw && typeof raw.watch === 'object' && raw.watch ? raw.watch : {};
    } catch {
      state = {};
    }
    return state!;
  }

  async function deliver(c: Channel, m: Message): Promise<Sent[]> {
    const sent = await send(c, m).catch((err) => [{ channel: 'ntfy' as const, ok: false, error: redact(String(err), c) }]);
    const line = { t: new Date(now()).toISOString(), key: m.key, kind: m.kind, title: m.title, body: m.body, sent };
    await appendPrivate(logPath, `${JSON.stringify(line)}\n`).catch(() => {});
    return sent;
  }

  /** One observation per watched port; null when `ss` failed (an empty listener list, though Portboard itself listens). */
  async function observePorts(ports: Record<string, { label?: string }>, prev: Record<string, WatchState>): Promise<Observation[] | null> {
    const views = await deps.ports();
    if (!views.length) return null;
    const obs: Observation[] = [];
    for (const [portStr, pref] of Object.entries(ports)) {
      const port = Number(portStr);
      const key = `port:${port}`;
      const v = views.find((x) => x.port === port && x.listening);
      const known = prev[key];
      const name = pref.label ?? v?.name ?? known?.name ?? `port ${port}`;
      const http = !!v?.probe?.http;
      if (!v) obs.push({ key, name, ok: false, reason: 'listen' });
      else if (http || !known?.http) obs.push({ key, name, ok: true, http });
      else obs.push((await httpOk(probeHost(v), port)) ? { key, name, ok: true, http: true } : { key, name, ok: false, reason: 'http' });
    }
    return obs;
  }

  async function check(): Promise<void> {
    const w = await deps.watched();
    const prev = await loadState();
    const keys = [...Object.keys(w.ports).map((p) => `port:${p}`), ...w.devices.map((d) => `device:${d}`)];
    const next: Record<string, WatchState> = {};
    // Ports are checked with or without a channel: the uptime history wants every check.
    const portObs = Object.keys(w.ports).length ? await observePorts(w.ports, prev) : [];
    const quiet = await loadQuiet(quietPath);
    if (portObs?.length && deps.record) {
      try {
        deps.record(portObs, now(), quiet);
      } catch (err) {
        console.error(`[portboard] uptime record: ${(err as Error).message}`);
      }
    }
    const c = keys.length ? await channel() : null;
    if (c) {
      const obs: Observation[] = [...(portObs ?? [])];
      if (!portObs) for (const p of Object.keys(w.ports)) if (prev[`port:${p}`]) next[`port:${p}`] = prev[`port:${p}`];
      // tailscale status failing is no reason to call every device offline: keep their state as it was
      const devs = w.devices.length ? await deps.devices().catch(() => null) : null;
      for (const id of w.devices) if (!devs && prev[`device:${id}`]) next[`device:${id}`] = prev[`device:${id}`];
      if (devs) {
        for (const id of w.devices) {
          const d = devs.find((x) => x.id === id);
          obs.push({ key: `device:${id}`, name: d?.name ?? prev[`device:${id}`]?.name ?? id, ok: !!d?.online, reason: 'offline' });
        }
      }
      const t = now();
      for (const o of obs) {
        const until = o.key.startsWith('port:') ? (quiet[o.key.slice(5)] ?? 0) : 0;
        const { next: s, message } = step(prev[o.key], o, t, until);
        next[o.key] = s;
        if (!message) continue;
        const sent = await deliver(c, message);
        // Nothing got through: try the down alert again next check instead of going quiet for the outage
        if (message.kind === 'down' && !sent.some((x) => x.ok)) next[o.key] = { ...s, alerted: false, lastDownAlert: prev[o.key]?.lastDownAlert ?? null };
      }
    } else {
      // No channel: send nothing, but keep what we knew so a channel coming back doesn't lose an outage, and learn
      // which ports speak HTTP so the uptime history can tell "listening but not answering" from up.
      for (const k of keys) if (prev[k]) next[k] = prev[k];
      for (const o of portObs ?? []) {
        if (!o.http || next[o.key]?.http) continue;
        next[o.key] = next[o.key]
          ? { ...next[o.key], http: true }
          : { name: o.name, http: true, down: false, fails: 0, since: null, alerted: false, lastDownAlert: null };
      }
    }
    lastCheck = now();
    if (JSON.stringify(next) !== JSON.stringify(prev)) {
      state = next;
      await writeJson(statePath, { version: 1, watch: next }).catch((err) => console.error(`[portboard] alerts state: ${(err as Error).message}`));
    }
  }

  return {
    /** One check; overlapping calls share the run in progress. */
    tick(): Promise<void> {
      running ??= check()
        .then(
          () => reportHealth('alerts', { ok: true }),
          (err) => {
            console.error(`[portboard] alert check failed: ${(err as Error).message}`);
            reportHealth('alerts', { ok: false, error: (err as Error).message });
          },
        )
        .finally(() => (running = null));
      return running;
    },

    start(every = CHECK_MS): () => void {
      const timer = setInterval(() => void this.tick(), every);
      timer.unref();
      void this.tick();
      return () => clearInterval(timer);
    },

    async test(): Promise<{ ok: boolean; message: string; sent: Sent[] }> {
      const c = await channel();
      if (!c) return { ok: false, message: t('alertsMsg.noChannel'), sent: [] };
      const sent = await deliver(c, testText());
      const ok = sent.length > 0 && sent.every((s) => s.ok);
      return { ok, message: ok ? t('alertsMsg.testSent') : t('alertsMsg.sendFailed', { errors: sent.filter((s) => !s.ok).map((s) => `${s.channel} ${s.error}`).join(', ') }), sent };
    },

    async status(): Promise<AlertsStatus> {
      const [w, c, st, quiet, recent] = await Promise.all([deps.watched(), channel(), loadState(), loadQuiet(quietPath), readRecent(logPath)]);
      const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
      const t = now();
      const watching: WatchStatus[] = [
        ...Object.entries(w.ports).map(([p, pref]): WatchStatus => {
          const s = st[`port:${p}`];
          const q = quiet[p] && quiet[p] > t ? quiet[p] : null;
          return { key: `port:${p}`, kind: 'port', port: Number(p), name: pref.label ?? s?.name ?? `port ${p}`, down: !!s?.down, since: iso(s?.since), alerted: !!s?.alerted, quietUntil: iso(q) };
        }),
        ...w.devices.map((id): WatchStatus => {
          const s = st[`device:${id}`];
          return { key: `device:${id}`, kind: 'device', id, name: s?.name ?? id, down: !!s?.down, since: iso(s?.since), alerted: !!s?.alerted, quietUntil: null };
        }),
      ];
      return { channel: { configured: !!c, kinds: channelKinds(c) }, checkEverySec: CHECK_MS / 1000, lastCheck: iso(lastCheck), watching, recent };
    },
  };
}

export type Checker = ReturnType<typeof createChecker>;

/** Sent alerts for one key (`port:8780`), newest first: what the service page lists. */
export async function readEvents(key: string, path = LOG_PATH, n = 20): Promise<{ t: string; kind: string; title: string; ok: boolean }[]> {
  try {
    const out: { t: string; kind: string; title: string; ok: boolean }[] = [];
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      try {
        const r = JSON.parse(lines[i]);
        if (r?.key !== key) continue;
        out.push({ t: r.t, kind: r.kind, title: r.title, ok: Array.isArray(r.sent) && r.sent.length > 0 && r.sent.every((s: Sent) => s.ok) });
      } catch {
        // a torn line
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function readRecent(path: string, n = 5): Promise<AlertsStatus['recent']> {
  try {
    const lines = (await readFile(path, 'utf8')).trim().split('\n').slice(-n).reverse();
    return lines.flatMap((l) => {
      try {
        const r = JSON.parse(l);
        return [{ t: r.t, title: r.title, ok: Array.isArray(r.sent) && r.sent.length > 0 && r.sent.every((s: Sent) => s.ok) }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writePrivate(path, () => `${JSON.stringify(value, null, 2)}\n`);
}

// ---------- wiring for the server process ----------

/** The checker with its real inputs: prefs.json, `tailscale status`, and a snapshot source (the server's cached one). */
export function defaultChecker(ports: () => Promise<PortView[]>, extra: Partial<CheckerDeps> = {}): Checker {
  return createChecker({
    ...extra,
    ports,
    async devices() {
      const r = await runShared('tailscale', ['status', '--json']);
      if (!r.ok) throw new Error('tailscale status failed'); // no observation beats a false "offline"
      return parsePeers(r.stdout).map((p) => ({ id: p.name, name: p.name, online: p.online }));
    },
    async watched() {
      const prefs = await loadPrefs();
      const watchedPorts: Record<string, { label?: string }> = {};
      for (const [port, p] of Object.entries(prefs.ports)) if (p.alert) watchedPorts[port] = { label: p.label };
      return { ports: watchedPorts, devices: Object.keys(prefs.deviceAlerts ?? {}) };
    },
  });
}
