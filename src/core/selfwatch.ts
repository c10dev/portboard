// Portboard watching its own data collection, and the credentials it depends on.
//
//   collectors  health.ts's registry, read once a minute. A collector that has failed for more than
//               PORTBOARD_SELFWATCH_MIN minutes (default 15) without a good attempt in between gets one alert
//               through compute-pool's channel (alerts.ts); the first good attempt after that gets one recovery
//               alert. At most one down alert per collector per hour. Turned-off and not-yet-set-up collectors
//               (no proxmox.json, Proxmox key not installed and never worked) are shown, not alerted.
//   expiry      once an hour: the Proxmox API token's `expire` (GET /access/users/{user}/token/{id}, or with only
//               PVEAuditor /access/users?full=1; via the pinned client, and the user's own expire) and the remote MCP clients' refresh tokens (remote.json, read only). One warning per
//               credential and expiry date once it is within 7 days or past. Where nothing can expire (the SSH key,
//               the ntfy topic) it says so; where the date can't be read it says unknown instead of guessing.
//   state       ~/.local/state/portboard/selfwatch.json (down/up state across restarts, warnings sent, and the last
//               view for the MCP server, which is another process)
//   log         sent alerts go to alerts.jsonl like every other Portboard alert (titles only, no channel details)

import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dur, httpSender, loadChannel, LOG_PATH, redact, type Channel, type Message, type Sender, type Sent } from './alerts.ts';
import { clean, COLLECTORS, health, type CollectorHealth } from './health.ts';
import { PATHS } from './paths.ts';
import { SITE } from './site.ts';
import { runbookForCollector, runbookForExpiry } from './runbooks.ts';
import { loadConfig as loadProxmoxConfig, pveGet, PROXMOX_PATH, type ProxmoxConfig } from './proxmox.ts';
import { appendPrivate, writePrivate } from './atomic.ts';
import { t } from './i18n.ts';

// Preview instances get their own state dir (core/paths.ts), so a preview never rewrites production's self-watch state.
export const SELFWATCH_PATH = join(PATHS.stateDir, 'selfwatch.json');

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const SELFWATCH_EVERY = MIN;
/** The first look waits a little: right after start every collector is still on its first attempt. */
export const SELFWATCH_FIRST = Math.min(SELFWATCH_EVERY, 20_000);
export const THRESHOLD_MS = Math.max(1, Number(process.env.PORTBOARD_SELFWATCH_MIN) || 15) * MIN;
export const SELF_RATE_MS = 60 * MIN;
/** A collector that hasn't reported for this long is failing too (its loop is stuck); hostkeys probes only on demand */
export const STALE_MS = 30 * MIN;
const NO_STALE = new Set(['hostkeys']);
export const EXPIRY_EVERY = 60 * MIN;
export const EXPIRY_WARN_MS = 7 * DAY;

/** For alert texts (English, like the other alerts). */
const ABOUT: Record<string, string> = {
  usage: 'port and connection sampling',
  pool: 'compute-pool host status',
  proxmox: 'Proxmox API',
  'pve-ports': `${SITE.pve.node} ports over SSH`,
  'win-ports': 'desktop Windows ports over SSH',
  hostkeys: 'SSH host-key probes',
  history: 'usage history file',
  'known-devices': 'known-devices file',
  alerts: 'down-alert checker',
  memory: 'memory sampling',
};

// ---------- collector state machine ----------

export interface CollectorState {
  down: boolean;
  /** ms: first failure of the current run, kept across restarts */
  failingSince: number | null;
  /** a down alert went out for this run, so its end gets a recovery alert */
  alerted: boolean;
  lastDownAlert: number | null;
  /** has worked at least once: from then on a setup error (key removed) is an outage */
  everOk: boolean;
  lastOk: number | null;
  lastError: string | null;
}

export const emptyCollector = (): CollectorState => ({ down: false, failingSince: null, alerted: false, lastDownAlert: null, everOk: false, lastOk: null, lastError: null });

export type CollectorView = 'ok' | 'failing' | 'down' | 'off' | 'setup' | 'pending';

/** What one collector looks like now: off and setup are not watched. */
export function viewOf(rec: CollectorHealth | undefined, st: CollectorState | undefined, now: number): { view: CollectorView; failing: boolean; error: string | null } {
  if (!rec) return { view: 'pending', failing: false, error: null };
  if (!rec.enabled) return { view: 'off', failing: false, error: rec.lastError };
  const stale = !NO_STALE.has(rec.name) && now - rec.checkedAt > STALE_MS;
  if (rec.ok && !stale) return { view: 'ok', failing: false, error: null };
  if (!rec.ok && rec.setup && !st?.everOk) return { view: 'setup', failing: false, error: rec.lastError };
  const error = stale ? `no report for ${dur(now - rec.checkedAt)}` : rec.lastError;
  return { view: st?.down ? 'down' : 'failing', failing: true, error };
}

export function downText(name: string, failingMs: number, error: string | null, lastOkAgo: number | null): Message {
  const what = ABOUT[name] ?? name;
  const last = lastOkAgo !== null ? ` Last good read ${dur(lastOkAgo)} ago.` : '';
  const runbook = runbookForCollector(name);
  return {
    key: `collector:${name}`,
    kind: 'down',
    title: `portboard: ${name} collection failing`,
    body: `${what} has failed for ${dur(failingMs)}${error ? ` (${error})` : ''}.${last} The dashboard shows stale or missing data for it.${runbook ? ` If its credential was rotated or rejected: ${runbook}` : ''}`,
    high: false,
  };
}

export function upText(name: string, failedMs: number): Message {
  return { key: `collector:${name}`, kind: 'recovered', title: `portboard: ${name} collection is back`, body: `${ABOUT[name] ?? name} works again after ${dur(failedMs)}.`, high: false };
}

export interface StepOptions {
  threshold?: number;
  rate?: number;
}

/**
 * One collector, one minute. rec undefined (nothing reported since this process started) keeps the state as it was:
 * an empty registry after a restart is not a recovery.
 */
export function stepCollector(prev: CollectorState | undefined, rec: CollectorHealth | undefined, now: number, opts: StepOptions = {}): { next: CollectorState; message: Message | null } {
  const threshold = opts.threshold ?? THRESHOLD_MS;
  const rate = opts.rate ?? SELF_RATE_MS;
  const s: CollectorState = { ...emptyCollector(), ...prev };
  if (!rec) return { next: s, message: null };
  const { view, failing, error } = viewOf(rec, s, now);
  if (view === 'off' || view === 'setup') return { next: { ...s, down: false, failingSince: null, alerted: false, lastError: error }, message: null };
  if (!failing) {
    const message = s.alerted && s.failingSince !== null ? upText(rec.name, now - s.failingSince) : null;
    return { next: { ...s, down: false, failingSince: null, alerted: false, everOk: true, lastOk: rec.lastOk ?? now, lastError: null }, message };
  }
  s.failingSince ??= rec.since ?? now;
  s.lastError = error;
  if (rec.lastOk) s.lastOk = Math.max(s.lastOk ?? 0, rec.lastOk);
  if (now - s.failingSince >= threshold) s.down = true;
  if (s.down && !s.alerted && (s.lastDownAlert === null || now - s.lastDownAlert >= rate)) {
    s.alerted = true;
    s.lastDownAlert = now;
    return { next: s, message: downText(rec.name, now - s.failingSince, error, s.lastOk ? now - s.lastOk : null) };
  }
  return { next: s, message: null };
}

// ---------- expiry ----------

export type ExpiryStatus = 'ok' | 'soon' | 'expired' | 'never' | 'unknown';

export interface ExpiryItem {
  /** stable key for the warning state: proxmox-token, remote:<hash of the client id>, ssh-key, ntfy */
  key: string;
  name: string;
  /** ms; null when it never expires or can't be read */
  expiresAt: number | null;
  status: ExpiryStatus;
  /** what was found: "no expiry", "token lacks permission to read it", "last used 25 d ago" */
  note: string | null;
}

export function expiryStatus(expiresAt: number | null, now: number, warn = EXPIRY_WARN_MS): ExpiryStatus {
  if (expiresAt === null) return 'never';
  if (expiresAt <= now) return 'expired';
  return expiresAt - now <= warn ? 'soon' : 'ok';
}

/** `user@realm!name` → the documented token endpoint (PVEAuditor or the token's own user may read it). */
export function tokenPath(tokenId: string): string | null {
  const m = /^([^!\s]+)!([^\s=]+)$/.exec(tokenId);
  return m ? `/access/users/${encodeURIComponent(m[1])}/token/${encodeURIComponent(m[2])}` : null;
}

/** GET /access/users/{user}/token/{id} → {expire: 0 | epoch seconds, privsep, comment}; 0 or absent = never. */
export function proxmoxTokenItem(data: any, now: number): ExpiryItem {
  const base = { key: 'proxmox-token', name: 'Proxmox API token' };
  const exp = data?.expire;
  if (exp === undefined || exp === null || exp === 0 || exp === '0') return { ...base, expiresAt: null, status: 'never', note: 'no expiry set on the token' };
  const n = Number(exp);
  if (!Number.isFinite(n) || n < 0) return { ...base, expiresAt: null, status: 'unknown', note: 'Proxmox answered without a readable expire' };
  const at = n * 1000;
  return { ...base, expiresAt: at, status: expiryStatus(at, now), note: null };
}

/** The token's own expire, and the user's: a token stops working when its user expires, whichever comes first. */
export function withUserExpiry(item: ExpiryItem, userExpire: unknown, now: number): ExpiryItem {
  const n = Number(userExpire);
  if (!Number.isFinite(n) || n <= 0) return item;
  const at = n * 1000;
  if (item.expiresAt !== null && item.expiresAt <= at) return item;
  if (item.status === 'unknown' && item.expiresAt === null) return item;
  return { ...item, expiresAt: at, status: expiryStatus(at, now), note: 'its user account expires then' };
}

/**
 * /access/users?full=1 (Sys.Audit, which PVEAuditor has) lists each user's expire and tokens with theirs; the token
 * endpoint itself wants User.Modify or the token's own user, so it is only the first try.
 */
export function proxmoxFromUsers(users: unknown, tokenId: string, now: number): ExpiryItem | null {
  const [userid, tokenid] = tokenId.split('!');
  const u = Array.isArray(users) ? users.find((x: any) => x?.userid === userid) : null;
  const t = Array.isArray(u?.tokens) ? u.tokens.find((x: any) => x?.tokenid === tokenid) : null;
  return t ? withUserExpiry(proxmoxTokenItem(t, now), u.expire, now) : null;
}

export async function proxmoxExpiry(now: number, path = PROXMOX_PATH, get: (cfg: ProxmoxConfig, p: string) => Promise<any> = pveGet): Promise<ExpiryItem[]> {
  const { cfg } = await loadProxmoxConfig(path);
  if (!cfg) return [];
  const p = tokenPath(cfg.tokenId);
  const unknown = (note: string): ExpiryItem[] => [{ key: 'proxmox-token', name: 'Proxmox API token', expiresAt: null, status: 'unknown', note }];
  if (!p) return unknown('tokenId is not user@realm!name');
  try {
    return [proxmoxTokenItem(await get(cfg, p), now)];
  } catch {
    // usually HTTP 403: try the user list
  }
  try {
    return [proxmoxFromUsers(await get(cfg, '/access/users?full=1'), cfg.tokenId, now) ?? unknown('the token is not in the user list it may read')[0]];
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    return unknown(/HTTP 403/.test(msg) ? 'the token may not read user or token expiry (HTTP 403)' : `could not read it: ${clean(msg) ?? 'error'}`);
  }
}

/**
 * remote.json → one item per client that still holds a refresh token: its newest refresh token's expiry. A refresh
 * token is rotated on every use, so one nearing its 30-day end means that client hasn't connected for weeks.
 * Hashes never leave this function; the key is a hash of the client id.
 */
export function remoteItems(state: any, now: number): ExpiryItem[] {
  const clients: Record<string, any> = state?.clients && typeof state.clients === 'object' ? state.clients : {};
  const newest = new Map<string, { at: number; name: string }>();
  for (const t of Object.values<any>(state?.tokens && typeof state.tokens === 'object' ? state.tokens : {})) {
    if (t?.kind !== 'refresh' || typeof t.expiresAt !== 'number' || typeof t.clientId !== 'string') continue;
    const cur = newest.get(t.clientId);
    if (!cur || t.expiresAt > cur.at) newest.set(t.clientId, { at: t.expiresAt, name: String(t.clientName ?? '') });
  }
  return [...newest].map(([id, { at, name }]) => {
    const c = clients[id];
    const used = typeof c?.lastUsedAt === 'number' ? c.lastUsedAt : null;
    return {
      key: `remote:${createHash('sha256').update(id).digest('hex').slice(0, 12)}`,
      name: `remote MCP client ${(c?.name ?? name) || 'unnamed'}`.slice(0, 80),
      expiresAt: at,
      status: expiryStatus(at, now),
      note: used ? `last connected ${dur(now - used)} ago` : null,
    };
  });
}

export async function remoteExpiry(now: number, path = PATHS.remoteConfig): Promise<ExpiryItem[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  try {
    return remoteItems(JSON.parse(text), now);
  } catch {
    return [{ key: 'remote', name: 'remote MCP tokens', expiresAt: null, status: 'unknown', note: 'remote.json is not valid JSON' }];
  }
}

/** Credentials that cannot expire, listed so "no warning" doesn't read as "not checked". */
export async function neverItems(channel: Channel | null, key = join(homedir(), '.ssh', 'portboard_ro')): Promise<ExpiryItem[]> {
  const out: ExpiryItem[] = [];
  if (await access(key, constants.R_OK).then(() => true, () => false)) out.push({ key: 'ssh-key', name: 'SSH key portboard_ro', expiresAt: null, status: 'never', note: 'SSH keys have no expiry' });
  if (channel?.ntfyTopic) out.push({ key: 'ntfy', name: 'ntfy topic', expiresAt: null, status: 'never', note: 'ntfy topics have no expiry' });
  if (channel?.webhookUrl) out.push({ key: 'webhook', name: 'alert webhook', expiresAt: null, status: 'unknown', note: 'a webhook URL carries no expiry date' });
  return out;
}

export function warningText(item: ExpiryItem, now: number): Message {
  const when = item.expiresAt === null ? '' : item.status === 'expired' ? ` expired ${dur(now - item.expiresAt)} ago` : ` expires in ${dur(item.expiresAt - now)}`;
  const hint = item.key === 'proxmox-token' ? ` Renew it on ${SITE.pve.node} (Datacenter → API Tokens) and update proxmox.json.` : item.key.startsWith('remote:') ? ' Use the connector once to refresh it, or reconnect it.' : '';
  const runbook = runbookForExpiry(item.key);
  return {
    key: `expiry:${item.key}`,
    kind: 'warning',
    title: `portboard: ${item.name}${item.status === 'expired' ? ' expired' : ' expires soon'}`,
    body: `${item.name}${when}${item.note ? ` (${item.note})` : ''}.${hint}${runbook ? ` Runbook: ${runbook}` : ''}`,
    high: false,
  };
}

// ---------- watcher ----------

export interface SelfWatchFile {
  version: 1;
  lastCheck: number | null;
  collectors: Record<string, CollectorState>;
  /** expiry key → the expiry date a warning went out for */
  warned: Record<string, { expiresAt: number | null; at: number }>;
  expiry: { at: number | null; items: ExpiryItem[] };
  /** the last status, for processes without the registry (the MCP server) */
  view?: SelfWatchStatus;
}

export const emptySelfWatch = (): SelfWatchFile => ({ version: 1, lastCheck: null, collectors: {}, warned: {}, expiry: { at: null, items: [] } });

export interface CollectorStatus {
  name: string;
  label: string;
  view: CollectorView;
  enabled: boolean;
  ok: boolean;
  checkedAt: string | null;
  lastOk: string | null;
  lastError: string | null;
  failures: number;
  failingSince: string | null;
  alerted: boolean;
}

export interface SelfWatchStatus {
  checkEverySec: number;
  thresholdMin: number;
  lastCheck: string | null;
  /** collectors failing now (failing or down), not counting off / setup */
  failing: number;
  /** "수집 정상" / "2개 실패" */
  summary: string;
  collectors: CollectorStatus[];
  /** runbook: how to rotate that credential (docs/runbooks/), null when there is none */
  expiry: { checkedAt: string | null; items: (Omit<ExpiryItem, 'expiresAt'> & { expiresAt: string | null; runbook: string | null })[] };
}

export interface SelfWatchDeps {
  collectors?(): CollectorHealth[];
  expiry?(now: number, channel: Channel | null): Promise<ExpiryItem[]>;
  channel?(): Promise<Channel | null>;
  send?: Sender;
  /** false: track and show, send nothing (PORTBOARD_ALERTS=off) */
  alertsOn?: boolean;
  now?(): number;
  threshold?: number;
  statePath?: string;
  logPath?: string;
  log?(line: string): void;
}

export async function loadSelfWatch(path = SELFWATCH_PATH): Promise<SelfWatchFile> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    if (raw?.version !== 1) return emptySelfWatch();
    return {
      ...emptySelfWatch(),
      ...raw,
      collectors: raw.collectors && typeof raw.collectors === 'object' ? raw.collectors : {},
      warned: raw.warned && typeof raw.warned === 'object' ? raw.warned : {},
      expiry: raw.expiry && Array.isArray(raw.expiry.items) ? raw.expiry : { at: null, items: [] },
    };
  } catch {
    return emptySelfWatch();
  }
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

export function statusOf(file: SelfWatchFile, recs: CollectorHealth[], now: number, threshold = THRESHOLD_MS): SelfWatchStatus {
  const names = [...new Set([...recs.map((r) => r.name), ...Object.keys(file.collectors)])];
  const order = Object.keys(COLLECTORS);
  const rank = (n: string) => (order.includes(n) ? order.indexOf(n) : order.length);
  const collectors = names
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((name): CollectorStatus => {
      const rec = recs.find((r) => r.name === name);
      const st = file.collectors[name];
      const v = viewOf(rec, st, now);
      return {
        name,
        label: COLLECTORS[name] ?? name,
        view: v.view === 'failing' && st?.down ? 'down' : v.view,
        enabled: rec?.enabled ?? true,
        ok: v.view === 'ok',
        checkedAt: iso(rec?.checkedAt),
        lastOk: iso(Math.max(rec?.lastOk ?? 0, st?.lastOk ?? 0) || null),
        lastError: v.error ?? (v.view === 'pending' ? null : rec?.lastError ?? null),
        failures: rec?.failures ?? 0,
        failingSince: v.failing ? iso(st?.failingSince ?? rec?.since) : null,
        alerted: !!st?.alerted && v.failing,
      };
    });
  const failing = collectors.filter((c) => c.view === 'failing' || c.view === 'down').length;
  return {
    checkEverySec: SELFWATCH_EVERY / 1000,
    thresholdMin: Math.round(threshold / MIN),
    lastCheck: iso(file.lastCheck),
    failing,
    summary: failing ? t('selfwatchMsg.failing', { n: failing }) : t('selfwatchMsg.ok'),
    collectors,
    expiry: { checkedAt: iso(file.expiry.at), items: file.expiry.items.map((i) => ({ ...i, expiresAt: iso(i.expiresAt), runbook: runbookForExpiry(i.key) })) },
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writePrivate(path, () => `${JSON.stringify(value, null, 1)}\n`);
}

export async function defaultExpiry(now: number, channel: Channel | null): Promise<ExpiryItem[]> {
  const parts = await Promise.all([proxmoxExpiry(now).catch(() => []), remoteExpiry(now).catch(() => []), neverItems(channel).catch(() => [])]);
  return parts.flat();
}

export function createSelfWatch(deps: SelfWatchDeps = {}) {
  const now = deps.now ?? Date.now;
  const collectors = deps.collectors ?? (() => health.all());
  const expiry = deps.expiry ?? defaultExpiry;
  const channel = deps.channel ?? (() => loadChannel());
  const send = deps.send ?? httpSender();
  const alertsOn = deps.alertsOn ?? true;
  const threshold = deps.threshold ?? THRESHOLD_MS;
  const statePath = deps.statePath ?? SELFWATCH_PATH;
  const logPath = deps.logPath ?? LOG_PATH;
  const log = deps.log ?? ((line: string) => console.error(line));
  let file: SelfWatchFile | null = null;
  let written = '';
  let lastWrite = 0;
  /** expiry is read once per process at the first check (proxmox.json may have changed while it was stopped) */
  let expiryRead = false;
  let running: Promise<void> | null = null;

  async function load(): Promise<SelfWatchFile> {
    if (!file) {
      file = await loadSelfWatch(statePath);
    }
    return file;
  }

  /** Sends one message; true when at least one channel took it. With alerts off or no channel nothing is sent. */
  async function deliver(c: Channel | null, m: Message): Promise<boolean> {
    if (!alertsOn || !c) return false;
    const sent: Sent[] = await send(c, m).catch((err) => [{ channel: 'ntfy' as const, ok: false, error: redact(String(err), c) }]);
    const line = { t: new Date(now()).toISOString(), key: m.key, kind: m.kind, title: m.title, body: m.body, sent };
    await appendPrivate(logPath, `${JSON.stringify(line)}\n`).catch(() => {});
    return sent.some((x) => x.ok);
  }

  async function check(forceExpiry = false): Promise<void> {
    const f = await load();
    const t = now();
    const recs = collectors();
    // After a long gap (Portboard was stopped), a failure run from before the gap is not "continuous".
    const gap = f.lastCheck !== null && t - f.lastCheck > threshold;
    const c = await channel().catch(() => null);
    const next: Record<string, CollectorState> = {};
    for (const name of new Set([...Object.keys(f.collectors), ...recs.map((r) => r.name)])) {
      let prev = f.collectors[name];
      if (gap && prev && !prev.down) prev = { ...prev, failingSince: null };
      const rec = recs.find((r) => r.name === name);
      const { next: s, message } = stepCollector(prev, rec, t, { threshold });
      next[name] = s;
      if (s.down !== !!prev?.down || (message && message.kind === 'recovered')) log(`[portboard] self-watch: ${name} ${s.down ? `down — ${s.lastError ?? 'failed'}` : 'ok'}`);
      if (!message) continue;
      const ok = await deliver(c, message);
      // Nothing got through: try the down alert again next minute instead of staying quiet for the whole run.
      if (message.kind === 'down' && !ok) next[name] = { ...s, alerted: false, lastDownAlert: prev?.lastDownAlert ?? null };
    }
    f.collectors = next;

    if (forceExpiry || !expiryRead || f.expiry.at === null || t - f.expiry.at >= EXPIRY_EVERY) {
      expiryRead = true;
      const items = await expiry(t, c).catch(() => f.expiry.items);
      f.expiry = { at: t, items };
      for (const item of items) {
        if (item.status !== 'soon' && item.status !== 'expired') continue;
        const w = f.warned[item.key];
        if (w && w.expiresAt === item.expiresAt) continue;
        if (await deliver(c, warningText(item, t))) f.warned[item.key] = { expiresAt: item.expiresAt, at: t };
      }
      // A credential that was renewed or removed may warn again later.
      for (const k of Object.keys(f.warned)) {
        const item = items.find((i) => i.key === k);
        if (!item || item.status === 'ok' || item.status === 'never') delete f.warned[k];
      }
    }

    f.lastCheck = t;
    f.view = statusOf({ ...f, view: undefined }, recs, t, threshold);
    const text = JSON.stringify({ ...f, view: { ...f.view, lastCheck: null, collectors: f.view.collectors.map((x) => ({ ...x, checkedAt: null, lastOk: null })) }, lastCheck: null });
    // Write when something other than the timestamps changed, else at most every 10 minutes.
    if (text !== written || t - lastWrite >= 10 * MIN) {
      await writeJson(statePath, f)
        .then(() => {
          written = text;
          lastWrite = t;
        })
        .catch((err) => log(`[portboard] self-watch state: ${(err as Error).message}`));
    }
  }

  return {
    tick(forceExpiry = false): Promise<void> {
      running ??= check(forceExpiry)
        .catch((err) => log(`[portboard] self-watch failed: ${(err as Error).message}`))
        .finally(() => (running = null));
      return running;
    },

    async status(): Promise<SelfWatchStatus> {
      return statusOf(await load(), collectors(), now(), threshold);
    },
  };
}

export type SelfWatch = ReturnType<typeof createSelfWatch>;

/** For the MCP server (another process): the view the server last wrote, or null. */
export async function savedStatus(path = SELFWATCH_PATH): Promise<SelfWatchStatus | null> {
  return (await loadSelfWatch(path)).view ?? null;
}
