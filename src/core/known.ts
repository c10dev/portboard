// Known devices and the "새 기기" (new device) alert.
//
//   ~/.local/state/portboard/known-devices.json   (PORTBOARD_STATE_DIR moves it, like the alert state)
//
// Every device that has connected to a service here, and every MAC seen in this server's neighbour table, is recorded
// under a stable key: `ts:<Tailscale DNS label>` for tailnet devices, `mac:<mac>` for LAN devices (random Wi-Fi MACs
// too: they are stable per network), `ip:<ip>` when the MAC is unknown. The first run seeds the record from what is
// visible now (cards, neighbours, the last-used history), so nothing is "new" on day one.
//
// After that, a device's first connection to a service (on by default) and, optionally, a MAC's first appearance in
// `ip neigh` (off by default: Linux adds entries for anything this server talks to, which is noisy) mark it pending
// ("새 기기" on its card until 확인 or 이름 붙이기) and queue one alert through the down-alert channel. Alerts are
// batched: at most one message per RATE_MS, listing everything that came up since the last one.
// Alerts carry names, vendors and services only, never addresses or MACs (same rule as the down alerts).
//
// Not tracked: this server, compute-pool hosts (configured by the user), subnet-routed traffic (the router is the
// device), tailnet IPs `tailscale status` doesn't know (transient), docker and tailscale serve legs, internet clients.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from './paths.ts';
import { CHECK_MS, httpSender, loadChannel, LOG_PATH, RATE_MS, type Channel, type Message, type Sender, type Sent } from './alerts.ts';
import { isRandomMac, nameKey, resolveName, vendorOf, type NameSource, type Neighbor } from './clients.ts';
import type { HistoryView } from './history.ts';
import type { DeviceCard, Usage } from './usage.ts';
import { reportHealth } from './health.ts';
import { appendPrivate, writePrivate } from './atomic.ts';
import { t } from './i18n.ts';
import { LOCALES } from './site.ts';

export const KNOWN_PATH = PATHS.known;
/** Oldest non-pending records go first past this (random MACs rotate) */
const MAX_RECORDS = 2000;

export type Scope = 'connection' | 'neighbor';

export interface KnownDevice {
  key: string;
  kind: 'tailnet' | 'lan';
  /** Display name when last seen */
  name: string;
  nameSource: NameSource;
  vendor: string | null;
  mac: string | null;
  /** Last LAN address (UI and local MCP only; never in an alert) */
  ip: string | null;
  /** 기기 card id (devices.html#<id>) */
  cardId: string | null;
  /** clients.json key for 이름 붙이기 (LAN devices) */
  nameKey: string | null;
  firstSeen: number;
  /** First connection to a service on this server */
  connected: number | null;
  /** First seen in the neighbour table */
  neighbor: number | null;
  /** The service it first used */
  service: { port: number; name: string } | null;
  /** Recorded by the first-run seeding */
  seeded?: true;
  /** Unacknowledged: shown as 새 기기 until 확인 (or 이름 붙이기) */
  pending: Scope | null;
  /** Queued for an alert */
  notify: boolean;
  notified: number | null;
}

export interface KnownStore {
  version: 1;
  seededAt: number | null;
  /** Last new-device alert that went out (rate limit; persisted so a restart doesn't reset the window) */
  lastSent: number | null;
  devices: Record<string, KnownDevice>;
}

export const emptyKnown = (): KnownStore => ({ version: 1, seededAt: null, lastSent: null, devices: {} });

export interface Sighting {
  key: string;
  kind: KnownDevice['kind'];
  name: string;
  nameSource: NameSource;
  vendor: string | null;
  mac: string | null;
  ip: string | null;
  cardId: string | null;
  nameKey: string | null;
  service?: { port: number; name: string };
}

export interface Observation {
  /** Devices with a (non-routed) connection to a service right now */
  connected: Sighting[];
  /** LAN neighbours (docker/bridge interfaces left out) */
  neighbors: Sighting[];
  /** Every device with a card (tailnet peers online or not, LAN cards) and what the last-used history knows; used
   *  only by the first-run seeding, so a tailnet peer that merely appears later still alerts when it first connects */
  present: Sighting[];
}

export interface NewDeviceSettings {
  connections: boolean;
  neighbors: boolean;
}

// ---------- identity ----------

/** The known-devices key of a 기기 card, or null for what isn't tracked. */
export function cardKey(c: Pick<DeviceCard, 'id' | 'kind' | 'mac' | 'addresses' | 'lanIps'>): string | null {
  if (c.kind === 'tailnet') return `ts:${c.id}`;
  if (c.kind === 'lan') {
    const ip = c.addresses[0] ?? c.lanIps[0];
    return c.mac ? `mac:${c.mac.toLowerCase()}` : ip ? `ip:${ip}` : null;
  }
  return null;
}

/** Interfaces whose neighbours are containers or VMs on this host, not devices on the network */
const VIRTUAL_DEV = /^(docker|br-|veth|virbr|cni|flannel|cali|tailscale|lxc|vnet|tap)/;

/**
 * What usage() shows right now, as sightings. null when the sample is degraded and must not be trusted:
 * no self card (tailscale status failed, so tailnet devices would look unknown), or LAN connections but an empty
 * neighbour table (ip neigh failed, so LAN devices would be keyed by IP instead of MAC).
 */
export function observationOf(
  u: Pick<Usage, 'cards'> & { history?: Pick<HistoryView, 'byDevice'> },
  neigh: Map<string, Neighbor>,
  oui: Map<string, string>,
  names: Record<string, string>,
): Observation | null {
  if (!u.cards.some((c) => c.kind === 'self')) return null;
  if (!neigh.size && u.cards.some((c) => c.kind === 'lan' && c.connections > 0)) return null;

  const connected: Sighting[] = [];
  const present: Sighting[] = [];
  // LAN addresses and MACs of tailnet devices, pool hosts and this server: those devices are known by other means
  const ownedMacs = new Set<string>();
  for (const c of u.cards) {
    if (c.kind !== 'tailnet' && c.kind !== 'self' && c.kind !== 'pool') continue;
    if (c.mac) ownedMacs.add(c.mac.toLowerCase());
    for (const ip of c.lanIps) if (neigh.get(ip)?.mac) ownedMacs.add(neigh.get(ip)!.mac);
  }
  for (const c of u.cards) {
    const key = cardKey(c);
    if (!key) continue;
    const s: Sighting = {
      key, kind: c.kind as Sighting['kind'], name: c.name, nameSource: c.nameSource, vendor: c.vendor, mac: c.mac,
      ip: c.kind === 'lan' ? (c.addresses[0] ?? null) : null, cardId: c.id, nameKey: c.nameKey,
    };
    present.push(s);
    const own = c.uses.filter((x) => !x.routed);
    if (!own.length) continue;
    const first = [...own].sort((a, b) => a.since.localeCompare(b.since))[0];
    connected.push({ ...s, service: { port: first.port, name: first.service } });
  }

  const byMac = new Map<string, Sighting>();
  for (const [ip, n] of neigh) {
    if (!n.mac || (n.dev && VIRTUAL_DEV.test(n.dev)) || ownedMacs.has(n.mac)) continue;
    const v4 = /^\d+\.\d+\.\d+\.\d+$/.test(ip);
    const prev = byMac.get(n.mac);
    if (prev && (prev.ip || !v4)) continue;
    const vendor = vendorOf(n.mac, oui);
    const nk = v4 ? nameKey(ip, n.mac) : null;
    const { name, source } = resolveName({ user: nk ? names[nk] : null, vendor, randomMac: isRandomMac(n.mac), ip: v4 ? ip : n.mac });
    byMac.set(n.mac, {
      key: `mac:${n.mac}`, kind: 'lan', name, nameSource: source, vendor, mac: n.mac, ip: v4 ? ip : null,
      cardId: v4 ? `lan:${ip}` : null, nameKey: nk,
    });
  }

  for (const [id, d] of Object.entries(u.history?.byDevice ?? {})) {
    if (d.kind === 'tailnet') present.push(blankSighting(`ts:${id}`, 'tailnet', d.name, id, null));
    else if (d.kind === 'lan' && d.nameKey) present.push(blankSighting(d.nameKey, 'lan', d.name, id, d.nameKey));
  }
  return { connected, neighbors: [...byMac.values()], present };
}

function blankSighting(key: string, kind: Sighting['kind'], name: string, cardId: string, nk: string | null): Sighting {
  const mac = key.startsWith('mac:') ? key.slice(4) : null;
  const ip = key.startsWith('ip:') ? key.slice(3) : null;
  return { key, kind, name, nameSource: 'ip', vendor: null, mac, ip, cardId, nameKey: nk };
}

// ---------- diffing ----------

/**
 * The record for a sighting. A LAN device first known only by IP (from the history, before its MAC was seen) is
 * adopted once by the MAC that shows up at that IP; a record that already has a different MAC is another device.
 */
function lookup(store: KnownStore, s: Sighting): KnownDevice | undefined {
  const hit = store.devices[s.key];
  if (hit || !s.mac || !s.ip) return hit;
  const byIp = store.devices[`ip:${s.ip}`];
  if (!byIp || byIp.mac) return undefined;
  delete store.devices[byIp.key];
  const moved = { ...byIp, key: s.key, mac: s.mac };
  store.devices[s.key] = moved;
  return moved;
}

function record(s: Sighting, now: number, extra: Partial<KnownDevice>): KnownDevice {
  return {
    key: s.key, kind: s.kind, name: s.name, nameSource: s.nameSource, vendor: s.vendor, mac: s.mac, ip: s.ip,
    cardId: s.cardId, nameKey: s.nameKey, firstSeen: now, connected: null, neighbor: null, service: s.service ?? null,
    pending: null, notify: false, notified: null,
    ...extra,
  };
}

function refresh(r: KnownDevice, s: Sighting) {
  r.name = s.name;
  r.nameSource = s.nameSource;
  r.vendor = s.vendor ?? r.vendor;
  r.mac = s.mac ?? r.mac;
  r.ip = s.ip ?? r.ip;
  r.cardId = s.cardId ?? r.cardId;
  r.nameKey = s.nameKey ?? r.nameKey;
}

/**
 * One observation. The first call (seededAt null) only seeds. After that, returns the records that just became
 * pending. Mutates store.
 */
export function observe(store: KnownStore, obs: Observation, settings: NewDeviceSettings, now: number): KnownDevice[] {
  if (store.seededAt === null) {
    for (const s of [...obs.present, ...obs.connected, ...obs.neighbors]) {
      const r = lookup(store, s);
      if (r) {
        refresh(r, s);
        r.connected ??= now;
        r.neighbor ??= s.mac ? now : null;
      } else {
        store.devices[s.key] = record(s, now, { connected: now, neighbor: s.mac ? now : null, seeded: true });
      }
    }
    store.seededAt = now;
    return [];
  }

  const events: KnownDevice[] = [];
  for (const s of obs.connected) {
    const r = lookup(store, s);
    if (r && r.connected !== null) {
      refresh(r, s);
      continue;
    }
    const next = r ?? record(s, now, {});
    if (r) refresh(next, s);
    next.connected = now;
    next.service = s.service ?? next.service;
    next.pending = 'connection';
    // already announced when it showed up on the LAN: the badge moves to the connection, no second alert
    next.notify = settings.connections && next.notified === null;
    store.devices[s.key] = next;
    events.push(next);
  }
  for (const s of obs.neighbors) {
    const r = lookup(store, s);
    if (r) {
      // already known (seeded, or it connected): just note it was seen on the LAN too
      r.neighbor ??= now;
      if (!r.ip && s.ip) r.ip = s.ip;
      continue;
    }
    const next = record(s, now, { neighbor: now, pending: settings.neighbors ? 'neighbor' : null, notify: settings.neighbors });
    store.devices[s.key] = next;
    if (settings.neighbors) events.push(next);
  }
  prune(store);
  return events;
}

function prune(store: KnownStore) {
  const keys = Object.keys(store.devices);
  if (keys.length <= MAX_RECORDS) return;
  const old = keys
    .filter((k) => !store.devices[k].pending)
    .sort((a, b) => store.devices[a].firstSeen - store.devices[b].firstSeen)
    .slice(0, keys.length - MAX_RECORDS);
  for (const k of old) delete store.devices[k];
}

/** 확인: clears the badge, and the alert if it hasn't gone out yet. key 'all' acknowledges everything. */
export function acknowledge(store: KnownStore, key: string): number {
  let n = 0;
  for (const r of Object.values(store.devices)) {
    if (key !== 'all' && r.key !== key && r.nameKey !== key) continue;
    if (!r.pending && !r.notify) continue;
    if (r.pending) n++;
    r.pending = null;
    if (r.notified === null) r.notify = false;
  }
  return n;
}

// ---------- alerts ----------

/** Name for an alert: never an address (an unnamed LAN device's name is its IP) */
function alertName(r: KnownDevice): string {
  if (r.nameSource !== 'ip') return r.name;
  if (LOCALES.some((l) => r.name === t('clientsMsg.privateWifi', undefined, l))) return r.name;
  return r.kind === 'tailnet' ? r.name : 'unnamed LAN device';
}

function alertLine(r: KnownDevice): string {
  const where = r.kind === 'tailnet' ? 'tailnet' : r.vendor ? `LAN, ${r.vendor}` : 'LAN';
  const what = r.pending === 'neighbor' || (r.connected === null && r.neighbor !== null)
    ? 'appeared on the LAN for the first time'
    : r.service ? `connected to ${r.service.name} :${r.service.port} for the first time` : 'connected for the first time';
  return `${alertName(r)} (${where}) ${what}.`;
}

export function newDeviceText(list: KnownDevice[], dashboard: string | null): Message {
  const click = dashboard ? `${dashboard.replace(/\/+$/, '')}/devices.html${list.length === 1 && list[0].cardId ? `#${encodeURIComponent(list[0].cardId)}` : ''}` : undefined;
  const title = list.length === 1 ? `portboard: new device — ${alertName(list[0])}` : `portboard: ${list.length} new devices`;
  const lines = list.slice(0, 8).map(alertLine);
  if (list.length > 8) lines.push(`… and ${list.length - 8} more.`);
  lines.push(t('knownMsg.alert.openHint', { it: list.length === 1 ? 'it' : 'them' }));
  return { key: 'new-device', kind: 'new-device', title, body: lines.join('\n'), high: false, ...(click ? { click } : {}) };
}

/** Everything queued, if the rate limit allows a message now. */
export function dueAlert(store: KnownStore, now: number, rateMs = RATE_MS): KnownDevice[] {
  const due = Object.values(store.devices).filter((r) => r.notify && r.notified === null);
  if (!due.length) return [];
  if (store.lastSent !== null && now - store.lastSent < rateMs) return [];
  return due.sort((a, b) => a.firstSeen - b.firstSeen);
}

/** Applies the outcome of sending `list`: sent → marked; no channel → dropped (not sent later); failed → retried. */
export function settle(store: KnownStore, list: KnownDevice[], outcome: 'sent' | 'no-channel' | 'failed', now: number) {
  if (outcome === 'failed') return;
  for (const r of list) {
    const cur = store.devices[r.key];
    if (!cur) continue;
    if (outcome === 'sent') cur.notified = now;
    else cur.notify = false;
  }
  if (outcome === 'sent') store.lastSent = now;
}

// ---------- persistence ----------

export function parseKnown(text: string): KnownStore {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyKnown();
  }
  const s = emptyKnown();
  if (typeof raw?.seededAt === 'number') s.seededAt = raw.seededAt;
  if (typeof raw?.lastSent === 'number') s.lastSent = raw.lastSent;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  for (const [k, r] of Object.entries<any>(raw?.devices ?? {})) {
    if (!r || typeof r.key !== 'string' || r.key !== k || !/^(ts|mac|ip):/.test(k) || num(r.firstSeen) === null) continue;
    s.devices[k] = {
      key: k, kind: r.kind === 'tailnet' ? 'tailnet' : 'lan',
      name: str(r.name) ?? k, nameSource: str(r.nameSource) as NameSource ?? 'ip',
      vendor: str(r.vendor), mac: str(r.mac), ip: str(r.ip), cardId: str(r.cardId), nameKey: str(r.nameKey),
      firstSeen: r.firstSeen, connected: num(r.connected), neighbor: num(r.neighbor),
      service: r.service && Number.isInteger(r.service.port) ? { port: r.service.port, name: String(r.service.name ?? `:${r.service.port}`) } : null,
      ...(r.seeded ? { seeded: true as const } : {}),
      pending: r.pending === 'connection' || r.pending === 'neighbor' ? r.pending : null,
      notify: !!r.notify, notified: num(r.notified),
    };
  }
  return s;
}

export async function loadKnown(path = KNOWN_PATH): Promise<KnownStore> {
  try {
    return parseKnown(await readFile(path, 'utf8'));
  } catch {
    return emptyKnown();
  }
}

// ---------- views ----------

export interface NewDeviceView {
  key: string;
  kind: KnownDevice['kind'];
  name: string;
  vendor: string | null;
  ip: string | null;
  cardId: string | null;
  nameKey: string | null;
  scope: Scope;
  /** When it became new (first connection, or first neighbour sighting) */
  since: string;
  service: KnownDevice['service'];
  notified: string | null;
}

export interface NewDevicesSummary {
  settings: NewDeviceSettings;
  /** false: PORTBOARD_ALERTS=off, nothing is sent (badges still work) */
  alertsOn: boolean;
  seededAt: string | null;
  known: number;
  pending: NewDeviceView[];
}

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

export function pendingView(store: KnownStore): NewDeviceView[] {
  return Object.values(store.devices)
    .filter((r) => r.pending)
    .map((r) => ({
      key: r.key, kind: r.kind, name: r.name, vendor: r.vendor, ip: r.ip, cardId: r.cardId, nameKey: r.nameKey,
      scope: r.pending!, since: iso((r.pending === 'connection' ? r.connected : r.neighbor) ?? r.firstSeen)!,
      service: r.service, notified: iso(r.notified),
    }))
    .sort((a, b) => b.since.localeCompare(a.since));
}

export function summary(store: KnownStore, settings: NewDeviceSettings, alertsOn: boolean): NewDevicesSummary {
  return { settings, alertsOn, seededAt: iso(store.seededAt), known: Object.keys(store.devices).length, pending: pendingView(store) };
}

/** usage cards with their 새 기기 state: { key, scope, since } while pending, else null */
export function withNewDevices<U extends { cards: DeviceCard[] }>(u: U, sum: NewDevicesSummary): Omit<U, 'cards' | 'newDevices'> & { cards: (U['cards'][number] & { newDevice: { key: string; scope: Scope; since: string } | null })[]; newDevices: NewDevicesSummary } {
  const byKey = new Map(sum.pending.map((p) => [p.key, p]));
  const byCard = new Map(sum.pending.filter((p) => p.cardId).map((p) => [p.cardId!, p]));
  return {
    ...u,
    cards: u.cards.map((c) => {
      const k = cardKey(c);
      const p = (k ? byKey.get(k) : undefined) ?? byCard.get(c.id);
      return { ...c, newDevice: p ? { key: p.key, scope: p.scope, since: p.since } : null };
    }),
    newDevices: sum,
  };
}

// ---------- the server's tracker ----------

export interface TrackerDeps {
  path?: string;
  logPath?: string;
  channel?(): Promise<Channel | null>;
  send?: Sender;
  /** false: never send (PORTBOARD_ALERTS=off) */
  alertsOn?: boolean;
  /** Dashboard base URL for the notification's tap target */
  dashboard?: string | null;
  now?(): number;
}

/** In-memory known devices for the server process; observe() on every usage sample. Writes only when something changed. */
export function createTracker(deps: TrackerDeps = {}) {
  const path = deps.path ?? KNOWN_PATH;
  const logPath = deps.logPath ?? LOG_PATH;
  const channel = deps.channel ?? (() => loadChannel());
  const send = deps.send ?? httpSender();
  const alertsOn = deps.alertsOn ?? true;
  const now = deps.now ?? Date.now;
  let store: KnownStore | null = null;
  let written = '';
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<KnownStore> {
    if (!store) {
      store = await loadKnown(path);
      written = JSON.stringify(store);
    }
    return store;
  }

  async function save() {
    const text = JSON.stringify(store);
    if (text === written) return;
    await writePrivate(path, () => `${JSON.stringify(store, null, 1)}\n`);
    written = text;
  }

  let sending: Promise<void> | null = null;
  /** After a failed send, don't try again before this (ms) */
  let retryAt = 0;

  /**
   * Sends what is due, off the request path: observe() never waits for ntfy, one send at a time, and a failed send
   * is retried no sooner than CHECK_MS later. With alerts off the queue is dropped, so turning them back on doesn't
   * release a backlog.
   */
  function kick(): Promise<void> {
    if (sending || now() < retryAt) return sending ?? Promise.resolve();
    sending = (async () => {
      const list = dueAlert(await load(), now());
      if (!list.length) return;
      if (!alertsOn) return void (await serial((s) => settle(s, list, 'no-channel', now())));
      const c = await channel();
      if (!c) return void (await serial((s) => settle(s, list, 'no-channel', now())));
      const m = newDeviceText(list, deps.dashboard ?? null);
      const sent: Sent[] = await send(c, m).catch(() => [{ channel: 'ntfy' as const, ok: false, error: 'send failed' }]);
      const line = { t: new Date(now()).toISOString(), key: m.key, kind: m.kind, title: m.title, body: m.body, sent };
      await appendPrivate(logPath, `${JSON.stringify(line)}\n`).catch(() => {});
      const ok = sent.some((x) => x.ok);
      if (!ok) retryAt = now() + CHECK_MS;
      await serial((s) => settle(s, list, ok ? 'sent' : 'failed', now()));
    })()
      .catch((err) => console.error(`[portboard] new-device alert: ${(err as Error).message}`))
      .finally(() => (sending = null));
    return sending;
  }

  /** Serialised: observations, acks and settling a sent alert never interleave. */
  function serial<T>(fn: (s: KnownStore) => Promise<T> | T): Promise<T> {
    const job = queue.then(async () => {
      const s = await load();
      const out = await fn(s);
      await save();
      return out;
    });
    queue = job.then(
      () => reportHealth('known-devices', { ok: true }),
      (err) => {
        console.error(`[portboard] known devices: ${(err as Error).message}`);
        reportHealth('known-devices', { ok: false, error: `cannot read or write known-devices.json (${(err as NodeJS.ErrnoException).code ?? 'error'})` });
      },
    );
    return job;
  }

  return {
    observe(obs: Observation | null, settings: NewDeviceSettings): Promise<KnownDevice[]> {
      return serial((s) => (obs ? observe(s, obs, settings, now()) : [])).finally(() => void kick());
    },
    /** Resolves when no alert is being sent (tests) */
    async idle(): Promise<void> {
      while (sending) await sending;
    },
    acknowledge(key: string): Promise<number> {
      return serial((s) => acknowledge(s, key));
    },
    async summary(settings: NewDeviceSettings): Promise<NewDevicesSummary> {
      await queue;
      return summary(await load(), settings, alertsOn);
    },
  };
}

export type Tracker = ReturnType<typeof createTracker>;
