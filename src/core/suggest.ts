// Smart defaults (c10dev/portboard#33): what Portboard suggests the user turn on or fill in, never does by itself.
//
//   alert  a port that is pinned, or runs as an installed systemd unit, or in a long-lived docker container, and has
//          no down alert yet → "🔔 알림 켜기?". One suggestion per unit / container (its HTTP port first, else its
//          lowest), so compute-pool monitor's 7720 and 7721 are one row.
//          Left out: hidden and stopped ports, Portboard itself (it can't alert about its own death), units made with
//          systemd-run (Claude previews and test services: nothing re-creates them), short-lived containers, system
//          ports whose owner isn't visible (sshd, DNS, tailscaled: the OS looks after those).
//   name   a LAN device without a user-given name → a name to accept in one click, from the best source there is:
//            tailscale  a tailnet peer whose direct WireGuard endpoint is this LAN address (the Mac on Wi-Fi with a
//                       private MAC, otherwise "개인 Wi-Fi 주소 기기"). The endpoint flips between the LAN address
//                       and the router (hairpin NAT), so the server remembers a match for 7 days while the same MAC
//                       is at that address (rememberPeers).
//            hostname   the name the LAN's DNS (the router, DHCP) gives the address, when it answers
//            vendor     a device kind from the MAC vendor (Synology → NAS, Brother → 프린터), only when it says more
//                       than the vendor guess already shown
//          A suggestion that equals the name already shown is no suggestion. A Proxmox guest is already shown under
//          its guest name (usage.ts); that name is what 이름 붙이기 pre-fills (prefillName), and the vendor guess
//          never replaces it.
//   idle   a service nobody has connected to for IDLE_DAYS (14) days, from the usage history (history.ts, 30 days)
//          → "💤 N일째 안 씀". Installed units, containers and plain processes alike (the owners cleanup only knows
//          left-over dev servers, #3); one per unit / container like alert, with its last use and owner. Only a
//          suggestion: nothing here or in the dashboard stops it. Left out: pinned, hidden and system ports,
//          Portboard itself, and whatever the history can't vouch for: nothing at all until the history spans
//          IDLE_DAYS, and a port the history never saw only when its service has been up that long (else it is new).
//
// Dismissed ids live in prefs.json (prefs.ts suggestions.dismissed). Everything here is pure; the feature module
// (src/features/suggestions.ts) collects the inputs.

import { shortVendor, type NameSource } from './clients.ts';
import { t } from './i18n.ts';
import { isPortboardUnit } from './selfunit.ts';

/** Ids fit the router's generic `:device` segment ([A-Za-z0-9][A-Za-z0-9-]{0,62}) */
export const SUGGESTION_ID = /^((alert|idle)-\d{1,5}|name-[a-z0-9][a-z0-9-]{0,57})$/;

export interface AlertSuggestion {
  id: string;
  kind: 'alert';
  port: number;
  name: string;
  /** Why this port: pinned, an installed systemd unit, a long-lived container */
  reasons: ('pinned' | 'systemd' | 'docker')[];
  unit: string | null;
  container: string | null;
  /** Other ports of the same unit / container (an alert on this one covers the service) */
  also: number[];
  text: string;
}

export interface NameSuggestion {
  id: string;
  kind: 'name';
  /** clients.json key for POST /api/clients/name and name_device */
  key: string;
  /** 기기 card id when the device has one */
  device: string | null;
  ip: string | null;
  current: string;
  currentSource: NameSource;
  name: string;
  source: 'tailscale' | 'hostname' | 'vendor';
  confidence: 'high' | 'medium' | 'low';
  /** OS when a source knows it (the matched tailnet peer, the Proxmox guest type) */
  os: string | null;
  text: string;
}

export interface IdleSuggestion {
  id: string;
  kind: 'idle';
  port: number;
  name: string;
  /** What runs it: a systemd unit, a docker container, or a plain process (its command) */
  owner: { type: 'unit' | 'container' | 'process'; name: string };
  /** Other ports of the same unit / container (none of them used either) */
  also: number[];
  /** The threshold: no connection in this many days */
  days: number;
  /** Last connection to any of its ports (ISO) and the device it came from; null when the history never saw one */
  lastUsed: string | null;
  lastDevice: string | null;
  /** Whole days since lastUsed; null with it */
  idleDays: number | null;
  text: string;
}

export type Suggestion = AlertSuggestion | NameSuggestion | IdleSuggestion;

export interface SuggestionsReport {
  at: string;
  suggestions: Suggestion[];
  /** How many would be shown but were dismissed (무시) */
  dismissed: number;
}

// ---------- alerts ----------

/** The parts of a PortEntry (src/core/index.ts) this needs */
export interface AlertCandidate {
  port: number;
  name: string;
  kind: 'app' | 'ephemeral' | 'system';
  listening: boolean;
  hidden: boolean;
  pinned: boolean;
  alert: boolean;
  container: string | null;
  processes: { unit: string | null }[];
  probe: { http: boolean } | null;
}

export interface ContainerInfo {
  startedAt: number | null;
  restart: string | null;
}

export interface AlertInputs {
  /** Units made with systemd-run (owners.ts transientUnits) */
  transient: Set<string>;
  /** Portboard's own units */
  selfUnits: Set<string>;
  /** docker inspect, by container name */
  containers: Map<string, ContainerInfo>;
  now: number;
}

/** A container that is up for a day, or that docker restarts by itself, is a service rather than an experiment. */
export const LONG_LIVED_MS = 24 * 3600_000;

export function longLived(c: ContainerInfo | undefined, now: number): boolean {
  if (!c) return false;
  if (c.restart === 'always' || c.restart === 'unless-stopped') return true;
  return c.startedAt !== null && now - c.startedAt >= LONG_LIVED_MS;
}

export function alertSuggestions(ports: AlertCandidate[], inp: AlertInputs): AlertSuggestion[] {
  // Owner of each port: its unit or container; a port with neither stands alone.
  const ownerOf = (p: AlertCandidate) => {
    const unit = p.processes.find((x) => x.unit)?.unit ?? null;
    return p.container ? `ctr:${p.container}` : unit ? `unit:${unit}` : `port:${p.port}`;
  };
  const byOwner = new Map<string, AlertCandidate[]>();
  for (const p of ports) {
    if (!p.listening) continue;
    const k = ownerOf(p);
    byOwner.set(k, [...(byOwner.get(k) ?? []), p]);
  }

  const out: AlertSuggestion[] = [];
  for (const group of byOwner.values()) {
    // Already watched through any of its ports: the service is covered.
    if (group.some((p) => p.alert)) continue;
    const shown = group.filter((p) => !p.hidden);
    if (!shown.length) continue;
    const unit = shown[0].processes.find((x) => x.unit)?.unit ?? null;
    const container = shown[0].container;
    if (unit && inp.selfUnits.has(unit)) continue;

    const reasons: AlertSuggestion['reasons'] = [];
    if (shown.some((p) => p.pinned)) reasons.push('pinned');
    if (unit && !inp.transient.has(unit) && shown[0].kind !== 'system') reasons.push('systemd');
    if (container && longLived(inp.containers.get(container), inp.now)) reasons.push('docker');
    if (!reasons.length) continue;

    const pick = [...shown].sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(!!b.probe?.http) - Number(!!a.probe?.http) || a.port - b.port)[0];
    const also = shown.filter((p) => p !== pick).map((p) => p.port).sort((a, b) => a - b);
    out.push({
      id: `alert-${pick.port}`,
      kind: 'alert',
      port: pick.port,
      name: pick.name,
      reasons,
      unit,
      container,
      also,
      text: alertText(reasons, unit, container),
    });
  }
  return out.sort((a, b) => a.port - b.port);
}

function alertText(reasons: AlertSuggestion['reasons'], unit: string | null, container: string | null): string {
  const why = reasons.map((r) => (r === 'pinned' ? t('suggest.alert.pinned') : r === 'systemd' ? t('suggest.alert.systemd', { unit }) : t('suggest.alert.container', { container })));
  return t('suggest.alert.text', { why: why.join(' · ') });
}

// ---------- names ----------

/** The parts of a 기기 card (src/core/usage.ts DeviceCard) this needs */
export interface NameCard {
  id: string;
  name: string;
  nameSource: NameSource;
  kind: string;
  os: string | null;
  vendor: string | null;
  mac: string | null;
  randomMac: boolean;
  addresses: string[];
  lanIps: string[];
  nameKey: string | null;
  path: { type: 'direct'; endpoint: string } | { type: 'relay'; region: string } | null;
  guestOf: { type: string; vmid: number } | null;
}

/** A 새 기기 without a card (seen only in the neighbour table): known.ts NewDeviceView */
export interface PendingDevice {
  key: string;
  kind: string;
  name: string;
  vendor: string | null;
  ip: string | null;
  cardId: string | null;
  nameKey: string | null;
}

export interface NameInputs {
  /** This server's LAN addresses and the default gateway: never a tailnet peer's own address */
  notPeers: Set<string>;
  /** Reverse DNS (PTR) answers, by IP; absent when the LAN's DNS doesn't answer */
  hostnames: Map<string, string>;
  /** Earlier peer ↔ LAN address matches (rememberPeers): a peer's endpoint flips between its LAN address and the router */
  seen?: PeerSightings;
}

/** LAN address → the tailnet peer last seen with its direct endpoint there, and the MAC at that address then */
export type PeerSightings = Map<string, { peer: string; os: string | null; mac: string | null; at: number }>;

export const PEER_MEMORY_MS = 7 * 86400_000;

/** "dev-mac.tail1234.ts.net" → "dev-mac"; "nas.lan." → "nas"; null for nothing useful */
export function cleanHostname(raw: string): string | null {
  const first = raw.trim().replace(/\.$/, '').split('.')[0];
  if (!first || /^\d+$/.test(first) || /^(localhost|unknown|android-[0-9a-f]{8,}|ip-[\d-]+)$/i.test(first)) return null;
  return first.slice(0, 40);
}

/** Vendor → what kind of device it almost always is (only vendors that make one kind of thing): [IEEE name, brand, kind key] */
const VENDOR_KIND: [RegExp, string, string][] = [
  [/^Synology/i, 'Synology', 'suggest.kind.nas'],
  [/^QNAP/i, 'QNAP', 'suggest.kind.nas'],
  [/^Brother/i, 'Brother', 'suggest.kind.printer'],
  [/^Canon/i, 'Canon', 'suggest.kind.printer'],
  [/^Seiko Epson/i, 'Epson', 'suggest.kind.printer'],
  [/^Kyocera/i, 'Kyocera', 'suggest.kind.printer'],
  [/^Espressif/i, 'Espressif', 'suggest.kind.iot'],
  [/^Tuya/i, 'Tuya', 'suggest.kind.iot'],
  [/^Shelly|^Allterco/i, 'Shelly', 'suggest.kind.iot'],
  [/^Sonos/i, 'Sonos', 'suggest.kind.speaker'],
  [/^Roku/i, 'Roku', 'suggest.kind.tvStick'],
  [/^Nintendo/i, 'Nintendo', 'suggest.kind.console'],
  [/^Sony Interactive/i, 'PlayStation', 'suggest.kind.console'],
  [/^Ubiquiti/i, 'Ubiquiti', 'suggest.kind.network'],
  [/^TP-LINK/i, 'TP-Link', 'suggest.kind.network'],
  [/^EFM Networks/i, 'ipTIME', 'suggest.kind.network'],
  [/^Raspberry Pi/i, 'Raspberry Pi', ''],
];

/** "Synology NAS", "Brother 프린터"; null when the vendor says nothing beyond its name */
export function vendorKind(vendor: string): string | null {
  const hit = VENDOR_KIND.find(([re]) => re.test(vendor));
  return hit ? `${hit[1]}${hit[2] ? ` ${t(hit[2])}` : ''}` : null;
}

const hostOf = (endpoint: string) => endpoint.replace(/^\[/, '').replace(/\]?:\d+$/, '');

/** "mac:bc:24:11:0a:0b:05" → "name-mac-bc-24-11-0a-0b-05" */
export function nameId(key: string): string {
  return `name-${key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}`.slice(0, 63);
}

export function nameSuggestions(cards: NameCard[], pending: PendingDevice[], inp: NameInputs): NameSuggestion[] {
  const peerAt = peersByEndpoint(cards, inp.notPeers);

  type Target = { key: string; device: string | null; ip: string | null; mac: string | null; current: string; currentSource: NameSource; vendor: string | null; guestOf: NameCard['guestOf'] };
  const targets: Target[] = [];
  const seen = new Set<string>();
  for (const c of cards) {
    if (c.kind !== 'lan' || !c.nameKey || c.nameSource === 'user') continue;
    seen.add(c.nameKey);
    targets.push({ key: c.nameKey, device: c.id, ip: c.addresses[0] ?? c.lanIps[0] ?? null, mac: c.mac, current: c.name, currentSource: c.nameSource, vendor: c.vendor, guestOf: c.guestOf });
  }
  for (const p of pending) {
    if (p.kind !== 'lan' || !p.nameKey || seen.has(p.nameKey)) continue;
    seen.add(p.nameKey);
    targets.push({ key: p.nameKey, device: p.cardId, ip: p.ip, mac: p.key.startsWith('mac:') ? p.key.slice(4) : null, current: p.name, currentSource: 'ip', vendor: p.vendor, guestOf: null });
  }

  const out: NameSuggestion[] = [];
  for (const tgt of targets) {
    // Now, else remembered while the same MAC is at that address (DHCP may have given it to another device since)
    const was = tgt.ip ? inp.seen?.get(tgt.ip) : undefined;
    const peer: { name: string; os: string | null } | null | undefined =
      (tgt.ip ? peerAt.get(tgt.ip) : null) ?? (was && was.mac && was.mac === tgt.mac && !(tgt.ip && peerAt.has(tgt.ip)) ? { name: was.peer, os: was.os } : null);
    const host = tgt.ip ? inp.hostnames.get(tgt.ip) : undefined;
    const hostName = host ? cleanHostname(host) : null;
    const kind = tgt.vendor ? vendorKind(tgt.vendor) : null;
    const guestOs = tgt.guestOf ? (tgt.guestOf.type === 'lxc' ? 'Proxmox CT' : 'Proxmox VM') : null;
    const pick: Pick<NameSuggestion, 'name' | 'source' | 'confidence' | 'os' | 'text'> | null = peer
      ? { name: peer.name, source: 'tailscale', confidence: 'high', os: peer.os, text: peer.os ? t('suggest.name.tailscaleOs', { name: peer.name, os: peer.os }) : t('suggest.name.tailscale', { name: peer.name }) }
      : hostName
        ? { name: hostName, source: 'hostname', confidence: 'high', os: guestOs, text: t('suggest.name.hostname', { host }) }
        : kind && tgt.currentSource !== 'proxmox'
          ? { name: kind, source: 'vendor', confidence: 'low', os: guestOs, text: t('suggest.name.vendor', { vendor: shortVendor(tgt.vendor!) }) }
          : null;
    if (!pick || pick.name === tgt.current) continue;
    out.push({ id: nameId(tgt.key), kind: 'name', key: tgt.key, device: tgt.device, ip: tgt.ip, current: tgt.current, currentSource: tgt.currentSource, ...pick });
  }
  return out;
}

/** Tailnet peers by the LAN address of their direct endpoint; an address two peers share is a NAT (null), not a device. */
function peersByEndpoint(cards: NameCard[], notPeers: Set<string>): Map<string, NameCard | null> {
  const peerAt = new Map<string, NameCard | null>();
  for (const c of cards) {
    if ((c.kind !== 'tailnet' && c.kind !== 'pool') || c.path?.type !== 'direct') continue;
    const ip = hostOf(c.path.endpoint);
    if (notPeers.has(ip) || c.lanIps.includes(ip)) continue;
    peerAt.set(ip, peerAt.has(ip) ? null : c);
  }
  return peerAt;
}

/** The sightings after this sample: a peer whose endpoint is a LAN card's address now, with that card's MAC; old ones expire. */
export function rememberPeers(prev: PeerSightings, cards: NameCard[], notPeers: Set<string>, now: number, ttl = PEER_MEMORY_MS): PeerSightings {
  const next: PeerSightings = new Map([...prev].filter(([, v]) => now - v.at < ttl));
  const lanMac = new Map<string, string | null>();
  for (const c of cards) if (c.kind === 'lan') for (const ip of [...c.addresses, ...c.lanIps]) lanMac.set(ip, c.mac);
  for (const [ip, peer] of peersByEndpoint(cards, notPeers)) {
    if (peer && lanMac.has(ip)) next.set(ip, { peer: peer.name, os: peer.os, mac: lanMac.get(ip) ?? null, at: now });
  }
  return next;
}

/**
 * The name to pre-fill when naming a device by hand: the suggestion, else a name that came from somewhere better
 * than a guess (the Proxmox guest name), else nothing.
 */
export function prefillName(c: Pick<NameCard, 'name' | 'nameSource'>, s: NameSuggestion | undefined): string {
  if (c.nameSource === 'user') return c.name;
  if (s) return s.name;
  return c.nameSource === 'proxmox' ? c.name : '';
}

// ---------- idle ----------

/** No connection for this many days makes a service a cleanup suggestion (a constant: suggestions have no settings) */
export const IDLE_DAYS = 14;
const DAY_MS = 86400_000;

/** The parts of a PortEntry (src/core/index.ts) this needs */
export interface IdleCandidate {
  port: number;
  name: string;
  kind: 'app' | 'ephemeral' | 'system';
  listening: boolean;
  hidden: boolean;
  pinned: boolean;
  container: string | null;
  processes: { pid: number; unit: string | null; cmdline: string }[];
  /** The snapshot's PortEntry.isPortboard; the unit and pid checks below cover a candidate without it */
  isPortboard?: boolean;
}

/** The parts of a usage-history entry (history.ts HistEntry) this needs: one per (device, port) */
export interface UseRecord {
  port: number;
  /** The device's display name */
  name: string;
  lastSeen: number;
}

export interface IdleInputs {
  /** When the usage history began (History.startedAt); null: no history yet */
  historySince: number | null;
  uses: UseRecord[];
  /** When each process started (ms), by pid (/proc/<pid>/stat) */
  started: Map<number, number>;
  /** docker inspect, by container name */
  containers: Map<string, ContainerInfo>;
  /** Portboard's own units and pid */
  selfUnits: Set<string>;
  selfPid: number;
  now: number;
  days?: number;
}

/** "/usr/bin/python3 -m http.server 8000" → "python3" */
const commandName = (cmdline: string) => cmdline.trim().split(/\s+/)[0]?.split('/').pop() || null;

export function idleSuggestions(ports: IdleCandidate[], inp: IdleInputs): IdleSuggestion[] {
  const days = inp.days ?? IDLE_DAYS;
  const span = days * DAY_MS;
  // A history younger than the threshold can't tell "unused" from "not watched yet".
  if (inp.historySince === null || inp.now - inp.historySince < span) return [];

  const lastUse = new Map<number, UseRecord>();
  for (const u of inp.uses) {
    const had = lastUse.get(u.port);
    if (!had || u.lastSeen > had.lastSeen) lastUse.set(u.port, u);
  }

  const unitOf = (p: IdleCandidate) => p.processes.find((x) => x.unit)?.unit ?? null;
  const byOwner = new Map<string, IdleCandidate[]>();
  for (const p of ports) {
    if (!p.listening) continue;
    const unit = unitOf(p);
    const k = p.container ? `ctr:${p.container}` : unit ? `unit:${unit}` : `port:${p.port}`;
    byOwner.set(k, [...(byOwner.get(k) ?? []), p]);
  }

  const out: IdleSuggestion[] = [];
  for (const group of byOwner.values()) {
    // Pinned: the user keeps it on purpose. System: the OS looks after it.
    if (group.some((p) => p.pinned || p.kind === 'system')) continue;
    const shown = group.filter((p) => !p.hidden);
    if (!shown.length) continue;
    const procs = group.flatMap((p) => p.processes);
    if (group.some((p) => p.isPortboard)) continue;
    if (procs.some((x) => x.pid === inp.selfPid || (!!x.unit && (inp.selfUnits.has(x.unit) || isPortboardUnit(x.unit))))) continue;
    const unit = unitOf(shown[0]);
    const container = shown[0].container;

    const last = group.map((p) => lastUse.get(p.port)).filter((u): u is UseRecord => !!u).sort((a, b) => b.lastSeen - a.lastSeen)[0] ?? null;
    if (last && inp.now - last.lastSeen < span) continue;
    if (!last) {
      // Never seen in the history: unused only when it has been up for the whole threshold, else it is just new.
      const starts = container ? [inp.containers.get(container)?.startedAt ?? null] : procs.map((x) => inp.started.get(x.pid) ?? null);
      const known = starts.filter((s): s is number => s !== null);
      if (!known.length || inp.now - Math.min(...known) < span) continue;
    }

    const owner: IdleSuggestion['owner'] = container
      ? { type: 'container', name: container }
      : unit
        ? { type: 'unit', name: unit }
        : { type: 'process', name: commandName(procs[0]?.cmdline ?? '') ?? shown[0].name };
    const pick = [...shown].sort((a, b) => a.port - b.port)[0];
    const idleDays = last ? Math.floor((inp.now - last.lastSeen) / DAY_MS) : null;
    out.push({
      id: `idle-${pick.port}`,
      kind: 'idle',
      port: pick.port,
      name: pick.name,
      owner,
      also: shown.filter((p) => p !== pick).map((p) => p.port),
      days,
      lastUsed: last ? new Date(last.lastSeen).toISOString() : null,
      lastDevice: last?.name ?? null,
      idleDays,
      text: idleText(owner, days, last?.name ?? null, idleDays),
    });
  }
  return out.sort((a, b) => a.port - b.port);
}

function idleText(owner: IdleSuggestion['owner'], days: number, device: string | null, idleDays: number | null): string {
  const who = owner.type === 'unit'
    ? t('suggest.idle.unit', { name: owner.name })
    : owner.type === 'container'
      ? t('suggest.idle.container', { name: owner.name })
      : t('suggest.idle.process', { name: owner.name });
  return idleDays !== null ? t('suggest.idle.text', { owner: who, days: idleDays, device }) : t('suggest.idle.never', { owner: who, days });
}

// ---------- together ----------

export function report(all: Suggestion[], dismissed: Set<string>, now: number): SuggestionsReport {
  const shown = all.filter((s) => !dismissed.has(s.id));
  return { at: new Date(now).toISOString(), suggestions: shown, dismissed: all.length - shown.length };
}

/** `docker inspect --format '{{.Name}}\t{{.State.StartedAt}}\t{{.HostConfig.RestartPolicy.Name}}'` */
export function parseDockerInspect(text: string): Map<string, ContainerInfo> {
  const out = new Map<string, ContainerInfo>();
  for (const line of text.split('\n')) {
    const [name, started = '', restart = ''] = line.trim().split('\t');
    if (!name) continue;
    const t = Date.parse(started);
    out.set(name.replace(/^\//, ''), { startedAt: Number.isFinite(t) && t > 0 ? t : null, restart: restart || null });
  }
  return out;
}

/** `ip route show default` → gateway addresses */
export function parseDefaultRoutes(text: string): string[] {
  return [...text.matchAll(/^default\s+via\s+(\S+)/gm)].map((m) => m[1]);
}
